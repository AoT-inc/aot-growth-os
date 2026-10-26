// A6-U9 필수 시험: 같은 SQLite 파일을 여는 두 데몬 프로세스가 같은 루틴 슬롯을 동시에 tick 해도 발화 1건·업무 1벌(템플릿의 업무 3개)이다.
// 시각은 부모가 자식마다 IPC 로 정한다(가짜 시계). 템플릿은 가짜 RoutineTemplateSource(의존 있는 업무 3개).
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { applyMigrations, FakeClock, openDb, SEED_IDS, seedPhaseA, type Db } from '@aot/domain';

import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';
import { addAgent } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const T0 = Date.parse('2026-10-15T00:00:00.000Z');
const MONDAYS = ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'].map((day) => `${day}T00:00:00.000Z`); // 09:00 Asia/Seoul

interface Env { dbPath: string; db: Db; logPath: string }

function engineDb(t: TestContext, routine: { catchUp: 'skip' | 'run_once' }): Env {
  const dir = makeTempDir(t);
  const dbPath = join(dir, 'engine.db');
  const db = openDb({ path: dbPath });
  t.after(() => db.close());
  const clock = new FakeClock(T0);
  applyMigrations(db, { dir: MIGRATIONS_DIR, clock });
  seedPhaseA(db, { clock });
  addAgent(db, clock);
  db.writeTx((tx) => tx.run(
    "INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled) VALUES ('routine-1', 'weekly-research', ?, '0 9 * * 1 Asia/Seoul', 'weekly-research@1', ?, 1)",
    [SEED_IDS.unit, routine.catchUp],
  ));
  return { dbPath, db, logPath: join(dir, 'executions.log') };
}

type Message = { type: string; [key: string]: unknown };
type RoutineReport = { fired: { scheduledFor: string; created: boolean; taskIds: string[] }[]; failed: unknown[] };

class Daemon {
  readonly child: ChildProcess;
  readonly #inbox: Message[] = [];
  readonly #waiters: { type: string; resolve: (m: Message) => void }[] = [];
  readonly #exited: Promise<unknown>;

  constructor(t: TestContext, env: Env, id: string) {
    this.child = fork(new URL('./workers/engine-worker.ts', import.meta.url), [env.dbPath, id, JSON.stringify({
      executor: 'complete', logPath: env.logPath, routineTemplate: true, leaseMs: 90_000, heartbeatMs: 30_000,
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

  async tick(now: number): Promise<RoutineReport> {
    this.child.send({ cmd: 'tick', now });
    return ((await this.next('tick'))['report'] as { routines: RoutineReport }).routines;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.#exited;
  }
}

const spawn = (t: TestContext, env: Env, id: string) => new Daemon(t, env, id).ready();
const count = (db: Db, from: string): number => Number(db.get(`SELECT count(*) AS n FROM ${from}`)?.['n']);
const firings = (db: Db): string[] => db.all<{ scheduled_for: string }>('SELECT scheduled_for FROM routine_firing ORDER BY scheduled_for').map((r) => r.scheduled_for);

test('two daemons tick the same weekly slot at the same moment: one firing, one template run (3 tasks with their dependencies), five slots in a row', async (t) => {
  const env = engineDb(t, { catchUp: 'skip' });
  const [a, b] = await Promise.all([spawn(t, env, 'daemon-a'), spawn(t, env, 'daemon-b')]);
  // both see the never-fired routine before the first slot
  await Promise.all([a.tick(T0), b.tick(T0)]);

  let slotIndex = 0;
  for (const slot of MONDAYS) {
    slotIndex += 1;
    const [ra, rb] = await Promise.all([a.tick(Date.parse(slot)), b.tick(Date.parse(slot))]);
    const mine = [...ra.fired, ...rb.fired].filter((f) => f.scheduledFor === slot);
    assert.equal(mine.filter((f) => f.created).length, 1, `${slot}: exactly one daemon created the firing`);
    assert.deepEqual(ra.failed.concat(rb.failed), []);
    assert.equal(count(env.db, 'routine_firing'), slotIndex);
    assert.equal(count(env.db, 'task'), slotIndex * 3, `${slot}: one template run`);
    assert.equal(count(env.db, 'task_dependency'), slotIndex * 3);
  }
  assert.deepEqual(firings(env.db), MONDAYS);
  assert.deepEqual(env.db.all<{ n: number }>('SELECT count(*) AS n FROM task GROUP BY trigger_ref').map((r) => Number(r.n)), Array(MONDAYS.length).fill(3));
  assert.equal(count(env.db, "task WHERE trigger_kind = 'routine'"), MONDAYS.length * 3);
});

test('both daemons come back after 3 weeks: run_once fires the newest missed slot exactly once', async (t) => {
  const env = engineDb(t, { catchUp: 'run_once' });
  env.db.writeTx((tx) => tx.run("INSERT INTO routine_firing (routine_id, scheduled_for, fired_at) VALUES ('routine-1', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:01.000Z')"));
  const [a, b] = await Promise.all([spawn(t, env, 'daemon-a'), spawn(t, env, 'daemon-b')]);
  const now = Date.parse('2026-10-21T10:00:00.000Z');
  const [ra, rb] = await Promise.all([a.tick(now), b.tick(now)]);
  assert.equal([...ra.fired, ...rb.fired].filter((f) => f.created).length, 1);
  assert.deepEqual(firings(env.db), ['2026-09-28T00:00:00.000Z', '2026-10-19T00:00:00.000Z']);
  assert.equal(count(env.db, 'task'), 3);
});

test('both daemons come back after 3 weeks: skip fires nothing until the next slot, then once', async (t) => {
  const env = engineDb(t, { catchUp: 'skip' });
  env.db.writeTx((tx) => tx.run("INSERT INTO routine_firing (routine_id, scheduled_for, fired_at) VALUES ('routine-1', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:01.000Z')"));
  const [a, b] = await Promise.all([spawn(t, env, 'daemon-a'), spawn(t, env, 'daemon-b')]);
  const back = Date.parse('2026-10-21T10:00:00.000Z');
  const [ra, rb] = await Promise.all([a.tick(back), b.tick(back)]);
  assert.deepEqual([...ra.fired, ...rb.fired], []);
  assert.equal(count(env.db, 'task'), 0);

  const next = Date.parse('2026-10-26T00:00:02.000Z');
  const [na, nb] = await Promise.all([a.tick(next), b.tick(next)]);
  assert.equal([...na.fired, ...nb.fired].filter((f) => f.created).length, 1);
  assert.deepEqual(firings(env.db), ['2026-09-28T00:00:00.000Z', '2026-10-26T00:00:00.000Z']);
  assert.equal(count(env.db, 'task'), 3);
});
