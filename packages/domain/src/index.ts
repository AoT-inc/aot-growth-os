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
  CALL_MACHINE, CALL_OPEN_STATUSES, CALL_TERMINAL_STATUSES, isCallOpen,
  EXTERNAL_EFFECT_MACHINE, isTaskTerminal, ORG_PROPOSAL_MACHINE, PRODUCT_LIFECYCLE_MACHINE, PRODUCT_REGISTRATION_MACHINE, PUBLICATION_MACHINE,
  ROLE_MACHINE, STATE_MACHINES, STRATEGY_MACHINE, TASK_MACHINE, TASK_TERMINAL_STATUSES,
} from './state/machines.ts';
export {
  PHONE_TARGET_TOOLS, EXPECTED_CALL_OUTCOME_CHECK_ID, MAX_OUTCOME_DISPOSITIONS, MAX_OUTCOME_REQUIRED_FIELDS, type ExpectedCallOutcome,
  EXPECTED_QUOTES_CHECK_ID, MAX_EXPECTED_QUOTE_CHARS, MAX_EXPECTED_QUOTES, MAX_EXPECTED_QUOTES_PER_SOURCE, MAX_TASK_RESULT_BYTES, MAX_TASK_RESULT_INPUTS,
  MAX_MEMORY_INPUTS, MAX_TASK_RESULT_TOTAL_BYTES, MEMORY_INPUT_KIND, MEMORY_LATEST_SELECTOR, MEMORY_REF_PREFIX, parseMemoryRef, resolveExpectedQuotes, SYSTEM_FILLED_FIELDS, TASK_RESULT_INPUT_KIND, TASK_RESULT_REF_PREFIX, taskIdOfResultRef, validateTaskSpec,
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
  EXPERIMENT_DECISION_EVENT, EXPERIMENT_DECISION_KEY_PREFIX, EXPERIMENT_RESULT_EVENT, EXPERIMENT_RESULT_KEY_PREFIX, EXPERIMENT_REVIEW_EVENT, EXPERIMENT_REVIEW_KEY_PREFIX,
  experimentDecisionKey, experimentEventId, experimentResultKey, experimentReviewKey, findExperimentDecision, findExperimentResult, findExperimentReview,
  findExperimentReviewByTask, promoteExperiment, recordExperimentReview, rejectExperiment,
  type ExperimentDecision, type ExperimentResult, type ExperimentReview, type PromoteExperimentInput, type RecordExperimentReviewInput, type RejectExperimentInput,
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
// 외부 대화 계층(ADR-0014 §0): 채널 중립 발화 기록·구조화 결과, 그리고 첫 채널인 전화(canonical 모델·검증·통화 저장·이벤트 적용·인바운드 라우팅).
export { isJsonData, jsonBytes } from './conversation/json.ts';
export {
  MAX_TRANSCRIPT_TURNS, MAX_TURN_CHARS, normalizeTranscriptTurns, TRANSCRIPT_SPEAKERS,
  type RawTranscriptTurn, type TranscriptSpeaker, type TranscriptTurn,
} from './conversation/transcript.ts';
export {
  MAX_OUTCOME_SUMMARY_CHARS, MAX_STRUCTURED_DATA_BYTES, missingOutcomeFields, NAME_PATTERN, validateConversationOutcome, type ConversationOutcome,
} from './conversation/outcome.ts';
export {
  callOf, E164_PATTERN, isE164, maskNumber, PHONE_EVENT_TYPES, PHONE_FAILURE_CODES,
  type Call, type CallConstraints, type CallHandle, type CallOutcome, type InboundDirective, type MakeCallInput, type PhoneAnalysisInput, type PhoneCapability,
  type PhoneEvent, type PhoneEventType, type PhoneFailureCode, type PhoneTranscriptInput, type Transcript, type TransferCallInput,
} from './phone/model.ts';
export {
  PhoneProviderError, PhoneRuleError, PhoneWebhookError, PROVIDER_ERROR_CODES, providerErrorFromHttp,
  type PhoneProviderErrorCode, type PhoneRuleCode,
} from './phone/errors.ts';
export { checkBusinessHours, withinBusinessHours, type BusinessHours } from './phone/hours.ts';
export { MAX_CALL_DURATION_SECONDS, MAX_CONTEXT_BYTES, MAX_REASON_CHARS, validateMakeCallInput, validatePhoneEvent, validateTransferInput } from './phone/validate.ts';
export {
  DEFAULT_REJECT, routeInboundCall, validateInboundRoutes, type InboundRoute, type RouteDecision, type RouteTarget,
} from './phone/routing.ts';
export {
  AOT_EVENT_PROVIDER, applyPhoneEvent, callIntentKey, findSameIntentCall, countOutboundCallsSince, createOutboundCall, expireCall, findCallByProvider, getCall, getCallOutcome, getCallRow,
  getTranscript, hasOpenCall, linkCallToTask, listCallsForTask, overdueOpenCalls, PHONE_EVENT_SOURCE, phoneEventKey, recordCallOutcome,
  type ApplyResult, type CallLink, type NewOutboundCall, type RecordCallOutcomeInput,
} from './phone/calls.ts';
export type {
  PhonePort, PhoneStartCallRequest, PhoneStartCallResult, PhoneTransferRequest, PhoneWebhookRequest, PhoneWebhookResult,
} from './ports/phone-port.ts';
export {
  DENY_ALL_PHONE_CALL_POLICY,
  type PhoneCallGrant, type PhoneCallPolicy, type PhoneCallPolicyRequest, type PhoneCallPolicyVerdict,
} from './ports/phone-call-policy.ts';
