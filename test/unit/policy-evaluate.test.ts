// 7요소 판정 (ADR-0006 Amendment, task-spec "권한 요청"): 요소마다 거부 사례, 기본 거부, 가장 엄격한 결과,
// 역할 데이터는 입력이 아님.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateRequest, parsePolicy, type PolicyDocument, type PolicyRequest } from '@aot/policy';

import { DEFAULT_TEMPLATE_TEXT, policyText } from '../support/policy.ts';

const doc = (text = DEFAULT_TEMPLATE_TEXT): PolicyDocument => {
  const result = parsePolicy(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value.document;
};
const withRules = (rules: string) => doc(policyText((y) => y.replace(/rules:\n[\s\S]*?\n\nrisky_change:/, `rules:\n${rules}\n\nrisky_change:`)));
const req = (overrides: Partial<PolicyRequest> = {}): PolicyRequest => ({
  subject: 'generalist@v1', action: 'web_search.search', resource: 'search:example', scope: 'internal', impact: 'read',
  constraints: { max_usd: 1 }, ...overrides,
});
const decide = (d: PolicyDocument, overrides: Partial<PolicyRequest> = {}) => evaluateRequest(d, req(overrides)).decision;

test('default policy v1: internal read allowed, task-own write allowed, other writes and deletes denied by default', () => {
  const d = doc();
  assert.equal(decide(d), 'allow');
  assert.equal(decide(d, { impact: 'write', resource: 'evidence:task-own' }), 'allow');
  assert.equal(decide(d, { impact: 'write', resource: 'repo:example-product' }), 'deny');
  assert.equal(decide(d, { impact: 'write', resource: null }), 'deny');
  assert.equal(decide(d, { impact: 'delete', resource: 'evidence:task-own' }), 'deny');
  assert.match(evaluateRequest(d, req({ impact: 'delete' })).reason, /no rule matches .*default deny/);
});

test('default policy v1: external effects and customer/public scopes need approval, with the D3 approval parameters', () => {
  const d = doc();
  for (const overrides of [{ impact: 'external_effect' as const }, { scope: 'customer' as const }, { scope: 'public' as const }]) {
    const verdict = evaluateRequest(d, req(overrides));
    assert.equal(verdict.decision, 'require_approval', JSON.stringify(overrides));
    assert.deepEqual(verdict.approval, { approver_kind: 'human', channel: 'approval-socket', min_approvers: 1, cooldown: 3600, reauth_before_effect: true, self_approval: false });
  }
  assert.equal(decide(d, { scope: 'public', impact: 'delete' }), 'require_approval', 'no allow rule, but a require_approval rule matches');
});

test('each of the 7 elements can make a request be denied', () => {
  const rules = [
    '  - {id: verifier-reads-repo, subject: ["registration-verifier@v1"], action: ["repo_read.*"], resource: ["repo:*"], scope: [internal], impact: [read], decision: allow}',
    '  - {id: notify-needs-approval, action: ["notify-tool.send"], impact: [external_effect], decision: require_approval}',
  ].join('\n');
  const d = withRules(rules);
  const ok: Partial<PolicyRequest> = { subject: 'registration-verifier@v1', action: 'repo_read.read_file', resource: 'repo:example-product' };
  assert.equal(decide(d, ok), 'allow');
  // 주체: 같은 요청을 다른 역할(또는 같은 역할의 다른 버전)이 하면 거부
  assert.equal(decide(d, { ...ok, subject: 'generalist@v1' }), 'deny');
  assert.equal(decide(d, { ...ok, subject: 'registration-verifier@v2' }), 'deny');
  // 행위
  assert.equal(decide(d, { ...ok, action: 'shell.exec' }), 'deny');
  // 대상
  assert.equal(decide(d, { ...ok, resource: 'site:public-landing' }), 'deny');
  assert.equal(decide(d, { ...ok, resource: null }), 'deny', 'an undeclared target does not match a resource rule');
  // 범위
  assert.equal(decide(d, { ...ok, scope: 'customer' }), 'deny');
  assert.equal(decide(d, { ...ok, scope: null }), 'deny');
  assert.match(evaluateRequest(d, req({ ...ok, scope: null })).reason, /scope not declared/);
  // 영향
  assert.equal(decide(d, { ...ok, impact: 'write' }), 'deny');
  assert.equal(decide(d, { ...ok, impact: null }), 'deny');
  // 제약: 정책 상한 초과
  assert.equal(decide(d, { ...ok, constraints: { max_usd: 5.01 } }), 'deny');
  assert.match(evaluateRequest(d, req({ ...ok, constraints: { max_usd: 50 } })).reason, /exceeds the policy limit 5/);
  const tokenCap = doc(policyText((y) => y.replace('max_usd_per_task: 5', 'max_usd_per_task: 5\n  max_tokens_per_task: 1000')));
  assert.equal(decide(tokenCap, { constraints: { max_usd: 1, max_tokens: 1001 } }), 'deny');
  assert.equal(decide(tokenCap, { constraints: { max_usd: 1, max_tokens: 1000 } }), 'allow');
  // 승인: require_approval 은 allow 가 아니다 (승인 요건이 붙는다. 승인 없이 실행되지 않는 것은 policy-gate 시험)
  const verdict = evaluateRequest(d, req({ action: 'notify-tool.send', impact: 'external_effect' }));
  assert.equal(verdict.decision, 'require_approval');
  assert.equal(verdict.approval?.approver_kind, 'human');
});

test('the strictest matching rule wins: deny > require_approval > allow, independent of rule order', () => {
  const allowThenDeny = withRules([
    '  - {id: a-allow-read, scope: [internal], impact: [read], decision: allow}',
    '  - {id: b-deny-search, action: ["web_search.*"], decision: deny}',
    '  - {id: c-ask-search, action: ["web_search.search"], decision: require_approval}',
  ].join('\n'));
  const verdict = evaluateRequest(allowThenDeny, req());
  assert.equal(verdict.decision, 'deny');
  assert.deepEqual(verdict.matchedRules, ['a-allow-read', 'b-deny-search', 'c-ask-search']);
  assert.match(verdict.reason, /deny by rule b-deny-search/);
  assert.equal(decide(allowThenDeny, { action: 'web_search.search', scope: 'internal' }), 'deny');
  assert.equal(decide(allowThenDeny, { action: 'evidence_store.read' }), 'allow');
});

test('glob patterns match whole strings only', () => {
  const d = withRules('  - {id: exact, action: ["repo_read.read_*"], scope: [internal], impact: [read], decision: allow}');
  assert.equal(decide(d, { action: 'repo_read.read_file' }), 'allow');
  assert.equal(decide(d, { action: 'xrepo_read.read_file' }), 'deny');
  assert.equal(decide(d, { action: 'repo_read.list_tree' }), 'deny');
  assert.equal(decide(d, { action: 'repo_read.read_file.extra' }), 'allow', '`*` spans any characters, including dots');
});
