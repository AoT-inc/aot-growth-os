// 루틴 슬롯 발화 (A6-U9): TaskWorker.tick 의 선택 단계. 가짜 템플릿 포트, 가짜 시계, 한 프로세스.
// 다중 프로세스 경쟁은 test/integration/task-engine-routine-multiprocess.test.ts 가 맡는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEED_IDS, type Db, type FakeClock } from '@aot/domain';
import { fireRoutineTasks, TaskCreationError, TaskWorker, type RoutineScheduleOptions, type RoutineTemplateTask, type TaskExecutor, type WorkerOptions } from '@aot/task-engine';

import { ALLOW_ALL_GATE, manualTimers, taskStatus } from '../support/engine.ts';
import { fakeTemplateSource, templateSpec, threeStepTemplate } from '../support/routine-template.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const WEEKLY_SEOUL = '0 9 * * 1 Asia/Seoul'; // Monday 00:00Z
const MONDAY = '2026-10-19T00:00:00.000Z';
const count = (db: Db, from: string): number => Number(db.get(`SELECT count(*) AS n FROM ${from}`)?.['n']);

const completes: TaskExecutor = { execute: async () => ({ result: { ok: true } }) };

function setup(t: Parameters<typeof seededDb>[0], routines?: Partial<RoutineScheduleOptions> | null, templates: Record<string, () => readonly RoutineTemplateTask[]> = { 'weekly-research@1': threeStepTemplate }) {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  const source = fakeTemplateSource(templates);
  const options = (workerId: string, extra: Partial<WorkerOptions> = {}): WorkerOptions => ({
    db, clock, workerId, actorId, adapter: 'fake-adapter', executor: completes, gate: ALLOW_ALL_GATE, timers: manualTimers(),
    ...(routines === null ? {} : { routines: { source, ...routines } }), ...extra,
  });
  return { db, clock, source, worker: (workerId = 'w1', extra: Partial<WorkerOptions> = {}) => new TaskWorker(options(workerId, extra)) };
}

function addRoutine(db: Db, extra: { id?: string; slug?: string; schedule?: string; template?: string; catchUp?: 'skip' | 'run_once'; enabled?: number } = {}): string {
  const id = extra.id ?? 'routine-1';
  db.writeTx((tx) => tx.run(
    'INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, extra.slug ?? 'weekly-research', SEED_IDS.unit, extra.schedule ?? WEEKLY_SEOUL, extra.template ?? 'weekly-research@1', extra.catchUp ?? 'skip', extra.enabled ?? 1],
  ));
  return id;
}

function recordFiring(db: Db, clock: FakeClock, routineId: string, scheduledFor: string): void {
  db.writeTx((tx) => tx.run('INSERT INTO routine_firing (routine_id, scheduled_for, fired_at) VALUES (?, ?, ?)', [routineId, scheduledFor, clock.nowIso()]));
}

const firings = (db: Db, routineId = 'routine-1'): string[] =>
  db.all<{ scheduled_for: string }>('SELECT scheduled_for FROM routine_firing WHERE routine_id = ? ORDER BY scheduled_for', [routineId]).map((r) => r.scheduled_for);

test('without the routine option a tick never looks at routines', async (t) => {
  const { db, clock, worker } = setup(t, null);
  addRoutine(db);
  clock.set('2026-10-20T00:00:00.000Z');
  const report = await worker().tick();
  assert.deepEqual(report.routines, { fired: [], failed: [] });
  assert.equal(count(db, 'routine_firing'), 0);
});

test('one template fires several tasks in one tick; names become dependencies; the slot fires once', async (t) => {
  const { db, clock, source, worker } = setup(t);
  addRoutine(db);
  const w = worker();
  clock.set('2026-10-18T12:00:00.000Z');
  assert.deepEqual((await w.tick()).routines, { fired: [], failed: [] }, 'first sight of a never-fired routine: nothing happened before it was seen');

  clock.set(MONDAY);
  const report = await w.tick();
  assert.equal(report.routines.fired.length, 1);
  const fired = report.routines.fired[0]!;
  assert.deepEqual({ slug: fired.slug, scheduledFor: fired.scheduledFor, created: fired.created }, { slug: 'weekly-research', scheduledFor: MONDAY, created: true });
  assert.equal(fired.taskIds.length, 3);
  assert.deepEqual(firings(db), [MONDAY]);

  const rows = db.all<{ id: string; objective: string; trigger_kind: string; trigger_ref: string; dedupe_key: string }>('SELECT id, objective, trigger_kind, trigger_ref, dedupe_key FROM task ORDER BY created_at, rowid');
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.dedupe_key)).size, 3, 'sibling tasks with the same inputs stay separate tasks');
  assert.deepEqual(rows.map((r) => [r.trigger_kind, r.trigger_ref]), Array(3).fill(['routine', `weekly-research@${MONDAY}`]));
  // created in dependency order: collect, analyze, report
  assert.deepEqual(rows.map((r) => r.objective), ['자료를 모은다', '자료를 분석한다', '주간 보고를 쓴다']);
  assert.deepEqual(fired.taskIds, rows.map((r) => r.id));
  const [collect, analyze, reportTask] = fired.taskIds as [string, string, string];
  const edges = db.all<{ task_id: string; depends_on: string }>('SELECT task_id, depends_on FROM task_dependency ORDER BY task_id, depends_on').map((e) => `${e.task_id}>${e.depends_on}`).sort();
  assert.deepEqual(edges, [`${analyze}>${collect}`, `${reportTask}>${analyze}`, `${reportTask}>${collect}`].sort());
  assert.deepEqual(source.requests.map((r) => [r.routine.id, r.scheduledFor, r.routine.taskTemplate]), [['routine-1', MONDAY, 'weekly-research@1']]);

  // the same tick claimed the only runnable task: the one nothing depends on first
  assert.equal(report.executed?.taskId, collect);
  assert.equal(taskStatus(db, collect), 'validating');
  assert.deepEqual([analyze, reportTask].map((id) => taskStatus(db, id)), ['queued', 'queued']);
  assert.equal((await w.tick()).executed, null, 'the dependents wait until their dependencies are completed');

  // later ticks in the same slot do not fire again
  clock.advance(60_000);
  assert.deepEqual((await w.tick()).routines, { fired: [], failed: [] });
  assert.equal(count(db, 'task'), 3);
  assert.equal(source.requests.length, 1);
});

test('a second worker ticking the same slot adds nothing (fire is idempotent per slot)', async (t) => {
  const { db, clock, worker } = setup(t);
  addRoutine(db);
  const [a, b] = [worker('a'), worker('b')];
  clock.set('2026-10-18T12:00:00.000Z');
  await a.tick();
  await b.tick();
  clock.set(MONDAY);
  const [ra, rb] = [await a.tick(), await b.tick()];
  assert.deepEqual([ra.routines.fired.length, rb.routines.fired.length], [1, 0], 'b sees the recorded firing and has nothing left to do');
  assert.equal(count(db, 'routine_firing'), 1);
  assert.equal(count(db, 'task'), 3);
});

test('3 weeks stopped, back mid-week: skip waits for the next slot and fires on time', async (t) => {
  const { db, clock, worker } = setup(t);
  addRoutine(db, { catchUp: 'skip' });
  recordFiring(db, clock, 'routine-1', '2026-09-28T00:00:00.000Z');
  const w = worker();
  clock.set('2026-10-22T12:00:00.000Z');
  assert.deepEqual((await w.tick()).routines, { fired: [], failed: [] });
  assert.equal(count(db, 'task'), 0);
  clock.set('2026-10-26T00:00:03.000Z'); // 3 seconds late is on time
  const report = await w.tick();
  assert.deepEqual(report.routines.fired.map((f) => f.scheduledFor), ['2026-10-26T00:00:00.000Z']);
  assert.deepEqual(firings(db), ['2026-09-28T00:00:00.000Z', '2026-10-26T00:00:00.000Z']);
});

test('3 weeks stopped, back mid-week: run_once fires the newest missed slot once and nothing for the older ones', async (t) => {
  const { db, clock, worker } = setup(t);
  addRoutine(db, { catchUp: 'run_once' });
  recordFiring(db, clock, 'routine-1', '2026-09-28T00:00:00.000Z');
  const w = worker();
  clock.set('2026-10-22T12:00:00.000Z');
  const report = await w.tick();
  assert.deepEqual(report.routines.fired.map((f) => f.scheduledFor), [MONDAY]);
  assert.equal(count(db, 'task'), 3, 'one template run, not three');
  assert.deepEqual(firings(db), ['2026-09-28T00:00:00.000Z', MONDAY]);
  assert.deepEqual((await w.tick()).routines, { fired: [], failed: [] }, 'caught up: the older missed slots are not revisited');
  clock.set('2026-10-26T00:00:00.000Z');
  assert.deepEqual((await w.tick()).routines.fired.map((f) => f.scheduledFor), ['2026-10-26T00:00:00.000Z']);
});

test('3 weeks stopped, back during a slot: skip fires that late slot only', async (t) => {
  const { db, clock, worker } = setup(t);
  addRoutine(db, { catchUp: 'skip' });
  recordFiring(db, clock, 'routine-1', '2026-09-28T00:00:00.000Z');
  clock.set('2026-10-19T00:05:00.000Z');
  assert.deepEqual((await worker().tick()).routines.fired.map((f) => f.scheduledFor), [MONDAY]);
  assert.equal(count(db, 'routine_firing'), 2);
});

test('a never-fired routine fires nothing for slots before it was first seen, unless activatedAt says it was already active', async (t) => {
  const plain = setup(t);
  addRoutine(plain.db);
  plain.clock.set('2026-10-22T00:00:00.000Z');
  assert.deepEqual((await plain.worker().tick()).routines.fired, []);

  const activated = setup(t, { activatedAt: () => '2026-10-10T00:00:00.000Z' }); // enabled before the Monday 10-12 slot
  addRoutine(activated.db, { catchUp: 'run_once' });
  activated.clock.set('2026-10-14T00:00:00.000Z');
  assert.deepEqual((await activated.worker().tick()).routines.fired.map((f) => f.scheduledFor), ['2026-10-12T00:00:00.000Z']);
});

test('disabled routines are not fired', async (t) => {
  const { db, clock, worker } = setup(t);
  addRoutine(db, { enabled: 0 });
  const w = worker();
  clock.set('2026-10-18T12:00:00.000Z');
  await w.tick();
  clock.set(MONDAY);
  assert.deepEqual((await w.tick()).routines, { fired: [], failed: [] });
  assert.equal(count(db, 'routine_firing'), 0);
});

test('an invalid schedule is reported once with its reason and never fires', async (t) => {
  const { db, clock, worker } = setup(t);
  addRoutine(db, { schedule: '0 9 * * 1' });
  addRoutine(db, { id: 'routine-2', slug: 'other', schedule: '0 9 * * 1 UTC', template: 'weekly-research@1' });
  const w = worker();
  clock.set('2026-10-18T12:00:00.000Z');
  const first = await w.tick();
  assert.equal(first.routines.failed.length, 1);
  assert.equal(first.routines.failed[0]!.routineId, 'routine-1');
  assert.equal(first.routines.failed[0]!.scheduledFor, null);
  assert.match(first.routines.failed[0]!.error, /time zone is required/);
  assert.deepEqual((await w.tick()).routines.failed, [], 'not reported again by the same process');
  clock.set('2026-10-19T09:00:00.000Z');
  assert.deepEqual((await w.tick()).routines.fired.map((f) => f.routineId), ['routine-2'], 'the other routine is unaffected');
});

test('a template that cannot be resolved leaves no firing and is retried on the next tick', async (t) => {
  let broken = true;
  const { db, clock, worker } = setup(t, undefined, { 'weekly-research@1': () => { if (broken) throw new Error('template store unavailable'); return threeStepTemplate(); } });
  addRoutine(db);
  const w = worker();
  clock.set('2026-10-18T12:00:00.000Z');
  await w.tick();
  clock.set(MONDAY);
  const failed = await w.tick();
  assert.deepEqual(failed.routines.failed.map((f) => [f.scheduledFor, f.error]), [[MONDAY, 'template store unavailable']]);
  assert.equal(count(db, 'routine_firing'), 0);
  broken = false;
  clock.advance(5_000);
  assert.equal((await w.tick()).routines.fired.length, 1);
  assert.equal(count(db, 'task'), 3);
});

test('invalid templates are refused as a whole: no firing, no task, reported once per slot', async (t) => {
  const spec = () => templateSpec('x');
  const templates: Record<string, () => readonly RoutineTemplateTask[]> = {
    'empty@1': () => [],
    'duplicate@1': () => [{ name: 'a', spec: spec() }, { name: 'a', spec: spec() }],
    'unknown@1': () => [{ name: 'a', spec: spec(), dependsOn: ['ghost'] }],
    'self@1': () => [{ name: 'a', spec: spec(), dependsOn: ['a'] }],
    'cycle@1': () => [{ name: 'a', spec: spec(), dependsOn: ['b'] }, { name: 'b', spec: spec(), dependsOn: ['a'] }],
    'second-invalid@1': () => [{ name: 'ok', spec: spec() }, { name: 'bad', spec: { ...spec(), acceptance_criteria: [] }, dependsOn: ['ok'] }],
  };
  const { db, clock, source, worker } = setup(t, undefined, templates);
  const slugs = Object.keys(templates);
  slugs.forEach((template, i) => addRoutine(db, { id: `r${i}`, slug: `routine-${i}`, template }));
  const w = worker();
  clock.set('2026-10-18T12:00:00.000Z');
  await w.tick();
  clock.set(MONDAY);
  const report = await w.tick();
  assert.equal(report.routines.fired.length, 0);
  assert.deepEqual(report.routines.failed.map((f) => f.routineId).sort(), slugs.map((_, i) => `r${i}`).sort());
  const reasons = Object.fromEntries(report.routines.failed.map((f) => [f.routineId, f.error]));
  assert.match(reasons['r0']!, /at least one task/);
  assert.match(reasons['r1']!, /used more than once/);
  assert.match(reasons['r2']!, /unknown template task 'ghost'/);
  assert.match(reasons['r3']!, /depends on itself/);
  assert.match(reasons['r4']!, /dependency cycle among: a, b/);
  assert.match(reasons['r5']!, /acceptance_criteria/);
  assert.equal(count(db, 'routine_firing'), 0);
  assert.equal(count(db, 'task'), 0, 'the valid first task of the last template was rolled back with the rest');
  assert.equal(count(db, 'task_dependency'), 0);

  clock.advance(5_000);
  assert.deepEqual((await w.tick()).routines.failed, [], 'a deterministic refusal is not retried (and not re-recorded) by the same process');
  assert.equal(source.requests.length, slugs.length);
});

test('fireRoutineTasks directly: a replayed slot returns the original tasks; a policy refusal rolls the whole firing back', (t) => {
  const { db, clock } = seededDb(t);
  addRoutine(db);
  const context = { clock, gate: ALLOW_ALL_GATE };
  const first = fireRoutineTasks(db, context, { routineId: 'routine-1', scheduledFor: MONDAY }, threeStepTemplate());
  const again = fireRoutineTasks(db, context, { routineId: 'routine-1', scheduledFor: MONDAY }, threeStepTemplate());
  assert.deepEqual([first.created, again.created], [true, false]);
  assert.deepEqual(again.taskIds, first.taskIds);

  const denied = { clock, gate: { ...ALLOW_ALL_GATE, beforeCreate: () => ({ decision: 'deny' as const, reason: 'no', recordRefusal: () => undefined }) } };
  assert.throws(() => fireRoutineTasks(db, denied, { routineId: 'routine-1', scheduledFor: '2026-10-26T00:00:00.000Z' }, threeStepTemplate()), TaskCreationError);
  assert.equal(count(db, 'routine_firing'), 1);
  assert.equal(count(db, 'task'), 3);
});
