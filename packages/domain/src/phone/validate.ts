// 전화 입력 검증. 에이전트가 표현하는 업무 의도(MakeCallInput)와 어댑터가 만든 canonical 이벤트(PhoneEvent)를 검사한다.
// 모든 문제를 모아 돌려주고 알 수 없는 키는 거부한다(task_spec 검증과 같은 방식).
import { jsonBytes } from '../conversation/json.ts';
import { NAME_PATTERN } from '../conversation/outcome.ts';
import { IssueCollector, isPlainObject, rejectUnknownKeys, type PlainObject, type ValidationResult } from '../validation.ts';

import {
  isE164, PHONE_EVENT_TYPES, PHONE_FAILURE_CODES,
  type CallConstraints, type MakeCallInput, type PhoneEvent, type PhoneEventType, type TransferCallInput,
} from './model.ts';

export const MAX_CONTEXT_BYTES = 8 * 1024;
export const MAX_CALL_DURATION_SECONDS = 4 * 3600;
export const MAX_REASON_CHARS = 300;
const MAX_EVENT_ID_CHARS = 200;

export function validateMakeCallInput(input: unknown): ValidationResult<MakeCallInput> {
  const out = new IssueCollector();
  const empty: MakeCallInput = { to: '', objective: '' };
  if (!isPlainObject(input)) {
    out.add('', 'type', 'the call request must be an object');
    return out.result(empty);
  }
  rejectUnknownKeys(input, ['to', 'objective', 'context', 'from', 'constraints'], '', out);
  const to = input['to'];
  if (!isE164(to)) out.add('to', 'format', 'to must be an E.164 number such as +821000000000');
  const objective = input['objective'];
  if (typeof objective !== 'string' || !NAME_PATTERN.test(objective)) out.add('objective', 'format', 'objective must be an intent key matching [a-z][a-z0-9_]{0,63} (for example qualify_lead)');
  const from = input['from'];
  if (from !== undefined && !isE164(from)) out.add('from', 'format', 'from must be an E.164 number');
  const context = input['context'];
  if (context !== undefined) {
    if (!isPlainObject(context)) out.add('context', 'type', 'context must be an object');
    else {
      const bytes = jsonBytes(context);
      if (bytes === null) out.add('context', 'not_json', 'context must be plain JSON data');
      else if (bytes > MAX_CONTEXT_BYTES) out.add('context', 'too_large', `context is larger than ${MAX_CONTEXT_BYTES} bytes`);
    }
  }
  const constraints = checkConstraints(input['constraints'], out);
  return out.result({
    to: typeof to === 'string' ? to : '',
    objective: typeof objective === 'string' ? objective : '',
    ...(isPlainObject(context) ? { context } : {}),
    ...(typeof from === 'string' ? { from } : {}),
    ...(constraints === undefined ? {} : { constraints }),
  });
}

function checkConstraints(value: unknown, out: IssueCollector): CallConstraints | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    out.add('constraints', 'type', 'constraints must be an object');
    return undefined;
  }
  rejectUnknownKeys(value, ['maxDurationSeconds', 'allowTransfer', 'recording'], 'constraints', out);
  const result: CallConstraints = {};
  const seconds = value['maxDurationSeconds'];
  if (seconds !== undefined) {
    if (!Number.isInteger(seconds) || (seconds as number) < 10 || (seconds as number) > MAX_CALL_DURATION_SECONDS) out.add('constraints.maxDurationSeconds', 'range', `maxDurationSeconds must be an integer in [10, ${MAX_CALL_DURATION_SECONDS}]`);
    else result.maxDurationSeconds = seconds as number;
  }
  for (const key of ['allowTransfer', 'recording'] as const) {
    const flag = value[key];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') out.add(`constraints.${key}`, 'type', `${key} must be true or false`);
    else result[key] = flag;
  }
  return result;
}

export function validateTransferInput(input: unknown): ValidationResult<TransferCallInput> {
  const out = new IssueCollector();
  if (!isPlainObject(input)) {
    out.add('', 'type', 'the transfer request must be an object');
    return out.result({ callId: '', to: '' });
  }
  rejectUnknownKeys(input, ['callId', 'to', 'reason'], '', out);
  if (typeof input['callId'] !== 'string' || input['callId'].trim() === '') out.add('callId', 'required', 'callId is required');
  if (!isE164(input['to'])) out.add('to', 'format', 'to must be an E.164 number');
  const reason = input['reason'];
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON_CHARS)) out.add('reason', 'format', `reason must be a string of at most ${MAX_REASON_CHARS} characters`);
  return out.result({
    callId: typeof input['callId'] === 'string' ? input['callId'] : '',
    to: typeof input['to'] === 'string' ? input['to'] : '',
    ...(typeof reason === 'string' ? { reason } : {}),
  });
}

const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/**
 * canonical 이벤트 검사. 어댑터는 TypeScript 타입으로 이미 이 모양을 만들지만 webhook 입력은 신뢰할 수 없는 경계 너머에서 오므로
 * 적용 직전에 한 번 더 검사한다 (모르는 형식의 이벤트가 상태를 바꾸지 못하게).
 */
export function validatePhoneEvent(input: unknown): ValidationResult<PhoneEvent> {
  const out = new IssueCollector();
  if (!isPlainObject(input)) {
    out.add('', 'type', 'an event must be an object');
    return out.result(input as PhoneEvent);
  }
  const type = input['type'];
  if (!(PHONE_EVENT_TYPES as readonly unknown[]).includes(type)) out.add('type', 'enum', `type must be one of ${PHONE_EVENT_TYPES.join('|')}`);
  const eventId = input['eventId'];
  if (typeof eventId !== 'string' || eventId.trim() === '' || eventId.length > MAX_EVENT_ID_CHARS) out.add('eventId', 'format', `eventId must be a non-empty string of at most ${MAX_EVENT_ID_CHARS} characters`);
  if (typeof input['provider'] !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(input['provider'])) out.add('provider', 'format', 'provider must match [a-z][a-z0-9_-]{0,31}');
  const providerCallId = input['providerCallId'];
  if (providerCallId !== null && (typeof providerCallId !== 'string' || providerCallId === '' || providerCallId.length > 200)) out.add('providerCallId', 'format', 'providerCallId must be null or a non-empty string');
  if (input['callId'] !== undefined && typeof input['callId'] !== 'string') out.add('callId', 'type', 'callId must be a string');
  if (providerCallId === null && input['callId'] === undefined) out.add('providerCallId', 'required', 'an event needs a providerCallId or a callId');
  if (!isIso(input['occurredAt'])) out.add('occurredAt', 'timestamp', 'occurredAt must be an ISO 8601 timestamp');

  const t = type as PhoneEventType;
  if (t === 'phone.call.failed' && !(PHONE_FAILURE_CODES as readonly unknown[]).includes(input['code'])) out.add('code', 'enum', `code must be one of ${PHONE_FAILURE_CODES.join('|')}`);
  if (t === 'phone.call.transcript.updated') checkTranscript(input['transcript'], 'transcript', out, true);
  if (t === 'phone.call.completed') {
    if (input['transcript'] !== undefined) checkTranscript(input['transcript'], 'transcript', out, true);
    if (input['analysis'] !== undefined && !isPlainObject(input['analysis'])) out.add('analysis', 'type', 'analysis must be an object');
    for (const key of ['durationSeconds', 'costUsd'] as const) {
      const n = input[key];
      if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e9)) out.add(key, 'range', `${key} must be a non-negative number`);
    }
  }
  if (t === 'phone.call.initiated') {
    if (input['direction'] !== undefined && input['direction'] !== 'inbound' && input['direction'] !== 'outbound') out.add('direction', 'enum', 'direction must be inbound or outbound');
    for (const key of ['from', 'to'] as const) {
      const n = input[key];
      if (n !== undefined && n !== null && !isE164(n)) out.add(key, 'format', `${key} must be an E.164 number`);
    }
  }
  return out.result(input as unknown as PhoneEvent);
}

function checkTranscript(value: unknown, path: string, out: IssueCollector, required: boolean): void {
  if (value === undefined && !required) return;
  if (!isPlainObject(value as PlainObject) || !Array.isArray((value as PlainObject)['turns'])) out.add(path, 'type', 'transcript must be an object with a turns array');
}
