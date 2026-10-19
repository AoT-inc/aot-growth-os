// 업무 생성 엔진 (A2): 멱등 생성(이벤트·루틴·dedupe), 생성 거부 조건, 시스템 필드 채우기, 의존 순환 거부.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DENY_ALL_TASK_POLICY_GATE, SEED_IDS, type Db, type FakeClock } from '@aot/domain';
import { createTask, fireRoutine, recordEvent, TaskCreationError, transitionTask } from '@aot/task-engine';

import { ALLOW_ALL_GATE } from '../support/engine.ts';
import { minimalDraft } from '../support/spec-fixtures.ts';
import { seededDb } from '../support/seeded-db.ts';

const count = (db: Db, sql: string, params: (string | number)[] = []): number => Number(db.get(`SELECT count(*) AS n FROM ${sql}`, params)?.['n']);
const ctx = (clock: FakeClock) => ({ clock, gate: ALLOW_ALL_GATE });
const generalist = (extra: Record<string, unknown> = {}) => ({ ...minimalDraft(), role: 'generalist', ...extra });
const issueCodes = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TaskCreationError, String(error));
    return error.issues.map((i) => `${i.path}:${i.code}`);
  }
  assert.fail('expected TaskCreationError');
};

test('creation fills the system fields, records the (none) -> queued transition, and queues tasks with a role', (t) => {
  const { db, clock } = seededDb(t);
  const result = createTask(db, ctx(clock), { spec: generalist({ department: 'core' }) });
  assert.deepEqual({ created: result.created, status: result.status }, { created: true, status: 'queued' });

  const row = db.get<{ spec: string; role_id: string; role_version: number; org_unit_id: string; org_version_id: string; policy_version_id: string; cost_budget_usd: number; attempts: number; max_attempts: number }>(
    'SELECT * FROM task WHERE id = ?', [result.taskId],
  )!;
  assert.equal(row.role_id, SEED_IDS.generalist);
  assert.equal(row.org_unit_id, SEED_IDS.unit);
  assert.equal(row.org_version_id, SEED_IDS.orgVersion);
  assert.equal(row.policy_version_id, SEED_IDS.policy);
  assert.equal(Number(row.cost_budget_usd), 2);
  assert.deepEqual([Number(row.attempts), Number(row.max_attempts)], [0, 3]);
  const spec = JSON.parse(row.spec) as Record<string, unknown>;
  assert.equal(spec['policy_version'], SEED_IDS.policy);
  assert.deepEqual(spec['versions'], { org_version: SEED_IDS.orgVersion, role_version: 1, task_spec_version: 1, strategy_version: null, tool_contract_version: null });

  const transitions = db.all('SELECT from_status, to_status, caused_by FROM task_transition WHERE task_id = ?', [result.taskId]);
  assert.deepEqual(JSON.parse(JSON.stringify(transitions)), [{ from_status: null, to_status: 'queued', caused_by: 'system:task_creator' }]);
});

test('no role -> unassigned', (t) => {
  const { db, clock } = seededDb(t);
  assert.equal(createTask(db, ctx(clock), { spec: minimalDraft() }).status, 'unassigned');
});

test('same trigger + same inputs N times -> one active task; a new task is allowed once the old one is terminal', (t) => {
  const { db, clock } = seededDb(t);
  const ids = Array.from({ length: 5 }, () => createTask(db, ctx(clock), { spec: generalist() }));
  assert.equal(new Set(ids.map((r) => r.taskId)).size, 1);
  assert.deepEqual(ids.map((r) => r.created), [true, false, false, false, false]);
  assert.equal(count(db, 'task'), 1);

  const other = createTask(db, ctx(clock), { spec: generalist({ inputs: [{ name: 'k', ref: 'strategy:other', kind: 'strategy' }] }) });
  assert.equal(other.created, true, 'different inputs are a different task');

  db.writeTx((tx) => transitionTask(tx, { taskId: ids[0]!.taskId, from: 'queued', to: 'cancelled', by: 'human', reason: 'test', now: clock.nowIso() }));
  const again = createTask(db, ctx(clock), { spec: generalist() });
  assert.equal(again.created, true);
  assert.notEqual(again.taskId, ids[0]!.taskId);
});

test('the same event delivered N times -> one event row, one task', (t) => {
  const { db, clock } = seededDb(t);
  const event = { source: 'example-source', externalId: 'evt-1', type: 'example.signal', payload: { n: 1 }, occurredAt: clock.nowIso() };
  const results = Array.from({ length: 7 }, () => recordEvent(db, ctx(clock), event, generalist()));
  assert.deepEqual(results.map((r) => r.created), [true, false, false, false, false, false, false]);
  assert.equal(new Set(results.map((r) => r.taskId)).size, 1);
  assert.equal(count(db, 'event'), 1);
  assert.equal(count(db, 'task'), 1);
  assert.equal(db.get('SELECT trigger_kind FROM task')?.['trigger_kind'], 'event');

  // external_id 가 없으면 내용 해시가 키다
  const anon = { source: 'example-source', type: 'example.signal', payload: { n: 2 }, occurredAt: clock.nowIso() };
  recordEvent(db, ctx(clock), anon, generalist());
  recordEvent(db, ctx(clock), { ...anon }, generalist());
  assert.equal(count(db, 'event'), 2);
  assert.equal(count(db, 'task'), 2);
});

test('an event whose task is rejected leaves no event row behind (one transaction)', (t) => {
  const { db, clock } = seededDb(t);
  const event = { source: 's', externalId: 'bad', type: 'x', payload: {}, occurredAt: clock.nowIso() };
  assert.throws(() => recordEvent(db, ctx(clock), event, { ...generalist(), acceptance_criteria: [] }), TaskCreationError);
  assert.equal(count(db, 'event'), 0);
});

test('a routine firing is recorded once; repeated firings for the same slot create nothing', (t) => {
  const { db, clock } = seededDb(t);
  db.writeTx((tx) => tx.run(
    "INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled) VALUES ('routine-1', 'weekly-research', ?, '0 9 * * MON UTC', 'weekly-research@1', 'skip', 1)",
    [SEED_IDS.unit],
  ));
  const slot = '2026-10-19T09:00:00.000Z';
  const results = Array.from({ length: 4 }, () => fireRoutine(db, ctx(clock), { routineId: 'routine-1', scheduledFor: slot }, generalist()));
  assert.deepEqual(results.map((r) => r.created), [true, false, false, false]);
  assert.equal(new Set(results.map((r) => r.taskId)).size, 1);
  assert.equal(count(db, 'routine_firing'), 1);
  assert.equal(db.get('SELECT trigger_ref FROM task')?.['trigger_ref'], `weekly-research@${slot}`);

  fireRoutine(db, ctx(clock), { routineId: 'routine-1', scheduledFor: '2026-10-26T09:00:00.000Z' }, generalist());
  assert.equal(count(db, 'task'), 2);

  db.writeTx((tx) => tx.run("UPDATE routine SET enabled = 0 WHERE id = 'routine-1'"));
  assert.deepEqual(issueCodes(() => fireRoutine(db, ctx(clock), { routineId: 'routine-1', scheduledFor: '2026-11-02T09:00:00.000Z' }, generalist())), ['routine:disabled']);
});

test('creation is rejected for invalid specs and bad references, with every issue reported', (t) => {
  const { db, clock } = seededDb(t);
  assert.ok(issueCodes(() => createTask(db, ctx(clock), { spec: { ...generalist(), acceptance_criteria: [] } })).includes('acceptance_criteria:required'));
  assert.ok(issueCodes(() => createTask(db, ctx(clock), { spec: { ...generalist(), policy_version: 'p' } })).includes('policy_version:system_field'));
  assert.deepEqual(issueCodes(() => createTask(db, ctx(clock), { spec: generalist({ role: 'market-researcher', product: 'example-product' }) })).sort(),
    ['product:not_registered', 'role:not_found']);
  assert.deepEqual(issueCodes(() => createTask(db, ctx(clock), { spec: generalist({ dependencies: ['task-missing'] }) })), ['dependencies[0]:not_found']);
  assert.equal(count(db, 'task'), 0);
});

test('the policy gate decides creation; without one (default) creation is denied', (t) => {
  const { db, clock } = seededDb(t);
  assert.deepEqual(issueCodes(() => createTask(db, { clock, gate: DENY_ALL_TASK_POLICY_GATE }, { spec: generalist() })), ['allowed_tools:policy_denied']);
  const seen: unknown[] = [];
  const gate = { ...ALLOW_ALL_GATE, beforeCreate: (_tx: Db, request: { spec: unknown }) => (seen.push(request.spec), { decision: 'allow' as const }) };
  createTask(db, { clock, gate }, { spec: generalist() });
  assert.equal((seen[0] as { policy_version: string }).policy_version, SEED_IDS.policy, 'the gate sees the spec with system fields filled');
});

test('dependency cycles are rejected: a self-dependency, and a cycle already reachable through stored dependencies', (t) => {
  const { db, clock } = seededDb(t);
  const a = createTask(db, ctx(clock), { id: 'task-a', spec: generalist({ objective: 'a 를 한다' , inputs: [{ name: 'a', ref: 'r:a', kind: 'k' }] }) });
  const b = createTask(db, ctx(clock), { id: 'task-b', spec: generalist({ inputs: [{ name: 'b', ref: 'r:b', kind: 'k' }], dependencies: ['task-a'] }) });
  assert.equal(b.created, true);

  assert.deepEqual(issueCodes(() => createTask(db, ctx(clock), { id: 'task-self', spec: generalist({ inputs: [{ name: 's', ref: 'r:s', kind: 'k' }], dependencies: ['task-self'] }) })),
    ['dependencies:cycle'], 'a task cannot depend on itself');

  // 저장된 간선이 순환을 이루면(손상된 데이터), 거기에 닿는 새 업무는 거부한다.
  db.writeTx((tx) => tx.run('INSERT INTO task_dependency (task_id, depends_on) VALUES (?, ?)', [a.taskId, b.taskId]));
  const codes = issueCodes(() => createTask(db, ctx(clock), { spec: generalist({ inputs: [{ name: 'c', ref: 'r:c', kind: 'k' }], dependencies: ['task-b'] }) }));
  assert.deepEqual(codes, ['dependencies:cycle']);
});
