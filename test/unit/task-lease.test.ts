// lease·heartbeat·펜싱·만료 인수·재시도 (docs/operations/recovery.md §2·§4). 한 프로세스, 가짜 시계.
// 다중 프로세스 경쟁과 SIGKILL 은 test/integration/task-engine-*.test.ts 가 맡는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DENY_ALL_TASK_POLICY_GATE, type Db, type FakeClock } from '@aot/domain';
import {
  claimNextTask, failRun, findExpiredRuns, heartbeat, LeaseLostError, promoteDueRetries, saveCheckpoint, submitRun,
  takeOverExpiredRun, TaskWorker, transitionTask, type Lease, type TaskExecutor,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, manualTimers, queuedTask, runsOf, taskStatus } from '../support/engine.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const LEASE_MS = 60_000;

function setup(t: Parameters<typeof seededDb>[0]) {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  const claim = (workerId: string, taskId?: string) =>
    claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId, actorId, adapter: 'fake-adapter', leaseMs: LEASE_MS, ...(taskId === undefined ? {} : { taskId }) });
  return { db, clock, actorId, claim };
}

const mustClaim = (result: ReturnType<ReturnType<typeof setup>['claim']>): Lease => {
  assert.ok(result.claimed, 'expected a claim');
  return result.claimed.lease;
};

test('claim: queued -> running and task_run creation happen together; a second worker gets nothing', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock);
  const lease = mustClaim(claim('w1'));
  assert.equal(lease.taskId, taskId);
  assert.equal(lease.attempt, 1);
  assert.equal(taskStatus(db, taskId), 'running');
  const run = db.get<{ lease_owner: string; lease_expires_at: string; heartbeat_at: string }>('SELECT * FROM task_run WHERE id = ?', [lease.runId])!;
  assert.equal(run.lease_owner, 'w1');
  assert.equal(run.lease_expires_at, new Date(clock.nowMs() + LEASE_MS).toISOString());
  assert.equal(claim('w2').claimed, null);
});

test('claim: tasks whose dependencies are not completed wait', (t) => {
  const { db, clock, claim } = setup(t);
  const first = queuedTask(db, clock, { inputs: [{ name: 'a', ref: 'r:a', kind: 'k' }] }, 'task-first');
  const second = queuedTask(db, clock, { inputs: [{ name: 'b', ref: 'r:b', kind: 'k' }], dependencies: [first] });
  assert.equal(mustClaim(claim('w1')).taskId, first);
  assert.equal(claim('w1').claimed, null, `${second} must wait for ${first}`);
});

test('claim: the policy gate re-checks right before running; needs_review on refusal (default gate refuses)', (t) => {
  const { db, clock, actorId } = setup(t);
  const taskId = queuedTask(db, clock);
  const result = claimNextTask(db, { clock, gate: DENY_ALL_TASK_POLICY_GATE, workerId: 'w1', actorId, adapter: 'a', leaseMs: LEASE_MS });
  assert.equal(result.claimed, null);
  assert.deepEqual(result.sentToReview, [taskId]);
  assert.equal(taskStatus(db, taskId), 'needs_review');
  assert.equal(db.get('SELECT count(*) AS n FROM task_run')?.['n'], 0);
});

test('heartbeat extends the lease; once expired it is refused even if nobody took over', (t) => {
  const { db, clock, claim } = setup(t);
  queuedTask(db, clock);
  const lease = mustClaim(claim('w1'));
  clock.advance(LEASE_MS - 1);
  assert.equal(heartbeat(db, clock, lease), new Date(clock.nowMs() + LEASE_MS).toISOString());
  clock.advance(LEASE_MS);
  assert.throws(() => heartbeat(db, clock, lease), LeaseLostError);
});

test('takeover: the expired run is closed as lease_expired, the task goes back to queued without consuming an attempt, the next attempt resumes from the checkpoint', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock);
  const old = mustClaim(claim('w1'));
  saveCheckpoint(db, clock, old, { step: 2 });
  assert.deepEqual(findExpiredRuns(db, clock.nowIso()), []);

  clock.advance(LEASE_MS);
  const [expired] = findExpiredRuns(db, clock.nowIso());
  assert.ok(expired);
  const result = takeOverExpiredRun(db, expired, { clock, workerId: 'w2' });
  assert.deepEqual(result && { outcome: result.outcome, taskStatus: result.taskStatus }, { outcome: 'lease_expired', taskStatus: 'queued' });
  assert.equal(takeOverExpiredRun(db, expired, { clock, workerId: 'w3' }), null, 'a second recoverer does nothing');
  assert.equal(Number(db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts']), 0);

  const next = claim('w2').claimed;
  assert.ok(next);
  assert.equal(next.lease.attempt, 2);
  assert.deepEqual(next.checkpoint, { step: 2 });
  assert.deepEqual(runsOf(db, taskId).map((r) => [r.attempt, r.outcome, r.lease_owner]), [[1, 'lease_expired', 'w1'], [2, null, 'w2']]);
});

test('fencing: the old owner can write nothing after losing the lease, even under the same worker id', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock);
  const old = mustClaim(claim('w1'));
  clock.advance(LEASE_MS);
  takeOverExpiredRun(db, findExpiredRuns(db, clock.nowIso())[0]!, { clock, workerId: 'w1' });
  const fresh = mustClaim(claim('w1'));
  assert.notEqual(fresh.runId, old.runId);

  assert.throws(() => heartbeat(db, clock, old), LeaseLostError);
  assert.throws(() => saveCheckpoint(db, clock, old, {}), LeaseLostError);
  assert.throws(() => submitRun(db, clock, old, { late: true }), LeaseLostError);
  assert.throws(() => failRun(db, clock, old, { outcome: 'error', reason: 'late', retryDelayMs: 1 }), LeaseLostError);
  assert.equal(taskStatus(db, taskId), 'running');
  assert.equal(db.get('SELECT result FROM task_run WHERE id = ?', [old.runId])?.['result'], null);
  assert.deepEqual(submitRun(db, clock, fresh, { ok: true }), { outcome: 'submitted', taskStatus: 'validating' });
});

test('lease expiry can be configured to consume an attempt (policy parameter); it fails the task when attempts run out', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock);
  db.writeTx((tx) => tx.run('UPDATE task SET max_attempts = 2 WHERE id = ?', [taskId]));
  for (const expected of ['queued', 'failed']) {
    mustClaim(claim('w1'));
    clock.advance(LEASE_MS);
    const result = takeOverExpiredRun(db, findExpiredRuns(db, clock.nowIso())[0]!, { clock, workerId: 'w2', consumeAttempt: true });
    assert.equal(result?.taskStatus, expected);
  }
});

test('errors: retry_wait until next_run_at, then queued again; failed after max_attempts', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock);
  for (let i = 1; i <= 2; i += 1) {
    const lease = mustClaim(claim('w1'));
    assert.deepEqual(failRun(db, clock, lease, { outcome: i === 1 ? 'error' : 'timeout', reason: 'boom', retryDelayMs: 1000 }), {
      outcome: i === 1 ? 'error' : 'timeout', taskStatus: 'retry_wait',
    });
    clock.advance(999);
    assert.deepEqual(promoteDueRetries(db, clock), []);
    clock.advance(1);
    assert.deepEqual(promoteDueRetries(db, clock), [taskId]);
  }
  const last = mustClaim(claim('w1'));
  assert.deepEqual(failRun(db, clock, last, { outcome: 'error', reason: 'boom', retryDelayMs: 1000 }), { outcome: 'error', taskStatus: 'failed' });
  assert.equal(Number(db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts']), 3);
  const path = db.all<{ to_status: string }>('SELECT to_status FROM task_transition WHERE task_id = ? ORDER BY id', [taskId]).map((r) => r.to_status);
  assert.deepEqual(path, ['queued', 'running', 'retry_wait', 'queued', 'running', 'retry_wait', 'queued', 'running', 'failed']);
});

// ===== TaskWorker =====

function worker(db: Db, clock: FakeClock, actorId: string, executor: TaskExecutor, timers = manualTimers(), workerId = 'w1') {
  return {
    timers,
    worker: new TaskWorker({ db, clock, workerId, actorId, adapter: 'fake-adapter', executor, gate: ALLOW_ALL_GATE, timers, lease: { leaseMs: LEASE_MS, heartbeatMs: 15_000 } }),
  };
}

test('worker: a tick claims, executes and submits; heartbeats run while executing and stop after', async (t) => {
  const { db, clock, actorId } = setup(t);
  const taskId = queuedTask(db, clock);
  const timers = manualTimers();
  const { worker: w } = worker(db, clock, actorId, {
    async execute(context) {
      assert.equal(timers.active, 1);
      clock.advance(50_000);
      timers.fire();
      clock.advance(50_000); // 100초가 지났지만 50초 시점의 heartbeat 로 lease 가 살아 있다
      return { result: { summary: `done ${context.taskId}` } };
    },
  }, timers);
  const report = await w.tick();
  assert.deepEqual(report.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(timers.active, 0);
  assert.equal(taskStatus(db, taskId), 'validating');
});

test('worker: an executor error goes to retry_wait; with no gate configured the task goes to needs_review instead of running', async (t) => {
  const { db, clock, actorId } = setup(t);
  const taskId = queuedTask(db, clock);
  const { worker: w } = worker(db, clock, actorId, { execute: async () => { throw new Error('adapter crashed'); } });
  assert.deepEqual((await w.tick()).executed?.end, { outcome: 'error', taskStatus: 'retry_wait' });

  const other = queuedTask(db, clock, { inputs: [{ name: 'o', ref: 'r:o', kind: 'k' }] });
  const ungated = new TaskWorker({ db, clock, workerId: 'w9', actorId, adapter: 'a', executor: { execute: async () => ({ result: null }) }, timers: manualTimers() });
  const report = await ungated.tick();
  assert.equal(report.executed, null);
  assert.deepEqual(report.sentToReview, [other]);
  assert.equal(taskStatus(db, taskId), 'retry_wait');
});

test('worker: when a heartbeat finds the lease gone the executor is aborted and its result is not recorded', async (t) => {
  const { db, clock, actorId } = setup(t);
  const taskId = queuedTask(db, clock);
  let aborted = false;
  const { worker: w, timers } = worker(db, clock, actorId, {
    async execute(context) {
      clock.advance(LEASE_MS); // heartbeat 를 놓쳐 만료
      takeOverExpiredRun(db, findExpiredRuns(db, clock.nowIso())[0]!, { clock, workerId: 'w2' });
      timers.fire(); // 다음 heartbeat 가 lease 상실을 발견
      aborted = context.signal.aborted;
      assert.throws(() => context.saveCheckpoint({ late: true }), LeaseLostError);
      return { result: 'late result' };
    },
  });
  const report = await w.tick();
  assert.equal(aborted, true);
  assert.equal(report.executed?.end, 'lease_lost');
  assert.equal(taskStatus(db, taskId), 'queued');
  assert.deepEqual(runsOf(db, taskId).map((r) => r.outcome), ['lease_expired']);
});

test('worker restart: a new worker recovers the expired run in its first tick and runs a new attempt', async (t) => {
  const { db, clock, actorId, claim } = setup(t);
  const taskId = queuedTask(db, clock);
  mustClaim(claim('w-dead')); // 실행 중에 죽은 프로세스
  clock.advance(LEASE_MS + 1);
  let executions = 0;
  const { worker: w } = worker(db, clock, actorId, { execute: async () => (executions++, { result: 'ok' }) }, manualTimers(), 'w-restarted');
  const report = await w.tick();
  assert.deepEqual(report.recovered.map((r) => [r.taskId, r.outcome, r.taskStatus]), [[taskId, 'lease_expired', 'queued']]);
  assert.equal(report.executed?.attempt, 2);
  assert.equal(executions, 1);
  assert.equal(taskStatus(db, taskId), 'validating');
});

test('transitions refuse a stale "from" status (compare-and-set)', (t) => {
  const { db, clock } = setup(t);
  const taskId = queuedTask(db, clock);
  assert.throws(() => db.writeTx((tx) => transitionTask(tx, { taskId, from: 'running', to: 'validating', by: 'scheduler', reason: 'x', now: clock.nowIso() })), /no longer 'running'/);
});
