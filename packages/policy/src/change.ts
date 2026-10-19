// 정책 변경 등급 (ADR-0006 "위험 변경", Amendment 2026-10-19). 결정론적이고 보수적이다:
// 강화임을 증명할 수 없는 변경은 위험 변경으로 분류한다.
//  - risky_change 하향: min_approvers 감소, cooldown 단축, reauth_before_effect 끄기, self_approval 허용
//  - 예산 한도 상향: max_usd_per_task 증가, max_tokens_per_task 증가 또는 삭제
//  - 규칙: deny 규칙 추가와 allow 규칙 삭제만 강화로 본다. 그 밖의 추가·삭제·수정은 권한을 넓힐 수 있으므로 위험 변경
//    (require_approval 규칙 추가도 기본 거부였던 요청을 승인 가능으로 바꿀 수 있다)
// 기억 기본 만료(memory.default_validity) 변경은 권한·공개 범위와 무관하므로 일반 변경이다.
import { canonicalJson, type ChangeClass } from '@aot/domain';

import type { PolicyDocument } from './document.ts';

export interface PolicyChange {
  changeClass: ChangeClass;
  /** 위험 변경으로 분류한 이유 (일반 변경이면 빈 목록) */
  reasons: string[];
}

export function classifyChange(current: PolicyDocument, next: PolicyDocument): PolicyChange {
  const reasons: string[] = [];
  const a = current.risky_change;
  const b = next.risky_change;
  if (b.min_approvers < a.min_approvers) reasons.push(`risky_change.min_approvers lowered ${a.min_approvers} -> ${b.min_approvers}`);
  if (b.cooldown < a.cooldown) reasons.push(`risky_change.cooldown shortened ${a.cooldown}s -> ${b.cooldown}s`);
  if (a.reauth_before_effect && !b.reauth_before_effect) reasons.push('risky_change.reauth_before_effect turned off');
  if (!a.self_approval && b.self_approval) reasons.push('risky_change.self_approval allowed');

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
  return { changeClass: reasons.length > 0 ? 'risky' : 'normal', reasons };
}
