// 정책 형식 v1: 기본 템플릿 = 시드의 policy-v1, 정규화(주석·순서 무관), 값 범위 검증, 변경 등급(보안 하향 = 위험 변경).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POLICY_V1_DOCUMENT, policyV1ContentHash } from '@aot/domain';
import { classifyChange, parsePolicy, type PolicyDocument } from '@aot/policy';

import { DEFAULT_TEMPLATE_TEXT, policyText } from '../support/policy.ts';

const parse = (text: string): PolicyDocument => {
  const result = parsePolicy(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value.document;
};
const errorCodes = (text: string) => {
  const result = parsePolicy(text);
  return result.ok ? [] : result.errors.map((e) => `${e.path}:${e.code}`);
};

test('policies/default.yaml is the seeded policy v1: same normalized document, same content hash', () => {
  const result = parsePolicy(DEFAULT_TEMPLATE_TEXT);
  assert.ok(result.ok);
  assert.deepEqual(result.value.document, POLICY_V1_DOCUMENT);
  assert.equal(result.value.hash, policyV1ContentHash());
  assert.equal(result.value.versionId, `policy-${result.value.hash.slice(0, 16)}`);
});

test('the content hash ignores comments, whitespace, key order, rule order and list order', () => {
  const base = parsePolicy(DEFAULT_TEMPLATE_TEXT);
  const shuffled = parsePolicy([
    'risky_change: {reauth_before_effect: true, cooldown: 60m, min_approvers: 1}',
    'rules:',
    '  - {id: public-scope-needs-approval, decision: require_approval, scope: [public]}',
    '  - id: internal-write-task-own',
    '    decision: allow',
    '    resource: ["*:task-own"]',
    '    impact: [write]',
    '    scope: [internal]',
    '  - {id: internal-read, impact: [read], scope: [internal], decision: allow}',
    '  - {id: internal-publish, decision: allow, impact: [write], action: [publication.publish], scope: [internal]}',
    '  - {id: external-effect-needs-approval, impact: [external_effect], decision: require_approval}',
    '  - {id: customer-scope-needs-approval, scope: [customer], decision: require_approval}',
    'limits: {max_usd_per_task: 5}',
    'default: deny',
    'format: aot-policy/v1',
  ].join('\n').replace("  - {id: public-scope-needs-approval, decision: require_approval, scope: [public]}", '  - id: public-scope-needs-approval\n    decision: require_approval\n    scope: [public]'));
  assert.ok(base.ok && shuffled.ok, JSON.stringify(shuffled));
  assert.equal(shuffled.value.hash, base.value.hash);
  const changed = parsePolicy(policyText((y) => y.replace('max_usd_per_task: 5', 'max_usd_per_task: 4')));
  assert.ok(changed.ok);
  assert.notEqual(changed.value.hash, base.value.hash);
});

test('schema validation: value ranges, default must be deny, no catch-all rules, no unknown keys', () => {
  const edit = (from: string, to: string) => errorCodes(policyText((y) => y.replace(from, to)));
  assert.deepEqual(edit('min_approvers: 1 ', 'min_approvers: 0 '), ['risky_change.min_approvers:range']);
  assert.deepEqual(edit('min_approvers: 1 ', 'min_approvers: 1.5 '), ['risky_change.min_approvers:range']);
  assert.deepEqual(edit('cooldown: 1h ', 'cooldown: -1h '), ['risky_change.cooldown:range']);
  assert.deepEqual(edit('cooldown: 1h ', 'cooldown: 31d '), ['risky_change.cooldown:range']);
  assert.deepEqual(edit('cooldown: 1h ', 'cooldown: soon '), ['risky_change.cooldown:range']);
  assert.deepEqual(edit('reauth_before_effect: true', 'reauth_before_effect: yes'), ['risky_change.reauth_before_effect:type']);
  assert.deepEqual(edit('default: deny', 'default: allow'), ['default:default_deny']);
  assert.deepEqual(edit('max_usd_per_task: 5', 'max_usd_per_task: 0'), ['limits.max_usd_per_task:range']);
  assert.deepEqual(edit('format: aot-policy/v1', 'format: aot-policy/v1\nextra: 1'), ['extra:unknown_key']);
  assert.deepEqual(edit('  - id: internal-read\n    scope: [internal]\n    impact: [read]\n', '  - id: internal-read\n'), ['rules.0:catch_all']);
  assert.deepEqual(edit('scope: [customer]', 'scope: [everyone]'), ['rules.4.scope:enum']);
  assert.deepEqual(edit('id: public-scope-needs-approval', 'id: internal-read'), ['rules.5.id:duplicate']);
  assert.deepEqual(edit('default_validity: {}', 'default_validity: {commitment: 30d}'), ['memory.default_validity.commitment:enum']);
  // 자기 승인은 파라미터가 아니다 (min_approvers 로 정해진다): 키를 쓰면 이유와 함께 거부
  assert.deepEqual(edit('cooldown: 1h ', 'self_approval: true\n  cooldown: 1h '), ['risky_change.self_approval:removed']);
  assert.deepEqual(edit('risky_change:\n  min_approvers: 1 ', 'risky_change:\n  min_approvers: 1\n  extra: 1 '), ['risky_change.extra:unknown_key']);
});

test('lowering any risky_change parameter is itself a risky change; raising them is normal', () => {
  const base = parse(DEFAULT_TEMPLATE_TEXT);
  const variant = (from: string, to: string) => parse(policyText((y) => y.replace(from, to)));
  const lowering: [string, string, RegExp][] = [
    ['min_approvers: 1 ', 'min_approvers: 1 ', /^$/],
    ['cooldown: 1h ', 'cooldown: 10m ', /cooldown shortened/],
    ['cooldown: 1h ', 'cooldown: 0 ', /cooldown shortened/],
    ['reauth_before_effect: true', 'reauth_before_effect: false', /reauth_before_effect turned off/],
  ];
  for (const [from, to, reason] of lowering.slice(1)) {
    const change = classifyChange(base, variant(from, to));
    assert.equal(change.changeClass, 'risky', to);
    assert.match(change.reasons.join(';'), reason);
  }
  const two = variant('min_approvers: 1 ', 'min_approvers: 2 ');
  assert.deepEqual(classifyChange(base, two), { changeClass: 'normal', reasons: [] }, 'stricter approver count is normal (self-approval becomes forbidden)');
  // 2인 이상 → 1인은 자기 승인이 허용으로 바뀌는 변경이므로 위험 변경이고, 그 이유가 드러난다
  assert.match(classifyChange(two, base).reasons.join(), /min_approvers lowered 2 -> 1 \(self-approval becomes allowed\)/);
  const three = variant('min_approvers: 1 ', 'min_approvers: 3 ');
  assert.doesNotMatch(classifyChange(three, two).reasons.join(), /self-approval/, 'lowering 3 -> 2 stays risky but self-approval stays forbidden');
  assert.equal(classifyChange(three, two).changeClass, 'risky');
  assert.equal(classifyChange(base, variant('cooldown: 1h ', 'cooldown: 2h ')).changeClass, 'normal');
  assert.equal(classifyChange(base, variant('max_usd_per_task: 5', 'max_usd_per_task: 3')).changeClass, 'normal');
  assert.match(classifyChange(base, variant('max_usd_per_task: 5', 'max_usd_per_task: 50')).reasons.join(), /max_usd_per_task raised/);
});

test('rule changes: only adding deny rules or removing allow rules counts as tightening', () => {
  const base = parse(DEFAULT_TEMPLATE_TEXT);
  const addRule = (rule: string) => parse(policyText((y) => y.replace('rules:\n', `rules:\n${rule}`)));
  assert.equal(classifyChange(base, addRule('  - {id: no-notify, action: ["notify-tool.*"], decision: deny}\n')).changeClass, 'normal');
  assert.match(classifyChange(base, addRule('  - {id: open-delete, impact: [delete], decision: allow}\n')).reasons.join(), /added with decision 'allow'/);
  assert.match(classifyChange(base, addRule('  - {id: ask-delete, impact: [delete], decision: require_approval}\n')).reasons.join(), /added with decision 'require_approval'/);
  const withoutRead = parse(policyText((y) => y.replace('  - id: internal-read\n    scope: [internal]\n    impact: [read]\n    decision: allow\n', '')));
  assert.equal(classifyChange(base, withoutRead).changeClass, 'normal', 'removing an allow rule tightens');
  const withoutPublic = parse(policyText((y) => y.replace('  - id: public-scope-needs-approval\n    scope: [public]\n    decision: require_approval\n', '')));
  assert.match(classifyChange(base, withoutPublic).reasons.join(), /removed/);
  const changedRule = parse(policyText((y) => y.replace('impact: [read]', 'impact: [read, write]')));
  assert.match(classifyChange(base, changedRule).reasons.join(), /rule 'internal-read' changed/);
});
