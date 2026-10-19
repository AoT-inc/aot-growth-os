// @aot/task-engine 공개 API 진입점 (단계 A2). 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 책임: 업무 생성(멱등), 스케줄러·폴링, task_run lease·heartbeat·펜싱, external_effect 원장, 재시작 복구.
// 의존: @aot/domain 만. 정책 훅은 domain 의 TaskPolicyGate 포트, 실행은 이 패키지의 TaskExecutor 포트(A5 가 구현).
export { canonicalJson } from './canonical.ts';
export {
  createTask, createTaskInTx, eventIdempotencyKey, findDependencyCycle, fireRoutine, recordEvent,
  type CreateContext, type CreateTaskInput, type CreateTaskResult, type FireRoutineResult, type IncomingEvent,
  type RecordEventResult, type RoutineFiring,
} from './create.ts';
export {
  beginDispatch, confirmByLookup, effectKeyOf, performEffect, planEffect, recordDispatchResult,
  type DispatchStart, type EffectCall, type EffectLookupResult, type EffectOutcome, type EffectSendResult, type EffectStep, type EffectTool,
} from './effects.ts';
export { EffectRefusedError, LeaseLostError, StaleStateError, TaskCreationError } from './errors.ts';
export {
  assertLeaseHeld, claimNextTask, failRun, findExpiredRuns, heartbeat, promoteDueRetries, saveCheckpoint, submitRun,
  takeOverExpiredRun,
  type ClaimedTask, type ClaimOptions, type ClaimResult, type EffectLookups, type ExpiredRun, type FailRunOptions, type Lease,
  type RunEnd, type TakeoverOptions, type TakeoverResult,
} from './lease.ts';
export { checkLeaseParams, DEFAULT_LEASE_PARAMS, DEFAULT_POLL_MS, type LeaseParams } from './params.ts';
export { runPolling, type PollingOptions } from './polling.ts';
export { transitionEffect, transitionTask, type EffectTransitionRequest, type TaskTransitionRequest } from './transitions.ts';
export {
  DEFAULT_RETRY_DELAY_MS, realTimers, RunTimeoutError, TaskWorker,
  type ExecutionReport, type RunContext, type TaskExecutor, type TickReport, type Timers, type WorkerOptions,
} from './worker.ts';
