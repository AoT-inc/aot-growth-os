// docs/schema/schema.sql 의 테이블별 행 타입. 시간은 UTC ISO 8601 문자열, JSON 열은 JSON 문자열(TEXT),
// 불리언 열은 0/1 정수다. 열 이름은 SQL 과 같다. (열거형 값은 enums.ts, 열 이름의 일치는 test/unit/entity-rows.test.ts 가 확인한다.)
import type {
  AbortReason, ActorKind, ApprovalDecision, ApprovalSubjectKind, CallArtifactKind, CallArtifactSource, CallDirection, CallStatus, CatchUpMode, ChangeClass, CostCategory,
  EvalOutcome, EvidenceKind, ExternalEffectState, Impact, Lifecycle, MemoryKind, MemoryValidity,
  OrgProposalStatus, OrgVersionStatus, PolicyDecisionValue, ReauthMethod, ProductKind, ProductLifecycleStage,
  ProductRegistrationStatus, PublicationStatus, SafetyResult, Scope, Sensitivity, StrategyStatus,
  TaskRunOutcome, TaskStatus, TriggerKind, TrustOrigin, VerificationStatus,
} from './enums.ts';

type Iso = string;
type Json = string;

export type OrgVersionRow = {
  id: string; parent_id: string | null; proposal_id: string | null; snapshot: Json; status: OrgVersionStatus; created_at: Iso;
}

export type OrgProposalRow = {
  id: string; proposed_by: string; diff: Json; rationale: string; evidence_refs: Json; expected_effect: string;
  base_org_version_id: string; proposal_hash: string; scope: Json; risk_assessment: Json; evaluation_plan: Json;
  rollback_plan: Json; change_class: ChangeClass; trial_scope: Json; trial_min_days: number; trial_extensions: number;
  expires_at: Iso; status: OrgProposalStatus; org_version_id: string | null; created_at: Iso;
}

export type OrgTrialResultRow = {
  id: string; proposal_id: string; evaluator: string; outcome: EvalOutcome; abort_reason: AbortReason | null;
  observations: number; metrics: Json; evidence_refs: Json; at: Iso;
}

export type OrgUnitRow = {
  id: string; parent_id: string | null; slug: string; lifecycle: Lifecycle; name: string; responsibility: string; created_at: Iso;
}

export type RoleRow = {
  id: string; org_unit_id: string; slug: string; description: string; allowed_tools: Json; lifecycle: Lifecycle;
  version: number; trial_scope: Json | null; created_at: Iso;
}

export type ActorRow = { id: string; kind: ActorKind; name: string; adapter: string | null; created_at: Iso }

export type RoleAssignmentRow = { actor_id: string; role_id: string; valid_from: Iso; valid_until: Iso | null }

export type ProductRow = {
  id: string; slug: string; name: string; kind: ProductKind; description: string | null;
  lifecycle_stage: ProductLifecycleStage; owner_org_unit_id: string | null; registration_status: ProductRegistrationStatus;
  registration_approval_id: string | null; registered_at: Iso | null; created_at: Iso; updated_at: Iso;
}

export type ProductRepoRow = {
  id: string; product_id: string; name: string; local_path: string | null; remote_url: string | null;
  default_branch: string | null; stack: Json | null; access_scope: string;
}

export type ProductEnvironmentRow = { id: string; product_id: string; name: string; url: string | null; access_class: string }

export type PolicyVersionRow = {
  id: string; content_hash: string; change_class: ChangeClass; approved_by: Json; deployed_at: Iso; rollback_of: string | null;
}

export type StrategyVersionRow = {
  id: string; parent_id: string | null; title: string; body: string; rationale_refs: Json; status: StrategyStatus;
  experiment_scope: Json | null; created_by: string; created_at: Iso;
}

export type EventRow = {
  id: string; source: string; external_id: string | null; type: string; payload: Json; product_id: string | null;
  idempotency_key: string; occurred_at: Iso; received_at: Iso;
}

export type RoutineRow = {
  id: string; slug: string; org_unit_id: string; schedule: string; task_template: string; catch_up: CatchUpMode;
  enabled: number; product_id: string | null;
}

export type RoutineFiringRow = { routine_id: string; scheduled_for: Iso; fired_at: Iso }

export type TaskRow = {
  id: string; dedupe_key: string; objective: string; org_unit_id: string | null; role_id: string | null;
  role_version: number | null; org_version_id: string | null; product_id: string | null; trigger_kind: TriggerKind;
  trigger_ref: string; spec: Json; task_spec_version: number; tool_contract_version: string | null;
  approval_id: string | null; approved_snapshot: Json | null; approved_hash: string | null; status: TaskStatus;
  policy_version_id: string; strategy_version_id: string | null; cost_budget_usd: number; attempts: number;
  max_attempts: number; next_run_at: Iso | null; created_at: Iso; updated_at: Iso;
}

export type TaskDependencyRow = { task_id: string; depends_on: string }

export type TaskTransitionRow = {
  id: number; task_id: string; from_status: TaskStatus | null; to_status: TaskStatus; reason: string; caused_by: string; at: Iso;
}

export type TaskRunRow = {
  id: string; task_id: string; attempt: number; actor_id: string; adapter: string; started_at: Iso; ended_at: Iso | null;
  lease_owner: string; lease_expires_at: Iso; heartbeat_at: Iso; checkpoint: Json | null; outcome: TaskRunOutcome | null;
  result: Json | null; run_log_ref: string | null;
}

export type ExternalEffectRow = {
  id: string; effect_key: string; task_id: string; task_run_id: string; tool: string; action: string; target: string;
  request_hash: string; state: ExternalEffectState; supports_idempotency: number; response_ref: string | null;
  compensation_ref: string | null; at: Iso;
}

export type PolicyDecisionRow = {
  id: number; task_id: string | null; task_run_id: string | null; subject: string; action: string; resource: string;
  scope: Scope; impact: Impact; constraints: Json | null; approval_required: Json | null; decision: PolicyDecisionValue;
  reason: string; policy_version_id: string; at: Iso;
}

export type EvidenceRow = {
  id: string; task_id: string; task_run_id: string | null; kind: EvidenceKind; ref: string; content_hash: string | null;
  /** 근거의 신뢰 출처. 외부 페이지·문서에서 읽은 근거는 external_untrusted (기본값 없음: 쓰는 쪽이 밝힌다) */
  trust_origin: TrustOrigin; captured_at: Iso; verified: number; verification_note: string | null;
}

export type CostEntryRow = {
  id: string; task_id: string | null; task_run_id: string | null; product_id: string | null; category: CostCategory;
  amount_usd: number; units: Json | null; at: Iso;
}

export type ApprovalRow = {
  id: string; subject_kind: ApprovalSubjectKind; subject_id: string; decision: ApprovalDecision;
  subject_hash: string | null; decided_by: string; comment: string | null; at: Iso;
}

export type HumanReauthRow = {
  id: number; actor_id: string; method: ReauthMethod; time_step: number; purpose: string; at: Iso;
}

export type EvaluationRow = {
  id: string; task_id: string; task_run_id: string | null; evaluator: string; validation_passed: number;
  outcome: EvalOutcome; primary_evidence_refs: Json; agent_report_used: number; quality: number | null;
  quality_note: string | null; effect: number | null; effect_note: string | null; economics: number | null;
  economics_note: string | null; safety: SafetyResult; safety_note: string | null; evidence_refs: Json;
  total_cost_usd: number | null; human_minutes: number | null; at: Iso;
}

export type MemoryItemRow = {
  id: string; kind: MemoryKind; body: string; source_ref: string; observed_at: Iso; verification_status: VerificationStatus;
  validity: MemoryValidity; valid_until: Iso | null; sensitivity: Sensitivity; trust_origin: TrustOrigin;
  superseded_by: string | null; product_id: string | null; policy_version_id: string | null;
  strategy_version_id: string | null; created_by: string; created_at: Iso;
}

export type PublicationRow = {
  id: string; task_id: string; product_id: string | null; channel: string; audience: Scope; content_ref: string;
  status: PublicationStatus; approval_id: string | null; published_at: Iso | null;
}

export type CallRow = {
  id: string; provider: string; provider_call_id: string | null; direction: CallDirection; status: CallStatus;
  from_number: string | null; to_number: string; task_id: string | null; task_run_id: string | null; actor_id: string | null;
  org_unit_id: string | null; objective: string | null; effect_key: string | null; intent_key: string | null; max_duration_seconds: number | null;
  allow_transfer: number; recording: number; end_reason: string | null; started_at: Iso | null; connected_at: Iso | null;
  ended_at: Iso | null; created_at: Iso; updated_at: Iso;
}

export type CallArtifactRow = {
  id: string; call_id: string; kind: CallArtifactKind; content: Json; content_hash: string; source: CallArtifactSource;
  trust_origin: TrustOrigin; created_at: Iso; updated_at: Iso;
}
