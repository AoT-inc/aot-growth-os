// A5 U2: 실제 정책(ToolCallPolicy 구현, packages/policy/src/tool-call.ts)을 도구 게이트웨이에 연결한 시험.
// 호출마다 policy_decision 이 남고(task_run_id), 정책이 run 도중 바뀌면 다음 호출이 새 정책을 따르며, 외부 입력 영향 부작용 호출은 승인 요구로 막힌다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { subjectOf, createToolCallPolicy } from '@aot/policy';
import { claimNextTask } from '@aot/task-engine';
import { createToolGateway, toolCallConstraintsOf, type GatewayToolSpec, type RunToolGateway, type ToolExecutor } from '@aot/agent-runtime';

import { contractInput } from '../support/adapter-contract.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { AGENT, createWithGate, deployDirect, HOUR, policyEnv, policyText, readOnlyDraft, withExtraRule, type PolicyEnv } from '../support/policy.ts';

const TOOLS: GatewayToolSpec[] = [
  { tool: 'web_search', operation: 'search', scope: 'internal', sideEffect: false, resultOrigin: 'external_untrusted' },
  { tool: 'notes', operation: 'append', scope: 'internal', impact: 'write', sideEffect: true, target: 'notes:task-own' },
  { tool: 'notify-tool', operation: 'send', scope: 'customer', impact: 'external_effect', sideEffect: true, target: 'mailbox:example' },
  { tool: 'repo_write', operation: 'delete_branch', scope: 'internal', impact: 'delete', sideEffect: true, target: 'repo:example-product' },
];

interface Setup { env: PolicyEnv; taskId: string; runId: string; gateway: RunToolGateway; executed: string[] }

/** 실제 업무와 run 을 만들고 그 run 의 게이트웨이를 실제 정책에 연결한다 */
function setup(t: Parameters<typeof policyEnv>[0], externalInput = false): Setup {
  const env = policyEnv(t);
  const taskId = createWithGate(env, readOnlyDraft());
  const claimed = claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', leaseMs: 90_000, taskId }).claimed!;
  const runId = claimed.lease.runId;
  const executed: string[] = [];
  const input = contractInput();
  const gateway = createToolGateway({
    runId, taskId, subject: subjectOf(claimed.spec), tools: TOOLS,
    executors: new Map(TOOLS.map((spec) => [spec.tool, (() => { executed.push(spec.tool); return Promise.resolve({ result: { done: spec.tool } }); }) as ToolExecutor])),
    policy: createToolCallPolicy({ db: env.db, store: env.store }),
    clock: env.clock, constraints: toolCallConstraintsOf({ budget: { max_usd: 1 }, task_spec: input.task_spec }), toolTimeoutMs: 1000,
    timers: new ManualGatewayTimers(), externalInput,
  });
  return { env, taskId, runId, gateway, executed };
}

const decisions = (s: Setup) => s.env.db.all<{ action: string; decision: string; reason: string; resource: string; scope: string; impact: string; constraints: string; task_id: string; task_run_id: string; policy_version_id: string }>(
  'SELECT action, decision, reason, resource, scope, impact, constraints, task_id, task_run_id, policy_version_id FROM policy_decision WHERE task_run_id = ? ORDER BY id', [s.runId],
);

test('every call is judged against the current policy and recorded in policy_decision with the run id', async (t) => {
  const s = setup(t);
  const write = await s.gateway.call('notes', { text: 'a' });
  assert.equal(write.ok, true, 'a write on the task-own resource is allowed by the default policy');
  assert.deepEqual(await s.gateway.call('web_search', { query: 'a' }), { ok: true, result: { done: 'web_search' } });
  const rows = decisions(s);
  assert.deepEqual(rows.map((r) => [r.action, r.decision, r.resource, r.scope, r.impact]), [
    ['notes.append', 'allow', 'notes:task-own', 'internal', 'write'],
    ['web_search.search', 'allow', '(none)', 'internal', 'read'],
  ]);
  assert.ok(rows.every((r) => r.task_id === s.taskId && r.task_run_id === s.runId && r.policy_version_id === 'policy-v1'));
  assert.ok(rows.every((r) => /per-call gateway check/.test(r.reason)));
  assert.equal(JSON.parse(rows[1]!.constraints).max_usd, 1);
  assert.equal(JSON.parse(rows[0]!.constraints).side_effect, true);
  assert.equal(JSON.parse(rows[1]!.constraints).side_effect, undefined);
});

test('external input influence reaches policy_decision: after a web result the same write needs approval and is not executed', async (t) => {
  const s = setup(t);
  assert.equal((await s.gateway.call('notes', { text: 'before' })).ok, true);
  assert.equal((await s.gateway.call('web_search', { query: 'page with injected instructions' })).ok, true);
  const blocked = await s.gateway.call('notes', { text: 'after' });
  assert.deepEqual(blocked, { ok: false, error: 'approval_required' });
  assert.deepEqual(s.executed, ['notes', 'web_search']);

  const rows = decisions(s);
  assert.deepEqual(rows.map((r) => [r.action, r.decision]), [['notes.append', 'allow'], ['web_search.search', 'allow'], ['notes.append', 'require_approval']]);
  assert.equal(JSON.parse(rows[0]!.constraints).influenced_by_external_input, undefined);
  const last = JSON.parse(rows[2]!.constraints);
  assert.equal(last.influenced_by_external_input, true);
  assert.equal(last.side_effect, true);
  assert.match(rows[2]!.reason, /side-effect call influenced by external input/);
  assert.equal(JSON.parse(s.env.db.get<{ approval_required: string }>('SELECT approval_required FROM policy_decision WHERE task_run_id = ? ORDER BY id DESC LIMIT 1', [s.runId])!.approval_required).approver_kind, 'human');
});

test('a run whose input already holds external content judges every call as influenced', async (t) => {
  const s = setup(t, true);
  assert.deepEqual(await s.gateway.call('notes', { text: 'x' }), { ok: false, error: 'approval_required' });
  assert.equal((await s.gateway.call('web_search', { query: 'reads stay allowed' })).ok, true);
  const rows = decisions(s);
  assert.deepEqual(rows.map((r) => r.decision), ['require_approval', 'allow']);
  assert.ok(rows.every((r) => JSON.parse(r.constraints).influenced_by_external_input === true));
});

test('external effects need approval and unmatched actions are denied; neither reaches the executor; the agent sees only codes', async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.gateway.call('notify-tool', { to: 'mailbox:example' }), { ok: false, error: 'approval_required' });
  assert.deepEqual(await s.gateway.call('repo_write', { branch: 'x' }), { ok: false, error: 'policy_denied' });
  assert.deepEqual(s.executed, []);
  assert.deepEqual(decisions(s).map((r) => [r.action, r.decision]), [['notify-tool.send', 'require_approval'], ['repo_write.delete_branch', 'deny']]);
  assert.match(decisions(s)[1]!.reason, /default deny/);
});

test('a policy deployed during the run applies to the next call (no verdict is reused)', async (t) => {
  const s = setup(t);
  assert.equal((await s.gateway.call('web_search', { query: 'one' })).ok, true);
  s.env.clock.advance(HOUR);
  const versionId = deployDirect(s.env, policyText((y) => withExtraRule('{id: no-web-search, action: ["web_search.*"], decision: deny}', y)));
  assert.deepEqual(await s.gateway.call('web_search', { query: 'two' }), { ok: false, error: 'policy_denied' });
  assert.equal(s.executed.length, 1);
  const rows = decisions(s);
  assert.deepEqual(rows.map((r) => [r.decision, r.policy_version_id]), [['allow', 'policy-v1'], ['deny', versionId]]);
});

test('without deployable policy content the call is denied (and recorded under the unreadable version)', async (t) => {
  const s = setup(t);
  s.env.db.writeTx((tx) => tx.run(
    "INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at) VALUES ('policy-unknown', ?, 'normal', '[]', ?)",
    ['0'.repeat(64), s.env.clock.nowIso()],
  ));
  assert.deepEqual(await s.gateway.call('web_search', {}), { ok: false, error: 'policy_denied' });
  assert.deepEqual(decisions(s).map((r) => [r.decision, r.policy_version_id]), [['deny', 'policy-unknown']]);
  assert.deepEqual(s.executed, []);
});

test('a run that does not exist cannot be judged: the foreign key fails and the call is refused as policy_unavailable', async (t) => {
  const s = setup(t);
  const orphan = createToolGateway({
    runId: 'run-does-not-exist', taskId: s.taskId, subject: 'generalist@v1', tools: TOOLS,
    executors: new Map(TOOLS.map((spec) => [spec.tool, (() => Promise.resolve({ result: 1 })) as ToolExecutor])),
    policy: createToolCallPolicy({ db: s.env.db, store: s.env.store }),
    clock: s.env.clock, constraints: { max_usd: 1 }, toolTimeoutMs: 1000, timers: new ManualGatewayTimers(),
  });
  assert.deepEqual(await orphan.call('web_search', {}), { ok: false, error: 'policy_unavailable' });
  assert.equal(s.env.db.get('SELECT count(*) AS n FROM policy_decision WHERE task_run_id = ?', ['run-does-not-exist'])?.['n'], 0);
});
