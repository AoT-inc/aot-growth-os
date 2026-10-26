// A6-U15: 실험 전략(strategy_version) 승인 — policy 승인 엔진(engine.ts)과 활성화 직전 재확인(approval.ts verifyStrategyApproval).
//  - 사람 1인 승인(cooldown·TOTP 없음), 승인 해시 = 본문 + experiment_scope + 승인 시점 정책 버전, 같은 트랜잭션에서 proposed → experiment
//  - 에이전트는 승인 채널의 인증 단계에서 거부, 해시 불일치 거부, 진행 중인 실험이 있으면 두 번째 승인 거부, 활성화 전 취소
//  - 자기 승인은 risky_change.min_approvers 규칙 (1 이면 허용, 2 이상이면 금지)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { experimentsInProgress, pendingExperimentActivations, recordStrategyComparison, type Db } from '@aot/domain';
import { verifyStrategyApproval } from '@aot/policy';
import { activateExperiment } from '@aot/task-engine';

import { AGENT, createWithGate, deployDirect, OWNER, policyEnv, policyText, readOnlyDraft, REVIEWER, withExtraRule, type PolicyEnv } from '../support/policy.ts';

function marketing(): Record<string, unknown> {
  const spec = readOnlyDraft({ objective: 'example-product 랜딩 페이지 문구를 한 주 동안 바꿔 본다' });
  delete spec['trigger'];
  return spec;
}
const SCOPE = {
  duration: { period: 'iso_week', weeks: 1 },
  measurement: { signal_id: 'weekly-landing-conversions', period: 'iso_week', baseline_week: '2026-W43' },
  task: { kind: 'task_spec', spec: marketing() },
  trust_origin: 'external_untrusted',
};

function addProposal(env: PolicyEnv, id: string, createdBy = AGENT): string {
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at)
     VALUES (?, NULL, ?, ?, ?, 'proposed', ?, ?, ?)`,
    [id, `Experiment proposal ${id}`, `hypothesis ${id}`, JSON.stringify(['task:example']), JSON.stringify(SCOPE), createdBy, env.clock.nowIso()],
  ));
  return id;
}

const statusOf = (db: Db, id: string) => String(db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [id])!.status);
const approvals = (db: Db, id: string) => db.all<{ decision: string; decided_by: string; subject_hash: string | null }>(
  "SELECT decision, decided_by, subject_hash FROM approval WHERE subject_kind = 'strategy_version' AND subject_id = ? ORDER BY at, rowid", [id],
).map((row) => ({ ...row }));
const show = (env: PolicyEnv, id: string, actor = OWNER) => env.send({ cmd: 'show', actor, kind: 'strategy_version', id });
const approve = (env: PolicyEnv, id: string, hash: unknown, actor = OWNER) => env.send({ cmd: 'approve', actor, kind: 'strategy_version', id, hash });
const showAndApprove = (env: PolicyEnv, id: string, actor = OWNER) => approve(env, id, show(env, id, actor)['hash'], actor);

test('one human approval bound to the shown hash moves proposed -> experiment in the same transaction (no cooldown, no TOTP)', (t) => {
  const env = policyEnv(t);
  addProposal(env, 'strategy-a');
  const shown = show(env, 'strategy-a');
  assert.equal(shown.ok, true, JSON.stringify(shown));
  assert.equal(shown['status'], 'proposed');
  const subject = shown['subject'] as Record<string, unknown>;
  assert.deepEqual(subject['experiment_scope'], SCOPE);
  assert.deepEqual([subject['body'], subject['policy_version_id']], ['hypothesis strategy-a', 'policy-v1']);
  assert.match(String(subject['policy_hash']), /^[0-9a-f]{64}$/);
  assert.equal((shown['approval'] as { state: string }).state, 'missing');

  const approved = approve(env, 'strategy-a', shown['hash']);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved['state'], 'experiment');
  assert.equal(statusOf(env.db, 'strategy-a'), 'experiment');
  assert.deepEqual(approvals(env.db, 'strategy-a'), [{ decision: 'approved', decided_by: OWNER, subject_hash: shown['hash'] }]);
  assert.equal(env.db.get<{ n: number }>('SELECT count(*) AS n FROM human_reauth')!.n, 0, 'no TOTP re-authentication');
  assert.deepEqual(verifyStrategyApproval(env.db, 'strategy-a'), { ok: true, reason: `approved by ${OWNER}`, approvalId: approved['approval_id'], approvedBy: OWNER });
  assert.deepEqual(pendingExperimentActivations(env.db), ['strategy-a'], 'activation happens outside the approval transaction');
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'strategy_version', id: 'strategy-a' })['error']), /needs no release/);
});

test('the hash binds the body, the experiment_scope and the policy version: a change after show is refused and nothing is written', (t) => {
  const env = policyEnv(t);
  addProposal(env, 'strategy-a');
  const edits: [string, () => void][] = [
    ['body', () => env.db.writeTx((tx) => tx.run("UPDATE strategy_version SET body = 'hypothesis edited' WHERE id = 'strategy-a'"))],
    ['experiment_scope', () => env.db.writeTx((tx) => tx.run('UPDATE strategy_version SET experiment_scope = ? WHERE id = ?', [JSON.stringify({ ...SCOPE, duration: { period: 'iso_week', weeks: 4 } }), 'strategy-a']))],
    ['policy version', () => void deployDirect(env, withExtraRule('{id: example-extra, action: ["cms.*"], decision: deny}'))],
  ];
  for (const [what, edit] of edits) {
    const before = show(env, 'strategy-a')['hash'];
    edit();
    const refused = approve(env, 'strategy-a', before);
    assert.equal(refused.ok, false, what);
    assert.match(String(refused.error), /subject hash mismatch/, what);
    assert.equal(statusOf(env.db, 'strategy-a'), 'proposed');
    assert.deepEqual(approvals(env.db, 'strategy-a'), []);
  }
  assert.equal(showAndApprove(env, 'strategy-a')['state'], 'experiment', 'showing again gives the hash to approve');
});

test('agents are refused at the authentication step of the approval channel for every strategy command; nothing is written', (t) => {
  const env = policyEnv(t);
  addProposal(env, 'strategy-a');
  const hash = show(env, 'strategy-a')['hash'];
  for (const command of [
    { cmd: 'show', actor: AGENT, kind: 'strategy_version', id: 'strategy-a' },
    { cmd: 'approve', actor: AGENT, kind: 'strategy_version', id: 'strategy-a', hash },
    { cmd: 'reject', actor: AGENT, kind: 'strategy_version', id: 'strategy-a' },
    { cmd: 'cancel', actor: AGENT, kind: 'strategy_version', id: 'strategy-a' },
    { cmd: 'list', actor: AGENT },
  ]) {
    const response = env.send(command);
    assert.equal(response.ok, false);
    assert.match(String(response.error), /only human actors/);
  }
  assert.match(String(approve(env, 'strategy-a', hash, 'actor-unknown').error), /unknown actor/);
  assert.equal(statusOf(env.db, 'strategy-a'), 'proposed');
  assert.deepEqual(approvals(env.db, 'strategy-a'), []);
});

test('one experiment at a time: a second approval while one is in progress is refused; cancelling the first before activation frees the slot', (t) => {
  const env = policyEnv(t);
  addProposal(env, 'strategy-a');
  addProposal(env, 'strategy-b');
  assert.equal(showAndApprove(env, 'strategy-a')['state'], 'experiment');
  const second = showAndApprove(env, 'strategy-b');
  assert.equal(second.ok, false);
  assert.match(String(second.error), /already in progress \(strategy-a\)/);
  assert.equal(statusOf(env.db, 'strategy-b'), 'proposed');
  assert.deepEqual(approvals(env.db, 'strategy-b'), []);

  // 대기 중(승인됐으나 아직 활성화 전) 취소: 승인이 무효가 되어 켜지지 않고, 진행 중 실험으로 세지 않는다
  const cancelled = env.send({ cmd: 'cancel', actor: OWNER, kind: 'strategy_version', id: 'strategy-a', comment: 'not this week' });
  assert.deepEqual([cancelled.ok, cancelled['state']], [true, 'cancelled']);
  assert.deepEqual(approvals(env.db, 'strategy-a').map((a) => a.decision), ['approved', 'rejected']);
  assert.equal(verifyStrategyApproval(env.db, 'strategy-a').ok, false);
  assert.match(verifyStrategyApproval(env.db, 'strategy-a').reason, /rejected or cancelled/);
  assert.deepEqual(experimentsInProgress(env.db), []);
  assert.deepEqual(pendingExperimentActivations(env.db), []);
  assert.throws(
    () => activateExperiment(env.db, { clock: env.clock, gate: env.gate }, { strategyVersionId: 'strategy-a', verifyApproval: verifyStrategyApproval }),
    /cannot be activated: the approval was rejected or cancelled/,
  );
  assert.equal(showAndApprove(env, 'strategy-b')['state'], 'experiment');
  assert.deepEqual(experimentsInProgress(env.db), ['strategy-b']);
});

test('cancel is refused once the experiment is active (it is ended instead); reject moves proposed -> rejected; only proposed strategies can be approved', (t) => {
  const env = policyEnv(t);
  addProposal(env, 'strategy-a');
  addProposal(env, 'strategy-b');
  showAndApprove(env, 'strategy-a');
  const activated = activateExperiment(env.db, { clock: env.clock, gate: env.gate }, { strategyVersionId: 'strategy-a', verifyApproval: verifyStrategyApproval });
  assert.equal(activated.taskIds.length, 1);
  assert.match(String(env.send({ cmd: 'cancel', actor: OWNER, kind: 'strategy_version', id: 'strategy-a' }).error), /already active; end it/);
  assert.match(String(showAndApprove(env, 'strategy-a').error), /'experiment'; only a proposed strategy can be approved/);

  const rejected = env.send({ cmd: 'reject', actor: OWNER, kind: 'strategy_version', id: 'strategy-b', comment: 'too costly' });
  assert.deepEqual([rejected.ok, rejected['state']], [true, 'rejected']);
  assert.equal(statusOf(env.db, 'strategy-b'), 'rejected');
  assert.match(String(showAndApprove(env, 'strategy-b').error), /'rejected'; only a proposed strategy can be approved/);
  assert.match(String(env.send({ cmd: 'reject', actor: OWNER, kind: 'strategy_version', id: 'strategy-a' }).error), /only a proposed strategy can be rejected/);
});

test('self-approval follows risky_change.min_approvers: a proposal by the owner is approvable by the owner at 1, by another person only at 2', (t) => {
  const env = policyEnv(t);
  addProposal(env, 'strategy-own', OWNER);
  assert.equal(showAndApprove(env, 'strategy-own')['state'], 'experiment');

  const strict = policyEnv(t);
  deployDirect(strict, policyText((y) => y.replace('min_approvers: 1', 'min_approvers: 2')));
  addProposal(strict, 'strategy-own', OWNER);
  const own = showAndApprove(strict, 'strategy-own');
  assert.equal(own.ok, false);
  assert.match(String(own.error), /proposer cannot approve their own strategy/);
  // 실험 승인은 사람 1인 승인이다(외부 부작용·정책 변경이 아님): 2인 정책에서도 다른 사람 한 명이면 된다
  assert.equal(showAndApprove(strict, 'strategy-own', REVIEWER)['state'], 'experiment');
});

test('verifyStrategyApproval: content changed after approval is not valid; a policy deployed after approval does not invalidate it', (t) => {
  const env = policyEnv(t);
  addProposal(env, 'strategy-a');
  showAndApprove(env, 'strategy-a');
  deployDirect(env, withExtraRule('{id: no-web-search, action: ["web_search.*"], decision: deny}'));
  assert.equal(verifyStrategyApproval(env.db, 'strategy-a').ok, true, 'the experiment approval is about its content; the task is re-judged by the new policy');
  env.db.writeTx((tx) => tx.run("UPDATE strategy_version SET title = 'edited after approval' WHERE id = 'strategy-a'"));
  const check = verifyStrategyApproval(env.db, 'strategy-a');
  assert.equal(check.ok, false);
  assert.match(check.reason, /changed since it was approved \(approved_hash mismatch\)/);
  assert.equal(verifyStrategyApproval(env.db, 'strategy-missing').ok, false);
});

test('list shows proposals waiting for approval, comparison records waiting for review and experiments in progress', (t) => {
  const env = policyEnv(t);
  addProposal(env, 'strategy-a');
  addProposal(env, 'strategy-b');
  showAndApprove(env, 'strategy-a');
  const planId = createWithGate(env, readOnlyDraft());
  env.db.writeTx((tx) => recordStrategyComparison(tx, env.clock, { planningTaskId: planId, record: { outcome: 'inconclusive', review_required: true, recommended: null, reasons: ['baseline missing'] }, by: 'evaluator' }));
  const listed = env.send({ cmd: 'list', actor: OWNER });
  assert.equal(listed.ok, true);
  assert.deepEqual((listed['strategy_proposals'] as { id: string }[]).map((s) => s.id), ['strategy-b']);
  assert.deepEqual(listed['experiments'], [{ id: 'strategy-a', activated_at: null }]);
  assert.deepEqual((listed['strategy_reviews'] as { planning_task_id: string; outcome: string; reasons: string[] }[]).map((r) => [r.planning_task_id, r.outcome, r.reasons]), [[planId, 'inconclusive', ['baseline missing']]]);
  activateExperiment(env.db, { clock: env.clock, gate: env.gate }, { strategyVersionId: 'strategy-a', verifyApproval: verifyStrategyApproval });
  assert.deepEqual(env.send({ cmd: 'list', actor: OWNER })['experiments'], [{ id: 'strategy-a', activated_at: env.clock.nowIso() }]);
});
