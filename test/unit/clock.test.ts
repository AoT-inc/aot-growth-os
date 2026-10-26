import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { FakeClock, systemClock } from '@aot/domain';

test('FakeClock only moves when told to', () => {
  const clock = new FakeClock('2026-10-19T00:00:00.000Z');
  assert.equal(clock.nowIso(), '2026-10-19T00:00:00.000Z');
  clock.advance(30_000);
  assert.equal(clock.nowIso(), '2026-10-19T00:00:30.000Z');
  clock.set('2026-10-20T00:00:00.000Z');
  assert.equal(clock.nowMs(), Date.parse('2026-10-20T00:00:00.000Z'));
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => new FakeClock('not a date'), TypeError);
});

test('ISO strings from Clock sort in time order (lease expiry can be compared as text)', () => {
  const clock = new FakeClock('2026-10-19T23:59:59.999Z');
  const before = clock.nowIso();
  clock.advance(1);
  assert.ok(before < clock.nowIso());
});

test('node:test fake timers: 30s of heartbeats without waiting', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let beats = 0;
  const handle = setInterval(() => (beats += 1), 10_000);
  t.mock.timers.tick(30_000);
  clearInterval(handle);
  assert.equal(beats, 3);
});

test('systemClock returns a parseable ISO timestamp', () => {
  assert.ok(Number.isFinite(Date.parse(systemClock.nowIso())));
  mock.reset();
});
