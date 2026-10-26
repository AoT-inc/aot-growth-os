// 도구 게이트웨이 (단계 A5 U2). 에이전트의 유일한 바깥 통신 경로이며 `ToolGateway` 포트(contract.ts)를 구현한다 (trust-boundaries §3.1-3).
// run 하나에 인스턴스 하나를 만든다(호출은 run 의 허용 도구·예산·외부 입력 영향 상태를 공유한다). 호출 하나의 처리 순서:
//   1. 인자 검증(JSON 객체) → run 취소 확인 → 허용 목록 확인(밖이면 `tool_not_allowed`; 정책·실행기는 부르지 않는다)
//   2. 정책 재판정: 호출마다 `ToolCallPolicy.judge` 를 새로 부른다(업무 시작 때의 판정을 재사용하지 않는다).
//      deny → `policy_denied`, require_approval → `approval_required`(막힘. 게이트웨이에는 승인 경로가 없고 에이전트는 승인을 대신할 수 없다),
//      판정을 못 얻으면(예외·이상한 응답) `policy_unavailable`(기본 거부). 거부되면 실행기는 호출되지 않는다.
//   3. 실행: 도구 실행기 레지스트리에서만 실제 외부 접근이 일어난다. 도구 호출 타임아웃이 지나면 실행기에 AbortSignal 을 보내고
//      즉시 `tool_timeout` 으로 답한다(실행기가 신호를 무시해도 응답은 나간다). 그 뒤 늦게 끝난 실행기의 결과·비용·출처는 모두 버린다.
//   4. 후처리: 비용 계량, 외부 출처 결과 표시, 결과 크기 상한(MAX_FRAME_BYTES 에 맞춤) 초과 시 잘라 응답.
// 외부 입력 영향 표시 (trust-boundaries §2-3): 외부 출처 도구(`resultOrigin:'external_untrusted'`, 예: 웹 페이지 조회)의 결과가 에이전트에
// 전달된 뒤(또는 run 입력에 외부 콘텐츠가 있으면 처음부터) 이 run 의 모든 호출을 "외부 입력의 영향 하에 있는 호출"로 표시한다.
// 외부 콘텐츠가 어느 호출을 유도했는지는 알 수 없으므로 run 단위로 보수적으로 표시하고, 표시는 되돌아가지 않는다.
// 표시는 정책 판정 입력(`influencedByExternalInput`)과 호출 기록에 들어간다. 부작용 호출은 승인이 필요하다:
// 정책 구현(policy 의 createToolCallPolicy)이 올리고, 게이트웨이도 하한으로 한 번 더 막는다(정책 포트가 allow 를 줘도 막힘).
// 모든 호출(허용·거부·타임아웃·오류)은 `ToolCallRecord` 와 run_log 항목으로 남고, 인자·결과·오류 문구의 비밀값은 가려서 남긴다(mask.ts).
// 응답에는 오류 코드만 담는다: 정책 사유·규칙 id 는 에이전트에 알리지 않고 기록에만 남긴다 (trust-boundaries §2-2).
// 시각은 주입된 Clock, 타임아웃은 주입 가능한 타이머 포트(기본 실제 타이머)를 쓴다. 인자는 판정·실행·기록이 같은 동결된 사본을 보며 바꾸지 않는다.
import { Buffer } from 'node:buffer';

import { isNonBlankString, SCOPES } from '@aot/domain';
import type { Clock, Impact, PolicyDecisionValue, Scope, ToolCallConstraints, ToolCallPolicy, ToolCallPolicyRequest, ToolCallPolicyVerdict } from '@aot/domain';

import type { AdapterCost, AdapterInput, CostProgressEvent, JsonObject, JsonValue, RunLogEntry, ToolGateway, ToolGatewayResponse } from './contract.ts';
import { isEffectLedgerBound } from './effect-ledger.ts';
import { MAX_FRAME_BYTES } from './frames.ts';
import { maskString, previewJson } from './mask.ts';
import { isJsonObject, isJsonValue } from './validate.ts';

// ===== 설정 =====

export type ToolResultOrigin = 'internal' | 'external_untrusted';

/** run 에 허용된 도구 하나. 에이전트가 부르는 이름 하나에 operation 하나다 (정책의 행위 = `<tool>.<operation>`) */
export interface GatewayToolSpec {
  tool: string;
  /**
   * 에이전트가 이 도구를 부르는 이름. 생략하면 `tool` 이다. 도구 하나가 operation 을 여럿 가질 때(예: `repo_read` 의 list_tree·read_file …) 작업마다 이름을 달리해 부른다
   * (예: `repo_read_read_file`). 정책의 행위(`<tool>.<operation>`)·명세의 `allowed_tools`·실행기는 이름이 아니라 `tool`·`operation` 으로 정해진다.
   */
  name?: string;
  operation: string;
  /** 정책 판정의 대상(resource). 선언이 없으면 생략 */
  target?: string;
  scope: Scope;
  /** 생략하면 sideEffect ? 'external_effect' : 'read'. sideEffect 와 어긋나면(read 인데 부작용, 부작용 없는데 write 등) 설정 오류 */
  impact?: Impact;
  /** 부작용이 있는 도구인가. 외부 입력의 영향을 받은 run 에서는 승인 없이 호출할 수 없다 */
  sideEffect: boolean;
  /** 결과의 출처. 외부 출처 결과를 받은 뒤의 호출은 외부 입력 영향 호출로 표시된다. 기본 'internal' */
  resultOrigin?: ToolResultOrigin;
  /** 실행기가 비용을 돌려주지 않을 때(또는 오류·타임아웃으로 못 돌려줄 때) 호출마다 계량하는 단위 비용 */
  unitCost?: AdapterCost;
  /** 이 도구의 타임아웃(밀리초). 생략하면 게이트웨이의 `toolTimeoutMs` */
  timeoutMs?: number;
}

/** 실행기에 넘기는 요청. `args` 는 동결된 사본이라 바꿀 수 없다 */
export interface ToolExecutionRequest {
  runId: string;
  tool: string;
  operation: string;
  args: Readonly<JsonObject>;
  /** 타임아웃·run 취소 때 abort 된다. 실행기는 가능한 한 빨리 멈춰야 한다 */
  signal: AbortSignal;
  /**
   * 이 run 의 업무 제약(예산·시간·`network_allowlist` 등). 동결된 사본이다. 정책 엔진은 `network_allowlist` 를 강제하지 않으므로
   * 외부에 나가는 실행기(`fetch_url`)가 스스로 적용한다. 실행기는 이 값으로 권한을 넓히지 못한다(좁히기만 한다).
   */
  constraints: Readonly<ToolCallConstraints>;
}

export interface ToolExecutionResult {
  result: JsonValue;
  /** 이 호출의 비용. 생략하면 도구의 `unitCost` */
  cost?: AdapterCost;
}

/** 실제 외부 접근을 하는 함수. 비밀값은 여기서(어댑터가) 주입하고 인자·결과에 싣지 않는다 (trust-boundaries §3) */
export type ToolExecutor = (request: ToolExecutionRequest) => Promise<ToolExecutionResult>;

/** 타임아웃용 타이머 포트. 시험은 손으로 돌리는 구현을 주입한다 */
export interface GatewayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realGatewayTimers: GatewayTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 호출 기록 포트. 게이트웨이는 호출마다 동결된 기록을 넘기고 응답 전에 기다린다. 던져도 응답에는 영향이 없다(`recorderFailures()` 로 센다) */
export interface ToolCallRecorder {
  record(record: ToolCallRecord): void | Promise<void>;
}

export interface ToolGatewayOptions {
  runId: string;
  taskId?: string | null;
  /** 정책 주체 `<role>@v<role_version>` */
  subject: string;
  /** 이 run 에 허용된 도구 */
  tools: readonly GatewayToolSpec[];
  /** 도구 이름 → 실행기. 허용 도구는 모두 여기에 있어야 한다 */
  executors: ReadonlyMap<string, ToolExecutor>;
  policy: ToolCallPolicy;
  recorder?: ToolCallRecorder;
  clock: Clock;
  /** 정책 판정에 넘기는 업무 제약 (`toolCallConstraintsOf`) */
  constraints: ToolCallConstraints;
  /** 도구 호출 타임아웃(밀리초) 기본값 */
  toolTimeoutMs: number;
  timers?: GatewayTimers;
  /** run 취소 신호. abort 되면 진행 중인 호출을 멈추고 새 호출은 `run_cancelled` 로 거부한다 */
  signal?: AbortSignal;
  /** 게이트웨이가 계량한 도구 비용의 누적 보고 (같은 단위 안에서 줄지 않는다) */
  onCostProgress?: (event: CostProgressEvent) => void;
  /** run 입력에 외부 콘텐츠가 이미 들어 있으면 true: 처음부터 모든 호출을 외부 입력 영향 호출로 표시한다 */
  externalInput?: boolean;
}

// ===== 기록 =====

export const GATEWAY_ERROR_CODES = [
  'tool_not_allowed', 'invalid_args', 'run_cancelled', 'policy_denied', 'approval_required', 'policy_unavailable', 'tool_timeout', 'tool_error',
] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];
export type ToolCallOutcome = 'ok' | GatewayErrorCode;

/** 호출 하나의 기록. JSON 으로 오가는 데이터라 필드 이름이 snake_case 다 */
export interface ToolCallRecord {
  seq: number;
  run_id: string;
  /** 호출을 받은 시각 (Clock.nowIso()) */
  at: string;
  tool: string;
  /** 허용 목록 밖이거나 인자가 잘못된 호출은 null */
  operation: string | null;
  outcome: ToolCallOutcome;
  /** 정책 판정 (정책을 묻지 않은 호출은 null) */
  decision: PolicyDecisionValue | null;
  /** 정책 사유 또는 오류 문구 (비밀값을 가리고 잘랐다). 에이전트에는 알리지 않는다 */
  reason: string | null;
  side_effect: boolean | null;
  influenced_by_external_input: boolean;
  duration_ms: number;
  /** 가린 인자의 JSON 미리보기 */
  args_preview: string;
  /** 가린 결과의 JSON 미리보기 (성공 호출만) */
  result_preview: string | null;
  /** 실행기가 돌려준 결과의 크기(바이트). 응답을 잘랐더라도 원래 크기 */
  result_bytes: number | null;
  /** 응답을 잘라서 보냈는가 */
  result_truncated: boolean;
  /** 이 호출에 계량한 비용 */
  cost: AdapterCost;
}

export interface RunToolGateway extends ToolGateway {
  /** 지금까지의 호출 기록 (끝난 순서) */
  records(): readonly ToolCallRecord[];
  /** 호출마다 한 항목. 어댑터 출력의 run_log 와 합쳐 쓸 수 있다 */
  runLog(): RunLogEntry[];
  /** 게이트웨이가 계량한 누적 도구 비용 */
  cost(): AdapterCost;
  /** 외부 출처 결과가 에이전트에 전달됐는가(또는 run 입력이 외부 콘텐츠를 포함하는가) */
  externalInputSeen(): boolean;
  /** 호출 기록 포트가 던진 횟수 */
  recorderFailures(): number;
}

/** 응답 결과의 최대 직렬화 크기. `tool_result` 프레임(MAX_FRAME_BYTES)에 id·구조 여유를 둔 값 */
export const MAX_TOOL_RESULT_BYTES = MAX_FRAME_BYTES - 4096;
/** 호출 기록 미리보기 길이(문자) */
export const RECORD_PREVIEW_CHARS = 1024;
/** 잘린 응답의 미리보기 길이(문자). JSON 이스케이프 최악(문자당 6바이트)에도 MAX_TOOL_RESULT_BYTES 에 들어가는 값 */
const TRUNCATED_PREVIEW_CHARS = Math.floor((MAX_TOOL_RESULT_BYTES - 512) / 6);
const REASON_CHARS = 500;

/** 업무 명세의 제약을 정책 판정에 넘기는 제약으로 옮긴다 (예산은 입력의 `budget`) */
export function toolCallConstraintsOf(input: Pick<AdapterInput, 'budget' | 'task_spec'>): ToolCallConstraints {
  const out: ToolCallConstraints = { max_usd: input.budget.max_usd };
  if (input.budget.max_tokens !== undefined) out.max_tokens = input.budget.max_tokens;
  const c = input.task_spec.constraints;
  if (c.time_limit !== undefined) out.time_limit = c.time_limit;
  if (c.network_allowlist !== undefined) out.network_allowlist = [...c.network_allowlist];
  if (c.publish_scope !== undefined) out.publish_scope = c.publish_scope;
  if (c.data_classes !== undefined) out.data_classes = [...c.data_classes];
  return out;
}

// ===== 구현 =====

type ExecOutcome =
  | { kind: 'done'; value: unknown }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

interface Conclusion {
  outcome: ToolCallOutcome;
  spec?: GatewayToolSpec | undefined;
  decision?: PolicyDecisionValue | undefined;
  reason?: string | undefined;
  influenced?: boolean | undefined;
  argsPreview?: string | undefined;
  resultPreview?: string | undefined;
  resultBytes?: number | undefined;
  truncated?: boolean | undefined;
  cost?: AdapterCost | undefined;
  response: ToolGatewayResponse;
}

export function createToolGateway(options: ToolGatewayOptions): RunToolGateway {
  const { runId, subject, policy, clock, constraints } = options;
  const taskId = options.taskId ?? null;
  const timers = options.timers ?? realGatewayTimers;
  const runSignal = options.signal ?? new AbortController().signal;
  const specs = indexTools(options);
  const executorConstraints = deepFreeze(structuredClone(constraints));

  const records: ToolCallRecord[] = [];
  const spent = { usd: 0, tokens: 0 };
  let externalSeen = options.externalInput === true;
  let recorderFailures = 0;
  let seq = 0;

  const applyCost = (cost: AdapterCost): AdapterCost => {
    const applied: AdapterCost = {};
    for (const key of ['usd', 'tokens'] as const) {
      const amount = cost[key];
      if (amount === undefined || amount <= 0) continue;
      spent[key] += amount;
      applied[key] = amount;
      try {
        options.onCostProgress?.({ cumulative: spent[key], unit: key });
      } catch {
        // 보고 콜백(실행 관리)의 예외가 도구 호출을 깨뜨리지 않게 한다
      }
    }
    return applied;
  };

  const execute = (spec: GatewayToolSpec, executor: ToolExecutor, args: Readonly<JsonObject>): Promise<ExecOutcome> => {
    const abort = new AbortController();
    const signal = AbortSignal.any([runSignal, abort.signal]);
    const timeoutMs = spec.timeoutMs ?? options.toolTimeoutMs;
    return new Promise<ExecOutcome>((resolve) => {
      let settled = false;
      const onRunAbort = (): void => settle({ kind: 'cancelled' });
      const settle = (outcome: ExecOutcome): void => {
        if (settled) return; // 타임아웃·취소 뒤에 늦게 끝난 실행기의 결과는 버린다
        settled = true;
        timers.clearTimeout(timer);
        runSignal.removeEventListener('abort', onRunAbort);
        resolve(outcome);
      };
      const timer = timers.setTimeout(() => {
        abort.abort(new Error('tool_timeout'));
        settle({ kind: 'timeout' });
      }, timeoutMs);
      runSignal.addEventListener('abort', onRunAbort, { once: true });
      let running: Promise<ToolExecutionResult>;
      try {
        running = Promise.resolve(executor({ runId, tool: spec.tool, operation: spec.operation, args, signal, constraints: executorConstraints }));
      } catch (error) {
        settle({ kind: 'error', error });
        return;
      }
      running.then((value) => settle({ kind: 'done', value }), (error: unknown) => settle({ kind: 'error', error }));
    });
  };

  const conclude = async (seqNo: number, at: string, startedMs: number, tool: string, c: Conclusion): Promise<ToolGatewayResponse> => {
    const record: ToolCallRecord = deepFreeze({
      seq: seqNo,
      run_id: runId,
      at,
      tool: maskString(tool).slice(0, 200),
      operation: c.spec?.operation ?? null,
      outcome: c.outcome,
      decision: c.decision ?? null,
      reason: c.reason === undefined ? null : maskString(c.reason).slice(0, REASON_CHARS),
      side_effect: c.spec?.sideEffect ?? null,
      influenced_by_external_input: c.influenced ?? externalSeen,
      duration_ms: Math.max(0, clock.nowMs() - startedMs),
      args_preview: c.argsPreview ?? '(none)',
      result_preview: c.resultPreview ?? null,
      result_bytes: c.resultBytes ?? null,
      result_truncated: c.truncated ?? false,
      cost: c.cost ?? {},
    });
    records.push(record);
    if (options.recorder) {
      try {
        await options.recorder.record(record);
      } catch {
        recorderFailures += 1;
      }
    }
    return c.response;
  };

  const refuse = (error: GatewayErrorCode): ToolGatewayResponse => ({ ok: false, error });

  return {
    async call(tool: string, args: JsonObject): Promise<ToolGatewayResponse> {
      const at = clock.nowIso();
      const startedMs = clock.nowMs();
      const seqNo = ++seq;
      const name = typeof tool === 'string' ? tool : '(not a string)';
      const done = (c: Conclusion): Promise<ToolGatewayResponse> => conclude(seqNo, at, startedMs, name, c);

      if (!isJsonObject(args)) {
        return done({ outcome: 'invalid_args', reason: 'args must be a JSON object', argsPreview: '(not a JSON object)', response: refuse('invalid_args') });
      }
      // 판정·실행·기록이 모두 이 동결된 사본을 본다 (호출자가 await 중에 원본을 바꿔도 판정한 값과 실행한 값이 어긋나지 않는다)
      const snapshot = deepFreeze(structuredClone(args));
      const argsPreview = previewJson(snapshot, RECORD_PREVIEW_CHARS).text;

      if (runSignal.aborted) return done({ outcome: 'run_cancelled', argsPreview, response: refuse('run_cancelled') });
      const spec = typeof tool === 'string' ? specs.get(tool) : undefined;
      if (!spec) return done({ outcome: 'tool_not_allowed', argsPreview, response: refuse('tool_not_allowed') });
      const executor = options.executors.get(spec.tool)!; // 생성 때 모든 허용 도구의 실행기를 확인했다

      const influenced = externalSeen;
      const request: ToolCallPolicyRequest = {
        runId, taskId, subject, tool: spec.tool, operation: spec.operation, target: spec.target ?? null, scope: spec.scope,
        impact: impactOf(spec), sideEffect: spec.sideEffect, influencedByExternalInput: influenced, constraints, now: at,
      };
      const base = { spec, influenced, argsPreview };

      let verdict: ToolCallPolicyVerdict | null = null;
      let unavailable = '';
      try {
        const judged = await policy.judge(request);
        if (isVerdict(judged)) verdict = judged;
        else unavailable = 'policy returned an invalid verdict';
      } catch (error) {
        unavailable = `policy could not be evaluated: ${errorText(error)}`;
      }
      if (verdict === null) return done({ ...base, outcome: 'policy_unavailable', decision: 'deny', reason: unavailable, response: refuse('policy_unavailable') });
      if (verdict.decision === 'allow' && spec.sideEffect && influenced) {
        verdict = { decision: 'require_approval', reason: 'gateway: side-effect call influenced by external input needs approval' };
      }
      if (verdict.decision === 'deny') return done({ ...base, outcome: 'policy_denied', decision: 'deny', reason: verdict.reason, response: refuse('policy_denied') });
      // 기록에는 정책이 실제로 말한 판정을 남긴다: 승인을 원장에 맡긴 호출은 require_approval 이 기록되고 사유에 그 사실이 붙는다
      let recorded: PolicyDecisionValue = 'allow';
      let deferredReason: string | undefined;
      if (verdict.decision === 'require_approval') {
        // 승인 판정을 원장에 넘길 수 있는 것은 `bindToEffectLedger` 로 만든 실행기뿐이다 (effect-ledger.ts). 스펙의 표시가 아니다. 외부 입력의 영향을 받은 run 은 그래도 막는다(하한)
        const deferred = isEffectLedgerBound(executor) && !influenced;
        if (!deferred) return done({ ...base, outcome: 'approval_required', decision: 'require_approval', reason: verdict.reason, response: refuse('approval_required') });
        recorded = 'require_approval';
        deferredReason = `${verdict.reason}; approval is re-checked by the effect ledger before the side effect is sent`;
      }
      if (runSignal.aborted) return done({ ...base, outcome: 'run_cancelled', decision: recorded, response: refuse('run_cancelled') });

      const outcome = await execute(spec, executor, snapshot);
      const unitCost = spec.unitCost ?? {};
      switch (outcome.kind) {
        case 'timeout':
          return done({ ...base, outcome: 'tool_timeout', decision: recorded, reason: `no result within ${spec.timeoutMs ?? options.toolTimeoutMs} ms`, cost: applyCost(unitCost), response: refuse('tool_timeout') });
        case 'cancelled':
          return done({ ...base, outcome: 'run_cancelled', decision: recorded, cost: applyCost(unitCost), response: refuse('run_cancelled') });
        case 'error':
          return done({ ...base, outcome: 'tool_error', decision: recorded, reason: errorText(outcome.error), cost: applyCost(unitCost), response: refuse('tool_error') });
        case 'done': {
          const value = outcome.value;
          if (!isExecutionResult(value)) {
            return done({ ...base, outcome: 'tool_error', decision: recorded, reason: 'executor returned an invalid result', cost: applyCost(unitCost), response: refuse('tool_error') });
          }
          const cost = applyCost(validCost(value.cost) ?? unitCost);
          // 결과가 에이전트에 전달되는 이 시점부터 이후의 모든 호출이 외부 입력 영향 호출이다 (동기: 다음 호출이 오기 전에 표시된다)
          if (spec.resultOrigin === 'external_untrusted') externalSeen = true;
          const fitted = fitResult(value.result);
          const preview = previewJson(value.result, RECORD_PREVIEW_CHARS).text;
          return done({
            ...base, outcome: 'ok', decision: recorded, ...(deferredReason === undefined ? {} : { reason: deferredReason }), cost, resultPreview: preview, resultBytes: fitted.bytes, truncated: fitted.truncated,
            response: { ok: true, result: fitted.value },
          });
        }
      }
    },
    records: () => [...records],
    runLog: () => records.map((record) => ({ at: record.at, message: logMessage(record) })),
    cost: () => ({ ...(spent.usd > 0 ? { usd: spent.usd } : {}), ...(spent.tokens > 0 ? { tokens: spent.tokens } : {}) }),
    externalInputSeen: () => externalSeen,
    recorderFailures: () => recorderFailures,
  };
}

// ===== 보조 =====

/** 설정을 검증하고 허용 도구 색인을 만든다. 잘못된 설정은 호출 때가 아니라 만들 때 던진다 */
function indexTools(options: ToolGatewayOptions): ReadonlyMap<string, GatewayToolSpec> {
  const problems: string[] = [];
  if (!isNonBlankString(options.runId)) problems.push('runId is required');
  if (!isNonBlankString(options.subject)) problems.push('subject is required');
  if (!isPositiveFinite(options.toolTimeoutMs)) problems.push('toolTimeoutMs must be a positive finite number');
  const index = new Map<string, GatewayToolSpec>();
  for (const spec of options.tools) {
    const label = `tool '${String(spec.name ?? spec.tool)}'`;
    if (!isNonBlankString(spec.tool)) problems.push('a tool needs a non-empty name');
    else if (spec.name !== undefined && !isNonBlankString(spec.name)) problems.push(`${label}: name must not be blank`);
    else if (index.has(gatewayNameOf(spec))) problems.push(`${label} is listed twice`);
    else index.set(gatewayNameOf(spec), spec);
    if (!isNonBlankString(spec.operation)) problems.push(`${label}: operation is required`);
    if (!(SCOPES as readonly unknown[]).includes(spec.scope)) problems.push(`${label}: scope must be one of ${SCOPES.join('|')}`);
    if (typeof spec.sideEffect !== 'boolean') problems.push(`${label}: sideEffect must be a boolean`);
    else if (spec.impact !== undefined && (spec.impact === 'read') === spec.sideEffect) {
      problems.push(`${label}: impact '${spec.impact}' contradicts sideEffect ${String(spec.sideEffect)}`);
    }
    if (spec.timeoutMs !== undefined && !isPositiveFinite(spec.timeoutMs)) problems.push(`${label}: timeoutMs must be a positive finite number`);
    if (spec.unitCost !== undefined && validCost(spec.unitCost) === null) problems.push(`${label}: unitCost must be non-negative (tokens an integer)`);
    if (!options.executors.has(spec.tool)) problems.push(`${label} has no executor`);
    // 원장에 묶인 실행기는 외부 부작용 도구에만 둘 수 있다: 승인을 원장에 넘기는 예외가 읽기 도구 등에 번지지 않게 한다
    if (isEffectLedgerBound(options.executors.get(spec.tool)) && !(spec.sideEffect === true && impactOf(spec) === 'external_effect')) {
      problems.push(`${label}: an effect-ledger-bound executor needs sideEffect=true and impact external_effect`);
    }
  }
  if (problems.length > 0) throw new Error(`invalid tool gateway configuration: ${problems.join('; ')}`);
  return index;
}

/** 에이전트가 도구를 부르는 이름 (`name` 이 없으면 `tool`) */
export const gatewayNameOf = (spec: Pick<GatewayToolSpec, 'tool' | 'name'>): string => spec.name ?? spec.tool;

const isPositiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const impactOf = (spec: GatewayToolSpec): Impact => spec.impact ?? (spec.sideEffect ? 'external_effect' : 'read');

function isVerdict(value: unknown): value is ToolCallPolicyVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { decision?: unknown; reason?: unknown };
  if (v.decision === 'allow') return true;
  return (v.decision === 'deny' || v.decision === 'require_approval') && typeof v.reason === 'string';
}

function isExecutionResult(value: unknown): value is ToolExecutionResult {
  return typeof value === 'object' && value !== null && 'result' in value && isJsonValue((value as { result: unknown }).result);
}

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 비용 형식이 맞으면 그 값을, 아니면 null */
function validCost(cost: unknown): AdapterCost | null {
  if (typeof cost !== 'object' || cost === null) return null;
  const { usd, tokens } = cost as { usd?: unknown; tokens?: unknown };
  if (usd !== undefined && !isAmount(usd)) return null;
  if (tokens !== undefined && !(isAmount(tokens) && Number.isInteger(tokens))) return null;
  return { ...(usd === undefined ? {} : { usd: usd as number }), ...(tokens === undefined ? {} : { tokens: tokens as number }) };
}

/** 결과가 프레임 상한을 넘으면 자른 표시와 앞부분 미리보기로 바꾼다. 원래 크기를 함께 돌려준다 */
function fitResult(result: JsonValue): { value: JsonValue; bytes: number; truncated: boolean } {
  const text = JSON.stringify(result);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_TOOL_RESULT_BYTES) return { value: result, bytes, truncated: false };
  return { value: { truncated: true, original_bytes: bytes, preview: text.slice(0, TRUNCATED_PREVIEW_CHARS) }, bytes, truncated: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'non-error value thrown';
}

function logMessage(record: ToolCallRecord): string {
  const parts = [`tool_call #${record.seq} ${record.tool}${record.operation === null ? '' : `.${record.operation}`}: ${record.outcome}`];
  if (record.decision !== null) parts.push(`decision ${record.decision}`);
  if (record.outcome === 'ok') parts.push(`${record.result_bytes ?? 0} bytes${record.result_truncated ? ' (truncated)' : ''}`);
  if (record.influenced_by_external_input) parts.push('influenced_by_external_input');
  if (record.cost.usd !== undefined) parts.push(`cost ${record.cost.usd} usd`);
  if (record.cost.tokens !== undefined) parts.push(`cost ${record.cost.tokens} tokens`);
  return parts.join(', ');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
