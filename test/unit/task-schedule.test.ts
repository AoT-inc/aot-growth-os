// 루틴 발화 시각 계산 (A6-U9): cron 부분집합 + IANA 시간대, 다음 슬롯, 놓친 슬롯, catch_up.
// 순수 함수라 시계도 DB 도 쓰지 않는다. 시각은 모두 인자다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { latestSlot, missedSlots, nextSlot, parseSchedule, planFirings, ScheduleError, slotsBetween } from '@aot/task-engine';

const ms = (iso: string): number => Date.parse(iso);
const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());
const slots = (schedule: string, after: string, until: string): string[] => slotsBetween(parseSchedule(schedule), ms(after), ms(until)).map((s) => iso(s)!);

test('Asia/Seoul Monday 09:00: the next slot is Monday 00:00Z, strictly after the given instant', () => {
  const schedule = parseSchedule('0 9 * * 1 Asia/Seoul');
  assert.equal(schedule.tz, 'Asia/Seoul');
  // 2026-10-24 is a Saturday
  assert.equal(iso(nextSlot(schedule, ms('2026-10-24T00:00:00.000Z'))), '2026-10-26T00:00:00.000Z');
  // exactly on a slot: the slot itself is not "after"
  assert.equal(iso(nextSlot(schedule, ms('2026-10-26T00:00:00.000Z'))), '2026-11-02T00:00:00.000Z');
  assert.equal(iso(nextSlot(schedule, ms('2026-10-25T23:59:59.999Z'))), '2026-10-26T00:00:00.000Z');
  // Sunday 15:00Z is already Monday 00:00 in Seoul, 9 hours before the slot
  assert.equal(iso(nextSlot(schedule, ms('2026-10-25T15:00:00.000Z'))), '2026-10-26T00:00:00.000Z');
  // the 7 spelling of Sunday and weekday names
  assert.equal(iso(nextSlot(parseSchedule('0 9 * * 7 Asia/Seoul'), ms('2026-10-24T00:00:00.000Z'))), '2026-10-25T00:00:00.000Z');
  assert.equal(iso(nextSlot(parseSchedule('0 9 * * mon Asia/Seoul'), ms('2026-10-24T00:00:00.000Z'))), '2026-10-26T00:00:00.000Z');
});

test('field syntax: lists, ranges, steps, wildcard, names', () => {
  assert.deepEqual(slots('0,30 9-10 * * * UTC', '2026-10-24T00:00:00.000Z', '2026-10-24T23:59:00.000Z'),
    ['2026-10-24T09:00:00.000Z', '2026-10-24T09:30:00.000Z', '2026-10-24T10:00:00.000Z', '2026-10-24T10:30:00.000Z']);
  assert.deepEqual(slots('*/20 3 * * * UTC', '2026-10-24T00:00:00.000Z', '2026-10-24T23:59:00.000Z'),
    ['2026-10-24T03:00:00.000Z', '2026-10-24T03:20:00.000Z', '2026-10-24T03:40:00.000Z']);
  assert.deepEqual(parseSchedule('10-40/10 0 1 1 * UTC').minutes, [10, 20, 30, 40]);
  // Monday-Friday names; 2026-10-24 and 25 are the weekend
  assert.deepEqual(slots('0 12 * * MON-FRI UTC', '2026-10-22T00:00:00.000Z', '2026-10-27T23:59:00.000Z'),
    ['2026-10-22T12:00:00.000Z', '2026-10-23T12:00:00.000Z', '2026-10-26T12:00:00.000Z', '2026-10-27T12:00:00.000Z']);
  assert.deepEqual(slots('0 0 1 JAN,JUL * UTC', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), ['2026-07-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
});

test('day-of-month and day-of-week both restricted: either one matches (standard cron); a wildcard one does not widen', () => {
  // 2026-11-13 is a Friday; Fridays in Nov 2026: 6, 13, 20, 27
  assert.deepEqual(slots('0 0 13 * 5 UTC', '2026-11-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z'),
    ['2026-11-06T00:00:00.000Z', '2026-11-13T00:00:00.000Z', '2026-11-20T00:00:00.000Z', '2026-11-27T00:00:00.000Z']);
  assert.deepEqual(slots('0 0 13 * * UTC', '2026-11-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z'), ['2026-11-13T00:00:00.000Z']);
  assert.deepEqual(slots('0 0 1,11 * 5 UTC', '2026-11-01T00:00:00.000Z', '2026-11-14T00:00:00.000Z'),
    ['2026-11-06T00:00:00.000Z', '2026-11-11T00:00:00.000Z', '2026-11-13T00:00:00.000Z']);
  // a day field that starts with '*' counts as a wildcard (Vixie cron): both must match, so no Friday here is day 1, 11, 21 or 31
  assert.deepEqual(slots('0 0 */10 * 5 UTC', '2026-11-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z'), []);
});

test('a schedule that can never fire has no next slot', () => {
  assert.equal(nextSlot(parseSchedule('0 0 30 2 * UTC'), ms('2026-01-01T00:00:00.000Z')), null);
  assert.equal(iso(nextSlot(parseSchedule('0 0 29 2 * UTC'), ms('2026-01-01T00:00:00.000Z'))), '2028-02-29T00:00:00.000Z');
});

test('America/New_York spring forward: a local time that does not exist moves forward by the gap; slots that collapse are listed once', () => {
  // 2026-03-08 02:00 EST -> 03:00 EDT (clocks jump at 07:00Z)
  assert.deepEqual(slots('30 2 * * * America/New_York', '2026-03-07T00:00:00.000Z', '2026-03-10T00:00:00.000Z'), [
    '2026-03-07T07:30:00.000Z', // 02:30 EST
    '2026-03-08T07:30:00.000Z', // 02:30 does not exist: 03:30 EDT
    '2026-03-09T06:30:00.000Z', // 02:30 EDT
  ]);
  assert.deepEqual(slots('0 2 * * * America/New_York', '2026-03-08T00:00:00.000Z', '2026-03-08T23:59:00.000Z'), ['2026-03-08T07:00:00.000Z']);
  // 02:00 and 03:00 are the same instant that day: one slot, not two
  assert.deepEqual(slots('0 2,3 * * * America/New_York', '2026-03-08T00:00:00.000Z', '2026-03-08T23:59:00.000Z'), ['2026-03-08T07:00:00.000Z']);
  // a schedule just after the gap is unaffected
  assert.deepEqual(slots('0 4 * * * America/New_York', '2026-03-07T12:00:00.000Z', '2026-03-09T12:00:00.000Z'), ['2026-03-08T08:00:00.000Z', '2026-03-09T08:00:00.000Z']);
});

test('America/New_York fall back: a local time that occurs twice fires once, at the first occurrence', () => {
  // 2026-11-01 02:00 EDT -> 01:00 EST (clocks fall back at 06:00Z); 01:30 happens at 05:30Z (EDT) and 06:30Z (EST)
  assert.deepEqual(slots('30 1 * * * America/New_York', '2026-10-31T00:00:00.000Z', '2026-11-03T00:00:00.000Z'), [
    '2026-10-31T05:30:00.000Z', // 01:30 EDT
    '2026-11-01T05:30:00.000Z', // first 01:30 (EDT) — the second one (06:30Z) is not a slot
    '2026-11-02T06:30:00.000Z', // 01:30 EST
  ]);
  assert.equal(iso(nextSlot(parseSchedule('30 1 * * * America/New_York'), ms('2026-11-01T05:30:00.000Z'))), '2026-11-02T06:30:00.000Z');
  // an hourly schedule: wall-clock 01:00 once (05:00Z), then 02:00 EST (07:00Z); nothing at 06:00Z
  assert.deepEqual(slots('0 * * * * America/New_York', '2026-11-01T03:30:00.000Z', '2026-11-01T08:00:00.000Z'), [
    '2026-11-01T04:00:00.000Z', '2026-11-01T05:00:00.000Z', '2026-11-01T07:00:00.000Z', '2026-11-01T08:00:00.000Z',
  ]);
  // a time outside the overlap is unaffected
  assert.deepEqual(slots('0 9 * * * America/New_York', '2026-10-31T00:00:00.000Z', '2026-11-02T23:59:00.000Z'),
    ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z']);
});

test('latestSlot finds the newest slot in (after, until] and null when there is none', () => {
  const weekly = parseSchedule('0 9 * * 1 Asia/Seoul');
  assert.equal(iso(latestSlot(weekly, ms('2026-09-28T00:00:00.000Z'), ms('2026-10-21T00:00:00.000Z'))), '2026-10-19T00:00:00.000Z');
  assert.equal(latestSlot(weekly, ms('2026-10-19T00:00:00.000Z'), ms('2026-10-25T00:00:00.000Z')), null, 'the lower bound is exclusive');
  assert.equal(iso(latestSlot(weekly, ms('2026-10-18T00:00:00.000Z'), ms('2026-10-19T00:00:00.000Z'))), '2026-10-19T00:00:00.000Z', 'the upper bound is inclusive');
});

test('invalid schedules are rejected with a reason', () => {
  const cases: [string, RegExp][] = [
    ['', /expected 6 space-separated tokens.*got 0/],
    ['0 9 * * 1', /time zone is required/],
    ['0 9 * * 1 Asia/Seoul extra', /got 7/],
    ['@daily UTC', /got 2/],
    ['60 9 * * * UTC', /minute: 60 is out of range 0-59/],
    ['0 24 * * * UTC', /hour: 24 is out of range 0-23/],
    ['0 9 0 * * UTC', /day-of-month: 0 is out of range 1-31/],
    ['0 9 32 * * UTC', /day-of-month: 32 is out of range/],
    ['0 9 * 13 * UTC', /month: 13 is out of range 1-12/],
    ['0 9 * * 8 UTC', /day-of-week: 8 is out of range 0-7/],
    ['*/0 * * * * UTC', /step '0' must be a positive integer/],
    ['*/x * * * * UTC', /step 'x'/],
    ['30-10 * * * * UTC', /range '30-10' is reversed/],
    ['1-2-3 * * * * UTC', /malformed range/],
    ['a * * * * UTC', /minute: 'a' is not a number/],
    ['0 9 L * * UTC', /day-of-month: 'L' is not a number/],
    ['0 9 ? * * UTC', /day-of-month: '\?'/],
    ['0 9 * * 5#2 UTC', /day-of-week: '5#2'/],
    ['5/15 * * * * UTC', /a step needs '\*' or a range/],
    ['1,,2 * * * * UTC', /empty list item/],
    ['0 9 * FOO * UTC', /month: 'FOO' is not a number or name/],
    ['0 9 * * 1 +09:00', /not an IANA zone name/],
    ['0 9 * * 1 Mars/Olympus_Mons', /time zone 'Mars\/Olympus_Mons' is unknown/],
  ];
  for (const [text, reason] of cases) {
    assert.throws(() => parseSchedule(text), (error) => error instanceof ScheduleError && reason.test(error.reason) && error.source === text, `${text} -> ${reason}`);
  }
});

// ===== catch_up =====

const WEEKLY = parseSchedule('0 9 * * 1 Asia/Seoul'); // Monday 00:00Z
const LAST = ms('2026-09-28T00:00:00.000Z'); // the last firing; then the daemon was stopped for three weeks
const TOLERANCE = 10 * 60_000;
const plan = (catchUp: 'skip' | 'run_once', now: string) => ({ schedule: WEEKLY, catchUp, afterMs: LAST, nowMs: ms(now), lateToleranceMs: TOLERANCE });

test('three weeks stopped, back on Monday 00:30Z (the 10-19 slot is 30 minutes late): skip fires nothing, run_once fires the newest slot only', () => {
  const now = '2026-10-19T00:30:00.000Z';
  assert.deepEqual(planFirings(plan('skip', now)), []);
  assert.deepEqual(missedSlots(plan('skip', now)), ['2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z', '2026-10-19T00:00:00.000Z']);
  assert.deepEqual(planFirings(plan('run_once', now)), ['2026-10-19T00:00:00.000Z']);
  assert.deepEqual(missedSlots(plan('run_once', now)), ['2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z']);
});

test('back up within the tolerance of a slot: skip still fires that slot (it is late, not missed) and drops the older ones', () => {
  const now = '2026-10-19T00:05:00.000Z';
  assert.deepEqual(planFirings(plan('skip', now)), ['2026-10-19T00:00:00.000Z']);
  assert.deepEqual(missedSlots(plan('skip', now)), ['2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z']);
  assert.deepEqual(planFirings(plan('run_once', now)), ['2026-10-19T00:00:00.000Z']);
});

test('back up mid-week: skip waits for the next slot, run_once catches up with the newest missed one', () => {
  const now = '2026-10-22T12:00:00.000Z';
  assert.deepEqual(planFirings(plan('skip', now)), []);
  assert.deepEqual(planFirings(plan('run_once', now)), ['2026-10-19T00:00:00.000Z']);
  assert.equal(iso(nextSlot(WEEKLY, ms(now))), '2026-10-26T00:00:00.000Z');
});

test('nothing is due before the next slot, whatever the policy', () => {
  for (const catchUp of ['skip', 'run_once'] as const) {
    assert.deepEqual(planFirings({ ...plan(catchUp, '2026-10-02T12:00:00.000Z') }), []);
    assert.deepEqual(missedSlots({ ...plan(catchUp, '2026-10-02T12:00:00.000Z') }), []);
  }
});
