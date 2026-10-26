// 행 타입(entities/rows.ts)의 열 이름이 schema.sql 의 실제 열과 같은지 확인한다 (양방향).
// `satisfies Record<keyof XRow, true>` 가 타입 쪽 누락·초과를, PRAGMA table_info 비교가 DB 쪽 누락·초과를 잡는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { openDb } from '@aot/domain';
import type { OrgVersionRow, OrgProposalRow, OrgTrialResultRow, OrgUnitRow, RoleRow, ActorRow, RoleAssignmentRow, ProductRow, ProductRepoRow, ProductEnvironmentRow, PolicyVersionRow, StrategyVersionRow, EventRow, RoutineRow, RoutineFiringRow, TaskRow, TaskDependencyRow, TaskTransitionRow, TaskRunRow, ExternalEffectRow, PolicyDecisionRow, EvidenceRow, CostEntryRow, ApprovalRow, HumanReauthRow, EvaluationRow, MemoryItemRow, PublicationRow, CallRow, CallArtifactRow } from '@aot/domain';

import { SCHEMA_SQL } from '../support/schema-snapshot.ts';

const COLUMNS = {
  org_version: { id: true, parent_id: true, proposal_id: true, snapshot: true, status: true, created_at: true } satisfies Record<keyof OrgVersionRow, true>,
  org_proposal: { id: true, proposed_by: true, diff: true, rationale: true, evidence_refs: true, expected_effect: true, base_org_version_id: true, proposal_hash: true, scope: true, risk_assessment: true, evaluation_plan: true, rollback_plan: true, change_class: true, trial_scope: true, trial_min_days: true, trial_extensions: true, expires_at: true, status: true, org_version_id: true, created_at: true } satisfies Record<keyof OrgProposalRow, true>,
  org_trial_result: { id: true, proposal_id: true, evaluator: true, outcome: true, abort_reason: true, observations: true, metrics: true, evidence_refs: true, at: true } satisfies Record<keyof OrgTrialResultRow, true>,
  org_unit: { id: true, parent_id: true, slug: true, lifecycle: true, name: true, responsibility: true, created_at: true } satisfies Record<keyof OrgUnitRow, true>,
  role: { id: true, org_unit_id: true, slug: true, description: true, allowed_tools: true, lifecycle: true, version: true, trial_scope: true, created_at: true } satisfies Record<keyof RoleRow, true>,
  actor: { id: true, kind: true, name: true, adapter: true, created_at: true } satisfies Record<keyof ActorRow, true>,
  role_assignment: { actor_id: true, role_id: true, valid_from: true, valid_until: true } satisfies Record<keyof RoleAssignmentRow, true>,
  product: { id: true, slug: true, name: true, kind: true, description: true, lifecycle_stage: true, owner_org_unit_id: true, registration_status: true, registration_approval_id: true, registered_at: true, created_at: true, updated_at: true } satisfies Record<keyof ProductRow, true>,
  product_repo: { id: true, product_id: true, name: true, local_path: true, remote_url: true, default_branch: true, stack: true, access_scope: true } satisfies Record<keyof ProductRepoRow, true>,
  product_environment: { id: true, product_id: true, name: true, url: true, access_class: true } satisfies Record<keyof ProductEnvironmentRow, true>,
  policy_version: { id: true, content_hash: true, change_class: true, approved_by: true, deployed_at: true, rollback_of: true } satisfies Record<keyof PolicyVersionRow, true>,
  strategy_version: { id: true, parent_id: true, title: true, body: true, rationale_refs: true, status: true, experiment_scope: true, created_by: true, created_at: true } satisfies Record<keyof StrategyVersionRow, true>,
  event: { id: true, source: true, external_id: true, type: true, payload: true, product_id: true, idempotency_key: true, occurred_at: true, received_at: true } satisfies Record<keyof EventRow, true>,
  routine: { id: true, slug: true, org_unit_id: true, schedule: true, task_template: true, catch_up: true, enabled: true, product_id: true } satisfies Record<keyof RoutineRow, true>,
  routine_firing: { routine_id: true, scheduled_for: true, fired_at: true } satisfies Record<keyof RoutineFiringRow, true>,
  task: { id: true, dedupe_key: true, objective: true, org_unit_id: true, role_id: true, role_version: true, org_version_id: true, product_id: true, trigger_kind: true, trigger_ref: true, spec: true, task_spec_version: true, tool_contract_version: true, approval_id: true, approved_snapshot: true, approved_hash: true, status: true, policy_version_id: true, strategy_version_id: true, cost_budget_usd: true, attempts: true, max_attempts: true, next_run_at: true, created_at: true, updated_at: true } satisfies Record<keyof TaskRow, true>,
  task_dependency: { task_id: true, depends_on: true } satisfies Record<keyof TaskDependencyRow, true>,
  task_transition: { id: true, task_id: true, from_status: true, to_status: true, reason: true, caused_by: true, at: true } satisfies Record<keyof TaskTransitionRow, true>,
  task_run: { id: true, task_id: true, attempt: true, actor_id: true, adapter: true, started_at: true, ended_at: true, lease_owner: true, lease_expires_at: true, heartbeat_at: true, checkpoint: true, outcome: true, result: true, run_log_ref: true } satisfies Record<keyof TaskRunRow, true>,
  external_effect: { id: true, effect_key: true, task_id: true, task_run_id: true, tool: true, action: true, target: true, request_hash: true, state: true, supports_idempotency: true, idempotency_retention_ms: true, response_ref: true, compensation_ref: true, planned_at: true, at: true } satisfies Record<keyof ExternalEffectRow, true>,
  policy_decision: { id: true, task_id: true, task_run_id: true, subject: true, action: true, resource: true, scope: true, impact: true, constraints: true, approval_required: true, decision: true, reason: true, policy_version_id: true, at: true } satisfies Record<keyof PolicyDecisionRow, true>,
  evidence: { id: true, task_id: true, task_run_id: true, kind: true, ref: true, content_hash: true, trust_origin: true, captured_at: true, verified: true, verification_note: true } satisfies Record<keyof EvidenceRow, true>,
  cost_entry: { id: true, task_id: true, task_run_id: true, product_id: true, category: true, amount_usd: true, units: true, at: true } satisfies Record<keyof CostEntryRow, true>,
  approval: { id: true, subject_kind: true, subject_id: true, decision: true, subject_hash: true, decided_by: true, comment: true, at: true } satisfies Record<keyof ApprovalRow, true>,
  human_reauth: { id: true, actor_id: true, method: true, time_step: true, purpose: true, at: true } satisfies Record<keyof HumanReauthRow, true>,
  evaluation: { id: true, task_id: true, task_run_id: true, evaluator: true, validation_passed: true, outcome: true, primary_evidence_refs: true, agent_report_used: true, quality: true, quality_note: true, effect: true, effect_note: true, economics: true, economics_note: true, safety: true, safety_note: true, evidence_refs: true, total_cost_usd: true, human_minutes: true, at: true } satisfies Record<keyof EvaluationRow, true>,
  memory_item: { id: true, kind: true, body: true, source_ref: true, observed_at: true, verification_status: true, validity: true, valid_until: true, sensitivity: true, trust_origin: true, superseded_by: true, product_id: true, policy_version_id: true, strategy_version_id: true, created_by: true, created_at: true } satisfies Record<keyof MemoryItemRow, true>,
  publication: { id: true, task_id: true, product_id: true, channel: true, audience: true, content_ref: true, status: true, approval_id: true, published_at: true } satisfies Record<keyof PublicationRow, true>,
  call: { id: true, provider: true, provider_call_id: true, direction: true, status: true, from_number: true, to_number: true, task_id: true, task_run_id: true, actor_id: true, org_unit_id: true, objective: true, effect_key: true, intent_key: true, max_duration_seconds: true, allow_transfer: true, recording: true, end_reason: true, started_at: true, connected_at: true, ended_at: true, created_at: true, updated_at: true } satisfies Record<keyof CallRow, true>,
  call_artifact: { id: true, call_id: true, kind: true, content: true, content_hash: true, source: true, trust_origin: true, created_at: true, updated_at: true } satisfies Record<keyof CallArtifactRow, true>,
};

test('row types list exactly the columns of every table in schema.sql', () => {
  const db = openDb({ path: ':memory:' });
  try {
    db.writeTx((tx) => tx.exec(readFileSync(SCHEMA_SQL, 'utf8')));
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name)
      .sort();
    assert.deepEqual(Object.keys(COLUMNS).sort(), tables, 'every table has a row type and vice versa');
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const actual = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name);
      assert.deepEqual(Object.keys(columns).sort(), [...actual].sort(), table);
    }
  } finally {
    db.close();
  }
});
