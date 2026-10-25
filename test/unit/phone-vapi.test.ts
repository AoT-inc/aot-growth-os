// Vapi 어댑터: 가짜 fetch 로 요청 모양, 오류 변환, webhook 인증과 canonical 변환을 확인한다. 실제 Vapi 호출은 없다 (수동 smoke 절차는 docs/plans/phone-capability.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPhoneEvent, getCallOutcome, getTranscript, PhoneProviderError, validatePhoneEvent, type PhoneStartCallRequest } from '@aot/domain';
import { ingestPhoneWebhook } from '@aot/agent-runtime';

import { classifyEndedReason, createVapiAdapter, turnsFromMessages, type VapiAdapterOptions } from '../../apps/daemon/src/phone-vapi.ts';
import { definePhonePortContract } from '../support/phone-port-contract.ts';
import { ev, FROM, taskWithCall, TO } from '../support/phone.ts';
import { seededDb } from '../support/seeded-db.ts';

const API_KEY = 'test-api-key-not-real';
const SECRET = 'test-webhook-secret-not-real';
const CONTROL = 'https://control.call-1.vapi.ai/abc';

interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(answers: ((sent: Sent) => Response | Promise<Response> | Error)[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    const record: Sent = { url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
    sent.push(record);
    const answer = answers.shift();
    if (!answer) return Promise.reject(new Error('unexpected request'));
    const result = answer(record);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }) as typeof fetch;
  return { fetch: fetchImpl, sent };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const START: PhoneStartCallRequest = {
  callId: 'call-abc', effectKey: 'k'.repeat(40), to: TO, from: FROM, objective: 'qualify_lead', context: { leadId: 'lead_123', nested: { a: 1 }, vip: true },
  maxDurationSeconds: 300, allowTransfer: true, recording: false,
};

function adapter(answers: Parameters<typeof fakeFetch>[0] = [], over: Partial<VapiAdapterOptions> = {}) {
  const f = fakeFetch(answers);
  return {
    sent: f.sent,
    port: createVapiAdapter({
      apiKey: API_KEY, webhookSecret: SECRET, phoneNumbers: { [FROM]: 'pn-1' }, assistants: { qualify_lead: 'asst-sales' }, defaultAssistantId: 'asst-default',
      fetch: f.fetch, now: () => Date.parse('2026-10-25T01:00:00.000Z'), ...over,
    }),
  };
}

const webhook = (message: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) => ({ headers, body: JSON.stringify({ message }) });

definePhonePortContract('vapi', () => {
  const { port } = adapter();
  return {
    port,
    valid: webhook({ type: 'status-update', status: 'in-progress', call: { id: 'vapi-9' }, timestamp: '2026-10-25T01:00:00.000Z' }),
    forged: webhook({ type: 'status-update', status: 'in-progress', call: { id: 'vapi-9' } }, { authorization: 'Bearer wrong' }),
    malformed: { headers: { authorization: `Bearer ${SECRET}` }, body: '<<<' },
    secrets: [SECRET, API_KEY],
  };
});

test('startCall: posts the documented body with the bearer key, never sends the caller context as a prompt, and returns the provider call id', async () => {
  const { port, sent } = adapter([() => json(201, { id: 'vapi-1', status: 'queued', monitor: { controlUrl: CONTROL } })]);
  const result = await port.startCall(START);
  assert.deepEqual(result, { providerCallId: 'vapi-1', status: 'queued' });
  assert.equal(sent[0]!.url, 'https://api.vapi.ai/call');
  assert.equal(sent[0]!.method, 'POST');
  assert.equal(sent[0]!.headers['authorization'], `Bearer ${API_KEY}`);
  assert.deepEqual(sent[0]!.body, {
    phoneNumberId: 'pn-1', customer: { number: TO }, assistantId: 'asst-sales', name: 'aot:call-abc',
    assistantOverrides: {
      maxDurationSeconds: 300, variableValues: { objective: 'qualify_lead', leadId: 'lead_123', vip: true },
      metadata: { aot_call_id: 'call-abc', aot_effect_key: 'k'.repeat(40) }, artifactPlan: { recordingEnabled: false },
    },
  });
});

test('startCall: configuration problems are definite refusals (nothing was sent), and unknown objectives fall back to the default assistant', async () => {
  const none = adapter();
  await assert.rejects(none.port.startCall({ ...START, from: '+82299999999' }), (e) => e instanceof PhoneProviderError && e.definite && e.code === 'invalid_request');
  const noAssistant = adapter([], { assistants: {}, defaultAssistantId: undefined as never });
  await assert.rejects(noAssistant.port.startCall(START), (e) => e instanceof PhoneProviderError && e.definite);
  assert.equal(none.sent.length + noAssistant.sent.length, 0, 'no request was made');
  const fallback = adapter([() => json(201, { id: 'vapi-2', status: 'queued' })]);
  await fallback.port.startCall({ ...START, objective: 'unmapped_objective' });
  assert.equal((fallback.sent[0]!.body as { assistantId: string }).assistantId, 'asst-default');
});

test('startCall: HTTP and transport failures map to canonical errors; only "the provider did not process it" is definite', async () => {
  const cases: [Parameters<typeof fakeFetch>[0][number], string, boolean][] = [
    [() => json(401, { message: 'bad key' }), 'unauthorized', true],
    [() => json(422, { message: 'bad number' }), 'invalid_request', true],
    [() => json(429, {}), 'rate_limited', true],
    [() => json(500, {}), 'unavailable', false],
    [() => json(504, {}), 'timeout', false],
    [() => new TypeError('fetch failed'), 'unavailable', false],
    [() => Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'timeout', false],
    [() => json(201, { status: 'queued' }), 'unknown', false], // 통화가 만들어졌는지 알 수 없다
    [() => new Response('not json', { status: 201 }), 'unknown', false],
  ];
  for (const [answer, code, definite] of cases) {
    const { port } = adapter([answer]);
    await assert.rejects(port.startCall(START), (e) => e instanceof PhoneProviderError && e.code === code && e.definite === definite, `${code}`);
  }
  // 오류 메시지에 응답 본문이나 키가 들어가지 않는다
  const { port } = adapter([() => json(401, { message: API_KEY })]);
  await assert.rejects(port.startCall(START), (e) => e instanceof Error && !e.message.includes(API_KEY));
});

test('hangup and transfer go to the control url without the API key; control urls on other hosts or plain http are refused', async () => {
  const { port, sent } = adapter([() => json(201, { id: 'vapi-3', status: 'queued', monitor: { controlUrl: CONTROL } }), () => json(200, {}), () => json(200, {})]);
  await port.startCall(START);
  await port.hangup('vapi-3');
  await port.transfer('vapi-3', { to: '+82200000009', reason: 'escalation' });
  assert.deepEqual(sent.slice(1).map((s) => [s.url, s.method, s.body]), [
    [CONTROL, 'POST', { type: 'end-call' }],
    [CONTROL, 'POST', { type: 'transfer', destination: { type: 'number', number: '+82200000009' } }],
  ]);
  assert.ok(sent.slice(1).every((s) => s.headers['authorization'] === undefined), 'the API key is not sent to the control url');

  for (const evil of ['https://evil.example.com/x', 'http://control.vapi.ai/x', 'https://vapi.ai.evil.example.com/x', 'not a url']) {
    const bad = adapter([() => json(201, { id: 'vapi-4', status: 'queued', monitor: { controlUrl: evil } })]);
    await bad.port.startCall(START);
    await assert.rejects(bad.port.hangup('vapi-4'), (e) => e instanceof PhoneProviderError && e.definite, evil);
    assert.equal(bad.sent.length, 1, `nothing was posted to ${evil}`);
  }
});

test('hangup for a call this process did not start looks the control url up once (and a missing one is a definite failure)', async () => {
  const found = adapter([() => json(200, { id: 'vapi-5', status: 'in-progress', monitor: { controlUrl: CONTROL } }), () => json(200, {})]);
  await found.port.hangup('vapi-5');
  assert.deepEqual(found.sent.map((s) => [s.method, s.url]), [['GET', 'https://api.vapi.ai/call/vapi-5'], ['POST', CONTROL]]);
  const missing = adapter([() => json(200, { id: 'vapi-6', status: 'ended' })]);
  await assert.rejects(missing.port.hangup('vapi-6'), (e) => e instanceof PhoneProviderError && e.definite);
});

test('webhook authentication accepts the bearer form and the legacy header, compares exactly, and never accepts a missing secret', () => {
  const { port } = adapter();
  const message = { type: 'status-update', status: 'ringing', call: { id: 'vapi-7' }, timestamp: '2026-10-25T01:00:00.000Z' };
  assert.equal(port.parseWebhook(webhook(message, { authorization: `Bearer ${SECRET}` })).events.length, 1);
  assert.equal(port.parseWebhook(webhook(message, { 'x-vapi-secret': SECRET })).events.length, 1);
  for (const headers of [{}, { authorization: `Bearer ${SECRET}x` }, { 'x-vapi-secret': SECRET.slice(1) }, { authorization: '' }]) {
    assert.throws(() => port.parseWebhook(webhook(message, headers)), (e: Error) => e.name === 'PhoneWebhookError');
  }
  assert.throws(() => createVapiAdapter({ apiKey: '', webhookSecret: SECRET, phoneNumbers: {} }), /needs an API key/);
});

test('status updates map to canonical events; advisory messages are ignored', () => {
  const { port } = adapter();
  const type = (status: string) => port.parseWebhook(webhook({ type: 'status-update', status, call: { id: 'vapi-8' }, timestamp: '2026-10-25T01:00:00.000Z' })).events.map((e) => e.type);
  assert.deepEqual([type('queued'), type('ringing'), type('in-progress'), type('forwarding'), type('ended')], [['phone.call.initiated'], ['phone.call.ringing'], ['phone.call.connected'], ['phone.call.transferred'], []]);
  assert.deepEqual(port.parseWebhook(webhook({ type: 'speech-update', call: { id: 'vapi-8' } })).events, []);
  assert.deepEqual(port.parseWebhook(webhook({ type: 'brand-new-message', call: { id: 'vapi-8' } })).events, []);
});

test('end-of-call-report: the conversation (without the system prompt), the analysis split into outcome fields, the cost and the duration', () => {
  const { port } = adapter();
  const report = {
    type: 'end-of-call-report', endedReason: 'customer-ended-call', cost: 0.42, durationSeconds: 95, timestamp: '2026-10-25T01:05:00.000Z', call: { id: 'vapi-10' },
    artifact: { messages: [
      { role: 'system', message: 'You are a sales agent for Example Corp. Lead: lead_123' },
      { role: 'assistant', message: '안녕하세요.' }, { role: 'user', message: '네.' }, { role: 'tool', message: '{"x":1}' }, { role: 'bot', message: '감사합니다.' },
    ] },
    analysis: { summary: '관심을 보임', structuredData: { disposition: 'qualified', nextAction: 'schedule_demo', budgetKnown: true } },
  };
  const [event] = port.parseWebhook(webhook(report)).events;
  assert.ok(validatePhoneEvent(event).ok);
  assert.equal(event?.type, 'phone.call.completed');
  if (event?.type !== 'phone.call.completed') return;
  assert.deepEqual(event.transcript?.turns.map((t) => t.speaker), ['assistant', 'user', 'bot']);
  assert.ok(!JSON.stringify(event).includes('Example Corp'), 'the system prompt never enters the canonical event');
  assert.deepEqual(event.analysis, { summary: '관심을 보임', disposition: 'qualified', nextAction: 'schedule_demo', structuredData: { budgetKnown: true } });
  assert.deepEqual([event.costUsd, event.durationSeconds, event.endedReason], [0.42, 95, 'customer-ended-call']);
});

test('ended reasons are classified as the documentation groups them; unknown reasons are failures, not completions', () => {
  const failed = (reason: string) => classifyEndedReason(reason);
  assert.deepEqual(failed('customer-did-not-answer'), { kind: 'failed', code: 'no_answer' });
  assert.deepEqual(failed('customer-busy'), { kind: 'failed', code: 'busy' });
  assert.deepEqual(failed('voicemail'), { kind: 'failed', code: 'voicemail' });
  assert.deepEqual(failed('vonage-rejected'), { kind: 'failed', code: 'rejected' });
  assert.deepEqual(failed('twilio-failed-to-connect-call'), { kind: 'failed', code: 'provider_error' });
  assert.deepEqual(failed('pipeline-error-openai-llm-failed'), { kind: 'failed', code: 'provider_error' });
  assert.deepEqual(failed('something-new-from-vapi'), { kind: 'failed', code: 'unknown' });
  for (const ok of ['customer-ended-call', 'assistant-ended-call', 'assistant-said-end-call-phrase', 'exceeded-max-duration', 'silence-timed-out']) assert.deepEqual(classifyEndedReason(ok), { kind: 'completed' }, ok);
  assert.deepEqual(classifyEndedReason(undefined), { kind: 'completed' });
  assert.deepEqual(turnsFromMessages('nope'), []);
});

test('a call nobody answered becomes a failed event with a canonical code', () => {
  const { port } = adapter();
  const [event] = port.parseWebhook(webhook({ type: 'end-of-call-report', endedReason: 'customer-did-not-answer', call: { id: 'vapi-11' }, timestamp: '2026-10-25T01:05:00.000Z' })).events;
  assert.ok(event?.type === 'phone.call.failed' && event.code === 'no_answer');
});

test('inbound: assistant-request becomes an inbound initiated event and waits for a directive, which is answered in the documented shapes', () => {
  const { port } = adapter();
  const parsed = port.parseWebhook(webhook({ type: 'assistant-request', call: { id: 'vapi-in-1', type: 'inboundPhoneCall' }, customer: { number: TO }, phoneNumber: { number: '+82200000001' }, timestamp: '2026-10-25T01:00:00.000Z' }));
  assert.equal(parsed.awaitingDirective, true);
  const [event] = parsed.events;
  assert.ok(event?.type === 'phone.call.initiated' && event.direction === 'inbound' && event.from === TO && event.to === '+82200000001');
  assert.deepEqual(port.buildInboundReply!({ action: 'connect_agent', callId: 'c', objective: 'qualify_lead' }), { status: 200, body: { assistantId: 'asst-sales' } });
  assert.deepEqual(port.buildInboundReply!({ action: 'connect_agent', callId: 'c', objective: 'other' }), { status: 200, body: { assistantId: 'asst-default' } });
  assert.deepEqual(port.buildInboundReply!({ action: 'transfer', callId: 'c', to: '+82200000009' }), { status: 200, body: { destination: { type: 'number', number: '+82200000009' } } });
  assert.equal((port.buildInboundReply!({ action: 'reject', callId: 'c', reason: 'no_route' }).body as { error?: string }).error !== undefined, true);
});

test('fetchCallEvents (reconciliation) reads the call and produces the same event ids as the webhook, so replays are absorbed', async () => {
  const ended = { id: 'vapi-12', status: 'ended', endedReason: 'customer-ended-call', cost: 0.2, endedAt: '2026-10-25T01:05:00.000Z', startedAt: '2026-10-25T01:00:00.000Z', messages: [{ role: 'assistant', message: '안녕하세요' }, { role: 'user', message: '네' }] };
  const { port } = adapter([() => json(200, ended), () => json(200, { id: 'vapi-12', status: 'ringing', updatedAt: '2026-10-25T01:00:00.000Z' })]);
  const events = await port.fetchCallEvents('vapi-12');
  assert.deepEqual(events.map((e) => e.type), ['phone.call.connected', 'phone.call.completed']);
  assert.deepEqual(events.map((e) => e.eventId), ['vapi-12:status:in-progress', 'vapi-12:end']);
  assert.deepEqual((await port.fetchCallEvents('vapi-12')).map((e) => e.type), ['phone.call.ringing']);
});

test('end to end with the real call store: Vapi webhooks drive an outbound call to completion with transcript and outcome', async (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  const { port } = adapter();
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'vapi-13', clock.nowIso(), { callId: call.id }));
  // 우리 provider 이름으로 시작한 통화이므로 provider 를 vapi 로 맞춰 둔다 (실제로는 startCall 이 vapi 통화를 만든다)
  db.writeTx((tx) => tx.run("UPDATE call SET provider = 'vapi', provider_call_id = 'vapi-13' WHERE id = ?", [call.id]));
  const options = { db, clock, port };
  const base = { call: { id: 'vapi-13' }, timestamp: '2026-10-19T00:10:00.000Z' };
  assert.equal((await ingestPhoneWebhook(options, webhook({ type: 'status-update', status: 'in-progress', ...base }))).status, 200);
  const done = await ingestPhoneWebhook(options, webhook({
    type: 'end-of-call-report', endedReason: 'customer-ended-call', cost: 0.5, durationSeconds: 60, ...base,
    artifact: { messages: [{ role: 'assistant', message: '안녕하세요' }, { role: 'user', message: '네' }] },
    analysis: { summary: '관심 있음', structuredData: { disposition: 'qualified', budgetKnown: true } },
  }));
  assert.deepEqual(done.applied.map((a) => a.result), ['applied']);
  assert.equal(getTranscript(db, call.id)?.turns.length, 2);
  assert.equal(getCallOutcome(db, call.id)?.disposition, 'qualified');
  assert.equal((await ingestPhoneWebhook(options, webhook({ type: 'status-update', status: 'in-progress' }, { authorization: 'Bearer wrong' }))).status, 401);
});

test('review fixes: shared transferred id, independent auth headers, reserved objective variable, duration fallback, assistant-request without a call id', async () => {
  const { port, sent } = adapter([() => json(201, { id: 'vapi-20', status: 'queued' })]);
  // forwarding 상태와 assistant-forwarded-call 종료 보고는 같은 이벤트 id 를 쓴다
  const status = port.parseWebhook(webhook({ type: 'status-update', status: 'forwarding', call: { id: 'vapi-21' }, timestamp: '2026-10-25T01:00:00.000Z' })).events[0]!;
  const ended = port.parseWebhook(webhook({ type: 'end-of-call-report', endedReason: 'assistant-forwarded-call', call: { id: 'vapi-21' }, timestamp: '2026-10-25T01:01:00.000Z' })).events;
  assert.equal(ended[0]!.eventId, status.eventId);
  assert.deepEqual(ended.map((e) => e.type), ['phone.call.transferred', 'phone.call.completed']);
  // 다른 용도의 Authorization 헤더가 있어도 X-Vapi-Secret 을 확인한다
  assert.equal(port.parseWebhook(webhook({ type: 'status-update', status: 'ringing', call: { id: 'vapi-22' } }, { authorization: 'Basic abc', 'x-vapi-secret': SECRET })).events.length, 1);
  // 맥락의 objective 키가 정책이 판정한 의도를 덮지 못한다
  await port.startCall({ ...START, context: { objective: 'something else', leadId: 'lead_1' } });
  assert.equal((sent[0]!.body as { assistantOverrides: { variableValues: { objective: string } } }).assistantOverrides.variableValues.objective, 'qualify_lead');
  // 조회 응답에는 durationSeconds 가 없으므로 시작·종료 시각의 차이를 쓴다
  const lookup = adapter([() => json(200, { id: 'vapi-23', status: 'ended', endedReason: 'customer-ended-call', startedAt: '2026-10-25T01:00:00.000Z', endedAt: '2026-10-25T01:01:30.000Z' })]);
  const done = (await lookup.port.fetchCallEvents('vapi-23')).find((e) => e.type === 'phone.call.completed');
  assert.ok(done?.type === 'phone.call.completed' && done.durationSeconds === 90);
  // call.id 없는 assistant-request 는 이벤트 없이 지시를 기다린다: ingest 가 거절 지시로 답한다 (통화가 만들어지지 않으므로 빈 callId)
  const parsed = port.parseWebhook(webhook({ type: 'assistant-request', customer: { number: TO } }));
  assert.deepEqual([parsed.events.length, parsed.awaitingDirective], [0, true]);
});
