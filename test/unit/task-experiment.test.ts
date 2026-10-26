// A6-U15: 승인된 실험의 활성화와 종료 (task-engine experiment.ts) + 실험 루틴의 발화 기준점(routine.ts).
// 승인 자체는 policy 의 몫이라 여기서는 `experiment` 상태 행을 직접 넣고 승인 확인을 주입한다(policy 쪽은 policy-strategy-approval.test.ts).
//  - 활성화는 전략당 한 번(event 멱등 키), 템플릿 범위면 그 템플릿의 루틴을 켜고, 일회성 명세면 전략이 붙은 업무를 만든다
//  - 켜진 루틴은 활성화 시각 *이후* 슬롯부터 발화한다(새 프로세스에서도), 꺼진 루틴은 발화하지 않는다, 다시 켜도 꺼져 있던 동안의 슬롯을 끌어오지 않는다
//  - 거부는 아무것도 쓰지 않는다
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DENY_ALL_TASK_POLICY_GATE, experimentActivationKey, latestRoutineActivation, SEED_IDS, type Db, type FakeClock, type TaskRow } from '@aot/domain';
import {
  activateExperiment, endExperiment, EXPERIMENT_TASK_CAUSE, ExperimentActivationError, TaskWorker,
  type ActivateExperimentInput, type ExperimentRefusalCode, type TaskExecutor,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, manualTimers } from '../support/engine.ts';
import { fakeTemplateSource, templateSpec, threeStepTemplate } from '../support/routine-template.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const WEEKLY_SEOUL = '0 9 * * 1 Asia/Seoul'; // 월요일 00:00Z
const OK = () => ({ ok: true, reason: 'approved by actor-owner', approvalId: 'approval-1' });
const completes: TaskExecutor = { execute: async () => ({ result: { ok: true } }) };
const count = (db: Db, sql: string, params: string[] = []): number => Number(db.get<{ n: number }>(sql, params)!.n);

function setup(t: Parameters<typeof seededDb>[0]) {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  const source = fakeTemplateSource({ 'weekly-research@1': threeStepTemplate });
  const worker = (workerId = 'w1') => new TaskWorker({
    db, clock, workerId, actorId, adapter: 'fake-adapter', executor: completes, gate: ALLOW_ALL_GATE, timers: manualTimers(), routines: { source },
  });
  return { db, clock, actorId, worker };
}

function addRoutine(db: Db, catchUp: 'skip' | 'run_once' = 'run_once', template = 'weekly-research@1'): string {
  db.writeTx((tx) => tx.run(
    'INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled) VALUES (?, ?, ?, ?, ?, ?, 0)',
    ['routine-1', 'weekly-research', SEED_IDS.unit, WEEKLY_SEOUL, template, catchUp],
  ));
  return 'routine-1';
}

const templateScope = (ref = 'weekly-research@1') => ({ duration: { period: 'iso_week', weeks: 1 }, task: { kind: 'task_template', ref } });
const specScope = (spec: Record<string, unknown> = marketing()) => ({ duration: { period: 'iso_week', weeks: 1 }, task: { kind: 'task_spec', spec } });
function marketing(): Record<string, unknown> {
  const spec = templateSpec('example-product 랜딩 페이지 문구를 한 주 동안 바꿔 본다');
  delete spec['trigger'];
  return spec;
}

/** 승인을 거쳤다고 치고 `experiment` 상태 행을 넣는다 (승인 절차는 policy 시험) */
function addExperiment(db: Db, clock: FakeClock, actorId: string, id: string, scope: unknown, status = 'experiment'): string {
  db.writeTx((tx) => tx.run(
    `INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `Experiment ${id}`, `hypothesis ${id}`, JSON.stringify(['task:example']), status, scope === null ? null : JSON.stringify(scope), actorId, clock.nowIso()],
  ));
  return id;
}

const activate = (db: Db, clock: FakeClock, id: string, extra: Partial<ActivateExperimentInput> = {}, gate = ALLOW_ALL_GATE) =>
  activateExperiment(db, { clock, gate }, { strategyVersionId: id, verifyApproval: OK, ...extra });

const enabled = (db: Db) => Number(db.get<{ enabled: number }>("SELECT enabled FROM routine WHERE id = 'routine-1'")!.enabled);
const activations = (db: Db) => count(db, "SELECT count(*) AS n FROM event WHERE type = 'experiment.activated'");
const firedTasks = (db: Db) => db.all<Pick<TaskRow, 'id' | 'strategy_version_id' | 'trigger_ref' | 'spec'>>("SELECT id, strategy_version_id, trigger_ref, spec FROM task WHERE trigger_kind = 'routine' ORDER BY created_at, rowid");

test('activation turns on the routine of the template once and records the activation time; activating again changes nothing', (t) => {
  const { db, clock, actorId } = setup(t);
  addRoutine(db);
  addExperiment(db, clock, actorId, 'strategy-a', templateScope());
  clock.set('2026-10-14T00:00:00.000Z');
  const first = activate(db, clock, 'strategy-a');
  assert.deepEqual([first.activated, first.activatedAt, first.routineIds, first.taskIds], [true, '2026-10-14T00:00:00.000Z', ['routine-1'], []]);
  assert.equal(enabled(db), 1);
  const event = db.get<{ occurred_at: string; external_id: string; payload: string }>('SELECT occurred_at, external_id, payload FROM event WHERE idempotency_key = ?', [experimentActivationKey('strategy-a')])!;
  assert.deepEqual([event.occurred_at, event.external_id], ['2026-10-14T00:00:00.000Z', 'strategy-a']);
  assert.deepEqual(JSON.parse(event.payload), { strategy_version_id: 'strategy-a', approval_id: 'approval-1', task_kind: 'task_template', task_template: 'weekly-research@1', routine_ids: ['routine-1'], task_ids: [] });
  assert.equal(latestRoutineActivation(db, 'routine-1')?.activatedAt, '2026-10-14T00:00:00.000Z');

  clock.set('2026-10-15T00:00:00.000Z');
  for (let i = 0; i < 3; i += 1) {
    const again = activate(db, clock, 'strategy-a');
    assert.deepEqual([again.activated, again.activatedAt, again.eventId], [false, '2026-10-14T00:00:00.000Z', first.eventId]);
  }
  assert.equal(activations(db), 1);
});

test('an activated routine fires from the first slot after the activation time, also in a fresh process, and its tasks carry the experiment', async (t) => {
  const { db, clock, actorId, worker } = setup(t);
  addRoutine(db, 'run_once'); // run_once 라도 활성화 전 슬롯(10-12)은 끌어오지 않는다
  addExperiment(db, clock, actorId, 'strategy-a', templateScope());
  clock.set('2026-10-14T00:00:00.000Z');
  activate(db, clock, 'strategy-a');
  assert.deepEqual((await worker().tick()).routines.fired, []);

  // 새 프로세스(새 워커)가 슬롯 직후에 처음 tick 해도 기준점은 "처음 본 시각"이 아니라 활성화 시각이다
  clock.set('2026-10-19T00:05:00.000Z');
  const fired = (await worker('w2').tick()).routines.fired;
  assert.deepEqual(fired.map((f) => [f.scheduledFor, f.created, f.taskIds.length]), [['2026-10-19T00:00:00.000Z', true, 3]]);
  for (const task of firedTasks(db)) {
    assert.equal(task.strategy_version_id, 'strategy-a');
    assert.equal((JSON.parse(task.spec) as { versions: { strategy_version: string } }).versions.strategy_version, 'strategy-a');
  }
});

test('a disabled routine never fires; ending the experiment turns it off (idempotent); a later activation does not catch up the slots it was off', async (t) => {
  const { db, clock, actorId, worker } = setup(t);
  addRoutine(db, 'run_once');
  addExperiment(db, clock, actorId, 'strategy-a', templateScope());
  const w = worker();
  clock.set('2026-10-19T00:01:00.000Z');
  assert.deepEqual((await w.tick()).routines, { fired: [], failed: [] }, 'not activated yet: the routine is off');

  clock.set('2026-10-20T00:00:00.000Z');
  activate(db, clock, 'strategy-a');
  clock.set('2026-10-26T00:01:00.000Z');
  assert.deepEqual((await w.tick()).routines.fired.map((f) => f.scheduledFor), ['2026-10-26T00:00:00.000Z']);

  clock.set('2026-10-27T00:00:00.000Z');
  const ended = endExperiment(db, clock, { strategyVersionId: 'strategy-a', by: 'evaluator', reason: 'one week elapsed' });
  assert.deepEqual([ended.ended, ended.routineIds], [true, ['routine-1']]);
  assert.equal(enabled(db), 0);
  assert.deepEqual(endExperiment(db, clock, { strategyVersionId: 'strategy-a', by: 'evaluator' }), { ended: false, eventId: ended.eventId, routineIds: ['routine-1'] });
  assert.equal(count(db, "SELECT count(*) AS n FROM event WHERE type = 'experiment.ended'"), 1);

  clock.set('2026-11-02T00:01:00.000Z');
  assert.deepEqual((await w.tick()).routines, { fired: [], failed: [] }, 'an ended experiment routine does not fire');
  assert.equal(count(db, 'SELECT count(*) AS n FROM routine_firing'), 1);

  // 다음 실험이 같은 루틴을 켜면 기준점 = max(마지막 발화 10-26, 새 활성화 11-05): 꺼져 있던 동안의 11-02 슬롯을 run_once 로 끌어오지 않는다
  addExperiment(db, clock, actorId, 'strategy-b', templateScope());
  clock.set('2026-11-05T00:00:00.000Z');
  activate(db, clock, 'strategy-b');
  assert.deepEqual((await w.tick()).routines.fired, []);
  clock.set('2026-11-09T00:01:00.000Z');
  const next = (await w.tick()).routines.fired;
  assert.deepEqual(next.map((f) => f.scheduledFor), ['2026-11-09T00:00:00.000Z']);
  const latest = firedTasks(db).filter((task) => next[0]!.taskIds.includes(task.id));
  assert.deepEqual([...new Set(latest.map((task) => task.strategy_version_id))], ['strategy-b']);
});

test('a one-off marketing task is created once with the experiment attached, triggered by the activation event', (t) => {
  const { db, clock, actorId } = setup(t);
  addExperiment(db, clock, actorId, 'strategy-a', specScope());
  const result = activate(db, clock, 'strategy-a');
  assert.equal(result.taskIds.length, 1);
  const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [result.taskIds[0]!])!;
  assert.deepEqual([task.status, task.strategy_version_id, task.trigger_kind, task.trigger_ref], ['queued', 'strategy-a', 'event', result.eventId]);
  assert.equal((JSON.parse(task.spec) as { versions: { strategy_version: string } }).versions.strategy_version, 'strategy-a');
  assert.equal(db.get<{ caused_by: string }>('SELECT caused_by FROM task_transition WHERE task_id = ? AND from_status IS NULL', [task.id])!.caused_by, EXPERIMENT_TASK_CAUSE);
  assert.equal(activate(db, clock, 'strategy-a').activated, false);
  assert.equal(count(db, 'SELECT count(*) AS n FROM task WHERE strategy_version_id = ?', ['strategy-a']), 1);
});

test('refusals write nothing (no event, no routine turned on, no task)', (t) => {
  const { db, clock, actorId } = setup(t);
  addRoutine(db);
  addExperiment(db, clock, actorId, 'strategy-a', templateScope());
  addExperiment(db, clock, actorId, 'strategy-proposed', templateScope(), 'proposed');
  addExperiment(db, clock, actorId, 'strategy-no-scope', null);
  addExperiment(db, clock, actorId, 'strategy-no-routine', templateScope('unknown-template@1'));
  addExperiment(db, clock, actorId, 'strategy-spec', specScope());
  const tasksBefore = count(db, 'SELECT count(*) AS n FROM task');
  const cases: [string, () => unknown, ExperimentRefusalCode][] = [
    ['agent', () => activate(db, clock, 'strategy-a', { by: 'agent' }), 'agent_forbidden'],
    ['unknown', () => activate(db, clock, 'strategy-missing'), 'not_found'],
    ['still proposed', () => activate(db, clock, 'strategy-proposed'), 'not_experiment'],
    ['approval no longer valid', () => activate(db, clock, 'strategy-a', { verifyApproval: () => ({ ok: false, reason: 'the approval was rejected or cancelled', approvalId: null }) }), 'approval_invalid'],
    ['no experiment_scope.task', () => activate(db, clock, 'strategy-no-scope'), 'invalid_scope'],
    ['no routine for the template', () => activate(db, clock, 'strategy-no-routine'), 'no_routine'],
    ['the policy refuses the task', () => activate(db, clock, 'strategy-spec', {}, DENY_ALL_TASK_POLICY_GATE), 'task_refused'],
  ];
  for (const [name, run, code] of cases) {
    assert.throws(run, (error: unknown) => error instanceof ExperimentActivationError && error.code === code, name);
  }
  assert.equal(activations(db), 0);
  assert.equal(enabled(db), 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM task'), tasksBefore);
  assert.throws(() => endExperiment(db, clock, { strategyVersionId: 'strategy-a', by: 'agent' }), (error: unknown) => error instanceof ExperimentActivationError && error.code === 'agent_forbidden');
  assert.throws(() => endExperiment(db, clock, { strategyVersionId: 'strategy-missing', by: 'evaluator' }), (error: unknown) => error instanceof ExperimentActivationError && error.code === 'not_found');
});
