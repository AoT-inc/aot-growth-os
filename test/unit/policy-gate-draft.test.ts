// 정책 게이트의 run 단계 판정(ADR-0015 §2.2)과 전송 직전 재확인(beforeEffect)을 고정한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sha256Hex, type TaskRow, type TaskSpec } from '@aot/domain';

import { MESSAGE_TARGET, MESSAGE_TOOL } from '../support/message-tool.ts';
import { draftRowFor, insertClosedRun, insertDraftRow } from '../support/drafts.ts';
import { AGENT, createWithGate, decisionsOf, deployDirect, effectDraft, HOUR, policyEnv, policyText, readOnlyDraft, taskRow, type PolicyEnv } from '../support/policy.ts';

const BAD_HASH = 'f'.repeat(64);

function runGate(env: PolicyEnv, taskId: string, effectApproval?: 'draft' | 'scope') {
  const task = taskRow(env.db, taskId);
  const spec = JSON.parse(task.spec) as TaskSpec;
  return env.db.writeTx((tx) => env.gate.beforeRun(tx, { task, spec, attempt: 1, now: env.clock.nowIso(), ...(effectApproval ? { effectApproval } : {}) }));
}

function effectGate(env: PolicyEnv, task: TaskRow, over: { phase: 'draft' | 'dispatch' | 'execute'; requestHash: string; tool?: string; target?: string }) {
  const spec = JSON.parse(task.spec) as TaskSpec;
  if (!env.db.get('SELECT 1 AS one FROM task_run WHERE id = ?', ['run-x'])) insertClosedRun(env.db, task.id, 'run-x', 9, AGENT, env.clock.nowIso());
  return env.db.writeTx((tx) => env.gate.beforeEffect(tx, {
    task, spec, runId: 'run-x', tool: over.tool ?? MESSAGE_TOOL, action: 'send', target: over.target ?? MESSAGE_TARGET,
    dispatch: 'first', now: env.clock.nowIso(), phase: over.phase, requestHash: over.requestHash,
  }));
}

const customerReadAndMail = () => effectDraft({
  allowed_tools: [
    { tool: 'crm_read', operations: ['read'], scope: 'customer', impact: 'read', target: 'crm:example' },
    { tool: MESSAGE_TOOL, operations: ['send'], scope: 'customer', impact: 'external_effect', target: MESSAGE_TARGET },
  ],
});

test('beforeRun phases: rule 1 (deny) and the budget cap still send the task to review, even for a draft task', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  env.clock.advance(HOUR);
  deployDirect(env, policyText((y) => y.replace('rules:\n', 'rules:\n  - {id: no-mail, action: ["notify-tool.*"], decision: deny}\n')));
  const verdict = runGate(env, id, 'draft');
  assert.equal(verdict.decision, 'needs_review');
});

test('beforeRun phases: rule 4 — a draft-approval task whose approval-requiring requests are all external effects starts a draft run without approval', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  assert.deepEqual(runGate(env, id, 'draft'), { decision: 'allow', phase: 'draft' });
  const recorded = decisionsOf(env.db, id).filter((r) => r.action === 'notify-tool.send' && /re-check before run/.test(r.reason));
  assert.ok(recorded.length > 0);
  for (const row of recorded) {
    assert.equal(row.decision, 'require_approval', 'the policy decision itself is unchanged');
    assert.match(row.reason, /draft run: nothing is sent; drafts await approval/);
  }
});

test('beforeRun phases: rule 5 — scope tasks, unmarked tasks and tasks mixing in an approval-requiring read need the spec approval as today', (t) => {
  const env = policyEnv(t);
  const mail = createWithGate(env, effectDraft());
  for (const mode of [undefined, 'scope'] as const) {
    const verdict = runGate(env, mail, mode);
    assert.equal(verdict.decision, 'needs_review');
    assert.match((verdict as { reason: string }).reason, /approval required/);
  }
  const mixed = createWithGate(env, customerReadAndMail(), { dedupeKey: 'mixed' });
  const verdict = runGate(env, mixed, 'draft');
  assert.equal(verdict.decision, 'needs_review', 'a customer read that needs approval keeps the old scope approval');
});

test('beforeRun phases: rule 3 — no approval needed means execute, with or without the draft marker', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, readOnlyDraft());
  assert.deepEqual(runGate(env, id), { decision: 'allow', phase: 'execute' });
  assert.deepEqual(runGate(env, id, 'draft'), { decision: 'allow', phase: 'execute' });
});

test('beforeRun phases: rule 2 — proposed drafts mean dispatch only with a valid human approval of the draft hash', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  insertClosedRun(env.db, id, 'run-1', 1, AGENT, env.clock.nowIso());
  insertDraftRow(env.db, draftRowFor(id, 'run-1'));
  const verdict = runGate(env, id, 'draft');
  assert.equal(verdict.decision, 'needs_review');
  assert.match((verdict as { reason: string }).reason, /approval required/);
  // 정책이 승인을 요구하지 않는 업무여도 초안이 있으면 execute 로 가지 않는다
  const free = createWithGate(env, readOnlyDraft(), { dedupeKey: 'free' });
  insertClosedRun(env.db, free, 'run-2', 1, AGENT, env.clock.nowIso());
  insertDraftRow(env.db, draftRowFor(free, 'run-2'));
  assert.equal(runGate(env, free).decision, 'needs_review');
});

test('beforeRun phases: a dispatch run is not stopped by the budget the draft run already spent', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft({ cost_budget: { max_usd: 1 } }));
  env.db.writeTx((tx) => tx.run("INSERT INTO cost_entry (id, task_id, category, amount_usd, at) VALUES ('c1', ?, 'llm', 1.0, ?)", [id, env.clock.nowIso()]));
  const noDrafts = runGate(env, id, 'draft');
  assert.ok(noDrafts.decision === 'needs_review' && /budget exhausted/.test(noDrafts.reason));
  insertClosedRun(env.db, id, 'run-1', 1, AGENT, env.clock.nowIso());
  insertDraftRow(env.db, draftRowFor(id, 'run-1'));
  const withDrafts = runGate(env, id, 'draft');
  assert.ok(withDrafts.decision === 'needs_review' && /approval required/.test(withDrafts.reason), 'reaches the approval check instead of the budget stop');
});

test('beforeEffect: a draft run is always refused and the refusal is recorded', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  const task = taskRow(env.db, id);
  const verdict = effectGate(env, task, { phase: 'draft', requestHash: BAD_HASH });
  assert.equal(verdict.decision, 'refuse');
  assert.match((verdict as { reason: string }).reason, /draft run sends nothing/);
  const last = decisionsOf(env.db, id).at(-1)!;
  assert.equal(last.decision, 'deny');
  assert.match(last.reason, /draft run/);
});

test('beforeEffect: a dispatch run needs a matching proposed draft before the usual checks; mismatches and expiry are refused', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  insertClosedRun(env.db, id, 'run-1', 1, AGENT, env.clock.nowIso());
  const draft = insertDraftRow(env.db, draftRowFor(id, 'run-1'));
  const task = taskRow(env.db, id);

  const unknownHash = effectGate(env, task, { phase: 'dispatch', requestHash: BAD_HASH });
  assert.ok(unknownHash.decision === 'refuse' && /does not match any approved draft/.test(unknownHash.reason));
  assert.ok(effectGate(env, task, { phase: 'dispatch', requestHash: sha256Hex('{"other":1}') }).decision === 'refuse');
  const wrongTarget = effectGate(env, task, { phase: 'dispatch', requestHash: draft.payload_hash, target: 'mailbox:other' });
  assert.equal(wrongTarget.decision, 'refuse');

  // 해시가 맞아도 사람의 초안 해시 승인이 없으면 거부한다 (승인 확인까지 간다)
  const noApproval = effectGate(env, task, { phase: 'dispatch', requestHash: draft.payload_hash });
  assert.ok(noApproval.decision === 'refuse' && /approval required/.test(noApproval.reason));

  env.clock.advance(4 * 24 * HOUR);
  const expired = effectGate(env, task, { phase: 'dispatch', requestHash: draft.payload_hash });
  assert.ok(expired.decision === 'refuse' && /expired/.test(expired.reason));
  assert.equal(decisionsOf(env.db, id).filter((r) => r.decision === 'deny').length >= 4, true, 'every refusal is a recorded decision');
});

test('beforeEffect: the execute phase behaves as before (no draft required)', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  const verdict = effectGate(env, taskRow(env.db, id), { phase: 'execute', requestHash: BAD_HASH });
  assert.ok(verdict.decision === 'refuse' && /approval required/.test(verdict.reason), 'still needs the spec approval');
});
