// A6-U13: 사람의 측정 값 입력(recordMeasurement)과 대기 조건(inputs[kind=measurement]).
//  - 사람만 입력한다(에이전트·모르는 actor 거부). 첨부가 필수인 신호는 첨부 없이 거부한다.
//  - 같은 신호·같은 주의 같은 입력 N회 → event 1건·근거 1벌·비용 1줄(첫 값 유지). 다른 값은 덮어쓰지 않고 거부한다.
//  - 측정이 없는 동안 그 업무는 집히지 않는다(전이·시도 소모·run 없음). 다른 업무는 정상 선택된다(기다리는 업무가 많아도).
//  - 측정이 들어오면 다음 claim 에 집히고, 측정 뒤에 만들어진 업무에도 근거가 붙는다.
//  - 주 키: ISO 주(월요일 시작)를 신호의 tz 로 센다. 주를 생략하면 Clock 기준 지난주, 끝나지 않은 주는 거부한다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isoWeekKeyOfDate, isoWeekMonday, isoWeeksInYear, parseIsoWeekKey, parseMeasurementRef, validateMeasurementSignal, validateTaskSpec,
  type Db,
} from '@aot/domain';
import {
  claimNextTask, isoWeekKeyAt, isoWeekPeriod, listMeasurementWaits, MeasurementRefusedError, previousIsoWeekKey, recordMeasurement,
  type RecordMeasurementInput,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, queuedTask, runsOf, taskStatus } from '../support/engine.ts';
import { transitionsOf } from '../support/evaluation.ts';
import { minimalDraft } from '../support/spec-fixtures.ts';
import { AFTER_W43, PACK_SIGNAL, W43_KEY as KEY } from '../support/measurement.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const OWNER = 'actor-owner';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const input = (overrides: Partial<RecordMeasurementInput> = {}): RecordMeasurementInput => ({
  actorId: OWNER, signal: PACK_SIGNAL, value: 42, observations: 7, quality: 'good',
  attachments: [{ ref: 'file:/example/exports/week-43.csv', sha256: SHA_A }], ...overrides,
});

/** 같은 트리거·입력의 활성 업무는 하나로 합쳐지므로(dedupe_key) `tag` 로 입력을 다르게 한다 */
const measurementInput = (ref = KEY, tag = 'x') => ({ inputs: [{ name: 'conversions', ref, kind: 'measurement' }, { name: 'k', ref: `r:${tag}`, kind: 'k' }] });
const count = (db: Db, sql: string, params: (string | number)[] = []): number => Number(db.get(`SELECT count(*) AS n FROM ${sql}`, params)?.['n']);

function rig(t: { after(fn: () => void): void }) {
  const { db, clock } = seededDb(t);
  clock.set(AFTER_W43);
  const agent = addAgent(db, clock);
  const claim = (taskId?: string) => claimNextTask(db, {
    clock, gate: ALLOW_ALL_GATE, workerId: 'w1', actorId: agent, adapter: 'fake-adapter', leaseMs: 60_000, ...(taskId === undefined ? {} : { taskId }),
  });
  return { db, clock, agent, claim };
}

const refusal = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) => error instanceof MeasurementRefusedError && error.code === code);

describe('ISO week keys', () => {
  it('counts weeks from Monday with the first Thursday rule, including 53-week years and year boundaries', () => {
    const table: [string, string][] = [
      ['2026-10-24', '2026-W43'], ['2026-10-19', '2026-W43'], ['2026-10-25', '2026-W43'], ['2026-10-26', '2026-W44'],
      ['2021-01-01', '2020-W53'], ['2024-12-30', '2025-W01'], ['2026-12-31', '2026-W53'], ['2027-01-03', '2026-W53'], ['2027-01-04', '2027-W01'],
    ];
    for (const [day, key] of table) {
      const [year, month, date] = day.split('-').map(Number) as [number, number, number];
      assert.equal(isoWeekKeyOfDate({ year, month, day: date }), key, day);
    }
    assert.equal(isoWeeksInYear(2026), 53);
    assert.equal(isoWeeksInYear(2025), 52);
    assert.deepEqual(isoWeekMonday(2026, 43), { year: 2026, month: 10, day: 19 });
    assert.deepEqual(isoWeekMonday(2025, 1), { year: 2024, month: 12, day: 30 });
  });

  it('rejects keys of weeks that do not exist and malformed keys', () => {
    for (const bad of ['2025-W53', '2026-W00', '2026-W54', '2026-W5', '2026W43', '26-W43', '2026-w43', '']) assert.equal(parseIsoWeekKey(bad), null, bad);
    assert.deepEqual(parseIsoWeekKey('2026-W53'), { year: 2026, week: 53 });
    assert.equal(parseMeasurementRef('measurement:weekly-landing-conversions@2025-W53'), null);
    assert.deepEqual(parseMeasurementRef(KEY), { signalId: 'weekly-landing-conversions', week: '2026-W43' });
  });

  it('places week boundaries at Monday 00:00 in the signal time zone, across a DST change', () => {
    assert.deepEqual(isoWeekPeriod('2026-W43', 'Asia/Seoul'), { start: '2026-10-18T15:00:00.000Z', end: '2026-10-25T15:00:00.000Z', tz: 'Asia/Seoul' });
    // America/New_York: 2026-03-08 에 일광 절약 시간이 시작된다 (주의 길이가 167시간)
    assert.deepEqual(isoWeekPeriod('2026-W10', 'America/New_York'), { start: '2026-03-02T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z', tz: 'America/New_York' });
    assert.equal(isoWeekKeyAt(Date.parse('2026-10-25T14:59:59.000Z'), 'Asia/Seoul'), '2026-W43');
    assert.equal(isoWeekKeyAt(Date.parse('2026-10-25T15:00:00.000Z'), 'Asia/Seoul'), '2026-W44');
    assert.equal(isoWeekKeyAt(Date.parse('2026-10-25T15:00:00.000Z'), 'UTC'), '2026-W43');
    assert.equal(previousIsoWeekKey(Date.parse(AFTER_W43), 'Asia/Seoul'), '2026-W43');
  });
});

describe('task_spec inputs[kind=measurement]', () => {
  const check = (inputs: unknown[]) => validateTaskSpec({ ...minimalDraft(), inputs }, 'draft');
  it('accepts one measurement input naming a signal and an explicit ISO week', () => {
    assert.ok(check([{ name: 'conversions', ref: KEY, kind: 'measurement' }]).ok);
  });
  it('rejects a relative or malformed week, a bad signal id, and more than one measurement input', () => {
    for (const ref of ['measurement:weekly-landing-conversions@previous', 'measurement:weekly-landing-conversions@2025-W53', 'measurement:Bad_Id@2026-W43', 'measurement:x', 'weekly@2026-W43']) {
      const result = check([{ name: 'm', ref, kind: 'measurement' }]);
      assert.ok(!result.ok && result.errors.some((e) => e.path === 'inputs[0].ref' && e.code === 'format'), ref);
    }
    const two = check([{ name: 'a', ref: KEY, kind: 'measurement' }, { name: 'b', ref: 'measurement:weekly-landing-conversions@2026-W44', kind: 'measurement' }]);
    assert.ok(!two.ok && two.errors.some((e) => e.code === 'too_many'));
  });
  it('the pack signal used here is a valid definition', () => {
    assert.ok(validateMeasurementSignal(PACK_SIGNAL).ok);
  });
});

describe('recordMeasurement: who may record, and what', () => {
  it('refuses an agent actor and an unknown actor, and writes nothing', (t) => {
    const { db, clock, agent } = rig(t);
    queuedTask(db, clock, measurementInput(), 'task-wait');
    refusal(() => recordMeasurement(db, { clock }, input({ actorId: agent })), 'not_human');
    refusal(() => recordMeasurement(db, { clock }, input({ actorId: 'actor-nobody' })), 'unknown_actor');
    assert.equal(count(db, 'event'), 0);
    assert.equal(count(db, 'evidence'), 0);
    assert.equal(count(db, 'cost_entry'), 0);
  });

  it('refuses a value without an attachment when the signal requires one', (t) => {
    const { db, clock } = rig(t);
    refusal(() => recordMeasurement(db, { clock }, input({ attachments: [] })), 'attachment_required');
    assert.equal(count(db, 'event'), 0);
  });

  it('refuses malformed values, observations, quality, attachments and minutes', (t) => {
    const { db, clock } = rig(t);
    refusal(() => recordMeasurement(db, { clock }, input({ value: -1 })), 'invalid_value');
    refusal(() => recordMeasurement(db, { clock }, input({ value: Number.NaN })), 'invalid_value');
    refusal(() => recordMeasurement(db, { clock }, input({ observations: 1.5 })), 'invalid_observations');
    refusal(() => recordMeasurement(db, { clock }, input({ quality: 'fine' as never })), 'invalid_quality');
    refusal(() => recordMeasurement(db, { clock }, input({ attachments: [{ ref: 'file:/x', sha256: 'not-a-hash' }] })), 'invalid_attachment');
    refusal(() => recordMeasurement(db, { clock }, input({ attachments: [{ ref: 'file:/x\nsecond line', sha256: SHA_A }] })), 'invalid_attachment');
    refusal(() => recordMeasurement(db, { clock }, input({ minutes: -3 })), 'invalid_minutes');
    refusal(() => recordMeasurement(db, { clock }, input({ signal: { ...PACK_SIGNAL, attachment_required: false } as never })), 'invalid_signal');
    assert.equal(count(db, 'event'), 0);
  });

  it('defaults to the last ended week in the signal time zone and refuses a week that has not ended', (t) => {
    const { db, clock } = rig(t);
    refusal(() => recordMeasurement(db, { clock }, input({ week: '2026-W44' })), 'week_not_ended');
    refusal(() => recordMeasurement(db, { clock }, input({ week: '2025-W53' })), 'invalid_week');
    const recorded = recordMeasurement(db, { clock }, input());
    assert.equal(recorded.week, '2026-W43');
    assert.equal(recorded.key, KEY);
    assert.deepEqual(recorded.period, { start: '2026-10-18T15:00:00.000Z', end: '2026-10-25T15:00:00.000Z', tz: 'Asia/Seoul' });
    const event = db.get<{ source: string; type: string; external_id: string; occurred_at: string; payload: string }>('SELECT * FROM event WHERE idempotency_key = ?', [KEY])!;
    assert.equal(event.source, 'measurement');
    assert.equal(event.type, 'measurement.recorded');
    assert.equal(event.external_id, 'weekly-landing-conversions@2026-W43');
    assert.equal(event.occurred_at, '2026-10-25T15:00:00.000Z');
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    assert.deepEqual(
      { value: payload['value'], observations: payload['observations'], data_quality: payload['data_quality'], week: payload['week'], recorded_by: payload['recorded_by'] },
      { value: 42, observations: 7, data_quality: 'good', week: '2026-W43', recorded_by: OWNER },
    );
    assert.deepEqual(payload['attachments'], [{ ref: 'file:/example/exports/week-43.csv', sha256: SHA_A }]);
  });
});

describe('recordMeasurement: idempotency and conflicts', () => {
  it('the same input N times is one event, one set of evidence for the waiting task and one human_time entry (first value kept)', (t) => {
    const { db, clock } = rig(t);
    queuedTask(db, clock, measurementInput(), 'task-wait');
    const first = recordMeasurement(db, { clock }, input({ minutes: 5 }));
    assert.equal(first.created, true);
    assert.deepEqual(first.attachedTo, ['task-wait']);
    for (let i = 0; i < 4; i += 1) {
      clock.advance(60_000);
      // 같은 파일을 다른 경로에서 붙여도(같은 해시) 같은 입력이다. 분은 비교하지 않는다
      const again = recordMeasurement(db, { clock }, input({ minutes: 9, attachments: [{ ref: 'file:/example/other-copy.csv', sha256: SHA_A }] }));
      assert.equal(again.created, false);
      assert.equal(again.eventId, first.eventId);
      assert.deepEqual(again.attachedTo, []);
    }
    assert.equal(count(db, 'event'), 1);
    const evidence = db.all<{ kind: string; ref: string; content_hash: string; trust_origin: string; task_run_id: string | null }>(
      'SELECT kind, ref, content_hash, trust_origin, task_run_id FROM evidence WHERE task_id = ? ORDER BY kind', ['task-wait'],
    );
    assert.deepEqual(evidence.map((row) => [row.kind, row.ref, row.trust_origin, row.task_run_id]), [
      ['document', 'file:/example/exports/week-43.csv', 'internal', null],
      ['measurement', KEY, 'internal', null],
    ]);
    assert.equal(evidence[0]!.content_hash, `sha256:${SHA_A}`);
    assert.match(evidence[1]!.content_hash, /^sha256:[0-9a-f]{64}$/);
    const cost = db.all<{ task_id: string; category: string; amount_usd: number; units: string }>('SELECT task_id, category, amount_usd, units FROM cost_entry');
    assert.equal(cost.length, 1);
    assert.deepEqual({ ...cost[0], units: JSON.parse(cost[0]!.units) as unknown }, {
      task_id: 'task-wait', category: 'human_time', amount_usd: 0, units: { minutes: 5, source: 'measurement', event_id: first.eventId, measurement: KEY },
    });
  });

  it('a different value, observation count, quality or attachment for the same signal and week is refused, not overwritten', (t) => {
    const { db, clock } = rig(t);
    recordMeasurement(db, { clock }, input());
    refusal(() => recordMeasurement(db, { clock }, input({ value: 43 })), 'conflict');
    refusal(() => recordMeasurement(db, { clock }, input({ observations: 8 })), 'conflict');
    refusal(() => recordMeasurement(db, { clock }, input({ quality: 'poor' })), 'conflict');
    refusal(() => recordMeasurement(db, { clock }, input({ attachments: [{ ref: 'file:/example/exports/week-43.csv', sha256: SHA_B }] })), 'conflict');
    const payload = JSON.parse(db.get<{ payload: string }>('SELECT payload FROM event WHERE idempotency_key = ?', [KEY])!.payload) as { value: number };
    assert.equal(payload.value, 42);
    assert.equal(count(db, 'event'), 1);
    // 다른 주는 다른 이벤트다
    clock.set('2026-11-02T01:00:00.000Z');
    assert.equal(recordMeasurement(db, { clock }, input({ value: 43 })).week, '2026-W44');
    assert.equal(count(db, 'event'), 2);
  });

  it('without minutes no human_time entry is written; without a waiting task the entry has no task', (t) => {
    const { db, clock } = rig(t);
    recordMeasurement(db, { clock }, input());
    assert.equal(count(db, 'cost_entry'), 0);
    clock.set('2026-11-02T01:00:00.000Z');
    const second = recordMeasurement(db, { clock }, input({ minutes: 3 }));
    assert.deepEqual({ ...db.get('SELECT task_id, category FROM cost_entry WHERE id = ?', [second.costEntryId!]) }, { task_id: null, category: 'human_time' });
  });
});

describe('the wait condition in claimNextTask', () => {
  it('a task waiting for a measurement is not claimed: no transition, no run, no attempt; it is listed with a reason', (t) => {
    const { db, clock, claim } = rig(t);
    queuedTask(db, clock, measurementInput(), 'task-wait');
    for (let i = 0; i < 3; i += 1) {
      assert.equal(claim('task-wait').claimed, null);
      assert.deepEqual(claim('task-wait').sentToReview, []);
      clock.advance(5_000);
    }
    assert.equal(taskStatus(db, 'task-wait'), 'queued');
    assert.deepEqual(transitionsOf(db, 'task-wait').map((row) => row.to_status), ['queued']);
    assert.deepEqual(runsOf(db, 'task-wait'), []);
    assert.equal(db.get<{ attempts: number }>('SELECT attempts FROM task WHERE id = ?', ['task-wait'])!.attempts, 0);
    const waits = listMeasurementWaits(db);
    assert.equal(waits.length, 1);
    assert.deepEqual({ ...waits[0], since: undefined }, {
      taskId: 'task-wait', input: 'conversions', ref: KEY, signalId: 'weekly-landing-conversions', week: '2026-W43', since: undefined,
      reason: "measurement_pending: input 'conversions' waits for a human to record signal 'weekly-landing-conversions' for 2026-W43",
    });
  });

  it('other tasks are claimed normally while tasks wait, even when more waiting tasks are older than one claim looks at', (t) => {
    const { db, clock, claim } = rig(t);
    for (let i = 0; i < 25; i += 1) queuedTask(db, clock, measurementInput(KEY, `wait-${i}`), `task-wait-${i}`);
    clock.advance(1_000);
    queuedTask(db, clock, {}, 'task-plain');
    const claimed = claim();
    assert.equal(claimed.claimed?.task.id, 'task-plain');
    assert.equal(claim().claimed, null, 'nothing else is ready');
    assert.equal(listMeasurementWaits(db).length, 25);
  });

  it('once the value is recorded the task is claimed on the next claim and keeps its evidence; a task created afterwards gets evidence at claim time', (t) => {
    const { db, clock, claim } = rig(t);
    queuedTask(db, clock, measurementInput(), 'task-before');
    assert.equal(claim().claimed, null);
    recordMeasurement(db, { clock }, input());
    queuedTask(db, clock, measurementInput(KEY, 'after'), 'task-after');
    assert.equal(count(db, 'evidence WHERE task_id = ?', ['task-after']), 0);
    assert.equal(claim().claimed?.task.id, 'task-before');
    assert.equal(claim().claimed?.task.id, 'task-after');
    for (const id of ['task-before', 'task-after']) {
      assert.deepEqual(db.all<{ kind: string }>('SELECT kind FROM evidence WHERE task_id = ? ORDER BY kind', [id]).map((row) => row.kind), ['document', 'measurement'], id);
      assert.equal(runsOf(db, id).length, 1);
    }
    assert.deepEqual(listMeasurementWaits(db), []);
  });

  it('a measurement for another week or another signal does not release the task', (t) => {
    const { db, clock, claim } = rig(t);
    queuedTask(db, clock, measurementInput('measurement:weekly-landing-conversions@2026-W42'), 'task-w42');
    queuedTask(db, clock, measurementInput('measurement:other-signal@2026-W43', 'other'), 'task-other');
    recordMeasurement(db, { clock }, input());
    assert.equal(claim().claimed, null);
    assert.deepEqual(listMeasurementWaits(db).map((w) => w.taskId), ['task-w42', 'task-other']);
  });
});
