// A2 필수 시험 (phase-a §3 "데몬 복구"·"중복 방지", recovery §7) — 같은 SQLite 파일을 여는 여러 데몬 프로세스로 수행한다.
// 시각은 부모가 자식마다 IPC 로 정한다(가짜 시계). 실제로 기다리지 않고 lease 만료를 만든다.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { applyMigrations, FakeClock, openDb, seedPhaseA, type Db } from '@aot/domain';

import { effectsOf, queuedTask, runsOf, taskStatus } from '../support/engine.ts';
import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';
import { addAgent } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const T0 = Date.parse('2026-10-19T00:00:00.000Z');
const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;

interface Env { dir: string; dbPath: string; db: Db; logPath: string; toolStore: string }

function engineDb(t: TestContext): Env {
  const dir = makeTempDir(t);
  const dbPath = join(dir, 'engine.db');
  const db = openDb({ path: dbPath });
  t.after(() => db.close());
  const clock = new FakeClock(T0);
  applyMigrations(db, { dir: MIGRATIONS_DIR, clock });
  seedPhaseA(db, { clock });
  addAgent(db, clock);
  return { dir, dbPath, db, logPath: join(dir, 'executions.log'), toolStore: join(dir, 'tool-deliveries.jsonl') };
}

function makeTasks(env: Env, count: number): string[] {
  const clock = new FakeClock(T0);
  return Array.from({ length: count }, (_, i) => queuedTask(env.db, clock, { inputs: [{ name: 'n', ref: `r:${i}`, kind: 'k' }] }, `task-${String(i).padStart(2, '0')}`));
}

type Message = { type: string; [key: string]: unknown };

class Daemon {
  readonly child: ChildProcess;
  readonly #inbox: Message[] = [];
  readonly #waiters: { type: string; resolve: (m: Message) => void }[] = [];
  readonly #exited: Promise<unknown>;

  constructor(t: TestContext, env: Env, id: string, config: Record<string, unknown>) {
    this.child = fork(new URL('./workers/engine-worker.ts', import.meta.url), [env.dbPath, id, JSON.stringify({
      logPath: env.logPath, toolStore: env.toolStore, leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS, ...config,
    })]);
    this.#exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.on('message', (raw) => {
      const message = raw as Message;
      if (message.type === 'error') throw new Error(`${id}: ${String(message['message'])}`);
      const waiter = this.#waiters.findIndex((w) => w.type === message.type);
      if (waiter >= 0) this.#waiters.splice(waiter, 1)[0]!.resolve(message);
      else this.#inbox.push(message);
    });
    t.after(() => this.kill());
  }

  next(type: string): Promise<Message> {
    const index = this.#inbox.findIndex((m) => m.type === type);
    if (index >= 0) return Promise.resolve(this.#inbox.splice(index, 1)[0]!);
    return new Promise((resolve) => this.#waiters.push({ type, resolve }));
  }

  async ready(): Promise<this> {
    await this.next('ready');
    return this;
  }

  tick(now: number): Promise<Message> {
    this.child.send({ cmd: 'tick', now });
    return this.next('tick');
  }

  drain(now: number): Promise<Message> {
    this.child.send({ cmd: 'drain', now });
    return this.next('drained');
  }

  continue(): void {
    this.child.send({ cmd: 'continue' });
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.#exited;
  }
}

const spawn = (t: TestContext, env: Env, id: string, config: Record<string, unknown>) => new Daemon(t, env, id, config).ready();

const logLines = (env: Env) => (existsSync(env.logPath) ? readFileSync(env.logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')) : []);
const deliveries = (env: Env) => (existsSync(env.toolStore) ? readFileSync(env.toolStore, 'utf8').trim().split('\n').filter(Boolean).length : 0);
type TickReport = { recovered: { taskId: string; outcome: string; taskStatus: string }[]; executed: { attempt: number; end: unknown } | null };
const reportOf = (message: Message) => message['report'] as TickReport;

test('two daemon processes race over 30 queued tasks: every task runs exactly once', async (t) => {
  const env = engineDb(t);
  const tasks = makeTasks(env, 30);
  const [a, b] = await Promise.all([spawn(t, env, 'daemon-a', { executor: 'complete' }), spawn(t, env, 'daemon-b', { executor: 'complete' })]);
  const [da, db] = await Promise.all([a.drain(T0), b.drain(T0)]);
  assert.equal(Number(da['executed']) + Number(db['executed']), tasks.length);

  const starts = logLines(env).filter(([kind]) => kind === 'start');
  assert.equal(starts.length, tasks.length, 'no task was executed twice');
  assert.deepEqual(new Set(starts.map(([, task]) => task)).size, tasks.length);
  for (const task of tasks) {
    assert.equal(taskStatus(env.db, task), 'validating', task);
    assert.deepEqual(runsOf(env.db, task).map((r) => [r.attempt, r.outcome]), [[1, 'submitted']], task);
  }
});

test('SIGKILL while running: the other daemon takes over only after the lease expires, as a new attempt, with no duplicate run', async (t) => {
  const env = engineDb(t);
  const [task] = makeTasks(env, 1);
  const a = await spawn(t, env, 'daemon-a', { executor: 'block' });
  const b = await spawn(t, env, 'daemon-b', { executor: 'complete' });
  const running = a.tick(T0);
  await a.next('blocked');
  await a.kill();
  void running;

  assert.equal(reportOf(await b.tick(T0 + LEASE_MS - 1)).executed, null, 'the lease is still valid: nothing to take over');
  assert.equal(taskStatus(env.db, task!), 'running');
  const report = reportOf(await b.tick(T0 + LEASE_MS));
  assert.deepEqual(report.recovered.map((r) => [r.taskId, r.outcome, r.taskStatus]), [[task, 'lease_expired', 'queued']]);
  assert.equal(report.executed?.attempt, 2);
  assert.deepEqual(runsOf(env.db, task!).map((r) => [r.attempt, r.outcome, r.lease_owner]), [[1, 'lease_expired', 'daemon-a'], [2, 'submitted', 'daemon-b']]);
  assert.deepEqual(logLines(env).map(([kind, , by, attempt]) => [kind, by, attempt]), [['start', 'daemon-a', '1'], ['start', 'daemon-b', '2'], ['done', 'daemon-b', '2']]);
  assert.equal(taskStatus(env.db, task!), 'validating');
});

test('daemon restart: the same daemon id restarted after SIGKILL recovers the run on its first tick', async (t) => {
  const env = engineDb(t);
  const [task] = makeTasks(env, 1);
  const first = await spawn(t, env, 'daemon-1', { executor: 'block' });
  void first.tick(T0);
  await first.next('blocked');
  await first.kill();

  const restarted = await spawn(t, env, 'daemon-1', { executor: 'complete' });
  const report = reportOf(await restarted.tick(T0 + LEASE_MS + 1));
  assert.deepEqual(report.recovered.map((r) => r.outcome), ['lease_expired']);
  assert.equal(report.executed?.attempt, 2);
  assert.deepEqual(runsOf(env.db, task!).map((r) => r.outcome), ['lease_expired', 'submitted']);
});

test('SIGKILL after an idempotent side effect was delivered but before it was recorded: the takeover confirms it by lookup, nothing is resent', async (t) => {
  const env = engineDb(t);
  const [task] = makeTasks(env, 1);
  const a = await spawn(t, env, 'daemon-a', { executor: 'effect', tool: 'idempotent', blockAfterDelivery: true });
  void a.tick(T0);
  await a.next('delivered');
  await a.kill();
  assert.deepEqual(effectsOf(env.db, task!).map((e) => e.state), ['dispatched']);
  assert.equal(deliveries(env), 1);

  const b = await spawn(t, env, 'daemon-b', { executor: 'effect', tool: 'idempotent' });
  const report = reportOf(await b.tick(T0 + LEASE_MS));
  assert.deepEqual(report.recovered.map((r) => [r.outcome, r.taskStatus]), [['lease_expired', 'queued']]);
  assert.equal(report.executed?.attempt, 2);
  assert.equal(deliveries(env), 1, 'one side effect in total');
  assert.deepEqual(effectsOf(env.db, task!).map((e) => e.state), ['confirmed']);
  assert.equal(taskStatus(env.db, task!), 'validating');
});

test('SIGKILL after a side effect on a tool without idempotency keys: no resend, run effect_unknown, task needs_review', async (t) => {
  const env = engineDb(t);
  const [task] = makeTasks(env, 1);
  const a = await spawn(t, env, 'daemon-a', { executor: 'effect', tool: 'plain', blockAfterDelivery: true });
  void a.tick(T0);
  await a.next('delivered');
  await a.kill();

  const b = await spawn(t, env, 'daemon-b', { executor: 'effect', tool: 'plain' });
  const report = reportOf(await b.tick(T0 + LEASE_MS));
  assert.deepEqual(report.recovered.map((r) => [r.outcome, r.taskStatus]), [['effect_unknown', 'needs_review']]);
  assert.equal(report.executed, null);
  for (let i = 1; i <= 3; i += 1) assert.equal(reportOf(await b.tick(T0 + LEASE_MS * (i + 1))).executed, null);
  assert.equal(deliveries(env), 1, 'never resent automatically');
  assert.deepEqual(effectsOf(env.db, task!).map((e) => e.state), ['unknown']);
  assert.deepEqual(runsOf(env.db, task!).map((r) => r.outcome), ['effect_unknown']);
  assert.equal(taskStatus(env.db, task!), 'needs_review');
});

test('a daemon that lost its lease while paused sends no side effect when it resumes', async (t) => {
  const env = engineDb(t);
  const [task] = makeTasks(env, 1);
  const a = await spawn(t, env, 'daemon-a', { executor: 'effect', tool: 'plain', blockBeforeEffect: true });
  const pending = a.tick(T0);
  await a.next('blocked');

  const b = await spawn(t, env, 'daemon-b', { executor: 'effect', tool: 'plain' });
  const taken = reportOf(await b.tick(T0 + LEASE_MS));
  assert.equal(taken.executed?.attempt, 2);
  assert.equal(deliveries(env), 1, 'the new owner sent it once');

  a.continue();
  const late = reportOf(await pending);
  assert.equal(late.executed?.end, 'lease_lost');
  assert.equal(deliveries(env), 1, 'the old owner sent nothing');
  assert.deepEqual(runsOf(env.db, task!).map((r) => [r.lease_owner, r.outcome]), [['daemon-a', 'lease_expired'], ['daemon-b', 'submitted']]);
  assert.deepEqual(effectsOf(env.db, task!).map((e) => e.state), ['confirmed']);
});
