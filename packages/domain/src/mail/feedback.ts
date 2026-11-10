// 반송·불만·수신 거부 반영 (ADR-0017 §5, docs/plans/mail-tool.md §7). 호스트 코드만 부른다: 입력은 transport 결과(또는 업체 webhook)뿐이고 에이전트 출력은 입력이 될 수 없다.
//  - 좁히기만 한다: 연락처 표에 있고 `active` 인 주소만 `suppressed` 로 바꾼다(`suppressed_by` NULL = 호스트). `active` 로 되돌리지 않는다.
//  - 연락처 행을 새로 만들지 않는다(`added_by` 는 사람 행위자여야 한다). 표에 없는 주소는 감사 기록(`event`)만 남는다.
//  - 감사 기록은 항상 남긴다: `event` source 'mail', type `mail.feedback.<kind>`. payload 에는 비밀이 없다.
import { randomUUID } from 'node:crypto';

import type { Clock } from '../clock.ts';
import { normalizeAddress } from '../contacts.ts';
import type { Db } from '../db/types.ts';

export const MAIL_EVENT_SOURCE = 'mail';
export const MAIL_FEEDBACK_KINDS = ['hard_bounce', 'complaint', 'unsubscribe'] as const;
export type MailFeedbackKind = (typeof MAIL_FEEDBACK_KINDS)[number];

const MAX_DETAIL_CHARS = 200;

export interface MailFeedback {
  kind: MailFeedbackKind;
  address: string;
  /** 단계·응답 코드 같은 짧은 설명 (서버 응답 원문이 아니다) */
  detail?: string;
}

export function applyMailFeedback(db: Db, clock: Clock, feedback: MailFeedback): { applied: boolean } {
  if (!(MAIL_FEEDBACK_KINDS as readonly string[]).includes(feedback.kind)) throw new Error(`mail feedback: unknown kind '${String(feedback.kind)}'`);
  const address = normalizeAddress(feedback.address);
  if (address === null) return { applied: false }; // 주소를 알 수 없으면 반영할 대상도 기록할 대상도 없다
  const detail = feedback.detail === undefined ? null : feedback.detail.slice(0, MAX_DETAIL_CHARS);
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    const changed = tx.run(
      "UPDATE contact SET status = 'suppressed', suppressed_by = NULL, suppressed_at = ? WHERE address = ? AND status = 'active'", [now, address],
    ).changes;
    const applied = changed > 0;
    const id = `event-${randomUUID()}`;
    tx.run(
      `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [id, MAIL_EVENT_SOURCE, address, `mail.feedback.${feedback.kind}`, JSON.stringify({ kind: feedback.kind, address, detail, applied }), `mail-feedback:${id}`, now, now],
    );
    return { applied };
  });
}
