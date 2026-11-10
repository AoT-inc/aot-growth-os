// 메일 전송 포트 (ADR-0017, docs/plans/mail-tool.md §2·§6). provider(SMTP, 나중에 업체 HTTP API)는 이 포트 뒤에 있다. 코어는 업체 이름을 모른다.
// 계약: `accepted`/`rejected` 는 결과가 확실할 때만 돌려준다. 결과를 알 수 없으면(메시지가 성립했을 수 있는데 응답을 잃음) 던진다 — 원장이 `unknown` 으로 기록한다.
import type { MailPayload } from '../mail/payload.ts';

export interface OutboundMail {
  /** 멱등 키 (= effect_key). 멱등을 지원하는 어댑터만 쓴다 */
  idempotencyKey: string;
  /** SMTP envelope-from (반송 주소) */
  envelopeFrom: string;
  /** envelope 받는 사람: to + cc */
  recipients: string[];
  /** `<…@…>` 꼴 Message-ID (raw 의 헤더와 같다) */
  messageId: string;
  /** 렌더링된 RFC 5322 메시지 (ASCII, CRLF) */
  raw: string;
  /** 승인된 payload (업체 HTTP API 어댑터가 쓴다. SMTP 는 raw 만 쓴다) */
  payload: MailPayload;
}

export type MailRejectStage = 'connect' | 'tls' | 'auth' | 'envelope' | 'data' | 'config';

export type MailSendResult =
  | { status: 'accepted'; providerMessageId: string | null }
  | {
    status: 'rejected';
    stage: MailRejectStage;
    /** 단계·응답 코드·확장 상태만 담는다 (서버 응답 원문·자격 증명 없음) */
    code: string;
    /** RCPT 단계에서 확장 상태 5.1.x 로 거절된 받는 사람 (주소 없음·도메인 없음 등) */
    bouncedRecipients: string[];
  };

export interface MailTransport {
  readonly name: string;
  readonly idempotency: { readonly supported: false } | { readonly supported: true; readonly retention_ms: number };
  send(mail: OutboundMail): Promise<MailSendResult>;
}
