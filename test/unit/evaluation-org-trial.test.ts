// Phase B / B4: 조직 변경 시험 평가기 (packages/evaluation/src/org-trial.ts).
//  - 즉시 중단(안전성·예산) → fail, 통과율 미달 → fail, 기간 안 → pending, 관측 부족 → inconclusive, 최소 기간 전 → pending, 기준선 비교
//  - 에이전트 보고가 아니라 독립 평가 기록(evaluation)과 비용 원장만 본다; 기록은 멱등
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateOrgTrial, recordOrgTrialResult } from '@aot/evaluation';

import { routeUnassignedTasks } from '@aot/task-engine';

import { DAY, proposeAndStartTrial, seedTask } from '../support/org-trial.ts';

const evaluate = (env: ReturnType<typeof proposeAndStartTrial>) => evaluateOrgTrial(env.db, env.clock, env.proposal());
const pass = { status: 'completed', outcome: 'pass' } as const;

test('in progress: not enough observations before the evaluation period ends is pending (nothing recorded)', (t) => {
  const env = proposeAndStartTrial(t);
  env.task(pass);
  env.clock.advance(3 * DAY);
  const result = evaluate(env);
  assert.equal(result.verdict, 'pending');
  assert.equal(result.observations, 1);
  assert.equal(env.db.writeTx((tx) => recordOrgTrialResult(tx, env.clock, env.proposalId, result)), null);
});

test('a safety failure on any trial task is an immediate stop (fail, abort_reason=safety), even with few observations', (t) => {
  const env = proposeAndStartTrial(t);
  env.task(pass);
  env.task({ status: 'completed', outcome: 'pass', safety: 'fail' });
  const result = evaluate(env);
  assert.deepEqual({ verdict: result.verdict, abort: result.abortReason }, { verdict: 'fail', abort: 'safety' });
});

test('trial cost above the allowed budget is an immediate stop (fail, abort_reason=budget)', (t) => {
  const env = proposeAndStartTrial(t);
  env.task({ status: 'completed', outcome: 'pass', cost: 3 });
  env.task({ status: 'queued', cost: 2.5 });
  const result = evaluate(env);
  assert.deepEqual({ verdict: result.verdict, abort: result.abortReason }, { verdict: 'fail', abort: 'budget' });
  assert.equal(result.metrics['cost_usd'], 5.5);
});

test('a pass rate below the minimum fails as soon as the required observations exist', (t) => {
  const env = proposeAndStartTrial(t);
  env.task(pass);
  env.task({ status: 'failed' });
  env.task({ status: 'completed', outcome: 'fail' });
  const result = evaluate(env);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.abortReason, null);
  assert.equal(result.metrics['pass_rate'], 0.3333);
});

test('after the period with too few observations the result is inconclusive, never pass or fail by guesswork', (t) => {
  const env = proposeAndStartTrial(t);
  env.task(pass);
  env.task({ status: 'cancelled' });
  env.clock.advance(15 * DAY);
  const result = evaluate(env);
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.observations, 1);
  const id = env.db.writeTx((tx) => recordOrgTrialResult(tx, env.clock, env.proposalId, result));
  assert.ok(id);
  assert.equal(env.db.writeTx((tx) => recordOrgTrialResult(tx, env.clock, env.proposalId, result)), null, 'the same verdict is not recorded twice');
  const row = env.db.get<{ evaluator: string; outcome: string; observations: number }>('SELECT evaluator, outcome, observations FROM org_trial_result')!;
  assert.deepEqual({ ...row }, { evaluator: 'org-trial-evaluator@1', outcome: 'inconclusive', observations: 1 });
});

test('pass needs the minimum trial period: enough passing observations early are pending, and pass once the period is over', (t) => {
  const env = proposeAndStartTrial(t, { plan: { evaluation_days: 14 } });
  for (let i = 0; i < 3; i += 1) env.task(pass);
  env.clock.advance(5 * DAY);
  assert.equal(evaluate(env).verdict, 'pending');
  env.clock.advance(10 * DAY);
  const result = evaluate(env);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.metrics['baseline'], null, 'no executor existed before, so there is no baseline');
});

test('a baseline from before the trial is compared: a pass rate far below it fails even when above the minimum', (t) => {
  const env = proposeAndStartTrial(t, {
    plan: { min_pass_rate: 0.5 },
    before: ({ db, clock }) => {
      for (let i = 0; i < 3; i += 1) seedTask(db, clock, { status: 'completed', outcome: 'pass', role: 'generalist' });
      clock.advance(DAY);
    },
  });
  env.task(pass);
  env.task(pass);
  env.task({ status: 'completed', outcome: 'fail' });
  env.clock.advance(15 * DAY);
  const result = evaluate(env);
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.metrics['baseline'], { observations: 3, pass_rate: 1 });
});

test('the agent\'s own report is not evidence: a completed task without a passing independent evaluation does not count as passed', (t) => {
  const env = proposeAndStartTrial(t);
  env.task({ status: 'completed' });
  env.task({ status: 'completed' });
  env.task({ status: 'completed' });
  assert.equal(evaluate(env).verdict, 'fail');
});

test('only a running trial can be evaluated', (t) => {
  const env = proposeAndStartTrial(t);
  env.db.writeTx((tx) => tx.run("UPDATE org_proposal SET status = 'rolled_back' WHERE id = ?", [env.proposalId]));
  assert.throws(() => evaluate(env), /only a trial can be evaluated/);
});

test('review fixes: the unassigned backlog routed to the role counts as trial work (safety stop sees it), and a stale base rolls the trial back', (t) => {
  const backlog: string[] = [];
  const env = proposeAndStartTrial(t, { before: ({ db, clock }) => { backlog.push(seedTask(db, clock, {}), seedTask(db, clock, {})); clock.advance(DAY); } });
  env.db.writeTx((tx) => routeUnassignedTasks(tx, env.clock));
  assert.equal(env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task WHERE status = 'queued' AND role_id IS NOT NULL")!.n, 2);
  env.db.writeTx((tx) => {
    tx.run("UPDATE task SET status = 'completed' WHERE id = ?", [backlog[0]!]);
    tx.run(
      `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, agent_report_used, safety, evidence_refs, at)
       VALUES ('e1', ?, NULL, 'test-evaluator@1', 1, 'pass', '[]', 0, 'fail', '[]', ?)`, [backlog[0]!, env.clock.nowIso()],
    );
  });
  const unsafe = evaluate(env);
  assert.deepEqual({ verdict: unsafe.verdict, abort: unsafe.abortReason }, { verdict: 'fail', abort: 'safety' });

  env.db.writeTx((tx) => tx.run("UPDATE evaluation SET safety = 'pass'"));
  assert.notEqual(evaluate(env).verdict, 'fail');
  env.db.writeTx((tx) => {
    tx.run("UPDATE org_version SET status = 'retired' WHERE status = 'active'");
    tx.run("INSERT INTO org_version (id, parent_id, proposal_id, snapshot, status, created_at) VALUES ('org-version-other', NULL, NULL, '{}', 'active', ?)", [env.clock.nowIso()]);
  });
  const stale = evaluate(env);
  assert.equal(stale.verdict, 'fail');
  assert.match(stale.reason, /no longer active/);
});
