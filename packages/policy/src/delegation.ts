// 결정 위임 (ADR-0016, 제안 — 오너 결정 D-B1 전까지 proposed). 사람이 정책 배포(TOTP)로 정한 위임(mandate) 안에서만 위임 보유자(AI)가 초안 승인 업무를 승인할 수 있다.
//  - 이 모듈은 결정론적 판단만 한다: 위임이 지금 유효한가(정지·철회·만료), 업무가 위임 대상으로 적격인가. AI 출력은 여기 들어오지 않는다(엔진의 delegateDecide 가 같은 트랜잭션에서
//    적격을 다시 확인한 뒤에만 기록한다). 위임이 없는 정책에서는 아무것도 하지 않는다.
//  - 적격은 "모두 참"이어야 한다. 거짓인 첫 조건이 "사람에게 온 이유"(한 줄, 한국어)가 되어 delegate_review 에 남는다.
//  - 항상 사람(코드 상수, 정책으로 못 바꾼다): ALWAYS_HUMAN. v1 의 subjects 는 `task` 뿐이라 나머지는 형식상으로도 위임할 수 없다.
import {
  contactStatuses, domainOfAddress, messagePreviewOf, normalizeAddress, recipientAddressesOf, type Db, type DelegationControlRow, type DraftSendState, type EffectDraftRow, type TaskRow, type TaskSpec,
} from '@aot/domain';

import type { DelegationAuthority } from './approval.ts';
import { mandateExpiresAt, type Mandate, type PolicyDocument, type RecipientRule } from './document.ts';
import { globMatch, type PolicyRequest, type PolicyVerdict } from './evaluate.ts';

/** 위임으로도 사람이 맡는 결정 (ADR-0016 Decision 5). 코드 상수이며 정책으로 바꾸지 못한다 */
export const ALWAYS_HUMAN = [
  'policy_deploy',         // 정책 배포(위임 변경 포함)
  'org_proposal',          // 조직 변경 제안 전부와 시험 확정
  'strategy_version',      // 실험 전략 승인·승격
  'product_decision',      // 상품 등록 결정
  'effect_resolution',     // 효과 확정(resolve-effect)
  'publication',           // 게시
  'scope_approval_task',   // 초안이 아닌 범위 승인 업무(전화·customer 읽기 등)
  'delete_impact',         // 영향에 delete 가 있는 업무
  'external_input_draft',  // 외부 입력이 쓴 초안
  'human_decided_task',    // 사람이 한 번 결정한 업무
  'delegation_resume',     // 위임 정지 해제
] as const;
export type AlwaysHuman = (typeof ALWAYS_HUMAN)[number];

/** v1 에서 위임할 수 있는 승인 대상 */
export const DELEGABLE_SUBJECTS = ['task'] as const;

/** 하루 창 (위임 승인 수, 검토 비용) */
export const DELEGATION_WINDOW_MS = 24 * 3_600_000;

/** AI 사유(승인 행 comment·검토 기록)의 길이 */
export const MAX_DELEGATE_REASON_CHARS = 200;

export const mandatesOf = (document: PolicyDocument): readonly Mandate[] => document.delegation?.mandates ?? [];

export function readDelegationControls(db: Db): DelegationControlRow[] {
  return db.all<DelegationControlRow>('SELECT * FROM delegation_control ORDER BY id');
}

export type MandateStop = 'revoked' | 'paused';

/**
 * 이 위임이 정지·철회 상태인가.
 *  - 철회(revoke): 이 위임 id 의 철회 행이 하나라도 있으면 영원히 (다시 켤 수 없다 — 정책에서 지우거나 새 id 로 다시 위험 변경)
 *  - 정지(pause): 전체 또는 이 위임의 가장 최근 pause/resume 이 pause 면 지금 정지
 *  - `sinceAt` 을 주면 그 시각 이후(같은 시각 포함)에 전체·이 위임의 정지/철회가 한 번이라도 있었으면 정지로 본다 — 승인 뒤에 정지가 있었다면 풀려도 그 승인은 되살아나지 않는다
 */
export function mandateStop(controls: readonly DelegationControlRow[], mandateId: string, sinceAt?: string): MandateStop | null {
  if (controls.some((c) => c.action === 'revoke' && c.mandate_id === mandateId)) return 'revoked';
  const latest = (scope: string | null) => controls.filter((c) => c.action !== 'revoke' && c.mandate_id === scope).at(-1);
  if (latest(null)?.action === 'pause' || latest(mandateId)?.action === 'pause') return 'paused';
  if (sinceAt !== undefined && controls.some((c) => c.action !== 'resume' && (c.mandate_id === null || c.mandate_id === mandateId) && c.at >= sinceAt)) return 'paused';
  return null;
}

export type MandateUsability = { usable: true } | { usable: false; reason: string };

/** 위임이 지금 쓸 수 있는가: 정책의 승인자 수 규칙, 만료, 정지·철회 (`sinceAt` 은 mandateStop 참고) */
export function mandateUsability(document: PolicyDocument, mandate: Mandate, controls: readonly DelegationControlRow[], now: string, sinceAt?: string): MandateUsability {
  if (document.risky_change.min_approvers !== 1) return { usable: false, reason: '승인자가 2명 이상 필요한 정책에서는 위임이 꺼집니다' };
  const expiresAt = mandateExpiresAt(mandate.expires);
  if (expiresAt === null || now > expiresAt) return { usable: false, reason: `위임 ${mandate.id}의 기간이 끝났습니다 (${mandate.expires})` };
  const stop = mandateStop(controls, mandate.id, sinceAt);
  if (stop === 'revoked') return { usable: false, reason: `위임 ${mandate.id}이(가) 철회되었습니다` };
  if (stop === 'paused') return { usable: false, reason: `위임 ${mandate.id}이(가) 멈춰 있습니다` };
  return { usable: true };
}

/** 승인 계산이 위임 승인 행을 받아 주는 쪽. 위임이 없는 정책이면 null — 그러면 에이전트 행은 하나도 세지 않는다 */
export function delegationAuthority(db: Db, document: PolicyDocument, now: string): DelegationAuthority | null {
  const mandates = mandatesOf(document);
  if (mandates.length === 0) return null;
  const byId = new Map(mandates.map((mandate) => [mandate.id, mandate]));
  const controls = readDelegationControls(db);
  return {
    accepts: ({ mandateId, decidedBy, at }) => {
      const mandate = byId.get(mandateId);
      return mandate !== undefined && mandate.holder === decidedBy && mandateUsability(document, mandate, controls, now, at).usable;
    },
    cooldownOf: (mandateId) => byId.get(mandateId)?.cooldown ?? null,
  };
}

// ===== 적격 =====

export type EligibilityCode =
  | 'no_mandate' | 'mandate_inactive' | 'wrong_state' | 'not_draft_task' | 'no_drafts' | 'policy_denied' | 'always_human' | 'already_approved' | 'human_decided'
  | 'out_of_mandate' | 'too_many_drafts' | 'draft_expired' | 'masked' | 'send_started' | 'external_input' | 'unknown_shape' | 'recipients' | 'recipient_rule' | 'payload_size'
  | 'requester_is_holder' | 'daily_limit' | 'task_budget' | 'review_budget' | 'holder_unavailable';

export type Eligibility =
  | { eligible: true; mandate: Mandate }
  /** `mandateId`: 사람에게 온 이유를 남길 위임 (가장 멀리 간 위임, 일반 조건이면 첫 위임). 위임이 하나도 없으면 null */
  | { eligible: false; code: EligibilityCode; reason: string; mandateId: string | null };

/** 엔진이 만든 업무 승인 문맥 중 적격 검사에 필요한 부분 (engine.ts `#taskContext`와 같은 값) */
export interface DelegationTaskContext {
  task: TaskRow;
  spec: TaskSpec;
  document: PolicyDocument;
  verdicts: readonly { request: PolicyRequest; verdict: PolicyVerdict }[];
  drafts: readonly EffectDraftRow[];
  sendStates: ReadonlyMap<string, DraftSendState | string>;
  /** 초안 id → 표시용 가리기가 바꾼 값의 경로 */
  masked: ReadonlyMap<string, string[]>;
  requester: string | null;
}

const no = (code: EligibilityCode, reason: string, mandateId: string | null = null): Extract<Eligibility, { eligible: false }> => ({ eligible: false, code, reason, mandateId });

/** 사람이 이 업무에 결정한 적이 있는가 (승인·거절·취소·다시 쓰게 모두). 위임 보유자(에이전트)의 행은 세지 않는다 */
function humanDecided(tx: Db, taskId: string): boolean {
  return tx.get(
    `SELECT 1 AS one FROM approval a JOIN actor ON actor.id = a.decided_by
     WHERE a.subject_kind = 'task' AND a.subject_id = ? AND actor.kind = 'human' LIMIT 1`, [taskId],
  ) !== undefined;
}

/** AI 의 다시 쓰게 횟수 (이 위임, 이 업무) */
export function rewritesUsed(tx: Db, taskId: string, mandateId: string): number {
  return Number(tx.get<{ n: number }>(
    "SELECT count(*) AS n FROM approval WHERE subject_kind = 'task' AND subject_id = ? AND decision = 'changes_requested' AND mandate_id = ?", [taskId, mandateId],
  )?.n ?? 0);
}

/**
 * 업무가 위임 대상으로 적격인가 (ADR-0016 §3.3). 읽기 전용이며 같은 입력이면 같은 결과다.
 * 위임마다 검사해 적격인 첫 위임(id 순)을 돌려준다. 없으면 가장 멀리 간 위임의 첫 거짓 조건(없으면 일반 조건의 것)을 이유로 돌려준다.
 */
export function delegationEligibility(tx: Db, ctx: DelegationTaskContext, now: string): Eligibility {
  const mandates = mandatesOf(ctx.document);
  if (mandates.length === 0) return no('no_mandate', '이 정책에는 위임이 없습니다');
  const general = generalChecks(tx, ctx);
  if (general !== null) return { ...general, mandateId: mandates[0]!.id };
  const controls = readDelegationControls(tx);
  let furthest: { depth: number; result: Extract<Eligibility, { eligible: false }> } | null = null;
  for (const mandate of mandates) {
    const result = mandateChecks(tx, ctx, mandate, controls, now);
    if (result.eligible) return result;
    if (furthest === null || result.depth > furthest.depth) furthest = { depth: result.depth, result: result.failure };
  }
  return furthest!.result;
}

/** 위임과 무관한 조건: 항상 사람인 업무와 업무 자체의 상태 */
function generalChecks(tx: Db, ctx: DelegationTaskContext): Extract<Eligibility, { eligible: false }> | null {
  const { task, spec } = ctx;
  if (task.status !== 'needs_review') return no('wrong_state', `업무가 검토 대기 상태가 아닙니다 (${task.status})`);
  const denied = ctx.verdicts.find((v) => v.verdict.decision === 'deny');
  if (denied !== undefined) return no('policy_denied', '지금 정책이 이 업무를 거부합니다 (위임으로 바꿀 수 없습니다)');
  if (spec.allowed_tools.some((entry) => entry.impact === 'delete')) return no('always_human', '삭제 영향이 있는 업무는 항상 사람이 정합니다');
  if (spec.allowed_tools.some((entry) => entry.scope === 'public')) return no('always_human', '공개(public) 범위는 항상 사람이 정합니다');
  const approvals = ctx.verdicts.filter((v) => v.verdict.decision === 'require_approval');
  if (approvals.length === 0) return no('not_draft_task', '승인이 필요한 업무가 아닙니다');
  if (approvals.some((v) => v.request.impact !== 'external_effect')) return no('always_human', '초안이 아닌 범위 승인(고객 데이터 읽기·전화 등)은 항상 사람이 정합니다');
  if (ctx.drafts.length === 0) return no('no_drafts', '제안된 초안이 없습니다');
  if (task.approved_hash !== null) return no('already_approved', '이미 승인이 기록된 업무입니다');
  if (humanDecided(tx, task.id)) return no('human_decided', '사람이 이 업무에 이미 결정한 적이 있어 계속 사람이 정합니다');
  return null;
}

/**
 * 받는 사람 규칙 검사 (D-B11, 결정론). to·cc·bcc 와 reply_to 의 모든 주소를 정규화해 위임의 규칙과 연락처 표에 대조한다.
 *  - 읽을 수 없는 주소는 모르는 주소다. 수신 거부(suppressed)는 규칙 종류와 상관없이 막는다
 * 통과하면 null, 아니면 사람에게 보이는 한 줄 이유(한국어). AI 출력은 여기에 영향을 주지 못한다.
 */
export function recipientRuleViolation(tx: Db, rule: RecipientRule, payload: unknown): string | null {
  const found = recipientAddressesOf(payload);
  if (found === null) return '받는 사람을 확인할 수 없는 모양의 초안입니다';
  const entries = [...found.recipients, ...found.replyTo];
  const addresses = new Set<string>();
  let unreadable = found.malformed;
  for (const entry of entries) {
    const address = normalizeAddress(entry);
    if (address === null) unreadable += 1;
    else addresses.add(address);
  }
  const statuses = contactStatuses(tx, [...addresses]);
  let suppressed = 0;
  let unknown = 0;
  for (const address of addresses) {
    const status = statuses.get(address);
    if (status === 'suppressed') suppressed += 1;
    else if (rule.kind === 'known_contacts' ? status !== 'active' : !rule.domains.includes(domainOfAddress(address))) unknown += 1;
  }
  const parts: string[] = [];
  if (unknown > 0) parts.push(`${rule.kind === 'known_contacts' ? '처음 보는' : '허용된 도메인이 아닌'} 받는 사람 ${unknown}명`);
  if (unreadable > 0) parts.push(`주소를 읽을 수 없는 받는 사람 ${unreadable}명`);
  if (suppressed > 0) parts.push(`수신을 막아 둔 받는 사람 ${suppressed}명`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** 위임 하나에 대한 조건. depth = 통과한 조건 수 (가장 멀리 간 위임을 고르는 데 쓴다) */
function mandateChecks(
  tx: Db, ctx: DelegationTaskContext, mandate: Mandate, controls: readonly DelegationControlRow[], now: string,
): { eligible: true; mandate: Mandate } | { eligible: false; depth: number; failure: Extract<Eligibility, { eligible: false }> } {
  const fail = (depth: number, code: EligibilityCode, reason: string) => ({ eligible: false as const, depth, failure: no(code, reason, mandate.id) });
  const usable = mandateUsability(ctx.document, mandate, controls, now);
  if (!usable.usable) return fail(0, 'mandate_inactive', usable.reason);
  const holder = tx.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [mandate.holder]);
  if (holder?.kind !== 'agent') return fail(0, 'holder_unavailable', `위임 보유자 ${mandate.holder}이(가) 에이전트 행위자로 등록되어 있지 않습니다`);

  // 범위: 모든 초안이 위임의 도구·action·대상·범위 안
  for (const draft of ctx.drafts) {
    const action = `${draft.tool}.${draft.action}`;
    const entry = ctx.spec.allowed_tools.find((t) =>
      t.tool === draft.tool && t.impact === 'external_effect' && t.operations.includes(draft.action) && (t.target === undefined || t.target === draft.target));
    const inside = mandate.match.actions.some((p) => globMatch(p, action))
      && mandate.match.targets.some((p) => globMatch(p, draft.target))
      && entry?.scope !== undefined && (mandate.match.scopes as readonly string[]).includes(entry.scope);
    if (!inside) return fail(1, 'out_of_mandate', `초안 ${action} → ${draft.target}은(는) 위임 ${mandate.id}의 범위 밖입니다`);
  }
  if (ctx.drafts.length > mandate.limits.max_drafts_per_task) {
    return fail(2, 'too_many_drafts', `초안 ${ctx.drafts.length}건 — 위임 한도 ${mandate.limits.max_drafts_per_task}건`);
  }
  // 초안마다: 만료·가린 값·전송 시작·외부 입력·받는 사람 수·크기
  for (const draft of ctx.drafts) {
    if (now >= draft.expires_at) return fail(3, 'draft_expired', '초안의 기한이 지났습니다');
    if ((ctx.masked.get(draft.id) ?? []).length > 0) return fail(3, 'masked', '가려지는 값이 있는 초안은 사람이 모든 내용을 보고 정해야 합니다');
    if ((ctx.sendStates.get(draft.id) ?? 'none') !== 'none') return fail(3, 'send_started', '전송이 이미 시작된 초안이 있습니다');
    if (draft.influenced_by_external_input === 1) return fail(3, 'external_input', '외부 입력이 영향을 준 초안은 항상 사람이 정합니다');
    const preview = messagePreviewOf(JSON.parse(draft.payload));
    if (preview === null) return fail(3, 'unknown_shape', '받는 사람과 본문을 확인할 수 없는 모양의 초안입니다');
    if (preview.recipients.length > mandate.limits.max_recipients_per_draft) {
      return fail(3, 'recipients', `받는 사람 ${preview.recipients.length}명 — 위임 한도 ${mandate.limits.max_recipients_per_draft}명`);
    }
    const violation = recipientRuleViolation(tx, mandate.match.recipients, JSON.parse(draft.payload));
    if (violation !== null) return fail(3, 'recipient_rule', violation);
    const bytes = Buffer.byteLength(draft.payload, 'utf8');
    if (bytes > mandate.limits.max_payload_bytes) return fail(3, 'payload_size', `초안 크기 ${bytes}바이트 — 위임 한도 ${mandate.limits.max_payload_bytes}바이트`);
  }
  if (ctx.requester !== null && ctx.requester === mandate.holder) return fail(4, 'requester_is_holder', '위임 보유자가 요청한 업무는 보유자가 승인할 수 없습니다');
  const since = new Date(Date.parse(now) - DELEGATION_WINDOW_MS).toISOString();
  const approved = Number(tx.get<{ n: number }>("SELECT count(*) AS n FROM approval WHERE mandate_id = ? AND decision = 'approved' AND at > ?", [mandate.id, since])?.n ?? 0);
  if (approved >= mandate.limits.max_per_day) return fail(5, 'daily_limit', `지난 24시간 위임 승인 ${approved}건 — 하루 한도 ${mandate.limits.max_per_day}건`);
  if (Number(ctx.task.cost_budget_usd) > mandate.limits.max_task_usd) {
    return fail(5, 'task_budget', `업무 예산 ${Number(ctx.task.cost_budget_usd)}달러 — 위임 한도 ${mandate.limits.max_task_usd}달러`);
  }
  const spent = Number(tx.get<{ total: number }>('SELECT coalesce(sum(cost_usd), 0) AS total FROM delegate_review WHERE mandate_id = ? AND at > ?', [mandate.id, since])?.total ?? 0);
  if (spent >= mandate.limits.max_review_usd_per_day) return fail(5, 'review_budget', `위임 검토 비용 ${spent}달러 — 하루 한도 ${mandate.limits.max_review_usd_per_day}달러`);
  return { eligible: true, mandate };
}
