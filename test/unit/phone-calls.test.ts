// 통화 저장과 canonical 이벤트 적용 (ADR-0014 §4~§6): 생명주기, 멱등, 역순/중복 이벤트, 인바운드 생성, 산출물, 증거 연결, 비용, 마감.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPhoneEvent, countOutboundCallsSince, createOutboundCall, expireCall, findCallByProvider, getCall, getCallOutcome, getTranscript, hasOpenCall,
  linkCallToTask, listCallsForTask, overdueOpenCalls, PhoneRuleError, recordCallOutcome, ValidationError, type PhoneEvent,
} from '@aot/domain';

import { queuedTask } from '../support/engine.ts';
import { COMPLETED_ANALYSIS, ev, OUR_NUMBER, PROVIDER, taskWithCall, TO, TRANSCRIPT, phoneSpecOverrides } from '../support/phone.ts';
import { seededDb } from '../support/seeded-db.ts';

const T0 = '2026-10-25T01:00:00.000Z';
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

const eventsOf = (db: ReturnType<typeof seededDb>['db'], callId: string) =>
  db.all<{ type: string; payload: string }>("SELECT type, payload FROM event WHERE source = 'phone' AND external_id = ? ORDER BY received_at, rowid", [callId]);

test('an outbound call is recorded as queued with a requested event, and the same effect key yields the same call', (t) => {
  const { db, clock } = seededDb(t);
  const { taskId, call } = taskWithCall(db, clock);
  assert.equal(call.status, 'queued');
  assert.equal(call.direction, 'outbound');
  assert.equal(call.taskId, taskId);
  assert.equal(call.providerCallId, null);
  const again = createOutboundCall(db, clock, {
    provider: PROVIDER, to: TO, from: null, taskId, taskRunId: null, actorId: null, orgUnitId: null, objective: 'qualify_lead',
    effectKey: `effect-key-${taskId}`.padEnd(40, '0'), maxDurationSeconds: 600, allowTransfer: true, recording: false,
  });
  assert.equal(again.created, false);
  assert.equal(again.call.id, call.id);
  assert.deepEqual(eventsOf(db, call.id).map((e) => e.type), ['phone.call.requested']);
  assert.ok(hasOpenCall(db, taskId));
  assert.deepEqual(listCallsForTask(db, taskId).map((c) => c.id), [call.id]);
});

test('lifecycle: initiated → ringing → connected → completed, with transcript, analysis and cost recorded once', (t) => {
  const { db, clock } = seededDb(t);
  const { taskId, call } = taskWithCall(db, clock);
  const apply = (event: PhoneEvent) => applyPhoneEvent(db, clock, event);

  assert.deepEqual(apply(ev('phone.call.initiated', 'p-1', at(0), { callId: call.id })), { result: 'applied', callId: call.id, from: 'queued', to: 'initiated', callCreated: false });
  assert.equal(getCall(db, call.id).providerCallId, 'p-1');
  assert.equal(findCallByProvider(db, PROVIDER, 'p-1')?.id, call.id);
  apply(ev('phone.call.ringing', 'p-1', at(2)));
  apply(ev('phone.call.connected', 'p-1', at(9)));
  assert.equal(getCall(db, call.id).connectedAt, at(9));
  apply(ev('phone.call.transcript.updated', 'p-1', at(30), { transcript: { turns: TRANSCRIPT.turns.slice(0, 2) } }));
  assert.equal(getTranscript(db, call.id)?.turns.length, 2);
  assert.ok(hasOpenCall(db, taskId), 'a connected call is still open');

  const done = apply(ev('phone.call.completed', 'p-1', at(120), { endedReason: 'customer-ended-call', durationSeconds: 111, costUsd: 0.37, transcript: TRANSCRIPT, analysis: COMPLETED_ANALYSIS }));
  assert.equal(done.result, 'applied');
  const finished = getCall(db, call.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.endedAt, at(120));
  assert.equal(finished.endReason, 'customer-ended-call');
  assert.equal(hasOpenCall(db, taskId), false);

  const transcript = getTranscript(db, call.id);
  assert.deepEqual(transcript?.turns.map((turn) => turn.speaker), ['agent', 'customer', 'agent']);
  assert.equal(transcript?.language, 'ko');
  const outcome = getCallOutcome(db, call.id);
  assert.equal(outcome?.disposition, 'qualified');
  assert.equal(outcome?.source, 'provider_analysis');
  assert.equal(outcome?.trustOrigin, 'external_untrusted', 'what the counterpart said is data, not a verified fact');
  assert.deepEqual(outcome?.structuredData, COMPLETED_ANALYSIS.structuredData);

  const cost = db.all<{ amount_usd: number; category: string; task_id: string }>('SELECT amount_usd, category, task_id FROM cost_entry');
  assert.deepEqual(cost.map((c) => [c.category, c.amount_usd, c.task_id]), [['external', 0.37, taskId]]);

  const types = eventsOf(db, call.id).map((e) => e.type);
  assert.deepEqual(types, ['phone.call.requested', 'phone.call.initiated', 'phone.call.ringing', 'phone.call.connected', 'phone.call.transcript.updated', 'phone.call.completed']);
  for (const row of eventsOf(db, call.id)) {
    assert.ok(!row.payload.includes('+82'), 'event payloads carry no phone numbers');
    assert.ok(!row.payload.includes('AoT'), 'event payloads carry no spoken text');
  }
});

test('duplicate delivery is absorbed: the same event applies once, and a repeated completion does not add cost twice', (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-2', at(0), { callId: call.id }));
  const completed = ev('phone.call.completed', 'p-2', at(60), { costUsd: 0.5, transcript: TRANSCRIPT, analysis: COMPLETED_ANALYSIS }, 'fixed-id');
  assert.equal(applyPhoneEvent(db, clock, completed).result, 'applied');
  assert.deepEqual(applyPhoneEvent(db, clock, completed), { result: 'duplicate', callId: call.id });
  assert.deepEqual(applyPhoneEvent(db, clock, completed), { result: 'duplicate', callId: call.id });
  assert.equal(db.all('SELECT 1 FROM cost_entry').length, 1);
  assert.equal(db.all("SELECT 1 FROM event WHERE source = 'phone' AND type = 'phone.call.completed'").length, 1);
});

test('out-of-order events never move a call backwards; late events after the end are recorded but change nothing', (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-3', at(0), { callId: call.id }));
  applyPhoneEvent(db, clock, ev('phone.call.connected', 'p-3', at(8)));
  // 역순: ringing 이 connected 뒤에 도착
  assert.deepEqual(applyPhoneEvent(db, clock, ev('phone.call.ringing', 'p-3', at(3))), { result: 'stale', callId: call.id, status: 'connected' });
  applyPhoneEvent(db, clock, ev('phone.call.completed', 'p-3', at(50)));
  const closed = getCall(db, call.id);
  assert.equal(closed.status, 'completed');
  // 종료 뒤: 실패/연결 이벤트는 상태를 바꾸지 못한다 (종료 상태는 되돌아가지 않는다)
  for (const late of [ev('phone.call.failed', 'p-3', at(60), { code: 'network' }), ev('phone.call.connected', 'p-3', at(61)), ev('phone.call.cancelled', 'p-3', at(62))]) {
    assert.equal(applyPhoneEvent(db, clock, late).result, 'stale');
  }
  assert.equal(getCall(db, call.id).status, 'completed');
  assert.equal(getCall(db, call.id).endedAt, closed.endedAt);
});

test('a lost intermediate event is tolerated: queued can jump to connected, but not to completed or transferred', (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  assert.equal(applyPhoneEvent(db, clock, ev('phone.call.completed', 'p-4', at(5), { callId: call.id })).result, 'stale', 'queued → completed is not a legal transition');
  assert.equal(getCall(db, call.id).status, 'queued');
  assert.equal(applyPhoneEvent(db, clock, ev('phone.call.connected', 'p-4', at(6), { callId: call.id })).result, 'applied');
  assert.equal(getCall(db, call.id).status, 'connected');
});

test('transfer: connected → transferred → completed', (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-5', at(0), { callId: call.id }));
  applyPhoneEvent(db, clock, ev('phone.call.connected', 'p-5', at(5)));
  assert.equal(applyPhoneEvent(db, clock, ev('phone.call.transferred', 'p-5', at(40), { target: '+82200000009' })).result, 'applied');
  assert.equal(getCall(db, call.id).status, 'transferred');
  assert.ok(hasOpenCall(db, call.taskId!), 'a transferred call is still open until it ends');
  applyPhoneEvent(db, clock, ev('phone.call.completed', 'p-5', at(200)));
  assert.equal(getCall(db, call.id).status, 'completed');
});

test('failures carry a canonical code as the end reason', (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-6', at(0), { callId: call.id }));
  applyPhoneEvent(db, clock, ev('phone.call.ringing', 'p-6', at(2)));
  applyPhoneEvent(db, clock, ev('phone.call.failed', 'p-6', at(32), { code: 'no_answer' }));
  const failed = getCall(db, call.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.endReason, 'no_answer');
  assert.equal(failed.connectedAt, null);
});

test('an unknown call is ignored, except that an inbound initiated event creates the call', (t) => {
  const { db, clock } = seededDb(t);
  assert.deepEqual(applyPhoneEvent(db, clock, ev('phone.call.connected', 'ghost', at(0))), { result: 'unknown_call', callId: null });
  assert.equal(db.all('SELECT 1 FROM call').length, 0);
  assert.equal(db.all("SELECT 1 FROM event WHERE source = 'phone'").length, 0);

  const created = applyPhoneEvent(db, clock, ev('phone.call.initiated', 'in-1', at(0), { direction: 'inbound', from: TO, to: OUR_NUMBER }));
  assert.equal(created.result, 'applied');
  if (created.result !== 'applied') return;
  assert.equal(created.callCreated, true);
  const call = getCall(db, created.callId);
  assert.deepEqual([call.direction, call.status, call.from, call.to, call.taskId], ['inbound', 'initiated', TO, OUR_NUMBER, null]);
  assert.equal(applyPhoneEvent(db, clock, ev('phone.call.connected', 'in-1', at(4))).result, 'applied');
  // 같은 provider 통화 id 는 통화를 하나만 만든다
  assert.equal(applyPhoneEvent(db, clock, ev('phone.call.initiated', 'in-1', at(5), { direction: 'inbound', from: TO, to: OUR_NUMBER })).result, 'stale');
  assert.equal(db.all('SELECT 1 FROM call').length, 1);
});

test('an inbound call is linked to a task later, and its evidence follows; one call cannot serve two tasks', (t) => {
  const { db, clock } = seededDb(t);
  const created = applyPhoneEvent(db, clock, ev('phone.call.initiated', 'in-2', at(0), { direction: 'inbound', from: TO, to: OUR_NUMBER }));
  if (created.result !== 'applied') throw new Error('expected a created call');
  applyPhoneEvent(db, clock, ev('phone.call.connected', 'in-2', at(3)));
  applyPhoneEvent(db, clock, ev('phone.call.completed', 'in-2', at(90), { transcript: TRANSCRIPT, analysis: COMPLETED_ANALYSIS }));
  const taskId = queuedTask(db, clock, phoneSpecOverrides());
  linkCallToTask(db, clock, created.callId, { taskId });
  const refs = db.all<{ ref: string; kind: string; trust_origin: string; task_run_id: string | null }>('SELECT ref, kind, trust_origin, task_run_id FROM evidence WHERE task_id = ? ORDER BY ref', [taskId]);
  assert.deepEqual(refs.map((r) => r.ref), [`call:${created.callId}`, `call:${created.callId}#outcome`, `call:${created.callId}#transcript`]);
  assert.ok(refs.every((r) => r.trust_origin === 'external_untrusted' && r.task_run_id === null));
  const other = queuedTask(db, clock, phoneSpecOverrides({ trigger: { kind: 'manual', ref: 'actor:other-owner' } }));
  assert.throws(() => linkCallToTask(db, clock, created.callId, { taskId: other }), (e) => e instanceof PhoneRuleError && e.code === 'link_conflict');
});

test('evidence rows appear for a task-linked call and track the transcript', (t) => {
  const { db, clock } = seededDb(t);
  const { taskId, call } = taskWithCall(db, clock);
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-7', at(0), { callId: call.id }));
  applyPhoneEvent(db, clock, ev('phone.call.transcript.updated', 'p-7', at(10), { transcript: { turns: TRANSCRIPT.turns.slice(0, 1) } }));
  const hashAt = (ref: string) => db.get<{ content_hash: string }>('SELECT content_hash FROM evidence WHERE task_id = ? AND ref = ?', [taskId, ref])?.content_hash;
  const first = hashAt(`call:${call.id}#transcript`);
  assert.ok(first);
  assert.equal(hashAt(`call:${call.id}`), undefined, 'the call record becomes evidence only once the call has ended');
  applyPhoneEvent(db, clock, ev('phone.call.transcript.updated', 'p-7', at(20), { transcript: { turns: TRANSCRIPT.turns } }));
  assert.notEqual(hashAt(`call:${call.id}#transcript`), first);
  // 더 짧은 (늦게 도착한) 기록은 완성된 기록을 덮지 못한다
  applyPhoneEvent(db, clock, ev('phone.call.transcript.updated', 'p-7', at(21), { transcript: { turns: TRANSCRIPT.turns.slice(0, 1) } }));
  assert.equal(getTranscript(db, call.id)?.turns.length, 3);
  applyPhoneEvent(db, clock, ev('phone.call.completed', 'p-7', at(40)));
  assert.ok(hashAt(`call:${call.id}`));
});

test('the outcome is recorded once; an agent cannot record it; a human can; a different second outcome is refused', (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  const outcome = { disposition: 'not_interested', summary: '관심 없음', structuredData: { budgetKnown: false } };
  assert.throws(() => recordCallOutcome(db, clock, { callId: call.id, outcome, source: 'human', by: 'human' }), (e) => e instanceof PhoneRuleError && e.code === 'not_open');
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-8', at(0), { callId: call.id }));
  applyPhoneEvent(db, clock, ev('phone.call.connected', 'p-8', at(2)));
  applyPhoneEvent(db, clock, ev('phone.call.completed', 'p-8', at(30)));
  assert.throws(() => recordCallOutcome(db, clock, { callId: call.id, outcome, source: 'extractor', by: 'agent' }), (e) => e instanceof PhoneRuleError && e.code === 'agent_forbidden');
  assert.throws(() => recordCallOutcome(db, clock, { callId: call.id, outcome: { ...outcome, disposition: 'hot' }, source: 'human', by: 'human', allowedDispositions: ['qualified', 'not_interested'] }), ValidationError);
  const first = recordCallOutcome(db, clock, { callId: call.id, outcome, source: 'human', by: 'human' });
  assert.equal(first.created, true);
  assert.equal(getCallOutcome(db, call.id)?.trustOrigin, 'internal', 'only a human-entered outcome is internal');
  assert.equal(recordCallOutcome(db, clock, { callId: call.id, outcome, source: 'human', by: 'human' }).created, false);
  assert.throws(() => recordCallOutcome(db, clock, { callId: call.id, outcome: { ...outcome, disposition: 'qualified' }, source: 'human', by: 'human' }), (e) => e instanceof PhoneRuleError && e.code === 'outcome_conflict');
});

test('provider analysis without a disposition and summary is free text, not an outcome', (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-9', at(0), { callId: call.id }));
  applyPhoneEvent(db, clock, ev('phone.call.completed', 'p-9', at(30), { analysis: { summary: '좋은 통화였다' } }));
  assert.equal(getCallOutcome(db, call.id), null);
});

test('malformed events are refused before they can touch state', (t) => {
  const { db, clock } = seededDb(t);
  const { call } = taskWithCall(db, clock);
  assert.throws(() => applyPhoneEvent(db, clock, { type: 'phone.call.failed', eventId: 'x', provider: PROVIDER, providerCallId: 'p', occurredAt: T0, code: 'vendor-77' } as unknown as PhoneEvent), ValidationError);
  assert.equal(getCall(db, call.id).status, 'queued');
  // 통화가 다른 provider 의 것이면 거부
  assert.throws(() => applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p', T0, { callId: call.id }, 'x2') && { ...ev('phone.call.initiated', 'p', T0, { callId: call.id }, 'x3'), provider: 'other' }), (e) => e instanceof PhoneRuleError && e.code === 'provider_mismatch');
});

test('daily volume counts only calls that reached the provider; overdue open calls are closed as deadline_exceeded (idempotent)', (t) => {
  const { db, clock } = seededDb(t);
  const a = taskWithCall(db, clock).call;
  const b = taskWithCall(db, clock, { trigger: { kind: 'manual', ref: 'actor:other-owner' } }).call;
  assert.equal(countOutboundCallsSince(db, '2026-10-19T00:00:00.000Z'), 2);
  applyPhoneEvent(db, clock, { type: 'phone.call.failed', eventId: 'refused-1', provider: PROVIDER, providerCallId: null, callId: b.id, occurredAt: at(0), code: 'rejected' });
  assert.equal(countOutboundCallsSince(db, '2026-10-19T00:00:00.000Z'), 1, 'a call that never reached the provider is not counted');
  assert.equal(countOutboundCallsSince(db, '2026-10-20T00:00:00.000Z'), 0);

  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-10', clock.nowIso(), { callId: a.id }));
  assert.deepEqual(overdueOpenCalls(db, clock, { graceMs: 60_000, defaultMaxSeconds: 3600 }), []);
  clock.advance((600 + 60) * 1000 + 1); // max_duration_seconds 600 + 유예
  const overdue = overdueOpenCalls(db, clock, { graceMs: 60_000, defaultMaxSeconds: 3600 });
  assert.deepEqual(overdue.map((c) => c.id), [a.id]);
  assert.equal(expireCall(db, clock, a.id).result, 'applied');
  assert.equal(getCall(db, a.id).status, 'failed');
  assert.equal(getCall(db, a.id).endReason, 'deadline_exceeded: no terminal event from the provider before the deadline');
  assert.equal(expireCall(db, clock, a.id).result, 'duplicate');
});
