// "AI가 처리함" 요약의 순수 규칙 (apps/daemon/src/review-web/delegation.ts): 상태·시간 문구·24시간 한 줄. 실제 엔진과의 흐름은 test/integration/review-web-decide.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyShadowComparison, SHADOW_MAX_DANGEROUS, SHADOW_MAX_FAILED_SHARE, SHADOW_MIN_AGREEMENT, SHADOW_MIN_COMPARED, shadowPromotionSuggested, type ShadowAgreement } from '@aot/policy';

import { describeDelegated, digestLine, inTime, shadowLines, type DelegatedFacts, type DelegatedItem } from '../../apps/daemon/src/review-web/delegation.ts';

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

// ===== 그림자 모드 문구 (docs/plans/delegate-reviewer.md §5.3) =====

const stats = (over: Partial<ShadowAgreement> = {}): ShadowAgreement => ({
  mandateId: 'm', windowDays: 14, compared: 20, agreed: 18, dangerous: 0, missed: 2, pending: 0, excluded: 0, failed: 0, recent: [], ...over,
});

test('shadow line: conclusion first, with the dangerous count; no ids or English on the first view', () => {
  const lines = shadowLines(stats());
  assert.equal(lines.headline, 'AI 판정 일치 18/20 (2주) · AI가 승인했는데 사람이 막은 건 0');
  assert.ok(!/[A-Za-z]{3,}|[0-9a-f]{12}/.test(lines.headline));
});

test('shadow line with nothing compared says what will make it show up', () => {
  assert.equal(shadowLines(stats({ compared: 0, agreed: 0, missed: 0 })).headline, 'AI 판정 비교 0건 (2주) — 사람 결정이 쌓이면 일치율을 보여 줍니다');
  assert.equal(shadowLines(stats({ compared: 0, agreed: 0, missed: 0 })).suggestion, null);
});

test('the promotion suggestion is text only and appears exactly when the criteria are met', () => {
  const met = shadowLines(stats());
  assert.match(met.suggestion ?? '', /기준을 넘었습니다\. 실제 위임으로 바꾸려면 정책에서 이 위임의 mode를 live로 바꿔 배포하세요\(OTP 필요\)\./);
  assert.equal(met.warning, null);
  assert.equal(shadowLines(stats({ compared: 19, agreed: 19 })).suggestion, null, '19 compared is too few');
  assert.equal(shadowLines(stats({ compared: 20, agreed: 17, dangerous: 0, missed: 3 })).suggestion, null, '85% is too low');
  const danger = shadowLines(stats({ compared: 30, agreed: 29, dangerous: 1, missed: 0 }));
  assert.equal(danger.suggestion, null, 'one dangerous disagreement blocks the suggestion');
  assert.equal(danger.warning, 'AI가 승인했는데 사람이 막은 건 1 — 아직 실제 위임으로 바꾸지 마세요.');
});

test('the promotion criteria: 20 compared, 90% agreement, no dangerous disagreement', () => {
  assert.equal(shadowPromotionSuggested({ compared: SHADOW_MIN_COMPARED - 1, agreed: SHADOW_MIN_COMPARED - 1, dangerous: 0 }), false);
  assert.equal(shadowPromotionSuggested({ compared: 20, agreed: 18, dangerous: 0 }), true);
  assert.equal(shadowPromotionSuggested({ compared: 20, agreed: 17, dangerous: 0 }), false);
  assert.equal(shadowPromotionSuggested({ compared: 20, agreed: 19, dangerous: 1 }), false);
  assert.equal(SHADOW_MIN_AGREEMENT, 0.9);
  assert.equal(SHADOW_MAX_DANGEROUS, 0);
});

test('AI vs human classification on the single question "may it go out"', () => {
  assert.equal(classifyShadowComparison('approve', 'approved'), 'agree');
  assert.equal(classifyShadowComparison('request_changes', 'rejected'), 'agree');
  assert.equal(classifyShadowComparison('request_changes', 'changes_requested'), 'agree');
  assert.equal(classifyShadowComparison('escalate', 'rejected'), 'agree');
  assert.equal(classifyShadowComparison('escalate', 'changes_requested'), 'agree');
  assert.equal(classifyShadowComparison('approve', 'rejected'), 'dangerous');
  assert.equal(classifyShadowComparison('approve', 'changes_requested'), 'dangerous');
  assert.equal(classifyShadowComparison('escalate', 'approved'), 'missed');
  assert.equal(classifyShadowComparison('request_changes', 'approved'), 'missed');
});

test('reviewer failures are shown and block the promotion suggestion when they are more than 10% of compared + failed', () => {
  assert.equal(shadowLines(stats({ failed: 3 })).headline, 'AI 판정 일치 18/20 (2주) · AI가 승인했는데 사람이 막은 건 0 · AI 검토 실패 3건');
  assert.equal(shadowLines(stats({ compared: 0, agreed: 0, missed: 0, failed: 2 })).headline, 'AI 판정 비교 0건 (2주) — 사람 결정이 쌓이면 일치율을 보여 줍니다 · AI 검토 실패 2건');
  assert.equal(shadowLines(stats({ failed: 0 })).headline.includes('실패'), false);
  assert.equal(shadowPromotionSuggested({ compared: 20, agreed: 18, dangerous: 0, failed: 2 }), true, '2/22 is under 10%');
  assert.equal(shadowPromotionSuggested({ compared: 20, agreed: 18, dangerous: 0, failed: 3 }), false, '3/23 is over 10%');
  assert.equal(shadowLines(stats({ failed: 20 })).suggestion, null);
  assert.equal(SHADOW_MAX_FAILED_SHARE, 0.1);
});
