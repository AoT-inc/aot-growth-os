// Phase B / B6: 적응형 조직 전체 흐름 (overview §6 Phase B 필수 테스트: 조직 변경·시험 평가·롤백 + 권한 확대 불가).
// 실제 부품을 조립한다: 승인 엔진(show/approve/release), 조직 채널(propose/signals/confirm/…), 조직 주기(advanceOrganization), 시험 평가기, 업무 배정.
//  1. 신호 → 제안 → 승인 → 시험(범위 안 unassigned 업무 배정) → 평가 pass → 사람 확인 → 새 org_version active
//  2. 실패(안전성) → 즉시 중단 → 롤백(역할 폐지, 대기 업무 재배정, 루틴 끔) / 증거 부족 → inconclusive → 재시험 1회
//  3. 오래된 기준 버전의 제안은 충돌(superseded) / 권한 확대는 위험 변경 절차 없이는 시험에 못 들어간다 / 역할 생성만으로 권한이 생기지 않는다
//  4. 에이전트는 조직 채널을 쓸 수 없다
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getOrgProposal, SEED_IDS } from '@aot/domain';
import { claimNextTask } from '@aot/task-engine';

import { advanceOrganization } from '../../apps/daemon/src/org-cycle.ts';
import { createOrgChannel, orgSignals } from '../../apps/daemon/src/org-channel.ts';
import { AGENT, createWithGate, effectDraft, HOUR, OWNER, policyEnv, taskRow, type PolicyEnv } from '../support/policy.ts';
import { DAY, PLAN, seedTask, TYPE } from '../support/org-trial.ts';

const ROLLBACK = { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: 'generalist' }, running_tasks: 'finish', external_effects: 'human' };

function proposalBody(slug = 'example-researcher', tools: unknown = [{ tool: 'web_search', operations: ['search'] }], extra: Record<string, unknown> = {}) {
  return {
    diff: { ops: [{ op: 'add_role', role: { slug, description: '조사 전담', allowed_tools: tools, unit: { slug: `unit-${slug}`.slice(0, 40), name: slug, responsibility: '시장 조사' } } }] },
    rationale: 'unassigned 시장 조사 업무가 반복됨',
    evidence_refs: ['signals:unassigned'],
    expected_effect: '시장 조사 업무가 처리된다',
    risk_assessment: { risks: ['새 역할의 품질'], mitigations: ['시험은 조사 업무로 제한'] },
    evaluation_plan: PLAN,
    rollback_plan: ROLLBACK,
    trial_scope: { task_types: [TYPE] },
    ...extra,
  };
}

function rig(t: Parameters<typeof policyEnv>[0]) {
  const env = policyEnv(t);
  const channel = createOrgChannel({ db: env.db, clock: env.clock });
  const org = (op: string, rest: Record<string, unknown> = {}, actor = OWNER) => channel({ cmd: 'org', actor, op, ...rest });
  const cycle = () => advanceOrganization(env.db, env.clock);
  const engineApprove = (id: string) => env.send({ cmd: 'approve', actor: OWNER, kind: 'org_proposal', id, hash: env.send({ cmd: 'show', actor: OWNER, kind: 'org_proposal', id })['hash'] });
  const propose = (body = proposalBody()) => {
    const response = org('propose', { proposal: body });
    assert.equal(response['ok'], true, JSON.stringify(response));
    return String(response['proposal_id']);
  };
  const statusOf = (id: string) => getOrgProposal(env.db, id)!.status;
  const roleLifecycle = (slug: string) => env.db.get<{ lifecycle: string }>('SELECT lifecycle FROM role WHERE slug = ?', [slug])?.lifecycle;
  const activeVersion = () => env.db.get<{ id: string }>("SELECT id FROM org_version WHERE status = 'active'")!.id;
  /** 승인 → 시험 시작까지 */
  const startTrial = (id: string) => {
    assert.equal(engineApprove(id)['state'], 'approved');
    const report = cycle();
    assert.deepEqual(report.started.map((s) => s.proposalId), [id]);
    assert.equal(statusOf(id), 'trial');
  };
  return { env, org, cycle, engineApprove, propose, statusOf, roleLifecycle, activeVersion, startTrial };
}

test('happy path: signal → proposal → approval → trial (routing) → pass → human confirmation → new active org_version', (t) => {
  const r = rig(t);
  const before = r.activeVersion();
  for (let i = 0; i < 3; i += 1) seedTask(r.env.db, r.env.clock, {}); // 역할 없는 시장 조사 업무 3건: seedTask 는 role 을 주지 않으면 unassigned
  const signals = r.org('signals');
  assert.deepEqual((signals['unassigned'] as Array<{ task_type: string; count: number; candidate: boolean }>).map((s) => ({ ...s, hint: undefined })).map(({ task_type, count, candidate }) => ({ task_type, count, candidate })), [{ task_type: TYPE, count: 3, candidate: true }]);

  const id = r.propose();
  assert.equal(r.statusOf(id), 'proposed');
  r.startTrial(id);
  assert.equal(r.roleLifecycle('example-researcher'), 'trial');
  assert.equal(r.activeVersion(), before, 'the active version does not change during the trial');
  const assigned = r.env.db.all<{ id: string; status: string; role_id: string | null }>("SELECT id, status, role_id FROM task WHERE role_id IS NOT NULL AND status = 'queued'");
  assert.equal(assigned.length, 3, 'the unassigned research tasks were routed to the trial role by the next cycle');
  assert.equal(r.org('signals')['unassigned'] instanceof Array && (r.org('signals')['unassigned'] as unknown[]).length, 0);

  // 시험 업무가 끝나고 독립 평가가 통과했다고 하자
  for (const task of assigned) {
    r.env.db.writeTx((tx) => {
      tx.run("UPDATE task SET status = 'completed' WHERE id = ?", [task.id]);
      tx.run(
        `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, agent_report_used, safety, evidence_refs, at)
         VALUES (?, ?, NULL, 'test-evaluator@1', 1, 'pass', '[]', 0, 'pass', '[]', ?)`, [`eval-${task.id}`, task.id, r.env.clock.nowIso()],
      );
    });
  }
  assert.deepEqual(r.cycle().awaitingConfirmation, [], 'too early: the minimum trial period is not over');
  r.env.clock.advance(14 * DAY);
  const report = r.cycle();
  assert.deepEqual(report.awaitingConfirmation, [id]);
  assert.equal(r.statusOf(id), 'trial', 'a passing trial is never promoted automatically');
  assert.equal(r.org('status', { id })['ok'], true);

  assert.match(String(r.org('confirm', { id })['error']), /reason/);
  const confirmed = r.org('confirm', { id, comment: 'results reviewed' });
  assert.equal(confirmed['ok'], true, JSON.stringify(confirmed));
  assert.equal(r.statusOf(id), 'active');
  assert.equal(r.roleLifecycle('example-researcher'), 'active');
  assert.notEqual(r.activeVersion(), before);
  assert.equal(r.env.db.get<{ status: string }>('SELECT status FROM org_version WHERE id = ?', [before])!.status, 'retired');
  assert.equal(r.env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approval WHERE subject_kind = 'org_proposal' AND decision = 'approved'")!.n, 2, 'approval + confirmation, both human');

  // 확정된 역할은 같은 유형의 새 unassigned 업무도 받는다
  const later = seedTask(r.env.db, r.env.clock, {});
  r.cycle();
  assert.equal(taskRow(r.env.db, later).status, 'queued');
});

test('unsafe trial: an immediate stop rolls back — role retired, queued tasks rerouted to the existing role, routines off, version rolled back', (t) => {
  const r = rig(t);
  const id = r.propose();
  r.startTrial(id);
  const unitId = r.env.db.get<{ id: string }>("SELECT id FROM org_unit WHERE slug LIKE 'unit-example-researcher%'")!.id;
  r.env.db.writeTx((tx) => tx.run("INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled, product_id) VALUES ('routine-trial', 'weekly-trial', ?, 'cron', 'tpl@1', 'skip', 1, NULL)", [unitId]));
  const queued = seedTask(r.env.db, r.env.clock, { role: 'example-researcher' });
  const unsafe = seedTask(r.env.db, r.env.clock, { role: 'example-researcher', status: 'completed', outcome: 'pass', safety: 'fail' });
  void unsafe;
  const report = r.cycle();
  assert.deepEqual(report.evaluated.map((e) => ({ verdict: e.verdict, to: e.transitionedTo })), [{ verdict: 'fail', to: 'rolled_back' }]);
  assert.equal(r.statusOf(id), 'rolled_back');
  assert.equal(r.env.db.get<{ abort_reason: string }>('SELECT abort_reason FROM org_trial_result WHERE proposal_id = ?', [id])!.abort_reason, 'safety');
  assert.equal(r.roleLifecycle('example-researcher'), 'retired', 'retired, not deleted');
  assert.equal(r.env.db.get<{ enabled: number }>("SELECT enabled FROM routine WHERE id = 'routine-trial'")!.enabled, 0);
  const row = taskRow(r.env.db, queued);
  assert.equal(row.status, 'queued');
  assert.equal(row.role_id, SEED_IDS.generalist, 'the queued task moved to the existing role');
  assert.equal(r.env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM org_version WHERE status = 'rolled_back'")!.n, 1);
  assert.equal(r.env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM org_version WHERE status = 'active'")!.n, 1);
});

test('too little evidence is inconclusive (not pass, not fail); one human-approved retrial is allowed, a second is refused', (t) => {
  const r = rig(t);
  const id = r.propose();
  r.startTrial(id);
  seedTask(r.env.db, r.env.clock, { role: 'example-researcher', status: 'completed', outcome: 'pass' });
  r.env.clock.advance(15 * DAY);
  assert.deepEqual(r.cycle().evaluated.map((e) => e.verdict), ['inconclusive']);
  assert.equal(r.statusOf(id), 'inconclusive');
  assert.equal(r.roleLifecycle('example-researcher'), 'retired', 'an inconclusive trial counts as ended');
  assert.equal(r.cycle().evaluated.length, 0, 'nothing happens until a person approves a retrial');

  assert.match(String(r.org('retrial', { id, comment: 'try again' })['error']), /evaluation_plan/);
  assert.equal(r.org('retrial', { id, comment: 'try again', evaluation_plan: { ...PLAN, evaluation_days: 21 } })['status'], 'trial');
  assert.equal(r.roleLifecycle('example-researcher'), 'trial');
  r.env.clock.advance(22 * DAY);
  assert.deepEqual(r.cycle().evaluated.map((e) => e.verdict), ['inconclusive'], 'old tasks of the first trial do not count');
  const second = r.org('retrial', { id, comment: 'again', evaluation_plan: PLAN });
  assert.equal(second['ok'], false);
  assert.equal(second['code'], 'extension_limit');
});

test('stale base version: after one change is confirmed, a second proposal made on the old version is superseded and cannot be approved', (t) => {
  const r = rig(t);
  const first = r.propose();
  const second = r.propose(proposalBody('example-analyst', undefined, { trial_scope: { task_types: ['other-type'] }, ttl_days: 60 }));
  r.startTrial(first);
  for (let i = 0; i < 3; i += 1) seedTask(r.env.db, r.env.clock, { role: 'example-researcher', status: 'completed', outcome: 'pass' });
  r.env.clock.advance(14 * DAY);
  r.cycle();
  assert.equal(r.org('confirm', { id: first, comment: 'ok' })['ok'], true);
  const report = r.cycle();
  assert.deepEqual(report.superseded, [second]);
  assert.equal(r.statusOf(second), 'superseded');
  assert.match(String(r.env.send({ cmd: 'approve', actor: OWNER, kind: 'org_proposal', id: second, hash: 'x'.repeat(64) })['error']), /only a proposed change/);
});

test('permission expansion: a risky proposal waits for cooldown and TOTP release; the cycle never starts it before; and a new role gains no permission by existing', (t) => {
  const r = rig(t);
  const risky = [{ tool: 'notify-tool', operations: ['send'] }];
  const id = r.propose(proposalBody('example-notifier', risky));
  assert.equal(r.env.db.get<{ change_class: string }>('SELECT change_class FROM org_proposal WHERE id = ?', [id])!.change_class, 'risky');
  assert.equal(r.engineApprove(id)['state'], 'cooldown');
  assert.deepEqual(r.cycle().started, [], 'approval is pending the cooldown: no trial');
  assert.equal(r.statusOf(id), 'proposed');
  r.env.clock.advance(HOUR);
  assert.match(String(r.env.send({ cmd: 'release', actor: OWNER, kind: 'org_proposal', id })['error']), /TOTP/);
  assert.equal(r.statusOf(id), 'proposed', 'no TOTP, no trial');
  assert.equal(r.env.send({ cmd: 'release', actor: OWNER, kind: 'org_proposal', id, totp: r.env.code() })['state'], 'approved');
  assert.deepEqual(r.cycle().started.map((s) => s.proposalId), [id]);

  // 역할이 있어도 정책은 그대로: 같은 역할의 외부 부작용 업무는 여전히 승인을 요구한다 (기본 거부·require_approval)
  assert.equal(r.env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM policy_version')!.n, 1, 'creating a role never changes the policy');
  const effectTask = createWithGate(r.env, effectDraft({ role: 'example-notifier', trigger: { kind: 'routine', ref: `${TYPE}@2026-W50` } }));
  const claimed = claimNextTask(r.env.db, { clock: r.env.clock, gate: r.env.gate, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', leaseMs: 90_000, taskId: effectTask });
  assert.equal(claimed.claimed, null, 'the task is not run');
  assert.equal(taskRow(r.env.db, effectTask).status, 'needs_review', 'the policy still requires approval for the external effect');
});

test('the policy cannot be targeted by a proposal, and an agent cannot use the organization channel', (t) => {
  const r = rig(t);
  const refused = r.org('propose', { proposal: proposalBody('example-researcher', [{ tool: 'policy.deploy', operations: ['apply'] }]) });
  assert.equal(refused['ok'], false);
  assert.equal(refused['code'], 'forbidden_target');
  assert.equal(r.org('propose', { proposal: { ...proposalBody(), diff: { ops: [{ op: 'update_policy', rules: [] }] } } })['code'], 'forbidden_target');
  assert.equal(r.org('propose', { proposal: { ...proposalBody(), extra: 1 } })['ok'], false, 'unknown fields are refused');
  assert.equal(r.env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM org_proposal')!.n, 0);

  assert.match(String(r.org('signals', {}, AGENT)['error']), /only human actors/);
  assert.match(String(r.org('propose', { proposal: proposalBody() }, AGENT)['error']), /only human actors/);
  assert.equal(r.env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM org_proposal')!.n, 0);
  assert.equal(orgSignals(r.env.db, r.env.clock)['window_days'], 30);
});

test('rollback of a confirmed change: a person can roll it back with a reason; the parent org_version is active again', (t) => {
  const r = rig(t);
  const before = r.activeVersion();
  const id = r.propose();
  r.startTrial(id);
  for (let i = 0; i < 3; i += 1) seedTask(r.env.db, r.env.clock, { role: 'example-researcher', status: 'completed', outcome: 'pass' });
  r.env.clock.advance(14 * DAY);
  r.cycle();
  r.org('confirm', { id, comment: 'ok' });
  assert.equal(r.org('rollback', { id })['ok'], false);
  const rolled = r.org('rollback', { id, comment: 'regression after launch' });
  assert.equal(rolled['status'], 'rolled_back');
  assert.equal(r.activeVersion(), before);
  assert.equal(r.roleLifecycle('example-researcher'), 'retired');
  void ({} as PolicyEnv);
});
