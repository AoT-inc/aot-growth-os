// 시험용 메모리 MailTransport (ADR-0017 §12). 네트워크 없이 받은 메일을 기록하고, 결과를 시험이 대본으로 정한다.
import type { MailSendResult, MailTransport, OutboundMail } from '@aot/domain';

export type FakeMailOutcome = MailSendResult | { throws: Error };

export interface FakeMailTransport extends MailTransport {
  /** `send` 가 받은 메일 (연결 횟수 = 길이) */
  readonly sent: OutboundMail[];
  /** 다음 호출들의 결과를 순서대로 정한다. 대본이 떨어지면 `accepted` */
  script(...outcomes: FakeMailOutcome[]): void;
}

export interface FakeMailTransportOptions {
  idempotency?: MailTransport['idempotency'];
  name?: string;
}

export function createFakeMailTransport(options: FakeMailTransportOptions = {}): FakeMailTransport {
  const sent: OutboundMail[] = [];
  const queue: FakeMailOutcome[] = [];
  return {
    name: options.name ?? 'fake-mail',
    idempotency: options.idempotency ?? { supported: false },
    sent,
    script: (...outcomes) => void queue.push(...outcomes),
    send(mail) {
      sent.push(mail);
      const next = queue.shift();
      if (next === undefined) return Promise.resolve({ status: 'accepted', providerMessageId: null });
      if ('throws' in next) return Promise.reject(next.throws);
      return Promise.resolve(next);
    },
  };
}
