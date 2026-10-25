// 전화 시험 공용: 번호는 예약 대역(실제 번호 아님), 이벤트 생성기, 통화가 달린 업무 만들기.
import { createOutboundCall, type Call, type Db, type FakeClock, type PhoneEvent } from '@aot/domain';

import { queuedTask } from './engine.ts';

export const TO = '+821000000001';
export const FROM = '+82200000000';
export const OUR_NUMBER = '+82200000001';
export const PROVIDER = 'fake';

/** 통화 요청을 가진 업무 명세 덧씀 (전화 도구와 통화 검사) */
export const phoneSpecOverrides = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  allowed_tools: [{ tool: 'phone_call', operations: ['call'], scope: 'customer', impact: 'external_effect' }],
  validation: { deterministic: ['call_completed', 'call_transcript_present', 'call_outcome_recorded', 'policy_compliance'], llm: null, human: false },
  expected_call_outcome: { dispositions: ['qualified', 'not_interested'], required_fields: ['budgetKnown'] },
  constraints: { time_limit: '30m', publish_scope: 'customer' },
  ...extra,
});

let counter = 0;
export const eventId = (): string => `evt-${(counter += 1)}`;

export function ev<T extends PhoneEvent['type']>(
  type: T, providerCallId: string, at: string, extra: Omit<Extract<PhoneEvent, { type: T }>, 'type' | 'eventId' | 'provider' | 'providerCallId' | 'occurredAt'> | Record<string, never> = {},
  id = eventId(),
): PhoneEvent {
  return { type, eventId: id, provider: PROVIDER, providerCallId, occurredAt: at, ...extra } as PhoneEvent;
}

/** 업무 하나와 그 업무의 `queued` 발신 통화 하나 */
export function taskWithCall(db: Db, clock: FakeClock, overrides: Record<string, unknown> = {}): { taskId: string; call: Call } {
  const taskId = queuedTask(db, clock, overrides);
  const { call } = createOutboundCall(db, clock, {
    provider: PROVIDER, to: TO, from: FROM, taskId, taskRunId: null, actorId: null, orgUnitId: null, objective: 'qualify_lead',
    effectKey: `effect-key-${taskId}`.padEnd(40, '0'), maxDurationSeconds: 600, allowTransfer: true, recording: false,
  });
  return { taskId, call };
}

export const COMPLETED_ANALYSIS = {
  disposition: 'qualified', summary: '고객이 제품 도입에 관심을 보였고 데모를 요청함',
  structuredData: { budgetKnown: true, timeline: 'this_quarter', decisionMakerReached: true }, nextAction: 'schedule_demo',
};

export const TRANSCRIPT = {
  turns: [{ speaker: 'assistant', text: '안녕하세요, AoT 입니다.' }, { speaker: 'user', text: '네, 말씀하세요.' }, { speaker: 'assistant', text: '제품 도입 의향을 여쭙고 싶습니다.' }],
  language: 'ko',
};
