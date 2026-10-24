// 승인 확인 (ADR-0006 Amendment 2026-10-19, trust-boundaries §4). 승인은 대상의 정규화 해시(subject_hash)에 묶이고,
// 실행 직전에 해시·정책 버전·승인자 수·대기(cooldown)·재인증을 다시 확인한다. 대상이 바뀌면 승인은 무효다.
//
// approval 행 해석 (같은 subject_kind·subject_id, 시각순):
//  - 'approved' 가 아닌 행(rejected 등)은 그 앞의 승인을 모두 무효로 한다 (거절, 대기 중 취소)
//  - 남은 'approved' 중 subject_hash 가 지금 해시와 같고, 사람(actor.kind='human')이며, 자기 승인이 금지(min_approvers ≥ 2)면 요청자가 아닌 것만 센다
//  - 서로 다른 승인자 수가 min_approvers 에 닿은 시각 + cooldown 이 지나야 하고, reauth_before_effect 면 그 뒤의 재인증 기록이 있어야 한다
import type { ApprovalSubjectKind, Db, PublicationRow, StrategyVersionRow, TaskRow, TaskSpec } from '@aot/domain';
import { contentHash } from '@aot/domain';

import { type ApprovalParams } from './document.ts';

export type ApprovalState =
  | 'approved'
  | 'missing'
  | 'insufficient'
  | 'hash_mismatch'
  | 'self_approval'
  | 'revoked'
  | 'cooldown'
  | 'reauth_required';

export interface ApprovalStatus {
  ok: boolean;
  state: ApprovalState;
  reason: string;
  approvers: string[];
  /** 승인자 수가 채워진 승인 행 */
  quorumApprovalId: string | null;
  quorumAt: string | null;
  cooldownEndsAt: string | null;
}

export interface ApprovalQuery {
  kind: ApprovalSubjectKind;
  id: string;
  hash: string;
  /** 자기 승인 판단용 요청자 actor id (모르면 null) */
  requesterId: string | null;
  params: ApprovalParams;
  now: string;
  /** false 면 재인증은 보지 않는다 (재인증 직전의 확인) */
  checkReauth?: boolean;
}

interface ApprovalJoinRow {
  id: string;
  decision: string;
  subject_hash: string | null;
  decided_by: string;
  at: string;
  actor_kind: string | null;
  [key: string]: string | null;
}

export const reauthPurpose = (kind: ApprovalSubjectKind, id: string, hash: string): string => `release:${kind}:${id}:${hash}`;

export function approvalStatus(db: Db, query: ApprovalQuery): ApprovalStatus {
  const rows = db.all<ApprovalJoinRow>(
    `SELECT a.id, a.decision, a.subject_hash, a.decided_by, a.at, actor.kind AS actor_kind
     FROM approval a LEFT JOIN actor ON actor.id = a.decided_by
     WHERE a.subject_kind = ? AND a.subject_id = ? ORDER BY a.at, a.rowid`,
    [query.kind, query.id],
  );
  let start = 0;
  rows.forEach((row, index) => {
    if (row.decision !== 'approved') start = index + 1;
  });
  const revoked = start > 0;
  const epoch = rows.slice(start);
  const approvers: string[] = [];
  let quorum: ApprovalJoinRow | null = null;
  let stale = 0;
  let self = 0;
  for (const row of epoch) {
    if (row.actor_kind !== 'human') continue;
    if (row.subject_hash !== query.hash) {
      stale += 1;
      continue;
    }
    if (!query.params.self_approval && query.requesterId !== null && row.decided_by === query.requesterId) {
      self += 1;
      continue;
    }
    if (approvers.includes(row.decided_by)) continue;
    approvers.push(row.decided_by);
    if (approvers.length === query.params.min_approvers) quorum = row;
  }
  const base = { approvers, quorumApprovalId: quorum?.id ?? null, quorumAt: quorum?.at ?? null, cooldownEndsAt: null };
  const fail = (state: ApprovalState, reason: string): ApprovalStatus => ({ ok: false, state, reason, ...base });
  if (!quorum) {
    const need = `${approvers.length}/${query.params.min_approvers} human approvals`;
    if (approvers.length > 0) return fail('insufficient', `${need}; waiting for more approvers`);
    if (stale > 0) return fail('hash_mismatch', `approval was given for different content (approved_hash mismatch); re-approval required`);
    if (self > 0) return fail('self_approval', 'the requester cannot approve their own request (self-approval is allowed only when min_approvers is 1)');
    if (revoked) return fail('revoked', 'the approval was rejected or cancelled');
    return fail('missing', 'approval required (no approval recorded)');
  }
  const cooldownEndsAt = new Date(Date.parse(quorum.at) + query.params.cooldown * 1000).toISOString();
  const withCooldown = { ...base, cooldownEndsAt };
  if (query.now < cooldownEndsAt) {
    return { ok: false, state: 'cooldown', reason: `approved; cooldown until ${cooldownEndsAt} (can be cancelled meanwhile)`, ...withCooldown };
  }
  if (query.params.reauth_before_effect && query.checkReauth !== false) {
    const reauth = db.get('SELECT 1 AS one FROM human_reauth WHERE purpose = ? AND at >= ? LIMIT 1', [reauthPurpose(query.kind, query.id, query.hash), cooldownEndsAt]);
    if (!reauth) return { ok: false, state: 'reauth_required', reason: 'human re-authentication (TOTP) is required after the cooldown', ...withCooldown };
  }
  return { ok: true, state: 'approved', reason: `approved by ${approvers.join(', ')}`, ...withCooldown };
}

// ===== 승인 대상의 정규화 내용 =====

/** 업무 승인 대상: 실행 인자(명세)와 승인 시점의 정책 버전. 실행 중 쌓이는 evidence_refs 는 뺀다. */
export function taskSubject(task: Pick<TaskRow, 'id' | 'role_id' | 'role_version' | 'product_id'>, spec: TaskSpec, policyVersionId: string) {
  const args: Record<string, unknown> = { ...spec };
  delete args['evidence_refs'];
  delete args['approved_snapshot'];
  return {
    kind: 'task' as const,
    task_id: task.id,
    spec: args,
    role_id: task.role_id,
    role_version: task.role_version === null ? null : Number(task.role_version),
    product_id: task.product_id,
    policy_version_id: policyVersionId,
  };
}

export type TaskSubject = ReturnType<typeof taskSubject>;

export const taskSubjectHash = (subject: TaskSubject): string => contentHash(subject);

export function publicationSubject(row: Pick<PublicationRow, 'id' | 'task_id' | 'product_id' | 'channel' | 'audience' | 'content_ref'>, policyVersionId: string) {
  return {
    kind: 'publication' as const,
    publication_id: row.id,
    task_id: row.task_id,
    product_id: row.product_id,
    channel: row.channel,
    audience: row.audience,
    content_ref: row.content_ref,
    policy_version_id: policyVersionId,
  };
}

/**
 * 실험 전략 승인 대상 (A6-U15): 제안 본문(제목·가설·근거 참조·부모) + `experiment_scope`(마케팅 업무 명세 또는 템플릿 참조, 측정 신호, 주, 비교 요약)
 * + 승인 시점 정책 버전(id 와 내용 해시). 상태(status)는 승인으로 바뀌므로 넣지 않는다. 업무 승인 대상(`taskSubject`)과 같은 구성이다.
 */
export function strategySubject(
  row: Pick<StrategyVersionRow, 'id' | 'parent_id' | 'title' | 'body' | 'rationale_refs' | 'experiment_scope' | 'created_by'>,
  policy: { versionId: string; hash: string },
) {
  const parse = (text: string | null): unknown => {
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text; // 형식이 깨진 값도 그대로 해시에 묶는다 (내용이 바뀌면 해시가 바뀐다)
    }
  };
  return {
    kind: 'strategy_version' as const,
    strategy_version_id: row.id,
    parent_id: row.parent_id,
    title: row.title,
    body: row.body,
    rationale_refs: parse(row.rationale_refs),
    experiment_scope: parse(row.experiment_scope),
    created_by: row.created_by,
    policy_version_id: policy.versionId,
    policy_hash: policy.hash,
  };
}

export type StrategySubject = ReturnType<typeof strategySubject>;

export const strategySubjectHash = (subject: StrategySubject): string => contentHash(subject);

export interface StrategyApprovalCheck {
  ok: boolean;
  reason: string;
  /** 유효한 승인 행 (없으면 null) */
  approvalId: string | null;
  approvedBy: string | null;
}

/**
 * 활성화 직전 재확인 (A6-U15): 이 전략의 승인이 아직 유효한가. 승인 트랜잭션 밖(주간 사이클)에서 부른다.
 *  - 마지막 승인 기록이 사람(actor.kind='human')의 `approved` 여야 한다 (뒤에 취소·거절 행이 있으면 무효)
 *  - 그 승인의 해시가 지금 내용 + *어떤* 배포된 정책 버전의 해시와 같아야 한다 = 승인 뒤 본문·범위가 바뀌지 않았다.
 *    승인 시점 정책 버전은 승인 해시에 묶여 있으므로 다른 버전으로는 맞지 않는다. 정책이 승인 뒤 바뀐 것만으로는 무효로 하지 않는다:
 *    실험 승인은 내용에 대한 것이고, 마케팅 업무 자체는 만들 때(생성 게이트)와 실행 직전(beforeRun)에 *새* 정책으로 다시 판정된다.
 */
export function verifyStrategyApproval(db: Db, strategyVersionId: string): StrategyApprovalCheck {
  const fail = (reason: string): StrategyApprovalCheck => ({ ok: false, reason, approvalId: null, approvedBy: null });
  const row = db.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [strategyVersionId]);
  if (!row) return fail(`strategy_version '${strategyVersionId}' does not exist`);
  const latest = db.get<{ id: string; decision: string; subject_hash: string | null; decided_by: string; actor_kind: string | null }>(
    `SELECT a.id, a.decision, a.subject_hash, a.decided_by, actor.kind AS actor_kind FROM approval a LEFT JOIN actor ON actor.id = a.decided_by
     WHERE a.subject_kind = 'strategy_version' AND a.subject_id = ? ORDER BY a.at DESC, a.rowid DESC LIMIT 1`,
    [strategyVersionId],
  );
  if (!latest) return fail('no approval recorded');
  if (latest.decision !== 'approved') return fail('the approval was rejected or cancelled');
  if (latest.actor_kind !== 'human') return fail('the approval is not from a human actor');
  const versions = db.all<{ id: string; content_hash: string }>('SELECT id, content_hash FROM policy_version ORDER BY deployed_at, rowid');
  const matches = versions.some((version) => strategySubjectHash(strategySubject(row, { versionId: version.id, hash: version.content_hash })) === latest.subject_hash);
  if (!matches) return fail('the strategy changed since it was approved (approved_hash mismatch); it cannot be activated');
  return { ok: true, reason: `approved by ${latest.decided_by}`, approvalId: latest.id, approvedBy: latest.decided_by };
}

/**
 * 업무의 요청자 (자기 승인 판단용). 생성 전이의 caused_by 가 actor 면 그 actor, 아니면 수동 트리거의 ref
 * (`<actor id>` 또는 `actor:<actor id>`)가 actor 이면 그 actor. 이벤트·루틴 트리거는 요청자가 없다(null).
 */
export function taskRequester(db: Db, task: Pick<TaskRow, 'id' | 'trigger_kind' | 'trigger_ref'>): string | null {
  const creation = db.get<{ caused_by: string }>('SELECT caused_by FROM task_transition WHERE task_id = ? AND from_status IS NULL ORDER BY id LIMIT 1', [task.id]);
  const candidates = [creation?.caused_by];
  if (task.trigger_kind === 'manual') candidates.push(task.trigger_ref, task.trigger_ref.replace(/^actor:/, ''));
  for (const candidate of candidates) {
    if (candidate && db.get('SELECT 1 AS one FROM actor WHERE id = ?', [candidate])) return candidate;
  }
  return null;
}

export class ReauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthError';
  }
}

/**
 * 재인증 기록. 같은 사람의 같은(또는 이전) 시간창 코드는 받지 않는다 — 한 번 쓴 코드의 재사용 거부.
 * 쓰기 트랜잭션 안에서 부른다. 비밀·코드는 남기지 않고 시간창 번호만 남긴다.
 */
export function recordReauth(tx: Db, actorId: string, timeStep: number, purpose: string, now: string): void {
  const last = tx.get<{ step: number | null }>("SELECT max(time_step) AS step FROM human_reauth WHERE actor_id = ? AND method = 'totp'", [actorId]);
  if (last?.step !== null && last?.step !== undefined && timeStep <= Number(last.step)) {
    throw new ReauthError('this TOTP code (or an earlier one) was already used; wait for the next code');
  }
  tx.run("INSERT INTO human_reauth (actor_id, method, time_step, purpose, at) VALUES (?, 'totp', ?, ?, ?)", [actorId, timeStep, purpose, now]);
}
