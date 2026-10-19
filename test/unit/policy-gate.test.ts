// 실제 정책 게이트(TaskPolicyGate)를 업무 엔진에 연결한 시험: 생성 판정과 기록, 실행 직전 재검증, 기본 거부,
// 역할 데이터 변경이 판정을 넓히지 않음 (phase-a §3 "권한(정책)" A3).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DENY_ALL_TASK_POLICY_GATE } from '@aot/domain';
import { claimNextTask, TaskCreationError } from '@aot/task-engine';

import { taskStatus } from '../support/engine.ts';
import {
  AGENT, createWithGate, decisionsOf, deployDirect, effectDraft, HOUR, policyEnv, policyText, readOnlyDraft, type PolicyEnv,
} from '../support/policy.ts';
import { minimalDraft } from '../support/spec-fixtures.ts';

const claim = (env: PolicyEnv, taskId?: string) =>
  claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', leaseMs: 90_000, ...(taskId ? { taskId } : {}) });

const refusal = (fn: () => unknown): TaskCreationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof TaskCreationError) return error;
    throw error;
  }
  assert.fail('expected TaskCreationError');
};

test('creation: allowed requests are recorded in policy_decision with the task id and the policy version', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, readOnlyDraft());
  const rows = decisionsOf(env.db, id);
  assert.deepEqual(rows.map((r) => [r.action, r.decision, r.policy_version_id]), [
    ['web_search.search', 'allow', 'policy-v1'], ['web_search.fetch', 'allow', 'policy-v1'],
  ]);
  assert.match(rows[0]!.reason, /allow by rule internal-read/);
});

test('creation: a denied request refuses the task, and the refusal is still recorded (task_id NULL) after the rollback', (t) => {
  const env = policyEnv(t);
  const spec = readOnlyDraft({ allowed_tools: [
    { tool: 'web_search', operations: ['search'], scope: 'internal', impact: 'read' },
    { tool: 'repo_write', operations: ['delete_branch'], scope: 'internal', impact: 'delete', target: 'repo:example-product' },
  ] });
  const error = refusal(() => createWithGate(env, spec));
  assert.deepEqual(error.issues.map((i) => i.code), ['policy_denied']);
  assert.match(error.message, /repo_write\.delete_branch .*default deny/);
  assert.equal(env.db.get('SELECT count(*) AS n FROM task')?.['n'], 0, 'no task row survives');
  assert.deepEqual(decisionsOf(env.db, null).map((r) => [r.action, r.decision]), [['web_search.search', 'allow'], ['repo_write.delete_branch', 'deny']]);
});

test('creation: undeclared scope/impact and budgets over the policy limit are denied (default deny)', (t) => {
  const env = policyEnv(t);
  const undeclared = refusal(() => createWithGate(env, { ...minimalDraft(), role: 'generalist' }));
  assert.match(undeclared.message, /scope and impact not declared/);
  const recorded = decisionsOf(env.db, null);
  assert.deepEqual(recorded.map((r) => [r.decision, r.scope, r.impact]), [['deny', 'public', 'external_effect'], ['deny', 'public', 'external_effect']]);
  assert.match(recorded[0]!.reason, /scope not declared \(recorded as 'public'\)/);

  const overBudget = refusal(() => createWithGate(env, readOnlyDraft({ cost_budget: { max_usd: 5.5 } })));
  assert.match(overBudget.message, /exceeds the policy limit 5/);
  assert.ok(createWithGate(env, readOnlyDraft({ cost_budget: { max_usd: 5 }, inputs: [{ name: 'k', ref: 'r:5', kind: 'k' }] })));
});

test('without deployable policy content every decision is a deny (creation refused, run sent to review)', (t) => {
  const env = policyEnv(t);
  const queued = createWithGate(env, readOnlyDraft());
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at) VALUES ('policy-unknown', ?, 'normal', '[]', ?)",
    ['0'.repeat(64), env.clock.nowIso()],
  ));
  assert.match(refusal(() => createWithGate(env, readOnlyDraft({ inputs: [{ name: 'k', ref: 'r:2', kind: 'k' }] }))).message, /was not found .*default deny/);
  const result = claim(env, queued);
  assert.equal(result.claimed, null);
  assert.equal(taskStatus(env.db, queued), 'needs_review');
});

test('run: the gate re-checks with the current policy; an allowed read-only task gets a lease', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, readOnlyDraft());
  const result = claim(env, id);
  assert.equal(result.claimed?.task.id, id);
  assert.ok(decisionsOf(env.db, id).some((r) => /re-check before run/.test(r.reason)));
});

test('run: a task whose request needs approval goes to needs_review instead of running', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  assert.equal(taskStatus(env.db, id), 'queued', 'require_approval does not refuse creation');
  const result = claim(env, id);
  assert.equal(result.claimed, null);
  assert.deepEqual(result.sentToReview, [id]);
  const last = env.db.get<{ reason: string; caused_by: string }>('SELECT reason, caused_by FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [id])!;
  assert.match(last.reason, /approval required/);
  assert.equal(last.caused_by, 'system:policy');
  const notify = decisionsOf(env.db, id).filter((r) => r.action === 'notify-tool.send');
  assert.deepEqual(notify.map((r) => r.decision), ['require_approval', 'require_approval']);
});

test('run: a task whose recorded cost already reached its budget is not started', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, readOnlyDraft({ cost_budget: { max_usd: 1 } }));
  env.db.writeTx((tx) => tx.run("INSERT INTO cost_entry (id, task_id, category, amount_usd, at) VALUES ('c1', ?, 'llm', 1.0, ?)", [id, env.clock.nowIso()]));
  assert.equal(claim(env, id).claimed, null);
  assert.match(env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [id])!.reason, /budget exhausted/);
});

test('run: a policy tightened after creation applies at run time', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, readOnlyDraft());
  env.clock.advance(HOUR);
  deployDirect(env, policyText((y) => y.replace('rules:\n', 'rules:\n  - {id: no-web-search, action: ["web_search.*"], decision: deny}\n')));
  assert.equal(claim(env, id).claimed, null);
  assert.equal(taskStatus(env.db, id), 'needs_review');
  assert.match(env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [id])!.reason, /denied by the current policy policy-[0-9a-f]{16}/);
});

test('changing role or routing data does not turn a decision into allow (trust-boundaries §2-7)', (t) => {
  const env = policyEnv(t);
  const risky = (inputs: string) => effectDraft({
    allowed_tools: [
      { tool: 'notify-tool', operations: ['send'], scope: 'public', impact: 'external_effect', target: 'mailbox:everyone' },
      { tool: 'repo_write', operations: ['push'], scope: 'internal', impact: 'write', target: 'repo:example-product' },
    ],
    inputs: [{ name: 'k', ref: inputs, kind: 'k' }],
  });
  const before = decisionsOf(env.db, null);
  assert.equal(before.length, 0);
  assert.throws(() => createWithGate(env, risky('r:1')), TaskCreationError);
  const baseline = decisionsOf(env.db, null).map((r) => [r.action, r.decision]);
  assert.deepEqual(baseline, [['notify-tool.send', 'require_approval'], ['repo_write.push', 'deny']]);

  // 역할에 도구를 넣고, 같은 권한을 "요청"하는 새 역할을 만들고, 업무를 그 역할로 라우팅해도 판정은 같다
  env.db.writeTx((tx) => {
    const everything = JSON.stringify([{ tool: 'notify-tool', operations: ['send'] }, { tool: 'repo_write', operations: ['push'] }]);
    tx.run("UPDATE role SET allowed_tools = ? WHERE slug = 'generalist'", [everything]);
    tx.run("INSERT INTO role (id, org_unit_id, slug, description, allowed_tools, lifecycle, version, created_at) VALUES ('role-power', 'org-unit-core', 'power-user', 'example', ?, 'active', 1, ?)", [everything, env.clock.nowIso()]);
  });
  assert.throws(() => createWithGate(env, risky('r:2')), TaskCreationError);
  assert.throws(() => createWithGate(env, { ...risky('r:3'), role: 'power-user' }), TaskCreationError);
  const after = decisionsOf(env.db, null).slice(2).map((r) => [r.action, r.decision]);
  assert.deepEqual(after, [...baseline, ...baseline]);
});

test('the deny-all default gate (used when no policy is wired) also refuses external effects', () => {
  assert.equal(DENY_ALL_TASK_POLICY_GATE.beforeEffect(undefined as never, undefined as never).decision, 'refuse');
});
