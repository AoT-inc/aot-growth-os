// 전화 canonical 모델 (ADR-0014). provider 이름(Vapi·Retell·Twilio)이 들어간 타입은 이 모듈에도, 코어 어디에도 없다.
// 어댑터가 provider 의 payload 를 여기의 PhoneEvent 로 바꾸고, 코어는 PhoneEvent 만 본다.
import type { CallArtifactSource, CallDirection, CallRow, CallStatus } from '../entities/index.ts';
import type { ConversationOutcome } from '../conversation/outcome.ts';
import type { RawTranscriptTurn, TranscriptTurn } from '../conversation/transcript.ts';

// ===== 전화번호 =====

/** E.164: `+` 와 국가번호로 시작하는 7~15자리 */
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;
export const isE164 = (value: unknown): value is string => typeof value === 'string' && E164_PATTERN.test(value);

/** 로그·정책 판정 기록용 마스킹: 앞 3자와 뒤 2자만 남긴다 (전화번호는 개인정보) */
export function maskNumber(number: string): string {
  if (number.length <= 6) return '*'.repeat(number.length);
  return `${number.slice(0, 3)}${'*'.repeat(number.length - 5)}${number.slice(-2)}`;
}

// ===== Call =====

export interface Call {
  id: string;
  provider: string;
  providerCallId: string | null;
  direction: CallDirection;
  status: CallStatus;
  from: string | null;
  to: string;
  taskId: string | null;
  taskRunId: string | null;
  /** 이 통화를 요청한 행위자(에이전트) */
  agentId: string | null;
  /** 이 통화를 맡은 조직 단위 */
  organizationId: string | null;
  objective: string | null;
  maxDurationSeconds: number | null;
  allowTransfer: boolean;
  recording: boolean;
  endReason: string | null;
  startedAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function callOf(row: CallRow): Call {
  return {
    id: row.id, provider: row.provider, providerCallId: row.provider_call_id, direction: row.direction, status: row.status,
    from: row.from_number, to: row.to_number, taskId: row.task_id, taskRunId: row.task_run_id, agentId: row.actor_id,
    organizationId: row.org_unit_id, objective: row.objective,
    maxDurationSeconds: row.max_duration_seconds === null ? null : Number(row.max_duration_seconds),
    allowTransfer: Number(row.allow_transfer) === 1, recording: Number(row.recording) === 1, endReason: row.end_reason,
    startedAt: row.started_at, connectedAt: row.connected_at, endedAt: row.ended_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** 발신 요청의 즉시 응답. 통화가 끝나길 기다리지 않는다 (ADR-0014 §6) */
export interface CallHandle {
  callId: string;
  status: CallStatus;
  providerCallId: string | null;
}

// ===== 에이전트가 표현하는 업무 의도 =====

export interface MakeCallInput {
  /** E.164 */
  to: string;
  /** 업무 의도 키 (예: qualify_lead). provider 프롬프트가 아니다 */
  objective: string;
  /** 통화에 필요한 업무 데이터 (leadId, companyName 등). 크기 제한이 있는 JSON */
  context?: Record<string, unknown> | undefined;
  /** 발신 번호. 생략하면 정책(`phone.caller_ids`)의 첫 번호 */
  from?: string | undefined;
  constraints?: CallConstraints | undefined;
}

export interface CallConstraints {
  maxDurationSeconds?: number | undefined;
  allowTransfer?: boolean | undefined;
  /** 녹취. 생략하면 꺼짐. 정책이 `forbidden` 이면 요청해도 거부된다 */
  recording?: boolean | undefined;
}

export interface TransferCallInput {
  callId: string;
  /** 넘길 대상 번호 (E.164). 정책의 `phone.transfer_targets` 안에 있어야 한다 */
  to: string;
  reason?: string | undefined;
}

/** 에이전트가 쓰는 Capability. 구현은 provider 구현을 import 하지 않는다 */
export interface PhoneCapability {
  call(input: MakeCallInput): Promise<CallHandle>;
  getCall(callId: string): Promise<Call>;
  transfer(input: TransferCallInput): Promise<void>;
  hangup(callId: string): Promise<void>;
}

// ===== Transcript / Outcome =====

export interface Transcript {
  callId: string;
  turns: TranscriptTurn[];
  language?: string | undefined;
  createdAt: string;
}

export interface CallOutcome extends ConversationOutcome {
  callId: string;
  source: CallArtifactSource;
  recordedAt: string;
}

// ===== canonical 이벤트 =====

export const PHONE_EVENT_TYPES = [
  'phone.call.requested', 'phone.call.initiated', 'phone.call.ringing', 'phone.call.connected', 'phone.call.transcript.updated',
  'phone.call.completed', 'phone.call.failed', 'phone.call.cancelled', 'phone.call.transferred',
] as const;
export type PhoneEventType = (typeof PHONE_EVENT_TYPES)[number];

/** 실패 사유 코드. provider 의 종료 사유 문자열은 어댑터가 이 코드로 옮긴다 */
export const PHONE_FAILURE_CODES = [
  'no_answer', 'busy', 'rejected', 'invalid_number', 'provider_error', 'network', 'timeout', 'deadline_exceeded', 'voicemail', 'unknown',
] as const;
export type PhoneFailureCode = (typeof PHONE_FAILURE_CODES)[number];

export interface PhoneTranscriptInput {
  turns: readonly RawTranscriptTurn[];
  language?: string | undefined;
}

/** provider 분석이 만든 통화 결과 후보 (상대의 말에서 나온 것이라 신뢰할 수 없는 데이터) */
export interface PhoneAnalysisInput {
  disposition?: string | undefined;
  summary?: string | undefined;
  structuredData?: Record<string, unknown> | undefined;
  nextAction?: string | undefined;
}

interface PhoneEventBase {
  /** provider 안에서 이 이벤트를 식별하는 안정적인 값 (같은 이벤트가 다시 오면 같아야 한다 — 멱등 키가 된다) */
  eventId: string;
  /** 어댑터 이름 */
  provider: string;
  providerCallId: string | null;
  /** AoT Call id. 우리가 만든 이벤트(발신 접수 등)에만 있다 */
  callId?: string | undefined;
  /** 이벤트가 일어난 시각 (ISO 8601) */
  occurredAt: string;
}

export type PhoneEvent = PhoneEventBase & (
  | { type: 'phone.call.requested' }
  | { type: 'phone.call.initiated'; direction?: CallDirection | undefined; from?: string | null | undefined; to?: string | undefined }
  | { type: 'phone.call.ringing' }
  | { type: 'phone.call.connected' }
  /** `turns` 는 *지금까지의 전체 대화*(스냅샷)다, 증분(델타)이 아니다. 더 길거나 같은 길이의 스냅샷이 이전 것을 대체한다. 어댑터는 내용이 다른 스냅샷에 다른 eventId 를 줘야 한다(같은 길이의 수정 포함) */
  | { type: 'phone.call.transcript.updated'; transcript: PhoneTranscriptInput }
  | {
    type: 'phone.call.completed'; endedReason?: string | undefined; durationSeconds?: number | undefined; costUsd?: number | undefined;
    transcript?: PhoneTranscriptInput | undefined; analysis?: PhoneAnalysisInput | undefined;
  }
  | { type: 'phone.call.failed'; code: PhoneFailureCode; reason?: string | undefined }
  | { type: 'phone.call.cancelled'; reason?: string | undefined }
  | { type: 'phone.call.transferred'; target?: string | undefined }
);

/** 인바운드 통화를 어떻게 처리할지에 대한 canonical 지시. 어댑터가 provider 응답으로 바꾼다 */
export type InboundDirective =
  | { action: 'connect_agent'; callId: string; objective: string; context?: Record<string, unknown> | undefined }
  | { action: 'transfer'; callId: string; to: string }
  | { action: 'reject'; callId: string; reason: string };
