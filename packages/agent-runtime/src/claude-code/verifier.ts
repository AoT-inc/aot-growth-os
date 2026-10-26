// `claude-code-cli` LLM 검증기 (Q22, docs/plans/registration-dogfood.md 3단계). 구독 `claude` CLI 를 *도구 없이* 별도 호출로 불러 주장 문장이 출처 본문에 뒷받침되는지 판정한다.
//
// 실행 어댑터와의 관계:
//  - 같은 환경 규칙(`HOME USER LOGNAME PATH` 뿐, 토큰·API 키 비접촉)과 같은 동의 기록(첫 실행 고지), 같은 게이트(동시 실행 한도·사람 우선 게이트)를 쓴다 — 구독 풀이 하나이기 때문이다 (Q22 d).
//  - 다른 점: 내장 도구 없음, 게이트웨이 MCP 없음, 빈 작업 디렉터리(세션·파일 비공유), 모델 별칭은 설정이 따로 정한다 (Q22 a·b). 입력은 `IsolatedVerificationInput` 뿐이다.
//
// 던지는 것 (ports.ts `LlmVerifier` 계약):
//  - `VerifierUnavailableError`: 지금은 검증할 수 없다 — 동의 없음, 미룸(사람 우선 게이트), 자리 없음(실행 어댑터가 쓰는 중), 사용량 한도·서버 제한·로그인 만료·CLI 없음.
//    평가기는 이 오류를 위로 던지고 업무는 `validating` 에 남아 다음 tick(기본 5초)에 다시 온다. **tick 마다 CLI 를 띄우지 않도록** 한도·로그인·CLI 문제는 `unavailableBackoffMs` 동안 안쪽 호출 없이 같은 오류를 바로 던진다.
//    자리 기다림도 하지 않는다(tick 을 붙들지 않는다): 자리가 없으면 바로 던진다.
//  - 그 밖의 오류(모델 출력이 모양에 안 맞음·시간 초과·격리 위반·턴 한도 등): 평가기가 `unclear` 로 기록해 사람 검토로 간다. 재시도 루프로 토큰을 태우지 않는다.
//  - 모델이 판단하지 못한 것은 오류가 아니라 `unclear` 판정이다.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import type { Clock } from '@aot/domain';
import { ISOLATED_INPUT_KEYS, IsolationError, VerifierUnavailableError, type IsolatedVerificationInput, type LlmVerdict, type LlmVerifier } from '@aot/evaluation';

import { nodeProcessPort, type ProcessPort } from '../docker.ts';
import { realGatewayTimers, type GatewayTimers } from '../gateway.ts';
import { maskString } from '../mask.ts';
import type { ClaudeCodeConsent } from './adapter.ts';
import type { ClaudeCodeGate } from './gate.ts';
import { buildClaudeEnv, buildMcpConfig, type ClaudeEnvInput } from './invocation.ts';
import { runClaudeProcess } from './process-run.ts';
import { classifyRun, isClaudeCodeReviewCode } from './stream.ts';
import { aggregateVerdict, buildVerifierArgs, buildVerifierPrompt, VERIFIER_PROMPT_VERSION } from './verifier-prompt.ts';

/** 평가 기록의 메모에 남는 검증기 식별의 앞부분. 뒤에 모델 별칭이 붙는다 */
export const CLAUDE_CODE_VERIFIER_NAME = 'claude-code-cli-verifier';

export interface ClaudeCodeVerifierOptions {
  claudePath: string;
  /** 호출 디렉터리를 만드는 절대 경로. 실행 어댑터와 같은 `runRoot` 를 써도 된다(이름이 `verify-` 로 시작) */
  runRoot: string;
  env: ClaudeEnvInput;
  /** 실행 어댑터와 같은 동의 기록 읽기. null 이면 모든 검증이 `consent_required` 로 미뤄진다 */
  consent: ClaudeCodeConsent | null | (() => ClaudeCodeConsent | null);
  clock: Clock;
  /** 실행 어댑터와 *같은* 게이트 (구독 풀 공유) */
  gate: ClaudeCodeGate;
  /** 검증 모델 별칭·이름. 실행과 다른 등급으로 둔다 (Q22 b) */
  model: string;
  process?: ProcessPort;
  timers?: GatewayTimers;
  /** 서로 다른 assistant 메시지 수 상한. 구조화 출력 호출까지 2턴이 보통이다. 기본 4 */
  maxTurns?: number;
  /** `--max-budget-usd` (정가 환산 추정치 기준). 기본 끔 */
  maxBudgetUsd?: number;
  /** 한 번의 검증 시간 상한. 넘으면 CLI 를 끝내고 `unclear` 로 간다. 기본 5분 */
  timeLimitMs?: number;
  /** 프롬프트에 넣는 출처 본문 합의 상한(바이트). 넘으면 큰 본문부터 줄인다. 기본 200_000 */
  maxSourceBytes?: number;
  /** 한도·로그인·CLI 문제 뒤 안쪽 호출 없이 바로 던지는 시간. 기본 10분 */
  unavailableBackoffMs?: number;
  limitPatterns?: readonly RegExp[];
  serverLimitPatterns?: readonly RegExp[];
  closeGraceMs?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
  maxLineBytes?: number;
  /** 진단 줄을 받는다(데몬 로그용). 검증기는 run_log 를 따로 남기지 않는다 */
  log?: (message: string) => void;
}

/** 검증기 호출에는 MCP 서버가 하나도 없어야 한다: 어떤 이름의 서버도 기대 밖이다 */
const NO_MCP_SERVER = '(none)';
const MAX_TIME_LIMIT_MS = 3_600_000;
const DEFAULT_TIME_LIMIT_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MS = 10 * 60_000;
const DEFAULT_MAX_SOURCE_BYTES = 200_000;

/** 구독 CLI 가 풀릴 때까지 기다려야 하는 분류 코드 (실행 어댑터의 검토 코드와 같다) */
const isUnavailableCode = (code: string): boolean => isClaudeCodeReviewCode(code);

export function createClaudeCodeVerifier(options: ClaudeCodeVerifierOptions): LlmVerifier {
  if (!isAbsolute(options.claudePath) || /[\0\r\n]/.test(options.claudePath)) throw new Error('claudePath must be an absolute path (it is never looked up on PATH)');
  if (!isAbsolute(options.runRoot) || /[\0\r\n]/.test(options.runRoot)) throw new Error('runRoot must be an absolute path');
  const env = buildClaudeEnv(options.env);
  buildVerifierArgs({ mcpConfigPath: join(options.runRoot, 'x'), model: options.model, ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }) }); // 설정 오류는 만들 때 던진다
  const clock = options.clock;
  const timers = options.timers ?? realGatewayTimers;
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const backoffMs = options.unavailableBackoffMs ?? DEFAULT_BACKOFF_MS;
  if (!(Number.isInteger(timeLimitMs) && timeLimitMs > 0 && timeLimitMs <= MAX_TIME_LIMIT_MS)) throw new Error(`timeLimitMs must be an integer from 1 to ${MAX_TIME_LIMIT_MS}`);
  if (!(Number.isInteger(maxSourceBytes) && maxSourceBytes > 0)) throw new Error('maxSourceBytes must be a positive integer');
  if (!(Number.isInteger(backoffMs) && backoffMs >= 0)) throw new Error('unavailableBackoffMs must be an integer >= 0');
  const processOptions = {
    claudePath: options.claudePath, env, port: options.process ?? nodeProcessPort, timers,
    maxTurns: options.maxTurns ?? 4, closeGraceMs: options.closeGraceMs ?? 5000, maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
    maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024, maxLineBytes: options.maxLineBytes ?? 1024 * 1024,
  };
  const id = `${CLAUDE_CODE_VERIFIER_NAME}@${VERIFIER_PROMPT_VERSION}:${options.model}`;
  const log = (message: string): void => options.log?.(maskString(message).slice(0, 1500));
  /** 한도·로그인·CLI 문제로 풀릴 때까지 안쪽 호출을 하지 않는 시각 (메모리만: 재시작하면 한 번 다시 시도한다) */
  let blocked: { code: string; message: string; untilMs: number } | null = null;

  async function verify(input: IsolatedVerificationInput): Promise<LlmVerdict> {
    const keys = Object.keys(input).sort();
    if (keys.length !== ISOLATED_INPUT_KEYS.length || keys.some((key, index) => key !== ISOLATED_INPUT_KEYS[index])) {
      throw new IsolationError(`the verification input must have exactly the keys ${ISOLATED_INPUT_KEYS.join(', ')}`);
    }
    if (input.claims.length === 0) return { verdict: 'unclear', note: 'no claim to verify' };
    // 주장 id 는 실행 에이전트가 정한다: 겹치면 한 번의 답이 두 주장을 덮을 수 있으므로 판정하지 않는다
    if (new Set(input.claims.map((claim) => claim.id)).size !== input.claims.length) throw new Error('the claims have duplicate ids; the verification needs one answer per claim id');

    // ----- 시작 전 검사: 여기서 던지면 CLI 를 띄우지 않는다 -----
    const consent = typeof options.consent === 'function' ? options.consent() : options.consent;
    if (consent === null || typeof consent.notice_version !== 'string' || consent.notice_version.trim() === '' || typeof consent.accepted_at !== 'string' || consent.accepted_at === '') {
      throw new VerifierUnavailableError('consent_required', 'the first-run notice has not been accepted (approval CLI: consent accept); the verifier uses the same subscription as the agent runs');
    }
    const now = clock.nowMs();
    if (blocked !== null && blocked.untilMs > now) {
      throw new VerifierUnavailableError(blocked.code, `${blocked.message} (not retried before ${new Date(blocked.untilMs).toISOString()})`);
    }
    let prompt;
    try {
      prompt = buildVerifierPrompt(input, { maxSourceBytes });
    } catch (cause) {
      throw new Error(`the verification prompt could not be built: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    }
    // 비밀 모양 값이 든 주장 문장은 마스킹하면 출처와 대조할 수 없다(서로 다른 값이 같은 `[REDACTED]` 가 된다): 모델에 보내지 않고 사람에게 넘긴다
    if (prompt.maskedClaimIds.length > 0) {
      return { verdict: 'unclear', note: `claim(s) ${prompt.maskedClaimIds.slice(0, 5).map((id) => id.slice(0, 40)).join(', ')} contain a secret-shaped value, so they cannot be compared with their sources; not sent to the model` };
    }
    // 자리를 기다리지 않는다: 실행 어댑터가 쓰는 중이면 이번 tick 은 건너뛴다 (tick 을 붙들면 실행 업무도 못 집는다)
    if (!options.gate.tryAcquire()) throw new VerifierUnavailableError('busy', 'the subscription CLI is busy with another run; the verification is retried on a later tick');
    try {
      const deferral = options.gate.deferral();
      if (deferral !== null) throw new VerifierUnavailableError('usage_deferred', deferral);
      return await invoke(input, prompt);
    } finally {
      options.gate.release();
    }
  }

  async function invoke(input: IsolatedVerificationInput, prompt: ReturnType<typeof buildVerifierPrompt>): Promise<LlmVerdict> {
    const runDir = join(options.runRoot, `verify-${randomUUID()}`);
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
        args = buildVerifierArgs({ mcpConfigPath, model: options.model, ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }) });
      } catch (cause) {
        throw new Error(`the verification could not be prepared: ${cause instanceof Error ? cause.message : 'unknown error'}`);
      }
      if (prompt.truncated.length > 0) log(`verification input was cut to fit ${maxSourceBytes} bytes: ${prompt.truncated.map((t) => `${t.ref} (-${t.omittedBytes} bytes)`).join(', ')}`);
      if (prompt.maskedParts > 0) log(`${prompt.maskedParts} part(s) of the verification input were masked before being sent`);

      const processed = await runClaudeProcess(processOptions, {
        args, cwd: workdir, signal: controller.signal, stdin: prompt.text, note: log,
        expected: { gatewayServer: NO_MCP_SERVER, gatewayTools: [], builtinTools: [] },
        requireInit: true,
      });
      options.gate.observe(processed.state);
      const tokens = processed.state.result?.tokens ?? null;
      const final = processed.ending;
      switch (final.kind) {
        case 'cancelled':
          throw new Error(timedOut ? `the verification took longer than ${timeLimitMs} ms and was stopped` : 'the verification was cancelled');
        case 'spawn_error':
          return block('cli_unavailable', `the claude CLI could not be started: ${final.message.slice(0, 200)}`);
        case 'turn_limit':
          throw new Error(`the verifier used more than ${processOptions.maxTurns} turns; it was stopped`);
        case 'init_problem':
          throw new Error(`${final.code}: ${final.message}`);
        case 'output_limit':
          throw new Error(`output limit: ${final.message}`);
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
        if (isUnavailableCode(classified.code)) return block(classified.code, classified.message);
        throw new Error(`${classified.code}: ${classified.message}`);
      }
      const parsed = aggregateVerdict(classified.result, input.claims.map((claim) => claim.id));
      // 잘림 표시는 길이 상한에 먼저 자리를 잡는다 (뒤에서 잘려 사라지지 않게)
      const truncatedNote = prompt.truncated.length > 0 ? ` [input cut: ${prompt.truncated.length} source(s)]` : '';
      return { verdict: parsed.verdict, note: `${parsed.note.slice(0, 500 - truncatedNote.length)}${truncatedNote}`, ...(classified.tokens === null ? {} : { tokens: classified.tokens }) };
    } finally {
      timers.clearTimeout(timer);
      if (created) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** 풀릴 때까지 안쪽 호출을 하지 않도록 기억하고 던진다 */
  function block(code: string, message: string): never {
    blocked = { code, message: maskString(message).slice(0, 300), untilMs: clock.nowMs() + backoffMs };
    log(`verifier unavailable (${code}): ${blocked.message}`);
    throw new VerifierUnavailableError(code, blocked.message);
  }

  return { id, verify };
}
