// 전화 Capability 통합 (ADR-0014): Task → (게이트웨이) → PhoneCapability → 부작용 원장 → Fake provider → webhook → Call 상태 → 검증 → 평가 → 업무 결과.
// 실제 정책 게이트·승인 엔진(사람 승인 + cooldown + TOTP)·업무 엔진·평가기·도구 게이트웨이를 쓰고 provider 만 가짜다. 실제 전화는 없다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakePhoneProvider, createPhoneEffectTools, type AdapterOutput, type AgentAdapter, type FakeWireEvent } from '@aot/agent-runtime';
import { getCall, getCallOutcome, getTranscript, listCallsForTask, type Call } from '@aot/domain';
import { createTask } from '@aot/task-engine';

import { taskStatus } from '../support/engine.ts';
import { evaluationsOf } from '../support/evaluation.ts';
import { OUR_NUMBER, TO } from '../support/phone.ts';
import {
  CALL_ARGS, createApprovedTask, phoneRig, phoneTaskSpec, TRANSFER_TO, withPhoneSection, type PhoneRig,
} from '../support/phone-rig.ts';
import { decisionsOf, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';

const NOW = '2026-10-19T02:00:00.000Z';
const wire = (kind: FakeWireEvent['kind'], id: string, call: string, extra: Partial<FakeWireEvent> = {}): FakeWireEvent => ({ kind, id, call, at: NOW, ...extra });

const ENDED = {
  reason: 'customer-ended-call', seconds: 111, cost: 0.37,
  lines: [{ who: 'assistant', said: '안녕하세요, AoT 입니다.' }, { who: 'user', said: '네, 말씀하세요.' }, { who: 'assistant', said: '제품 도입 의향을 여쭙고 싶습니다.' }, { who: 'user', said: '데모를 보고 싶어요.' }],
  language: 'ko',
  summary: { label: 'qualified', text: '고객이 제품 도입에 관심을 보였고 데모를 요청함', data: { budgetKnown: true, timeline: 'this_quarter', decisionMakerReached: true }, next: 'schedule_demo' },
} satisfies Partial<FakeWireEvent>;

const onlyCall = (env: PolicyEnv, taskId: string): Call => {
  const calls = listCallsForTask(env.db, taskId);
  assert.equal(calls.length, 1, 'exactly one call for the task');
  return calls[0]!;
};

test('outbound: the run returns a handle at once, the task waits for the call, and only the system verdict completes it', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env);
  const taskId = createApprovedTask(env);

  // 1) 에이전트 run: 통화를 걸고 바로 결과를 제출한다 (통화가 끝나길 기다리지 않는다)
  const first = await rig.tick();
  assert.equal(first.executed?.taskId, taskId);
  assert.equal(taskStatus(env.db, taskId), 'validating');
  const call = onlyCall(env, taskId);
  assert.equal(call.status, 'initiated');
  assert.equal(call.direction, 'outbound');
  assert.equal(call.providerCallId, rig.port.providerCallIdOf(call.id));
  assert.equal(rig.port.started.length, 1);
  assert.deepEqual(
    { to: rig.port.started[0]!.to, from: rig.port.started[0]!.from, objective: rig.port.started[0]!.objective, context: rig.port.started[0]!.context, maxDurationSeconds: rig.port.started[0]!.maxDurationSeconds, allowTransfer: rig.port.started[0]!.allowTransfer, recording: rig.port.started[0]!.recording },
    { to: TO, from: '+82200000000', objective: 'qualify_lead', context: CALL_ARGS.context, maxDurationSeconds: 600, allowTransfer: true, recording: false },
  );
  const result = JSON.parse(env.db.get<{ result: string }>('SELECT result FROM task_run WHERE task_id = ?', [taskId])!.result) as { tool_results: { tool: string; result: { callId: string; status: string } }[] };
  assert.deepEqual(result.tool_results[0]!.result, { callId: call.id, status: 'initiated' });

  // 2) 에이전트가 "관심 있다고 했습니다"라고 보고했지만 통화는 아직 진행 중이다: 완료도 실패도 아니고 검증은 보류된다
  const waiting = await rig.tick();
  assert.deepEqual(waiting.validated, []);
  assert.equal(taskStatus(env.db, taskId), 'validating');
  assert.equal(evaluationsOf(env.db, taskId).length, 0, 'no evaluation is written while the call is open');

  // 3) provider 이벤트(webhook)가 Call 상태를 갱신한다
  const providerCallId = call.providerCallId!;
  await rig.webhook([wire('ringing', 'a-1', providerCallId)]);
  assert.equal(getCall(env.db, call.id).status, 'ringing');
  await rig.webhook([wire('answered', 'a-2', providerCallId)]);
  assert.equal(getCall(env.db, call.id).status, 'connected');
  assert.equal((await rig.tick()).validated.length, 0, 'a connected call is still open');
  await rig.webhook([wire('speech', 'a-2b', providerCallId, { lines: ENDED.lines.slice(0, 2) })]);
  const done = await rig.webhook([wire('ended', 'a-3', providerCallId, ENDED)]);
  assert.equal(done.status, 200);
  assert.equal(getCall(env.db, call.id).status, 'completed');
  assert.equal(taskStatus(env.db, taskId), 'validating', 'the call ending does not complete the task: the evaluator does');

  // 4) 통화가 끝났으니 다음 tick 에 검증·평가되어 완료된다
  const last = await rig.tick();
  assert.deepEqual(last.validated.map((v) => [v.taskId, v.taskStatus]), [[taskId, 'completed']]);
  const [evaluation] = evaluationsOf(env.db, taskId);
  assert.equal(evaluation?.outcome, 'pass');
  assert.equal(evaluation?.safety, 'pass');

  // 산출물: canonical transcript, 구조화된 outcome (상대의 말에서 나온 데이터라 external_untrusted)
  assert.deepEqual(getTranscript(env.db, call.id)?.turns.map((turn) => turn.speaker), ['agent', 'customer', 'agent', 'customer']);
  const outcome = getCallOutcome(env.db, call.id);
  assert.deepEqual([outcome?.disposition, outcome?.nextAction, outcome?.trustOrigin], ['qualified', 'schedule_demo', 'external_untrusted']);

  // 부작용 원장·정책 판정·비용·이벤트
  const effect = env.db.get<{ tool: string; action: string; target: string; state: string; supports_idempotency: number; response_ref: string }>('SELECT tool, action, target, state, supports_idempotency, response_ref FROM external_effect WHERE task_id = ?', [taskId])!;
  assert.deepEqual({ ...effect, supports_idempotency: Number(effect.supports_idempotency) }, { tool: 'phone_call', action: 'call', target: TO, state: 'confirmed', supports_idempotency: 0, response_ref: call.id });
  const decisions = decisionsOf(env.db, taskId).filter((d) => d.action === 'phone_call.call' && d.task_run_id !== null);
  assert.ok(decisions.some((d) => d.decision === 'allow' && /phone policy/.test(d.reason)), 'the phone policy decision is recorded');
  assert.ok(decisions.every((d) => d.decision !== 'deny'));
  assert.deepEqual(env.db.all('SELECT category, amount_usd FROM cost_entry WHERE category = ?', ['external']).map((r) => ({ ...r })), [{ category: 'external', amount_usd: 0.37 }]);
  const events = env.db.all<{ type: string }>("SELECT type FROM event WHERE source = 'phone' ORDER BY received_at, rowid").map((e) => e.type);
  assert.deepEqual(events, ['phone.call.requested', 'phone.call.initiated', 'phone.call.ringing', 'phone.call.connected', 'phone.call.transcript.updated', 'phone.call.completed']);
});

test('the same webhook delivered again changes nothing (no second cost, no second event)', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env);
  const taskId = createApprovedTask(env);
  await rig.tick();
  const call = onlyCall(env, taskId);
  const request = rig.port.webhook([wire('answered', 'd-1', call.providerCallId!), wire('ended', 'd-2', call.providerCallId!, ENDED)]);
  const first = await rig.daemon.phone!.ingest(request);
  const again = await rig.daemon.phone!.ingest(request);
  assert.deepEqual(first.applied.map((a) => a.result), ['applied', 'applied']);
  assert.deepEqual(again.applied.map((a) => a.result), ['duplicate', 'duplicate']);
  assert.equal(env.db.all("SELECT 1 FROM cost_entry WHERE category = 'external'").length, 1);
  assert.equal(env.db.all("SELECT 1 FROM event WHERE type = 'phone.call.completed'").length, 1);
});

test('webhook authenticity and format: a wrong secret or a malformed body applies nothing', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env);
  const taskId = createApprovedTask(env);
  await rig.tick();
  const call = onlyCall(env, taskId);
  const forged = await rig.daemon.phone!.ingest(rig.port.webhook([wire('ended', 'f-1', call.providerCallId!, ENDED)], { secret: 'wrong' }));
  assert.equal(forged.status, 401);
  const unsigned = await rig.daemon.phone!.ingest(rig.port.webhook([wire('ended', 'f-2', call.providerCallId!, ENDED)], { secret: null }));
  assert.equal(unsigned.status, 401);
  const malformed = await rig.daemon.phone!.ingest({ headers: { 'x-fake-secret': 'fake-secret' }, body: '{not json' });
  assert.equal(malformed.status, 400);
  assert.equal(getCall(env.db, call.id).status, 'initiated');
  // 알 수 없는 통화의 이벤트는 200 으로 받되 아무것도 쓰지 않는다
  const unknown = await rig.webhook([wire('answered', 'u-1', 'someone-elses-call')]);
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.applied.map((a) => a.result), ['unknown_call']);
});

test('a task is never completed by the agent report alone: if the provider never reports, the deadline closes the call and the evaluation does not pass', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env);
  const taskId = createApprovedTask(env);
  await rig.tick();
  const call = onlyCall(env, taskId);
  assert.equal(taskStatus(env.db, taskId), 'validating');

  env.clock.advance(60_000);
  assert.deepEqual((await rig.daemon.phone!.reconcile()).expired, [], 'not overdue yet');
  assert.equal(taskStatus(env.db, taskId), 'validating');

  env.clock.advance((600 + 300) * 1000); // 최대 통화시간 600초 + 유예 5분
  const report = await rig.daemon.phone!.reconcile();
  assert.deepEqual(report.expired, [call.id]);
  assert.equal(getCall(env.db, call.id).status, 'failed');
  assert.match(getCall(env.db, call.id).endReason ?? '', /deadline_exceeded/);

  const validated = await rig.tick();
  assert.equal(validated.validated.length, 1);
  assert.notEqual(taskStatus(env.db, taskId), 'completed');
  assert.equal(evaluationsOf(env.db, taskId)[0]?.outcome, 'fail');
});

test('reconciliation asks the provider first: a call that ended while the webhook was lost is closed from the provider state', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env);
  const taskId = createApprovedTask(env);
  await rig.tick();
  const call = onlyCall(env, taskId);
  rig.port.setSnapshot(call.providerCallId!, [wire('answered', 'r-1', call.providerCallId!), wire('ended', 'r-2', call.providerCallId!, ENDED)]);
  env.clock.advance((600 + 300 + 1) * 1000);
  const report = await rig.daemon.phone!.reconcile();
  assert.deepEqual([report.closedByProvider, report.expired], [[call.id], []]);
  assert.equal(getCall(env.db, call.id).status, 'completed');
  assert.deepEqual((await rig.tick()).validated.map((v) => v.taskStatus), ['completed']);
});

test('a lost provider response is "unknown": the number is never dialed a second time automatically', async (t) => {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  port.loseNextStartResponse();
  const rig = phoneRig(env, { port });
  const taskId = createApprovedTask(env);
  await rig.tick();
  assert.equal(port.started.length, 1);
  const effect = env.db.get<{ state: string }>('SELECT state FROM external_effect WHERE task_id = ?', [taskId])!;
  assert.equal(effect.state, 'unknown');
  assert.notEqual(taskStatus(env.db, taskId), 'completed');
  for (let i = 0; i < 3; i += 1) {
    env.clock.advance(60_000);
    await rig.tick();
  }
  assert.equal(port.started.length, 1, 'no automatic redial after an unknown outcome');
  assert.equal(taskStatus(env.db, taskId), 'needs_review', 'a person decides');
});

test('a provider that clearly refuses (bad request) is a failed call, recorded without dialing', async (t) => {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  const rig = phoneRig(env, { port });
  const taskId = createApprovedTask(env);
  // 접수 전에 provider 가 요청을 거절한다 (처리되지 않았음이 확실한 오류)
  const { PhoneProviderError } = await import('@aot/domain');
  port.failNextStart(new PhoneProviderError('invalid_request', 'start call: HTTP 422', { status: 422 }));
  await rig.tick();
  const call = onlyCall(env, taskId);
  assert.equal(call.status, 'failed');
  assert.match(call.endReason ?? '', /rejected/);
  assert.equal(env.db.get<{ state: string }>('SELECT state FROM external_effect WHERE task_id = ?', [taskId])!.state, 'failed');
});

test('policy: a number outside the allowed regions is denied before anything reaches the provider, and the decision is recorded masked', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env, { adapterConfig: { toolCalls: [{ tool: 'phone_call', args: { ...CALL_ARGS, to: '+15550100123' } }] } });
  const taskId = createApprovedTask(env, phoneTaskSpec({}, { call: '+1555*' }));
  await rig.tick();
  assert.equal(rig.port.started.length, 0);
  assert.equal(listCallsForTask(env.db, taskId).length, 0);
  const denied = env.db.all<{ decision: string; resource: string; reason: string }>("SELECT decision, resource, reason FROM policy_decision WHERE action = 'phone_call.call' AND reason LIKE '%phone policy%'");
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.decision, 'deny');
  assert.match(denied[0]!.reason, /outside the allowed regions/);
  assert.ok(!denied[0]!.resource.includes('5550100123'), 'the number is masked in the decision record');
  assert.equal(rig.records.find((r) => r.tool === 'phone_call')?.outcome, 'tool_error');
});

test('a policy without a phone section denies every call (default deny)', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env, { policy: withPhoneSection('') });
  const taskId = createApprovedTask(env);
  await rig.tick();
  assert.equal(rig.port.started.length, 0);
  assert.equal(listCallsForTask(env.db, taskId).length, 0);
  assert.notEqual(taskStatus(env.db, taskId), 'completed');
});

test('the approved task bounds the numbers: a call outside the target the person approved is refused', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env, { adapterConfig: { toolCalls: [{ tool: 'phone_call', args: { ...CALL_ARGS, to: '+821000000002' } }] } });
  const taskId = createApprovedTask(env, phoneTaskSpec({}, { call: TO }));
  await rig.tick();
  assert.equal(rig.port.started.length, 0);
  assert.equal(listCallsForTask(env.db, taskId).length, 0);
  assert.equal(rig.records.find((r) => r.tool === 'phone_call')?.outcome, 'tool_error');
});

test('without the person\'s approval the run does not start, so nothing is dialed', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env);
  const { createWithGate } = await import('../support/policy.ts');
  const taskId = createWithGate(env, phoneTaskSpec());
  const report = await rig.tick();
  assert.equal(report.executed, null);
  assert.equal(taskStatus(env.db, taskId), 'needs_review');
  assert.equal(rig.port.started.length, 0);
});

/** 통화를 걸고, 연결되면 사람에게 넘기는 에이전트 */
function escalatingAgent(getRig: () => PhoneRig, port: ReturnType<typeof createFakePhoneProvider>, callArgs: Record<string, unknown> = CALL_ARGS): AgentAdapter {
  return {
    name: 'escalating-agent',
    async run(_input, context): Promise<AdapterOutput> {
      const placed = await context.gateway.call('phone_call', callArgs as never);
      if (!placed.ok) return { status: 'error', result: null, evidence: [], run_log: [], cost: {}, error: { code: 'call_failed', message: placed.error } };
      const { callId } = placed.result as { callId: string };
      await getRig().webhook([wire('answered', 'e-1', port.providerCallIdOf(callId)!)]);
      const moved = await context.gateway.call('phone_transfer', { callId, to: TRANSFER_TO, reason: 'high-risk request' });
      return { status: 'submitted', result: { callId, transferred: moved.ok }, evidence: [], run_log: [], cost: { usd: 0 } };
    },
  };
}

test('human escalation: a connected call is transferred to an allowed operator and the Call state records it', async (t) => {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  const holder: { rig: PhoneRig | null } = { rig: null };
  const rig = phoneRig(env, { port, adapter: escalatingAgent(() => holder.rig!, port) });
  holder.rig = rig;
  const taskId = createApprovedTask(env, phoneTaskSpec({}, { call: TO, transfer: TRANSFER_TO }));
  await rig.tick();
  const call = onlyCall(env, taskId);
  assert.equal(call.status, 'transferred');
  assert.deepEqual(port.transfers.map((x) => [x.providerCallId, x.request.to, x.request.reason]), [[call.providerCallId, TRANSFER_TO, 'high-risk request']]);
  assert.deepEqual(env.db.all<{ tool: string; state: string }>('SELECT tool, state FROM external_effect WHERE task_id = ? ORDER BY tool', [taskId]).map((e) => [e.tool, e.state]), [['phone_call', 'confirmed'], ['phone_transfer', 'confirmed']]);
  // 사람이 통화를 끝내면 완료된다
  await rig.webhook([wire('ended', 'e-2', call.providerCallId!, ENDED)]);
  assert.equal(getCall(env.db, call.id).status, 'completed');
  assert.deepEqual((await rig.tick()).validated.map((v) => v.taskStatus), ['completed']);
});

test('escalation to a number that is not an allowed operator is refused', async (t) => {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  const holder: { rig: PhoneRig | null } = { rig: null };
  const agent: AgentAdapter = {
    name: 'nasty-agent',
    async run(_input, context): Promise<AdapterOutput> {
      const placed = await context.gateway.call('phone_call', CALL_ARGS as never);
      const { callId } = (placed as { ok: true; result: { callId: string } }).result;
      await holder.rig!.webhook([wire('answered', 'n-1', port.providerCallIdOf(callId)!)]);
      const moved = await context.gateway.call('phone_transfer', { callId, to: '+82200000008' });
      return { status: 'submitted', result: { transferred: moved.ok }, evidence: [], run_log: [], cost: {} };
    },
  };
  const rig = phoneRig(env, { port, adapter: agent });
  holder.rig = rig;
  const taskId = createApprovedTask(env, phoneTaskSpec({}, { call: TO, transfer: '+82200000008' }));
  await rig.tick();
  assert.equal(onlyCall(env, taskId).status, 'connected', 'the call is untouched');
  assert.equal(port.transfers.length, 0);
});

test('inbound: a routed call becomes a Call linked to a task, the directive is returned to the provider, and later events fill the evidence', async (t) => {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  let created = 0;
  const rig = phoneRig(env, {
    port,
    routes: [
      { id: 'support', to: [OUR_NUMBER], target: { kind: 'agent', orgUnit: 'core', role: 'generalist', objective: 'handle_support' } },
    ],
    createInboundTask: (call, target) => {
      created += 1;
      const spec = readOnlyDraft({
        objective: `수신 통화(${target.objective})를 처리한다`, inputs: [{ name: 'call', ref: `call:${call.id}`, kind: 'call' }],
        validation: { deterministic: ['call_completed', 'call_transcript_present'], llm: null, human: false },
      });
      return { taskId: createTask(env.db, { clock: env.clock, gate: env.gate }, { spec, causedBy: 'system:phone-inbound' }).taskId };
    },
  });
  const reply = await rig.webhook([wire('dialing', 'i-1', 'prov-in-1', { direction: 'in', from: TO, to: OUR_NUMBER })], true);
  assert.equal(reply.status, 200);
  const body = reply.body as { fakeDirective: string; callId: string };
  assert.equal(body.fakeDirective, 'connect_agent');
  const call = getCall(env.db, body.callId);
  assert.deepEqual([call.direction, call.status, call.from, call.to, created], ['inbound', 'initiated', TO, OUR_NUMBER, 1]);
  assert.ok(call.taskId, 'the call is linked to the task created for it');
  assert.equal(call.objective, 'handle_support');

  await rig.webhook([wire('answered', 'i-2', 'prov-in-1')]);
  await rig.webhook([wire('ended', 'i-3', 'prov-in-1', ENDED)]);
  const refs = env.db.all<{ ref: string }>('SELECT ref FROM evidence WHERE task_id = ? ORDER BY ref', [call.taskId]).map((r) => r.ref);
  assert.deepEqual(refs, [`call:${call.id}`, `call:${call.id}#outcome`, `call:${call.id}#transcript`]);
  assert.equal(getCall(env.db, call.id).status, 'completed');
});

test('inbound: no matching route rejects the call (default deny), creates no task, and ends the Call as cancelled', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env, { routes: [{ id: 'support', to: [OUR_NUMBER], target: { kind: 'agent', orgUnit: 'core', role: 'generalist', objective: 'handle_support' } }] });
  const reply = await rig.webhook([wire('dialing', 'x-1', 'prov-in-2', { direction: 'in', from: TO, to: '+82200000777' })], true);
  const body = reply.body as { fakeDirective: string; callId: string };
  assert.equal(body.fakeDirective, 'reject');
  const call = getCall(env.db, body.callId);
  assert.equal(call.status, 'cancelled');
  assert.match(call.endReason ?? '', /no_route/);
  assert.equal(call.taskId, null);
  assert.equal(env.db.get('SELECT count(*) AS n FROM task')?.['n'], 0);
});

test('inbound: a failing task factory rejects the call instead of leaving it unanswered', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env, {
    routes: [{ id: 'support', target: { kind: 'agent', orgUnit: 'core', role: 'generalist', objective: 'handle_support' } }],
    createInboundTask: () => { throw new Error('cannot create a task'); },
  });
  const reply = await rig.webhook([wire('dialing', 'y-1', 'prov-in-3', { direction: 'in', from: TO, to: OUR_NUMBER })], true);
  assert.equal((reply.body as { fakeDirective: string }).fakeDirective, 'reject');
  assert.equal(getCall(env.db, (reply.body as { callId: string }).callId).status, 'cancelled');
});

test('inbound: a route to a human returns a transfer directive without involving an agent', async (t) => {
  const env = policyEnv(t);
  const rig = phoneRig(env, { routes: [{ id: 'vip', from: ['+82101111*'], target: { kind: 'human', number: TRANSFER_TO } }] });
  const reply = await rig.webhook([wire('dialing', 'z-1', 'prov-in-4', { direction: 'in', from: '+821011112222', to: OUR_NUMBER })], true);
  assert.equal((reply.body as { fakeDirective: string }).fakeDirective, 'transfer');
  assert.equal(env.db.get('SELECT count(*) AS n FROM task')?.['n'], 0);
});

test('with a phone section present but the phone runtime absent, nothing is offered to the agent', async (t) => {
  // 전화 런타임을 조립하지 않으면 전화 도구가 에이전트에게 열리지 않는다 (명세가 요청해도)
  const env = policyEnv(t);
  const { assembleDaemon } = await import('../../apps/daemon/src/assemble.ts');
  const { createFakeAgentAdapter } = await import('@aot/agent-runtime');
  const { ManualGatewayTimers } = await import('../support/gateway-contract.ts');
  const { manualTimers } = await import('../support/engine.ts');
  const { join } = await import('node:path');
  const { deployDirect, AGENT } = await import('../support/policy.ts');
  deployDirect(env, withPhoneSection());
  const records: { tool: string; outcome: string }[] = [];
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: { adapter: createFakeAgentAdapter({ clock: env.clock, scenario: 'tool_calls', toolCalls: [{ tool: 'phone_call', args: CALL_ARGS }] }), timers: new ManualGatewayTimers(), recorder: { record: (r) => void records.push(r) } },
  });
  assert.equal(daemon.phone, null);
  createApprovedTask(env);
  await daemon.worker.tick();
  assert.equal(records.find((r) => r.tool === 'phone_call')?.outcome, 'tool_not_allowed');
});


test('a transfer whose response is lost is "unknown": it is not repeated automatically, and a provider status update lets the ledger confirm it afterwards', async (t) => {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  port.loseNextTransferResponse();
  const holder: { rig: PhoneRig | null } = { rig: null };
  const rig = phoneRig(env, { port, adapter: escalatingAgent(() => holder.rig!, port) });
  holder.rig = rig;
  const taskId = createApprovedTask(env, phoneTaskSpec({}, { call: TO, transfer: TRANSFER_TO }));
  await rig.tick();
  const call = onlyCall(env, taskId);
  assert.equal(port.transfers.length, 1, 'the transfer was attempted once');
  const effect = env.db.get<{ effect_key: string; state: string; supports_idempotency: number }>("SELECT effect_key, state, supports_idempotency FROM external_effect WHERE tool = 'phone_transfer'")!;
  assert.deepEqual([effect.state, Number(effect.supports_idempotency)], ['unknown', 0], 'unknown, on a tool that declares no idempotency key: never resent');
  assert.equal(call.status, 'connected', 'we do not claim a transfer we could not confirm');
  for (let i = 0; i < 3; i += 1) {
    env.clock.advance(60_000);
    await rig.tick();
  }
  assert.equal(port.transfers.length, 1, 'no automatic second transfer');
  assert.equal(taskStatus(env.db, taskId), 'needs_review', 'a person decides');

  // 조회: provider 가 전환 중이라고 알려 오면(상태 이벤트) 원장이 전환을 확인할 수 있다. 확인되기 전에는 "알 수 없음"이다
  const tools = createPhoneEffectTools({ db: env.db, clock: env.clock, port });
  assert.deepEqual(await tools.phone_transfer.lookup!(effect.effect_key), { found: false });
  await rig.webhook([wire('handed_off', 'h-1', call.providerCallId!, { target: TRANSFER_TO })]);
  assert.equal(getCall(env.db, call.id).status, 'transferred');
  assert.deepEqual(await tools.phone_transfer.lookup!(effect.effect_key), { found: true, responseRef: call.id });
  assert.deepEqual(await tools.phone_transfer.lookup!('0'.repeat(64)), { found: false }, 'an unrelated key is not confirmed');
});

/** 같은 번호로 두 번 거는 에이전트 */
function dialTwice(second: Record<string, unknown>): AgentAdapter {
  return {
    name: 'dial-twice',
    async run(_input, context): Promise<AdapterOutput> {
      const first = await context.gateway.call('phone_call', CALL_ARGS as never);
      const again = await context.gateway.call('phone_call', second as never);
      return { status: 'submitted', result: { first: first.ok, again: again.ok }, evidence: [], run_log: [], cost: {} };
    },
  };
}

test('dialing the same number for the same purpose twice is one call, even when the requested limits differ (the policy grant is not part of the intent)', async (t) => {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  const rig = phoneRig(env, { port, adapter: dialTwice({ ...CALL_ARGS, constraints: { maxDurationSeconds: 300, allowTransfer: false } }) });
  const taskId = createApprovedTask(env);
  await rig.tick();
  assert.equal(port.started.length, 1);
  assert.equal(listCallsForTask(env.db, taskId).length, 1);
});

test('the same number with a different context is a different call (e.g. another lead), subject to the daily limit', async (t) => {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  const rig = phoneRig(env, { port, adapter: dialTwice({ ...CALL_ARGS, context: { leadId: 'lead_456', companyName: 'Other Corp' } }) });
  const taskId = createApprovedTask(env);
  await rig.tick();
  assert.equal(port.started.length, 2);
  assert.deepEqual(listCallsForTask(env.db, taskId).map((c) => c.status), ['initiated', 'initiated']);
});

test('a task that declares no number range cannot be created with a phone tool', async (t) => {
  const env = policyEnv(t);
  const { createWithGate } = await import('../support/policy.ts');
  assert.throws(() => createWithGate(env, phoneTaskSpec({}, {})), /needs a target/);
});
