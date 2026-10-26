// Phone Port: 전화 provider(Vapi, Retell, Twilio …)가 구현하는 계약 (ADR-0014). Capability 는 이 인터페이스만 알고 provider 이름을 모른다.
// 구현(어댑터)의 책임: 인증·API 호출·webhook 서명 검증·provider 상태/payload → canonical PhoneEvent 변환·provider 오류 → PhoneProviderError 변환.
// 어댑터는 비밀값을 가진 호스트 쪽 코드이며 에이전트(컨테이너)에 닿지 않는다 (trust-boundaries §3). 원본 payload 는 변환 뒤 버린다(저장하지 않는다).
import type { InboundDirective, PhoneEvent } from '../phone/model.ts';

export interface PhoneStartCallRequest {
  /** AoT Call id. provider 쪽 메타데이터로 실어 webhook 에서 되돌려 받을 수 있다 */
  callId: string;
  /** 외부 부작용 원장의 effect_key. provider 가 멱등 키를 지원하면 그 값으로 쓴다 */
  effectKey: string;
  to: string;
  from: string | null;
  /** 업무 의도 키. 어댑터가 provider 의 음성 에이전트 설정으로 바꾼다 (provider 프롬프트와 같은 개념이 아니다) */
  objective: string;
  context: Readonly<Record<string, unknown>>;
  maxDurationSeconds: number;
  allowTransfer: boolean;
  recording: boolean;
}

export interface PhoneStartCallResult {
  providerCallId: string;
  /** provider 가 접수한 직후의 상태. queued 또는 initiated/ringing */
  status: 'queued' | 'initiated' | 'ringing';
}

export interface PhoneTransferRequest {
  to: string;
  reason?: string | undefined;
}

export interface PhoneWebhookRequest {
  /** 소문자 이름의 헤더 */
  headers: Readonly<Record<string, string | undefined>>;
  /** 원문 본문 (서명 검증에 원문이 필요하다) */
  body: string;
}

export interface PhoneWebhookResult {
  events: readonly PhoneEvent[];
  /** provider 가 이 요청의 응답으로 인바운드 처리 지시를 기다리는가 (예: 수신 시 어떤 음성 에이전트로 받을지 묻는 요청) */
  awaitingDirective: boolean;
}

export interface PhonePort {
  /** 어댑터 이름 (`call.provider`, 이벤트 멱등 키에 들어간다). 소문자 */
  readonly name: string;
  /**
   * 발신을 접수시킨다. 접수만 하고 통화가 끝나길 기다리지 않는다.
   * provider 가 요청을 처리하지 않았음이 확실한 오류는 `PhoneProviderError.definite=true`, 도달 여부를 알 수 없으면 false 로 던진다.
   */
  startCall(request: PhoneStartCallRequest): Promise<PhoneStartCallResult>;
  hangup(providerCallId: string): Promise<void>;
  transfer(providerCallId: string, request: PhoneTransferRequest): Promise<void>;
  /** 현재 상태를 canonical 이벤트로 돌려준다 (webhook 누락 보완용 조회). 알 수 없으면 빈 목록 */
  fetchCallEvents(providerCallId: string): Promise<readonly PhoneEvent[]>;
  /** 서명/비밀을 검증하고 canonical 이벤트로 바꾼다. 검증 실패·형식 오류는 PhoneWebhookError */
  parseWebhook(request: PhoneWebhookRequest): PhoneWebhookResult;
  /** 인바운드 지시를 provider 응답으로 바꾼다 (지원하는 provider 만) */
  buildInboundReply?(directive: InboundDirective): { status: number; body: unknown };
}
