// 열거형 값의 정본은 docs/schema/schema.sql 의 CHECK 목록이다. 여기 값이 어긋나면
// test/unit/entity-enums.test.ts 가 sqlite_master 와 비교해 실패한다.

export const ORG_VERSION_STATUSES = ['trial', 'active', 'retired', 'rolled_back'] as const;
export type OrgVersionStatus = (typeof ORG_VERSION_STATUSES)[number];

export const ORG_PROPOSAL_STATUSES = [
  'proposed', 'rejected', 'approved', 'trial', 'active', 'inconclusive', 'rolled_back', 'retired', 'expired', 'superseded',
] as const;
export type OrgProposalStatus = (typeof ORG_PROPOSAL_STATUSES)[number];

export const CHANGE_CLASSES = ['normal', 'risky'] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

export const EVAL_OUTCOMES = ['pass', 'fail', 'inconclusive'] as const;
export type EvalOutcome = (typeof EVAL_OUTCOMES)[number];

export const ABORT_REASONS = ['safety', 'budget', 'quality'] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

/** org_unit.lifecycle, role.lifecycle 공통 */
export const LIFECYCLES = ['proposed', 'trial', 'active', 'retired'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const ACTOR_KINDS = ['human', 'agent'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const PRODUCT_KINDS = ['software', 'physical', 'service', 'other'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const PRODUCT_LIFECYCLE_STAGES = ['idea', 'development', 'beta', 'live', 'maintenance', 'sunset'] as const;
export type ProductLifecycleStage = (typeof PRODUCT_LIFECYCLE_STAGES)[number];

export const PRODUCT_REGISTRATION_STATUSES = ['candidate', 'verifying', 'pending_approval', 'registered', 'rejected'] as const;
export type ProductRegistrationStatus = (typeof PRODUCT_REGISTRATION_STATUSES)[number];

export const STRATEGY_STATUSES = ['proposed', 'experiment', 'active', 'retired', 'rejected'] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export const CATCH_UP_MODES = ['skip', 'run_once'] as const;
export type CatchUpMode = (typeof CATCH_UP_MODES)[number];

export const TASK_STATUSES = [
  'unassigned', 'queued', 'running', 'validating', 'completed', 'needs_review', 'retry_wait', 'failed', 'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TRIGGER_KINDS = ['event', 'routine', 'manual', 'task'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const TASK_RUN_OUTCOMES = ['submitted', 'error', 'timeout', 'killed', 'lease_expired', 'effect_unknown'] as const;
export type TaskRunOutcome = (typeof TASK_RUN_OUTCOMES)[number];

export const EXTERNAL_EFFECT_STATES = ['planned', 'dispatched', 'confirmed', 'failed', 'unknown', 'compensated'] as const;
export type ExternalEffectState = (typeof EXTERNAL_EFFECT_STATES)[number];

/** 정책 판정의 범위(scope)와 publication.audience 공통 */
export const SCOPES = ['internal', 'customer', 'public'] as const;
export type Scope = (typeof SCOPES)[number];

export const IMPACTS = ['read', 'write', 'delete', 'external_effect'] as const;
export type Impact = (typeof IMPACTS)[number];

export const POLICY_DECISIONS = ['allow', 'deny', 'require_approval'] as const;
export type PolicyDecisionValue = (typeof POLICY_DECISIONS)[number];

export const EVIDENCE_KINDS = ['source_url', 'document', 'test_result', 'run_log', 'measurement', 'approval', 'other'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const COST_CATEGORIES = ['llm', 'tool', 'infra', 'external', 'human_time'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const APPROVAL_SUBJECT_KINDS = ['task', 'strategy_version', 'policy_version', 'publication', 'tool_call'] as const;
export type ApprovalSubjectKind = (typeof APPROVAL_SUBJECT_KINDS)[number];

export const APPROVAL_DECISIONS = ['approved', 'rejected', 'changes_requested'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const SAFETY_RESULTS = ['pass', 'fail'] as const;
export type SafetyResult = (typeof SAFETY_RESULTS)[number];

export const MEMORY_KINDS = ['fact', 'commitment', 'measurement', 'hypothesis', 'strategy_record', 'lesson'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const VERIFICATION_STATUSES = ['unverified', 'verified', 'refuted'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const MEMORY_VALIDITIES = ['valid', 'stale', 'superseded', 'refuted'] as const;
export type MemoryValidity = (typeof MEMORY_VALIDITIES)[number];

export const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const TRUST_ORIGINS = ['internal', 'external_untrusted'] as const;
export type TrustOrigin = (typeof TRUST_ORIGINS)[number];

export const PUBLICATION_STATUSES = ['draft', 'pending_approval', 'published', 'withdrawn'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
