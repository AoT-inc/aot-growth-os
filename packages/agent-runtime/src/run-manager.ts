// 실행 관리 (단계 A5 U4). 어댑터(가짜 또는 컨테이너 러너) 실행 하나를 업무 엔진의 run 수명주기에 연결한다.
//  - 시간 제한: `constraints.time_limit`(domain 의 parseTimeLimit)을 주입 타이머로 감시한다. 지나면 AbortController 를 abort 해 어댑터(컨테이너 러너는 `docker kill`)를
//    멈추고 `killed`(사유 time_limit)로 끝낸다. 명세에 없으면 `defaultTimeLimitMs`(기본 30분)를 쓴다 — 제한 없는 에이전트는 두지 않는다. 해석할 수 없는 값은 시작하지 않고 실패.
//  - 비용: 어댑터의 `cost_progress`(모델 비용)와 게이트웨이가 계량한 도구 비용을 각각 단조 증가하는 *누적* 값으로 거른다(같은 값 반복·줄어든 값은 거부하고 세어 둔다).
//    걸러진 누적을 `AgentRunHost.reportCost` 로 넘기면 호스트가 차액만 원장(`cost_entry`)에 더하고 업무 전체의 예산 초과를 판정한다. 초과면 즉시 abort → `killed`(budget_exceeded).
//    초과 시점까지의 비용은 원장에 남는다(기록은 abort 보다 먼저다).
//  - 종료: 어댑터가 돌려준 `cost` 는 최종 누적이다. 진행 보고분과의 차이만 기록하므로 이중 계상이 없다. 취소·오류 출력의 비용도 기록한다.
//  - 취소 뒤에 도착한 결과는 버린다(성공으로 받지 않는다). 어댑터가 취소를 무시하면 `terminationGraceMs` 뒤에 포기하고 killed 로 끝내되 종료를 확인하지 못했다고 표시한다
//    (컨테이너 러너는 docker kill 을 확인한 뒤에야 돌려주므로 확인된다). 포기한 어댑터의 뒤늦은 보고는 무시한다.
//  - 정책 재판정 거부(`policy_denied` 등)는 게이트웨이가 에이전트에 오류로 답할 뿐 run 을 죽이지 않는다. 이 파일은 정책을 모른다.
// 업무 상태 전이는 하지 않는다. 결과(`AgentTaskEnd`)만 돌려주고 run 종료·상태 전이는 업무 엔진이 한다(에이전트는 상태를 바꾸지 않는다).
// DB 는 모른다: 비용 원장과 증거 기록은 domain 의 `AgentRunHost` 포트로 한다.
import { parseTimeLimit } from '@aot/domain';
import type { AgentCostSource, AgentCostTotals, AgentEvidenceInput, AgentRunHost, Clock } from '@aot/domain';

import type {
  AdapterContext, AdapterCost, AdapterInput, AdapterOutput, AgentAdapter, CostProgressEvent, CostUnit, JsonObject, RunLogEntry, ToolGateway,
} from './contract.ts';
import { realGatewayTimers, type GatewayTimers } from './gateway.ts';
import { maskString } from './mask.ts';
import type { RunLogStore } from './run-log-store.ts';
import { validateAdapterOutput } from './validate.ts';

/** 명세에 `time_limit` 이 없을 때의 시간 제한 */
export const DEFAULT_TIME_LIMIT_MS = 30 * 60_000;
/** 취소 뒤 어댑터가 멈추기를 기다리는 시간 */
export const DEFAULT_TERMINATION_GRACE_MS = 10_000;
/** 거부한 비용 보고를 run_log 에 적는 최대 횟수 (그 뒤는 세기만 한다) */
const MAX_LOGGED_REJECTIONS = 20;

/** 게이트웨이 팩토리가 받는 것: run 취소 신호와, 게이트웨이가 계량한 도구 비용의 누적 보고 콜백 */
export interface GatewayHooks {
  readonly signal: AbortSignal;
  readonly onCostProgress: (event: CostProgressEvent) => void;
}

/** 실행 관리가 쓰는 게이트웨이의 모양 (`createToolGateway` 의 `RunToolGateway` 가 만족한다) */
export interface ManagedGateway extends ToolGateway {
  runLog(): RunLogEntry[];
  cost(): AdapterCost;
}

export interface RunAgentTaskOptions {
  adapter: AgentAdapter;
  /** 시간 제한은 `task_spec.constraints.time_limit` 에서 읽는다. `time_limit_ms` 는 이 함수가 채운다 */
  input: Omit<AdapterInput, 'time_limit_ms'>;
  createGateway(hooks: GatewayHooks): ManagedGateway;
  host: AgentRunHost;
  clock: Clock;
  timers?: GatewayTimers;
  /** 바깥에서 오는 취소(lease 상실). abort 되면 어댑터를 멈추고 `cancelled` 로 끝낸다 */
  signal?: AbortSignal;
  runLogStore?: RunLogStore;
  defaultTimeLimitMs?: number;
  terminationGraceMs?: number;
}

export type KillReason = 'time_limit' | 'budget_exceeded';

export type AgentTaskEnd =
  /** 어댑터가 결과를 냈다 (업무 엔진이 submitted → validating) */
  | { kind: 'submitted'; result: JsonObject }
  /** 실행 관리가 죽였다. 늦게 도착한 결과는 버렸다 */
  | { kind: 'killed'; reason: KillReason; detail: string }
  /** 바깥 취소(lease 상실). 아무것도 기록하지 않는다 */
  | { kind: 'cancelled'; detail: string }
  /** 어댑터 오류·잘못된 출력·기록 실패 (재시도 대상) */
  | { kind: 'failed'; code: string; message: string };

export interface AgentTaskReport {
  end: AgentTaskEnd;
  /** 원장에 반영한 출처별 최종 누적 비용 */
  cost: { adapter: AgentCostTotals; gateway: AgentCostTotals };
  /** 중복·역행·형식 오류로 거부한 진행 보고 수 */
  rejectedCostReports: number;
  /** 취소한 어댑터가 `terminationGraceMs` 안에 멈췄는가 (취소가 없었으면 true) */
  terminationConfirmed: boolean;
  runLogRef: string | null;
  runLog: readonly RunLogEntry[];
}

type Cause =
  | { kind: 'time_limit'; detail: string }
  | { kind: 'budget_exceeded'; detail: string }
  | { kind: 'lease_lost'; detail: string }
  | { kind: 'host_error'; detail: string };

const errorText = (error: unknown): string => maskString(error instanceof Error ? `${error.name}: ${error.message}` : 'non-error value thrown').slice(0, 300);

export async function runAgentTask(options: RunAgentTaskOptions): Promise<AgentTaskReport> {
  const { adapter, host, clock, input } = options;
  const timers = options.timers ?? realGatewayTimers;
  const graceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const notes: RunLogEntry[] = [];
  const note = (message: string): void => void notes.push({ at: clock.nowIso(), message });

  const streams: Record<AgentCostSource, AgentCostTotals> = { adapter: {}, gateway: {} };
  const snapshot = (): AgentRunReportCost => ({ adapter: { ...streams.adapter }, gateway: { ...streams.gateway } });
  let rejected = 0;
  let logged = 0;
  let runLogRef: string | null = null;

  const finish = (end: AgentTaskEnd, extra: { confirmed?: boolean; runLog?: readonly RunLogEntry[] } = {}): AgentTaskReport => ({
    end, cost: snapshot(), rejectedCostReports: rejected, terminationConfirmed: extra.confirmed ?? true, runLogRef, runLog: extra.runLog ?? notes,
  });

  // ----- 시작 전 검사: 여기서 거부하면 어댑터를 띄우지 않는다 -----
  const limitText = input.task_spec.constraints.time_limit;
  const limitMs = limitText === undefined ? (options.defaultTimeLimitMs ?? DEFAULT_TIME_LIMIT_MS) : parseTimeLimit(limitText);
  if (limitMs === null || !(Number.isFinite(limitMs) && limitMs > 0)) {
    note(`not started: time_limit '${String(limitText)}' cannot be interpreted`);
    return finish({ kind: 'failed', code: 'invalid_time_limit', message: `constraints.time_limit '${String(limitText)}' is not a valid time limit; the agent was not started` });
  }
  if (options.signal?.aborted === true) {
    note('not started: the run was already cancelled');
    return finish({ kind: 'cancelled', detail: 'cancelled before the agent was started' });
  }

  const controller = new AbortController();
  let cause: Cause | null = null;
  let ended = false;
  let graceHandle: unknown = null;
  let graceExpired!: () => void;
  const graceP = new Promise<'grace'>((resolve) => { graceExpired = () => resolve('grace'); });

  const stop = (why: Cause): void => {
    if (cause !== null) return; // 첫 사유가 이긴다
    cause = why;
    note(`stopping the agent (${why.kind}): ${why.detail}`);
    controller.abort(new Error(`${why.kind}: ${why.detail}`));
    if (!ended) graceHandle = timers.setTimeout(graceExpired, graceMs); // 결과를 확정한 뒤(종료 시 비용 정산 중)의 사유는 기다릴 어댑터가 없다
  };
  const currentCause = (): Cause | null => cause;

  // ----- 비용 -----
  const rejectReport = (source: AgentCostSource, unit: CostUnit, cumulative: unknown, why: string): void => {
    rejected += 1;
    if (logged < MAX_LOGGED_REJECTIONS) {
      logged += 1;
      note(`cost_progress rejected (${source} ${unit} ${String(cumulative)}): ${why}`);
    }
  };

  const forward = (source: AgentCostSource): void => {
    let breach;
    try {
      breach = host.reportCost(source, { ...streams[source] });
    } catch (error) {
      stop({ kind: 'host_error', detail: `the cost could not be recorded (${errorText(error)})` });
      return;
    }
    if (breach !== null) stop({ kind: 'budget_exceeded', detail: breach.detail });
  };

  /** 진행 보고: 단조 증가하는 누적만 받는다 */
  const progress = (source: AgentCostSource, unit: CostUnit, cumulative: unknown): void => {
    if (ended) return; // 결과를 확정한 뒤(또는 포기한 어댑터)의 보고는 버린다
    if (typeof cumulative !== 'number' || !Number.isFinite(cumulative) || cumulative < 0 || (unit === 'tokens' && !Number.isInteger(cumulative))) {
      return rejectReport(source, unit, cumulative, 'not a finite, non-negative number (tokens: an integer)');
    }
    const previous = streams[source][unit];
    if (previous !== undefined && cumulative <= previous) {
      return rejectReport(source, unit, cumulative, cumulative === previous ? 'duplicate of the last cumulative value' : `cumulative value went down from ${previous}`);
    }
    streams[source][unit] = cumulative;
    forward(source);
  };

  /** 종료 시 최종 누적: 이미 보고한 값보다 클 때만 차이를 반영한다(같으면 이중 계상 없음, 작으면 큰 값을 유지) */
  const settle = (source: AgentCostSource, final: AdapterCost): void => {
    let raised = false;
    for (const unit of ['usd', 'tokens'] as const) {
      const value = final[unit];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (unit === 'tokens' && !Number.isInteger(value))) {
        note(`final ${source} ${unit} cost ignored: not a valid amount`);
        continue;
      }
      const previous = streams[source][unit];
      if (value > (previous ?? 0)) {
        streams[source][unit] = value;
        raised = true;
      } else if (previous !== undefined && value < previous) {
        note(`final ${source} ${unit} cost ${value} is below the reported ${previous}; keeping the reported value`);
      }
    }
    if (raised) forward(source);
  };

  // ----- 실행 -----
  const gateway = options.createGateway({ signal: controller.signal, onCostProgress: (event) => progress('gateway', event.unit, event.cumulative) });
  const context: AdapterContext = {
    gateway,
    signal: controller.signal,
    onCostProgress: (event) => progress('adapter', event?.unit, event?.cumulative),
  };

  const onOutsideAbort = (): void => stop({ kind: 'lease_lost', detail: 'the run was cancelled from outside (lease lost)' });
  options.signal?.addEventListener('abort', onOutsideAbort, { once: true });
  const limitHandle = timers.setTimeout(() => stop({ kind: 'time_limit', detail: `time limit ${limitText ?? `${limitMs} ms`} exceeded` }), limitMs);
  note(`agent ${adapter.name} started (time limit ${limitMs} ms)`);

  type Settled = { ok: true; output: unknown } | { ok: false; error: unknown };
  const running: Promise<Settled> = (async () => adapter.run({ ...input, time_limit_ms: limitMs }, context))()
    .then((output): Settled => ({ ok: true, output }), (error: unknown): Settled => ({ ok: false, error }));

  const first = await Promise.race([running, graceP]);
  ended = true; // 이후의 진행 보고는 버린다(최종 비용은 아래 settle 이 반영한다)
  timers.clearTimeout(limitHandle);
  if (graceHandle !== null) timers.clearTimeout(graceHandle);
  options.signal?.removeEventListener('abort', onOutsideAbort);

  const gaveUp = first === 'grace';
  if (gaveUp) note(`the agent did not stop within ${graceMs} ms of the cancel signal; giving up on it (any later result is discarded)`);

  // 어댑터가 돌려준 출력의 형태를 믿지 않고 확인한다
  let output: AdapterOutput | null = null;
  let invalid: string | null = null;
  let thrown: string | null = null;
  if (first !== 'grace') {
    if (first.ok) {
      const checked = validateAdapterOutput(first.output);
      if (checked.ok) output = checked.value;
      else invalid = checked.errors.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    } else {
      thrown = errorText(first.error);
      note(`the adapter threw: ${thrown}`);
    }
  }

  // 최종 비용: 취소·오류에서도 쓴 돈은 남긴다
  if (output !== null) settle('adapter', output.cost);
  settle('gateway', safeGatewayCost(gateway));

  // ----- 끝을 정한다 -----
  const why = currentCause();
  let end: AgentTaskEnd;
  let keep = false; // 어댑터가 낸 증거를 기록할 가치가 있는가
  if (why !== null) {
    if (why.kind === 'time_limit' || why.kind === 'budget_exceeded') end = { kind: 'killed', reason: why.kind, detail: why.detail };
    else if (why.kind === 'lease_lost') end = { kind: 'cancelled', detail: why.detail };
    else end = { kind: 'failed', code: 'cost_recording_failed', message: why.detail };
    if (output !== null && output.status === 'submitted') note('a result arrived after the cancel signal; it was discarded');
    else keep = output !== null;
  } else if (thrown !== null) {
    end = { kind: 'failed', code: 'adapter_exception', message: thrown };
  } else if (invalid !== null) {
    end = { kind: 'failed', code: 'invalid_adapter_output', message: invalid };
  } else if (output === null) {
    end = { kind: 'failed', code: 'adapter_exception', message: 'the adapter produced no output' };
  } else if (output.status === 'submitted') {
    end = { kind: 'submitted', result: output.result as JsonObject };
    keep = true;
  } else if (output.status === 'error') {
    end = { kind: 'failed', code: output.error?.code ?? 'adapter_error', message: maskString(output.error?.message ?? '').slice(0, 300) };
    keep = true;
  } else {
    end = { kind: 'failed', code: 'adapter_cancelled', message: 'the adapter stopped without a cancel request' };
    keep = true;
  }

  // ----- 기록: run_log 저장과 증거 -----
  const runLog = mergeLogs(notes, output?.run_log ?? [], safeGatewayLog(gateway));
  if (options.runLogStore !== undefined) {
    try {
      runLogRef = await options.runLogStore.save(input.run_id, runLog);
    } catch (error) {
      note(`the run log could not be saved: ${errorText(error)}`);
    }
  }
  if (end.kind !== 'cancelled') {
    const evidence: AgentEvidenceInput[] = keep && output !== null
      ? output.evidence.map((item) => ({ kind: item.kind, ref: item.ref, trustOrigin: item.trust_origin, capturedAt: item.captured_at, ...(item.content_hash === undefined ? {} : { contentHash: item.content_hash }) }))
      : [];
    try {
      host.recordOutput({ evidence, runLogRef });
    } catch (error) {
      // 결과를 제출하려면 증거가 남아야 한다. 죽이는 경우에는 기록 실패가 종료 사유를 바꾸지 않는다
      note(`the output could not be recorded: ${errorText(error)}`);
      if (end.kind === 'submitted') end = { kind: 'failed', code: 'output_not_recorded', message: errorText(error) };
    }
  }
  return finish(end, { confirmed: !gaveUp, runLog });
}

type AgentRunReportCost = AgentTaskReport['cost'];

function safeGatewayCost(gateway: ManagedGateway): AdapterCost {
  try {
    return gateway.cost();
  } catch {
    return {};
  }
}

function safeGatewayLog(gateway: ManagedGateway): RunLogEntry[] {
  try {
    return gateway.runLog();
  } catch {
    return [];
  }
}

/** 시각순(같으면 들어온 순서)으로 합친다 */
function mergeLogs(...lists: readonly (readonly RunLogEntry[])[]): RunLogEntry[] {
  return lists.flatMap((list) => list.map((entry) => ({ at: entry.at, message: entry.message })))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : a.index - b.index))
    .map(({ entry }) => entry);
}
