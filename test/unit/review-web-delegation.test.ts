// "AI가 처리함" 요약의 순수 규칙 (apps/daemon/src/review-web/delegation.ts): 상태·시간 문구·24시간 한 줄. 실제 엔진과의 흐름은 test/integration/review-web-decide.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeDelegated, digestLine, inTime, type DelegatedFacts, type DelegatedItem } from '../../apps/daemon/src/review-web/delegation.ts';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const facts = (over: Partial<DelegatedFacts> = {}): DelegatedFacts => ({ taskStatus: 'needs_review', humanStopped: false, stillValid: true, sendAtMs: NOW + 50 * 60_000, lastAtMs: NOW - 60_000, nowMs: NOW, ...over });
const item = (over: Partial<DelegatedItem> = {}): DelegatedItem => ({
  state: 'sent', when: '', cancellable: false, taskId: 't', what: '메일 1통', why: '정기 안내', atMs: NOW - 3_600_000, hash: null, count: 1, ...over,
});

test('relative send time: soon, minutes, hours', () => {
  assert.equal(inTime(null, NOW), '곧');
  assert.equal(inTime(NOW + 30_000, NOW), '곧');
  assert.equal(inTime(NOW + 50 * 60_000, NOW), '50분 뒤');
  assert.equal(inTime(NOW + 3 * 3_600_000, NOW), '3시간 뒤');
});

test('a delegated approval that is still valid and not sent is cancellable and says when it goes out', () => {
  const d = describeDelegated(facts());
  assert.deepEqual([d.state, d.when, d.cancellable], ['waiting', '50분 뒤 나감', true]);
  assert.equal(describeDelegated(facts({ taskStatus: 'queued', sendAtMs: NOW - 1 })).when, '곧 나감', 'released but not started yet: still cancellable');
  assert.equal(describeDelegated(facts({ taskStatus: 'queued', sendAtMs: NOW - 1 })).cancellable, true);
});

test('once it is running, sent, failed or cancelled it can no longer be cancelled', () => {
  assert.deepEqual([describeDelegated(facts({ taskStatus: 'running' })).state, describeDelegated(facts({ taskStatus: 'running' })).cancellable], ['sending', false]);
  const sent = describeDelegated(facts({ taskStatus: 'completed', lastAtMs: NOW - 86_400_000 }));
  assert.deepEqual([sent.state, sent.when, sent.cancellable], ['sent', '어제 나감', false]);
  assert.equal(describeDelegated(facts({ taskStatus: 'failed' })).state, 'failed');
  const cancelled = describeDelegated(facts({ humanStopped: true }));
  assert.deepEqual([cancelled.state, cancelled.cancellable], ['cancelled', false]);
  assert.equal(describeDelegated(facts({ taskStatus: 'cancelled' })).state, 'cancelled');
});

test('when the engine no longer counts the delegated approval (paused, revoked, policy changed) the item goes back to the person', () => {
  const d = describeDelegated(facts({ stillValid: false }));
  assert.deepEqual([d.state, d.cancellable], ['back', false]);
  assert.match(d.when, /사람이 다시 결정/);
});

test('no first-view text carries ids, hashes, state codes, ISO times or English', () => {
  for (const d of [facts(), facts({ stillValid: false }), facts({ taskStatus: 'completed' }), facts({ taskStatus: 'running' }), facts({ taskStatus: 'failed' }), facts({ humanStopped: true })].map(describeDelegated)) {
    assert.ok(!/[A-Za-z]{3,}|\d{4}-\d{2}-\d{2}|[0-9a-f]{12}/.test(d.when), d.when);
  }
});

test('digest line counts the last 24 hours only, and says how many can still be cancelled', () => {
  assert.equal(digestLine([], NOW), null);
  assert.equal(digestLine([item({ state: 'cancelled' }), item({ state: 'back' }), item({ atMs: NOW - 2 * 86_400_000 })], NOW), null, 'cancelled, handed back and older than a day do not count');
  assert.equal(digestLine([item(), item()], NOW), 'AI가 지난 24시간에 2건 처리함');
  assert.equal(digestLine([item(), item({ state: 'waiting', cancellable: true })], NOW), 'AI가 지난 24시간에 2건 처리함. 1건은 아직 나가지 않았고 취소할 수 있습니다');
});
