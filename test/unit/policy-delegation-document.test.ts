// 결정 위임 정책 섹션 (ADR-0016, 제안): 파싱·검증·정규화와 변경 등급. 위임이 없는 정책은 지금과 같다(동작·해시 불변).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyChange, parsePolicy, POLICY_FORMAT, type PolicyDocument } from '@aot/policy';
import { policyV1ContentHash } from '@aot/domain';

import { delegationPolicyText, mandateLines } from '../support/delegation.ts';
import { DEFAULT_TEMPLATE_TEXT } from '../support/policy.ts';

const parse = (text: string) => parsePolicy(text);
const ok = (text: string): PolicyDocument => {
  const result = parse(text);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
  return result.ok ? result.value.document : (undefined as never);
};
const errors = (text: string): string[] => {
  const result = parse(text);
  assert.equal(result.ok, false, 'expected the policy to be rejected');
  return result.ok ? [] : result.errors.map((e) => `${e.path}:${e.code}`);
};

test('a policy without a delegation section is unchanged: no key, and the content hash equals the seeded policy-v1 hash', () => {
  const result = parse(DEFAULT_TEMPLATE_TEXT);
  assert.equal(result.ok, true);
  const value = (result as { ok: true; value: { document: PolicyDocument; hash: string } }).value;
  assert.equal('delegation' in value.document, false);
  assert.equal(value.hash, policyV1ContentHash());
  assert.equal(value.document.format, POLICY_FORMAT);
});

test('an empty mandates list normalizes to no section at all (same hash as a policy without the key)', () => {
  const plain = parse(DEFAULT_TEMPLATE_TEXT) as { ok: true; value: { hash: string } };
  const empty = parse(`${DEFAULT_TEMPLATE_TEXT.trimEnd()}\n\ndelegation:\n  mandates: []\n`) as { ok: true; value: { hash: string; document: PolicyDocument } };
  assert.equal(empty.ok, true);
  assert.equal(empty.value.hash, plain.value.hash);
  assert.equal('delegation' in empty.value.document, false);
});

test('a valid mandate is parsed and normalized: sorted lists, durations in seconds, mandates in id order', () => {
  const document = ok(delegationPolicyText([
    { id: 'zeta-mail', actions: ['notify-tool.send', 'mail.send'], targets: ['mailbox:b', 'mailbox:a'], scopes: ['customer', 'internal'] },
    { id: 'alpha-mail', cooldown: '2h' },
  ]));
  const mandates = document.delegation!.mandates;
  assert.deepEqual(mandates.map((m) => m.id), ['alpha-mail', 'zeta-mail']);
  assert.equal(mandates[0]!.cooldown, 7200);
  assert.equal(mandates[1]!.cooldown, 3600);
  assert.deepEqual(mandates[1]!.match, { actions: ['mail.send', 'notify-tool.send'], targets: ['mailbox:a', 'mailbox:b'], scopes: ['customer', 'internal'], recipients: { kind: 'known_contacts' } });
  assert.deepEqual(mandates[0]!.subjects, ['task']);
  assert.equal(mandates[0]!.expires, '2026-12-31');
  assert.equal(mandates[0]!.holder, 'approval-delegate');
  assert.deepEqual(Object.keys(mandates[0]!.limits).sort(), [
    'max_drafts_per_task', 'max_payload_bytes', 'max_per_day', 'max_recipients_per_draft', 'max_review_usd_per_day', 'max_rewrites_per_task', 'max_task_usd',
  ]);
});

test('key order, comments and mandate order do not change the policy version (content hash)', () => {
  const a = parse(delegationPolicyText([{ id: 'a-mail' }, { id: 'b-mail' }])) as { ok: true; value: { hash: string } };
  const b = parse(`${delegationPolicyText([{ id: 'b-mail' }, { id: 'a-mail' }])}\n# trailing comment\n`) as { ok: true; value: { hash: string } };
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.value.hash, b.value.hash);
  const c = parse(delegationPolicyText([{ id: 'a-mail' }, { id: 'b-mail', limits: { max_per_day: 4 } }])) as { ok: true; value: { hash: string } };
  assert.notEqual(a.value.hash, c.value.hash);
});

test('validation rejects: unknown keys, public scope, missing/invalid expires, bad limits, cooldown below risky_change.cooldown, bad guidance, duplicate ids, other subjects', () => {
  const base = (over: Parameters<typeof mandateLines>[0] = {}) => delegationPolicyText([over]);
  assert.ok(errors(base().replace('      subjects: [task]', '      subjects: [task]\n      extra: 1')).includes('delegation.mandates.0.extra:unknown_key'));
  assert.ok(errors(base({ scopes: ['customer', 'public'] })).includes('delegation.mandates.0.match.scopes:public_scope'), 'public can never be delegated');
  assert.ok(errors(base().replace(/\n {6}expires: .*/, '')).includes('delegation.mandates.0.expires:format'), 'expires is required');
  assert.ok(errors(base({ expires: '2026-13-40' })).includes('delegation.mandates.0.expires:format'));
  assert.ok(errors(base({ expires: '2026-02-30' })).includes('delegation.mandates.0.expires:format'), 'a date that does not exist');
  for (const [key, value] of [['max_per_day', 0], ['max_per_day', 1.5], ['max_recipients_per_draft', 0], ['max_task_usd', 0], ['max_review_usd_per_day', -1], ['max_rewrites_per_task', -1], ['max_payload_bytes', 999_999_999]] as const) {
    assert.ok(errors(base({ limits: { [key]: value } })).includes(`delegation.mandates.0.limits.${key}:range`), `${key}=${value}`);
  }
  assert.equal(ok(base({ limits: { max_rewrites_per_task: 0 } })).delegation!.mandates[0]!.limits.max_rewrites_per_task, 0, 'zero rewrites is allowed: the AI may not ask for them');
  assert.ok(errors(base().replace('        max_per_day: 5\n', '')).includes('delegation.mandates.0.limits.max_per_day:range'), 'every limit is required');
  assert.ok(errors(base({ cooldown: '30m' })).includes('delegation.mandates.0.cooldown:range'), 'shorter than risky_change.cooldown (1h)');
  assert.ok(errors(base({ cooldown: 'soon' })).includes('delegation.mandates.0.cooldown:range'));
  assert.ok(errors(base({ guidance: '' })).includes('delegation.mandates.0.guidance:range'));
  assert.ok(errors(base({ guidance: 'x'.repeat(501) })).includes('delegation.mandates.0.guidance:range'));
  assert.ok(errors(delegationPolicyText([{ id: 'dup' }, { id: 'dup' }])).includes('delegation.mandates.1.id:duplicate'));
  assert.ok(errors(base().replace('subjects: [task]', 'subjects: [task, publication]')).includes('delegation.mandates.0.subjects:enum'), 'v1 delegates only draft-approval tasks');
  assert.ok(errors(base({ id: 'Bad_ID' })).includes('delegation.mandates.0.id:format'));
  assert.ok(errors(base({ holder: 'bad holder' })).includes('delegation.mandates.0.holder:format'));
  assert.ok(errors(base({ actions: ['send'] })).includes('delegation.mandates.0.match.actions:type'), "actions are '<tool>.<action>' patterns");
});

test('min_approvers >= 2 forbids delegation: a delegated approval would fill one approver\'s share only', () => {
  const two = delegationPolicyText([{}]).replace('min_approvers: 1', 'min_approvers: 2');
  assert.ok(errors(two).includes('delegation:min_approvers'));
  // 위임이 없는 2인 정책은 그대로 받는다
  assert.equal(parse(DEFAULT_TEMPLATE_TEXT.replace('min_approvers: 1', 'min_approvers: 2')).ok, true);
});

// ===== 변경 등급 =====

const withMandate = (over: Parameters<typeof mandateLines>[0] = {}) => ok(delegationPolicyText([over]));
const without = ok(DEFAULT_TEMPLATE_TEXT);

test('change class: adding the section or a mandate is risky; removing a mandate or the section is normal', () => {
  assert.equal(classifyChange(without, withMandate()).changeClass, 'risky');
  assert.match(classifyChange(without, withMandate()).reasons.join(), /delegation section added/);
  const one = withMandate();
  const two = ok(delegationPolicyText([{}, { id: 'other-mail' }]));
  assert.match(classifyChange(one, two).reasons.join(), /mandate 'other-mail' added/);
  assert.equal(classifyChange(two, one).changeClass, 'normal', 'removing a mandate narrows');
  assert.equal(classifyChange(one, without).changeClass, 'normal', 'removing the section turns delegation off');
  assert.equal(classifyChange(one, one).changeClass, 'normal');
});

test('change class table: every widening of a mandate is risky, every narrowing is normal', () => {
  const base = withMandate();
  const widen: Array<[string, Parameters<typeof mandateLines>[0], RegExp]> = [
    ['actions', { actions: ['notify-tool.send', 'mail.send'] }, /match\.actions widened/],
    ['targets', { targets: ['mailbox:*', 'crm:*'] }, /match\.targets widened/],
    ['scopes', { scopes: ['customer', 'internal'] }, /match\.scopes widened/],
    ['max_per_day', { limits: { max_per_day: 6 } }, /limits\.max_per_day raised/],
    ['max_drafts_per_task', { limits: { max_drafts_per_task: 2 } }, /limits\.max_drafts_per_task raised/],
    ['max_recipients_per_draft', { limits: { max_recipients_per_draft: 2 } }, /limits\.max_recipients_per_draft raised/],
    ['max_payload_bytes', { limits: { max_payload_bytes: 20_001 } }, /limits\.max_payload_bytes raised/],
    ['max_task_usd', { limits: { max_task_usd: 3 } }, /limits\.max_task_usd raised/],
    ['max_rewrites_per_task', { limits: { max_rewrites_per_task: 2 } }, /limits\.max_rewrites_per_task raised/],
    ['max_review_usd_per_day', { limits: { max_review_usd_per_day: 2 } }, /limits\.max_review_usd_per_day raised/],
    ['expires extended', { expires: '2027-01-15' }, /expires extended/],
    ['guidance', { guidance: 'anything goes' }, /guidance changed/],
    ['holder', { holder: 'someone-else' }, /holder changed/],
  ];
  for (const [name, over, pattern] of widen) {
    const change = classifyChange(base, withMandate(over));
    assert.equal(change.changeClass, 'risky', name);
    assert.match(change.reasons.join(), pattern, name);
  }
  // 쿨다운 단축은 길게 시작한 위임에서만 보인다 (위임 cooldown 은 risky_change.cooldown 이상이어야 하므로)
  const long = withMandate({ cooldown: '2h' });
  assert.match(classifyChange(long, withMandate({ cooldown: '1h' })).reasons.join(), /cooldown shortened/);
  assert.equal(classifyChange(long, withMandate({ cooldown: '1h' })).changeClass, 'risky');
  assert.equal(classifyChange(base, withMandate({ cooldown: '2h' })).changeClass, 'normal', 'a longer cooldown narrows');

  const narrow: Array<[string, Parameters<typeof mandateLines>[0]]> = [
    ['max_per_day', { limits: { max_per_day: 4 } }],
    ['max_recipients_per_draft', { limits: { max_recipients_per_draft: 1, max_drafts_per_task: 1 } }],
    ['expires shortened', { expires: '2026-11-30' }],
  ];
  for (const [name, over] of narrow) assert.equal(classifyChange(base, withMandate(over)).changeClass, 'normal', name);
  assert.equal(classifyChange(base, withMandate({ limits: { max_per_day: 1, max_task_usd: 1 } })).changeClass, 'normal', 'lowering limits narrows');
});

// ===== 받는 사람 규칙 (D-B11) =====

test('a mandate without a recipient rule is refused', () => {
  assert.deepEqual(errors(delegationPolicyText([{ recipients: null }])), ['delegation.mandates.0.match.recipients:required']);
});

test('recipient rules: known_contacts and exact, normalized domains are accepted', () => {
  const known = ok(delegationPolicyText([{ recipients: { kind: 'known_contacts' } }])).delegation!.mandates[0]!.match.recipients;
  assert.deepEqual(known, { kind: 'known_contacts' });
  const domains = ok(delegationPolicyText([{ recipients: { kind: 'domains', domains: [' Shop.Example.COM ', 'example.com', 'example.com'] } }])).delegation!.mandates[0]!.match.recipients;
  assert.deepEqual(domains, { kind: 'domains', domains: ['example.com', 'shop.example.com'] });
});

test('public free-mail domains are refused in a domains rule, whatever the case', () => {
  for (const domain of ['gmail.com', 'NAVER.com', 'daum.net', 'hanmail.net', 'kakao.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me']) {
    assert.deepEqual(errors(delegationPolicyText([{ recipients: { kind: 'domains', domains: ['example.com', domain] } }])), ['delegation.mandates.0.match.recipients.domains.1:free_mail_domain'], domain);
  }
});

test('domains rules refuse wildcards, addresses, sub-domain patterns, empty lists and unknown kinds', () => {
  for (const domain of ['*.example.com', '*', '@example.com', 'a@example.com', '.example.com', 'example', 'exa mple.com', 'example.com/x']) {
    assert.deepEqual(errors(delegationPolicyText([{ recipients: { kind: 'domains', domains: [domain] } }])), ['delegation.mandates.0.match.recipients.domains.0:format'], domain);
  }
  assert.deepEqual(errors(delegationPolicyText([{ recipients: { kind: 'domains', domains: [] } }])), ['delegation.mandates.0.match.recipients.domains:type']);
  const text = delegationPolicyText([{}]).replace('recipients: { kind: known_contacts }', 'recipients: { kind: anyone }');
  assert.deepEqual(errors(text), ['delegation.mandates.0.match.recipients.kind:enum']);
});

test('changing the recipient rule is a risky change only when it widens', () => {
  const base = ok(delegationPolicyText([{ recipients: { kind: 'domains', domains: ['a.example.com'] } }]));
  const same = ok(delegationPolicyText([{ recipients: { kind: 'domains', domains: ['a.example.com'] } }]));
  const wider = ok(delegationPolicyText([{ recipients: { kind: 'domains', domains: ['a.example.com', 'b.example.com'] } }]));
  const narrower = ok(delegationPolicyText([{ recipients: { kind: 'domains', domains: ['a.example.com'] } }]));
  const kind = ok(delegationPolicyText([{ recipients: { kind: 'known_contacts' } }]));
  assert.equal(classifyChange(base, same).reasons.some((r) => r.includes('recipients')), false);
  assert.equal(classifyChange(base, wider).reasons.some((r) => r.includes('match.recipients widened')), true);
  assert.equal(classifyChange(wider, narrower).reasons.some((r) => r.includes('recipients')), false);
  assert.equal(classifyChange(base, kind).reasons.some((r) => r.includes('match.recipients changed')), true);
});
