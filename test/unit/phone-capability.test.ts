// PhoneCapability (ADR-0014 §1): 입력 검증 → 전화 정책 → 부작용 원장. 정책·원장은 가짜로 갈아 끼우고 Capability 의 규칙만 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPhoneCapability, PhoneCapabilityError, type PhoneEffectRunner, type PhoneEffectStep } from '@aot/agent-runtime';
import { applyPhoneEvent, DENY_ALL_PHONE_CALL_POLICY, getCall, type PhoneCallPolicy, type PhoneCallPolicyRequest } from '@aot/domain';

import { ev, taskWithCall, TO } from '../support/phone.ts';
import { seededDb } from '../support/seeded-db.ts';

const GRANT = { from: '+82200000000', maxDurationSeconds: 300, recording: false, allowTransfer: true };
const allow: PhoneCallPolicy = { judge: () => ({ decision: 'allow', grant: GRANT }) };

function harness(t: Parameters<typeof seededDb>[0], options: { policy?: PhoneCallPolicy; outcome?: Awaited<ReturnType<PhoneEffectRunner>> } = {}) {
  const { db, clock } = seededDb(t);
  const { taskId, call } = taskWithCall(db, clock);
  const steps: { tool: string; step: PhoneEffectStep }[] = [];
  const requests: PhoneCallPolicyRequest[] = [];
  const policy = options.policy ?? allow;
  const dispatch: PhoneEffectRunner = (tool, step) => {
    steps.push({ tool, step });
    return Promise.resolve(options.outcome ?? { state: 'confirmed', effectId: 'e1', responseRef: call.id });
  };
  const capability = createPhoneCapability({
    db, clock, dispatch,
    policy: { judge: (request) => { requests.push(request); return policy.judge(request); } },
    run: { taskId, runId: null, subject: 'generalist@v1' },
  });
  return { db, clock, taskId, call, steps, requests, capability };
}

const rejects = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (error) => error instanceof PhoneCapabilityError && error.code === code, code);
};

test('call: validates the intent first, so malformed requests never reach the policy or the ledger', async (t) => {
  const h = harness(t);
  for (const bad of [{}, { to: '010', objective: 'qualify_lead' }, { to: TO, objective: 'Qualify Lead' }, { to: TO, objective: 'qualify_lead', prompt: 'you are a salesman' }]) {
    await rejects(h.capability.call(bad as never), 'invalid_input');
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.steps.length, 0);
});

test('call: a denied or approval-needing verdict stops before the ledger; allowed values are the policy grant, not the request', async (t) => {
  const denied = harness(t, { policy: DENY_ALL_PHONE_CALL_POLICY });
  await rejects(denied.capability.call({ to: TO, objective: 'qualify_lead' }), 'policy_denied');
  assert.equal(denied.steps.length, 0);

  const approval = harness(t, { policy: { judge: () => ({ decision: 'require_approval', reason: 'needs a person' }) } });
  await rejects(approval.capability.call({ to: TO, objective: 'qualify_lead' }), 'approval_required');
  assert.equal(approval.steps.length, 0);

  const h = harness(t);
  const handle = await h.capability.call({ to: TO, objective: 'qualify_lead', context: { leadId: 'lead_1' }, constraints: { maxDurationSeconds: 9000, recording: true } });
  assert.equal(handle.callId, h.call.id);
  assert.equal(h.steps.length, 1);
  const { tool, step } = h.steps[0]!;
  assert.deepEqual([tool, step.action], ['phone_call', 'call']);
  assert.deepEqual(step.request, { to: TO, from: '+82200000000', objective: 'qualify_lead', context: { leadId: 'lead_1' }, maxDurationSeconds: 300, allowTransfer: true, recording: false });
  assert.ok(!step.target.includes('0000000'), 'the ledger target is the masked number when the task declares no target');
  assert.equal(h.requests[0]?.kind, 'call');
});

test('call: the same intent is the same ledger step (a retry cannot dial twice), a different number is a different step', async (t) => {
  const h = harness(t);
  await h.capability.call({ to: TO, objective: 'qualify_lead', context: { a: 1 } });
  await h.capability.call({ to: TO, objective: 'qualify_lead', context: { a: 1 }, constraints: { maxDurationSeconds: 60 } });
  await h.capability.call({ to: '+821000000002', objective: 'qualify_lead', context: { a: 1 } });
  const ids = h.steps.map((s) => s.step.stepId);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
});

test('call: unknown and failed ledger outcomes surface as distinct errors; an unknown outcome is never retried by the capability', async (t) => {
  const unknown = harness(t, { outcome: { state: 'unknown', effectId: 'e' } });
  await rejects(unknown.capability.call({ to: TO, objective: 'qualify_lead' }), 'outcome_unknown');
  assert.equal(unknown.steps.length, 1);
  const failed = harness(t, { outcome: { state: 'failed', effectId: 'e' } });
  await rejects(failed.capability.call({ to: TO, objective: 'qualify_lead' }), 'provider_failed');
});

test('call: numbers outside the approved task targets are refused before the policy is asked; a declared target is what the ledger sees', async (t) => {
  const { db, clock } = seededDb(t);
  const { taskId, call } = taskWithCall(db, clock);
  const steps: PhoneEffectStep[] = [];
  const asked: string[] = [];
  const capability = createPhoneCapability({
    db, clock, policy: { judge: (r) => { asked.push(r.to); return allow.judge(r); } },
    dispatch: (_tool, step) => { steps.push(step); return Promise.resolve({ state: 'confirmed', effectId: 'e', responseRef: call.id }); },
    run: { taskId, runId: null, subject: 'generalist@v1', allowedTargets: { call: [TO, '+8210555*'], transfer: null } },
  });
  await rejects(capability.call({ to: '+821000000002', objective: 'qualify_lead' }), 'not_allowed');
  assert.deepEqual(asked, []);
  await capability.call({ to: TO, objective: 'qualify_lead' });
  await capability.call({ to: '+821055512345', objective: 'qualify_lead' });
  assert.deepEqual(steps.map((s) => s.target), [TO, '+8210555*']);
});

test('getCall: only the calls of the run\'s own task are visible', async (t) => {
  const h = harness(t);
  assert.equal((await h.capability.getCall(h.call.id)).id, h.call.id);
  await rejects(h.capability.getCall('call-nope'), 'not_found');
  const other = taskWithCall(h.db, h.clock, { trigger: { kind: 'manual', ref: 'actor:other' } });
  await rejects(h.capability.getCall(other.call.id), 'not_found');
  await rejects(h.capability.hangup(other.call.id), 'not_found');
  await rejects(h.capability.transfer({ callId: other.call.id, to: '+82200000009' }), 'not_found');
});

test('hangup: a call that never reached the provider is cancelled locally; an ended call is a no-op; a live call goes through the ledger', async (t) => {
  const h = harness(t);
  await h.capability.hangup(h.call.id);
  assert.equal(getCall(h.db, h.call.id).status, 'cancelled');
  assert.equal(h.steps.length, 0, 'no provider action for a call that was never dialed');
  await h.capability.hangup(h.call.id);
  assert.equal(h.steps.length, 0);

  const live = harness(t);
  applyPhoneEvent(live.db, live.clock, ev('phone.call.initiated', 'p-h', live.clock.nowIso(), { callId: live.call.id }));
  await live.capability.hangup(live.call.id);
  assert.deepEqual(live.steps.map((s) => [s.tool, s.step.action, s.step.stepId]), [['phone_hangup', 'hangup', `phone.hangup:${live.call.id}`]]);
  assert.equal(getCall(live.db, live.call.id).status, 'initiated', 'only the provider\'s event ends the call');
});

test('transfer: only a connected call, only to an allowed target, only when the call allows it', async (t) => {
  const h = harness(t);
  await rejects(h.capability.transfer({ callId: h.call.id, to: '+82200000009' }), 'not_allowed'); // 아직 queued
  applyPhoneEvent(h.db, h.clock, ev('phone.call.connected', 'p-t', h.clock.nowIso(), { callId: h.call.id }));
  await h.capability.transfer({ callId: h.call.id, to: '+82200000009', reason: 'escalation' });
  assert.deepEqual(h.requests.map((r) => [r.kind, r.callAllowsTransfer]), [['transfer', true]]);
  assert.deepEqual(h.steps.map((s) => [s.tool, s.step.action]), [['phone_transfer', 'transfer']]);
  await rejects(h.capability.transfer({ callId: 'x', to: 'nope' } as never), 'invalid_input');
  const noTransfer = harness(t, { policy: { judge: (r) => (r.kind === 'transfer' ? { decision: 'deny', reason: 'not an operator' } : allow.judge(r)) } });
  applyPhoneEvent(noTransfer.db, noTransfer.clock, ev('phone.call.connected', 'p-t2', noTransfer.clock.nowIso(), { callId: noTransfer.call.id }));
  await rejects(noTransfer.capability.transfer({ callId: noTransfer.call.id, to: '+82200000008' }), 'policy_denied');
  assert.equal(noTransfer.steps.length, 0);
});
