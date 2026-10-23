// 데몬 설정(config/daemon.config.example.json)에서 에이전트 실행 환경을 만든다 (A5 U6). main.ts 가 아니라 이 모듈에 둔 이유: main.ts 는 import 하면 바로 데몬을
// 시작하므로, 설정 → 조립 경로를 시험(test/integration/daemon-research-pipeline.test.ts)이 import 해서 쓸 수 없기 때문이다.
//
// 연결하는 것 (모두 설정이 있을 때만, 없으면 기존 동작 그대로):
//   container_agent  Docker 경로·자원 상한. 있으면 컨테이너 샌드박스 어댑터를 실행 관리에 연결한다(A5 U4).
//   research_agent   조사 에이전트 이미지 + 허용 호스트. container_agent 와 함께 있을 때만 의미가 있다:
//                      - 어댑터 = createResearchAgentAdapter (이미지는 research_agent.image)
//                      - 도구 = `fetch_url` 선언·실행기 (허용 호스트 = research_agent.allowed_hosts, 비어 있으면 모두 거부)
//                      - 평가 포트 = 같은 허용 호스트·같은 SSRF 규칙의 출처 조회기(createSourceFetcher) → `validating` 업무가 실제 출처 조회 검증을 받는다
//                    research_agent 가 없으면 평가 포트를 넘기지 않는다: `validating` 업무는 검증되지 않고 그대로 남는다(자동 완료 없음, A4 이후 동작 유지).
// 비밀값은 설정에 넣지 않는다(이미지 ID·호스트 이름·숫자뿐이다). 시험 전용 주입점(`overrides`)은 코드에서만 넘길 수 있고 설정 파일로는 닿지 않는다.
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  containerAgentAdapter, createContainerRunner, createDockerCli, createFetchUrlTool, createFileRunLogStore, createResearchAgentAdapter, createSourceFetcher,
  isValidInstanceId, pickDockerEnv,
  type FetchUrlTool, type FetchUrlToolOptions, type GatewayTimers, type SourceFetcherOptions, type ToolCallRecorder,
} from '@aot/agent-runtime';
import { parseTimeLimit, systemClock, type Clock } from '@aot/domain';
import type { SourceFetcher } from '@aot/evaluation';

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

export interface AgentRuntimeConfig {
  container_agent?: ContainerAgentConfig | null;
  research_agent?: ResearchAgentConfig | null;
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
  /** `fetch_url` 도구 생성기. 설정에서 만든 옵션(허용 호스트 포함)을 그대로 받는다 */
  createFetchUrlTool?: (options: FetchUrlToolOptions) => FetchUrlTool;
  /** 출처 조회기 생성기. 같은 옵션을 받는다 */
  createSourceFetcher?: (options: SourceFetcherOptions) => SourceFetcher;
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

export function buildAgentRuntime(config: AgentRuntimeConfig, instanceDir: string, overrides: AgentRuntimeOverrides = {}): AgentRuntimeBuild {
  const instanceId = config.instance_id ?? deriveInstanceId(instanceDir);
  if (!isValidInstanceId(instanceId)) throw new Error(`instance_id '${String(instanceId)}' must start with a letter or digit and contain only letters, digits, '_', '.', '-' (max 63 chars)`);
  const container = config.container_agent ?? undefined;
  const research = config.research_agent ?? undefined;
  if (container === undefined) {
    if (research !== undefined) requireContainer(config);
    return { agent: undefined, evaluation: undefined, instanceId };
  }
  const clock = overrides.clock ?? systemClock;
  const defaultTimeLimitMs = config.default_time_limit === undefined ? undefined : parseTimeLimit(config.default_time_limit);
  if (defaultTimeLimitMs === null) throw new Error(`default_time_limit '${String(config.default_time_limit)}' is not a valid time limit (for example "30m")`);
  const docker = createDockerCli({ path: container.docker_path, env: pickDockerEnv(process.env) });
  const limits = { memoryMiB: container.memory_mib, cpus: container.cpus, pidsLimit: container.pids_limit, tmpfsMiB: container.tmpfs_mib };
  const base = {
    docker,
    runLogStore: createFileRunLogStore({ dir: config.run_log_dir ?? join(instanceDir, 'run-logs') }),
    instanceId,
    ...(defaultTimeLimitMs === undefined ? {} : { defaultTimeLimitMs }),
    ...(overrides.recorder === undefined ? {} : { recorder: overrides.recorder }),
    ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
  };

  if (research === undefined) {
    if (typeof container.image !== 'string') throw new Error('container_agent.image is required when research_agent is not set');
    const runner = createContainerRunner({
      docker, image: container.image, instance: instanceId, clock, limits,
      ...(container.agent_args === undefined ? {} : { agentArgs: container.agent_args }),
    });
    return { agent: { ...base, adapter: containerAgentAdapter(runner) }, evaluation: undefined, instanceId };
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
    agent: {
      ...base,
      adapter: createResearchAgentAdapter({ docker, image: research.image, instance: instanceId, clock, limits }),
      tools: [fetchTool.spec],
      executors: new Map([[fetchTool.spec.tool, fetchTool.executor]]),
    },
    evaluation: { fetcher: sourceFetcher },
    instanceId,
  };
}
