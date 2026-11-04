// Phase B / B1: 조직 제안 모델 (packages/domain/src/org.ts).
//  - 생성: 검증, 금지 대상 거부, 위험 분류(제안자가 낮출 수 없다), 멱등
//  - 전이: 에이전트 거부, 사람 승인 기록 필수, 기준 버전 충돌, 만료, 평가 결과 필요, 연장 상한
//  - 부수 효과: trial 진입 시 역할·부서·버전 생성, 확정 시 교체, 롤백 시 복구(삭제 아님)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createOrgProposal, expireOrgProposals, getOrgProposal, latestTrialResult, OrgRuleError, SEED_IDS, supersedeStaleOrgProposals, transitionOrgProposal,
  TransitionError, type Db, type OrgProposalInput,
} from '@aot/domain';

import { addAgent, seededDb } from '../support/seeded-db.ts';

const DAY_MS = 86_400_000;
const TOOLS = [{ tool: 'web_search', operations: ['search'] }];
const EVALUATION = { min_pass_rate: 0.8, min_observations: 3, max_cost_usd: 5, baseline_window_days: 30, evaluation_days: 14 };
const ROLLBACK = { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: 'generalist' }, running_tasks: 'finish', external_effects: 'human' };

function input(proposedBy: string, overrides: Partial<OrgProposalInput> = {}): OrgProposalInput {
  return {
    proposedBy,
    diff: { ops: [{ op: 'add_role', role: { slug: 'example-researcher', description: '조사 전담', allowed_tools: TOOLS, unit: { slug: 'research', name: 'research', responsibility: '시장 조사' } } }] },
    rationale: 'unassigned 업무가 반복됨',
    evidenceRefs: ['task:example'],
    expectedEffect: '조사 업무 처리 시간 단축',
    riskAssessment: { risks: ['새 역할의 품질'], mitigations: ['시험 기간 동안 조사 업무로 제한'] },
    evaluationPlan: EVALUATION,
    rollbackPlan: ROLLBACK,
    trialScope: { task_types: ['weekly-market-research'] },
    ...overrides,
  };
}

function setup(t: { after(fn: () => void): void }) {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  const propose = (overrides: Partial<OrgProposalInput> = {}, by = agent) => db.writeTx((tx) => createOrgProposal(tx, clock, input(by, overrides)));
  let sequence = 0;
  const approval = (id: string, actor: string, decision = 'approved') => db.writeTx((tx) => {
    sequence += 1;
    const approvalId = `approval-${sequence}-${decision}`;
    tx.run('INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)', [
      approvalId, 'org_proposal', id, decision, actor, clock.nowIso(),
    ]);
    return approvalId;
  });
  const move = (id: string, to: Parameters<typeof transitionOrgProposal>[2]['to'], rest: Partial<Parameters<typeof transitionOrgProposal>[2]> = {}) =>
    db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId: id, to, by: 'human', actorId: SEED_IDS.owner, ...rest }));
  const result = (id: string, outcome: 'pass' | 'fail' | 'inconclusive') => db.writeTx((tx) => tx.run(
    `INSERT INTO org_trial_result (id, proposal_id, evaluator, outcome, abort_reason, observations, metrics, evidence_refs, at) VALUES (?, ?, 'test-evaluator@1', ?, NULL, 3, '{}', '[]', ?)`,
    [`result-${id}-${outcome}-${clock.nowIso()}`, id, outcome, clock.nowIso()],
  ));
  return { db, clock, agent, propose, approval, move, result };
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof OrgRuleError || error instanceof TransitionError) return error.code;
    throw error;
  }
  return 'no_error';
};
const statusOf = (db: Db, id: string): string => getOrgProposal(db, id)!.status;
const lifecycleOf = (db: Db, table: 'role' | 'org_unit', slug: string): string | undefined => db.get<{ lifecycle: string }>(`SELECT lifecycle FROM ${table} WHERE slug = ?`, [slug])?.lifecycle;

test('create: a valid proposal is stored once (idempotent) and derives scope from the diff', (t) => {
  const { db, propose } = setup(t);
  const first = propose();
  assert.equal(first.created, true);
  assert.equal(first.changeClass, 'normal');
  assert.equal(propose().created, false);
  assert.equal(propose().proposalId, first.proposalId);
  const row = getOrgProposal(db, first.proposalId)!;
  assert.equal(row.status, 'proposed');
  assert.equal(row.base_org_version_id, SEED_IDS.orgVersion);
  assert.deepEqual(JSON.parse(row.scope), { roles: ['example-researcher'], task_types: ['weekly-market-research'] });
});

test('create: a tool no active role has is a permission expansion and makes the proposal risky (cannot be lowered)', (t) => {
  const { propose } = setup(t);
  const risky = propose({ diff: { ops: [{ op: 'add_role', role: { slug: 'example-mailer', description: '발송', allowed_tools: [{ tool: 'email_send', operations: ['send'] }], unit: 'core' } }] } });
  assert.equal(risky.changeClass, 'risky');
  assert.match(risky.riskReasons[0]!, /email_send\.send/);
  assert.equal(propose({ ...({ changeClass: 'normal' } as object) } as Partial<OrgProposalInput>).changeClass, 'normal');
});

test('create: fixed core components cannot be targeted (operations, tools, role and unit names)', (t) => {
  const { propose } = setup(t);
  const role = (over: Record<string, unknown>) => ({ ops: [{ op: 'add_role', role: { slug: 'example-role', description: 'x', allowed_tools: TOOLS, unit: 'core', ...over } }] });
  assert.equal(code(() => propose({ diff: { ops: [{ op: 'update_policy', rule: {} }] } })), 'forbidden_target');
  assert.equal(code(() => propose({ diff: { ops: [{ op: 'replace_evaluator', id: 'x' }] } })), 'forbidden_target');
  assert.equal(code(() => propose({ diff: role({ allowed_tools: [{ tool: 'policy.deploy', operations: ['apply'] }] }) })), 'forbidden_target');
  assert.equal(code(() => propose({ diff: role({ allowed_tools: [{ tool: 'approval', operations: ['grant'] }] }) })), 'forbidden_target');
  assert.equal(code(() => propose({ diff: role({ slug: 'second-verifier' }) })), 'forbidden_target');
  assert.equal(code(() => propose({ diff: role({ unit: { slug: 'policy-team', name: 'x', responsibility: 'x' } }) })), 'forbidden_target');
});

test('create: incomplete or malformed plans are rejected (no proposal without evaluation, rollback, trial scope and risk assessment)', (t) => {
  const { db, propose } = setup(t);
  assert.equal(code(() => propose({ evaluationPlan: { ...EVALUATION, min_observations: 0 } })), 'invalid_field');
  assert.equal(code(() => propose({ evaluationPlan: { ...EVALUATION, evaluation_days: 3 } })), 'invalid_field');
  assert.equal(code(() => propose({ evaluationPlan: { ...EVALUATION, extra: 1 } })), 'invalid_field');
  assert.equal(code(() => propose({ rollbackPlan: { ...ROLLBACK, routines: 'keep' } })), 'invalid_field');
  assert.equal(code(() => propose({ rollbackPlan: { ...ROLLBACK, queued_tasks: { reroute_to: 'no-such-role' } } })), 'invalid_field');
  assert.equal(code(() => propose({ rollbackPlan: undefined })), 'invalid_field');
  assert.equal(code(() => propose({ trialScope: { task_types: [] } })), 'invalid_field');
  assert.equal(code(() => propose({ riskAssessment: { risks: [], mitigations: ['x'] } })), 'invalid_field');
  assert.equal(code(() => propose({ evidenceRefs: [] })), 'invalid_field');
  assert.equal(code(() => propose({ diff: { ops: [{ op: 'add_role', role: { slug: 'generalist', description: 'x', allowed_tools: TOOLS, unit: 'core' } }] } })), 'invalid_field');
  assert.equal(code(() => propose({ diff: { ops: [{ op: 'add_role', role: { slug: 'example-role', description: 'x', allowed_tools: TOOLS, unit: 'no-unit' } }] } })), 'invalid_field');
  assert.equal(code(() => propose({}, 'actor-unknown')), 'unknown_actor');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM org_proposal')!.n, 0);
});

test('transition: agents cannot change a proposal; approval needs a human approval record of this proposal', (t) => {
  const { db, clock, agent, propose, approval, move } = setup(t);
  const { proposalId } = propose();
  assert.equal(code(() => db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'approved', by: 'agent' }))), 'agent_forbidden');
  assert.equal(code(() => move(proposalId, 'approved')), 'approval_missing');
  assert.equal(code(() => move(proposalId, 'approved', { actorId: agent })), 'not_human');
  assert.equal(code(() => move(proposalId, 'approved', { approvalId: approval(proposalId, agent) })), 'approval_missing');
  assert.equal(code(() => move(proposalId, 'approved', { approvalId: approval(proposalId, SEED_IDS.owner, 'rejected') })), 'approval_missing');
  assert.equal(code(() => move(proposalId, 'trial')), 'not_allowed');
  assert.equal(code(() => move(proposalId, 'active', { by: 'system' })), 'not_allowed');
  assert.equal(statusOf(db, proposalId), 'proposed');
  move(proposalId, 'approved', { approvalId: approval(proposalId, SEED_IDS.owner) });
  assert.equal(statusOf(db, proposalId), 'approved');
});

test('transition: a proposal based on an older org_version conflicts and a sweep marks it superseded', (t) => {
  const { db, clock, propose, approval, move } = setup(t);
  const a = propose().proposalId;
  const b = propose({ trialScope: { task_types: ['other-type'] } }).proposalId;
  move(a, 'approved', { approvalId: approval(a, SEED_IDS.owner) });
  db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId: a, to: 'trial', by: 'system' }));
  db.writeTx((tx) => tx.run("UPDATE org_version SET status = 'retired' WHERE id = ?", [SEED_IDS.orgVersion]));
  db.writeTx((tx) => tx.run(
    "INSERT INTO org_version (id, parent_id, proposal_id, snapshot, status, created_at) VALUES ('org-version-next', ?, NULL, '{}', 'active', ?)", [SEED_IDS.orgVersion, clock.nowIso()],
  ));
  assert.equal(code(() => move(b, 'approved', { approvalId: approval(b, SEED_IDS.owner) })), 'conflict');
  assert.deepEqual(db.writeTx((tx) => supersedeStaleOrgProposals(tx, clock)), [b]);
  assert.equal(statusOf(db, b), 'superseded');
});

test('transition: an expired proposal cannot be approved and the sweep expires it', (t) => {
  const { db, clock, propose, approval, move } = setup(t);
  const { proposalId } = propose({ ttlDays: 1 });
  clock.advance(2 * 86_400_000);
  assert.equal(code(() => move(proposalId, 'approved', { approvalId: approval(proposalId, SEED_IDS.owner) })), 'expired');
  assert.deepEqual(db.writeTx((tx) => expireOrgProposals(tx, clock)), [proposalId]);
  assert.equal(statusOf(db, proposalId), 'expired');
});

test('lifecycle: approve → trial creates trial roles/units/version; confirm needs a pass result and a human approval; active swaps the version', (t) => {
  const { db, clock, propose, approval, move, result } = setup(t);
  const { proposalId } = propose();
  move(proposalId, 'approved', { approvalId: approval(proposalId, SEED_IDS.owner) });
  const trial = db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'trial', by: 'system', reason: 'plans complete' }));
  assert.equal(lifecycleOf(db, 'role', 'example-researcher'), 'trial');
  assert.equal(lifecycleOf(db, 'org_unit', 'research'), 'trial');
  assert.deepEqual(JSON.parse(db.get<{ trial_scope: string }>("SELECT trial_scope FROM role WHERE slug = 'example-researcher'")!.trial_scope), { task_types: ['weekly-market-research'] });
  const version = db.get<{ status: string; parent_id: string }>('SELECT status, parent_id FROM org_version WHERE id = ?', [trial.orgVersionId]);
  assert.deepEqual({ ...version }, { status: 'trial', parent_id: SEED_IDS.orgVersion });
  assert.equal(db.get<{ status: string }>('SELECT status FROM org_version WHERE id = ?', [SEED_IDS.orgVersion])!.status, 'active');

  assert.equal(code(() => move(proposalId, 'active', { by: 'system', approvalId: approval(proposalId, SEED_IDS.owner, 'approved') })), 'result_missing');
  result(proposalId, 'fail');
  assert.equal(code(() => move(proposalId, 'active', { by: 'system', approvalId: approval(proposalId, SEED_IDS.owner, 'approved') })), 'result_missing');
  clock.advance(1000);
  result(proposalId, 'pass');
  assert.equal(code(() => move(proposalId, 'active', { by: 'system' })), 'approval_missing');
  move(proposalId, 'active', { by: 'system', approvalId: approval(proposalId, SEED_IDS.owner, 'approved') });
  assert.equal(lifecycleOf(db, 'role', 'example-researcher'), 'active');
  assert.equal(lifecycleOf(db, 'org_unit', 'research'), 'active');
  assert.equal(db.get<{ status: string }>('SELECT status FROM org_version WHERE id = ?', [trial.orgVersionId])!.status, 'active');
  assert.equal(db.get<{ status: string }>('SELECT status FROM org_version WHERE id = ?', [SEED_IDS.orgVersion])!.status, 'retired');
  assert.equal(latestTrialResult(db, proposalId)?.outcome, 'pass');
});

test('rollback: a failed trial retires new roles and units (not deleted), disables their routines and marks the version rolled back', (t) => {
  const { db, clock, propose, approval, move, result } = setup(t);
  const { proposalId } = propose();
  move(proposalId, 'approved', { approvalId: approval(proposalId, SEED_IDS.owner) });
  const trial = db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'trial', by: 'system' }));
  const unitId = db.get<{ id: string }>("SELECT id FROM org_unit WHERE slug = 'research'")!.id;
  db.writeTx((tx) => tx.run(
    "INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled, product_id) VALUES ('routine-x', 'weekly-x', ?, 'cron', 'tpl@1', 'skip', 1, NULL)", [unitId],
  ));
  assert.equal(code(() => db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'rolled_back', by: 'system', reason: 'x' }))), 'result_missing');
  result(proposalId, 'fail');
  const undone = db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'rolled_back', by: 'system', reason: 'trial failed' }));
  assert.deepEqual(undone.disabledRoutineIds, ['routine-x']);
  assert.equal(lifecycleOf(db, 'role', 'example-researcher'), 'retired');
  assert.equal(lifecycleOf(db, 'org_unit', 'research'), 'retired');
  assert.equal(db.get<{ enabled: number }>("SELECT enabled FROM routine WHERE id = 'routine-x'")!.enabled, 0);
  assert.equal(db.get<{ status: string }>('SELECT status FROM org_version WHERE id = ?', [trial.orgVersionId])!.status, 'rolled_back');
  assert.equal(db.get<{ status: string }>('SELECT status FROM org_version WHERE id = ?', [SEED_IDS.orgVersion])!.status, 'active');
});

test('rollback of an active change restores the parent version; it needs a human reason', (t) => {
  const { db, clock, propose, approval, move, result } = setup(t);
  const { proposalId } = propose();
  move(proposalId, 'approved', { approvalId: approval(proposalId, SEED_IDS.owner) });
  const trial = db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'trial', by: 'system' }));
  result(proposalId, 'pass');
  move(proposalId, 'active', { by: 'system', approvalId: approval(proposalId, SEED_IDS.owner) });
  assert.equal(code(() => move(proposalId, 'rolled_back')), 'reason_required');
  move(proposalId, 'rolled_back', { reason: 'regression found after confirmation' });
  assert.equal(db.get<{ status: string }>('SELECT status FROM org_version WHERE id = ?', [SEED_IDS.orgVersion])!.status, 'active');
  assert.equal(db.get<{ status: string }>('SELECT status FROM org_version WHERE id = ?', [trial.orgVersionId])!.status, 'rolled_back');
  assert.equal(lifecycleOf(db, 'role', 'example-researcher'), 'retired');
});

test('inconclusive: roles stop receiving work; one human-approved retry with a new plan is allowed, a second is refused', (t) => {
  const { db, clock, propose, approval, move, result } = setup(t);
  const { proposalId } = propose();
  move(proposalId, 'approved', { approvalId: approval(proposalId, SEED_IDS.owner) });
  db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'trial', by: 'system' }));
  assert.equal(code(() => db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'inconclusive', by: 'evaluator' }))), 'result_missing');
  result(proposalId, 'inconclusive');
  db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'inconclusive', by: 'evaluator' }));
  assert.equal(lifecycleOf(db, 'role', 'example-researcher'), 'retired');
  assert.equal(code(() => move(proposalId, 'trial', { approvalId: approval(proposalId, SEED_IDS.owner) })), 'invalid_field');
  const plan = { ...EVALUATION, evaluation_days: 21 };
  move(proposalId, 'trial', { approvalId: approval(proposalId, SEED_IDS.owner), evaluationPlan: plan });
  assert.equal(lifecycleOf(db, 'role', 'example-researcher'), 'trial');
  const row = getOrgProposal(db, proposalId)!;
  assert.equal(row.trial_extensions, 1);
  assert.equal(JSON.parse(row.evaluation_plan).evaluation_days, 21);
  clock.advance(1000);
  result(proposalId, 'inconclusive');
  db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'inconclusive', by: 'evaluator' }));
  assert.equal(code(() => move(proposalId, 'trial', { approvalId: approval(proposalId, SEED_IDS.owner), evaluationPlan: plan })), 'extension_limit');
});

test('a confirmation must come after the passing result: the earlier proposal approval cannot be reused to confirm a trial', (t) => {
  const { db, clock, propose, approval, move, result } = setup(t);
  const { proposalId } = propose();
  const early = approval(proposalId, SEED_IDS.owner);
  move(proposalId, 'approved', { approvalId: early });
  db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId, to: 'trial', by: 'system' }));
  clock.advance(DAY_MS);
  result(proposalId, 'pass');
  assert.equal(code(() => move(proposalId, 'active', { by: 'system', approvalId: early })), 'approval_missing');
  assert.equal(statusOf(db, proposalId), 'trial');
  move(proposalId, 'active', { by: 'system', approvalId: approval(proposalId, SEED_IDS.owner) });
  assert.equal(statusOf(db, proposalId), 'active');
});

test('review fixes: name variants of fixed components are refused; a dead proposal can be submitted again; a stale or duplicate proposal cannot be approved', (t) => {
  const { db, clock, propose, approval, move } = setup(t);
  const role = (over: Record<string, unknown>) => ({ ops: [{ op: 'add_role', role: { slug: 'example-role', description: 'x', allowed_tools: TOOLS, unit: 'core', ...over } }] });
  for (const tool of ['policy-admin.deploy', 'policies.x', 'x.policy.deploy', 'evaluators.run']) {
    assert.equal(code(() => propose({ diff: role({ allowed_tools: [{ tool, operations: ['x'] }] }) })), 'forbidden_target', tool);
  }
  for (const slug of ['evalu-ator', 'approver-role', 'org-mgmt']) assert.equal(code(() => propose({ diff: role({ slug }) })), 'forbidden_target', slug);

  const first = propose().proposalId;
  db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId: first, to: 'rejected', by: 'human', actorId: SEED_IDS.owner, reason: 'no' }));
  const again = propose();
  assert.equal(again.created, true, 'a rejected proposal does not block the same content');
  assert.notEqual(again.proposalId, first);
  assert.equal(propose().proposalId, again.proposalId, 'but an open one is still idempotent');

  // 승인 전에 같은 slug 의 역할이 생기면 승인할 수 없다 (시험 시작이 영원히 실패하지 않게)
  db.writeTx((tx) => tx.run(
    "INSERT INTO role (id, org_unit_id, slug, description, allowed_tools, lifecycle, version, trial_scope, created_at) VALUES ('role-dup', ?, 'example-researcher', 'x', '[]', 'active', 1, NULL, ?)", [SEED_IDS.unit, clock.nowIso()],
  ));
  assert.equal(code(() => move(again.proposalId, 'approved', { approvalId: approval(again.proposalId, SEED_IDS.owner) })), 'conflict');
});

test('review fixes: a normal proposal that would now expand permissions cannot get the normal approval; rollback/retire need the latest confirmed change', (t) => {
  const { db, clock, propose, approval, move, result } = setup(t);
  const a = propose({ diff: { ops: [{ op: 'add_role', role: { slug: 'role-a', description: 'a', allowed_tools: [{ tool: 'web_search', operations: ['search'] }], unit: 'core' } }] } }).proposalId;
  // a 와 같은 도구를 쓰는 role-b: 만들 때는 일반 변경
  const b = propose({ diff: { ops: [{ op: 'add_role', role: { slug: 'role-b', description: 'b', allowed_tools: [{ tool: 'web_search', operations: ['search'] }], unit: 'core' } }] }, trialScope: { task_types: ['other-type'] } }).proposalId;
  assert.equal(getOrgProposal(db, b)!.change_class, 'normal');
  // 시험 중에 도구 목록을 바꿀 수는 없지만, 지금 active 역할이 그 도구를 요청하지 않게 되면(예: generalist 가 바뀜) 등급이 달라질 수 있다
  db.writeTx((tx) => tx.run("UPDATE role SET allowed_tools = '[]' WHERE slug = 'generalist'"));
  assert.equal(code(() => move(b, 'approved', { approvalId: approval(b, SEED_IDS.owner) })), 'conflict');
  assert.equal(statusOf(db, b), 'proposed');

  // 확정된 a 를 되돌리거나 폐지하려면 a 가 마지막 확정이어야 한다
  db.writeTx((tx) => tx.run("UPDATE role SET allowed_tools = '[{\"tool\":\"web_search\",\"operations\":[\"search\"]}]' WHERE slug = 'generalist'"));
  move(a, 'approved', { approvalId: approval(a, SEED_IDS.owner) });
  db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId: a, to: 'trial', by: 'system' }));
  result(a, 'pass');
  move(a, 'active', { by: 'system', approvalId: approval(a, SEED_IDS.owner) });
  db.writeTx((tx) => tx.run("INSERT INTO org_version (id, parent_id, proposal_id, snapshot, status, created_at) VALUES ('org-version-later', ?, NULL, '{}', 'active', ?)", [getOrgProposal(db, a)!.org_version_id, clock.nowIso()]));
  db.writeTx((tx) => tx.run("UPDATE org_version SET status = 'retired' WHERE id = ?", [getOrgProposal(db, a)!.org_version_id]));
  assert.equal(code(() => move(a, 'rolled_back', { reason: 'x' })), 'conflict');
  assert.equal(code(() => move(a, 'retired', { reason: 'x' })), 'conflict');
});
