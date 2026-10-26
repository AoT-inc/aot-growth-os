import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRepeatFilter } from '../../apps/daemon/src/log-throttle.ts';

test('the same message for the same key is logged once, again after the repeat interval, and at once when it changes or after clear', () => {
  let now = 0;
  const filter = createRepeatFilter(() => now, 1000);
  assert.equal(filter.shouldLog('t1', 'usage_limit: x'), true);
  now += 5;
  assert.equal(filter.shouldLog('t1', 'usage_limit: x'), false);
  assert.equal(filter.shouldLog('t2', 'usage_limit: x'), true, 'another task has its own line');
  now += 994;
  assert.equal(filter.shouldLog('t1', 'usage_limit: x'), false);
  now += 1;
  assert.equal(filter.shouldLog('t1', 'usage_limit: x'), true, 'the repeat interval passed');
  assert.equal(filter.shouldLog('t1', 'login_required: y'), true, 'a different message is news');
  filter.clear('t1');
  assert.equal(filter.shouldLog('t1', 'login_required: y'), true, 'after the task was validated the next problem is news again');
});
