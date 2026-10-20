// memory-item 규칙 8 (A1 이월): `inconclusive` 평가 결과는 lesson/strategy_record 로 저장되지 않는다 (성공도 실패도 아님).
// 막는 지점은 domain 의 createMemoryItem 이다 (evaluation 은 domain 만 참조할 수 있다).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryItem, EVALUATION_SOURCE_PREFIX, MemoryRuleError, SEED_IDS, supersedeMemoryItem, type Db, type EvalOutcome, type FakeClock, type MemoryKind } from '@aot/domain';

import { submittedRun } from '../support/evaluation.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

function insertEvaluation(db: Db, clock: FakeClock, id: string, outcome: EvalOutcome, safety: 'pass' | 'fail' = 'pass'): void {
  const run = submittedRun(db, clock, { taskId: `task-${id}`, spec: { inputs: [{ name: id, ref: `r:${id}`, kind: 'k' }] } });
  db.writeTx((tx) => tx.run(
    `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, agent_report_used, safety, evidence_refs, at)
     VALUES (?, ?, ?, 'task-evaluator@v1', 1, ?, '[]', 0, ?, '[]', ?)`,
    [id, run.taskId, run.runId, outcome, safety, clock.nowIso()],
  ));
}

const memory = (kind: MemoryKind, evaluationId: string, extra: Record<string, unknown> = {}) => ({
  kind,
  body: '이 전략은 이번 주 시험에서 이런 결과였다',
  source_ref: `${EVALUATION_SOURCE_PREFIX}${evaluationId}`,
  observed_at: '2026-10-20T00:00:00Z',
  created_by: SEED_IDS.owner,
  ...extra,
});

const rejectsInconclusive = (error: unknown): boolean => error instanceof MemoryRuleError && error.code === 'inconclusive_not_learnable';

test('rule 8: an inconclusive evaluation is not stored as a lesson or a strategy_record, also through supersede', (t) => {
  const { db, clock } = seededDb(t);
  addAgent(db, clock);
  insertEvaluation(db, clock, 'eval-inconclusive', 'inconclusive');
  const context = { clock };
  for (const kind of ['lesson', 'strategy_record'] as const) {
    assert.throws(() => db.writeTx((tx) => createMemoryItem(tx, memory(kind, 'eval-inconclusive'), context)), rejectsInconclusive, kind);
  }
  assert.equal(db.get('SELECT count(*) AS n FROM memory_item')?.['n'], 0, 'nothing was written');
  // 대체 경로도 같은 규칙을 지난다
  const base = db.writeTx((tx) => createMemoryItem(tx, memory('strategy_record', 'eval-inconclusive', { source_ref: 'doc:strategy-notes' }), context));
  assert.throws(() => db.writeTx((tx) => supersedeMemoryItem(tx, base.id, memory('strategy_record', 'eval-inconclusive'), context)), rejectsInconclusive);
});

test('rule 8: pass and fail evaluations can be recorded as cases; a missing evaluation reference is refused; other kinds are not affected', (t) => {
  const { db, clock } = seededDb(t);
  insertEvaluation(db, clock, 'eval-pass', 'pass');
  insertEvaluation(db, clock, 'eval-fail', 'fail', 'fail');
  insertEvaluation(db, clock, 'eval-inconclusive', 'inconclusive');
  const context = { clock };
  db.writeTx((tx) => {
    createMemoryItem(tx, memory('strategy_record', 'eval-pass'), context);
    createMemoryItem(tx, memory('lesson', 'eval-fail'), context);
  });
  assert.throws(
    () => db.writeTx((tx) => createMemoryItem(tx, memory('lesson', 'eval-missing'), context)),
    (error: unknown) => error instanceof MemoryRuleError && error.code === 'invalid_field',
  );
  // 규칙 8 은 학습 기록(lesson/strategy_record)에 대한 것이다. 관측 기록은 출처만 있으면 된다.
  db.writeTx((tx) => createMemoryItem(tx, memory('measurement', 'eval-inconclusive'), context));
  assert.equal(db.get('SELECT count(*) AS n FROM memory_item')?.['n'], 3);
});
