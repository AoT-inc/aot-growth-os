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

/** `product`: 상품 등록 승인(registered 전이), `org_proposal`: 조직 제안 승인(proposed → approved) */
export const APPROVAL_SUBJECT_KINDS = ['task', 'strategy_version', 'policy_version', 'publication', 'tool_call', 'product', 'org_proposal'] as const;
export type ApprovalSubjectKind = (typeof APPROVAL_SUBJECT_KINDS)[number];

export const APPROVAL_DECISIONS = ['approved', 'rejected', 'changes_requested'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** human_reauth.method (trust-boundaries §3.1: 위험 변경 재인증은 TOTP) */
export const REAUTH_METHODS = ['totp'] as const;
export type ReauthMethod = (typeof REAUTH_METHODS)[number];

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

/** 전화 통화 방향 (ADR-0014). 사용자 표기는 소문자 그대로다 */
export const CALL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/** AoT canonical 통화 상태. provider 의 상태 이름은 어댑터 밖으로 나오지 않는다 */
export const CALL_STATUSES = ['queued', 'initiated', 'ringing', 'connected', 'completed', 'failed', 'cancelled', 'transferred'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_ARTIFACT_KINDS = ['transcript', 'outcome'] as const;
export type CallArtifactKind = (typeof CALL_ARTIFACT_KINDS)[number];

/** 산출물이 어디서 왔는가. provider_* 와 extractor 는 상대방의 말에서 나온 요약이라 신뢰할 수 없는 데이터다 */
export const CALL_ARTIFACT_SOURCES = ['provider_transcript', 'provider_analysis', 'extractor', 'human'] as const;
export type CallArtifactSource = (typeof CALL_ARTIFACT_SOURCES)[number];
