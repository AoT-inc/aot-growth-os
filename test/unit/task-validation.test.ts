// 판정 → 업무 전이 (state-machines.md 업무 표의 validating 행, 사용자 결정 2026-10-21: 평가 inconclusive 는 needs_review).
// 검증기(evaluation)는 domain 의 TaskValidator 포트 뒤에 있고 task-engine 이 transitions 규칙대로 상태를 옮긴다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Db, FakeClock, TaskValidationVerdict, TaskValidator } from '@aot/domain';
import { nextValidatingTask, routeVerdict, TaskWorker, validateTask } from '@aot/task-engine';

import { ALLOW_ALL_GATE, manualTimers, taskStatus } from '../support/engine.ts';
import { recordEvaluation, submittedRun, transitionsOf, type SubmittedRun } from '../support/evaluation.ts';
import { seededDb } from '../support/seeded-db.ts';

type Outcome = 'pass' | 'fail' | 'inconclusive';

/** 기록된 평가를 그대로 돌려주는 검증기 */
function stubValidator(db: Db, calls: string[] = []): TaskValidator {
  return {
    validate: ({ task, spec, runId }) => {
      calls.push(task.id);
      const row = db.get<{ id: string; outcome: Outcome; safety: 'pass' | 'fail' }>('SELECT id, outcome, safety FROM evaluation WHERE task_run_id = ?', [runId])!;
      return Promise.resolve({ evaluationId: row.id, outcome: row.outcome, safety: row.safety, humanRequired: spec.validation.human, reason: `stub ${row.outcome}` });
    },
  };
}

function validating(db: Db, clock: FakeClock, outcome: Outcome, options: { safety?: 'pass' | 'fail'; human?: boolean; maxAttempts?: number; attempts?: number; taskId?: string } = {}) {
  const run = submittedRun(db, clock, {
    taskId: options.taskId ?? `task-${outcome}-${Math.random().toString(36).slice(2, 8)}`,
    spec: { validation: { deterministic: ['budget'], llm: null, human: options.human ?? false }, inputs: [{ name: 'n', ref: `r:${Math.random()}`, kind: 'k' }] },
  });
  if (options.maxAttempts !== undefined || options.attempts !== undefined) {
    db.writeTx((tx) => tx.run('UPDATE task SET max_attempts = ?, attempts = ? WHERE id = ?', [options.maxAttempts ?? 3, options.attempts ?? 0, run.taskId]));
  }
  recordEvaluation(db, clock, run, { outcome, ...(options.safety === undefined ? {} : { safety: options.safety }) });
  return run;
}

const validate = (db: Db, clock: FakeClock, run: SubmittedRun, validator = stubValidator(db)) => validateTask(db, { clock, validator, retryDelayMs: 5000 }, run.taskId);

test('pass with safety pass: validating -> completed, recorded as a validator transition', async (t) => {
  const { db, clock } = seededDb(t);
  const run = validating(db, clock, 'pass');
  const end = await validate(db, clock, run);
  assert.deepEqual(end, { taskId: run.taskId, runId: run.runId, evaluationId: `eval-${run.runId}`, taskStatus: 'completed' });
  assert.equal(taskStatus(db, run.taskId), 'completed');
  const last = transitionsOf(db, run.taskId).at(-1)!;
  assert.deepEqual([last.from_status, last.to_status, last.caused_by], ['validating', 'completed', 'system:validator']);
});

test('pass with validation.human=true goes to needs_review: a person confirms', async (t) => {
  const { db, clock } = seededDb(t);
  const run = validating(db, clock, 'pass', { human: true });
  assert.equal((await validate(db, clock, run))?.taskStatus, 'needs_review');
  assert.match(transitionsOf(db, run.taskId).at(-1)!.reason, /validation\.human=true/);
});

test('fail with attempts left: validating -> retry_wait; the attempt is consumed and next_run_at is set', async (t) => {
  const { db, clock } = seededDb(t);
  const run = validating(db, clock, 'fail', { attempts: 0, maxAttempts: 3 });
  assert.equal((await validate(db, clock, run))?.taskStatus, 'retry_wait');
  const task = db.get<{ attempts: number; next_run_at: string }>('SELECT attempts, next_run_at FROM task WHERE id = ?', [run.taskId])!;
  assert.equal(task.attempts, 1);
  assert.equal(task.next_run_at, new Date(clock.nowMs() + 5000).toISOString());
});

test('fail with no attempts left: validating cannot go to failed, so a person decides (needs_review)', async (t) => {
  const { db, clock } = seededDb(t);
  const run = validating(db, clock, 'fail', { attempts: 2, maxAttempts: 3 });
  assert.equal((await validate(db, clock, run))?.taskStatus, 'needs_review');
  assert.match(transitionsOf(db, run.taskId).at(-1)!.reason, /attempts are exhausted/);
});

test('inconclusive evaluation: validating -> needs_review (user decision 2026-10-21), not retry_wait and not completed', async (t) => {
  const { db, clock } = seededDb(t);
  const run = validating(db, clock, 'inconclusive');
  assert.equal((await validate(db, clock, run))?.taskStatus, 'needs_review');
  assert.match(transitionsOf(db, run.taskId).at(-1)!.reason, /inconclusive/);
  assert.equal(db.get('SELECT attempts FROM task WHERE id = ?', [run.taskId])?.['attempts'], 0, 'no attempt is consumed');
});

test('safety=fail never completes or retries automatically: needs_review', async (t) => {
  const { db, clock } = seededDb(t);
  const run = validating(db, clock, 'fail', { safety: 'fail' });
  assert.equal((await validate(db, clock, run))?.taskStatus, 'needs_review');
  assert.match(transitionsOf(db, run.taskId).at(-1)!.reason, /safety failed/);
});

test('routeVerdict is pure and refuses a contradictory verdict (pass with safety=fail)', () => {
  const verdict = (over: Partial<TaskValidationVerdict>): TaskValidationVerdict => ({ evaluationId: 'e', outcome: 'pass', safety: 'pass', humanRequired: false, reason: 'r', ...over });
  const task = { attempts: 0, max_attempts: 3 };
  assert.equal(routeVerdict(task, verdict({})).to, 'completed');
  assert.equal(routeVerdict(task, verdict({ outcome: 'fail' })).to, 'retry_wait');
  assert.equal(routeVerdict({ attempts: 2, max_attempts: 3 }, verdict({ outcome: 'fail' })).to, 'needs_review');
  assert.equal(routeVerdict(task, verdict({ outcome: 'inconclusive' })).to, 'needs_review');
  assert.throws(() => routeVerdict(task, verdict({ safety: 'fail' })), /inconsistent verdict/);
});

test('the engine checks the verdict against the recorded evaluation: a validator cannot complete a task on its own say-so', async (t) => {
  const { db, clock } = seededDb(t);
  const run = validating(db, clock, 'inconclusive');
  const lying: TaskValidator = { validate: () => Promise.resolve({ evaluationId: `eval-${run.runId}`, outcome: 'pass', safety: 'pass', humanRequired: false, reason: 'trust me' }) };
  await assert.rejects(validate(db, clock, run, lying), /differs from the recorded evaluation/);
  const phantom: TaskValidator = { validate: () => Promise.resolve({ evaluationId: 'eval-none', outcome: 'pass', safety: 'pass', humanRequired: false, reason: 'no row' }) };
  await assert.rejects(validate(db, clock, run, phantom), /not recorded for run/);
  assert.equal(taskStatus(db, run.taskId), 'validating', 'nothing moved');
});

test('only validating tasks are validated; a second validation of the same task finds nothing to do', async (t) => {
  const { db, clock } = seededDb(t);
  const calls: string[] = [];
  const run = validating(db, clock, 'pass');
  assert.ok(await validate(db, clock, run, stubValidator(db, calls)));
  assert.equal(await validate(db, clock, run, stubValidator(db, calls)), null);
  assert.deepEqual(calls, [run.taskId], 'the validator is not called for a task that left validating');
  assert.equal(nextValidatingTask(db), null);
});

test('a task already moved by another worker between validation and transition is skipped (compare-and-set)', async (t) => {
  const { db, clock } = seededDb(t);
  const run = validating(db, clock, 'pass');
  const racing: TaskValidator = {
    validate: async (request) => {
      const verdict = await stubValidator(db).validate(request);
      db.writeTx((tx) => tx.run("UPDATE task SET status = 'cancelled' WHERE id = ?", [run.taskId]));
      return verdict;
    },
  };
  assert.equal(await validate(db, clock, run, racing), null);
  assert.equal(taskStatus(db, run.taskId), 'cancelled');
});

test('worker tick: validates every pending task, reports errors per task and keeps going; no validator means validating tasks stay', async (t) => {
  const { db, clock } = seededDb(t);
  const good = validating(db, clock, 'pass');
  const inconclusive = validating(db, clock, 'inconclusive');
  const broken = validating(db, clock, 'pass');
  const validator = stubValidator(db);
  const flaky: TaskValidator = {
    validate: (request) => (request.task.id === broken.taskId ? Promise.reject(new Error('fetcher exploded')) : validator.validate(request)),
  };
  const options = { db, clock, workerId: 'w1', actorId: 'actor-agent-1', adapter: 'fake-adapter', gate: ALLOW_ALL_GATE, timers: manualTimers(), executor: { execute: () => Promise.reject(new Error('no execution')) } };

  const without = await new TaskWorker(options).tick();
  assert.deepEqual([without.validated, without.validationFailed], [[], []]);
  assert.equal(taskStatus(db, good.taskId), 'validating');

  const report = await new TaskWorker({ ...options, validator: flaky }).tick();
  assert.deepEqual(report.validated.map((v) => [v.taskId, v.taskStatus]).sort(), [[good.taskId, 'completed'], [inconclusive.taskId, 'needs_review']].sort());
  assert.deepEqual(report.validationFailed, [{ taskId: broken.taskId, error: 'fetcher exploded' }]);
  assert.equal(taskStatus(db, broken.taskId), 'validating', 'retried on the next tick');
});
