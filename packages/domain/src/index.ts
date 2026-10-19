// @aot/domain 공개 API 진입점. 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 시계 주입(Clock), SQLite 접근 계층(Db), 엔터티 타입, 상태 전이 허용표, task_spec·팩 manifest 검증.
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
  SYSTEM_FILLED_FIELDS, validateTaskSpec,
  type CostBudget, type TaskConstraints, type TaskInput, type TaskSpec, type TaskSpecDraft, type TaskSpecStage,
  type TaskSpecVersions, type TaskTrigger, type TaskValidation, type ToolRequest,
} from './spec/task-spec.ts';
export { checkTaskSpecReferences } from './spec/spec-references.ts';
export { PACK_CONTENT_KEYS, validatePackManifest, type PackContentKey, type PackManifest } from './spec/pack-manifest.ts';
export {
  isNonBlankString, isPlainObject, IssueCollector, ValidationError,
  type Issue, type PlainObject, type ValidationResult,
} from './validation.ts';
export {
  createMemoryItem, currentFacts, getMemoryItem, isCurrentFact, listMemoryItems, MemoryRuleError, refuteMemoryItem,
  supersedeMemoryItem, sweepExpiredMemory,
  type MemoryContext, type MemoryFilter, type MemoryRuleCode, type NewMemoryItem,
} from './memory.ts';
export {
  DENY_ALL_TASK_POLICY_GATE,
  type TaskCreationGateRequest, type TaskCreationVerdict, type TaskPolicyGate, type TaskRunGateRequest, type TaskRunVerdict,
} from './ports/task-policy-gate.ts';
export {
  currentPolicyVersionId, DEFAULT_OWNER_NAME, POLICY_V1_BASELINE, policyV1ContentHash, SEED_IDS, SEED_SLUGS, seedPhaseA,
  taskCreationPrerequisites, type SeedOptions, type SeedResult, type TaskCreationPrerequisites,
} from './seed.ts';
