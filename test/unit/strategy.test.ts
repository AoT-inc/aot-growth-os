// A6-U14: strategy_version 제안과 전이 (domain strategy.ts). 비교 기록이 추천한 후보로만 `proposed` 를 만들고, 같은 (기획 업무, 후보)는 한 번만 만든다.
// 전이는 STRATEGY_MACHINE 허용표를 따르며 에이전트는 어떤 전이도 일으킬 수 없다.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  checkTransition, findStrategyComparison, listStrategyReviews, proposeStrategyVersion, recordStrategyComparison, STRATEGY_MACHINE, strategyProposalId,
  StrategyRuleError, transitionStrategyVersion, TransitionError,
  type Db, type FakeClock, type StrategyProposalInput,
} from '@aot/domain';

import { queuedTask } from '../support/engine.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const OWNER = 'actor-owner';

function rig(t: TestContext) {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  const planningTaskId = queuedTask(db, clock);
  return { db, clock, agent, planningTaskId };
}

const recommended = (id: string | null) => ({ outcome: id === null ? 'no_candidate' : 'recommended', review_required: id === null, recommended: id, reasons: ['test'] });

function proposal(planningTaskId: string, agent: string, extra: Partial<StrategyProposalInput> = {}): StrategyProposalInput {
  return {
    planningTaskId, candidateId: 'a', title: 'Experiment proposal a', body: 'hypothesis a', rationaleRefs: [`task:${planningTaskId}`],
    experimentScope: { duration: { period: 'iso_week', weeks: 1 } }, proposedBy: agent, by: 'evaluator', ...extra,
  };
}

const count = (db: Db, sql: string) => Number(db.get<{ n: number }>(sql)!.n);

function recordAndPropose(db: Db, clock: FakeClock, planningTaskId: string, agent: string) {
  return db.writeTx((tx) => {
    const comparison = recordStrategyComparison(tx, clock, { planningTaskId, record: recommended('a'), by: 'evaluator' });
    return { comparison, proposal: proposeStrategyVersion(tx, clock, proposal(planningTaskId, agent)) };
  });
}

test('a recommended candidate becomes one proposed strategy_version; running again adds nothing (idempotent on planning task + candidate)', (t) => {
  const { db, clock, agent, planningTaskId } = rig(t);
  const first = recordAndPropose(db, clock, planningTaskId, agent);
  assert.deepEqual([first.comparison.created, first.proposal.created], [true, true]);
  assert.equal(first.proposal.strategyVersionId, strategyProposalId(planningTaskId, 'a'));
  for (let i = 0; i < 3; i += 1) {
    const again = recordAndPropose(db, clock, planningTaskId, agent);
    assert.deepEqual([again.comparison.created, again.proposal.created, again.proposal.strategyVersionId], [false, false, first.proposal.strategyVersionId]);
  }
  assert.equal(count(db, 'SELECT count(*) AS n FROM strategy_version'), 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM event WHERE type = 'experiment.compared'"), 1);
  const row = db.get<{ status: string; created_by: string; rationale_refs: string; experiment_scope: string; parent_id: string | null }>('SELECT * FROM strategy_version')!;
  assert.deepEqual([row.status, row.created_by, row.parent_id], ['proposed', agent, null]);
  assert.deepEqual(JSON.parse(row.rationale_refs), [`task:${planningTaskId}`]);
  assert.deepEqual(JSON.parse(row.experiment_scope), { duration: { period: 'iso_week', weeks: 1 } });
  assert.equal(strategyProposalId(planningTaskId, 'b') === strategyProposalId(planningTaskId, 'a'), false);
  assert.deepEqual(findStrategyComparison(db, planningTaskId)?.record, recommended('a'));
});

test('no proposal without a comparison record, or for a candidate the comparison did not recommend', (t) => {
  const { db, clock, agent, planningTaskId } = rig(t);
  assert.throws(() => db.writeTx((tx) => proposeStrategyVersion(tx, clock, proposal(planningTaskId, agent))), (e: unknown) => e instanceof StrategyRuleError && e.code === 'no_comparison');
  db.writeTx((tx) => recordStrategyComparison(tx, clock, { planningTaskId, record: recommended('b'), by: 'evaluator' }));
  assert.throws(() => db.writeTx((tx) => proposeStrategyVersion(tx, clock, proposal(planningTaskId, agent))), (e: unknown) => e instanceof StrategyRuleError && e.code === 'not_recommended');
  assert.equal(count(db, 'SELECT count(*) AS n FROM strategy_version'), 0);
});

test('a comparison without a recommendation is listed for a person to review; a recommended one is not', (t) => {
  const { db, clock, planningTaskId } = rig(t);
  const other = queuedTask(db, clock, { objective: 'another planning task' });
  db.writeTx((tx) => {
    recordStrategyComparison(tx, clock, { planningTaskId, record: recommended(null), by: 'evaluator' });
    recordStrategyComparison(tx, clock, { planningTaskId: other, record: recommended('a'), by: 'evaluator' });
  });
  assert.deepEqual(listStrategyReviews(db).map((r) => [r.planningTaskId, r.outcome, r.reasons]), [[planningTaskId, 'no_candidate', ['test']]]);
});

test('an agent can neither record a comparison, propose, nor transition a strategy_version', (t) => {
  const { db, clock, agent, planningTaskId } = rig(t);
  assert.throws(() => db.writeTx((tx) => recordStrategyComparison(tx, clock, { planningTaskId, record: recommended('a'), by: 'agent' })), (e: unknown) => e instanceof StrategyRuleError && e.code === 'agent_forbidden');
  recordAndPropose(db, clock, planningTaskId, agent);
  assert.throws(() => db.writeTx((tx) => proposeStrategyVersion(tx, clock, proposal(planningTaskId, agent, { candidateId: 'b', by: 'agent' }))), (e: unknown) => e instanceof StrategyRuleError && e.code === 'agent_forbidden');
  const id = strategyProposalId(planningTaskId, 'a');
  for (const to of ['experiment', 'active', 'rejected'] as const) {
    assert.throws(() => db.writeTx((tx) => transitionStrategyVersion(tx, { strategyVersionId: id, from: 'proposed', to, by: 'agent', approvalId: 'x' })), (e: unknown) => e instanceof TransitionError && e.code === 'agent_forbidden');
    // 사람 주체로 와도 행위자가 에이전트면 거부
    assert.throws(() => db.writeTx((tx) => transitionStrategyVersion(tx, { strategyVersionId: id, from: 'proposed', to, by: 'human', actorId: agent, approvalId: 'x' })), (e: unknown) => e instanceof StrategyRuleError && e.code === 'not_human');
  }
  assert.equal(db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [id])!.status, 'proposed');
});

test('transitions follow the allow table: proposed -> experiment needs a human approval of this row and an experiment_scope; only experiment -> rejected was added (A6-U16)', (t) => {
  const { db, clock, agent, planningTaskId } = rig(t);
  recordAndPropose(db, clock, planningTaskId, agent);
  const id = strategyProposalId(planningTaskId, 'a');
  const move = (extra: Partial<Parameters<typeof transitionStrategyVersion>[1]>) =>
    db.writeTx((tx) => transitionStrategyVersion(tx, { strategyVersionId: id, from: 'proposed', to: 'experiment', by: 'human', actorId: OWNER, ...extra }));
  assert.throws(() => move({}), (e: unknown) => e instanceof TransitionError && e.code === 'approval_required');
  assert.throws(() => move({ approvalId: 'approval-missing' }), (e: unknown) => e instanceof StrategyRuleError && e.code === 'approval_missing');
  assert.throws(() => move({ by: 'system', approvalId: 'approval-1' }), (e: unknown) => e instanceof TransitionError && e.code === 'actor_not_allowed');
  assert.throws(() => move({ from: 'proposed', to: 'retired' }), (e: unknown) => e instanceof TransitionError && e.code === 'not_allowed');
  db.writeTx((tx) => tx.run(
    "INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES ('approval-1', 'strategy_version', ?, 'approved', NULL, ?, NULL, ?)",
    [id, OWNER, clock.nowIso()],
  ));
  const moved = move({ approvalId: 'approval-1' });
  assert.equal(moved.status, 'experiment');
  assert.throws(() => move({ approvalId: 'approval-1' }), (e: unknown) => e instanceof StrategyRuleError && e.code === 'stale_state');
  // 허용표: (none) -> proposed 행은 없다(생성은 전이가 아니다). A6-U16 에서 experiment -> rejected 한 줄만 더해졌다(5 → 6)
  assert.equal(checkTransition(STRATEGY_MACHINE, { from: null, to: 'proposed', by: 'system' }).ok, false);
  assert.equal(STRATEGY_MACHINE.rules.length, 6);
});

test('experiment needs an experiment_scope even with an approval', (t) => {
  const { db, clock, agent, planningTaskId } = rig(t);
  recordAndPropose(db, clock, planningTaskId, agent);
  const id = strategyProposalId(planningTaskId, 'a');
  db.writeTx((tx) => {
    tx.run('UPDATE strategy_version SET experiment_scope = NULL WHERE id = ?', [id]); // 시험 준비: 범위 없는 행
    tx.run("INSERT INTO approval (id, subject_kind, subject_id, decision, decided_by, at) VALUES ('approval-2', 'strategy_version', ?, 'approved', ?, ?)", [id, OWNER, clock.nowIso()]);
  });
  assert.throws(
    () => db.writeTx((tx) => transitionStrategyVersion(tx, { strategyVersionId: id, from: 'proposed', to: 'experiment', by: 'human', actorId: OWNER, approvalId: 'approval-2' })),
    (e: unknown) => e instanceof StrategyRuleError && e.code === 'experiment_scope_required',
  );
  // rejected 는 승인 없이 사람이 할 수 있다
  assert.equal(db.writeTx((tx) => transitionStrategyVersion(tx, { strategyVersionId: id, from: 'proposed', to: 'rejected', by: 'human', actorId: OWNER })).status, 'rejected');
});

test('proposal fields are checked before anything is written', (t) => {
  const { db, clock, agent, planningTaskId } = rig(t);
  db.writeTx((tx) => recordStrategyComparison(tx, clock, { planningTaskId, record: recommended('a'), by: 'evaluator' }));
  const refused = (extra: Partial<StrategyProposalInput>, code: string) =>
    assert.throws(() => db.writeTx((tx) => proposeStrategyVersion(tx, clock, proposal(planningTaskId, agent, extra))), (e: unknown) => e instanceof StrategyRuleError && e.code === code);
  refused({ title: ' ' }, 'invalid_field');
  refused({ body: 'b'.repeat(2001) }, 'invalid_field');
  refused({ rationaleRefs: [] }, 'invalid_field');
  refused({ proposedBy: 'actor-ghost' }, 'unknown_actor');
  assert.throws(() => db.writeTx((tx) => recordStrategyComparison(tx, clock, { planningTaskId: 'task-ghost', record: recommended('a'), by: 'evaluator' })), (e: unknown) => e instanceof StrategyRuleError && e.code === 'unknown_task');
  assert.throws(() => db.writeTx((tx) => recordStrategyComparison(tx, clock, { planningTaskId, record: { outcome: 'recommended' }, by: 'evaluator' })), (e: unknown) => e instanceof StrategyRuleError && e.code === 'invalid_field');
  assert.equal(count(db, 'SELECT count(*) AS n FROM strategy_version'), 0);
});
