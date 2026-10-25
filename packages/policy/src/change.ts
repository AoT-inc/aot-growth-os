// 정책 변경 등급 (ADR-0006 "위험 변경", Amendment 2026-10-19). 결정론적이고 보수적이다:
// 강화임을 증명할 수 없는 변경은 위험 변경으로 분류한다.
//  - risky_change 하향: min_approvers 감소(2 이상 → 1 은 자기 승인 허용으로 바뀌는 변경이기도 하다), cooldown 단축, reauth_before_effect 끄기
//  - 예산 한도 상향: max_usd_per_task 증가, max_tokens_per_task 증가 또는 삭제
//  - 규칙: deny 규칙 추가와 allow 규칙 삭제만 강화로 본다. 그 밖의 추가·삭제·수정은 권한을 넓힐 수 있으므로 위험 변경
//    (require_approval 규칙 추가도 기본 거부였던 요청을 승인 가능으로 바꿀 수 있다)
//  - phone 섹션(ADR-0014): 통화를 더 많이/더 넓게 허용하는 변경은 위험 변경(섹션 신설, 지역·발신 번호·전환 대상 추가, 금지 번호 삭제, 통화시간·일일 통화량 상향,
//    영업시간 해제·확대, 녹취 완화). 섹션 삭제와 그 밖의 강화는 일반 변경
// 기억 기본 만료(memory.default_validity) 변경은 권한·공개 범위와 무관하므로 일반 변경이다.
import { canonicalJson, type ChangeClass } from '@aot/domain';

import { selfApprovalAllowed, type PhonePolicySection, type PolicyDocument } from './document.ts';

export interface PolicyChange {
  changeClass: ChangeClass;
  /** 위험 변경으로 분류한 이유 (일반 변경이면 빈 목록) */
  reasons: string[];
}

export function classifyChange(current: PolicyDocument, next: PolicyDocument): PolicyChange {
  const reasons: string[] = [];
  const a = current.risky_change;
  const b = next.risky_change;
  if (b.min_approvers < a.min_approvers) {
    // 자기 승인은 min_approvers == 1 에서만 허용되므로, 2 이상에서 1 로 내리면 자기 승인 허용으로 바뀌는 변경이기도 하다.
    const selfNote = !selfApprovalAllowed(a) && selfApprovalAllowed(b) ? ' (self-approval becomes allowed)' : '';
    reasons.push(`risky_change.min_approvers lowered ${a.min_approvers} -> ${b.min_approvers}${selfNote}`);
  }
  if (b.cooldown < a.cooldown) reasons.push(`risky_change.cooldown shortened ${a.cooldown}s -> ${b.cooldown}s`);
  if (a.reauth_before_effect && !b.reauth_before_effect) reasons.push('risky_change.reauth_before_effect turned off');

  if (next.limits.max_usd_per_task > current.limits.max_usd_per_task) {
    reasons.push(`limits.max_usd_per_task raised ${current.limits.max_usd_per_task} -> ${next.limits.max_usd_per_task}`);
  }
  const tokensBefore = current.limits.max_tokens_per_task;
  const tokensAfter = next.limits.max_tokens_per_task;
  if (tokensBefore !== undefined && (tokensAfter === undefined || tokensAfter > tokensBefore)) {
    reasons.push(`limits.max_tokens_per_task raised or removed ${tokensBefore} -> ${tokensAfter ?? 'none'}`);
  }

  const before = new Map(current.rules.map((rule) => [rule.id, rule]));
  const after = new Map(next.rules.map((rule) => [rule.id, rule]));
  for (const [id, rule] of after) {
    const old = before.get(id);
    if (!old) {
      if (rule.decision !== 'deny') reasons.push(`rule '${id}' added with decision '${rule.decision}'`);
    } else if (canonicalJson(old) !== canonicalJson(rule)) {
      reasons.push(`rule '${id}' changed`);
    }
  }
  for (const [id, rule] of before) {
    if (!after.has(id) && rule.decision !== 'allow') reasons.push(`rule '${id}' (decision '${rule.decision}') removed`);
  }
  reasons.push(...phoneWidenings(current.phone, next.phone));
  return { changeClass: reasons.length > 0 ? 'risky' : 'normal', reasons };
}

/** 전화 섹션이 통화를 더 허용하게 바뀐 부분. 강화임을 증명할 수 없으면 넓힘으로 본다 */
function phoneWidenings(before: PhonePolicySection | undefined, after: PhonePolicySection | undefined): string[] {
  if (after === undefined) return []; // 섹션을 지우면 모든 통화가 거부된다
  if (before === undefined) return ['phone section added (phone calls become possible)'];
  const reasons: string[] = [];
  for (const region of after.allowed_regions) {
    if (!before.allowed_regions.some((existing) => region.startsWith(existing))) reasons.push(`phone.allowed_regions widened by '${region}'`);
  }
  for (const number of before.denied_numbers) if (!after.denied_numbers.includes(number)) reasons.push('phone.denied_numbers entry removed');
  for (const id of after.caller_ids) if (!before.caller_ids.includes(id)) reasons.push('phone.caller_ids entry added');
  for (const target of after.transfer_targets) if (!before.transfer_targets.includes(target)) reasons.push('phone.transfer_targets entry added');
  if (after.max_duration_seconds > before.max_duration_seconds) reasons.push(`phone.max_duration_seconds raised ${before.max_duration_seconds} -> ${after.max_duration_seconds}`);
  if (after.max_calls_per_day > before.max_calls_per_day) reasons.push(`phone.max_calls_per_day raised ${before.max_calls_per_day} -> ${after.max_calls_per_day}`);
  const unitBefore = before.max_calls_per_day_per_org_unit;
  const unitAfter = after.max_calls_per_day_per_org_unit;
  if (unitBefore !== undefined && (unitAfter === undefined || unitAfter > unitBefore)) reasons.push(`phone.max_calls_per_day_per_org_unit raised or removed ${unitBefore} -> ${unitAfter ?? 'none'}`);
  if (after.recording !== before.recording && after.recording !== 'forbidden') reasons.push(`phone.recording loosened ${before.recording} -> ${after.recording}`);
  const h0 = before.business_hours;
  const h1 = after.business_hours;
  if (h0 !== undefined) {
    const narrower = h1 !== undefined && h1.tz === h0.tz && h1.days.every((day) => h0.days.includes(day)) && h1.start >= h0.start && h1.end <= h0.end;
    if (!narrower && canonicalJson(h0) !== canonicalJson(h1)) reasons.push('phone.business_hours removed or widened');
  }
  return reasons;
}
