// 가짜 전화 provider (ADR-0014): 실제 전화·네트워크·난수·실제 시계를 쓰지 않고, 시험이 지시한 대로 결정적으로 움직인다.
// PhonePort 계약을 구현하며 어댑터 계약 시험(test/support/phone-port-contract.ts)을 통과해야 한다.
// 일부러 "자기 나름의" webhook 형식(kind: dialing/answered/ended …)을 쓴다: 실제 provider 처럼 payload → canonical 변환을 거쳐야 하므로
// 코어가 provider payload 를 그대로 쓰는 실수를 시험이 잡는다. 이 형식은 시험·시연용이며 실제 provider 의 형식이 아니다.
import {
  PhoneProviderError, PhoneWebhookError, isE164,
  type InboundDirective, type PhoneEvent, type PhoneFailureCode, type PhonePort, type PhoneStartCallRequest, type PhoneStartCallResult, type PhoneTransferRequest,
  type PhoneWebhookRequest, type PhoneWebhookResult,
} from '@aot/domain';

export const FAKE_PHONE_PROVIDER = 'fake';
export const FAKE_SECRET_HEADER = 'x-fake-secret';

/** 가짜 provider 의 webhook 이벤트 (provider 형식) */
export interface FakeWireEvent {
  kind: 'dialing' | 'ringing' | 'answered' | 'speech' | 'ended' | 'unreachable' | 'cancelled' | 'handed_off';
  id: string;
  /** provider 쪽 통화 id */
  call: string;
  /** 우리가 발신 때 실어 보낸 AoT Call id (인바운드에는 없다) */
  ref?: string;
  at: string;
  direction?: 'in' | 'out';
  from?: string;
  to?: string;
  lines?: { who: string; said: string; at?: string }[];
  language?: string;
  reason?: string;
  cause?: string;
  seconds?: number;
  cost?: number;
  summary?: { label?: string; text?: string; data?: Record<string, unknown>; next?: string };
  target?: string;
}

const CAUSES: Readonly<Record<string, PhoneFailureCode>> = {
  'no-answer': 'no_answer', busy: 'busy', declined: 'rejected', 'bad-number': 'invalid_number', network: 'network', voicemail: 'voicemail',
};

function toCanonical(wire: FakeWireEvent): PhoneEvent {
  const base = { eventId: wire.id, provider: FAKE_PHONE_PROVIDER, providerCallId: wire.call, occurredAt: wire.at, ...(wire.ref === undefined ? {} : { callId: wire.ref }) };
  const turns = (wire.lines ?? []).map((line) => ({ speaker: line.who, text: line.said, ...(line.at === undefined ? {} : { startedAt: line.at }) }));
  switch (wire.kind) {
    case 'dialing':
      return { ...base, type: 'phone.call.initiated', ...(wire.direction === undefined ? {} : { direction: wire.direction === 'in' ? 'inbound' as const : 'outbound' as const }), ...(wire.from === undefined ? {} : { from: wire.from }), ...(wire.to === undefined ? {} : { to: wire.to }) };
    case 'ringing':
      return { ...base, type: 'phone.call.ringing' };
    case 'answered':
      return { ...base, type: 'phone.call.connected' };
    case 'speech':
      return { ...base, type: 'phone.call.transcript.updated', transcript: { turns, ...(wire.language === undefined ? {} : { language: wire.language }) } };
    case 'ended':
      return {
        ...base, type: 'phone.call.completed',
        ...(wire.reason === undefined ? {} : { endedReason: wire.reason }), ...(wire.seconds === undefined ? {} : { durationSeconds: wire.seconds }), ...(wire.cost === undefined ? {} : { costUsd: wire.cost }),
        ...(turns.length === 0 ? {} : { transcript: { turns, ...(wire.language === undefined ? {} : { language: wire.language }) } }),
        ...(wire.summary === undefined ? {} : {
          analysis: {
            ...(wire.summary.label === undefined ? {} : { disposition: wire.summary.label }), ...(wire.summary.text === undefined ? {} : { summary: wire.summary.text }),
            ...(wire.summary.data === undefined ? {} : { structuredData: wire.summary.data }), ...(wire.summary.next === undefined ? {} : { nextAction: wire.summary.next }),
          },
        }),
      };
    case 'unreachable':
      return { ...base, type: 'phone.call.failed', code: CAUSES[wire.cause ?? ''] ?? 'unknown', ...(wire.reason === undefined ? {} : { reason: wire.reason }) };
    case 'cancelled':
      return { ...base, type: 'phone.call.cancelled', ...(wire.reason === undefined ? {} : { reason: wire.reason }) };
    case 'handed_off':
      return { ...base, type: 'phone.call.transferred', ...(wire.target === undefined ? {} : { target: wire.target }) };
  }
}

export interface FakePhoneProviderOptions {
  /** webhook 인증 비밀 (시험용 값). 기본 'fake-secret' */
  secret?: string;
}

export interface FakePhoneProvider extends PhonePort {
  readonly started: PhoneStartCallRequest[];
  readonly hangups: string[];
  readonly transfers: { providerCallId: string; request: PhoneTransferRequest }[];
  /** 다음 startCall 을 이 오류로 거절한다 (한 번) */
  failNextStart(error: PhoneProviderError): void;
  /** 다음 startCall 은 통화를 접수하지만 응답을 잃는다(타임아웃) — 도달 여부를 알 수 없는 경우 */
  loseNextStartResponse(): void;
  /** 다음 transfer 는 전환을 수행하지만 응답을 잃는다(타임아웃) */
  loseNextTransferResponse(): void;
  /** 이 AoT Call id 로 접수된 provider 통화 id */
  providerCallIdOf(callId: string): string | undefined;
  /** `fetchCallEvents` 가 돌려줄 현재 상태 */
  setSnapshot(providerCallId: string, events: FakeWireEvent[]): void;
  /** webhook 요청 본문 만들기 */
  webhook(events: FakeWireEvent[], options?: { secret?: string | null; wantsDirective?: boolean }): PhoneWebhookRequest;
}

export function createFakePhoneProvider(options: FakePhoneProviderOptions = {}): FakePhoneProvider {
  const secret = options.secret ?? 'fake-secret';
  const started: PhoneStartCallRequest[] = [];
  const hangups: string[] = [];
  const transfers: { providerCallId: string; request: PhoneTransferRequest }[] = [];
  const byCall = new Map<string, string>();
  const snapshots = new Map<string, FakeWireEvent[]>();
  let nextFailure: PhoneProviderError | null = null;
  let loseNext = false;
  let loseNextTransfer = false;
  let counter = 0;

  return {
    name: FAKE_PHONE_PROVIDER,
    started, hangups, transfers,
    failNextStart(error) { nextFailure = error; },
    loseNextStartResponse() { loseNext = true; },
    loseNextTransferResponse() { loseNextTransfer = true; },
    providerCallIdOf: (callId) => byCall.get(callId),
    setSnapshot(providerCallId, events) { snapshots.set(providerCallId, events); },
    webhook(events, opts = {}) {
      const headers: Record<string, string> = {};
      const used = opts.secret === undefined ? secret : opts.secret;
      if (used !== null) headers[FAKE_SECRET_HEADER] = used;
      return { headers, body: JSON.stringify({ events, wantsDirective: opts.wantsDirective === true }) };
    },

    startCall(request): Promise<PhoneStartCallResult> {
      if (nextFailure) {
        const error = nextFailure;
        nextFailure = null;
        return Promise.reject(error);
      }
      if (!isE164(request.to)) return Promise.reject(new PhoneProviderError('invalid_request', 'start call: invalid number'));
      started.push(request);
      counter += 1;
      const providerCallId = `fake-call-${counter}`;
      byCall.set(request.callId, providerCallId);
      if (loseNext) {
        loseNext = false;
        return Promise.reject(new PhoneProviderError('timeout', 'start call: no response'));
      }
      return Promise.resolve({ providerCallId, status: 'queued' });
    },
    hangup(providerCallId) {
      hangups.push(providerCallId);
      return Promise.resolve();
    },
    transfer(providerCallId, request) {
      transfers.push({ providerCallId, request });
      if (loseNextTransfer) {
        loseNextTransfer = false;
        return Promise.reject(new PhoneProviderError('timeout', 'transfer: no response'));
      }
      return Promise.resolve();
    },
    fetchCallEvents(providerCallId) {
      return Promise.resolve((snapshots.get(providerCallId) ?? []).map(toCanonical));
    },
    parseWebhook(request): PhoneWebhookResult {
      if (request.headers[FAKE_SECRET_HEADER] !== secret) throw new PhoneWebhookError('unauthorized', 'the webhook secret does not match');
      let body: unknown;
      try {
        body = JSON.parse(request.body);
      } catch {
        throw new PhoneWebhookError('malformed', 'the body is not JSON');
      }
      const events = (body as { events?: unknown }).events;
      if (!Array.isArray(events)) throw new PhoneWebhookError('malformed', 'events is missing');
      return { events: events.map((wire) => toCanonical(wire as FakeWireEvent)), awaitingDirective: (body as { wantsDirective?: unknown }).wantsDirective === true };
    },
    buildInboundReply(directive: InboundDirective) {
      return { status: 200, body: { fakeDirective: directive.action, callId: directive.callId } };
    },
  };
}
