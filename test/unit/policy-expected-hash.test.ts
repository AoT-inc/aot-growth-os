// 공유 계약 (docs/plans/decision-delegation.md §5): `expected_hash`(reject·cancel·request_changes·release), `via`, 거부 응답의 `code`.
// 화면(트랙 C)이 이 모양에 맞춰 보낸다: 해시가 다르면 hash_mismatch 로 거부하고, 해시를 보내지 않으면 예전처럼 동작한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOrgProposal, type OrgProposalInput } from '@aot/domain';
import { REFUSAL_CODES } from '@aot/policy';

import { draftedTask } from '../support/draft-flow.ts';
import { draftedFor, approvalsOf } from '../support/delegation.ts';
import { draftsOf } from '../support/drafts.ts';
import { taskStatus } from '../support/engine.ts';
import { examplePayload } from '../support/message-tool.ts';
import { AGENT, deployDirect, HOUR, OWNER, policyEnv, policyText, REVIEWER, type PolicyEnv } from '../support/policy.ts';

const STALE = 'e'.repeat(64);
const hashOf = (env: PolicyEnv, kind: string, id: string): string => String(env.send({ cmd: 'show', actor: OWNER, kind, id })['hash']);
const code = (response: { code?: unknown }): unknown => response.code;

test('the refusal code list is exactly the shared contract', () => {
  assert.deepEqual([...REFUSAL_CODES], [
    'hash_mismatch', 'wrong_state', 'send_started', 'masked', 'expired', 'policy_denied', 'self_approval', 'cooldown',
    'reauth_required', 'reauth_failed', 'reauth_locked', 'not_human', 'bad_request',
  ]);
});

// ===== expected_hash =====

test('reject: a stale expected_hash is refused with hash_mismatch and nothing changes; the right hash, or none, goes through', async (t) => {
  const env = policyEnv(t);
  const a = await draftedTask(env, { dedupeKey: 'a' });
  const b = await draftedTask(env, { dedupeKey: 'b' });
  const c = await draftedTask(env, { dedupeKey: 'c' });
  const refused = env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: a.taskId, expected_hash: STALE, via: 'web' });
  assert.deepEqual([refused.ok, code(refused)], [false, 'hash_mismatch']);
  assert.match(String(refused.error), /changed since it was shown/);
  assert.equal(taskStatus(env.db, a.taskId), 'needs_review');
  assert.equal(approvalsOf(env.db, a.taskId).length, 0);
  assert.equal(draftsOf(env.db, a.taskId)[0]!.state, 'proposed');

  const ok = env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: b.taskId, expected_hash: hashOf(env, 'task', b.taskId), via: 'web' });
  assert.equal(ok['ok'], true);
  assert.equal(taskStatus(env.db, b.taskId), 'failed');
  assert.equal(approvalsOf(env.db, b.taskId)[0]!.via, 'web', 'via is recorded on the approval row');

  assert.equal(env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: c.taskId })['ok'], true, 'without expected_hash the request behaves as before');
  assert.equal(approvalsOf(env.db, c.taskId)[0]!.via, null, 'no via was reported');
});

test('cancel and request_changes honor expected_hash the same way (task)', async (t) => {
  const env = policyEnv(t);
  const a = await draftedTask(env, { dedupeKey: 'a' });
  const b = await draftedTask(env, { dedupeKey: 'b' });
  assert.equal(code(env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id: a.taskId, expected_hash: STALE })), 'hash_mismatch');
  assert.equal(approvalsOf(env.db, a.taskId).length, 0);
  assert.equal(env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id: a.taskId, expected_hash: hashOf(env, 'task', a.taskId), via: 'web' })['state'], 'cancelled');

  assert.equal(code(env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id: b.taskId, comment: 'shorter', expected_hash: STALE })), 'hash_mismatch');
  assert.equal(taskStatus(env.db, b.taskId), 'needs_review');
  assert.equal(draftsOf(env.db, b.taskId)[0]!.state, 'proposed');
  const done = env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id: b.taskId, comment: 'shorter', expected_hash: hashOf(env, 'task', b.taskId), via: 'cli' });
  assert.equal(done['state'], 'queued');
  assert.equal(approvalsOf(env.db, b.taskId)[0]!.via, 'cli');
});

test('release honors expected_hash: a stale one is refused before the TOTP is used', async (t) => {
  const env = policyEnv(t);
  const a = await draftedTask(env);
  const hash = hashOf(env, 'task', a.taskId);
  env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: a.taskId, hash });
  env.clock.advance(HOUR);
  const stale = env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: a.taskId, totp: env.code(OWNER), expected_hash: STALE });
  assert.deepEqual([stale.ok, code(stale)], [false, 'hash_mismatch']);
  assert.equal(env.db.get('SELECT count(*) AS n FROM human_reauth')?.['n'], 0, 'the TOTP code was not consumed');
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: a.taskId, totp: env.code(OWNER), expected_hash: hash })['state'], 'queued');
});

test('expected_hash is checked for policy proposals, strategies and organization proposals as well', (t) => {
  const env = policyEnv(t);
  // 정책 제안: 위험 변경을 승인해 두고 해시를 대조한다
  const text = policyText((y) => y.replace('max_usd_per_task: 5', 'max_usd_per_task: 9'));
  const approved = env.send({ cmd: 'approve', actor: OWNER, kind: 'policy_version', policy_text: text });
  const policyHash = String(approved['hash']);
  const id = String(approved['id']);
  assert.equal(code(env.send({ cmd: 'cancel', actor: OWNER, kind: 'policy_version', id, expected_hash: STALE })), 'hash_mismatch');
  assert.equal(code(env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id, totp: env.code(OWNER), expected_hash: STALE })), 'hash_mismatch');
  assert.equal(env.send({ cmd: 'cancel', actor: OWNER, kind: 'policy_version', id, expected_hash: policyHash })['state'], 'cancelled');

  // 실험 전략
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at)
     VALUES ('strategy-x', NULL, 'Experiment x', 'hypothesis', '[]', 'proposed', '{}', ?, ?)`, [AGENT, env.clock.nowIso()],
  ));
  assert.equal(code(env.send({ cmd: 'reject', actor: OWNER, kind: 'strategy_version', id: 'strategy-x', expected_hash: STALE })), 'hash_mismatch');
  assert.equal(env.send({ cmd: 'reject', actor: OWNER, kind: 'strategy_version', id: 'strategy-x', expected_hash: hashOf(env, 'strategy_version', 'strategy-x') })['state'], 'rejected');

  // 조직 제안
  const input: OrgProposalInput = {
    proposedBy: AGENT,
    diff: { ops: [{ op: 'add_role', role: { slug: 'example-normal', description: '조사 전담', allowed_tools: [{ tool: 'web_search', operations: ['search'] }], unit: 'core' } }] },
    rationale: 'unassigned 업무가 반복됨', evidenceRefs: ['task:example'], expectedEffect: '처리 시간 단축', riskAssessment: { risks: ['품질'], mitigations: ['시험 범위 제한'] },
    evaluationPlan: { min_pass_rate: 0.8, min_observations: 3, max_cost_usd: 5, baseline_window_days: 30, evaluation_days: 14 },
    rollbackPlan: { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: 'generalist' }, running_tasks: 'finish', external_effects: 'human' },
    trialScope: { task_types: ['weekly-market-research'] },
  };
  const orgId = env.db.writeTx((tx) => createOrgProposal(tx, env.clock, input)).proposalId;
  assert.equal(code(env.send({ cmd: 'reject', actor: OWNER, kind: 'org_proposal', id: orgId, expected_hash: STALE })), 'hash_mismatch');
  assert.equal(env.send({ cmd: 'reject', actor: OWNER, kind: 'org_proposal', id: orgId, expected_hash: hashOf(env, 'org_proposal', orgId) })['state'], 'rejected');
});

test('expected_hash must be the 64-hex hash from show; via must be cli or web; other unknown fields are still ignored', async (t) => {
  const env = policyEnv(t);
  const a = await draftedTask(env);
  for (const bad of ['', 'abc', 'G'.repeat(64), 42, null]) {
    assert.equal(code(env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: a.taskId, expected_hash: bad })), 'bad_request', JSON.stringify(bad));
  }
  assert.equal(code(env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: a.taskId, via: 'delegate' })), 'bad_request', 'only cli and web can be self-reported');
  assert.equal(code(env.send({ cmd: 'whoami', actor: OWNER, via: 'telepathy' })), 'bad_request');
  assert.equal(taskStatus(env.db, a.taskId), 'needs_review');
  assert.equal(env.send({ cmd: 'whoami', actor: OWNER, via: 'web', future_field: 1 })['ok'], true);
});

// ===== code =====

test('refusals carry a machine-readable code next to the English error', async (t) => {
  const env = policyEnv(t);
  const task = await draftedTask(env, { dedupeKey: 'code' });
  const id = task.taskId;
  const hash = hashOf(env, 'task', id);

  assert.deepEqual([env.send({ cmd: 'whoami', actor: AGENT }).ok, code(env.send({ cmd: 'whoami', actor: AGENT }))], [false, 'not_human']);
  assert.equal(code(env.send({ cmd: 'whoami', actor: 'nobody' })), 'not_human');
  assert.equal(code(env.send({ cmd: 'nope', actor: OWNER })), 'bad_request');
  assert.equal(code(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id })), 'bad_request', 'hash missing');
  assert.equal(code(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: 'missing-task' })), 'bad_request');
  assert.equal(code(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id, hash: STALE })), 'hash_mismatch');
  assert.equal(code(env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id, comment: '' })), 'bad_request');

  // cooldown -> reauth_required -> reauth_failed -> reauth_locked
  assert.equal(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id, hash })['state'], 'cooldown');
  assert.equal(code(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code(OWNER) })), 'cooldown');
  env.clock.advance(HOUR);
  assert.equal(code(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id })), 'reauth_required');
  for (let i = 0; i < 5; i += 1) assert.equal(code(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: '000000' })), 'reauth_failed');
  assert.equal(code(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: '000000' })), 'reauth_locked');
  env.clock.advance(6 * 60_000);
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code(OWNER) })['state'], 'queued');
  assert.equal(code(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id, hash })), 'wrong_state', 'the task is queued now');
  assert.equal(code(env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id })), 'wrong_state');
});

test('masked, expired, send_started and policy_denied are told apart by code', async (t) => {
  const env = policyEnv(t);
  const masked = await draftedTask(env, { dedupeKey: 'masked', requests: [{ ...examplePayload(), api_key: 'sk-secret-value' }] });
  assert.equal(code(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: masked.taskId, hash: hashOf(env, 'task', masked.taskId) })), 'masked');

  const started = await draftedTask(env, { dedupeKey: 'started' });
  const [draft] = draftsOf(env.db, started.taskId);
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, idempotency_retention_ms, planned_at, at)
     VALUES ('e1', ?, ?, ?, ?, ?, ?, ?, 'dispatched', 1, 86400000, ?, ?)`,
    [draft!.effect_key, started.taskId, started.draftRunId, draft!.tool, draft!.action, draft!.target, draft!.payload_hash, env.clock.nowIso(), env.clock.nowIso()],
  ));
  assert.equal(code(env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: started.taskId })), 'send_started');
  assert.equal(code(env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id: started.taskId, comment: 'again' })), 'send_started');

  const fresh = await draftedTask(env, { dedupeKey: 'fresh' });
  const freshHash = hashOf(env, 'task', fresh.taskId);
  deployDirect(env, policyText((y) => y.replace('max_usd_per_task: 5', 'max_usd_per_task: 1')));
  assert.equal(code(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: fresh.taskId, hash: freshHash })), 'policy_denied');

  const env2 = policyEnv(t);
  const old = await draftedTask(env2);
  env2.clock.advance(73 * HOUR);
  assert.equal(code(env2.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: old.taskId, hash: hashOf(env2, 'task', old.taskId) })), 'expired');
});

test('self_approval: with min_approvers 2 the requester cannot approve (code self_approval)', async (t) => {
  const env = policyEnv(t);
  deployDirect(env, policyText((y) => y.replace('min_approvers: 1', 'min_approvers: 2')));
  const { taskId } = await draftedFor(env, { causedBy: OWNER });
  const response = env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash: hashOf(env, 'task', taskId) });
  assert.deepEqual([response.ok, code(response)], [false, 'self_approval']);
  assert.equal(env.send({ cmd: 'approve', actor: REVIEWER, kind: 'task', id: taskId, hash: hashOf(env, 'task', taskId) })['ok'], true);
});

test('every coded refusal is one of the shared codes', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedFor(env);
  const probes = [
    { cmd: 'approve', kind: 'task', id: taskId, hash: STALE }, { cmd: 'release', kind: 'task', id: taskId }, { cmd: 'cancel', kind: 'task', id: 'x' },
    { cmd: 'reject', kind: 'strategy_version', id: 'none' }, { cmd: 'release', kind: 'strategy_version', id: 'none' }, { cmd: 'show', kind: 'org_proposal', id: 'none' },
    { cmd: 'approve', kind: 'policy_version', policy_text: 'not: [valid' }, { cmd: 'delegation', op: 'resume' },
  ];
  for (const probe of probes) {
    const response = env.send({ actor: OWNER, ...probe });
    assert.equal(response.ok, false, JSON.stringify(probe));
    if (response.code !== undefined) assert.ok((REFUSAL_CODES as readonly string[]).includes(response.code), `${JSON.stringify(probe)} -> ${response.code}`);
  }
});
