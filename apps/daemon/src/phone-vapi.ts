// Vapi 어댑터 (ADR-0014 §10): PhonePort 구현. Vapi 의 API 호출·webhook 인증·payload → canonical PhoneEvent 변환이 전부 이 파일에 있고, 코어는 Vapi 를 모른다.
// 비밀값(API 키, webhook 비밀)은 생성자에 주입된다(데몬 설정은 환경 변수 *이름*만 갖는다). 저장소에는 값이 없다. 원본 payload 는 변환 뒤 버린다.
// 근거: https://docs.vapi.ai (calls/create, server-url/events, server-url/server-authentication, calls/call-ended-reason, calls/call-features). 2026-10-25 문서 조사.
// 문서만으로 확인하지 못한 항목은 아래 `UNVERIFIED` 주석과 docs/plans/phone-capability.md 의 수동 smoke 절차에 모았다. 실제 Vapi 호출은 단위·통합 시험에서 하지 않는다.
//  - 호출 생성에 멱등 키가 문서에 없다 → 코어는 `supports_idempotency=false` 로 다룬다(응답을 잃으면 자동 재다이얼하지 않는다).
//  - 인증: webhook 은 `Authorization: Bearer <secret>` 또는 레거시 `X-Vapi-Secret: <secret>` 헤더의 비밀을 상수 시간으로 비교한다(HMAC 은 구현하지 않았다).
//  - 인바운드: `assistant-request` 에 7.5초 안에 응답해야 한다. 응답은 `assistantId` / `destination` / `error` 중 하나다.
//  - 끊기·전환은 통화 생성 응답의 `monitor.controlUrl` 로 보낸다. 그 주소는 제공자가 준 값이므로 https 이고 허용 도메인 접미사일 때만 호출하며 API 키를 싣지 않는다.
import { createHash, timingSafeEqual } from 'node:crypto';

import {
  isE164, isPlainObject, PhoneProviderError, providerErrorFromHttp, PhoneWebhookError,
  type InboundDirective, type PhoneEvent, type PhoneFailureCode, type PhonePort, type PhoneStartCallRequest, type PhoneStartCallResult, type PhoneTransferRequest,
  type PhoneWebhookRequest, type PhoneWebhookResult, type PlainObject,
} from '@aot/domain';

export const VAPI_PROVIDER = 'vapi';
const DEFAULT_BASE_URL = 'https://api.vapi.ai';

export interface VapiAdapterOptions {
  /** Vapi private API key (환경 변수에서 읽은 값) */
  apiKey: string;
  /** webhook 요청의 비밀 (Vapi 의 Custom Credential 값) */
  webhookSecret: string;
  /** 발신 번호(E.164) → Vapi phoneNumberId. 정책의 `caller_ids` 와 같은 번호들이어야 한다 */
  phoneNumbers: Readonly<Record<string, string>>;
  /** 업무 의도 키(objective) → Vapi assistantId. 목록에 없으면 `defaultAssistantId` */
  assistants?: Readonly<Record<string, string>>;
  defaultAssistantId?: string;
  baseUrl?: string;
  /** 시험은 가짜 fetch 를 넣는다 */
  fetch?: typeof fetch;
  /** 요청 타임아웃(ms). 기본 10초 */
  timeoutMs?: number;
  /** 시각 공급원(epoch ms). webhook 에 시각이 없을 때만 쓴다 */
  now?: () => number;
  /** controlUrl 로 허용하는 도메인 접미사. 기본 `vapi.ai` */
  controlHostSuffix?: string;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const obj = (value: unknown): PlainObject | undefined => (isPlainObject(value) ? value : undefined);

/** Vapi `endedReason` → canonical. 문서의 분류(call-ended-reason)를 따른다. 모르는 값은 완료로 보지 않고 `unknown` 실패로 둔다 */
export function classifyEndedReason(reason: string | undefined): { kind: 'completed' } | { kind: 'failed'; code: PhoneFailureCode } {
  if (reason === undefined) return { kind: 'completed' };
  if (['customer-ended-call', 'exceeded-max-duration', 'silence-timed-out', 'assistant-forwarded-call'].includes(reason) || reason.startsWith('assistant-ended-call') || reason === 'assistant-said-end-call-phrase') return { kind: 'completed' };
  if (reason === 'customer-did-not-answer' || reason === 'call.forwarding.no-answer') return { kind: 'failed', code: 'no_answer' };
  if (reason === 'customer-busy' || reason === 'call.forwarding.operator-busy') return { kind: 'failed', code: 'busy' };
  if (reason === 'vonage-rejected' || reason.endsWith('sip-403-forbidden')) return { kind: 'failed', code: 'rejected' };
  if (reason === 'voicemail') return { kind: 'failed', code: 'voicemail' };
  if (/^pipeline-error|-failed$|^twilio-failed|^vonage-|^call\.in-progress\.error|^phone-call-provider|^call\.start\.error/.test(reason)) return { kind: 'failed', code: 'provider_error' };
  return { kind: 'failed', code: 'unknown' };
}

/** `messages` 배열 → raw 턴. 시스템 프롬프트·도구 호출은 대화가 아니므로 버린다(프롬프트에 업무 맥락이 들어 있을 수 있다) */
export function turnsFromMessages(messages: unknown): { speaker: string; text: string }[] {
  if (!Array.isArray(messages)) return [];
  const turns: { speaker: string; text: string }[] = [];
  for (const item of messages) {
    const message = obj(item);
    if (!message) continue;
    const role = str(message['role']);
    const text = str(message['message']) ?? str(message['content']);
    if (role === undefined || text === undefined || !['assistant', 'bot', 'user'].includes(role)) continue;
    turns.push({ speaker: role, text });
  }
  return turns;
}

function analysisOf(value: unknown): { disposition?: string; summary?: string; structuredData?: Record<string, unknown>; nextAction?: string } | undefined {
  const analysis = obj(value);
  if (!analysis) return undefined;
  const result: { disposition?: string; summary?: string; structuredData?: Record<string, unknown>; nextAction?: string } = {};
  const summary = str(analysis['summary']);
  if (summary !== undefined) result.summary = summary;
  const data = obj(analysis['structuredData']);
  if (data) {
    const { disposition, nextAction, ...rest } = data;
    if (typeof disposition === 'string') result.disposition = disposition;
    if (typeof nextAction === 'string') result.nextAction = nextAction;
    result.structuredData = rest;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

const safeEqual = (a: string, b: string): boolean => {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
};

export function createVapiAdapter(options: VapiAdapterOptions): PhonePort {
  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const hostSuffix = options.controlHostSuffix ?? 'vapi.ai';
  const controlUrls = new Map<string, string>();
  const rememberControlUrl = (id: string, url: string): void => {
    controlUrls.set(id, url);
    if (controlUrls.size > 1000) controlUrls.delete(controlUrls.keys().next().value!); // 오래된 것부터 버린다 (필요하면 GET 으로 다시 얻는다)
  };
  if (options.apiKey === '' || options.webhookSecret === '') throw new Error('the Vapi adapter needs an API key and a webhook secret');

  async function request(method: 'GET' | 'POST', path: string, what: string, body?: unknown): Promise<PlainObject> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${options.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 요청이 도달했는지 알 수 없다 (definite 아님)
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new PhoneProviderError(timedOut ? 'timeout' : 'unavailable', `${what}: ${timedOut ? 'no response in time' : 'could not reach the provider'}`);
    }
    if (!response.ok) throw providerErrorFromHttp(response.status, what);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new PhoneProviderError('unknown', `${what}: the provider's answer was not JSON`, { status: response.status });
    }
    const result = obj(parsed);
    if (!result) throw new PhoneProviderError('unknown', `${what}: unexpected answer shape`, { status: response.status });
    return result;
  }

  async function controlUrlOf(providerCallId: string): Promise<string> {
    let url = controlUrls.get(providerCallId);
    if (url === undefined) {
      // UNVERIFIED: GET /call/{id} 가 monitor.controlUrl 을 돌려주는지 문서로 확인하지 못했다 (수동 smoke 에서 확인)
      url = str(obj(obj(await request('GET', `/call/${encodeURIComponent(providerCallId)}`, 'get call'))?.['monitor'])?.['controlUrl']);
      if (url === undefined) throw new PhoneProviderError('invalid_request', 'control: the call has no control url (it may have ended)');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PhoneProviderError('invalid_request', 'control: the control url is not a URL');
    }
    if (parsed.protocol !== 'https:' || !(parsed.hostname === hostSuffix || parsed.hostname.endsWith(`.${hostSuffix}`))) {
      throw new PhoneProviderError('invalid_request', 'control: the control url is not on an allowed host');
    }
    rememberControlUrl(providerCallId, url);
    return url;
  }

  async function control(providerCallId: string, payload: unknown, what: string): Promise<void> {
    const url = await controlUrlOf(providerCallId);
    let response: Response;
    try {
      // API 키를 싣지 않는다: 제공자가 준 주소로 비밀을 보내지 않는다
      response = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new PhoneProviderError(timedOut ? 'timeout' : 'unavailable', `${what}: ${timedOut ? 'no response in time' : 'could not reach the provider'}`);
    }
    if (!response.ok) throw providerErrorFromHttp(response.status, what);
  }

  const occurredAt = (...candidates: unknown[]): string => {
    for (const candidate of candidates) {
      const ms = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Date.parse(candidate) : Number.NaN;
      if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
    }
    return new Date(now()).toISOString();
  };

  /** 종료 보고(웹훅 end-of-call-report 와 GET /call 응답이 같은 모양의 필드를 쓴다) → canonical 종료 이벤트들 */
  function endEvents(callId: string, source: PlainObject, call: PlainObject): PhoneEvent[] {
    const base = { provider: VAPI_PROVIDER, providerCallId: callId, occurredAt: occurredAt(call['endedAt'], source['endedAt'], source['timestamp']) };
    const reason = str(source['endedReason']) ?? str(call['endedReason']);
    const verdict = classifyEndedReason(reason);
    const events: PhoneEvent[] = [];
    if (reason === 'assistant-forwarded-call') events.push({ ...base, eventId: `${callId}:status:forwarding`, type: 'phone.call.transferred' }); // status-update 'forwarding' 과 같은 id: 한 번만 적용된다
    if (verdict.kind === 'failed') {
      events.push({ ...base, eventId: `${callId}:end`, type: 'phone.call.failed', code: verdict.code, ...(reason === undefined ? {} : { reason }) });
      return events;
    }
    const artifact = obj(source['artifact']);
    const turns = turnsFromMessages(artifact?.['messages'] ?? source['messages'] ?? call['messages']);
    const analysis = analysisOf(source['analysis'] ?? call['analysis']);
    const cost = typeof source['cost'] === 'number' ? source['cost'] : typeof call['cost'] === 'number' ? call['cost'] : undefined;
    const startedMs = Date.parse(str(call['startedAt']) ?? '');
    const endedMs = Date.parse(str(call['endedAt']) ?? '');
    const seconds = typeof source['durationSeconds'] === 'number' ? source['durationSeconds']
      : Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs ? Math.round((endedMs - startedMs) / 1000) : undefined; // 조회 응답에는 durationSeconds 가 없다
    events.push({
      ...base, eventId: `${callId}:end`, type: 'phone.call.completed',
      ...(reason === undefined ? {} : { endedReason: reason }), ...(seconds === undefined ? {} : { durationSeconds: seconds }), ...(cost === undefined ? {} : { costUsd: cost }),
      ...(turns.length === 0 ? {} : { transcript: { turns } }), ...(analysis === undefined ? {} : { analysis }),
    });
    return events;
  }

  function statusEvent(callId: string, status: string, at: string): PhoneEvent | null {
    const base = { provider: VAPI_PROVIDER, providerCallId: callId, occurredAt: at, eventId: `${callId}:status:${status}` };
    switch (status) {
      case 'queued': case 'scheduled': return { ...base, type: 'phone.call.initiated' };
      case 'ringing': return { ...base, type: 'phone.call.ringing' };
      case 'in-progress': return { ...base, type: 'phone.call.connected' };
      case 'forwarding': return { ...base, type: 'phone.call.transferred' };
      default: return null; // 'ended' 는 종료 보고가 자세한 내용을 가진다
    }
  }

  return {
    name: VAPI_PROVIDER,

    async startCall(req: PhoneStartCallRequest): Promise<PhoneStartCallResult> {
      const from = req.from ?? Object.keys(options.phoneNumbers)[0] ?? null;
      const phoneNumberId = from === null ? undefined : options.phoneNumbers[from];
      if (phoneNumberId === undefined) throw new PhoneProviderError('invalid_request', 'start call: the caller id has no configured Vapi phone number');
      const assistantId = options.assistants?.[req.objective] ?? options.defaultAssistantId;
      if (assistantId === undefined) throw new PhoneProviderError('invalid_request', `start call: no assistant is configured for objective '${req.objective}'`);
      if (!isE164(req.to)) throw new PhoneProviderError('invalid_request', 'start call: the number is not E.164');
      // 업무 맥락은 템플릿 변수로만 전달한다(단순 값만). UNVERIFIED: assistantOverrides.variableValues / metadata / artifactPlan.recordingEnabled 필드명
      const variableValues: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(req.context)) if (['string', 'number', 'boolean'].includes(typeof value)) variableValues[key] = value as string | number | boolean;
      variableValues['objective'] = req.objective; // 예약 키: 정책이 판정한 의도가 맥락 값에 덮이지 않는다
      const created = await request('POST', '/call', 'start call', {
        phoneNumberId, customer: { number: req.to }, assistantId, name: `aot:${req.callId}`.slice(0, 40),
        assistantOverrides: {
          maxDurationSeconds: req.maxDurationSeconds, variableValues, metadata: { aot_call_id: req.callId, aot_effect_key: req.effectKey },
          artifactPlan: { recordingEnabled: req.recording },
        },
      });
      const id = str(created['id']);
      // 응답에 id 가 없으면 통화가 만들어졌는지 알 수 없다 (definite 아님)
      if (id === undefined) throw new PhoneProviderError('unknown', 'start call: the answer has no call id');
      const controlUrl = str(obj(created['monitor'])?.['controlUrl']);
      if (controlUrl !== undefined) rememberControlUrl(id, controlUrl);
      return { providerCallId: id, status: created['status'] === 'ringing' ? 'ringing' : created['status'] === 'queued' ? 'queued' : 'initiated' };
    },

    async hangup(providerCallId: string): Promise<void> {
      await control(providerCallId, { type: 'end-call' }, 'hang up');
    },

    async transfer(providerCallId: string, req: PhoneTransferRequest): Promise<void> {
      if (!isE164(req.to)) throw new PhoneProviderError('invalid_request', 'transfer: the target is not E.164');
      await control(providerCallId, { type: 'transfer', destination: { type: 'number', number: req.to } }, 'transfer');
    },

    async fetchCallEvents(providerCallId: string): Promise<readonly PhoneEvent[]> {
      const call = await request('GET', `/call/${encodeURIComponent(providerCallId)}`, 'get call');
      const status = str(call['status']) ?? '';
      const events: PhoneEvent[] = [];
      const at = occurredAt(call['updatedAt'], call['createdAt']);
      if (status === 'ended') {
        const started = statusEvent(providerCallId, 'in-progress', occurredAt(call['startedAt'], call['createdAt']));
        if (started && classifyEndedReason(str(call['endedReason'])).kind === 'completed') events.push(started); // 연결된 적이 있는 통화만
        events.push(...endEvents(providerCallId, call, call));
        return events;
      }
      const event = statusEvent(providerCallId, status, at);
      return event ? [event] : [];
    },

    parseWebhook(req: PhoneWebhookRequest): PhoneWebhookResult {
      // 두 형식을 각각 독립적으로 본다 (다른 용도의 Authorization 헤더가 있어도 X-Vapi-Secret 은 확인한다)
      const authorization = req.headers['authorization'];
      const candidates = [/^Bearer\s+/i.test(authorization ?? '') ? authorization!.replace(/^Bearer\s+/i, '') : undefined, req.headers['x-vapi-secret']];
      if (!candidates.some((candidate) => candidate !== undefined && safeEqual(candidate, options.webhookSecret))) throw new PhoneWebhookError('unauthorized', 'the webhook secret does not match');
      let body: unknown;
      try {
        body = JSON.parse(req.body);
      } catch {
        throw new PhoneWebhookError('malformed', 'the body is not JSON');
      }
      const message = obj(obj(body)?.['message']);
      const type = str(message?.['type']);
      if (!message || type === undefined) throw new PhoneWebhookError('malformed', 'the body has no message type');
      const call = obj(message['call']) ?? {};
      const callId = str(call['id']);
      const at = occurredAt(message['timestamp'], call['updatedAt']);
      if (callId === undefined) return { events: [], awaitingDirective: type === 'assistant-request' };

      switch (type) {
        case 'assistant-request': {
          const customer = str(obj(message['customer'])?.['number']) ?? str(obj(call['customer'])?.['number']);
          const ours = str(obj(message['phoneNumber'])?.['number']) ?? str(obj(call['phoneNumber'])?.['number']);
          if (!ours || !isE164(ours)) return { events: [], awaitingDirective: true };
          return {
            awaitingDirective: true,
            events: [{
              type: 'phone.call.initiated', eventId: `${callId}:request`, provider: VAPI_PROVIDER, providerCallId: callId, occurredAt: at,
              direction: 'inbound', to: ours, ...(customer !== undefined && isE164(customer) ? { from: customer } : {}),
            }],
          };
        }
        case 'status-update': {
          const event = statusEvent(callId, str(message['status']) ?? '', at);
          return { events: event ? [event] : [], awaitingDirective: false };
        }
        case 'conversation-update': {
          const turns = turnsFromMessages(message['messages']);
          if (turns.length === 0) return { events: [], awaitingDirective: false };
          return {
            events: [{ type: 'phone.call.transcript.updated', eventId: `${callId}:conversation:${turns.length}:${createHash('sha256').update(JSON.stringify(turns)).digest('hex').slice(0, 12)}`, provider: VAPI_PROVIDER, providerCallId: callId, occurredAt: at, transcript: { turns } }],
            awaitingDirective: false,
          };
        }
        case 'end-of-call-report':
          return { events: endEvents(callId, message, call), awaitingDirective: false };
        default:
          return { events: [], awaitingDirective: false }; // 조언성 메시지(speech-update 등)는 무시한다
      }
    },

    buildInboundReply(directive: InboundDirective): { status: number; body: unknown } {
      switch (directive.action) {
        case 'connect_agent': {
          const assistantId = options.assistants?.[directive.objective] ?? options.defaultAssistantId;
          return assistantId === undefined ? { status: 200, body: { error: 'Sorry, we cannot take your call right now.' } } : { status: 200, body: { assistantId } };
        }
        case 'transfer':
          return { status: 200, body: { destination: { type: 'number', number: directive.to } } };
        case 'reject':
          return { status: 200, body: { error: 'Sorry, we cannot take your call right now.' } };
      }
    },
  };
}
