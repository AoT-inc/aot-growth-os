// 게시 게이트 (phase-a §3 "외부 게시" A3 판정, memory-item 규칙 7): 승인 없는 public/customer 게시 거부,
// internal 이상 민감도 입력의 public 게시 거부(승인과 무관), confidential 이상 입력은 승인 필요.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TransitionError } from '@aot/domain';
import { transitionPublication, type PublicationTransitionRequest } from '@aot/policy';

import { createWithGate, decisionsOf, deployDirect, HOUR, OWNER, policyEnv, readOnlyDraft, withExtraRule, type PolicyEnv } from '../support/policy.ts';

function publication(env: PolicyEnv, audience: 'internal' | 'customer' | 'public', id = `pub-${audience}`): { id: string; taskId: string } {
  const taskId = createWithGate(env, readOnlyDraft({ inputs: [{ name: 'n', ref: `r:${id}`, kind: 'k' }] }));
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO publication (id, task_id, channel, audience, content_ref, status) VALUES (?, ?, 'public-web', ?, 'sha256:example-content', 'draft')",
    [id, taskId, audience],
  ));
  return { id, taskId };
}
const publish = (env: PolicyEnv, id: string, extra: Partial<PublicationTransitionRequest> = {}) =>
  env.db.writeTx((tx) => transitionPublication(tx, env.store, { publicationId: id, to: 'published', by: 'system', now: env.clock.nowIso(), ...extra }));
const statusOf = (env: PolicyEnv, id: string) => env.db.get<{ status: string; approval_id: string | null }>('SELECT status, approval_id FROM publication WHERE id = ?', [id])!;

test('public and customer publications without an approval are refused, and the refusal is recorded', (t) => {
  const env = policyEnv(t);
  for (const audience of ['public', 'customer'] as const) {
    const { id, taskId } = publication(env, audience);
    const result = publish(env, id);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /approval required/);
    assert.equal(statusOf(env, id).status, 'draft');
    const decision = decisionsOf(env.db, taskId).at(-1)!;
    assert.deepEqual([decision.action, decision.scope, decision.impact, decision.decision], ['publication.publish', audience, 'external_effect', 'require_approval']);
  }
});

test('approved (after cooldown and TOTP) public publication is published with the approval id', (t) => {
  const env = policyEnv(t);
  const { id } = publication(env, 'public');
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'publication', id });
  const approved = env.send({ cmd: 'approve', actor: OWNER, kind: 'publication', id, hash: shown['hash'] });
  assert.equal(approved['state'], 'cooldown');
  assert.equal(statusOf(env, id).status, 'pending_approval');
  assert.equal(publish(env, id).ok, false, 'cooldown');
  env.clock.advance(HOUR);
  const waiting = publish(env, id);
  assert.match(waiting.ok ? '' : waiting.reason, /re-authentication \(TOTP\) is required/);
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'publication', id, totp: env.code() }).ok, true);
  const result = publish(env, id);
  assert.deepEqual(result, { ok: true, approvalId: approved['approval_id'] });
  assert.deepEqual({ ...statusOf(env, id) }, { status: 'published', approval_id: approved['approval_id'] });
});

test('internal or more sensitive inputs never go to a public audience, even with an approval', (t) => {
  const env = policyEnv(t);
  const { id } = publication(env, 'public');
  env.send({ cmd: 'approve', actor: OWNER, kind: 'publication', id, hash: env.send({ cmd: 'show', actor: OWNER, kind: 'publication', id })['hash'] });
  env.clock.advance(HOUR);
  env.send({ cmd: 'release', actor: OWNER, kind: 'publication', id, totp: env.code() });
  for (const sensitivity of ['internal', 'confidential', 'restricted'] as const) {
    const result = publish(env, id, { inputSensitivities: ['public', sensitivity] });
    assert.equal(result.ok, false, sensitivity);
    assert.match(result.ok ? '' : result.reason, new RegExp(`sensitivity ${sensitivity} cannot be published to 'public'`));
  }
  assert.equal(publish(env, id, { inputSensitivities: ['public'] }).ok, true);
});

test('internal publications: denied by the default policy; with an allow rule, confidential inputs still need an approval (rule 7)', (t) => {
  const env = policyEnv(t);
  const blocked = publication(env, 'internal', 'pub-blocked');
  assert.match(String((publish(env, blocked.id) as { reason: string }).reason), /default deny/);

  env.clock.advance(1);
  deployDirect(env, withExtraRule('{id: internal-wiki, action: ["publication.publish"], resource: ["public-web:*"], scope: [internal], impact: [write], decision: allow}'));
  const plain = publication(env, 'internal', 'pub-plain');
  assert.deepEqual(publish(env, plain.id, { inputSensitivities: ['internal'] }), { ok: true, approvalId: null });

  const secret = publication(env, 'internal', 'pub-confidential');
  const refused = publish(env, secret.id, { inputSensitivities: ['confidential'] });
  assert.match(refused.ok ? '' : refused.reason, /approval required/);
  assert.match(decisionsOf(env.db, secret.taskId).at(-1)!.reason, /confidential or restricted inputs need an approval \(memory-item rule 7\)/);
});

test('agents cannot change publication state', (t) => {
  const env = policyEnv(t);
  const { id } = publication(env, 'internal');
  assert.throws(() => env.db.writeTx((tx) => transitionPublication(tx, env.store, { publicationId: id, to: 'pending_approval', by: 'agent', now: env.clock.nowIso() })), TransitionError);
});
