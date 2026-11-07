// 위임 검토자 시험이 공유하는 검토 재료. 실제 상품명·주소·비밀은 없다.
import type { DelegationReviewMaterial } from '@aot/policy';

export const HASH = 'a'.repeat(64);

export function reviewMaterial(overrides: { objective?: string; draftBody?: string; history?: DelegationReviewMaterial['history'] } = {}): DelegationReviewMaterial {
  return {
    objective: overrides.objective ?? 'Send the weekly newsletter draft to subscribers',
    mandate: { id: 'mandate-news', guidance: 'Approve routine newsletters that match the approved tone. Anything promising refunds goes to a person.', limits: { max_review_usd_per_day: 1 } as never },
    drafts: [{ id: 'draft-1', tool: 'send_message', action: 'send', target: 'subscriber@example.com', payload: { body: overrides.draftBody ?? 'Hello, here is this week\'s news.' } }],
    history: overrides.history ?? [],
    facts: { draft_count: 1, recipient_rule: 'known_contacts', payload_bytes: 40, rewrites_used: 0, rewrites_allowed: 1 } as never,
  };
}
