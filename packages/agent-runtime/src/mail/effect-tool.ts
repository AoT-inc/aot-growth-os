// 메일 부작용 도구 (ADR-0017 §4, docs/plans/mail-tool.md §6): task-engine 의 부작용 원장(performEffect)이 부르는 도구. transport 호출은 여기서만 일어난다.
// 원장이 먼저 `planned → dispatched` 를 펜싱·정책 재검증과 한 트랜잭션에서 기록한 뒤에 send 를 부른다. 순서:
//  1. payload 재검증  2. 보내는 사람 대조  3. 수신 거부 확인  4. 하루 상한  5. 최소 간격(기다린다, 거부하지 않는다)  6. 렌더링 → MailTransport.send
// 1~4 에서 걸리면 아무것도 연결하지 않고 `failed`. transport 가 `rejected` 면 `failed`(5.1.x 반송 주소는 연락처를 수신 거부로 좁힌다), `accepted` 면 `confirmed`.
// transport 가 던지면(끝 점 뒤 응답을 잃음 등) 그대로 던진다: 원장이 `unknown` 으로 기록하고 멱등 미지원이면 재전송하지 않는다.
import {
  applyMailFeedback, contactStatuses, domainOfAddress, mailRecipients, messageIdOf, renderMailMessage, validateMailPayload,
  type Clock, type Db, type MailTransport,
} from '@aot/domain';

import { MAIL_SEND_TOOL, senderKeyOfTarget } from './tools.ts';

/** task-engine 의 EffectTool 과 구조가 같다 (agent-runtime 은 task-engine 을 import 하지 않는다 — 구조적 타입으로 만난다) */
export interface MailEffectTool {
  readonly name: string;
  readonly actions: Readonly<Record<string, { readonly approval: 'draft' | 'scope'; readonly idempotency: { readonly supported: false } | { readonly supported: true; readonly retention_ms: number } }>>;
  send(call: { effectKey: string; action: string; target: string; request: unknown }): Promise<{ status: 'confirmed' | 'failed'; responseRef: string | null }>;
}

export interface MailSenderConfig { address: string }

export interface MailEffectToolOptions {
  db: Db;
  clock: Clock;
  transport: MailTransport;
  /** 보내는 사람 키 → 설정 (데몬 설정 `mail.senders`) */
  senders: Readonly<Record<string, MailSenderConfig>>;
  /** 모든 메일의 List-Unsubscribe mailto 주소 */
  unsubscribeMailto: string;
  /** envelope-from. 없으면 보내는 사람 주소 */
  bounceAddress?: string;
  /** Message-ID 의 도메인. 없으면 보내는 사람 주소의 도메인 */
  messageIdDomain?: string;
  maxPerDay: number;
  minIntervalMs: number;
  /** 시험용 주입점. 기본은 실제 타이머 */
  sleep?: (ms: number) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => void setTimeout(resolve, ms));
const FAILED = { status: 'failed', responseRef: null } as const;

export function createMailEffectTool(options: MailEffectToolOptions): MailEffectTool {
  const { db, clock, transport, senders } = options;
  const sleep = options.sleep ?? realSleep;
  /** 같은 프로세스에서 다음 전송이 가능한 가장 이른 시각(ms). 기다릴 시간을 동기적으로 예약해 동시 전송이 겹치지 않게 한다 */
  let nextSlotMs = Number.NEGATIVE_INFINITY;

  return {
    name: MAIL_SEND_TOOL,
    actions: { send: { approval: 'draft', idempotency: transport.idempotency } },
    async send(call) {
      if (call.action !== 'send') throw new Error(`mail_send: unknown action '${call.action}'`);
      // 1. payload 재검증
      const checked = validateMailPayload(call.request, { requireFrom: true });
      if (!checked.ok) return FAILED;
      const payload = checked.value;
      // 2. 보내는 사람: target 의 키가 지금 설정에 있고 주소가 payload.from 과 같아야 한다
      const key = senderKeyOfTarget(call.target);
      const sender = key === null ? undefined : Object.hasOwn(senders, key) ? senders[key] : undefined;
      if (sender === undefined || sender.address !== payload.from) return FAILED;
      const recipients = mailRecipients(payload);
      // 5. 최소 간격: 먼저 기다린다(자리는 동기적으로 예약). 기다리는 동안 수신 거부가 들어올 수 있으므로 3·4 는 기다린 뒤 전송 직전에 한다
      const now = clock.nowMs();
      const slot = Math.max(now, nextSlotMs);
      nextSlotMs = slot + options.minIntervalMs;
      if (slot > now) await sleep(slot - now);
      // 3. 수신 거부 (승인 뒤에 들어왔을 수 있다)  4. 하루 상한: 최근 24시간 안에 마지막으로 바뀐 dispatched|confirmed|unknown 행 (자기 자신 제외)
      // 이 확인이 던지면 아직 아무것도 보내지 않았다: unknown 이 아니라 failed 다
      try {
        if ([...contactStatuses(db, recipients).values()].includes('suppressed')) return FAILED;
        const since = new Date(clock.nowMs() - DAY_MS).toISOString();
        const sentToday = db.get<{ n: number }>(
          `SELECT count(*) AS n FROM external_effect WHERE tool = ? AND state IN ('dispatched','confirmed','unknown') AND at >= ? AND effect_key <> ?`,
          [MAIL_SEND_TOOL, since, call.effectKey],
        )?.n ?? 0;
        if (sentToday >= options.maxPerDay) return FAILED;
      } catch (error) {
        console.error('mail_send: pre-send check failed; nothing was sent:', error instanceof Error ? error.name : 'error');
        return FAILED;
      }
      // 6. 렌더링 → 전송
      const messageId = messageIdOf(call.effectKey, options.messageIdDomain ?? domainOfAddress(payload.from));
      const raw = renderMailMessage({ payload, messageId, date: clock.nowIso(), listUnsubscribe: options.unsubscribeMailto });
      const result = await transport.send({
        idempotencyKey: call.effectKey, envelopeFrom: options.bounceAddress ?? payload.from, recipients, messageId, raw, payload,
      });
      if (result.status === 'accepted') return { status: 'confirmed', responseRef: result.providerMessageId ?? messageId };
      // transport 가 확실히 거절했다: 받는 사람 주소가 없다는 거절(5.1.1·5.1.2·5.1.3·5.1.6·5.1.10)은 호스트가 결정론적으로 수신 거부로 좁힌다. 입력은 transport 결과뿐이다
      // 반영이 실패해도 결과는 바뀌지 않는다(메일은 나가지 않았음이 확실하다): unknown 으로 새지 않게 삼킨다
      for (const address of result.bouncedRecipients) {
        try {
          if (recipients.includes(address)) applyMailFeedback(db, clock, { kind: 'hard_bounce', address, detail: `${result.stage}:${result.code}` });
        } catch (error) {
          console.error('mail_send: recording a bounce failed:', error instanceof Error ? error.name : 'error');
        }
      }
      return FAILED;
    },
  };
}
