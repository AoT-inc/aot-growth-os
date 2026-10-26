// 데몬 설정(config/daemon.config.example.json)에서 에이전트 실행 환경을 만든다 (A5 U6). main.ts 가 아니라 이 모듈에 둔 이유: main.ts 는 import 하면 바로 데몬을
// 시작하므로, 설정 → 조립 경로를 시험(test/integration/daemon-research-pipeline.test.ts)이 import 해서 쓸 수 없기 때문이다.
//
// 연결하는 것 (모두 설정이 있을 때만, 없으면 기존 동작 그대로):
//   container_agent  Docker 경로·자원 상한. 있으면 컨테이너 샌드박스 어댑터를 실행 관리에 연결한다(A5 U4).
//   research_agent   조사 에이전트 이미지 + 허용 호스트. container_agent 와 함께 있을 때만 의미가 있다:
//                      - 어댑터 = createResearchAgentAdapter (이미지는 research_agent.image)
//                      - 도구 = `fetch_url` 선언·실행기 (허용 호스트 = research_agent.allowed_hosts, 비어 있으면 모두 거부)
//                      - 평가 포트 = 같은 허용 호스트·같은 SSRF 규칙의 출처 조회기(createSourceFetcher) → `validating` 업무가 실제 출처 조회 검증을 받는다
//   llm_verifier     컨텍스트 분리 LLM 검증기 (A6-U12). `{kind: "stub"}` 만 허용한다(모델 호출 없는 결정적 가짜. 실제 모델 연결은 Q22 후속이므로 다른 kind 는 거부).
//                    평가 포트가 있어야 의미가 있으므로 research_agent 와 함께 있을 때만 받는다. 없으면 검증기를 연결하지 않아 `validation.llm` 이 있는 업무는 inconclusive(이전 동작).
//                    research_agent 가 없으면 평가 포트를 넘기지 않는다: `validating` 업무는 검증되지 않고 그대로 남는다(자동 완료 없음, A4 이후 동작 유지).
//   claude_code_cli  구독 로그인된 이 PC 의 공식 `claude` CLI 어댑터(ADR-0005 Amendment 2026-10-25·26). container_agent 없이 있으면 이 어댑터가 기본 어댑터이고,
//                    container_agent 와 함께 있으면 `roles` 에 적은 역할의 업무만 이 어댑터로 가고 나머지는 컨테이너 어댑터로 간다. 첫 실행 고지 동의는 설정이 아니라
//                    승인 CLI `consent` 로 받은 DB 기록이다: 호출자(main.ts)가 `overrides.claudeCodeConsent`(= readClaudeCodeConsent(db))를 넘기고, 어댑터는 run 마다 읽는다.
// 비밀값은 설정에 넣지 않는다(이미지 ID·호스트 이름·숫자뿐이다). 시험 전용 주입점(`overrides`)은 코드에서만 넘길 수 있고 설정 파일로는 닿지 않는다.
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  containerAgentAdapter, createContainerRunner, createDockerCli, createFetchUrlTool, createFileRunLogStore, createResearchAgentAdapter, createSourceFetcher,
  isValidInstanceId, pickDockerEnv,
  CLAUDE_CODE_ADAPTER_NAME, createClaudeCodeCliAdapter, REGISTRATION_TOOL_DESCRIPTIONS,
  type AgentAdapter, type ClaudeCodeConsent, type FetchUrlTool, type FetchUrlToolOptions, type GatewayTimers, type SourceFetcherOptions, type ToolCallRecorder,
} from '@aot/agent-runtime';
import { parseTimeLimit, systemClock, type Clock, type Db } from '@aot/domain';
import { createStubLlmVerifier, type LlmVerifier, type SourceFetcher } from '@aot/evaluation';

import { adapterByRole } from './agent-executor.ts';
import { createRegistrationRuntime, withRegistrationTools } from './registration.ts';
import type { AssembleOptions } from './assemble.ts';

export interface ContainerAgentConfig {
  docker_path: string;
  /** 이미지 ID `sha256:…`. `research_agent` 가 있으면 쓰이지 않는다(조사 에이전트 이미지가 쓰인다) */
  image?: string;
  memory_mib: number;
  cpus: number;
  pids_limit: number;
  tmpfs_mib: number;
  /** 이미지 뒤에 붙는 에이전트 인자 (`research_agent` 가 있으면 쓰이지 않는다) */
  agent_args?: string[];
}

export interface ResearchAgentConfig {
  /** 조사 에이전트 이미지 ID `sha256:…` (packages/agent-runtime/container/research-agent 의 빌드 결과) */
  image: string;
  /** `fetch_url` 과 출처 조회기가 접근할 수 있는 호스트. 정확한 호스트 또는 `*.example.com`. 비어 있으면 모두 거부 */
  allowed_hosts: string[];
  /** 본문 상한(바이트). 생략하면 코드 기본값 */
  max_body_bytes?: number;
  /** 최대 리다이렉트 횟수. 생략하면 코드 기본값 */
  max_redirects?: number;
  /** `fetch_url` 호출 한 번당 비용(USD). 생략하면 0 */
  fetch_unit_cost_usd?: number;
  /** 검증기가 URL 하나를 읽는 전체 시간(ms). 생략하면 코드 기본값 */
  source_fetch_timeout_ms?: number;
}

/** 컨텍스트 분리 LLM 검증기 설정. 지금은 모델 호출 없는 가짜(`stub`)만 있다. 실제 모델 연결(Q22)이 정해지면 kind 를 더한다 */
export interface LlmVerifierConfig {
  kind: 'stub';
  /** 검증 호출 한 번의 비용(USD)으로 기록할 값. 생략하면 0 */
  cost_usd?: number;
}

/** 구독 로그인된 `claude` CLI 어댑터 설정. 로그인 정보·토큰은 어디에도 없다(로그인은 사용자가 `claude auth login` 으로 한다) */
export interface ClaudeCodeCliConfig {
  /** `claude` 실행 파일의 절대 경로. PATH 탐색 없음 */
  claude_path: string;
  /** run 별 디렉터리를 만드는 절대 경로(짧게, 데몬 전용 OS 계정만 쓸 수 있어야 한다) */
  run_root: string;
  /** CLI 자식의 환경. 이 네 값뿐이다: 구독 로그인이 있는 홈, OS 계정 이름, 최소 PATH */
  env: { home: string; user: string; path: string };
  /** container_agent 와 함께 쓸 때 이 어댑터로 실행할 역할(`task_spec.role`). 필수·비어 있으면 안 된다. 단독으로 쓸 때는 줄 수 없다(모든 업무가 이 어댑터) */
  roles?: string[];
  /** 서로 다른 assistant 메시지 수 상한(기본 40) */
  max_turns?: number;
  /** `--max-budget-usd` (정가 환산 추정치 기준). 기본 꺼짐 */
  max_budget_usd?: number;
  model?: string;
  /** 사용률 경고 임계값(기본 0.8) */
  warn_utilization?: number;
  /** 사람 우선 게이트: 창별 임계값. 기본 꺼짐 */
  yield_utilization?: { five_hour?: number; seven_day?: number };
  /** 동시 실행 수(기본 1) */
  max_concurrent?: number;
}

/** 상품 등록 검증 도구 설정. 비밀값은 없다(실행 파일 경로·디렉터리·제한 시간뿐) */
export interface RegistrationToolsConfig {
  /** `git` 실행 파일의 절대 경로 */
  git_path: string;
  /** gitleaks 실행 파일의 절대 경로 (8.30.1) */
  gitleaks_path: string;
  /** gitleaks 설정 파일의 절대 경로. 생략하면 저장소의 `config/gitleaks-registration.toml`(기본 규칙 전체). 후보 저장소 안의 설정은 쓰지 않는다 */
  gitleaks_config?: string;
  /** 근거 본문 저장 디렉터리(0700). 기본 `<instance_dir>/evidence` */
  evidence_dir?: string;
  /** 스캐너 제한 시간(ms). 기본 10분 */
  scan_timeout_ms?: number;
}

export interface AgentRuntimeConfig {
  container_agent?: ContainerAgentConfig | null;
  /** 구독 CLI 어댑터. 생략·null 이면 연결하지 않는다 */
  claude_code_cli?: ClaudeCodeCliConfig | null;
  /** 상품 등록 검증 도구(repo_read · secret_scan · license_check)와 근거 저장소. 생략·null 이면 연결하지 않는다. claude_code_cli 또는 container_agent 가 있어야 한다 */
  registration_tools?: RegistrationToolsConfig | null;
  research_agent?: ResearchAgentConfig | null;
  /** LLM 검증기. 생략·null 이면 연결하지 않는다. `research_agent` 가 있어야 한다 */
  llm_verifier?: LlmVerifierConfig | null;
  /** 컨테이너 라벨 `aot.instance` 에 쓸 값. 생략하면 인스턴스 디렉터리의 절대 경로에서 도출한다(`deriveInstanceId`) */
  instance_id?: string;
  /** run_log 파일 디렉터리. 기본 `<instance_dir>/run-logs` */
  run_log_dir?: string;
  /** 명세에 `constraints.time_limit` 이 없을 때의 시간 제한 ("30m" 형식) */
  default_time_limit?: string;
}

/** 코드에서만 넣을 수 있는 주입점(설정 파일로는 닿지 않는다). 시험이 외부 접근 부품을 시험용 주입점이 있는 것으로 바꾼다 */
export interface AgentRuntimeOverrides {
  clock?: Clock;
  /** claude_code_cli 의 고지 동의 기록 읽기(run 마다 불린다). main.ts 는 `() => readClaudeCodeConsent(db)` 를 넘긴다. `claude_code_cli` 설정이 있으면 필수 */
  claudeCodeConsent?: () => ClaudeCodeConsent | null;
  /** 등록 도구가 저장소 바인딩(product_repo)을 읽는 DB. `registration_tools` 설정이 있으면 필수 */
  db?: Db;
  /** 등록 도구 실행 파일 확인 (시작 때). 기본은 실행 권한 확인이고, 던지면 데몬이 시작하지 않는다. 시험이 가짜 경로를 허용하려고 바꾼다 */
  checkExecutable?: (path: string) => void;
  /** `fetch_url` 도구 생성기. 설정에서 만든 옵션(허용 호스트 포함)을 그대로 받는다 */
  createFetchUrlTool?: (options: FetchUrlToolOptions) => FetchUrlTool;
  /** 출처 조회기 생성기. 같은 옵션을 받는다 */
  createSourceFetcher?: (options: SourceFetcherOptions) => SourceFetcher;
  /** LLM 검증기 생성기. 검증한 설정(`kind: 'stub'`)을 받는다. 시험이 판정표·규칙·예외를 가진 가짜로 바꾼다 */
  createLlmVerifier?: (config: LlmVerifierConfig) => LlmVerifier;
  /** 게이트웨이 호출 기록을 구조화된 채로 받는 훅 (run 마다 모든 호출에 대해 불린다) */
  recorder?: ToolCallRecorder;
  /** 도구 호출·시간 제한 타이머 */
  timers?: GatewayTimers;
}

export interface AgentRuntimeBuild {
  /** `assembleDaemon` 의 `agent` 옵션. container_agent 가 없으면 undefined */
  agent: AssembleOptions['agent'];
  /** `assembleDaemon` 의 `evaluation` 옵션. research_agent 가 없으면 undefined(검증기를 연결하지 않는다) */
  evaluation: AssembleOptions['evaluation'];
  /** 컨테이너에 붙인 `aot.instance` 라벨 값 */
  instanceId: string;
}

/** 인스턴스 디렉터리의 절대 경로에서 도출하는 안전한 인스턴스 ID (`i-` + sha256 앞 16자). 같은 호스트의 다른 인스턴스와 겹치지 않는다 */
export function deriveInstanceId(instanceDir: string): string {
  return `i-${createHash('sha256').update(resolve(instanceDir)).digest('hex').slice(0, 16)}`;
}

function requireContainer(config: AgentRuntimeConfig): ContainerAgentConfig {
  const container = config.container_agent;
  if (container === undefined || container === null) throw new Error('research_agent needs container_agent (docker_path and resource limits)');
  return container;
}

const createStubFromConfig = (config: LlmVerifierConfig): LlmVerifier => createStubLlmVerifier(config.cost_usd === undefined ? {} : { costUsd: config.cost_usd });

const LLM_VERIFIER_KEYS: ReadonlySet<string> = new Set(['kind', 'cost_usd']);

/** `llm_verifier` 설정을 검증한다. 없으면(undefined·null) undefined. 알 수 없는 kind·키·비용은 던진다 */
export function parseLlmVerifierConfig(value: unknown): LlmVerifierConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('llm_verifier must be an object like {"kind": "stub"}');
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !LLM_VERIFIER_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`llm_verifier has unknown key(s): ${unknown.join(', ')}`);
  if (record['kind'] !== 'stub') {
    throw new Error(`llm_verifier.kind '${String(record['kind'])}' is not supported (only 'stub', which makes no model call; a real model is wired after Q22)`);
  }
  const cost = record['cost_usd'];
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw new Error('llm_verifier.cost_usd must be a finite number >= 0');
  return { kind: 'stub', ...(cost === undefined ? {} : { cost_usd: cost }) };
}

const CLAUDE_KEYS: ReadonlySet<string> = new Set(['claude_path', 'run_root', 'env', 'roles', 'max_turns', 'max_budget_usd', 'model', 'warn_utilization', 'yield_utilization', 'max_concurrent']);
const CLAUDE_ENV_KEYS: ReadonlySet<string> = new Set(['home', 'user', 'path']);
const YIELD_KEYS: ReadonlySet<string> = new Set(['five_hour', 'seven_day']);

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${where} has unknown key(s): ${unknown.join(', ')}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `claude_code_cli` 설정의 모양을 검사한다. 없으면(undefined·null) undefined. 경로·환경 값의 세부 검사는 어댑터가 만들 때 한다 */
export function parseClaudeCodeCliConfig(value: unknown): ClaudeCodeCliConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('claude_code_cli must be an object');
  rejectUnknownKeys(value, CLAUDE_KEYS, 'claude_code_cli');
  for (const key of ['claude_path', 'run_root'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '') throw new Error(`claude_code_cli.${key} must be a non-empty string (an absolute path)`);
  }
  const env = value['env'];
  if (!isRecord(env)) throw new Error('claude_code_cli.env must be {"home": …, "user": …, "path": …}');
  rejectUnknownKeys(env, CLAUDE_ENV_KEYS, 'claude_code_cli.env');
  for (const key of CLAUDE_ENV_KEYS) if (typeof env[key] !== 'string') throw new Error(`claude_code_cli.env.${key} must be a string`);
  const roles = value['roles'];
  if (roles !== undefined && (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => typeof role !== 'string' || role === ''))) {
    throw new Error('claude_code_cli.roles must be a non-empty array of role slugs');
  }
  const number = (key: string, integer: boolean): void => {
    const v = value[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v)))) throw new Error(`claude_code_cli.${key} must be a positive ${integer ? 'integer' : 'number'}`);
  };
  number('max_turns', true);
  number('max_concurrent', true);
  number('max_budget_usd', false);
  number('warn_utilization', false);
  if (value['model'] !== undefined && (typeof value['model'] !== 'string' || value['model'] === '')) throw new Error('claude_code_cli.model must be a non-empty string');
  const yielding = value['yield_utilization'];
  if (yielding !== undefined) {
    if (!isRecord(yielding)) throw new Error('claude_code_cli.yield_utilization must be like {"five_hour": 0.7, "seven_day": 0.8}');
    rejectUnknownKeys(yielding, YIELD_KEYS, 'claude_code_cli.yield_utilization');
    for (const [key, v] of Object.entries(yielding)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`claude_code_cli.yield_utilization.${key} must be a positive number`);
    }
  }
  return value as unknown as ClaudeCodeCliConfig;
}

function buildClaudeAdapter(config: ClaudeCodeCliConfig, clock: Clock, overrides: AgentRuntimeOverrides, toolDescriptions?: Readonly<Record<string, string>>): AgentAdapter {
  if (overrides.claudeCodeConsent === undefined) throw new Error('claude_code_cli needs a consent source (the daemon passes readClaudeCodeConsent(db); the consent itself is given with the approval CLI `consent accept`)');
  return createClaudeCodeCliAdapter({
    claudePath: config.claude_path,
    runRoot: config.run_root,
    env: config.env,
    consent: overrides.claudeCodeConsent,
    clock,
    ...(config.max_turns === undefined ? {} : { maxTurns: config.max_turns }),
    ...(config.max_budget_usd === undefined ? {} : { maxBudgetUsd: config.max_budget_usd }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(toolDescriptions === undefined ? {} : { toolDescriptions }),
    ...(config.warn_utilization === undefined ? {} : { warnUtilization: config.warn_utilization }),
    ...(config.yield_utilization === undefined ? {} : { yieldUtilization: config.yield_utilization }),
    ...(config.max_concurrent === undefined ? {} : { maxConcurrent: config.max_concurrent }),
    ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
  });
}

/** 출처 URL 을 읽지 않는 평가 포트용: 상품 등록 검증은 로컬 근거만 쓰므로 URL 조회는 모두 접근 불가다 */
const NO_SOURCE_FETCHER: SourceFetcher = { fetch: () => Promise.resolve({ reachable: false, reason: 'no source fetcher is configured (research_agent is not set)' }) };

const REGISTRATION_KEYS: ReadonlySet<string> = new Set(['git_path', 'gitleaks_path', 'gitleaks_config', 'evidence_dir', 'scan_timeout_ms']);

/** `registration_tools` 설정의 모양을 검사한다. 없으면(undefined·null) undefined. 실행 파일 경로는 절대 경로여야 한다 */
export function parseRegistrationToolsConfig(value: unknown): RegistrationToolsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('registration_tools must be an object');
  rejectUnknownKeys(value, REGISTRATION_KEYS, 'registration_tools');
  for (const key of ['git_path', 'gitleaks_path'] as const) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) throw new Error(`registration_tools.${key} must be an absolute path (it is never looked up on PATH)`);
  }
  for (const key of ['gitleaks_config', 'evidence_dir'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !isAbsolute(value[key]))) throw new Error(`registration_tools.${key} must be an absolute path`);
  }
  const timeout = value['scan_timeout_ms'];
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000 || timeout > 3_600_000)) throw new Error('registration_tools.scan_timeout_ms must be an integer from 1000 to 3600000');
  return value as unknown as RegistrationToolsConfig;
}

/** 시작 때 실행 파일이 실제로 있고 실행할 수 있는지 확인한다 (없으면 데몬이 시작하지 않는다) */
function defaultExecutableCheck(path: string): void {
  accessSync(path, constants.X_OK);
}

/** 운영자 설정이 없을 때 쓰는 gitleaks 설정: 저장소의 `config/gitleaks-registration.toml` (기본 규칙 전체) */
const DEFAULT_GITLEAKS_CONFIG = fileURLToPath(new URL('../../../config/gitleaks-registration.toml', import.meta.url));

export function buildAgentRuntime(config: AgentRuntimeConfig, instanceDir: string, overrides: AgentRuntimeOverrides = {}): AgentRuntimeBuild {
  const registration = parseRegistrationToolsConfig(config.registration_tools);
  const built = buildAgentBase(config, instanceDir, overrides, registration === undefined ? undefined : REGISTRATION_TOOL_DESCRIPTIONS);
  if (registration === undefined) return built;
  if (overrides.db === undefined) throw new Error('registration_tools needs the database (the daemon passes it)');
  if (built.agent === undefined) throw new Error('registration_tools needs an agent adapter: set claude_code_cli or container_agent');
  const check = overrides.checkExecutable ?? defaultExecutableCheck;
  for (const [name, path] of [['git_path', registration.git_path], ['gitleaks_path', registration.gitleaks_path]] as const) {
    try {
      check(path);
    } catch {
      throw new Error(`registration_tools.${name} '${path}' is not an executable file`);
    }
  }
  const runtime = createRegistrationRuntime({
    db: overrides.db, clock: overrides.clock ?? systemClock, gitPath: registration.git_path, gitleaksPath: registration.gitleaks_path,
    gitleaksConfigPath: registration.gitleaks_config ?? DEFAULT_GITLEAKS_CONFIG, evidenceDir: registration.evidence_dir ?? join(instanceDir, 'evidence'),
    ...(registration.scan_timeout_ms === undefined ? {} : { scanTimeoutMs: registration.scan_timeout_ms }),
  });
  return {
    ...built,
    agent: withRegistrationTools(built.agent, runtime),
    // 평가기가 저장된 근거 본문을 직접 읽는다. 출처 URL 조회는 research_agent 가 있을 때만 된다
    evaluation: { ...(built.evaluation ?? { fetcher: NO_SOURCE_FETCHER }), evidenceReader: runtime.store.reader },
  };
}

function buildAgentBase(config: AgentRuntimeConfig, instanceDir: string, overrides: AgentRuntimeOverrides, toolDescriptions?: Readonly<Record<string, string>>): AgentRuntimeBuild {
  const instanceId = config.instance_id ?? deriveInstanceId(instanceDir);
  if (!isValidInstanceId(instanceId)) throw new Error(`instance_id '${String(instanceId)}' must start with a letter or digit and contain only letters, digits, '_', '.', '-' (max 63 chars)`);
  const container = config.container_agent ?? undefined;
  const research = config.research_agent ?? undefined;
  const llmConfig = parseLlmVerifierConfig(config.llm_verifier);
  if (llmConfig !== undefined && research === undefined) throw new Error('llm_verifier needs research_agent (the evaluation port is wired only with it)');
  const claudeConfig = parseClaudeCodeCliConfig(config.claude_code_cli);
  if (claudeConfig !== undefined) {
    if (container === undefined && claudeConfig.roles !== undefined) throw new Error('claude_code_cli.roles is only for use with container_agent (without it every task runs on the claude_code_cli adapter)');
    if (container !== undefined && claudeConfig.roles === undefined) throw new Error('claude_code_cli.roles is required with container_agent: the roles that run on the subscription CLI (every other role runs on the container agent)');
  }
  const clock = overrides.clock ?? systemClock;
  const defaultTimeLimitMs = config.default_time_limit === undefined ? undefined : parseTimeLimit(config.default_time_limit);
  if (defaultTimeLimitMs === null) throw new Error(`default_time_limit '${String(config.default_time_limit)}' is not a valid time limit (for example "30m")`);
  const common = {
    runLogStore: createFileRunLogStore({ dir: config.run_log_dir ?? join(instanceDir, 'run-logs') }),
    ...(defaultTimeLimitMs === undefined ? {} : { defaultTimeLimitMs }),
    ...(overrides.recorder === undefined ? {} : { recorder: overrides.recorder }),
    ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
  };
  const claudeAdapter = claudeConfig === undefined ? undefined : buildClaudeAdapter(claudeConfig, clock, overrides, toolDescriptions);
  if (container === undefined) {
    if (research !== undefined) requireContainer(config);
    if (claudeAdapter === undefined) return { agent: undefined, evaluation: undefined, instanceId };
    // 구독 CLI 단독: 컨테이너가 없으므로 docker 확인·고아 정리도 없다(prepareAgentRuntime 은 null)
    return { agent: { ...common, adapter: claudeAdapter }, evaluation: undefined, instanceId };
  }
  // 컨테이너 어댑터와 함께면 roles 에 적은 역할만 구독 CLI 어댑터로 간다
  const withClaude = <T extends NonNullable<AssembleOptions['agent']>>(agent: T): T => claudeConfig === undefined || claudeAdapter === undefined ? agent : {
    ...agent,
    adapters: new Map([[CLAUDE_CODE_ADAPTER_NAME, claudeAdapter]]),
    selectAdapter: adapterByRole(Object.fromEntries((claudeConfig.roles ?? []).map((role) => [role, CLAUDE_CODE_ADAPTER_NAME]))),
  };
  const docker = createDockerCli({ path: container.docker_path, env: pickDockerEnv(process.env) });
  const limits = { memoryMiB: container.memory_mib, cpus: container.cpus, pidsLimit: container.pids_limit, tmpfsMiB: container.tmpfs_mib };
  const base = { docker, instanceId, ...common };

  if (research === undefined) {
    if (typeof container.image !== 'string') throw new Error('container_agent.image is required when research_agent is not set');
    const runner = createContainerRunner({
      docker, image: container.image, instance: instanceId, clock, limits,
      ...(container.agent_args === undefined ? {} : { agentArgs: container.agent_args }),
    });
    return { agent: withClaude({ ...base, adapter: containerAgentAdapter(runner) }), evaluation: undefined, instanceId };
  }

  if (!Array.isArray(research.allowed_hosts)) throw new Error('research_agent.allowed_hosts must be an array of host names (use [] to deny every host)');
  const fetchOptions: FetchUrlToolOptions = {
    allowedHosts: research.allowed_hosts,
    ...(research.max_body_bytes === undefined ? {} : { maxBodyBytes: research.max_body_bytes }),
    ...(research.max_redirects === undefined ? {} : { maxRedirects: research.max_redirects }),
    ...(research.fetch_unit_cost_usd === undefined ? {} : { unitCost: { usd: research.fetch_unit_cost_usd } }),
  };
  const fetchTool = (overrides.createFetchUrlTool ?? createFetchUrlTool)(fetchOptions);
  const sourceFetcher = (overrides.createSourceFetcher ?? createSourceFetcher)({
    ...fetchOptions,
    ...(research.source_fetch_timeout_ms === undefined ? {} : { fetchTimeoutMs: research.source_fetch_timeout_ms }),
    ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
  });
  return {
    agent: withClaude({
      ...base,
      adapter: createResearchAgentAdapter({ docker, image: research.image, instance: instanceId, clock, limits }),
      tools: [fetchTool.spec],
      executors: new Map([[fetchTool.spec.tool, fetchTool.executor]]),
    }),
    evaluation: {
      fetcher: sourceFetcher,
      ...(llmConfig === undefined ? {} : { llm: (overrides.createLlmVerifier ?? createStubFromConfig)(llmConfig) }),
    },
    instanceId,
  };
}
