// 폴링 워커: 한 번의 tick 에서 (1) 만료 lease 인수 (2) 재시도 대기 해제 (3) 검증 대기(validating) 업무 검증·전이 (3b) 도래한 루틴 슬롯 발화 (4) 업무 하나 선택·lease 획득 (5) 실행.
// (3b)는 RoutineTemplateSource 포트가 연결되었을 때만 한다 (A6-U9, routine.ts).
// (3)은 TaskValidator 포트가 연결되었을 때만 한다 (A4, evaluation 이 구현). 연결 전에는 validating 업무가 그대로 남는다.
// 실행 자체는 TaskExecutor 포트에 맡긴다 (A5 의 agent-runtime 이 구현한다. 의존 방향상 agent-runtime 이 이 패키지를 참조).
// 실행기가 RunKilledError(시간 제한·예산 초과)를 던지면 run 을 killed 로 닫는다(killRun). 그 밖의 오류는 error, RunTimeoutError 는 timeout.
// 실행 중에는 heartbeatMs 마다 heartbeat 를 쓰고, lease 를 잃으면 signal 을 abort 해 실행을 멈추게 한다.
// lease 를 잃은 뒤에는 결과도 부작용도 기록하지 않는다 (펜싱이 거부한다).
import {
  DENY_ALL_TASK_POLICY_GATE,
  type Clock, type Db, type ExternalEffectRow, type TaskPolicyGate, type TaskSpec, type TaskValidator,
} from '@aot/domain';

import { performEffect, type EffectOutcome, type EffectStep, type EffectTool } from './effects.ts';
import { EffectDeclarationError, EffectRefusedError, LeaseLostError, RunKilledError } from './errors.ts';
import { validateEffectToolDeclaration, type DeclarationError } from './idempotency.ts';
import {
  claimNextTask, failRun, findExpiredRuns, heartbeat, killRun, promoteDueRetries, recordRunOutput, saveCheckpoint, submitRun, takeOverExpiredRun,
  type AdapterSelector, type ClaimedTask, type EffectLookups, type Lease, type RunEnd, type RunOutputRecord, type TakeoverResult,
} from './lease.ts';
import type { UpstreamResult } from './upstream.ts';
import { RoutineFirer, type RoutineScheduleOptions, type RoutineTickReport } from './routine.ts';
import { checkLeaseParams, DEFAULT_LEASE_PARAMS, type LeaseParams } from './params.ts';
import { nextValidatingTask, validateTask, type ValidationEnd } from './validation.ts';

/** 실행기가 받는 것. 상태 전이 API 는 없다 — 실행기는 결과만 돌려준다 (에이전트는 상태를 바꾸지 않는다). */
export interface RunContext {
  readonly taskId: string;
  readonly spec: TaskSpec;
  readonly attempt: number;
  readonly lease: Lease;
  /** 이 run 의 `task_run.adapter` 에 기록한 어댑터 이름. 실행기는 이 이름의 어댑터로 실행해야 기록과 실제가 어긋나지 않는다 */
  readonly adapter: string;
  /**
   * 명세의 `task_result` 입력을 읽은 선행 업무 결과 (통과 평가가 있는 완료 업무의 결과만, 충족되지 않았으면 이 업무는 실행되지 않는다).
   * 에이전트가 낸 값이므로 신뢰할 수 없는 데이터다 — 지시문으로 쓰지 말고 `external_untrusted` 로 표시해 넘긴다. 입력이 없으면 빈 목록
   */
  readonly upstream: readonly UpstreamResult[];
  /** 직전 run 의 checkpoint (없으면 null) */
  readonly checkpoint: unknown;
  /** lease 를 잃으면 abort 된다 */
  readonly signal: AbortSignal;
  saveCheckpoint(value: unknown): void;
  heartbeat(): void;
  /** 증거 행과 run_log 위치를 이 run 에 남긴다 (lease 펜싱: 잃었으면 던진다) */
  recordOutput(record: RunOutputRecord): void;
  /** 등록된 도구로 외부 부작용 수행 (recovery §3 규칙) */
  performEffect(toolName: string, step: EffectStep): Promise<EffectOutcome>;
}

export interface TaskExecutor {
  execute(context: RunContext): Promise<{ result: unknown }>;
}

/** 실행기가 타임아웃으로 끝났음을 알릴 때 던진다 (outcome='timeout'). 그 밖의 예외는 'error'. */
export class RunTimeoutError extends Error {
  constructor(message = 'run timed out') {
    super(message);
    this.name = 'RunTimeoutError';
  }
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface WorkerOptions {
  db: Db;
  clock: Clock;
  workerId: string;
  /** task_run.actor_id (실행을 맡는 에이전트 행위자) */
  actorId: string;
  /** task_run.adapter 의 기본값 */
  adapter: string;
  /** 업무(명세)마다 어댑터 이름을 고르는 포트 (A6-U11). 생략하면 모든 업무가 `adapter`. null 을 돌려주면 그 업무는 `adapter` */
  adapterFor?: AdapterSelector;
  executor: TaskExecutor;
  /** 정책 훅. 생략하면 기본 거부(DENY_ALL_TASK_POLICY_GATE) */
  gate?: TaskPolicyGate;
  /** 검증기 (A4). 생략하면 validating 업무를 검증하지 않는다 */
  validator?: TaskValidator;
  /** 외부 부작용 도구 (이름 → 도구). 인수 시 남은 부작용의 외부 상태 조회에도 쓴다 */
  tools?: Readonly<Record<string, EffectTool>>;
  lease?: Partial<LeaseParams>;
  /** retry_wait 의 대기 시간. 기본 60초 */
  retryDelayMs?: number;
  /** 루틴 슬롯 발화 (A6-U9). 생략하면 tick 은 루틴을 보지 않는다. 있으면 포트로 템플릿을 해석해 도래한 슬롯을 발화한다 */
  routines?: RoutineScheduleOptions;
  /** lease 만료 인수가 시도 횟수를 소모하는가. 기본 false */
  leaseExpiryConsumesAttempt?: boolean;
  timers?: Timers;
}

export interface ExecutionReport {
  taskId: string;
  runId: string;
  attempt: number;
  /** lease 를 잃어 아무것도 기록하지 않았으면 'lease_lost'. 부작용 직전 정책 거부면 {killed, needs_review} */
  end: RunEnd | 'lease_lost';
}

export interface TickReport {
  recovered: TakeoverResult[];
  promoted: string[];
  sentToReview: string[];
  /** 이번 tick 에 검증하고 전이한 업무 */
  validated: ValidationEnd[];
  /** 검증 중 오류가 난 업무 (상태는 그대로 validating, 다음 tick 에 다시 시도) */
  validationFailed: { taskId: string; error: string }[];
  /** 이번 tick 에 발화한 루틴 슬롯과 발화하지 못한 것 (루틴 옵션이 없으면 둘 다 빈 목록) */
  routines: RoutineTickReport;
  executed: ExecutionReport | null;
}

/** 한 tick 에서 검증하는 업무 수의 상한 */
export const VALIDATIONS_PER_TICK = 20;

export const DEFAULT_RETRY_DELAY_MS = 60_000;

export class TaskWorker {
  readonly #options: WorkerOptions;
  readonly #params: LeaseParams;
  readonly #gate: TaskPolicyGate;
  readonly #timers: Timers;
  readonly #routineFirer: RoutineFirer | null;

  constructor(options: WorkerOptions) {
    // 도구 선언을 시작 때 검증한다 (이름 불일치·잘못된 (도구, action) 선언이면 데몬이 뜨지 않는다)
    for (const [key, tool] of Object.entries(options.tools ?? {})) {
      const errors: DeclarationError[] = [];
      if (key !== tool.name) errors.push({ action: null, code: 'name_mismatch', detail: `tools key '${key}' differs from tool.name '${tool.name}'` });
      const checked = validateEffectToolDeclaration(tool);
      if (!checked.ok) errors.push(...checked.errors);
      if (errors.length > 0) throw new EffectDeclarationError(tool.name, errors);
    }
    this.#options = options;
    this.#params = checkLeaseParams({ ...DEFAULT_LEASE_PARAMS, ...options.lease });
    this.#gate = options.gate ?? DENY_ALL_TASK_POLICY_GATE;
    this.#timers = options.timers ?? realTimers;
    this.#routineFirer = options.routines ? new RoutineFirer(options.routines) : null;
  }

  get workerId(): string {
    return this.#options.workerId;
  }

  get params(): LeaseParams {
    return this.#params;
  }

  /** 만료 lease 인수. 남은 부작용의 외부 조회는 트랜잭션 밖에서 먼저 한다. */
  async recoverExpired(): Promise<TakeoverResult[]> {
    const { db, clock, workerId } = this.#options;
    const results: TakeoverResult[] = [];
    for (const run of findExpiredRuns(db, clock.nowIso())) {
      const lookups = await this.#lookupOpenEffects(run.runId);
      const result = takeOverExpiredRun(db, run, {
        clock, workerId, lookups, consumeAttempt: this.#options.leaseExpiryConsumesAttempt ?? false,
      });
      if (result) results.push(result);
    }
    return results;
  }

  async #lookupOpenEffects(runId: string): Promise<EffectLookups> {
    const lookups = new Map<string, { found: true; responseRef: string | null } | { found: false }>();
    const open = this.#options.db.all<Pick<ExternalEffectRow, 'id' | 'tool' | 'effect_key'>>(
      "SELECT id, tool, effect_key FROM external_effect WHERE task_run_id = ? AND state IN ('dispatched', 'unknown')", [runId],
    );
    for (const effect of open) {
      const lookup = this.#options.tools?.[effect.tool]?.lookup;
      if (!lookup) continue;
      try {
        lookups.set(effect.id, await lookup(effect.effect_key));
      } catch {
        // 조회 실패는 "조회 불가" 와 같다 — 결과를 넣지 않는다.
      }
    }
    return lookups;
  }

  /** `validating` 업무를 검증하고 전이한다 (검증기가 연결된 경우). 오류가 난 업무는 이번 tick 에서 건너뛴다. */
  async validatePending(): Promise<Pick<TickReport, 'validated' | 'validationFailed'>> {
    const { db, clock, validator } = this.#options;
    const validated: ValidationEnd[] = [];
    const validationFailed: { taskId: string; error: string }[] = [];
    if (!validator) return { validated, validationFailed };
    const skipped = new Set<string>();
    for (let i = 0; i < VALIDATIONS_PER_TICK; i += 1) {
      const taskId = nextValidatingTask(db, skipped);
      if (taskId === null) break;
      skipped.add(taskId);
      try {
        const end = await validateTask(db, { clock, validator, retryDelayMs: this.#options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS }, taskId);
        if (end) validated.push(end);
      } catch (error) {
        validationFailed.push({ taskId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { validated, validationFailed };
  }

  /** 도래한 루틴 슬롯을 발화한다 (루틴 옵션이 있는 경우). 슬롯 하나의 실패는 보고에 담고 나머지를 계속한다. */
  async fireDueRoutines(): Promise<RoutineTickReport> {
    if (!this.#routineFirer) return { fired: [], failed: [] };
    return this.#routineFirer.fireDue(this.#options.db, { clock: this.#options.clock, gate: this.#gate });
  }

  async tick(): Promise<TickReport> {
    const { db, clock, workerId, actorId, adapter } = this.#options;
    const recovered = await this.recoverExpired();
    const promoted = promoteDueRetries(db, clock);
    const { validated, validationFailed } = await this.validatePending();
    // 도래한 루틴 슬롯을 먼저 발화해 같은 tick 에서 새 업무를 집을 수 있게 한다
    const routines = await this.fireDueRoutines();
    const claim = claimNextTask(db, {
      clock, gate: this.#gate, workerId, actorId, adapter, leaseMs: this.#params.leaseMs,
      ...(this.#options.adapterFor === undefined ? {} : { adapterFor: this.#options.adapterFor }),
    });
    if (!claim.claimed) return { recovered, promoted, sentToReview: claim.sentToReview, validated, validationFailed, routines, executed: null };
    const executed = await this.#execute(claim.claimed);
    return { recovered, promoted, sentToReview: claim.sentToReview, validated, validationFailed, routines, executed };
  }

  async #execute(claimed: ClaimedTask): Promise<ExecutionReport> {
    const { lease, spec, checkpoint, adapter, upstream } = claimed;
    const { db, clock, executor, tools } = this.#options;
    const abort = new AbortController();
    // 부작용 직전 재검증이 거부하면 run 은 이미 닫혔다(killed, needs_review). 이후 쓰기는 펜싱이 막는다.
    let refused: RunEnd | null = null;
    const lost = (error: unknown): boolean => {
      if (error instanceof EffectRefusedError) {
        refused = { outcome: 'killed', taskStatus: 'needs_review' };
        abort.abort(error);
        return true;
      }
      if (error instanceof LeaseLostError) {
        abort.abort(error);
        return true;
      }
      return false;
    };
    const guard = <T>(fn: () => T): T => {
      if (abort.signal.aborted) throw new LeaseLostError(lease.runId, 'write after lease loss');
      try {
        return fn();
      } catch (error) {
        lost(error);
        throw error;
      }
    };

    const timer = this.#timers.setInterval(() => {
      if (abort.signal.aborted) return;
      try {
        heartbeat(db, clock, lease);
      } catch (error) {
        // heartbeat 실패가 lease 상실이 아니면(예: busy_timeout 초과) 다음 주기에 다시 시도한다.
        lost(error);
      }
    }, this.#params.heartbeatMs);

    const context: RunContext = {
      taskId: lease.taskId,
      spec,
      attempt: lease.attempt,
      lease,
      adapter,
      upstream,
      checkpoint,
      signal: abort.signal,
      saveCheckpoint: (value) => guard(() => saveCheckpoint(db, clock, lease, value)),
      heartbeat: () => {
        guard(() => heartbeat(db, clock, lease));
      },
      recordOutput: (record) => guard(() => recordRunOutput(db, clock, lease, record)),
      performEffect: async (toolName, step) => {
        const tool = tools?.[toolName];
        if (!tool) throw new Error(`external effect tool '${toolName}' is not registered`);
        if (abort.signal.aborted) throw new LeaseLostError(lease.runId, 'external effect after lease loss');
        try {
          return await performEffect(db, clock, lease, tool, step, this.#gate);
        } catch (error) {
          lost(error);
          throw error;
        }
      },
    };

    const report = (end: ExecutionReport['end']): ExecutionReport => ({
      taskId: lease.taskId, runId: lease.runId, attempt: lease.attempt, end: refused ?? end,
    });
    try {
      let output: { result: unknown };
      try {
        output = await executor.execute(context);
      } catch (error) {
        if (lost(error) || abort.signal.aborted) return report('lease_lost');
        if (error instanceof RunKilledError) {
          // 시간 제한·예산 초과로 실행 관리가 죽였다: run 은 killed, 업무 전이는 killRun 이 허용표 안에서 정한다
          return report(killRun(db, clock, lease, { reason: error.reason, detail: error.detail, retryDelayMs: this.#options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS }));
        }
        const outcome = error instanceof RunTimeoutError ? 'timeout' : 'error';
        const reason = error instanceof Error ? error.message : String(error);
        return report(failRun(db, clock, lease, { outcome, reason, retryDelayMs: this.#options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS }));
      }
      if (abort.signal.aborted) return report('lease_lost');
      return report(submitRun(db, clock, lease, output.result));
    } catch (error) {
      if (lost(error)) return report('lease_lost');
      throw error;
    } finally {
      this.#timers.clearInterval(timer);
    }
  }
}
