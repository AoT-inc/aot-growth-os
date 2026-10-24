// @aot/task-engine 공개 API 진입점 (단계 A2). 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 책임: 업무 생성(멱등), 스케줄러·폴링, task_run lease·heartbeat·펜싱, external_effect 원장, 재시작 복구, 검증 판정 → validating 전이(A4),
// 사람의 측정 값 입력과 측정 대기 조건(A6-U13), 승인된 실험의 활성화(루틴 켜기·일회성 업무)와 종료(A6-U15).
// 의존: @aot/domain 만. 정책 훅은 domain 의 TaskPolicyGate 포트, 검증은 domain 의 TaskValidator 포트(evaluation 이 구현), 실행은 이 패키지의 TaskExecutor 포트(A5 가 구현).
export { canonicalJson } from './canonical.ts';
export {
  createTask, createTaskInTx, eventIdempotencyKey, findDependencyCycle, fireRoutine, fireRoutineTasks, recordEvent,
  type CreateContext, type CreateTaskInput, type CreateTaskResult, type FireRoutineResult, type FireRoutineTasksResult, type IncomingEvent,
  type RecordEventResult, type RoutineFiring, type RoutineTemplateTask,
} from './create.ts';
export {
  DEFAULT_LATE_TOLERANCE_MS, RoutineFirer,
  type RoutineFailure, type RoutineFired, type RoutineRef, type RoutineScheduleOptions, type RoutineTemplateRequest, type RoutineTemplateSource,
  type RoutineTickReport,
} from './routine.ts';
export {
  DEFAULT_SLOT_LIMIT, latestSlot, missedSlots, nextSlot, parseSchedule, planFirings, ScheduleError, slotsBetween,
  type CatchUpPolicy, type CronSchedule, type FirePlanInput,
} from './schedule.ts';
export {
  beginDispatch, confirmByLookup, effectKeyOf, performEffect, planEffect, recordDispatchResult,
  type DispatchStart, type EffectCall, type EffectLookupResult, type EffectOutcome, type EffectSendResult, type EffectStep, type EffectTool,
} from './effects.ts';
export {
  activateExperiment, endExperiment, EXPERIMENT_TASK_CAUSE, ExperimentActivationError,
  type ActivateExperimentInput, type ActivateExperimentResult, type ApprovalCheck, type EndExperimentInput, type EndExperimentResult, type ExperimentRefusalCode,
} from './experiment.ts';
export { EffectRefusedError, LeaseLostError, MeasurementRefusedError, RunKilledError, StaleStateError, TaskCreationError } from './errors.ts';
export {
  DATA_QUALITIES, findMeasurement, isoWeekKeyAt, isoWeekPeriod, listMeasurementWaits, MAX_ATTACHMENT_REF_CHARS, MAX_MEASUREMENT_ATTACHMENTS,
  MEASUREMENT_EVENT_SOURCE, MEASUREMENT_EVENT_TYPE, measurementContentHash, measurementInputsOf, previousIsoWeekKey, recordMeasurement,
  type DataQuality, type MeasurementAttachment, type MeasurementContext, type MeasurementPayload, type MeasurementPeriod, type MeasurementWait,
  type RecordMeasurementInput, type RecordMeasurementResult,
} from './measurement.ts';
export {
  assertLeaseHeld, claimNextTask, failRun, findExpiredRuns, heartbeat, killRun, promoteDueRetries, recordRunOutput, saveCheckpoint, submitRun,
  takeOverExpiredRun,
  MAX_ADAPTER_NAME_CHARS, type AdapterSelector, type ClaimedTask, type ClaimOptions, type ClaimResult, type EffectLookups, type ExpiredRun, type FailRunOptions, type KillRunOptions, type Lease,
  type RunEnd, type RunEvidence, type RunOutputRecord, type TakeoverOptions, type TakeoverResult,
} from './lease.ts';
export {
  hasTaskResultInputs, resolveUpstream, UPSTREAM_UNMET_CODES,
  type UpstreamResolution, type UpstreamResult, type UpstreamUnmetCode,
} from './upstream.ts';
export { checkLeaseParams, DEFAULT_LEASE_PARAMS, DEFAULT_POLL_MS, type LeaseParams } from './params.ts';
export { runPolling, type PollingOptions } from './polling.ts';
export { transitionEffect, transitionTask, type EffectTransitionRequest, type TaskTransitionRequest } from './transitions.ts';
export {
  nextValidatingTask, routeVerdict, validateTask,
  type ValidationEnd, type ValidationOptions, type ValidationRoute, type ValidationTarget,
} from './validation.ts';
export {
  DEFAULT_RETRY_DELAY_MS, realTimers, RunTimeoutError, TaskWorker, VALIDATIONS_PER_TICK,
  type ExecutionReport, type RunContext, type TaskExecutor, type TickReport, type Timers, type WorkerOptions,
} from './worker.ts';
