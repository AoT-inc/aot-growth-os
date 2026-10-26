// A6-U16: 실험 결과 기록(evaluation `recordExperimentResult`)과 전략의 결정(domain `rejectExperiment`·`promoteExperiment`), 실험 주 계산(apps `experimentWeekOf`).
// 사이클 전체(검토 업무 생성 → 평가 → 기록 → 승격·거절)는 통합 시험 daemon-experiment-review.test.ts. 여기서는 규칙 하나하나를 손으로 만든 행으로 고정한다.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  findExperimentDecision, findExperimentResult, MemoryRuleError, promoteExperiment, recordExperimentReview, rejectExperiment, SEED_IDS, StrategyRuleError, TransitionError,
  type Db, type FakeClock, type MemoryItemRow,
} from '@aot/domain';
import { decisiveReviewEvaluation, experimentCost, ExperimentResultError, recordCost, recordExperimentResult } from '@aot/evaluation';
import { recordMeasurement } from '@aot/task-engine';

import { experimentWeekOf } from '../../apps/daemon/src/cycle.ts';
import { recordEvaluation, submittedRun, type SubmittedRun } from '../support/evaluation.ts';
import { PACK_SIGNAL } from '../support/measurement.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const OWNER = SEED_IDS.owner;
const W45_KEY = 'measurement:weekly-landing-conversions@2026-W45';
const W45_END = '2026-11-08T15:00:00.000Z';
const SHA = 'b'.repeat(64);

interface Rig {
  db: Db;
  clock: FakeClock;
  strategyId: string;
  run: SubmittedRun;
  agent: string;
}

/** 실험 전략 하나 + 결과 검토 업무(측정 근거가 붙은 제출된 run) + 검토 기록. 평가는 아직 없다 */
function rig(t: TestContext, options: { minutes?: number; passAtLeast?: number | null; baseline?: { week: string; value: number } | null } = {}): Rig {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  const strategyId = 'strategy-exp';
  db.writeTx((tx) => tx.run(
    "INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at) VALUES (?, NULL, 'exp', 'body', '[]', 'experiment', '{}', ?, ?)",
    [strategyId, agent, clock.nowIso()],
  ));
  clock.set(W45_END);
  recordMeasurement(db, { clock }, {
    actorId: OWNER, signal: PACK_SIGNAL, week: '2026-W45', value: 20, observations: 3, quality: 'good', attachments: [{ ref: 'file:/example/w45.png', sha256: SHA }],
    ...(options.minutes === undefined ? {} : { minutes: options.minutes }),
  });
  const run = submittedRun(db, clock, { spec: { inputs: [{ name: 'result', ref: W45_KEY, kind: 'measurement' }] } });
  db.writeTx((tx) => {
    tx.run('UPDATE task SET strategy_version_id = ? WHERE id = ?', [strategyId, run.taskId]);
    recordExperimentReview(tx, clock, {
      strategyVersionId: strategyId, reviewTaskId: run.taskId, experimentWeek: '2026-W45', signalId: PACK_SIGNAL.id,
      period: { start: '2026-11-01T15:00:00.000Z', end: W45_END, tz: 'Asia/Seoul' }, activatedAt: '2026-10-26T01:00:00.000Z',
      baseline: options.baseline === undefined ? { week: '2026-W43', value: 10 } : options.baseline,
      passAtLeast: options.passAtLeast === undefined ? 11 : options.passAtLeast, planningTaskId: null, by: 'evaluator',
    });
  });
  return { db, clock, strategyId, run, agent };
}

/** 같은 run 에 평가를 하나 더 넣는다 (한 평가기 = 한 행이라 평가기 이름을 바꾼다. 실제로는 재시도마다 새 run 의 평가다) */
function addEvaluation(r: Rig, id: string, outcome: 'pass' | 'fail' | 'inconclusive', safety: 'pass' | 'fail' = 'pass'): string {
  r.db.writeTx((tx) => tx.run(
    `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, agent_report_used, safety, evidence_refs, at)
     VALUES (?, ?, ?, ?, 0, ?, '["evidence:x"]', 0, ?, '[]', ?)`,
    [id, r.run.taskId, r.run.runId, `test-evaluator@${id}`, outcome, safety, r.clock.nowIso()],
  ));
  return id;
}

const record = (r: Rig, evaluationId: string, extra: Record<string, unknown> = {}) =>
  r.db.writeTx((tx) => recordExperimentResult(tx, r.clock, { strategyVersionId: r.strategyId, evaluationId, by: 'evaluator', ...extra }));
const items = (r: Rig): MemoryItemRow[] => r.db.all<MemoryItemRow>('SELECT * FROM memory_item ORDER BY kind');
const count = (db: Db, sql: string, params: string[] = []) => Number(db.get<{ n: number }>(sql, params)!.n);

test('pass: a measurement and a strategy_record are stored from original data; recording again changes nothing', (t) => {
  const r = rig(t);
  const evaluationId = recordEvaluation(r.db, r.clock, r.run, { outcome: 'pass' });
  const first = record(r, evaluationId);
  assert.equal(first.created, true);
  assert.deepEqual([first.result.conclusion, first.result.evaluationId], ['pass', evaluationId]);
  const stored = items(r);
  assert.deepEqual(stored.map((item) => [item.kind, item.verification_status, item.trust_origin, item.created_by, item.strategy_version_id]), [
    ['measurement', 'unverified', 'internal', OWNER, r.strategyId], // 평가 행에 효과 점수가 없어(effect NULL) 측정을 검증된 것으로 보지 않는다
    ['strategy_record', 'verified', 'internal', OWNER, r.strategyId],
  ]);
  for (const item of stored) assert.equal(item.observed_at, W45_END, 'observed_at is when the week ended, not when it was recorded');
  assert.deepEqual([first.result.measurementMemoryId, first.result.strategyRecordMemoryId].sort(), stored.map((item) => item.id).sort());
  const again = record(r, evaluationId);
  assert.deepEqual([again.created, again.result.eventId], [false, first.result.eventId]);
  assert.equal(items(r).length, 2);
  assert.equal(count(r.db, 'SELECT count(*) AS n FROM event WHERE type = ?', ['experiment.result_recorded']), 1);
});

test('the measurement is verified only when the evaluation measured the effect; the value is read from the person-entered event, not from the agent report', (t) => {
  const r = rig(t);
  const evaluationId = recordEvaluation(r.db, r.clock, r.run, { outcome: 'pass' });
  r.db.writeTx((tx) => tx.run('UPDATE evaluation SET effect = 20 WHERE id = ?', [evaluationId]));
  record(r, evaluationId);
  const measurement = items(r).find((item) => item.kind === 'measurement')!;
  assert.equal(measurement.verification_status, 'verified');
  assert.equal((JSON.parse(measurement.body) as { value: number }).value, 20);
});

test('an external_untrusted measurement evidence is stored only as an unverified hypothesis (rules 3 and 9); the strategy_record still comes from the evaluation', (t) => {
  const r = rig(t);
  r.db.writeTx((tx) => tx.run("UPDATE evidence SET trust_origin = 'external_untrusted' WHERE task_id = ? AND kind = 'measurement'", [r.run.taskId]));
  const evaluationId = recordEvaluation(r.db, r.clock, r.run, { outcome: 'pass' });
  record(r, evaluationId);
  assert.deepEqual(items(r).map((item) => [item.kind, item.verification_status, item.trust_origin]), [
    ['hypothesis', 'unverified', 'external_untrusted'],
    ['strategy_record', 'verified', 'internal'],
  ]);
});

test('fail is recorded too (the conclusion is fail); inconclusive writes nothing and is refused as inconclusive_not_learnable', (t) => {
  const r = rig(t);
  const inconclusive = addEvaluation(r, 'eval-inconclusive', 'inconclusive');
  assert.throws(() => record(r, inconclusive), (e: unknown) => e instanceof MemoryRuleError && e.code === 'inconclusive_not_learnable');
  assert.equal(items(r).length, 0);
  assert.equal(findExperimentResult(r.db, r.strategyId), null);
  const fail = addEvaluation(r, 'eval-fail', 'fail', 'fail');
  assert.equal(record(r, fail).result.conclusion, 'fail');
  assert.equal((JSON.parse(items(r).find((item) => item.kind === 'strategy_record')!.body) as { conclusion: string }).conclusion, 'fail');
});

test('refusals write nothing: an agent, a missing review, an evaluation of another task, an unknown evaluation, a missing measurement', (t) => {
  const r = rig(t);
  const evaluationId = recordEvaluation(r.db, r.clock, r.run, { outcome: 'pass' });
  const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ExperimentResultError ? e.code : String(e); } return 'no error'; };
  assert.equal(codeOf(() => record(r, evaluationId, { by: 'agent' })), 'agent_forbidden');
  assert.equal(codeOf(() => record(r, 'eval-missing')), 'unknown_evaluation');
  assert.equal(codeOf(() => r.db.writeTx((tx) => recordExperimentResult(tx, r.clock, { strategyVersionId: 'strategy-other', evaluationId, by: 'evaluator' }))), 'no_review');
  const other = submittedRun(r.db, r.clock, { spec: { objective: 'another task', inputs: [{ name: 'x', ref: 'r:x', kind: 'k' }] } });
  const otherEvaluation = recordEvaluation(r.db, r.clock, other, { outcome: 'pass' });
  assert.equal(codeOf(() => record(r, otherEvaluation)), 'not_review_evaluation');
  r.db.writeTx((tx) => tx.run("DELETE FROM event WHERE idempotency_key = ?", [W45_KEY]));
  assert.equal(codeOf(() => record(r, evaluationId)), 'no_measurement');
  assert.equal(items(r).length, 0);
  assert.equal(findExperimentResult(r.db, r.strategyId), null);
});

test('the default validity (policy parameter memory.default_validity) applies to both items; without it nothing expires', (t) => {
  const r = rig(t);
  const evaluationId = recordEvaluation(r.db, r.clock, r.run, { outcome: 'pass' });
  record(r, evaluationId);
  assert.deepEqual(items(r).map((item) => item.valid_until), [null, null]);
  const r2 = rig(t);
  const evaluation2 = recordEvaluation(r2.db, r2.clock, r2.run, { outcome: 'pass' });
  record(r2, evaluation2, { defaultValiditySeconds: () => 86_400 });
  assert.deepEqual(items(r2).map((item) => item.valid_until), ['2026-11-09T15:00:00.000Z', '2026-11-09T15:00:00.000Z']);
});

test('the experiment cost is the ledger sum of the experiment tasks plus the human time that could not be attached to a task; no row is counted twice', (t) => {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  db.writeTx((tx) => tx.run(
    "INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at) VALUES ('s1', NULL, 'exp', 'b', '[]', 'experiment', '{}', ?, ?)",
    [agent, clock.nowIso()],
  ));
  clock.set(W45_END);
  // 값이 먼저 입력되고 검토 업무가 나중에 생긴다: 사람 시간(분)은 붙일 업무가 없어 task_id 없이 남는다
  recordMeasurement(db, { clock }, { actorId: OWNER, signal: PACK_SIGNAL, week: '2026-W45', value: 20, observations: 3, quality: 'good', attachments: [{ ref: 'file:/x', sha256: SHA }], minutes: 20 });
  const a = submittedRun(db, clock, { taskId: 'task-a', spec: { objective: 'experiment task', inputs: [{ name: 'i', ref: 'r:a', kind: 'k' }] } });
  const b = submittedRun(db, clock, { taskId: 'task-b', spec: { objective: 'review task', inputs: [{ name: 'result', ref: W45_KEY, kind: 'measurement' }] } });
  const unrelated = submittedRun(db, clock, { taskId: 'task-c', spec: { objective: 'another strategy', inputs: [{ name: 'i', ref: 'r:c', kind: 'k' }] } });
  db.writeTx((tx) => {
    tx.run("UPDATE task SET strategy_version_id = 's1' WHERE id IN ('task-a', 'task-b')");
    recordCost(tx, clock, { taskId: a.taskId, taskRunId: a.runId, category: 'tool', amountUsd: 0.125 });
    recordCost(tx, clock, { taskId: a.taskId, taskRunId: null, category: 'llm', amountUsd: 0.25, units: { tokens: 1000 } });
    recordCost(tx, clock, { taskId: b.taskId, taskRunId: b.runId, category: 'llm', amountUsd: 0.5, units: { tokens: 500 } });
    recordCost(tx, clock, { taskId: unrelated.taskId, taskRunId: unrelated.runId, category: 'tool', amountUsd: 9 });
  });
  const cost = experimentCost(db, 's1', W45_KEY);
  assert.deepEqual([cost.total_usd, cost.human_minutes, cost.tokens, cost.by_category.tool, cost.by_category.llm], [0.875, 20, 1500, 0.125, 0.75]);
  assert.deepEqual(cost.task_ids.sort(), ['task-a', 'task-b']);
  const ledger = Number(db.get<{ s: number }>("SELECT sum(amount_usd) AS s FROM cost_entry WHERE task_id IN ('task-a', 'task-b') OR (task_id IS NULL AND json_extract(units, '$.measurement') = ?)", [W45_KEY])!.s);
  assert.equal(cost.total_usd, ledger);
  assert.equal(cost.entries, 4, 'three task rows and the unattached human_time row');
});

test('decisiveReviewEvaluation: a pass decides; a fail decides only when the task will not try again; inconclusive and none never decide', (t) => {
  const r = rig(t);
  const setStatus = (status: string) => r.db.writeTx((tx) => tx.run('UPDATE task SET status = ? WHERE id = ?', [status, r.run.taskId]));
  assert.equal(decisiveReviewEvaluation(r.db, r.run.taskId), null);
  addEvaluation(r, 'eval-1', 'fail');
  for (const status of ['retry_wait', 'queued', 'running', 'validating']) {
    setStatus(status);
    assert.equal(decisiveReviewEvaluation(r.db, r.run.taskId), null, status);
  }
  for (const status of ['needs_review', 'failed', 'cancelled']) {
    setStatus(status);
    assert.equal(decisiveReviewEvaluation(r.db, r.run.taskId)?.id, 'eval-1', status);
  }
  r.clock.advance(1_000);
  addEvaluation(r, 'eval-2', 'inconclusive');
  assert.equal(decisiveReviewEvaluation(r.db, r.run.taskId), null);
  r.clock.advance(1_000);
  addEvaluation(r, 'eval-3', 'pass');
  setStatus('retry_wait');
  assert.equal(decisiveReviewEvaluation(r.db, r.run.taskId)?.id, 'eval-3', 'the latest evaluation decides, even over an earlier fail');
});

test('rejectExperiment: experiment -> rejected, a reason is required, an agent cannot, a person needs a human actor, and only an experiment can be rejected', (t) => {
  const r = rig(t);
  const reject = (extra: Record<string, unknown>) => r.db.writeTx((tx) => rejectExperiment(tx, r.clock, { strategyVersionId: r.strategyId, by: 'human', actorId: OWNER, reason: 'no good', ...extra } as never));
  assert.throws(() => reject({ by: 'agent' }), (e: unknown) => e instanceof StrategyRuleError && e.code === 'agent_forbidden');
  assert.throws(() => reject({ reason: '  ' }), (e: unknown) => e instanceof StrategyRuleError && e.code === 'reason_required');
  assert.throws(() => reject({ actorId: r.agent }), (e: unknown) => e instanceof StrategyRuleError && e.code === 'not_human');
  assert.throws(() => reject({ actorId: undefined }), (e: unknown) => e instanceof StrategyRuleError && e.code === 'unknown_actor');
  assert.equal(count(r.db, "SELECT count(*) AS n FROM strategy_version WHERE status = 'rejected'"), 0);
  assert.equal(findExperimentDecision(r.db, r.strategyId), null);
  assert.equal(reject({}).status, 'rejected');
  assert.deepEqual(findExperimentDecision(r.db, r.strategyId) && [findExperimentDecision(r.db, r.strategyId)!.decision, findExperimentDecision(r.db, r.strategyId)!.reason], ['rejected', 'no good']);
  assert.throws(() => reject({}), (e: unknown) => e instanceof StrategyRuleError && e.code === 'stale_state');
  // 시스템(평가기)은 사람 확인 없이 거절할 수 있다
  const r2 = rig(t);
  assert.equal(r2.db.writeTx((tx) => rejectExperiment(tx, r2.clock, { strategyVersionId: r2.strategyId, by: 'evaluator', reason: 'the review failed' })).status, 'rejected');
  assert.equal(findExperimentDecision(r2.db, r2.strategyId)?.by, 'evaluator');
  // proposed 였던 전략은 이 함수로 거절하지 않는다 (승인 엔진의 reject)
  r2.db.writeTx((tx) => tx.run("INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at) VALUES ('p1', NULL, 't', 'b', '[]', 'proposed', '{}', ?, ?)", [r2.agent, r2.clock.nowIso()]));
  assert.throws(() => r2.db.writeTx((tx) => rejectExperiment(tx, r2.clock, { strategyVersionId: 'p1', by: 'human', actorId: OWNER, reason: 'x' })), (e: unknown) => e instanceof StrategyRuleError && e.code === 'stale_state');
});

test('promoteExperiment: only a person, only after a recorded pass (evaluation pass AND safety pass), with a reason; the previous active strategy is retired; fail and missing results are refused', (t) => {
  const r = rig(t);
  const promote = (extra: Record<string, unknown> = {}) => r.db.writeTx((tx) => promoteExperiment(tx, r.clock, { strategyVersionId: r.strategyId, actorId: OWNER, reason: 'beat the line', ...extra }));
  assert.throws(() => promote(), (e: unknown) => e instanceof StrategyRuleError && e.code === 'no_result');
  const evaluationId = recordEvaluation(r.db, r.clock, r.run, { outcome: 'pass' });
  record(r, evaluationId);
  assert.throws(() => promote({ actorId: r.agent }), (e: unknown) => e instanceof StrategyRuleError && e.code === 'not_human');
  assert.throws(() => promote({ reason: '' }), (e: unknown) => e instanceof StrategyRuleError && e.code === 'reason_required');
  // 기록된 결과가 pass 라도 평가 행이 pass AND safety pass 가 아니면 승격하지 않는다 (방어)
  r.db.writeTx((tx) => tx.run("UPDATE evaluation SET safety = 'fail' WHERE id = ?", [evaluationId]));
  assert.throws(() => promote(), (e: unknown) => e instanceof StrategyRuleError && e.code === 'not_passed');
  r.db.writeTx((tx) => tx.run("UPDATE evaluation SET safety = 'pass' WHERE id = ?", [evaluationId]));
  r.db.writeTx((tx) => tx.run("INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at) VALUES ('old', NULL, 'old', 'b', '[]', 'active', NULL, ?, ?)", [r.agent, r.clock.nowIso()]));
  const promoted = promote();
  assert.deepEqual([promoted.strategy.status, promoted.retired], ['active', ['old']]);
  assert.equal(r.db.get<{ status: string }>("SELECT status FROM strategy_version WHERE id = 'old'")!.status, 'retired');
  assert.throws(() => promote(), (e: unknown) => e instanceof StrategyRuleError && e.code === 'stale_state' || e instanceof TransitionError);

  // fail 로 기록된 결과는 승격할 수 없다
  const f = rig(t);
  record(f, recordEvaluation(f.db, f.clock, f.run, { outcome: 'fail' }));
  assert.throws(() => f.db.writeTx((tx) => promoteExperiment(tx, f.clock, { strategyVersionId: f.strategyId, actorId: OWNER, reason: 'try' })), (e: unknown) => e instanceof StrategyRuleError && e.code === 'not_passed');
  assert.equal(f.db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [f.strategyId])!.status, 'experiment');
});

test('the experiment week is the first ISO week that starts at or after the activation, counted in the time zone of the signal', () => {
  // 서울(UTC+9): 2026-10-26 월요일 00:00 KST = 2026-10-25T15:00Z 가 W44 의 시작
  const seoul = (at: string) => experimentWeekOf(at, 'Asia/Seoul');
  assert.equal(seoul('2026-10-25T15:00:00.000Z'), '2026-W44', 'exactly at the start of a week: that week');
  assert.equal(seoul('2026-10-25T15:00:00.001Z'), '2026-W45', 'one millisecond later: the next week');
  assert.equal(seoul('2026-10-26T01:00:00.000Z'), '2026-W45', 'Monday 10:00 KST (the examples of this plan)');
  assert.equal(seoul('2026-10-25T14:59:59.999Z'), '2026-W44', 'Sunday 23:59:59.999 KST belongs to W43, so the next week starting at/after it is W44');
  // 같은 순간도 시간대가 다르면 주가 다르다 (UTC 로는 일요일 15:00 = W43 안)
  assert.equal(experimentWeekOf('2026-10-25T15:00:00.000Z', 'UTC'), '2026-W44');
  assert.equal(experimentWeekOf('2026-10-25T15:00:00.000Z', 'America/New_York'), '2026-W44');
  // 해 경계 (2026-W01 = 2025-12-29 시작, 2026 은 53주)
  assert.equal(experimentWeekOf('2025-12-28T12:00:00.000Z', 'UTC'), '2026-W01');
  assert.equal(experimentWeekOf('2026-12-28T00:00:00.000Z', 'UTC'), '2026-W53');
  assert.equal(experimentWeekOf('2026-12-28T00:00:01.000Z', 'UTC'), '2027-W01');
});
