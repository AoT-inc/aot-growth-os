// `claude-code-cli` 위임 검토자 (ADR-0016, docs/plans/delegate-reviewer.md). 구독 `claude` CLI 를 *도구 없이* 별도 호출로 불러, 위임 기준에 맞는 초안인지 판정을 받는다.
// 검증기(verifier.ts)와 같은 격리·동의·게이트를 쓴다(구독 풀이 하나다): `HOME USER LOGNAME PATH` 뿐인 환경, 내장 도구 없음, 빈 MCP 설정, 빈 작업 디렉터리(`delegate-<uuid>`), 프롬프트는 stdin.
//
// 던지는 것:
//  - `DelegateReviewerUnavailable`: 지금은 쓸 수 없다 — 동의 없음, 미룸(사람 우선 게이트), 자리 없음, 사용량 한도·서버 제한·로그인 만료·CLI 없음. 데몬이 이것을 자기 `DelegateReviewerUnavailableError` 로 바꾼다.
//    한도·로그인·CLI 문제는 `unavailableBackoffMs` 동안 안쪽 호출 없이 같은 오류를 바로 던진다. 자리 기다림은 하지 않는다.
//  - 그 밖의 오류(시간 초과·프로세스 실패·턴 한도·구조화 출력 없음·경계 표지 충돌): 보통 `Error`. 주기가 "AI 검토 실패"로 사람에게 넘긴다.
// 출력 해석은 이 모듈이 하지 않는다: 키가 정확히 `verdict`·`reason` 인 객체면 요청의 해시를 붙여 돌려주고, 아니면 모델의 값을 그대로 돌려준다(주기가 엄격히 검사해 사람에게 넘긴다).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import type { Clock } from '@aot/domain';
import type { DelegationReviewMaterial } from '@aot/policy';

import { nodeProcessPort, type ProcessPort } from '../docker.ts';
import { realGatewayTimers, type GatewayTimers } from '../gateway.ts';
import { maskString } from '../mask.ts';
import type { ClaudeCodeConsent } from './adapter.ts';
import { buildDelegateReviewerArgs, buildDelegateReviewerPrompt, DELEGATE_REVIEWER_PROMPT_VERSION } from './delegate-reviewer-prompt.ts';
import type { ClaudeCodeGate } from './gate.ts';
import { buildClaudeEnv, buildMcpConfig, type ClaudeEnvInput } from './invocation.ts';
import { runClaudeProcess } from './process-run.ts';
import { classifyRun, isClaudeCodeReviewCode } from './stream.ts';

/** 검토 기록에 남는 검토자 식별의 앞부분. 뒤에 프롬프트 버전과 모델 별칭이 붙는다 */
export const CLAUDE_CODE_DELEGATE_REVIEWER_NAME = 'claude-code-cli-delegate-reviewer';

/** 검토자를 지금은 쓸 수 없다 (동의 없음·사용량 한도·로그인 만료·자리 없음·CLI 없음). 검토 기록 없이 다음 tick 에 다시 한다 */
export class DelegateReviewerUnavailable extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DelegateReviewerUnavailable';
    this.code = code;
  }
}

/**
 * 검토 프로세스가 실제로 시작된 뒤의 실패 (시간 초과·턴 한도·구조화 출력 없음·출력 상한 등). 구독 한도를 이미 썼으므로 `costUsd` 를 달고 던진다:
 * CLI 가 알려 준 `total_cost_usd`(0 이하·무한대는 모르는 값), 없으면 `assumedCostUsd`. 시작도 못 한 실패(동의 없음·CLI 없음 등)는 이 오류가 아니고 비용이 없다.
 */
export class DelegateReviewerRunError extends Error {
  readonly costUsd: number;

  constructor(message: string, costUsd: number) {
    super(message);
    this.name = 'DelegateReviewerRunError';
    this.costUsd = costUsd;
  }
}

/** 데몬 `DelegateReviewer` 포트와 구조가 같다 (agent-runtime 은 데몬을 참조하지 않아 모양만 맞춘다) */
export interface ClaudeCodeDelegateReviewRequest {
  taskId: string;
  hash: string;
  material: DelegationReviewMaterial;
}

export interface ClaudeCodeDelegateReviewer {
  readonly id: string;
  review(request: ClaudeCodeDelegateReviewRequest): Promise<{ output: unknown; costUsd: number }>;
}

export interface ClaudeCodeDelegateReviewerOptions {
  claudePath: string;
  /** 호출 디렉터리를 만드는 절대 경로. 실행 어댑터·검증기와 같은 `runRoot` 를 써도 된다(이름이 `delegate-` 로 시작) */
  runRoot: string;
  env: ClaudeEnvInput;
  /** 실행 어댑터와 같은 동의 기록 읽기. null 이면 모든 검토가 `consent_required` 로 미뤄진다 */
  consent: ClaudeCodeConsent | null | (() => ClaudeCodeConsent | null);
  clock: Clock;
  /** 실행 어댑터·검증기와 *같은* 게이트 (구독 풀 공유) */
  gate: ClaudeCodeGate;
  /** 모델 별칭·이름. 기본 호출은 데몬 설정이 정한다 */
  model: string;
  process?: ProcessPort;
  timers?: GatewayTimers;
  /** 서로 다른 assistant 메시지 수 상한. 구조화 출력 호출까지 2턴이 보통이다. 기본 4 */
  maxTurns?: number;
  /** `--max-budget-usd` (정가 환산 추정치 기준). 기본 끔 */
  maxBudgetUsd?: number;
  /** 한 번의 검토 시간 상한. 넘으면 CLI 를 끝내고 사람에게 넘긴다. 기본 2분 (한 tick 에 최대 5건을 순서대로 검토하므로 5분이면 한 tick 이 25분 막힌다) */
  timeLimitMs?: number;
  /** CLI 가 비용을 주지 않을 때 기록할 값(USD). 한도가 실제로 걸리게 0 이 아니다. 기본 0.05 */
  assumedCostUsd?: number;
  /** 한도·로그인·CLI 문제 뒤 안쪽 호출 없이 바로 던지는 시간. 기본 10분 */
  unavailableBackoffMs?: number;
  /** 경계 표지 토큰 공급(시험용). 기본 128비트 무작위 */
  nonce?: () => string;
  limitPatterns?: readonly RegExp[];
  serverLimitPatterns?: readonly RegExp[];
  closeGraceMs?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
  maxLineBytes?: number;
  /** 진단 줄을 받는다(데몬 로그용) */
  log?: (message: string) => void;
}

/** 검토 호출에는 MCP 서버가 하나도 없어야 한다 */
const NO_MCP_SERVER = '(none)';
const MAX_TIME_LIMIT_MS = 3_600_000;
// 한 tick(검토 5건)이 막히는 시간의 상한을 줄이려고 2분이다. 더 길게 쓰려면 설정 `timeout_ms` 로 올린다
const DEFAULT_TIME_LIMIT_MS = 120_000;
const DEFAULT_BACKOFF_MS = 10 * 60_000;
export const DEFAULT_ASSUMED_COST_USD = 0.05;

/** 모델 출력 모양이 키 정확히 `verdict`·`reason` 인 객체인가 */
const hasExactKeys = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === 'reason' && keys[1] === 'verdict';
};

export function createClaudeCodeDelegateReviewer(options: ClaudeCodeDelegateReviewerOptions): ClaudeCodeDelegateReviewer {
  if (!isAbsolute(options.claudePath) || /[\0\r\n]/.test(options.claudePath)) throw new Error('claudePath must be an absolute path (it is never looked up on PATH)');
  if (!isAbsolute(options.runRoot) || /[\0\r\n]/.test(options.runRoot)) throw new Error('runRoot must be an absolute path');
  const env = buildClaudeEnv(options.env);
  buildDelegateReviewerArgs({ mcpConfigPath: join(options.runRoot, 'x'), model: options.model, ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }) }); // 설정 오류는 만들 때 던진다
  const clock = options.clock;
  const timers = options.timers ?? realGatewayTimers;
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const backoffMs = options.unavailableBackoffMs ?? DEFAULT_BACKOFF_MS;
  const assumedCostUsd = options.assumedCostUsd ?? DEFAULT_ASSUMED_COST_USD;
  if (!(Number.isInteger(timeLimitMs) && timeLimitMs > 0 && timeLimitMs <= MAX_TIME_LIMIT_MS)) throw new Error(`timeLimitMs must be an integer from 1 to ${MAX_TIME_LIMIT_MS}`);
  if (!(Number.isInteger(backoffMs) && backoffMs >= 0)) throw new Error('unavailableBackoffMs must be an integer >= 0');
  if (!(Number.isFinite(assumedCostUsd) && assumedCostUsd >= 0)) throw new Error('assumedCostUsd must be a finite number >= 0');
  const processOptions = {
    claudePath: options.claudePath, env, port: options.process ?? nodeProcessPort, timers,
    maxTurns: options.maxTurns ?? 4, closeGraceMs: options.closeGraceMs ?? 5000, maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
    maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024, maxLineBytes: options.maxLineBytes ?? 1024 * 1024,
  };
  const id = `${CLAUDE_CODE_DELEGATE_REVIEWER_NAME}@${DELEGATE_REVIEWER_PROMPT_VERSION}:${options.model}`;
  const log = (message: string): void => options.log?.(maskString(message).slice(0, 1500));
  /** 한도·로그인·CLI 문제로 풀릴 때까지 안쪽 호출을 하지 않는 시각 (메모리만: 재시작하면 한 번 다시 시도한다) */
  let blocked: { code: string; message: string; untilMs: number } | null = null;

  async function review(request: ClaudeCodeDelegateReviewRequest): Promise<{ output: unknown; costUsd: number }> {
    // ----- 시작 전 검사: 여기서 던지면 CLI 를 띄우지 않는다 -----
    const consent = typeof options.consent === 'function' ? options.consent() : options.consent;
    if (consent === null || typeof consent.notice_version !== 'string' || consent.notice_version.trim() === '' || typeof consent.accepted_at !== 'string' || consent.accepted_at === '') {
      throw new DelegateReviewerUnavailable('consent_required', 'the first-run notice has not been accepted (approval CLI: consent accept); the delegate reviewer uses the same subscription as the agent runs');
    }
    const now = clock.nowMs();
    if (blocked !== null && blocked.untilMs > now) {
      throw new DelegateReviewerUnavailable(blocked.code, `${blocked.message} (not retried before ${new Date(blocked.untilMs).toISOString()})`);
    }
    let prompt;
    try {
      prompt = buildDelegateReviewerPrompt(request.material, options.nonce === undefined ? {} : { nonce: options.nonce() });
    } catch (cause) {
      throw new Error(`the review prompt could not be built: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    }
    // 자리를 기다리지 않는다: 실행 어댑터가 쓰는 중이면 이번 tick 은 건너뛴다
    if (!options.gate.tryAcquire()) throw new DelegateReviewerUnavailable('busy', 'the subscription CLI is busy with another run; the review is retried on a later tick');
    try {
      const deferral = options.gate.deferral();
      if (deferral !== null) throw new DelegateReviewerUnavailable('usage_deferred', deferral);
      return await invoke(request, prompt.text);
    } finally {
      options.gate.release();
    }
  }

  async function invoke(request: ClaudeCodeDelegateReviewRequest, promptText: string): Promise<{ output: unknown; costUsd: number }> {
    const runDir = join(options.runRoot, `delegate-${randomUUID()}`);
    const workdir = join(runDir, 'work');
    let created = false;
    const controller = new AbortController();
    let timedOut = false;
    const timer = timers.setTimeout(() => { timedOut = true; controller.abort(); }, timeLimitMs);
    let args: string[];
    try {
      try {
        await mkdir(options.runRoot, { recursive: true, mode: 0o700 });
        await mkdir(runDir, { mode: 0o700 });
        created = true;
        await mkdir(workdir, { mode: 0o700 });
        const mcpConfigPath = join(runDir, 'empty-mcp.json');
        await writeFile(mcpConfigPath, buildMcpConfig(null), { mode: 0o600 });
        args = buildDelegateReviewerArgs({ mcpConfigPath, model: options.model, ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }) });
      } catch (cause) {
        throw new Error(`the review could not be prepared: ${cause instanceof Error ? cause.message : 'unknown error'}`);
      }
      const processed = await runClaudeProcess(processOptions, {
        args, cwd: workdir, signal: controller.signal, stdin: promptText, note: log,
        expected: { gatewayServer: NO_MCP_SERVER, gatewayTools: [], builtinTools: [] },
        requireInit: true,
      });
      options.gate.observe(processed.state);
      const tokens = processed.state.result?.tokens ?? null;
      // 프로세스가 시작된 뒤의 실패는 비용을 달고 던진다 (CLI 가 준 값이 0·음수·무한대면 모르는 값: 가정 비용)
      const reported = processed.state.result?.totalCostUsd;
      const costUsd = typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : assumedCostUsd;
      const failed = (message: string): never => { throw new DelegateReviewerRunError(message, costUsd); };
      const final = processed.ending;
      switch (final.kind) {
        case 'cancelled':
          return failed(timedOut ? `the review took longer than ${timeLimitMs} ms and was stopped` : 'the review was cancelled');
        case 'spawn_error':
          return block('cli_unavailable', `the claude CLI could not be started: ${final.message.slice(0, 200)}`);
        case 'turn_limit':
          return failed(`the delegate reviewer used more than ${processOptions.maxTurns} turns; it was stopped`);
        case 'init_problem':
          return failed(`${final.code}: ${final.message}`);
        case 'output_limit':
          return failed(`output limit: ${final.message}`);
        case 'closed':
          break;
      }
      const classified = classifyRun(processed.state, processed.exit, processed.stderrText, {
        ...(options.limitPatterns === undefined ? {} : { limitPatterns: options.limitPatterns }),
        ...(options.serverLimitPatterns === undefined ? {} : { serverLimitPatterns: options.serverLimitPatterns }),
        parseOutput: (output) => ({ ok: true, result: output, evidence: [] }),
      });
      if (!classified.ok) {
        log(`classified as ${classified.code}${tokens === null ? '' : ` (${tokens} tokens)`}`);
        if (isClaudeCodeReviewCode(classified.code)) return block(classified.code, classified.message);
        return failed(`${classified.code}: ${classified.message}`);
      }
      const raw: unknown = classified.result;
      // 해시는 모델이 되풀이하지 않는다: 키가 정확히 verdict·reason 일 때만 요청의 해시를 붙인다. 그 밖은 그대로 돌려줘 주기가 거른다
      const output = hasExactKeys(raw) ? { verdict: raw['verdict'], reason: raw['reason'], hash: request.hash } : raw;
      return { output, costUsd };
    } finally {
      timers.clearTimeout(timer);
      if (created) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** 풀릴 때까지 안쪽 호출을 하지 않도록 기억하고 던진다 */
  function block(code: string, message: string): never {
    blocked = { code, message: maskString(message).slice(0, 300), untilMs: clock.nowMs() + backoffMs };
    log(`delegate reviewer unavailable (${code}): ${blocked.message}`);
    throw new DelegateReviewerUnavailable(code, blocked.message);
  }

  return { id, review };
}
