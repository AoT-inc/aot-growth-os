// 전화 canonical 모델: 상태 허용표, 입력 검증, 번호 마스킹, 발화 정규화, 결과 검증, provider 오류 변환, 영업시간, 인바운드 라우팅 (ADR-0014).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CALL_MACHINE, CALL_STATUSES, checkTransition, isE164, isCallOpen, maskNumber, missingOutcomeFields, normalizeTranscriptTurns, PhoneProviderError,
  providerErrorFromHttp, reachableFrom, routeInboundCall, validateConversationOutcome, validateInboundRoutes, validateMakeCallInput, validatePhoneEvent,
  validateTransferInput, withinBusinessHours, checkBusinessHours, IssueCollector, validateTaskSpec, type CallStatus,
} from '@aot/domain';

import { minimalDraft } from '../support/spec-fixtures.ts';

const NUMBER = '+821000000001';

test('call state machine: forward moves (including skips) are allowed, backward moves and terminal exits are not', () => {
  const ok = (from: CallStatus | null, to: CallStatus): boolean => checkTransition(CALL_MACHINE, { from, to, by: 'system' }).ok;
  assert.ok(ok(null, 'queued') && ok(null, 'initiated'));
  assert.ok(ok('queued', 'initiated') && ok('queued', 'connected') && ok('initiated', 'ringing') && ok('ringing', 'connected'));
  assert.ok(ok('connected', 'completed') && ok('connected', 'transferred') && ok('transferred', 'completed') && ok('ringing', 'failed'));
  assert.ok(!ok('connected', 'ringing') && !ok('queued', 'completed') && !ok('queued', 'transferred'));
  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    for (const to of CALL_STATUSES) assert.ok(!ok(terminal, to), `${terminal} -> ${to} must be rejected`);
    assert.equal(isCallOpen(terminal), false);
  }
  assert.deepEqual(reachableFrom(CALL_MACHINE, 'transferred').sort(), ['completed', 'failed']);
});

test('an agent can never change a call state, and only the system moves it', () => {
  const agent = checkTransition(CALL_MACHINE, { from: 'queued', to: 'initiated', by: 'agent' });
  assert.equal(agent.ok, false);
  const human = checkTransition(CALL_MACHINE, { from: 'queued', to: 'initiated', by: 'human' });
  assert.equal(human.ok, false);
});

test('phone number helpers: E.164 validation and masking', () => {
  assert.ok(isE164(NUMBER) && isE164('+15550100'));
  for (const bad of ['01012345678', '+0123456789', '+82 10 0000 0001', '+8210', '', 7, null]) assert.equal(isE164(bad), false, String(bad));
  assert.equal(maskNumber(NUMBER), '+82********01');
  assert.ok(!maskNumber(NUMBER).includes('0000000'));
});

test('MakeCallInput validation: intent keys, E.164, bounded context, no unknown keys', () => {
  const good = validateMakeCallInput({
    to: NUMBER, objective: 'qualify_lead', context: { leadId: 'lead_123', companyName: 'Example Corp' }, constraints: { maxDurationSeconds: 600, allowTransfer: true },
  });
  assert.ok(good.ok);
  const bad = validateMakeCallInput({ to: '010', objective: 'Qualify Lead', context: { f: () => 1 }, constraints: { maxDurationSeconds: 5, recording: 'yes' }, prompt: 'x' });
  assert.ok(!bad.ok);
  const paths = bad.ok ? [] : bad.errors.map((e) => e.path);
  for (const path of ['to', 'objective', 'context', 'constraints.maxDurationSeconds', 'constraints.recording', 'prompt']) assert.ok(paths.includes(path), path);
  const huge = validateMakeCallInput({ to: NUMBER, objective: 'qualify_lead', context: { blob: 'x'.repeat(9000) } });
  assert.ok(!huge.ok && huge.errors.some((e) => e.code === 'too_large'));
  assert.ok(!validateMakeCallInput('call me').ok);
});

test('TransferCallInput validation', () => {
  assert.ok(validateTransferInput({ callId: 'call-1', to: NUMBER, reason: 'escalation' }).ok);
  assert.ok(!validateTransferInput({ callId: '', to: 'x' }).ok);
});

test('transcript normalization maps provider speaker names, drops empty turns and refuses unknown speakers', () => {
  const ok = normalizeTranscriptTurns([
    { speaker: 'assistant', text: '  안녕하세요   AoT 입니다 ' },
    { speaker: 'USER', text: '네', startedAt: '2026-10-25T01:00:00Z' },
    { speaker: 'bot', text: '   ' },
  ]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok ? ok.value : [], [
    { speaker: 'agent', text: '안녕하세요 AoT 입니다' },
    { speaker: 'customer', text: '네', startedAt: '2026-10-25T01:00:00.000Z' },
  ]);
  const unknown = normalizeTranscriptTurns([{ speaker: 'manager', text: 'hi' }]);
  assert.ok(!unknown.ok && unknown.errors[0]?.code === 'unknown_speaker');
  assert.ok(!normalizeTranscriptTurns('hello').ok);
  assert.ok(!normalizeTranscriptTurns([{ speaker: 'agent', text: 'x', startedAt: 'yesterday' }]).ok);
});

test('call outcome validation: structured, bounded, restricted to the dispositions the task allows', () => {
  const outcome = { disposition: 'qualified', summary: '고객이 데모를 요청함', structuredData: { budgetKnown: true, timeline: 'this_quarter' }, nextAction: 'schedule_demo' };
  const ok = validateConversationOutcome(outcome, ['qualified', 'not_interested']);
  assert.ok(ok.ok);
  assert.deepEqual(missingOutcomeFields({ structuredData: { budgetKnown: true, timeline: null } }, ['budgetKnown', 'timeline', 'decisionMakerReached']), ['timeline', 'decisionMakerReached']);
  assert.ok(!validateConversationOutcome({ ...outcome, disposition: 'hot_lead' }, ['qualified']).ok, 'a disposition outside the task vocabulary is refused');
  assert.ok(!validateConversationOutcome({ ...outcome, summary: '  ' }).ok);
  assert.ok(!validateConversationOutcome({ ...outcome, structuredData: 'free text' }).ok);
  assert.ok(!validateConversationOutcome({ ...outcome, extra: 1 }).ok);
  assert.ok(!validateConversationOutcome({ ...outcome, structuredData: { blob: 'x'.repeat(20_000) } }).ok);
});

test('provider errors map to canonical codes, and only definite refusals count as "not sent"', () => {
  const table: [number, string, boolean][] = [
    [400, 'invalid_request', true], [401, 'unauthorized', true], [403, 'unauthorized', true], [404, 'not_found', true], [422, 'invalid_request', true],
    [429, 'rate_limited', true], [408, 'timeout', false], [500, 'unavailable', false], [503, 'unavailable', false], [504, 'timeout', false], [302, 'unknown', false],
  ];
  for (const [status, code, definite] of table) {
    const error = providerErrorFromHttp(status, 'start call');
    assert.ok(error instanceof PhoneProviderError);
    assert.equal(error.code, code, String(status));
    assert.equal(error.definite, definite, String(status));
    assert.equal(error.status, status);
    assert.ok(!error.message.includes('secret'));
  }
});

test('canonical event validation rejects malformed events before they can touch state', () => {
  const base = { eventId: 'e1', provider: 'fake', providerCallId: 'p1', occurredAt: '2026-10-25T01:00:00.000Z' };
  assert.ok(validatePhoneEvent({ ...base, type: 'phone.call.connected' }).ok);
  assert.ok(!validatePhoneEvent({ ...base, type: 'phone.call.exploded' }).ok);
  assert.ok(!validatePhoneEvent({ ...base, type: 'phone.call.failed', code: 'vapi-error-77' }).ok, 'provider-specific failure codes are not canonical');
  assert.ok(!validatePhoneEvent({ ...base, providerCallId: null, type: 'phone.call.ringing' }).ok, 'an event must identify a call');
  assert.ok(!validatePhoneEvent({ ...base, occurredAt: 'soon', type: 'phone.call.ringing' }).ok);
  assert.ok(!validatePhoneEvent({ ...base, provider: 'Vapi Prod', type: 'phone.call.ringing' }).ok);
  assert.ok(!validatePhoneEvent({ ...base, type: 'phone.call.transcript.updated' }).ok);
});

test('business hours are evaluated on the wall clock of the configured time zone', () => {
  const issues = new IssueCollector();
  const hours = checkBusinessHours({ tz: 'Asia/Seoul', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, 'h', issues);
  assert.ok(hours && issues.issues.length === 0);
  assert.equal(withinBusinessHours(hours, new Date('2026-10-26T00:00:00Z')), true); // 월 09:00 KST (시작 포함)
  assert.equal(withinBusinessHours(hours, new Date('2026-10-26T08:59:00Z')), true); // 월 17:59 KST
  assert.equal(withinBusinessHours(hours, new Date('2026-10-26T09:00:00Z')), false); // 월 18:00 KST (끝 미포함)
  assert.equal(withinBusinessHours(hours, new Date('2026-10-25T01:00:00Z')), false); // 일 10:00 KST
  const bad = new IssueCollector();
  assert.equal(checkBusinessHours({ tz: 'Mars/Base', days: [8], start: '18:00', end: '09:00' }, 'h', bad), null);
  assert.ok(bad.issues.length >= 2);
  assert.equal(checkBusinessHours({ days: [1], start: '09:00', end: '10:00' }, 'h', new IssueCollector()), null, 'tz is mandatory');
});

test('inbound routing: first match wins, no match is rejected, routing never grants anything', () => {
  const parsed = validateInboundRoutes([
    { id: 'vip', from: ['+8210123*'], target: { kind: 'human', number: '+821000000009' } },
    { id: 'support-hours', to: [NUMBER], hours: { tz: 'Asia/Seoul', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, target: { kind: 'agent', orgUnit: 'support', role: 'generalist', objective: 'handle_support' } },
    { id: 'after-hours', to: [NUMBER], target: { kind: 'reject', reason: 'closed' } },
  ]);
  assert.ok(parsed.ok);
  const routes = parsed.ok ? parsed.value : [];
  const weekdayNoon = new Date('2026-10-26T03:00:00Z');
  assert.deepEqual(routeInboundCall(routes, { to: NUMBER, from: '+821012345678' }, weekdayNoon), { routeId: 'vip', target: { kind: 'human', number: '+821000000009' } });
  assert.equal(routeInboundCall(routes, { to: NUMBER, from: '+821099990000' }, weekdayNoon).routeId, 'support-hours');
  assert.deepEqual(routeInboundCall(routes, { to: NUMBER, from: '+821099990000' }, new Date('2026-10-25T03:00:00Z')).target, { kind: 'reject', reason: 'closed' });
  assert.deepEqual(routeInboundCall(routes, { to: '+821000000777', from: null }, weekdayNoon), { routeId: null, target: { kind: 'reject', reason: 'no_route' } });
  assert.deepEqual(routeInboundCall([], { to: NUMBER, from: null }, weekdayNoon).target, { kind: 'reject', reason: 'no_route' });
});

test('route configuration is validated: unknown keys, duplicate ids, bad numbers', () => {
  const bad = validateInboundRoutes([
    { id: 'a', to: ['010-1234'], target: { kind: 'reject' }, extra: 1 },
    { id: 'a', target: { kind: 'agent', orgUnit: 'x', role: 'y', objective: 'Not A Key' } },
    { id: 'c', target: { kind: 'teleport' } },
  ]);
  assert.ok(!bad.ok);
  const codes = bad.ok ? [] : bad.errors.map((e) => `${e.path}:${e.code}`);
  assert.ok(codes.includes('routes[0].extra:unknown_key') && codes.includes('routes[0].to:format') && codes.includes('routes[1].id:duplicate'));
  assert.ok(codes.includes('routes[1].target.objective:format') && codes.includes('routes[2].target.kind:enum'));
});

test('task_spec: a phone tool must declare the number range the person approves (E.164 or a prefix ending in *)', () => {
  const spec = (target: unknown, tool = 'phone_call') => ({
    ...minimalDraft(),
    allowed_tools: [{ tool, operations: ['call'], scope: 'customer', impact: 'external_effect', ...(target === undefined ? {} : { target }) }],
  });
  for (const ok of [NUMBER, '+8210555*', '+82*']) assert.ok(validateTaskSpec(spec(ok), 'draft').ok, String(ok));
  for (const bad of [undefined, '', '010-1234', '*', '+82', '82*', '+8210 555*']) {
    const checked = validateTaskSpec(spec(bad), 'draft');
    assert.ok(!checked.ok && checked.errors.some((e) => e.code === 'phone_target' || e.path.endsWith('target')), String(bad));
  }
  assert.ok(!validateTaskSpec(spec(undefined, 'phone_transfer'), 'draft').ok);
  assert.ok(validateTaskSpec({ ...minimalDraft() }, 'draft').ok, 'other tools are unaffected');
});
