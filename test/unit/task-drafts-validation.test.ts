// 초안 run 의 검증 경로 (ADR-0015 W6): 독립 평가를 통과한 초안만 사람에게 간다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Db, FakeClock, TaskValidator } from '@aot/domain';
import { validateTask } from '@aot/task-engine';

import { draftRowFor, draftsOf, insertDraftRow } from '../support/drafts.ts';
import { taskStatus } from '../support/engine.ts';
import { recordEvaluation, submittedRun, transitionsOf, type SubmittedRun } from '../support/evaluation.ts';
import { seededDb } from '../support/seeded-db.ts';

type Outcome = 'pass' | 'fail' | 'inconclusive';

function stubValidator(db: Db): TaskValidator {
  return {
    validate: ({ spec, runId }) => {
      const row = db.get<{ id: string; outcome: Outcome; safety: 'pass' | 'fail' }>('SELECT id, outcome, safety FROM evaluation WHERE task_run_id = ?', [runId])!;
      return Promise.resolve({ evaluationId: row.id, outcome: row.outcome, safety: row.safety, humanRequired: spec.validation.human, reason: `stub ${row.outcome}` });
    },
  };
}

let n = 0;
function draftRun(db: Db, clock: FakeClock, outcome: Outcome, options: { safety?: 'pass' | 'fail'; human?: boolean; drafts?: number } = {}) {
  n += 1;
  const run = submittedRun(db, clock, {
    taskId: `task-draft-${n}`,
    spec: { validation: { deterministic: ['budget'], llm: null, human: options.human ?? false }, inputs: [{ name: 'n', ref: `r:draft:${n}`, kind: 'k' }] },
  });
  for (let i = 0; i < (options.drafts ?? 2); i += 1) insertDraftRow(db, draftRowFor(run.taskId, run.runId, { state: 'pending', seq: i + 1, request: { to: ['a@example.com'], subject: `s${i}`, text: 't' } }));
  recordEvaluation(db, clock, run, { outcome, ...(options.safety === undefined ? {} : { safety: options.safety }) });
  return run;
}

const validate = (db: Db, clock: FakeClock, run: SubmittedRun) => validateTask(db, { clock, validator: stubValidator(db), retryDelayMs: 5000 }, run.taskId);
const states = (db: Db, run: SubmittedRun) => draftsOf(db, run.taskId).map((d) => d.state);

test('pass + safety pass with drafts: validating -> needs_review (drafts_awaiting_approval) and the drafts become proposed', async (t) => {
  const { db, clock } = seededDb(t);
  const run = draftRun(db, clock, 'pass');
  assert.equal((await validate(db, clock, run))?.taskStatus, 'needs_review');
  assert.equal(taskStatus(db, run.taskId), 'needs_review');
  const last = transitionsOf(db, run.taskId).at(-1)!;
  assert.deepEqual([last.from_status, last.to_status, last.caused_by], ['validating', 'needs_review', 'system:validator']);
  assert.match(last.reason, /^drafts_awaiting_approval: 2 drafts/);
  assert.deepEqual(states(db, run), ['proposed', 'proposed']);
});

test('validation.human=true folds into the same single person step', async (t) => {
  const { db, clock } = seededDb(t);
  const run = draftRun(db, clock, 'pass', { human: true });
  assert.equal((await validate(db, clock, run))?.taskStatus, 'needs_review');
  assert.match(transitionsOf(db, run.taskId).at(-1)!.reason, /^drafts_awaiting_approval/);
  assert.deepEqual(states(db, run), ['proposed', 'proposed']);
});

test('fail with attempts left: retry_wait and the drafts are superseded', async (t) => {
  const { db, clock } = seededDb(t);
  const run = draftRun(db, clock, 'fail');
  assert.equal((await validate(db, clock, run))?.taskStatus, 'retry_wait');
  assert.deepEqual(states(db, run), ['superseded', 'superseded']);
});

test('inconclusive and a safety failure: needs_review as before, but the drafts are superseded (they cannot be approved)', async (t) => {
  const { db, clock } = seededDb(t);
  const inconclusive = draftRun(db, clock, 'inconclusive');
  assert.equal((await validate(db, clock, inconclusive))?.taskStatus, 'needs_review');
  assert.match(transitionsOf(db, inconclusive.taskId).at(-1)!.reason, /inconclusive/);
  assert.deepEqual(states(db, inconclusive), ['superseded', 'superseded']);
  const unsafe = draftRun(db, clock, 'fail', { safety: 'fail' });
  assert.equal((await validate(db, clock, unsafe))?.taskStatus, 'needs_review');
  assert.match(transitionsOf(db, unsafe.taskId).at(-1)!.reason, /safety failed/);
  assert.deepEqual(states(db, unsafe), ['superseded', 'superseded']);
});

test('a run without drafts validates exactly as before', async (t) => {
  const { db, clock } = seededDb(t);
  const run = draftRun(db, clock, 'pass', { drafts: 0 });
  assert.equal((await validate(db, clock, run))?.taskStatus, 'completed');
  assert.deepEqual(draftsOf(db, run.taskId), []);
});

test('only the validated run\'s pending drafts move; drafts of other runs are left alone', async (t) => {
  const { db, clock } = seededDb(t);
  const run = draftRun(db, clock, 'pass', { drafts: 1 });
  insertDraftRow(db, draftRowFor(run.taskId, run.runId, { state: 'rejected', seq: 9, request: { to: ['b@example.com'], subject: 'x', text: 'y' } }));
  await validate(db, clock, run);
  assert.deepEqual(states(db, run).sort(), ['proposed', 'rejected']);
});
