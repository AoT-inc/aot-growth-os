// A5 U4: 실행 관리가 run 을 죽일 때의 업무 엔진 쪽 (killRun, RunKilledError, recordRunOutput). 기존 전이 허용표 안에서만 움직이는지 본다:
//  deferred => run killed, 업무 retry_wait 인데 시도를 소모하지 않는다(실패 아님; 시도가 다 지나도 failed 가 되지 않는다).
//  time_limit => run killed, 업무 retry_wait(시도 소모) / 소진되면 failed.  budget_exceeded => run killed, 업무 needs_review(시도 소모 없음).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_TIME_LIMIT_MS, parseTimeLimit, validateTaskSpec } from '@aot/domain';
import {
  claimNextTask, findExpiredRuns, killRun, LeaseLostError, promoteDueRetries, recordRunOutput, RunKilledError, takeOverExpiredRun, TaskWorker,
  type Lease, type TaskExecutor,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, manualTimers, queuedTask, runsOf, taskStatus } from '../support/engine.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';
import { minimalDraft } from '../support/spec-fixtures.ts';

const LEASE_MS = 60_000;

function setup(t: Parameters<typeof seededDb>[0]) {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  const claim = (taskId: string): Lease => {
    const result = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: 'w1', actorId, adapter: 'fake-adapter', leaseMs: LEASE_MS, taskId });
    assert.ok(result.claimed);
    return result.claimed.lease;
  };
  return { db, clock, actorId, claim };
}

const attemptsOf = (db: ReturnType<typeof setup>['db'], taskId: string): number => Number(db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts']);
const lastTransition = (db: ReturnType<typeof setup>['db'], taskId: string) =>
  db.get<{ from_status: string; to_status: string; reason: string; caused_by: string }>('SELECT * FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!;

test('time_limit kill: run killed, the attempt is used up, retry_wait; the last attempt ends failed', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-time');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const lease = claim(taskId);
    const end = killRun(db, clock, lease, { reason: 'time_limit', detail: 'time limit 30m exceeded', retryDelayMs: 1000 });
    assert.deepEqual(end, { outcome: 'killed', taskStatus: attempt < 3 ? 'retry_wait' : 'failed' });
    assert.equal(attemptsOf(db, taskId), attempt);
    assert.ok(db.get('SELECT ended_at FROM task_run WHERE id = ?', [lease.runId])?.['ended_at']);
    if (attempt < 3) {
      clock.advance(1000);
      promoteDueRetries(db, clock);
    }
  }
  assert.deepEqual(runsOf(db, taskId).map((r) => r.outcome), ['killed', 'killed', 'killed']);
  assert.match(lastTransition(db, taskId).reason, /killed: time_limit: time limit 30m exceeded \(attempts exhausted\)/);
});

test('review_required kill: run killed and the task goes to needs_review without using an attempt (a retry would hit the same login/limit condition)', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-review');
  const lease = claim(taskId);
  const end = killRun(db, clock, lease, { reason: 'review_required', detail: 'usage_limit: the usage limit was reached', retryDelayMs: 1000 });
  assert.deepEqual(end, { outcome: 'killed', taskStatus: 'needs_review' });
  assert.equal(taskStatus(db, taskId), 'needs_review');
  assert.equal(attemptsOf(db, taskId), 0);
  const last = lastTransition(db, taskId);
  assert.equal(last.caused_by, 'system:scheduler');
  assert.match(last.reason, /killed: review_required: usage_limit: the usage limit was reached/);
});

test('deferred kill: run killed, the task waits in retry_wait for the defer delay without using an attempt, however many times it is deferred', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-deferred');
  const maxAttempts = Number(db.get('SELECT max_attempts FROM task WHERE id = ?', [taskId])?.['max_attempts']);
  for (let round = 1; round <= maxAttempts + 2; round += 1) {
    const lease = claim(taskId);
    const end = killRun(db, clock, lease, { reason: 'deferred', detail: 'usage_deferred: the five_hour window is above 0.7', retryDelayMs: 1000, deferDelayMs: 900_000 });
    assert.deepEqual(end, { outcome: 'killed', taskStatus: 'retry_wait' }, `round ${round}`);
    assert.equal(attemptsOf(db, taskId), 0, 'a deferral is not a failed attempt');
    assert.equal(db.get('SELECT next_run_at FROM task WHERE id = ?', [taskId])?.['next_run_at'], new Date(clock.nowMs() + 900_000).toISOString());
    const last = lastTransition(db, taskId);
    assert.equal(last.caused_by, 'system:scheduler');
    assert.match(last.reason, /killed: deferred: usage_deferred/);
    clock.advance(899_999);
    assert.equal(promoteDueRetries(db, clock).length, 0, 'not yet due');
    clock.advance(1);
    assert.equal(promoteDueRetries(db, clock).length, 1, 'due after exactly the defer delay');
    assert.equal(taskStatus(db, taskId), 'queued');
  }
  assert.deepEqual(runsOf(db, taskId).map((r) => r.outcome), Array.from({ length: maxAttempts + 2 }, () => 'killed'));
});

test('deferred kill without deferDelayMs waits retryDelayMs', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-deferred-default');
  const end = killRun(db, clock, claim(taskId), { reason: 'deferred', detail: 'usage_deferred: test', retryDelayMs: 1000 });
  assert.deepEqual(end, { outcome: 'killed', taskStatus: 'retry_wait' });
  assert.equal(db.get('SELECT next_run_at FROM task WHERE id = ?', [taskId])?.['next_run_at'], new Date(clock.nowMs() + 1000).toISOString());
});

test('budget kill: run killed and the task goes to needs_review without using an attempt (a retry would hit the same budget)', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-budget');
  const lease = claim(taskId);
  const end = killRun(db, clock, lease, { reason: 'budget_exceeded', detail: 'spent 1.2 USD exceeds the budget 1 USD', retryDelayMs: 1000 });
  assert.deepEqual(end, { outcome: 'killed', taskStatus: 'needs_review' });
  assert.equal(taskStatus(db, taskId), 'needs_review');
  assert.equal(attemptsOf(db, taskId), 0);
  const last = lastTransition(db, taskId);
  assert.equal(last.caused_by, 'system:scheduler');
  assert.match(last.reason, /budget_exceeded: spent 1\.2 USD exceeds the budget 1 USD/);
});

test('killRun is fenced: a run that lost its lease cannot be killed (nor can anything else be written for it)', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-fenced');
  const lease = claim(taskId);
  clock.advance(LEASE_MS);
  takeOverExpiredRun(db, findExpiredRuns(db, clock.nowIso())[0]!, { clock, workerId: 'w2' });
  for (const reason of ['time_limit', 'budget_exceeded'] as const) {
    assert.throws(() => killRun(db, clock, lease, { reason, detail: 'late', retryDelayMs: 1 }), LeaseLostError, reason);
  }
  assert.throws(() => recordRunOutput(db, clock, lease, { evidence: [], runLogRef: 'run-log:x' }), LeaseLostError);
  assert.equal(taskStatus(db, taskId), 'queued', 'the takeover result stands');
  assert.equal(db.get('SELECT run_log_ref FROM task_run WHERE id = ?', [lease.runId])?.['run_log_ref'], null);
});

test('recordRunOutput stores evidence rows (unverified) and run_log_ref on the run, in one transaction; the trust origin is always external_untrusted (host-enforced, A5-U8)', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-output');
  const lease = claim(taskId);
  let n = 0;
  recordRunOutput(db, clock, lease, {
    evidence: [
      { kind: 'source_url', ref: 'https://docs.example.com/a', capturedAt: clock.nowIso(), contentHash: 'sha256:abc' },
      // 호출자가 (형식을 어기고) trustOrigin 을 실어 보내도 저장에 닿지 않는다: 이 함수는 신뢰 출처를 인자로 받지 않는다
      { kind: 'run_log', ref: `run-log:${lease.runId}`, capturedAt: clock.nowIso(), ...{ trustOrigin: 'internal' } },
    ],
    runLogRef: `run-log:${lease.runId}`,
  }, () => `ev-test-${(n += 1)}`);
  const rows = db.all<{ id: string; kind: string; ref: string; content_hash: string | null; trust_origin: string; verified: number; task_run_id: string }>('SELECT * FROM evidence WHERE task_id = ? ORDER BY id', [taskId]);
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.content_hash, r.trust_origin, Number(r.verified), r.task_run_id]), [['ev-test-1', 'source_url', 'sha256:abc', 'external_untrusted', 0, lease.runId], ['ev-test-2', 'run_log', null, 'external_untrusted', 0, lease.runId]]);
  assert.equal(db.get('SELECT run_log_ref FROM task_run WHERE id = ?', [lease.runId])?.['run_log_ref'], `run-log:${lease.runId}`);
});

test('worker: an executor that throws RunKilledError ends the run as killed (the executor itself changes no state)', async (t) => {
  const { db, clock, actorId } = setup(t);
  const budgetTask = queuedTask(db, clock, {}, 'task-w-budget');
  const timeTask = queuedTask(db, clock, { inputs: [{ name: 'x', ref: 'r:x', kind: 'k' }] }, 'task-w-time');
  const reasons = ['budget_exceeded', 'time_limit'] as const;
  let call = 0;
  const executor: TaskExecutor = { execute: () => Promise.reject(new RunKilledError(reasons[call++]!, 'detail')) };
  const timers = manualTimers();
  const w = new TaskWorker({ db, clock, workerId: 'w1', actorId, adapter: 'fake-adapter', executor, gate: ALLOW_ALL_GATE, timers, retryDelayMs: 5000, lease: { leaseMs: LEASE_MS, heartbeatMs: 15_000 } });
  assert.deepEqual((await w.tick()).executed?.end, { outcome: 'killed', taskStatus: 'needs_review' });
  assert.deepEqual((await w.tick()).executed?.end, { outcome: 'killed', taskStatus: 'retry_wait' });
  assert.equal(taskStatus(db, budgetTask), 'needs_review');
  assert.equal(taskStatus(db, timeTask), 'retry_wait');
  assert.equal(timers.active, 0);
});

test('worker: a RunKilledError after the lease was lost is lease_lost; nothing is written', async (t) => {
  const { db, clock, actorId } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-w-lost');
  const timers = manualTimers();
  const w = new TaskWorker({
    db, clock, workerId: 'w1', actorId, adapter: 'fake-adapter', gate: ALLOW_ALL_GATE, timers, lease: { leaseMs: LEASE_MS, heartbeatMs: 15_000 },
    executor: {
      execute: () => {
        clock.advance(LEASE_MS);
        takeOverExpiredRun(db, findExpiredRuns(db, clock.nowIso())[0]!, { clock, workerId: 'w2' });
        return Promise.reject(new RunKilledError('time_limit', 'late'));
      },
    },
  });
  assert.equal((await w.tick()).executed?.end, 'lease_lost');
  assert.deepEqual(runsOf(db, taskId).map((r) => r.outcome), ['lease_expired']);
  assert.equal(taskStatus(db, taskId), 'queued');
});

test('time_limit text: whole number + s|m|h|d up to 7d; everything else is refused by the parser and by spec validation', () => {
  assert.equal(parseTimeLimit('30m'), 1_800_000);
  assert.equal(parseTimeLimit('45s'), 45_000);
  assert.equal(parseTimeLimit('2h'), 7_200_000);
  assert.equal(parseTimeLimit('7d'), MAX_TIME_LIMIT_MS);
  for (const bad of ['8d', '169h', '0m', '-1m', '1.5h', '30 m', ' 30m', '30M', '1h30m', '30', 'm', '', 30, null, undefined]) {
    assert.equal(parseTimeLimit(bad), null, String(bad));
  }
  const withLimit = (time_limit: unknown) => validateTaskSpec({ ...minimalDraft(), constraints: { time_limit } }, 'draft');
  assert.equal(withLimit('30m').ok, true);
  for (const bad of ['soon', '8d', '1.5h']) {
    const result = withLimit(bad);
    assert.equal(result.ok, false, bad);
    assert.ok(!result.ok && result.errors.some((e) => e.path === 'constraints.time_limit' && e.code === 'format'), bad);
  }
});
