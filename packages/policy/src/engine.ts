// 승인 엔진 (trust-boundaries §1·§3.1). approval 행은 여기서만 쓴다. 요청은 사람 승인 채널(소켓)로만 들어온다.
//  - 승인·거절·취소·해제(release)는 actor.kind='human' 만. 에이전트 actor 의 요청은 무엇이든 거부한다
//  - 승인은 대상의 정규화 해시에 묶인다. 사람은 `show` 로 본 해시를 `approve` 에 함께 보내고, 그 사이 내용이 바뀌면 거부된다
//  - 외부 부작용(external_effect)과 정책 변경(risky_change): 승인자 수가 차면 cooldown 이 시작되고(대기 중 cancel 가능), 끝난 뒤 `release` 에서
//    TOTP 재인증을 거쳐야 실행(업무 queued, 정책 배포)으로 넘어간다
//  - 그 밖의 require_approval(예: customer 범위 읽기, internal 게시의 confidential 입력)은 사람 1인 승인만 — cooldown·재인증 없음
//  - 자기 승인(요청자 = 승인자)은 risky_change.min_approvers == 1 일 때만 허용, 2 이상이면 금지 (document.ts selfApprovalAllowed)
//  - 정책 배포: 일반 변경은 사람 1인 승인으로 바로 배포, 위험 변경은 **현재** 정책의 risky_change 절차 (ADR-0006 Amendment 2026-10-19)
//  - 실험 전략(strategy_version, A6-U15): 사람 1인 승인(humanApprovalParams, cooldown·재인증 없음, 자기 승인은 min_approvers 규칙). 해시 = 본문 + experiment_scope
//    + 승인 시점 정책 버전. 승인과 같은 트랜잭션에서 `proposed → experiment`(domain 허용표). 진행 중인 실험이 있으면 거부(한 번에 하나).
//    루틴 활성화는 승인 트랜잭션 밖(주간 사이클)이 하며, 활성화 전이면 cancel 로 승인을 무효로 할 수 있다(활성화가 verifyStrategyApproval 로 다시 확인).
//    마케팅 업무의 외부 부작용은 이 승인이 대신하지 않는다 — 그 업무가 기존 업무 승인(위험 변경 절차)을 따로 탄다.
// TOTP 코드·비밀은 응답·로그·DB 어디에도 남기지 않는다.
import { randomUUID } from 'node:crypto';

import {
  checkTransition, contentHash, experimentsInProgress, findExperimentActivation, listStrategyReviews, StrategyRuleError, TASK_MACHINE, transitionStrategyVersion,
  type Clock, type Db, type PublicationRow, type StrategyVersionRow, type TaskRow, type TaskSpec,
} from '@aot/domain';

import {
  approvalStatus, publicationSubject, reauthPurpose, recordReauth, ReauthError, strategySubject, strategySubjectHash, taskRequester, taskSubject, taskSubjectHash,
} from './approval.ts';
import { classifyChange } from './change.ts';
import { humanApprovalParams, riskyApprovalParams, type ParsedPolicy } from './document.ts';
import { evaluateRequest, requestsFromSpec, taskApprovalParams } from './evaluate.ts';
import { PolicyFormatError, type ActivePolicy, type PolicyStore } from './store.ts';
import { TotpSecretError, verifyTotp, type TotpSecretStore } from './totp.ts';

export type ApprovalSubject = 'task' | 'publication' | 'policy_version' | 'strategy_version';

export type ApprovalCommand =
  | { cmd: 'whoami'; actor: string }
  | { cmd: 'list'; actor: string }
  | { cmd: 'show'; actor: string; kind: ApprovalSubject; id: string }
  | { cmd: 'approve'; actor: string; kind: 'task' | 'publication' | 'strategy_version'; id: string; hash: string; comment?: string }
  | { cmd: 'approve'; actor: string; kind: 'policy_version'; policy_text: string; comment?: string }
  | { cmd: 'release'; actor: string; kind: ApprovalSubject; id: string; totp?: string }
  | { cmd: 'cancel'; actor: string; kind: ApprovalSubject; id: string; comment?: string }
  | { cmd: 'reject'; actor: string; kind: ApprovalSubject; id: string; comment?: string };

/** 성공이면 ok: true 와 명령별 값, 거부면 ok: false 와 error */
export interface ApprovalResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRefusedError';
  }
}

export interface ApprovalEngineOptions {
  db: Db;
  clock: Clock;
  store: PolicyStore;
  totp: TotpSecretStore;
  newId?: () => string;
}

const SELF_APPROVAL_RULE = 'self-approval is allowed only when risky_change.min_approvers is 1';

const refuse = (message: string): never => {
  throw new ApprovalRefusedError(message);
};

/** TOTP 연속 실패 제한 (RFC 4226 §7.3) */
export const TOTP_MAX_FAILURES = 5;
export const TOTP_LOCKOUT_MS = 5 * 60_000;

export class ApprovalEngine {
  readonly #o: ApprovalEngineOptions;
  readonly #failures = new Map<string, { count: number; lastMs: number }>();

  constructor(options: ApprovalEngineOptions) {
    this.#o = options;
  }

  /** 소켓에서 받은 요청 하나를 처리한다. 형식이 틀리거나 거부되면 { ok: false, error }. */
  handle(raw: unknown): ApprovalResponse {
    try {
      const command = parseCommand(raw);
      return { ok: true, ...this.#dispatch(command) };
    } catch (error) {
      if (
        error instanceof ApprovalRefusedError || error instanceof ReauthError || error instanceof TotpSecretError || error instanceof PolicyFormatError
        || error instanceof StrategyRuleError
      ) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  #dispatch(c: ApprovalCommand): Record<string, unknown> {
    const { db } = this.#o;
    // 모든 명령의 첫 단계: 사람인지 확인 (인증 단계에서 에이전트를 거부한다)
    requireHuman(db, c.actor);
    switch (c.cmd) {
      case 'whoami':
        return { actor: c.actor, kind: 'human' };
      case 'list':
        return this.#list();
      case 'show':
        return this.#show(c.kind, c.id);
      case 'approve':
        if (c.kind === 'policy_version') return this.#approvePolicy(c.actor, c.policy_text, c.comment);
        if (c.kind === 'strategy_version') return this.#approveStrategy(c.actor, c.id, c.hash, c.comment);
        return c.kind === 'task' ? this.#approveTask(c.actor, c.id, c.hash, c.comment) : this.#approvePublication(c.actor, c.id, c.hash, c.comment);
      case 'release':
        return this.#release(c.actor, c.kind, c.id, c.totp);
      case 'cancel':
        return this.#cancel(c.actor, c.kind, c.id, c.comment);
      case 'reject':
        return this.#reject(c.actor, c.kind, c.id, c.comment);
    }
  }

  #now(): string {
    return this.#o.clock.nowIso();
  }

  #policy(tx: Db): ActivePolicy {
    const active = this.#o.store.active(tx);
    if (!active?.policy) return refuse('the deployed policy content is not available; nothing can be approved (default deny)');
    return active.policy;
  }

  #insertApproval(tx: Db, kind: ApprovalSubject, id: string, decision: 'approved' | 'rejected', hash: string | null, actor: string, comment: string | null): string {
    const approvalId = this.#o.newId?.() ?? `approval-${randomUUID()}`;
    tx.run('INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      approvalId, kind, id, decision, hash, actor, comment === null ? null : comment.slice(0, 500), this.#now(),
    ]);
    return approvalId;
  }

  /**
   * 재인증 (TOTP). 코드가 없거나 틀리거나 이미 쓴 시간창이면 거부.
   * 연속 실패는 제한한다 (RFC 4226 §7.3 throttling, RFC 6238 §5): 사람별 TOTP_MAX_FAILURES 회 연속 실패면
   * TOTP_LOCKOUT_MS 동안 받지 않는다. 기록은 프로세스 메모리에만 둔다(재시작하면 초기화).
   */
  #reauth(tx: Db, actor: string, code: string | undefined, purpose: string): void {
    if (code === undefined || code === '') refuse('a TOTP code is required to release this risky change');
    const nowMs = this.#o.clock.nowMs();
    const failures = this.#failures.get(actor);
    if (failures && failures.count >= TOTP_MAX_FAILURES && nowMs < failures.lastMs + TOTP_LOCKOUT_MS) {
      refuse('too many wrong TOTP codes; try again later');
    }
    const step = verifyTotp(this.#o.totp.secretOf(actor), code!, nowMs);
    if (step === null) {
      const count = failures && nowMs < failures.lastMs + TOTP_LOCKOUT_MS ? failures.count + 1 : 1;
      this.#failures.set(actor, { count, lastMs: nowMs });
      refuse('the TOTP code is not valid');
    }
    this.#failures.delete(actor);
    recordReauth(tx, actor, step!, purpose, this.#now());
  }

  // ===== 업무 =====

  #taskContext(tx: Db, id: string) {
    const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [id]) ?? refuse(`task '${id}' does not exist`);
    const spec = JSON.parse(task.spec) as TaskSpec;
    const policy = this.#policy(tx);
    const requests = requestsFromSpec(spec);
    const verdicts = requests.map((request) => ({ request, verdict: evaluateRequest(policy.document, request) }));
    const subject = taskSubject(task, spec, policy.versionId);
    return { task, spec, policy, verdicts, subject, hash: taskSubjectHash(subject), requester: taskRequester(tx, task), params: taskApprovalParams(policy.document, requests) };
  }

  #approveTask(actor: string, id: string, hash: string, comment?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const ctx = this.#taskContext(tx, id);
      if (ctx.task.status !== 'needs_review') refuse(`task '${id}' is '${ctx.task.status}'; approvals apply to tasks in needs_review`);
      const denied = ctx.verdicts.filter((v) => v.verdict.decision === 'deny');
      if (denied.length > 0) refuse(`the current policy denies this task (${denied.map((v) => v.verdict.reason).join('; ')}); an approval cannot override deny`);
      if (hash !== ctx.hash) refuse('the task changed since it was shown (subject hash mismatch); show it again before approving');
      const params = ctx.params;
      if (!params.self_approval && ctx.requester === actor) refuse(`the requester cannot approve their own task (${SELF_APPROVAL_RULE})`);

      const approvalId = this.#insertApproval(tx, 'task', id, 'approved', ctx.hash, actor, comment ?? null);
      const needsApproval = ctx.verdicts.some((v) => v.verdict.decision === 'require_approval');
      const snapshot = JSON.stringify(ctx.subject);
      if (!needsApproval) {
        this.#queue(tx, ctx.task, actor, approvalId, { approval_id: approvalId, approved_snapshot: snapshot, approved_hash: ctx.hash }, 'approved by a human (no risky change)');
        return { state: 'queued', approval_id: approvalId, hash: ctx.hash };
      }
      const status = approvalStatus(tx, { kind: 'task', id, hash: ctx.hash, requesterId: ctx.requester, params, now: this.#now() });
      if (status.quorumApprovalId !== null) {
        tx.run('UPDATE task SET approval_id = ?, approved_snapshot = ?, approved_hash = ?, updated_at = ? WHERE id = ?', [
          status.quorumApprovalId, snapshot, ctx.hash, this.#now(), id,
        ]);
      }
      if (status.ok) {
        this.#queue(tx, ctx.task, actor, status.quorumApprovalId!, {}, 'approved; no cooldown or re-authentication applies (no external effect or the policy sets none)');
        return { state: 'queued', approval_id: approvalId, hash: ctx.hash };
      }
      return { state: status.state, reason: status.reason, approval_id: approvalId, hash: ctx.hash, cooldown_ends_at: status.cooldownEndsAt };
    });
  }

  #queue(tx: Db, task: TaskRow, actor: string, approvalId: string, set: Record<string, string>, reason: string): void {
    assertAllowed('needs_review', 'queued', approvalId);
    const changed = tx.run(
      `UPDATE task SET status = 'queued', updated_at = ?${Object.keys(set).map((k) => `, ${k} = ?`).join('')} WHERE id = ? AND status = 'needs_review'`,
      [this.#now(), ...Object.values(set), task.id],
    );
    if (changed.changes !== 1) refuse(`task '${task.id}' is no longer in needs_review`);
    tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
      task.id, 'needs_review', 'queued', `${reason} (approval ${approvalId})`, actor, this.#now(),
    ]);
  }

  #releaseTask(tx: Db, actor: string, id: string, code: string | undefined): Record<string, unknown> {
    const ctx = this.#taskContext(tx, id);
    if (ctx.task.status !== 'needs_review') refuse(`task '${id}' is '${ctx.task.status}'; only an approved task in needs_review can be released`);
    if (ctx.task.approved_hash === null) refuse(`task '${id}' has no approval to release`);
    if (ctx.task.approved_hash !== ctx.hash) refuse('the task or the policy changed since approval (approved_hash mismatch); re-approval required');
    const params = ctx.params;
    const status = approvalStatus(tx, { kind: 'task', id, hash: ctx.hash, requesterId: ctx.requester, params, now: this.#now(), checkReauth: false });
    if (!status.ok) refuse(status.reason);
    if (params.reauth_before_effect) this.#reauth(tx, actor, code, reauthPurpose('task', id, ctx.hash));
    this.#queue(tx, ctx.task, actor, ctx.task.approval_id ?? status.quorumApprovalId!, {}, 'released after the cooldown and human re-authentication');
    return { state: 'queued' };
  }

  // ===== 게시 =====

  #publication(tx: Db, id: string) {
    const row = tx.get<PublicationRow>('SELECT * FROM publication WHERE id = ?', [id]) ?? refuse(`publication '${id}' does not exist`);
    const policy = this.#policy(tx);
    const subject = publicationSubject(row, policy.versionId);
    const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [row.task_id]);
    // 외부 대상(customer/public) 게시는 외부 부작용이므로 위험 변경 절차, internal 게시(confidential 입력 승인 등)는 사람 1인 승인
    const params = row.audience === 'internal' ? humanApprovalParams(policy.document) : riskyApprovalParams(policy.document);
    return { row, policy, subject, hash: contentHash(subject), requester: task ? taskRequester(tx, task) : null, params };
  }

  #approvePublication(actor: string, id: string, hash: string, comment?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const ctx = this.#publication(tx, id);
      if (ctx.row.status !== 'draft' && ctx.row.status !== 'pending_approval') refuse(`publication '${id}' is '${ctx.row.status}'`);
      if (hash !== ctx.hash) refuse('the publication changed since it was shown (subject hash mismatch); show it again before approving');
      const params = ctx.params;
      if (!params.self_approval && ctx.requester === actor) refuse(`the requester cannot approve their own publication (${SELF_APPROVAL_RULE})`);
      const approvalId = this.#insertApproval(tx, 'publication', id, 'approved', ctx.hash, actor, comment ?? null);
      if (ctx.row.status === 'draft') tx.run("UPDATE publication SET status = 'pending_approval' WHERE id = ? AND status = 'draft'", [id]);
      const status = approvalStatus(tx, { kind: 'publication', id, hash: ctx.hash, requesterId: ctx.requester, params, now: this.#now() });
      return { state: status.state, reason: status.reason, approval_id: approvalId, hash: ctx.hash, cooldown_ends_at: status.cooldownEndsAt };
    });
  }

  #releasePublication(tx: Db, actor: string, id: string, code: string | undefined): Record<string, unknown> {
    const ctx = this.#publication(tx, id);
    const params = ctx.params;
    const status = approvalStatus(tx, { kind: 'publication', id, hash: ctx.hash, requesterId: ctx.requester, params, now: this.#now(), checkReauth: false });
    if (!status.ok) refuse(status.reason);
    if (params.reauth_before_effect) this.#reauth(tx, actor, code, reauthPurpose('publication', id, ctx.hash));
    return { state: 'released', note: 'the publication gate may now publish it' };
  }

  // ===== 실험 전략 (A6-U15) =====

  #strategy(tx: Db, id: string) {
    const row = tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [id]) ?? refuse(`strategy_version '${id}' does not exist`);
    const policy = this.#policy(tx);
    const subject = strategySubject(row, policy);
    // 요청자 = 제안자(created_by). 보통 기획 run 의 에이전트라 사람 승인자와 겹치지 않지만, 사람이 낸 제안이면 자기 승인 규칙이 적용된다.
    return { row, policy, subject, hash: strategySubjectHash(subject), requester: row.created_by, params: humanApprovalParams(policy.document) };
  }

  #approveStrategy(actor: string, id: string, hash: string, comment?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const ctx = this.#strategy(tx, id);
      if (ctx.row.status !== 'proposed') refuse(`strategy_version '${id}' is '${ctx.row.status}'; only a proposed strategy can be approved`);
      if (hash !== ctx.hash) refuse('the strategy changed since it was shown (subject hash mismatch); show it again before approving');
      const running = experimentsInProgress(tx).filter((other) => other !== id);
      if (running.length > 0) refuse(`an experiment is already in progress (${running.join(', ')}); approve the next one after it ends`);
      if (!ctx.params.self_approval && ctx.requester === actor) refuse(`the proposer cannot approve their own strategy (${SELF_APPROVAL_RULE})`);
      const approvalId = this.#insertApproval(tx, 'strategy_version', id, 'approved', ctx.hash, actor, comment ?? null);
      const status = approvalStatus(tx, { kind: 'strategy_version', id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now() });
      if (!status.ok) refuse(status.reason); // 사람 1인·cooldown 0·재인증 없음이라 여기서는 항상 ok 다 (방어)
      transitionStrategyVersion(tx, {
        strategyVersionId: id, from: 'proposed', to: 'experiment', by: 'human', actorId: actor, approvalId,
        reason: `approved by a human (approval ${approvalId})`,
      });
      return { state: 'experiment', approval_id: approvalId, hash: ctx.hash, note: 'the experiment routine is activated by the weekly cycle (outside this transaction)' };
    });
  }

  /** 활성화 전 취소: 승인을 무효로 한다(뒤에 rejected 행). 활성화가 승인을 다시 확인하므로 켜지지 않는다. 이미 켜진 실험은 취소가 아니라 종료한다 */
  #cancelStrategy(tx: Db, actor: string, id: string, comment?: string): Record<string, unknown> {
    const row = tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [id]) ?? refuse(`strategy_version '${id}' does not exist`);
    if (row.status !== 'proposed' && row.status !== 'experiment') refuse(`strategy_version '${id}' is '${row.status}'; nothing is waiting to be cancelled`);
    if (findExperimentActivation(tx, id) !== null) refuse(`the experiment '${id}' is already active; end it instead of cancelling the approval`);
    const approvalId = this.#insertApproval(tx, 'strategy_version', id, 'rejected', null, actor, `cancelled${comment ? `: ${comment}` : ''}`);
    return { state: 'cancelled', approval_id: approvalId, status: row.status };
  }

  #rejectStrategy(tx: Db, actor: string, id: string, comment?: string): Record<string, unknown> {
    const row = tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [id]) ?? refuse(`strategy_version '${id}' does not exist`);
    if (row.status !== 'proposed') refuse(`strategy_version '${id}' is '${row.status}'; only a proposed strategy can be rejected`);
    const approvalId = this.#insertApproval(tx, 'strategy_version', id, 'rejected', null, actor, comment ?? 'rejected');
    transitionStrategyVersion(tx, { strategyVersionId: id, from: 'proposed', to: 'rejected', by: 'human', actorId: actor, reason: `rejected by a human (approval ${approvalId})` });
    return { state: 'rejected', approval_id: approvalId };
  }

  // ===== 정책 배포 =====

  #approvePolicy(actor: string, text: string, comment?: string): Record<string, unknown> {
    if (typeof text !== 'string' || text.length > 256 * 1024) refuse('policy_text must be a YAML document of at most 256 KiB');
    const parsed = this.#o.store.archive(text);
    return this.#o.db.writeTx((tx) => {
      const current = this.#policy(tx);
      if (parsed.hash === current.hash) refuse(`this content is already the deployed policy (${current.versionId})`);
      const change = classifyChange(current.document, parsed.document);
      const note = [`change_class=${change.changeClass}`, ...change.reasons, ...(comment ? [comment] : [])].join('; ');
      const approvalId = this.#insertApproval(tx, 'policy_version', parsed.versionId, 'approved', parsed.hash, actor, note);
      const base = { id: parsed.versionId, hash: parsed.hash, change_class: change.changeClass, reasons: change.reasons, approval_id: approvalId };
      if (change.changeClass === 'normal') return { ...base, state: 'deployed', version_id: this.#deploy(tx, parsed, 'normal', [actor]) };
      // 위험 변경은 현재(변경 전) 정책의 risky_change 로 승인한다. 새 정책의 값으로 자기 자신을 승인할 수 없다.
      const status = approvalStatus(tx, { kind: 'policy_version', id: parsed.versionId, hash: parsed.hash, requesterId: null, params: riskyApprovalParams(current.document), now: this.#now() });
      if (status.ok) return { ...base, state: 'deployed', version_id: this.#deploy(tx, parsed, 'risky', status.approvers) };
      return { ...base, state: status.state, reason: status.reason, cooldown_ends_at: status.cooldownEndsAt };
    });
  }

  #releasePolicy(tx: Db, actor: string, id: string, code: string | undefined): Record<string, unknown> {
    const latest = tx.get<{ subject_hash: string | null; decision: string }>(
      "SELECT subject_hash, decision FROM approval WHERE subject_kind = 'policy_version' AND subject_id = ? ORDER BY at DESC, rowid DESC LIMIT 1", [id],
    ) ?? refuse(`no policy proposal '${id}'`);
    if (latest.decision !== 'approved' || latest.subject_hash === null) refuse(`policy proposal '${id}' was rejected or cancelled`);
    const parsed = this.#o.store.byHash(latest.subject_hash!) ?? refuse(`the content of policy proposal '${id}' is not in the policy store`);
    const current = this.#policy(tx);
    if (parsed.hash === current.hash) refuse(`policy proposal '${id}' is already deployed`);
    const change = classifyChange(current.document, parsed.document);
    if (change.changeClass === 'normal') return { state: 'deployed', change_class: 'normal', version_id: this.#deploy(tx, parsed, 'normal', [actor]) };
    const params = riskyApprovalParams(current.document);
    const status = approvalStatus(tx, { kind: 'policy_version', id, hash: parsed.hash, requesterId: null, params, now: this.#now(), checkReauth: false });
    if (!status.ok) refuse(status.reason);
    if (params.reauth_before_effect) this.#reauth(tx, actor, code, reauthPurpose('policy_version', id, parsed.hash));
    return { state: 'deployed', change_class: 'risky', reasons: change.reasons, version_id: this.#deploy(tx, parsed, 'risky', status.approvers) };
  }

  /** policy_version 행 추가 = 배포. 같은 내용을 다시 배포하면(되돌리기) id 뒤에 번호를 붙인다. */
  #deploy(tx: Db, parsed: ParsedPolicy, changeClass: 'normal' | 'risky', approvers: string[]): string {
    let id = parsed.versionId;
    for (let n = 2; tx.get('SELECT 1 AS one FROM policy_version WHERE id = ?', [id]); n += 1) id = `${parsed.versionId}.${n}`;
    tx.run('INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at, rollback_of) VALUES (?, ?, ?, ?, ?, NULL)', [
      id, parsed.hash, changeClass, JSON.stringify(approvers), this.#now(),
    ]);
    return id;
  }

  // ===== 공통 명령 =====

  #release(actor: string, kind: ApprovalSubject, id: string, code: string | undefined): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      if (kind === 'task') return this.#releaseTask(tx, actor, id, code);
      if (kind === 'publication') return this.#releasePublication(tx, actor, id, code);
      if (kind === 'strategy_version') refuse('a strategy needs no release: one human approval moves it to experiment (no cooldown or re-authentication)');
      return this.#releasePolicy(tx, actor, id, code);
    });
  }

  /** 대기 중 취소: 승인을 무효로 한다(뒤에 rejected 행). 해제된 뒤 아직 실행 전(queued)인 업무는 needs_review 로 되돌린다. */
  #cancel(actor: string, kind: ApprovalSubject, id: string, comment?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const now = this.#now();
      if (kind === 'strategy_version') return this.#cancelStrategy(tx, actor, id, comment);
      if (kind === 'task') {
        const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [id]) ?? refuse(`task '${id}' does not exist`);
        if (task.status !== 'needs_review' && task.status !== 'queued') refuse(`task '${id}' is '${task.status}'; only a task that has not started can be cancelled`);
        const approvalId = this.#insertApproval(tx, 'task', id, 'rejected', task.approved_hash, actor, `cancelled${comment ? `: ${comment}` : ''}`);
        if (task.status === 'queued') {
          assertAllowed('queued', 'needs_review', approvalId, 'policy');
          tx.run("UPDATE task SET status = 'needs_review', updated_at = ? WHERE id = ? AND status = 'queued'", [now, id]);
          tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
            id, 'queued', 'needs_review', `approval cancelled by ${actor} before the run`, 'system:policy', now,
          ]);
        }
        return { state: 'cancelled', approval_id: approvalId };
      }
      const approvalId = this.#insertApproval(tx, kind, id, 'rejected', null, actor, `cancelled${comment ? `: ${comment}` : ''}`);
      return { state: 'cancelled', approval_id: approvalId };
    });
  }

  #reject(actor: string, kind: ApprovalSubject, id: string, comment?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      if (kind === 'strategy_version') return this.#rejectStrategy(tx, actor, id, comment);
      if (kind !== 'task') return { state: 'rejected', approval_id: this.#insertApproval(tx, kind, id, 'rejected', null, actor, comment ?? 'rejected') };
      const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [id]) ?? refuse(`task '${id}' does not exist`);
      if (task.status !== 'needs_review') refuse(`task '${id}' is '${task.status}'; only a task in needs_review can be rejected`);
      const approvalId = this.#insertApproval(tx, 'task', id, 'rejected', task.approved_hash, actor, comment ?? 'rejected');
      assertAllowed('needs_review', 'failed', approvalId);
      tx.run("UPDATE task SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'needs_review'", [this.#now(), id]);
      tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
        id, 'needs_review', 'failed', `rejected by a human (approval ${approvalId})`, actor, this.#now(),
      ]);
      return { state: 'failed', approval_id: approvalId };
    });
  }

  #show(kind: ApprovalSubject, id: string): Record<string, unknown> {
    const { db } = this.#o;
    if (kind === 'task') {
      const ctx = this.#taskContext(db, id);
      const status = approvalStatus(db, { kind: 'task', id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now() });
      return {
        kind, id, status: ctx.task.status, hash: ctx.hash, subject: ctx.subject, policy_version: ctx.policy.versionId,
        decisions: ctx.verdicts.map((v) => ({ action: v.request.action, resource: v.request.resource, scope: v.request.scope, impact: v.request.impact, decision: v.verdict.decision, reason: v.verdict.reason })),
        approval: { state: status.state, reason: status.reason, approvers: status.approvers, cooldown_ends_at: status.cooldownEndsAt },
      };
    }
    if (kind === 'publication') {
      const ctx = this.#publication(db, id);
      const status = approvalStatus(db, { kind, id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now() });
      return { kind, id, status: ctx.row.status, hash: ctx.hash, subject: ctx.subject, approval: { state: status.state, reason: status.reason, cooldown_ends_at: status.cooldownEndsAt } };
    }
    if (kind === 'strategy_version') {
      const ctx = this.#strategy(db, id);
      const status = approvalStatus(db, { kind, id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now() });
      const activation = findExperimentActivation(db, id);
      return {
        kind, id, status: ctx.row.status, hash: ctx.hash, subject: ctx.subject, policy_version: ctx.policy.versionId,
        experiments_in_progress: experimentsInProgress(db).filter((other) => other !== id),
        activation: activation === null ? null : { at: activation.activatedAt, routine_ids: activation.routineIds, task_ids: activation.taskIds },
        approval: { state: status.state, reason: status.reason, approvers: status.approvers },
      };
    }
    const latest = db.get<{ subject_hash: string | null }>(
      "SELECT subject_hash FROM approval WHERE subject_kind = 'policy_version' AND subject_id = ? AND decision = 'approved' ORDER BY at DESC, rowid DESC LIMIT 1", [id],
    ) ?? refuse(`no policy proposal '${id}'`);
    const parsed = this.#o.store.byHash(latest.subject_hash ?? '') ?? refuse(`the content of policy proposal '${id}' is not in the policy store`);
    const current = this.#policy(db);
    const change = classifyChange(current.document, parsed.document);
    const status = approvalStatus(db, { kind, id, hash: parsed.hash, requesterId: null, params: riskyApprovalParams(current.document), now: this.#now() });
    return { kind, id, hash: parsed.hash, change_class: change.changeClass, reasons: change.reasons, approval: { state: status.state, reason: status.reason, cooldown_ends_at: status.cooldownEndsAt } };
  }

  #list(): Record<string, unknown> {
    const { db } = this.#o;
    const tasks = db.all<{ id: string; objective: string; reason: string | null }>(
      `SELECT t.id, t.objective, (SELECT reason FROM task_transition x WHERE x.task_id = t.id ORDER BY x.id DESC LIMIT 1) AS reason
       FROM task t WHERE t.status = 'needs_review' ORDER BY t.updated_at, t.id`,
    );
    const publications = db.all<{ id: string; audience: string; status: string }>(
      "SELECT id, audience, status FROM publication WHERE status IN ('draft', 'pending_approval') ORDER BY id",
    );
    const policies = db.all<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM approval a WHERE subject_kind = 'policy_version'
         AND NOT EXISTS (SELECT 1 FROM policy_version p WHERE p.content_hash = a.subject_hash) ORDER BY subject_id`,
    );
    // 실험 전략 (A6-U15): 승인을 기다리는 제안, 추천 없이 끝나 사람이 볼 비교 기록(listStrategyReviews), 진행 중인 실험과 활성화 여부
    const strategies = db.all<{ id: string; title: string; created_at: string }>("SELECT id, title, created_at FROM strategy_version WHERE status = 'proposed' ORDER BY created_at, rowid");
    const reviews = listStrategyReviews(db).map((review) => ({ planning_task_id: review.planningTaskId, outcome: review.outcome, reasons: review.reasons, recorded_at: review.recordedAt }));
    const experiments = experimentsInProgress(db).map((id) => {
      const activation = findExperimentActivation(db, id);
      return { id, activated_at: activation?.activatedAt ?? null };
    });
    return { tasks, publications, policy_proposals: policies.map((p) => p.subject_id), strategy_proposals: strategies, strategy_reviews: reviews, experiments };
  }
}

function requireHuman(db: Db, actorId: unknown): void {
  if (typeof actorId !== 'string' || actorId === '') refuse('an actor id is required');
  const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId as string]);
  if (!actor) refuse(`unknown actor '${String(actorId)}'`);
  if (actor!.kind !== 'human') refuse(`only human actors can use the approval channel; '${String(actorId)}' is '${actor!.kind}'`);
}

function assertAllowed(from: 'needs_review' | 'queued', to: 'queued' | 'needs_review' | 'failed', approvalId: string, by: 'human' | 'policy' = 'human'): void {
  const check = checkTransition(TASK_MACHINE, { from, to, by, approvalId, reason: 'approval channel' });
  if (!check.ok) refuse(check.message);
}

const SUBJECTS: readonly string[] = ['task', 'publication', 'policy_version', 'strategy_version'];
const CMDS: readonly string[] = ['whoami', 'list', 'show', 'approve', 'release', 'cancel', 'reject'];

function parseCommand(raw: unknown): ApprovalCommand {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('a request must be a JSON object');
  const c = raw as Record<string, unknown>;
  if (typeof c['cmd'] !== 'string' || !CMDS.includes(c['cmd'])) refuse(`cmd must be one of ${CMDS.join('|')}`);
  if (typeof c['actor'] !== 'string') refuse('actor is required');
  const cmd = c['cmd'] as ApprovalCommand['cmd'];
  if (cmd === 'whoami' || cmd === 'list') return { cmd, actor: c['actor'] as string };
  if (typeof c['kind'] !== 'string' || !SUBJECTS.includes(c['kind'])) refuse(`kind must be one of ${SUBJECTS.join('|')}`);
  const kind = c['kind'] as ApprovalSubject;
  const optional = (key: string): { [k: string]: string } => (typeof c[key] === 'string' ? { [key]: c[key] as string } : {});
  if (cmd === 'approve' && kind === 'policy_version') {
    if (typeof c['policy_text'] !== 'string') refuse('policy_text is required');
    return { cmd, actor: c['actor'] as string, kind, policy_text: c['policy_text'] as string, ...optional('comment') };
  }
  if (typeof c['id'] !== 'string' || c['id'] === '') refuse('id is required');
  const id = c['id'] as string;
  if (cmd === 'approve') {
    if (typeof c['hash'] !== 'string') refuse('hash is required (from `show`)');
    return { cmd, actor: c['actor'] as string, kind: kind as 'task' | 'publication' | 'strategy_version', id, hash: c['hash'] as string, ...optional('comment') };
  }
  if (cmd === 'release') return { cmd, actor: c['actor'] as string, kind, id, ...optional('totp') };
  if (cmd === 'show') return { cmd, actor: c['actor'] as string, kind, id };
  return { cmd, actor: c['actor'] as string, kind, id, ...optional('comment') };
}
