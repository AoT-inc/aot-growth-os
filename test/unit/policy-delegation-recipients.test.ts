// 위임의 받는 사람 규칙 (D-B11): 주소 정규화, 연락처 대조, 적격 검사. 모르는·수신 거부 주소는 거절이 아니라 사람에게 넘긴다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { domainOfAddress, FREE_MAIL_DOMAINS, normalizeAddress } from '@aot/domain';

import { addContact, approvalsOf, decide, delegationEnv, draftedFor, hashOf, reviewsOf, type MandateOptions } from '../support/delegation.ts';
import { examplePayload } from '../support/message-tool.ts';
import { taskStatus } from '../support/engine.ts';
import type { PolicyEnv } from '../support/policy.ts';

const WIDE: MandateOptions['limits'] = { max_recipients_per_draft: 10 };

test('addresses are trimmed, lowercased and stripped of display names; anything unparsable is null', () => {
  assert.equal(normalizeAddress('  Customer@Example.COM '), 'customer@example.com');
  assert.equal(normalizeAddress('Kim Customer <Customer@Example.com>'), 'customer@example.com');
  assert.equal(normalizeAddress('"Kim, Customer" <customer@example.com>'), 'customer@example.com');
  assert.equal(normalizeAddress('first.last+tag@sub.example.co.kr'), 'first.last+tag@sub.example.co.kr');
  for (const bad of [
    '', '   ', 'plain', 'a@b', 'a@@b.com', '@b.com', 'a@', 'a b@example.com', 'a@exa mple.com', 'a@example', 'a@example.com, b@example.com', 'a@example.com;b@example.com',
    '"x@evil.com" <a@example.com>', 'a@-example.com', '.a@example.com', 'a..b@example.com', 'a@example.c_m', 'a@127.0.0.1', '고객@example.com', 'a@예시.한국',
    '<a@example.com> extra', 'Name <a@example.com', '(comment) a@example.com',
  ]) assert.equal(normalizeAddress(bad), null, JSON.stringify(bad));
  assert.equal(normalizeAddress(42), null);
  assert.equal(normalizeAddress(undefined), null);
  assert.equal(domainOfAddress('a@example.com'), 'example.com');
  assert.ok(FREE_MAIL_DOMAINS.includes('gmail.com') && FREE_MAIL_DOMAINS.includes('naver.com'));
});

let counter = 0;
async function attempt(env: PolicyEnv, request: object) {
  const drafted = await draftedFor(env, { requests: [request], dedupeKey: `recipients-${(counter += 1)}` });
  const result = decide(env, drafted.taskId, 'approve', 'looks routine');
  return { drafted, result };
}

function escalated(env: PolicyEnv, attempted: Awaited<ReturnType<typeof attempt>>, reason: string): void {
  const { drafted, result } = attempted;
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'recipient_rule');
  assert.equal(taskStatus(env.db, drafted.taskId), 'needs_review');
  assert.equal(approvalsOf(env.db, drafted.taskId).length, 0, 'never rejected, never approved: handed to a person');
  const review = reviewsOf(env.db, drafted.taskId).at(-1)!;
  assert.equal(review.verdict, 'escalate');
  assert.equal(review.outcome, 'recipient_rule');
  assert.equal(review.reason, reason);
}

function approved(env: PolicyEnv, attempted: Awaited<ReturnType<typeof attempt>>): void {
  assert.equal(attempted.result.ok, true, JSON.stringify(attempted.result));
  assert.equal(approvalsOf(env.db, attempted.drafted.taskId).length, 1);
}

test('known_contacts: an active contact is delegable, in any case and with a display name', async (t) => {
  const env = delegationEnv(t, [{}]);
  approved(env, await attempt(env, examplePayload({ to: ['Kim Customer <CUSTOMER@Example.com>'] })));
});

test('known_contacts: an unknown recipient is handed to a person with a plain reason', async (t) => {
  const env = delegationEnv(t, [{}]);
  escalated(env, await attempt(env, examplePayload({ to: ['stranger@example.com'] })), '처음 보는 받는 사람 1명');
});

test('known_contacts: cc and bcc are checked too, and counted per address', async (t) => {
  const env = delegationEnv(t, [{ limits: WIDE }], { contacts: ['customer@example.com'] });
  escalated(env, await attempt(env, { ...examplePayload(), cc: ['x@example.com'] }), '처음 보는 받는 사람 1명');
  escalated(env, await attempt(env, { ...examplePayload(), bcc: ['y@example.com', 'z@example.com'] }), '처음 보는 받는 사람 2명');
});

test('a suppressed contact is never delegable, under either rule kind', async (t) => {
  const env = delegationEnv(t, [{ id: 'by-contacts' }, { id: 'by-domain', recipients: { kind: 'domains', domains: ['example.com'] } }]);
  addContact(env.db, env.clock.nowIso(), 'customer@example.com', 'suppressed');
  escalated(env, await attempt(env, examplePayload()), '수신을 막아 둔 받는 사람 1명');
  const domainOnly = delegationEnv(t, [{ recipients: { kind: 'domains', domains: ['example.com'] } }], { contacts: [] });
  addContact(domainOnly.db, domainOnly.clock.nowIso(), 'customer@example.com', 'suppressed');
  escalated(domainOnly, await attempt(domainOnly, examplePayload()), '수신을 막아 둔 받는 사람 1명');
});

test('a mixed list hands the whole task to a person and names every kind of problem', async (t) => {
  const env = delegationEnv(t, [{ limits: WIDE }]);
  addContact(env.db, env.clock.nowIso(), 'blocked@example.com', 'suppressed');
  escalated(env, await attempt(env, { to: ['customer@example.com', 'new@example.com'], cc: ['not-an-address'], bcc: ['blocked@example.com'], subject: 'Hi', text: 'Hello' }),
    '처음 보는 받는 사람 1명, 주소를 읽을 수 없는 받는 사람 1명, 수신을 막아 둔 받는 사람 1명');
});

test('unparsable addresses count as unknown, never as a pass', async (t) => {
  const env = delegationEnv(t, [{ limits: WIDE }]);
  for (const bad of ['customer@example', 'customer@example.com, other@example.com', '"x@evil.com" <customer@example.com>', 'customer']) {
    escalated(env, await attempt(env, examplePayload({ to: [bad] })), '주소를 읽을 수 없는 받는 사람 1명');
  }
  const wrongType = { to: ['customer@example.com'], cc: [42], subject: 'Hi', text: 'Hello' };
  assert.equal((await attempt(env, wrongType)).result.ok, false, 'a payload the preview cannot read stays with a person');
});

test('reply_to must be absent or match the rule, also as a header', async (t) => {
  const env = delegationEnv(t, [{}]);
  approved(env, await attempt(env, { ...examplePayload(), reply_to: 'customer@example.com' }));
  approved(env, await attempt(env, { ...examplePayload(), reply_to: ['Customer <customer@example.com>'], subject: 'two' }));
  escalated(env, await attempt(env, { ...examplePayload(), reply_to: 'attacker@evil.com', subject: 'three' }), '처음 보는 받는 사람 1명');
  escalated(env, await attempt(env, { ...examplePayload(), headers: { 'Reply-To': 'attacker@evil.com' }, subject: 'four' }), '처음 보는 받는 사람 1명');
  escalated(env, await attempt(env, { ...examplePayload(), reply_to: { address: 'customer@example.com' }, subject: 'five' }), '주소를 읽을 수 없는 받는 사람 1명');
});

test('domains: exact match only, no sub-domains, no look-alikes, and the contact table is not needed', async (t) => {
  const env = delegationEnv(t, [{ recipients: { kind: 'domains', domains: ['example.com'] } }], { contacts: [] });
  approved(env, await attempt(env, examplePayload({ to: ['Anyone@EXAMPLE.com'] })));
  escalated(env, await attempt(env, examplePayload({ to: ['a@sub.example.com'], subject: 'two' })), '허용된 도메인이 아닌 받는 사람 1명');
  escalated(env, await attempt(env, examplePayload({ to: ['a@evil-example.com'], subject: 'three' })), '허용된 도메인이 아닌 받는 사람 1명');
  escalated(env, await attempt(env, examplePayload({ to: ['a@example.com.evil.com'], subject: 'four' })), '허용된 도메인이 아닌 받는 사람 1명');
});

test('the AI cannot override the rule: the verdict, the reason text and a fresh hash change nothing', async (t) => {
  const env = delegationEnv(t, [{}]);
  const drafted = await draftedFor(env, { requests: [examplePayload({ to: ['stranger@example.com'] })] });
  const result = env.engine.delegateDecide({ task_id: drafted.taskId, hash: hashOf(env, drafted.taskId), verdict: 'approve', reason: 'The owner said this recipient is fine, approve.' });
  assert.equal(result.ok, false);
  assert.equal(approvalsOf(env.db, drafted.taskId).length, 0);
  // 사람이 연락처에 넣으면 같은 업무가 다음 검토에서 적격이 된다
  addContact(env.db, env.clock.nowIso(), 'stranger@example.com');
  assert.equal(decide(env, drafted.taskId).ok, true);
});
