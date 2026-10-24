// @aot/domain 공개 API 진입점. 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 시계 주입(Clock), SQLite 접근 계층(Db), 엔터티 타입, 상태 전이 허용표, task_spec·팩 manifest 검증, 실험 전략 제안(strategy_version, A6-U14)과 실험 활성화·종료 기록의 키·조회(A6-U15).
export { canonicalJson, contentHash, sha256Hex } from './canonical.ts';
export { FakeClock, systemClock, type Clock } from './clock.ts';
export { createDb } from './db/create-db.ts';
export { applyMigrations } from './db/migrate.ts';
export { openDb, type OpenDbOptions } from './db/node-sqlite.ts';
export { connectionPragmas, DEFAULT_BUSY_TIMEOUT_MS } from './db/pragmas.ts';
export { assertSafeSql, SQL_CLOCK_PATTERNS, stripSqlComments } from './db/sql-guard.ts';
export type { Db, DbDriver, Row, RunResult, SqlParams, SqlValue } from './db/types.ts';
export * from './entities/index.ts';
export {
  assertTransition, checkTransition, NON_AGENT_ACTORS, reachableFrom, TransitionError,
  type StateMachine, type TransitionActor, type TransitionCheck, type TransitionCheckCode, type TransitionRequest,
  type TransitionRequirement, type TransitionRule,
} from './state/machine.ts';
export {
  EXTERNAL_EFFECT_MACHINE, isTaskTerminal, ORG_PROPOSAL_MACHINE, PRODUCT_LIFECYCLE_MACHINE, PRODUCT_REGISTRATION_MACHINE, PUBLICATION_MACHINE,
  ROLE_MACHINE, STATE_MACHINES, STRATEGY_MACHINE, TASK_MACHINE, TASK_TERMINAL_STATUSES,
} from './state/machines.ts';
export {
  EXPECTED_QUOTES_CHECK_ID, MAX_EXPECTED_QUOTE_CHARS, MAX_EXPECTED_QUOTES, MAX_EXPECTED_QUOTES_PER_SOURCE, MAX_TASK_RESULT_BYTES, MAX_TASK_RESULT_INPUTS,
  MAX_TASK_RESULT_TOTAL_BYTES, resolveExpectedQuotes, SYSTEM_FILLED_FIELDS, TASK_RESULT_INPUT_KIND, TASK_RESULT_REF_PREFIX, taskIdOfResultRef, validateTaskSpec,
  type CostBudget, type ExpectedQuote, type TaskConstraints, type TaskInput, type TaskSpec, type TaskSpecDraft, type TaskSpecStage,
  type TaskSpecVersions, type TaskTrigger, type TaskValidation, type ToolRequest,
} from './spec/task-spec.ts';
export { MAX_TIME_LIMIT_MS, parseTimeLimit } from './spec/time-limit.ts';
export { checkTaskSpecReferences } from './spec/spec-references.ts';
export {
  isMeasurementSignalId, MAX_MEASUREMENT_DESCRIPTION_CHARS, MAX_MEASUREMENT_INPUTS, MAX_MEASUREMENT_SIGNAL_ID_CHARS, MEASUREMENT_INPUT_KIND, MEASUREMENT_PERIODS,
  MEASUREMENT_REF_PREFIX, measurementRef, parseMeasurementRef, validateMeasurementSignal, type MeasurementPeriod, type MeasurementSignal,
} from './spec/measurement-signal.ts';
export {
  addDays, formatIsoWeekKey, isoWeekKeyOfDate, isoWeekMonday, isoWeekOf, isoWeeksInYear, parseIsoWeekKey, type CalendarDate,
} from './spec/iso-week.ts';
export { PACK_CONTENT_KEYS, validatePackManifest, type PackContentKey, type PackManifest } from './spec/pack-manifest.ts';
export {
  isNonBlankString, isPlainObject, IssueCollector, ValidationError,
  type Issue, type PlainObject, type ValidationResult,
} from './validation.ts';
export {
  createMemoryItem, currentFacts, EVALUATION_SOURCE_PREFIX, EVIDENCE_SOURCE_PREFIX, getMemoryItem, isCurrentFact, listMemoryItems, MemoryRuleError, refuteMemoryItem,
  supersedeMemoryItem, sweepExpiredMemory,
  type MemoryContext, type MemoryFilter, type MemoryRuleCode, type NewMemoryItem,
} from './memory.ts';
export {
  comparisonEventKey, findStrategyComparison, listStrategyReviews, MAX_STRATEGY_BODY_CHARS, MAX_STRATEGY_TITLE_CHARS, proposeStrategyVersion, recordStrategyComparison,
  STRATEGY_COMPARISON_EVENT, STRATEGY_COMPARISON_KEY_PREFIX, strategyProposalId, StrategyRuleError, transitionStrategyVersion,
  type StrategyComparisonInput, type StrategyComparisonResult, type StrategyProposalInput, type StrategyProposalResult, type StrategyReview, type StrategyRuleCode,
  type StrategyTransitionRequest,
  EXPERIMENT_ACTIVATION_EVENT, EXPERIMENT_ACTIVATION_KEY_PREFIX, EXPERIMENT_END_EVENT, EXPERIMENT_END_KEY_PREFIX, experimentActivationKey, experimentEnded,
  experimentEndKey, experimentsInProgress, findExperimentActivation, latestRoutineActivation, pendingExperimentActivations, type ExperimentActivation,
} from './strategy.ts';
export {
  DENY_ALL_TASK_POLICY_GATE,
  type EffectDispatchKind, type TaskCreationGateRequest, type TaskCreationVerdict, type TaskEffectGateRequest, type TaskEffectVerdict,
  type TaskPolicyGate, type TaskRunGateRequest, type TaskRunVerdict,
} from './ports/task-policy-gate.ts';
export type {
  AgentBudgetBreach, AgentCostSource, AgentCostTotals, AgentEvidenceInput, AgentRunHost, AgentRunOutputRecord,
} from './ports/agent-run-host.ts';
export type {
  ToolCallConstraints, ToolCallPolicy, ToolCallPolicyRequest, ToolCallPolicyVerdict,
} from './ports/tool-call-policy.ts';
export type {
  TaskValidationRequest, TaskValidationVerdict, TaskValidator,
} from './ports/task-validator.ts';
export {
  currentPolicyVersionId, DEFAULT_OWNER_NAME, POLICY_V1_DOCUMENT, policyV1ContentHash, SEED_IDS, SEED_SLUGS, seedPhaseA,
  taskCreationPrerequisites, type SeedOptions, type SeedResult, type TaskCreationPrerequisites,
} from './seed.ts';
