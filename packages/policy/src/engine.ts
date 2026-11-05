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
//  - 초안 승인 업무(ADR-0015): 업무 승인 대상 해시가 제안된 초안(`effect_draft` proposed)을 묶는다. `show` 가 초안 본문과 해시를 보여 주고, 승인·해제는 만료된 초안이 있으면 거부한다.
//    `reject` 는 초안을 `rejected` 로, 새 명령 `request_changes` 는 승인 행(`changes_requested`)을 남기고 초안을 `superseded` 로 만든 뒤 업무를 다시 큐에 넣는다(초안을 다시 쓰게 한다).
//  - 거부 응답은 `{ ok:false, error, code? }` 다. `code` 는 기계가 읽는 사유(RefusalCode)이고 `error` 는 사람이 읽는 영어 문장이다 (검토 화면이 코드로 안내를 고른다)
//  - 낡은 결정 막기: `approve` 는 `hash` 를, `reject`·`cancel`·`request_changes`·`release` 는 선택 필드 `expected_hash` 를 지금 대상 해시와 대조한다 (없으면 대조하지 않는다).
//    `via`('cli'|'web', 자기 신고 값)는 승인 행에 감사용으로 남는다
//  - 결정 위임(ADR-0016, 제안 — 오너 결정 D-B1): 정책이 `delegation.mandates` 를 선언했을 때만, 위임 보유자(AI)가 프로세스 안 메서드 `delegateDecide` 로 초안 승인 업무를 승인·다시 쓰게·사람에게
//    넘긴다. 소켓 명령이 아니다(`CMDS` 에 없다) — 소켓은 계속 사람 전용이다. 적격(delegation.ts)을 같은 트랜잭션에서 다시 확인하고, 위임 승인은 `show` 해시(초안 포함)에 묶인다.
//    cooldown 뒤 `releaseDelegated`(데몬 주기)가 `needs_review → queued` 로 넘긴다. 사람 명령 `delegation status|pause|resume|revoke` 로 멈추고(resume 은 TOTP), 사람이 위임 승인을 취소하면 그 위임은 자동 정지된다
// TOTP 코드·비밀은 응답·로그·DB 어디에도 남기지 않는다.
import { randomUUID } from 'node:crypto';

import {
  activeOrgVersion, APPROVAL_DELEGATE, checkTransition, contentHash, ensureApprovalDelegate, experimentsInProgress, findExperimentActivation, getOrgProposal, listStrategyReviews, OrgRuleError, StrategyRuleError, TASK_MACHINE,
  draftSendStates, maskedPathsOf, maskSecretKeys, proposedDraftsOf, transitionDrafts, transitionOrgProposal, transitionStrategyVersion,
  type Clock, type Db, type DelegationControlRow, type DraftSendState, type EffectDraftRow, type OrgProposalRow, type PublicationRow, type StrategyVersionRow, type TaskRow, type TaskSpec,
} from '@aot/domain';

import {
  approvalStatus, publicationSubject, reauthPurpose, recordReauth, ReauthError, strategySubject, strategySubjectHash, taskRequester, taskSubject, taskSubjectHash, type ApprovalState, type DelegationAuthority, type TaskSubject,
} from './approval.ts';
import { classifyChange } from './change.ts';
import {
  delegationAuthority, delegationEligibility, DELEGATION_WINDOW_MS, mandatesOf, mandateStop, MAX_DELEGATE_REASON_CHARS, readDelegationControls, rewritesUsed,
  type Eligibility, type EligibilityCode,
} from './delegation.ts';
import { DELEGATION_MAX_DAYS, humanApprovalParams, mandateExpiresAt, riskyApprovalParams, type ApprovalParams, type Mandate, type ParsedPolicy, type PolicyDocument } from './document.ts';
import { evaluateRequest, requestsFromSpec, taskApprovalParams, type PolicyRequest, type PolicyVerdict } from './evaluate.ts';
import { PolicyFormatError, type ActivePolicy, type PolicyStore } from './store.ts';
import { TotpSecretError, verifyTotp, type TotpSecretStore } from './totp.ts';

export type ApprovalSubject = 'task' | 'publication' | 'policy_version' | 'strategy_version' | 'org_proposal';

/** 결정 경로 (자기 신고 값, 감사용). 소켓 요청이 실을 수 있는 값은 cli·web 뿐이다 — `delegate` 는 위임 승인 행에 엔진이 직접 적는다 */
export type DecisionVia = 'cli' | 'web';
export const DECISION_VIA: readonly DecisionVia[] = ['cli', 'web'];

/** 공통 선택 필드: `via` 와, 낡은 결정 막기용 `expected_hash`(reject·cancel·request_changes·release) */
interface Common {
  via?: DecisionVia;
}
interface Expecting extends Common {
  /** `show` 가 보여 준 해시. 있으면 지금 대상 해시와 다를 때 거부한다 (hash_mismatch) */
  expected_hash?: string;
}

export type ApprovalCommand =
  | ({ cmd: 'whoami'; actor: string } & Common)
  | ({ cmd: 'list'; actor: string } & Common)
  | ({ cmd: 'show'; actor: string; kind: ApprovalSubject; id: string } & Common)
  | ({ cmd: 'approve'; actor: string; kind: 'task' | 'publication' | 'strategy_version' | 'org_proposal'; id: string; hash: string; comment?: string } & Common)
  | ({ cmd: 'approve'; actor: string; kind: 'policy_version'; policy_text: string; comment?: string } & Common)
  | ({ cmd: 'release'; actor: string; kind: ApprovalSubject; id: string; totp?: string } & Expecting)
  | ({ cmd: 'cancel'; actor: string; kind: ApprovalSubject; id: string; comment?: string } & Expecting)
  | ({ cmd: 'reject'; actor: string; kind: ApprovalSubject; id: string; comment?: string } & Expecting)
  /** 초안 승인 업무의 변경 요청 (ADR-0015): 초안을 버리고 다시 쓰게 한다. 사유(comment)는 필수(1~500자) */
  | ({ cmd: 'request_changes'; actor: string; kind: 'task'; id: string; comment: string } & Expecting)
  /** 위임 관리 (ADR-0016, 제안). 사람만. pause·revoke 는 강화라 TOTP 없이, resume 은 TOTP. mandate_id 가 없으면 pause·resume 은 전체, revoke 는 지금 정책의 모든 위임 */
  | ({ cmd: 'delegation'; actor: string; op: 'status' | 'pause' | 'resume' | 'revoke'; mandate_id?: string; comment?: string; totp?: string } & Common);

/** 거부 사유 코드 (공유 계약 §5). 검토 화면이 안내를 고르는 데 쓴다 */
export const REFUSAL_CODES = [
  'hash_mismatch', 'wrong_state', 'send_started', 'masked', 'expired', 'policy_denied', 'self_approval', 'cooldown',
  'reauth_required', 'reauth_failed', 'reauth_locked', 'not_human', 'bad_request',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** 성공이면 ok: true 와 명령별 값, 거부면 ok: false 와 error(사람이 읽는 영어 문장)와 code(기계가 읽는 사유, 없을 수 있다) */
export interface ApprovalResponse {
  ok: boolean;
  error?: string;
  code?: RefusalCode;
  [key: string]: unknown;
}

export class ApprovalRefusedError extends Error {
  readonly code: RefusalCode | undefined;

  constructor(message: string, code?: RefusalCode) {
    super(message);
    this.name = 'ApprovalRefusedError';
    this.code = code;
  }
}

/** 재인증 거부 사유 코드: 코드 없음 / 연속 실패 잠금 / 틀린 코드. 메시지는 release 와 같다 */
export type ReauthRefusalCode = 'reauth_required' | 'reauth_locked' | 'reauth_failed';

/** `ApprovalRefusedError` 이면서 사유 코드를 가진다 (release 의 응답은 `error` 메시지와 같은 `code` 를 함께 돌려준다) */
export class ReauthRefusedError extends ApprovalRefusedError {
  declare readonly code: ReauthRefusalCode;

  constructor(code: ReauthRefusalCode, message: string) {
    super(message, code);
    this.name = 'ReauthRefusedError';
  }
}

/** 업무 승인 대상의 문맥: `show`·승인·해제·위임 적격이 모두 같은 값을 본다 */
interface TaskApprovalContext {
  task: TaskRow;
  spec: TaskSpec;
  policy: ActivePolicy;
  document: PolicyDocument;
  verdicts: Array<{ request: PolicyRequest; verdict: PolicyVerdict }>;
  drafts: EffectDraftRow[];
  sendStates: Map<string, DraftSendState>;
  masked: Map<string, string[]>;
  subject: TaskSubject;
  hash: string;
  requester: string | null;
  params: ApprovalParams;
  authority: DelegationAuthority | null;
}

export type DelegateVerdict = 'approve' | 'request_changes' | 'escalate';
const DELEGATE_VERDICTS: readonly string[] = ['approve', 'request_changes', 'escalate'];

/** 위임 보유자(AI)의 결정 (프로세스 안 호출 전용, 소켓 명령이 아니다). hash 는 AI 가 본 대상 해시(초안 포함)다 */
export interface DelegateDecision {
  task_id: string;
  hash: string;
  verdict: DelegateVerdict;
  /** 사유 (200자 이내로 잘린다). 승인 행의 comment 와 검토 기록에 남는다 */
  reason: string;
  /** 이 검토에 든 AI 비용 (위임의 하루 검토 비용 한도에 센다) */
  cost_usd?: number;
}

export type DelegateDecideResult =
  | { ok: true; recorded: 'approved' | 'changes_requested' | 'escalated'; mandate_id: string; approval_id?: string; state?: ApprovalState; cooldown_ends_at?: string | null }
  | { ok: false; code: EligibilityCode | 'hash_mismatch' | 'rewrite_limit' | 'bad_request'; error: string };

/** AI 에게 줄 자료: 위임 기준과 한도, 초안(가린 값은 이미 없다 — 적격 조건), 이 업무의 앞선 결정. 외부 데이터 영역으로 취급한다 */
export interface DelegationReviewMaterial {
  objective: string;
  mandate: { id: string; guidance: string; limits: Mandate['limits'] };
  drafts: Array<{ id: string; tool: string; action: string; target: string; payload: unknown }>;
  history: Array<{ decision: string; by: string; comment: string | null }>;
}

export interface DelegationScanEntry {
  taskId: string;
  /** 지금 대상 해시 (`show` 의 hash 와 같다) */
  hash: string;
  eligibility: Eligibility;
  /** 적격일 때만 */
  review: DelegationReviewMaterial | null;
}

export interface ApprovalEngineOptions {
  db: Db;
  clock: Clock;
  store: PolicyStore;
  totp: TotpSecretStore;
  newId?: () => string;
  /**
   * 초안 payload 를 *표시용으로* 가리는 함수 (agent-runtime 의 `maskSecrets`; 이 패키지는 agent-runtime 을 참조하지 않아 데몬이 주입한다). 없으면 키 이름만 가리는 기본값(`maskSecretKeys`). 가려지는 값이 있는
   * 초안은 사람이 모든 바이트를 보고 승인할 수 없으므로 `show` 가 알리고 승인·해제를 거부한다 (ADR-0015).
   */
  maskPayload?: (payload: unknown) => unknown;
}

const SELF_APPROVAL_RULE = 'self-approval is allowed only when risky_change.min_approvers is 1';

const refuse = (message: string, code?: RefusalCode): never => {
  throw new ApprovalRefusedError(message, code);
};

/** 승인 계산 상태 → 거부 코드 (release 가 `status.ok` 가 아닐 때) */
const STATE_CODES: Readonly<Record<ApprovalState, RefusalCode>> = {
  approved: 'wrong_state', missing: 'wrong_state', insufficient: 'wrong_state', hash_mismatch: 'hash_mismatch', self_approval: 'self_approval',
  revoked: 'wrong_state', cooldown: 'cooldown', reauth_required: 'reauth_required',
};

const refuseReauth = (code: ReauthRefusalCode, message: string): never => {
  throw new ReauthRefusedError(code, message);
};

/** TOTP 연속 실패 제한 (RFC 4226 §7.3) */
export const TOTP_MAX_FAILURES = 5;
export const TOTP_LOCKOUT_MS = 5 * 60_000;

export class ApprovalEngine {
  readonly #o: ApprovalEngineOptions;
  readonly #failures = new Map<string, { count: number; lastMs: number }>();
  /** 지금 처리 중인 소켓 요청이 자기 신고한 결정 경로 (동기 처리라 겹치지 않는다). 승인 행의 `via` 에 남는다 */
  #via: DecisionVia | null = null;

  constructor(options: ApprovalEngineOptions) {
    this.#o = options;
  }

  /** 소켓에서 받은 요청 하나를 처리한다. 형식이 틀리거나 거부되면 { ok: false, error, code? }. */
  handle(raw: unknown): ApprovalResponse {
    try {
      const command = parseCommand(raw);
      this.#via = command.via ?? null;
      try {
        return { ok: true, ...this.#dispatch(command) };
      } finally {
        this.#via = null;
      }
    } catch (error) {
      if (error instanceof ApprovalRefusedError) return { ok: false, error: error.message, ...(error.code === undefined ? {} : { code: error.code }) };
      if (error instanceof ReauthError || error instanceof TotpSecretError) return { ok: false, error: error.message, code: 'reauth_failed' };
      if (error instanceof PolicyFormatError) return { ok: false, error: error.message, code: 'bad_request' };
      if (error instanceof StrategyRuleError || error instanceof OrgRuleError) return { ok: false, error: error.message, code: 'wrong_state' };
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
        if (c.kind === 'org_proposal') return this.#approveOrg(c.actor, c.id, c.hash, c.comment);
        return c.kind === 'task' ? this.#approveTask(c.actor, c.id, c.hash, c.comment) : this.#approvePublication(c.actor, c.id, c.hash, c.comment);
      case 'release':
        return this.#release(c.actor, c.kind, c.id, c.totp, c.expected_hash);
      case 'cancel':
        return this.#cancel(c.actor, c.kind, c.id, c.comment, c.expected_hash);
      case 'reject':
        return this.#reject(c.actor, c.kind, c.id, c.comment, c.expected_hash);
      case 'request_changes':
        return this.#requestChanges(c.actor, c.id, c.comment, c.expected_hash);
      case 'delegation':
        return this.#delegation(c);
    }
  }

  #now(): string {
    return this.#o.clock.nowIso();
  }

  #policy(tx: Db): ActivePolicy {
    const active = this.#o.store.active(tx);
    if (!active?.policy) return refuse('the deployed policy content is not available; nothing can be approved (default deny)', 'policy_denied');
    return active.policy;
  }

  /** `delegated` 는 위임 승인·다시 쓰게일 때만 (mandate_id 와 via='delegate' 가 남는다). 그 밖에는 소켓 요청이 자기 신고한 via 가 남는다 */
  #insertApproval(
    tx: Db, kind: ApprovalSubject, id: string, decision: 'approved' | 'rejected' | 'changes_requested', hash: string | null, actor: string, comment: string | null,
    delegated?: { mandateId: string },
  ): string {
    const approvalId = this.#o.newId?.() ?? `approval-${randomUUID()}`;
    tx.run('INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at, mandate_id, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      approvalId, kind, id, decision, hash, actor, comment === null ? null : comment.slice(0, 500), this.#now(), delegated?.mandateId ?? null, delegated ? 'delegate' : this.#via,
    ]);
    return approvalId;
  }

  /** `show` 가 보여 준 해시(expected_hash)와 지금 해시가 다르면 거부한다. 해시를 보내지 않았으면 대조하지 않는다 */
  #expect(expected: string | undefined, actual: string | null, what: string): void {
    if (expected !== undefined && expected !== actual) refuse(`the ${what} changed since it was shown (expected_hash mismatch); show it again before deciding`, 'hash_mismatch');
  }

  /** cancel·reject 가 종류를 가리지 않고 쓰는 지금 대상 해시 (`show` 의 hash 와 같다) */
  #hashOf(tx: Db, kind: ApprovalSubject, id: string): string | null {
    if (kind === 'task') return this.#taskContext(tx, id).hash;
    if (kind === 'publication') return this.#publication(tx, id).hash;
    if (kind === 'strategy_version') return this.#strategy(tx, id).hash;
    if (kind === 'org_proposal') return this.#org(tx, id).hash;
    return tx.get<{ subject_hash: string | null }>(
      "SELECT subject_hash FROM approval WHERE subject_kind = 'policy_version' AND subject_id = ? AND decision = 'approved' ORDER BY at DESC, rowid DESC LIMIT 1", [id],
    )?.subject_hash ?? null;
  }

  /**
   * 재인증 (TOTP). 코드가 없거나 틀리거나 이미 쓴 시간창이면 거부.
   * 연속 실패는 제한한다 (RFC 4226 §7.3 throttling, RFC 6238 §5): 사람별 TOTP_MAX_FAILURES 회 연속 실패면
   * TOTP_LOCKOUT_MS 동안 받지 않는다. 기록은 프로세스 메모리에만 둔다(재시작하면 초기화).
   */
  #reauth(tx: Db, actor: string, code: string | undefined, purpose: string, missingMessage = 'a TOTP code is required to release this risky change'): void {
    if (code === undefined || code === '') refuseReauth('reauth_required', missingMessage);
    const nowMs = this.#o.clock.nowMs();
    const failures = this.#failures.get(actor);
    if (failures && failures.count >= TOTP_MAX_FAILURES && nowMs < failures.lastMs + TOTP_LOCKOUT_MS) {
      refuseReauth('reauth_locked', 'too many wrong TOTP codes; try again later');
    }
    const step = verifyTotp(this.#o.totp.secretOf(actor), code!, nowMs);
    if (step === null) {
      const count = failures && nowMs < failures.lastMs + TOTP_LOCKOUT_MS ? failures.count + 1 : 1;
      this.#failures.set(actor, { count, lastMs: nowMs });
      refuseReauth('reauth_failed', 'the TOTP code is not valid');
    }
    recordReauth(tx, actor, step!, purpose, this.#now()); // 이미 쓴 시간창이면 여기서 던진다: 그 경우 실패 횟수를 지우지 않는다
    this.#failures.delete(actor);
  }

  /**
   * 호출자의 write 트랜잭션 안에서 하는 TOTP 재인증 (효과 해소 failed 가 쓴다, A6 후속). release 와 같은 `#reauth` 를 거치므로
   * 같은 연속 실패 잠금(`#failures`)과 같은 시간창 재사용 거부를 공유한다. 성공하면 `human_reauth` 행 하나를 호출자 트랜잭션에 쓴다
   * (호출자가 이후 단계에서 던지면 같이 되돌려진다).
   * 호출 오류는 아무것도 세기 전에 plain Error: 트랜잭션 밖 호출, `release:` 로 시작하는 목적(release 의 목적과 섞이면 안 된다).
   * 사람이 아니면 ApprovalRefusedError, 거부는 ReauthRefusedError(코드), 이미 쓴 시간창은 ReauthError, 비밀 미등록은 TotpSecretError.
   */
  reauthenticateInTx(tx: Db, actorId: string, code: string | undefined, purpose: string): void {
    if (!tx.inWriteTx) throw new Error('reauthenticateInTx must be called inside the caller\'s write transaction');
    if (purpose.startsWith('release:')) throw new Error("reauthenticateInTx: purposes starting with 'release:' are reserved for the release command");
    requireHuman(tx, actorId);
    this.#reauth(tx, actorId, code, purpose, 'a TOTP code is required to resolve an effect as failed');
  }

  // ===== 업무 =====

  #taskContext(tx: Db, id: string): TaskApprovalContext {
    const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [id]) ?? refuse(`task '${id}' does not exist`, 'bad_request');
    const spec = JSON.parse(task.spec) as TaskSpec;
    const policy = this.#policy(tx);
    const requests = requestsFromSpec(spec);
    const verdicts = requests.map((request) => ({ request, verdict: evaluateRequest(policy.document, request) }));
    const drafts = proposedDraftsOf(tx, id);
    const sendStates = draftSendStates(tx, drafts);
    const masked = new Map(drafts.map((draft) => [draft.id, maskedPathsOf(JSON.parse(draft.payload), (this.#o.maskPayload ?? maskSecretKeys)(JSON.parse(draft.payload)))]));
    const subject = taskSubject(task, spec, policy.versionId, drafts);
    return {
      task, spec, policy, document: policy.document, verdicts, drafts, sendStates, masked, subject, hash: taskSubjectHash(subject), requester: taskRequester(tx, task),
      params: taskApprovalParams(policy.document, requests),
      // 위임 승인 행을 받아 주는 쪽 (ADR-0016, 제안). 위임이 없는 정책이면 null — 에이전트 행은 하나도 세지 않는다
      authority: delegationAuthority(tx, policy.document, this.#now()),
    };
  }

  #approveTask(actor: string, id: string, hash: string, comment?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const ctx = this.#taskContext(tx, id);
      if (ctx.task.status !== 'needs_review') refuse(`task '${id}' is '${ctx.task.status}'; approvals apply to tasks in needs_review`, 'wrong_state');
      const denied = ctx.verdicts.filter((v) => v.verdict.decision === 'deny');
      if (denied.length > 0) refuse(`the current policy denies this task (${denied.map((v) => v.verdict.reason).join('; ')}); an approval cannot override deny`, 'policy_denied');
      this.#refuseExpiredDrafts(ctx.drafts, 'approved');
      this.#refuseMaskedDrafts(ctx, 'approved');
      if (hash !== ctx.hash) refuse('the task changed since it was shown (subject hash mismatch); show it again before approving', 'hash_mismatch');
      const params = ctx.params;
      if (!params.self_approval && ctx.requester === actor) refuse(`the requester cannot approve their own task (${SELF_APPROVAL_RULE})`, 'self_approval');

      const approvalId = this.#insertApproval(tx, 'task', id, 'approved', ctx.hash, actor, comment ?? null);
      const needsApproval = ctx.verdicts.some((v) => v.verdict.decision === 'require_approval');
      const snapshot = JSON.stringify(ctx.subject);
      if (!needsApproval) {
        this.#queue(tx, ctx.task, actor, approvalId, { approval_id: approvalId, approved_snapshot: snapshot, approved_hash: ctx.hash }, 'approved by a human (no risky change)');
        return { state: 'queued', approval_id: approvalId, hash: ctx.hash };
      }
      const status = approvalStatus(tx, { kind: 'task', id, hash: ctx.hash, requesterId: ctx.requester, params, now: this.#now(), authority: ctx.authority });
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

  /** 기한이 지난 초안이 있으면 승인·해제를 거부한다 (ADR-0015): 변경 요청으로 다시 쓰게 한다 */
  #refuseMaskedDrafts(ctx: { drafts: readonly { id: string }[]; masked: ReadonlyMap<string, string[]> }, what: 'approved' | 'released'): void {
    const hidden = ctx.drafts.filter((draft) => (ctx.masked.get(draft.id) ?? []).length > 0);
    if (hidden.length > 0) {
      refuse(`${hidden.length} of ${ctx.drafts.length} drafts would show masked values (${hidden.map((d) => `${d.id}: ${ctx.masked.get(d.id)!.join(', ')}`).join('; ')}): a person cannot see every byte, so the content cannot be ${what}; ask for changes (request-changes) so the secret-like values are removed`, 'masked');
    }
  }

  /** 이미 전송이 시작된(planned 보다 나아간) 초안이 있으면 초안을 버리거나 거절할 수 없다: 다시 쓴 초안이 같은 내용을 다른 문구로 또 보낼 수 있다 */
  #refuseStartedDrafts(ctx: { drafts: readonly { id: string }[]; sendStates: ReadonlyMap<string, string> }, what: string): void {
    const started = ctx.drafts.filter((draft) => !['none', 'planned'].includes(ctx.sendStates.get(draft.id) ?? 'none'));
    if (started.length > 0) {
      refuse(`${started.length} draft(s) already left the ledger (${started.map((d) => `${d.id}: ${ctx.sendStates.get(d.id)!}`).join(', ')}); ${what} would let a rewritten draft send the same content again. Check the external service and settle the effect with \`effects\` / \`resolve-effect\` first`, 'send_started');
    }
  }

  #refuseExpiredDrafts(drafts: readonly { id: string; expires_at: string }[], what: 'approved' | 'released'): void {
    const now = this.#now();
    const expired = drafts.filter((draft) => now >= draft.expires_at);
    if (expired.length > 0) refuse(`draft expired (${expired.length} of ${drafts.length} past expires_at): the content cannot be ${what}; ask for changes (request-changes) so the agent rewrites it`, 'expired');
  }

  #queue(tx: Db, task: TaskRow, actor: string, approvalId: string, set: Record<string, string>, reason: string, by: 'human' | 'policy' = 'human'): void {
    assertAllowed('needs_review', 'queued', approvalId, by);
    const changed = tx.run(
      `UPDATE task SET status = 'queued', updated_at = ?${Object.keys(set).map((k) => `, ${k} = ?`).join('')} WHERE id = ? AND status = 'needs_review'`,
      [this.#now(), ...Object.values(set), task.id],
    );
    if (changed.changes !== 1) refuse(`task '${task.id}' is no longer in needs_review`, 'wrong_state');
    tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
      task.id, 'needs_review', 'queued', `${reason} (approval ${approvalId})`, actor, this.#now(),
    ]);
  }

  #releaseTask(tx: Db, actor: string, id: string, code: string | undefined, expected?: string): Record<string, unknown> {
    const ctx = this.#taskContext(tx, id);
    if (ctx.task.status !== 'needs_review') refuse(`task '${id}' is '${ctx.task.status}'; only an approved task in needs_review can be released`, 'wrong_state');
    if (ctx.task.approved_hash === null) refuse(`task '${id}' has no approval to release`, 'wrong_state');
    this.#refuseExpiredDrafts(ctx.drafts, 'released');
    this.#refuseMaskedDrafts(ctx, 'released');
    if (ctx.task.approved_hash !== ctx.hash) refuse('the task or the policy changed since approval (approved_hash mismatch); re-approval required', 'hash_mismatch');
    const params = ctx.params;
    this.#expect(expected, ctx.hash, 'task');
    const status = approvalStatus(tx, { kind: 'task', id, hash: ctx.hash, requesterId: ctx.requester, params, now: this.#now(), checkReauth: false, authority: ctx.authority });
    if (!status.ok) refuse(status.reason, STATE_CODES[status.state]);
    // 위임 승인(ADR-0016)이 정족수면 재인증은 위임을 배포할 때 했다: 위임 cooldown 만 지나면 된다
    if (params.reauth_before_effect && status.mandateId == null) this.#reauth(tx, actor, code, reauthPurpose('task', id, ctx.hash));
    this.#queue(tx, ctx.task, actor, ctx.task.approval_id ?? status.quorumApprovalId!, {}, status.mandateId == null ? 'released after the cooldown and human re-authentication' : `released after the delegation cooldown (mandate ${status.mandateId})`);
    return { state: 'queued' };
  }

  // ===== 게시 =====

  #publication(tx: Db, id: string) {
    const row = tx.get<PublicationRow>('SELECT * FROM publication WHERE id = ?', [id]) ?? refuse(`publication '${id}' does not exist`, 'bad_request');
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
      if (ctx.row.status !== 'draft' && ctx.row.status !== 'pending_approval') refuse(`publication '${id}' is '${ctx.row.status}'`, 'wrong_state');
      if (hash !== ctx.hash) refuse('the publication changed since it was shown (subject hash mismatch); show it again before approving', 'hash_mismatch');
      const params = ctx.params;
      if (!params.self_approval && ctx.requester === actor) refuse(`the requester cannot approve their own publication (${SELF_APPROVAL_RULE})`, 'self_approval');
      const approvalId = this.#insertApproval(tx, 'publication', id, 'approved', ctx.hash, actor, comment ?? null);
      if (ctx.row.status === 'draft') tx.run("UPDATE publication SET status = 'pending_approval' WHERE id = ? AND status = 'draft'", [id]);
      const status = approvalStatus(tx, { kind: 'publication', id, hash: ctx.hash, requesterId: ctx.requester, params, now: this.#now() });
      return { state: status.state, reason: status.reason, approval_id: approvalId, hash: ctx.hash, cooldown_ends_at: status.cooldownEndsAt };
    });
  }

  #releasePublication(tx: Db, actor: string, id: string, code: string | undefined, expected?: string): Record<string, unknown> {
    const ctx = this.#publication(tx, id);
    this.#expect(expected, ctx.hash, 'publication');
    const params = ctx.params;
    const status = approvalStatus(tx, { kind: 'publication', id, hash: ctx.hash, requesterId: ctx.requester, params, now: this.#now(), checkReauth: false });
    if (!status.ok) refuse(status.reason, STATE_CODES[status.state]);
    if (params.reauth_before_effect) this.#reauth(tx, actor, code, reauthPurpose('publication', id, ctx.hash));
    return { state: 'released', note: 'the publication gate may now publish it' };
  }

  // ===== 실험 전략 (A6-U15) =====

  #strategy(tx: Db, id: string) {
    const row = tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [id]) ?? refuse(`strategy_version '${id}' does not exist`, 'bad_request');
    const policy = this.#policy(tx);
    const subject = strategySubject(row, policy);
    // 요청자 = 제안자(created_by). 보통 기획 run 의 에이전트라 사람 승인자와 겹치지 않지만, 사람이 낸 제안이면 자기 승인 규칙이 적용된다.
    return { row, policy, subject, hash: strategySubjectHash(subject), requester: row.created_by, params: humanApprovalParams(policy.document) };
  }

  #approveStrategy(actor: string, id: string, hash: string, comment?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const ctx = this.#strategy(tx, id);
      if (ctx.row.status !== 'proposed') refuse(`strategy_version '${id}' is '${ctx.row.status}'; only a proposed strategy can be approved`, 'wrong_state');
      if (hash !== ctx.hash) refuse('the strategy changed since it was shown (subject hash mismatch); show it again before approving', 'hash_mismatch');
      const running = experimentsInProgress(tx).filter((other) => other !== id);
      if (running.length > 0) refuse(`an experiment is already in progress (${running.join(', ')}); approve the next one after it ends`, 'wrong_state');
      if (!ctx.params.self_approval && ctx.requester === actor) refuse(`the proposer cannot approve their own strategy (${SELF_APPROVAL_RULE})`, 'self_approval');
      const approvalId = this.#insertApproval(tx, 'strategy_version', id, 'approved', ctx.hash, actor, comment ?? null);
      const status = approvalStatus(tx, { kind: 'strategy_version', id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now() });
      if (!status.ok) refuse(status.reason, STATE_CODES[status.state]); // 사람 1인·cooldown 0·재인증 없음이라 여기서는 항상 ok 다 (방어)
      transitionStrategyVersion(tx, {
        strategyVersionId: id, from: 'proposed', to: 'experiment', by: 'human', actorId: actor, approvalId,
        reason: `approved by a human (approval ${approvalId})`,
      });
      return { state: 'experiment', approval_id: approvalId, hash: ctx.hash, note: 'the experiment routine is activated by the weekly cycle (outside this transaction)' };
    });
  }

  /** 활성화 전 취소: 승인을 무효로 한다(뒤에 rejected 행). 활성화가 승인을 다시 확인하므로 켜지지 않는다. 이미 켜진 실험은 취소가 아니라 종료한다 */
  #cancelStrategy(tx: Db, actor: string, id: string, comment?: string, expected?: string): Record<string, unknown> {
    const row = tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [id]) ?? refuse(`strategy_version '${id}' does not exist`, 'bad_request');
    if (row.status !== 'proposed' && row.status !== 'experiment') refuse(`strategy_version '${id}' is '${row.status}'; nothing is waiting to be cancelled`, 'wrong_state');
    if (findExperimentActivation(tx, id) !== null) refuse(`the experiment '${id}' is already active; end it instead of cancelling the approval`, 'wrong_state');
    if (expected !== undefined) this.#expect(expected, this.#strategy(tx, id).hash, 'strategy');
    const approvalId = this.#insertApproval(tx, 'strategy_version', id, 'rejected', null, actor, `cancelled${comment ? `: ${comment}` : ''}`);
    return { state: 'cancelled', approval_id: approvalId, status: row.status };
  }

  #rejectStrategy(tx: Db, actor: string, id: string, comment?: string, expected?: string): Record<string, unknown> {
    const row = tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [id]) ?? refuse(`strategy_version '${id}' does not exist`, 'bad_request');
    if (row.status !== 'proposed') refuse(`strategy_version '${id}' is '${row.status}'; only a proposed strategy can be rejected`, 'wrong_state');
    if (expected !== undefined) this.#expect(expected, this.#strategy(tx, id).hash, 'strategy');
    const approvalId = this.#insertApproval(tx, 'strategy_version', id, 'rejected', null, actor, comment ?? 'rejected');
    transitionStrategyVersion(tx, { strategyVersionId: id, from: 'proposed', to: 'rejected', by: 'human', actorId: actor, reason: `rejected by a human (approval ${approvalId})` });
    return { state: 'rejected', approval_id: approvalId };
  }

  // ===== 조직 변경 제안 (Phase B, ADR-0011) =====
  // 일반 변경(normal)은 사람 1인 승인(humanApprovalParams), 위험 변경(risky = 권한 확대)은 **현재** 정책의 risky_change 절차(대기 + 취소 가능 + 해제 때 TOTP 재인증).
  // 승인 해시 = 제안 해시(diff·기준 버전·시험 범위·평가 계획·롤백 계획·등급) + 승인 시점 정책 버전. 승인되면 같은 트랜잭션에서 `proposed → approved` (domain 허용표).
  // 기준 버전 충돌·만료는 거부가 아니라 `superseded`/`expired` 전이로 기록하고 결과 상태를 돌려준다 (예외로 되돌리면 전이가 사라진다).
  // `approved → trial` 은 시스템(주기 처리)이 한다 — 승인은 변경안 승인이지 무조건적인 실행 허가가 아니다.

  #org(tx: Db, id: string) {
    const row = getOrgProposal(tx, id) ?? refuse(`org_proposal '${id}' does not exist`, 'bad_request');
    const policy = this.#policy(tx);
    const subject = {
      kind: 'org_proposal' as const, proposal_id: row.id, proposal_hash: row.proposal_hash, base_org_version_id: row.base_org_version_id,
      change_class: row.change_class, policy_version_id: policy.versionId, policy_hash: policy.hash,
    };
    const params = row.change_class === 'risky' ? riskyApprovalParams(policy.document) : humanApprovalParams(policy.document);
    return { row, policy, subject, hash: contentHash(subject), requester: row.proposed_by, params };
  }

  /** 승인·해제 직전 점검: 만료·기준 버전 충돌이면 전이를 기록하고 그 결과를 돌려준다 (null 이면 계속) */
  #orgStale(tx: Db, row: OrgProposalRow): Record<string, unknown> | null {
    const stale = orgProposalStaleness(tx, row, this.#now());
    if (stale === null) return null;
    transitionOrgProposal(tx, this.#o.clock, { proposalId: row.id, to: stale.to, by: 'system', reason: stale.reason });
    return { state: stale.to, note: stale.note };
  }

  #approveOrg(actor: string, id: string, hash: string, comment?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const ctx = this.#org(tx, id);
      if (ctx.row.status !== 'proposed') refuse(`org_proposal '${id}' is '${ctx.row.status}'; only a proposed change can be approved`, 'wrong_state');
      if (hash !== ctx.hash) refuse('the proposal changed since it was shown (subject hash mismatch); show it again before approving', 'hash_mismatch');
      if (!ctx.params.self_approval && ctx.requester === actor) refuse(`the proposer cannot approve their own proposal (${SELF_APPROVAL_RULE})`, 'self_approval');
      const stale = this.#orgStale(tx, ctx.row);
      if (stale) return stale;
      const approvalId = this.#insertApproval(tx, 'org_proposal', id, 'approved', ctx.hash, actor, comment ?? null);
      const status = approvalStatus(tx, { kind: 'org_proposal', id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now() });
      if (status.ok) {
        transitionOrgProposal(tx, this.#o.clock, { proposalId: id, to: 'approved', by: 'human', actorId: actor, approvalId });
        return { state: 'approved', approval_id: approvalId, hash: ctx.hash, note: 'the trial starts in the next organization cycle (outside this transaction)' };
      }
      return { state: status.state, approval_id: approvalId, hash: ctx.hash, reason: status.reason, cooldown_ends_at: status.cooldownEndsAt };
    });
  }

  #releaseOrg(tx: Db, actor: string, id: string, code: string | undefined, expected?: string): Record<string, unknown> {
    const ctx = this.#org(tx, id);
    if (ctx.row.change_class !== 'risky') refuse('only a risky proposal needs a release: a normal change is approved by one human approval', 'wrong_state');
    if (ctx.row.status !== 'proposed') refuse(`org_proposal '${id}' is '${ctx.row.status}'; only a proposed change can be released`, 'wrong_state');
    this.#expect(expected, ctx.hash, 'proposal');
    const stale = this.#orgStale(tx, ctx.row);
    if (stale) return stale;
    const status = approvalStatus(tx, { kind: 'org_proposal', id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now(), checkReauth: false });
    if (!status.ok) refuse(status.reason, STATE_CODES[status.state]);
    if (ctx.params.reauth_before_effect) this.#reauth(tx, actor, code, reauthPurpose('org_proposal', id, ctx.hash));
    transitionOrgProposal(tx, this.#o.clock, { proposalId: id, to: 'approved', by: 'human', actorId: actor, approvalId: status.quorumApprovalId! });
    return { state: 'approved', change_class: 'risky', approval_id: status.quorumApprovalId };
  }

  #cancelOrg(tx: Db, actor: string, id: string, comment?: string, expected?: string): Record<string, unknown> {
    const row = getOrgProposal(tx, id) ?? refuse(`org_proposal '${id}' does not exist`, 'bad_request');
    if (row.status !== 'proposed') refuse(`org_proposal '${id}' is '${row.status}'; nothing is waiting to be cancelled`, 'wrong_state');
    if (expected !== undefined) this.#expect(expected, this.#org(tx, id).hash, 'proposal');
    const approvalId = this.#insertApproval(tx, 'org_proposal', id, 'rejected', null, actor, `cancelled${comment ? `: ${comment}` : ''}`);
    return { state: 'cancelled', approval_id: approvalId, status: row.status };
  }

  #rejectOrg(tx: Db, actor: string, id: string, comment?: string, expected?: string): Record<string, unknown> {
    const row = getOrgProposal(tx, id) ?? refuse(`org_proposal '${id}' does not exist`, 'bad_request');
    if (row.status !== 'proposed') refuse(`org_proposal '${id}' is '${row.status}'; only a proposed change can be rejected`, 'wrong_state');
    if (expected !== undefined) this.#expect(expected, this.#org(tx, id).hash, 'proposal');
    const approvalId = this.#insertApproval(tx, 'org_proposal', id, 'rejected', null, actor, comment ?? 'rejected');
    transitionOrgProposal(tx, this.#o.clock, { proposalId: id, to: 'rejected', by: 'human', actorId: actor, reason: comment ?? 'rejected by a human' });
    return { state: 'rejected', approval_id: approvalId };
  }

  // ===== 정책 배포 =====

  #approvePolicy(actor: string, text: string, comment?: string): Record<string, unknown> {
    if (typeof text !== 'string' || text.length > 256 * 1024) refuse('policy_text must be a YAML document of at most 256 KiB', 'bad_request');
    const parsed = this.#o.store.archive(text);
    return this.#o.db.writeTx((tx) => {
      const current = this.#policy(tx);
      if (parsed.hash === current.hash) refuse(`this content is already the deployed policy (${current.versionId})`, 'wrong_state');
      this.#checkMandatesAtDeploy(tx, parsed.document, this.#now());
      const change = classifyChange(current.document, parsed.document);
      const note = [`change_class=${change.changeClass}`, ...change.reasons, ...(comment ? [comment] : [])].join('; ');
      const approvalId = this.#insertApproval(tx, 'policy_version', parsed.versionId, 'approved', parsed.hash, actor, note);
      const base = { id: parsed.versionId, hash: parsed.hash, change_class: change.changeClass, reasons: change.reasons, approval_id: approvalId };
      if (change.changeClass === 'normal') return { ...base, state: 'deployed', version_id: this.#deploy(tx, parsed, 'normal', [actor]) };
      // 위험 변경은 현재(변경 전) 정책의 risky_change 로 승인한다. 새 정책의 값으로 자기 자신을 승인할 수 없다.
      const status = approvalStatus(tx, { kind: 'policy_version', id: parsed.versionId, hash: parsed.hash, requesterId: null, params: policyApprovalParams(current.document, change), now: this.#now() });
      if (status.ok) return { ...base, state: 'deployed', version_id: this.#deploy(tx, parsed, 'risky', status.approvers) };
      return { ...base, state: status.state, reason: status.reason, cooldown_ends_at: status.cooldownEndsAt };
    });
  }

  #releasePolicy(tx: Db, actor: string, id: string, code: string | undefined, expected?: string): Record<string, unknown> {
    const latest = tx.get<{ subject_hash: string | null; decision: string; at: string }>(
      "SELECT subject_hash, decision, at FROM approval WHERE subject_kind = 'policy_version' AND subject_id = ? ORDER BY at DESC, rowid DESC LIMIT 1", [id],
    ) ?? refuse(`no policy proposal '${id}'`, 'bad_request');
    if (latest.decision !== 'approved' || latest.subject_hash === null) refuse(`policy proposal '${id}' was rejected or cancelled`, 'wrong_state');
    const parsed = this.#o.store.byHash(latest.subject_hash!) ?? refuse(`the content of policy proposal '${id}' is not in the policy store`, 'bad_request');
    const current = this.#policy(tx);
    if (parsed.hash === current.hash) refuse(`policy proposal '${id}' is already deployed`, 'wrong_state');
    this.#expect(expected, parsed.hash, 'policy proposal');
    this.#checkMandatesAtDeploy(tx, parsed.document, latest.at); // 위임 만료의 90일은 배포 승인 시각부터 센다
    const change = classifyChange(current.document, parsed.document);
    if (change.changeClass === 'normal') return { state: 'deployed', change_class: 'normal', version_id: this.#deploy(tx, parsed, 'normal', [actor]) };
    const params = policyApprovalParams(current.document, change);
    const status = approvalStatus(tx, { kind: 'policy_version', id, hash: parsed.hash, requesterId: null, params, now: this.#now(), checkReauth: false });
    if (!status.ok) refuse(status.reason, STATE_CODES[status.state]);
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
    // 위임 보유자가 예약된 AI 행위자(approval-delegate)면 사람이 승인한 이 배포와 같은 트랜잭션에서 행위자·역할을 만든다 (ADR-0016, 제안)
    if (mandatesOf(parsed.document).some((mandate) => mandate.holder === APPROVAL_DELEGATE.actor)) ensureApprovalDelegate(tx, this.#o.clock);
    return id;
  }

  /**
   * 위임을 선언한 정책의 배포 승인 점검 (ADR-0016, 제안): 모든 위임의 만료가 배포 승인 시각부터 90일 이내이고 이미 지나지 않았고, 보유자가 에이전트 행위자여야 한다
   * (예약된 `approval-delegate` 는 배포 때 만들어지므로 아직 없어도 된다). 위임이 없는 정책이면 아무것도 보지 않는다.
   */
  #checkMandatesAtDeploy(tx: Db, document: PolicyDocument, approvedAt: string): void {
    const mandates = mandatesOf(document);
    if (mandates.length === 0) return;
    const limit = new Date(Date.parse(approvedAt) + DELEGATION_MAX_DAYS * 86_400_000).toISOString();
    for (const mandate of mandates) {
      const expiresAt = mandateExpiresAt(mandate.expires) ?? refuse(`mandate '${mandate.id}': expires is not a date`, 'bad_request');
      if (expiresAt > limit) refuse(`mandate '${mandate.id}' expires ${mandate.expires}, more than ${DELEGATION_MAX_DAYS} days after the deployment approval; shorten it`, 'policy_denied');
      if (expiresAt < approvedAt) refuse(`mandate '${mandate.id}' has already expired (${mandate.expires})`, 'policy_denied');
      if (mandate.holder !== APPROVAL_DELEGATE.actor && tx.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [mandate.holder])?.kind !== 'agent') {
        refuse(`mandate '${mandate.id}': holder '${mandate.holder}' must be a registered agent actor`, 'policy_denied');
      }
    }
  }

  // ===== 공통 명령 =====

  #release(actor: string, kind: ApprovalSubject, id: string, code: string | undefined, expected?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      if (kind === 'task') return this.#releaseTask(tx, actor, id, code, expected);
      if (kind === 'publication') return this.#releasePublication(tx, actor, id, code, expected);
      if (kind === 'strategy_version') refuse('a strategy needs no release: one human approval moves it to experiment (no cooldown or re-authentication)', 'wrong_state');
      if (kind === 'org_proposal') return this.#releaseOrg(tx, actor, id, code, expected);
      return this.#releasePolicy(tx, actor, id, code, expected);
    });
  }

  /** 대기 중 취소: 승인을 무효로 한다(뒤에 rejected 행). 해제된 뒤 아직 실행 전(queued)인 업무는 needs_review 로 되돌린다. */
  #cancel(actor: string, kind: ApprovalSubject, id: string, comment?: string, expected?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const now = this.#now();
      if (kind === 'strategy_version') return this.#cancelStrategy(tx, actor, id, comment, expected);
      if (kind === 'org_proposal') return this.#cancelOrg(tx, actor, id, comment, expected);
      if (kind === 'task') {
        const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [id]) ?? refuse(`task '${id}' does not exist`, 'bad_request');
        if (task.status !== 'needs_review' && task.status !== 'queued') refuse(`task '${id}' is '${task.status}'; only a task that has not started can be cancelled`, 'wrong_state');
        if (expected !== undefined) this.#expect(expected, this.#taskContext(tx, id).hash, 'task');
        // 사람이 위임 승인을 취소하면 그 위임을 자동 정지한다 (ADR-0016 D-B5): 해제는 사람 + TOTP. 취소 행을 쓰기 전에 지금 유효한 위임 승인을 찾는다
        const delegatedMandate = this.#delegatedApprovalOf(tx, id);
        const approvalId = this.#insertApproval(tx, 'task', id, 'rejected', task.approved_hash, actor, `cancelled${comment ? `: ${comment}` : ''}`);
        if (delegatedMandate !== null) this.#insertControl(tx, 'pause', delegatedMandate, actor, '사람이 위임 결정을 취소함');
        if (task.status === 'queued') {
          assertAllowed('queued', 'needs_review', approvalId, 'policy');
          tx.run("UPDATE task SET status = 'needs_review', updated_at = ? WHERE id = ? AND status = 'queued'", [now, id]);
          tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
            id, 'queued', 'needs_review', `approval cancelled by ${actor} before the run`, 'system:policy', now,
          ]);
        }
        return { state: 'cancelled', approval_id: approvalId, ...(delegatedMandate === null ? {} : { delegation_paused: delegatedMandate }) };
      }
      if (expected !== undefined) this.#expect(expected, this.#hashOf(tx, kind, id), kind);
      const approvalId = this.#insertApproval(tx, kind, id, 'rejected', null, actor, `cancelled${comment ? `: ${comment}` : ''}`);
      return { state: 'cancelled', approval_id: approvalId };
    });
  }

  #reject(actor: string, kind: ApprovalSubject, id: string, comment?: string, expected?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      if (kind === 'strategy_version') return this.#rejectStrategy(tx, actor, id, comment, expected);
      if (kind === 'org_proposal') return this.#rejectOrg(tx, actor, id, comment, expected);
      if (kind !== 'task') {
        if (expected !== undefined) this.#expect(expected, this.#hashOf(tx, kind, id), kind);
        return { state: 'rejected', approval_id: this.#insertApproval(tx, kind, id, 'rejected', null, actor, comment ?? 'rejected') };
      }
      const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [id]) ?? refuse(`task '${id}' does not exist`, 'bad_request');
      if (task.status !== 'needs_review') refuse(`task '${id}' is '${task.status}'; only a task in needs_review can be rejected`, 'wrong_state');
      const rejectCtx = this.#taskContext(tx, id);
      this.#refuseStartedDrafts(rejectCtx, 'rejecting the task');
      this.#expect(expected, rejectCtx.hash, 'task');
      // 사람이 위임 승인을 거절해도 취소와 같이 그 위임을 자동 정지한다 (ADR-0016 D-B5): AI 가 한 결정을 사람이 뒤집었다는 신호다
      const delegatedMandate = this.#delegatedApprovalOf(tx, id);
      const approvalId = this.#insertApproval(tx, 'task', id, 'rejected', task.approved_hash, actor, comment ?? 'rejected');
      if (delegatedMandate !== null) this.#insertControl(tx, 'pause', delegatedMandate, actor, '사람이 위임 결정을 거절함');
      assertAllowed('needs_review', 'failed', approvalId);
      tx.run("UPDATE task SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'needs_review'", [this.#now(), id]);
      tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
        id, 'needs_review', 'failed', `rejected by a human (approval ${approvalId})`, actor, this.#now(),
      ]);
      // 같은 트랜잭션에서 제안된 초안도 거절한다 (ADR-0015)
      transitionDrafts(tx, { taskId: id, from: ['proposed'], to: 'rejected', by: 'human', now: this.#now() });
      return { state: 'failed', approval_id: approvalId, ...(delegatedMandate === null ? {} : { delegation_paused: delegatedMandate }) };
    });
  }

  /**
   * 변경 요청 (ADR-0015): 승인 행(`changes_requested`, 지금 대상 해시)을 남기고, 제안된 초안을 `superseded` 로 버리고, 승인 컬럼을 비운 뒤 `needs_review → queued`.
   * 다음 `beforeRun` 은 제안된 초안이 없으니 초안 단계(draft)로 보낸다. 사유는 필수이며 승인 행의 comment 에 남는다(다음 초안 run 에 넘기는 것은 W13).
   * 앞선 승인은 비승인 행이 뒤따르므로 무효가 된다.
   */
  #requestChanges(actor: string, id: string, comment: string, expected?: string): Record<string, unknown> {
    return this.#o.db.writeTx((tx) => {
      const ctx = this.#taskContext(tx, id);
      if (ctx.task.status !== 'needs_review') refuse(`task '${id}' is '${ctx.task.status}'; changes can only be requested for a task in needs_review`, 'wrong_state');
      this.#refuseStartedDrafts(ctx, 'requesting changes');
      this.#expect(expected, ctx.hash, 'task');
      // 사람이 위임 승인에 변경을 요청해도 취소·거절과 같이 그 위임을 자동 정지한다 (ADR-0016 D-B5)
      const delegatedMandate = this.#delegatedApprovalOf(tx, id);
      const result = this.#queueForRewrite(tx, ctx, actor, comment, null);
      if (delegatedMandate === null) return result;
      this.#insertControl(tx, 'pause', delegatedMandate, actor, '사람이 위임 결정에 변경을 요청함');
      return { ...result, delegation_paused: delegatedMandate };
    });
  }

  /** 승인 행(`changes_requested`)을 남기고, 제안된 초안을 버리고, 승인 컬럼을 비운 뒤 `needs_review → queued`. 사람의 변경 요청과 위임 보유자의 다시 쓰게가 같이 쓴다 */
  #queueForRewrite(tx: Db, ctx: { task: TaskRow; hash: string }, actor: string, comment: string, delegated: { mandateId: string } | null): Record<string, unknown> {
    const id = ctx.task.id;
    const approvalId = this.#insertApproval(tx, 'task', id, 'changes_requested', ctx.hash, actor, comment, delegated ?? undefined);
    assertAllowed('needs_review', 'queued', approvalId, delegated === null ? 'human' : 'policy');
    const now = this.#now();
    const superseded = transitionDrafts(tx, { taskId: id, from: ['proposed'], to: 'superseded', by: delegated === null ? 'human' : 'scheduler', now }); // 위임 보유자의 다시 쓰게는 호스트(데몬 주기)가 기록한다
    const changed = tx.run(
      "UPDATE task SET status = 'queued', approval_id = NULL, approved_snapshot = NULL, approved_hash = NULL, updated_at = ? WHERE id = ? AND status = 'needs_review'", [now, id],
    );
    if (changed.changes !== 1) refuse(`task '${id}' is no longer in needs_review`, 'wrong_state');
    tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
      id, 'needs_review', 'queued',
      delegated === null ? `changes requested by a human; the drafts are discarded and rewritten (approval ${approvalId})`
        : `changes requested by the delegate (mandate ${delegated.mandateId}); the drafts are discarded and rewritten (approval ${approvalId})`,
      actor, now,
    ]);
    return { state: 'queued', approval_id: approvalId, drafts_superseded: superseded };
  }

  // ===== 결정 위임 (ADR-0016, 제안 — 오너 결정 D-B1) =====
  // 위임 보유자(AI)의 결정은 소켓이 아니라 이 프로세스 안 메서드로만 들어온다(데몬의 delegate-cycle). 소켓 명령 목록(CMDS)에 없다.

  /** 지금 정책의 위임 목록. 정책 내용이 없으면 빈 목록 */
  #mandates(tx: Db): readonly Mandate[] {
    const active = this.#o.store.active(tx);
    return active?.policy ? mandatesOf(active.policy.document) : [];
  }

  #delegationCtx(ctx: TaskApprovalContext) {
    return { task: ctx.task, spec: ctx.spec, document: ctx.document, verdicts: ctx.verdicts, drafts: ctx.drafts, sendStates: ctx.sendStates, masked: ctx.masked, requester: ctx.requester };
  }

  /** 이 업무의 지금 유효한(뒤에 비승인 행이 없는) 승인 중 위임 승인이 있으면 그 위임 id */
  #delegatedApprovalOf(tx: Db, taskId: string): string | null {
    const rows = tx.all<{ decision: string; mandate_id: string | null }>(
      "SELECT decision, mandate_id FROM approval WHERE subject_kind = 'task' AND subject_id = ? ORDER BY at, rowid", [taskId],
    );
    let start = 0;
    rows.forEach((row, index) => {
      if (row.decision !== 'approved') start = index + 1;
    });
    return rows.slice(start).find((row) => row.mandate_id !== null)?.mandate_id ?? null;
  }

  #insertControl(tx: Db, action: 'pause' | 'resume' | 'revoke', mandateId: string | null, actor: string, reason: string): void {
    tx.run('INSERT INTO delegation_control (action, mandate_id, actor_id, reason, at) VALUES (?, ?, ?, ?, ?)', [action, mandateId, actor, reason.slice(0, 500), this.#now()]);
  }

  /**
   * 위임 검토 후보 (프로세스 안, 읽기 전용): 위임이 있는 정책에서 검토 대기 중이고 제안된 초안이 있고 이 해시를 아직 검토하지 않은 업무마다
   * 적격 여부와, 적격이면 AI 에게 줄 자료. 위임이 없는 정책이면 빈 목록 — 아무것도 읽지 않는다.
   */
  delegationScan(): DelegationScanEntry[] {
    const { db } = this.#o;
    if (this.#mandates(db).length === 0) return [];
    const now = this.#now();
    const out: DelegationScanEntry[] = [];
    const candidates = db.all<{ id: string }>(
      `SELECT t.id FROM task t WHERE t.status = 'needs_review'
         AND EXISTS (SELECT 1 FROM effect_draft d WHERE d.task_id = t.id AND d.state = 'proposed') ORDER BY t.updated_at, t.id`,
    );
    for (const { id } of candidates) {
      let ctx: TaskApprovalContext;
      try {
        ctx = this.#taskContext(db, id);
      } catch (error) {
        if (error instanceof ApprovalRefusedError) continue;
        throw error;
      }
      if (db.get('SELECT 1 AS one FROM delegate_review WHERE task_id = ? AND subject_hash = ?', [id, ctx.hash]) !== undefined) continue;
      const eligibility = delegationEligibility(db, this.#delegationCtx(ctx), now);
      if (!eligibility.eligible) {
        out.push({ taskId: id, hash: ctx.hash, eligibility, review: null });
        continue;
      }
      const mask = this.#o.maskPayload ?? maskSecretKeys;
      const history = db.all<{ decision: string; kind: string | null; comment: string | null }>(
        `SELECT a.decision, actor.kind, a.comment FROM approval a LEFT JOIN actor ON actor.id = a.decided_by
         WHERE a.subject_kind = 'task' AND a.subject_id = ? ORDER BY a.at, a.rowid`, [id],
      );
      out.push({
        taskId: id, hash: ctx.hash, eligibility,
        review: {
          objective: ctx.task.objective,
          mandate: { id: eligibility.mandate.id, guidance: eligibility.mandate.guidance, limits: eligibility.mandate.limits },
          drafts: ctx.drafts.map((draft) => ({ id: draft.id, tool: draft.tool, action: draft.action, target: draft.target, payload: mask(JSON.parse(draft.payload)) })),
          history: history.map((row) => ({ decision: row.decision, by: row.kind ?? 'unknown', comment: row.comment === null ? null : row.comment.slice(0, 200) })),
        },
      });
    }
    return out;
  }

  /**
   * 위임 보유자의 결정을 기록한다 (프로세스 안 호출만 — 소켓 명령이 아니다). AI 출력은 신뢰하지 않는 데이터이므로, 같은 트랜잭션에서 적격을 다시 확인하고 그 업무의 지금 해시가 AI 가 본 해시와
   * 같을 때만 기록한다. 결과는 어떤 경우에도 `delegate_review` 에 남는다(적격하지 않거나 해시가 바뀌었으면 사람에게 넘김). 행위자는 위임 보유자로 고정된다 — 호출자가 정하지 못한다.
   *  - approve:         위임 보유자 이름의 승인 행(mandate_id, via='delegate', comment=사유, subject_hash=지금 `show` 해시[초안 포함])을 남긴다. 전송은 위임 cooldown 뒤 `releaseDelegated` 가 연다
   *  - request_changes: `changes_requested` 행을 남기고 초안을 버려 업무를 다시 큐에 넣는다. 위임의 max_rewrites_per_task 를 넘으면 사람에게 넘긴다
   *  - escalate:        사람에게 넘긴다 (승인 행 없음)
   */
  delegateDecide(input: DelegateDecision): DelegateDecideResult {
    const reason = typeof input?.reason === 'string' ? input.reason.trim().slice(0, MAX_DELEGATE_REASON_CHARS) : '';
    if (typeof input?.task_id !== 'string' || typeof input.hash !== 'string' || !DELEGATE_VERDICTS.includes(input.verdict) || reason === '') {
      return { ok: false, code: 'bad_request', error: 'task_id, hash, verdict (approve|request_changes|escalate) and a reason are required' };
    }
    const cost = typeof input.cost_usd === 'number' && Number.isFinite(input.cost_usd) && input.cost_usd > 0 ? input.cost_usd : 0;
    return this.#o.db.writeTx((tx): DelegateDecideResult => {
      let ctx: TaskApprovalContext;
      try {
        ctx = this.#taskContext(tx, input.task_id);
      } catch (error) {
        if (error instanceof ApprovalRefusedError) return { ok: false, code: 'bad_request', error: error.message };
        throw error;
      }
      const now = this.#now();
      const record = (mandateId: string, verdict: DelegateVerdict, why: string, outcome: string, hash: string = ctx.hash): void => {
        tx.run('INSERT INTO delegate_review (task_id, subject_hash, mandate_id, verdict, reason, outcome, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
          input.task_id, hash, mandateId, verdict, why.slice(0, MAX_DELEGATE_REASON_CHARS), outcome, cost, now,
        ]);
      };
      const eligibility = delegationEligibility(tx, this.#delegationCtx(ctx), now);
      if (!eligibility.eligible) {
        if (eligibility.mandateId !== null) record(eligibility.mandateId, 'escalate', eligibility.reason, eligibility.code);
        return { ok: false, code: eligibility.code, error: eligibility.reason };
      }
      const mandate = eligibility.mandate;
      if (input.hash !== ctx.hash) {
        const why = 'AI가 본 내용이 그 사이 바뀌었습니다';
        record(mandate.id, 'escalate', why, 'hash_mismatch', input.hash);
        return { ok: false, code: 'hash_mismatch', error: why };
      }
      if (input.verdict === 'escalate') {
        record(mandate.id, 'escalate', reason, 'recorded');
        return { ok: true, recorded: 'escalated', mandate_id: mandate.id };
      }
      if (input.verdict === 'request_changes') {
        if (rewritesUsed(tx, ctx.task.id, mandate.id) >= mandate.limits.max_rewrites_per_task) {
          const why = `AI가 다시 쓰게 할 수 있는 횟수(업무당 ${mandate.limits.max_rewrites_per_task}번)를 넘었습니다`;
          record(mandate.id, 'escalate', why, 'rewrite_limit');
          return { ok: false, code: 'rewrite_limit', error: why };
        }
        const queued = this.#queueForRewrite(tx, ctx, mandate.holder, reason, { mandateId: mandate.id });
        record(mandate.id, 'request_changes', reason, 'recorded');
        return { ok: true, recorded: 'changes_requested', mandate_id: mandate.id, approval_id: queued['approval_id'] as string };
      }
      const approvalId = this.#insertApproval(tx, 'task', ctx.task.id, 'approved', ctx.hash, mandate.holder, reason, { mandateId: mandate.id });
      const status = approvalStatus(tx, { kind: 'task', id: ctx.task.id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now, authority: ctx.authority });
      if (status.quorumApprovalId === null || status.mandateId == null) throw new Error('internal error: a delegated approval that passed eligibility was not counted');
      tx.run('UPDATE task SET approval_id = ?, approved_snapshot = ?, approved_hash = ?, updated_at = ? WHERE id = ?', [status.quorumApprovalId, JSON.stringify(ctx.subject), ctx.hash, now, ctx.task.id]);
      record(mandate.id, 'approve', reason, 'recorded');
      return { ok: true, recorded: 'approved', mandate_id: mandate.id, approval_id: approvalId, state: status.state, cooldown_ends_at: status.cooldownEndsAt };
    });
  }

  /**
   * 위임 승인이 정족수이고 위임 cooldown 이 끝났고 위임이 아직 유효한 업무를 `needs_review → queued` 로 넘긴다 (데몬 주기가 부른다, 주체 policy + 위임 승인 참조).
   * 정지·철회·만료·정책 변경·초안 만료로 승인이 효력을 잃었으면 넘기지 않는다. 사람 승인(재인증이 필요한)은 건드리지 않는다.
   */
  releaseDelegated(): Array<{ taskId: string; mandateId: string; approvalId: string }> {
    const { db } = this.#o;
    const released: Array<{ taskId: string; mandateId: string; approvalId: string }> = [];
    const waiting = db.all<{ id: string }>(
      "SELECT t.id FROM task t WHERE t.status = 'needs_review' AND t.approved_hash IS NOT NULL AND EXISTS (SELECT 1 FROM approval a WHERE a.subject_kind = 'task' AND a.subject_id = t.id AND a.mandate_id IS NOT NULL) ORDER BY t.updated_at, t.id",
    );
    for (const { id } of waiting) {
      const result = db.writeTx((tx) => {
        let ctx: TaskApprovalContext;
        try {
          ctx = this.#taskContext(tx, id);
        } catch (error) {
          if (error instanceof ApprovalRefusedError) return null;
          throw error;
        }
        const now = this.#now();
        if (ctx.task.status !== 'needs_review' || ctx.task.approved_hash !== ctx.hash) return null;
        if (ctx.drafts.some((draft) => now >= draft.expires_at) || [...ctx.masked.values()].some((paths) => paths.length > 0)) return null;
        const status = approvalStatus(tx, { kind: 'task', id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now, checkReauth: false, authority: ctx.authority });
        if (!status.ok || status.mandateId == null || status.quorumApprovalId === null) return null;
        const mandate = mandatesOf(ctx.document).find((m) => m.id === status.mandateId);
        if (mandate === undefined) return null;
        this.#queue(tx, ctx.task, mandate.holder, status.quorumApprovalId, {}, `released after the delegation cooldown (mandate ${mandate.id})`, 'policy');
        return { taskId: id, mandateId: mandate.id, approvalId: status.quorumApprovalId };
      });
      if (result !== null) released.push(result);
    }
    return released;
  }

  /** 사람 명령 `delegation` (소켓): status 는 읽기, pause·revoke 는 강화라 TOTP 없이, resume 은 TOTP */
  #delegation(c: Extract<ApprovalCommand, { cmd: 'delegation' }>): Record<string, unknown> {
    const { db } = this.#o;
    if (c.op === 'status') return this.#delegationStatus(db);
    return db.writeTx((tx) => {
      const mandates = this.#mandates(tx);
      if (c.mandate_id !== undefined && !mandates.some((mandate) => mandate.id === c.mandate_id)) {
        refuse(`mandate '${c.mandate_id}' is not in the deployed policy`, 'bad_request');
      }
      const controls = readDelegationControls(tx);
      const paused = (scope: string | null): boolean => controls.filter((row) => row.action !== 'revoke' && row.mandate_id === scope).at(-1)?.action === 'pause';
      const scope = c.mandate_id ?? null;
      const reason = c.comment?.trim() ? c.comment.trim() : `${c.op} by ${c.actor}`;
      if (c.op === 'pause') {
        if (!paused(scope)) this.#insertControl(tx, 'pause', scope, c.actor, reason);
        return { state: 'paused', mandate_id: scope };
      }
      if (c.op === 'revoke') {
        const ids = c.mandate_id !== undefined ? [c.mandate_id] : mandates.map((mandate) => mandate.id);
        if (ids.length === 0) refuse('there is no mandate in the deployed policy to revoke', 'bad_request');
        const done: string[] = [];
        for (const id of ids) {
          if (mandateStop(controls, id) === 'revoked') continue;
          this.#insertControl(tx, 'revoke', id, c.actor, reason);
          done.push(id);
        }
        return { state: 'revoked', mandate_ids: done };
      }
      if (c.mandate_id !== undefined && mandateStop(controls, c.mandate_id) === 'revoked') refuse(`mandate '${c.mandate_id}' was revoked and cannot be resumed; declare it again in the policy under a new id`, 'wrong_state');
      if (!paused(scope)) refuse(scope === null ? 'delegation is not paused as a whole' : `mandate '${scope}' is not paused`, 'wrong_state');
      this.#reauth(tx, c.actor, c.totp, `delegation-resume:${scope ?? '*'}`, 'a TOTP code is required to resume delegation');
      this.#insertControl(tx, 'resume', scope, c.actor, reason);
      return { state: 'resumed', mandate_id: scope, note: scope !== null && paused(null) ? 'delegation is still paused as a whole' : undefined };
    });
  }

  #delegationStatus(db: Db): Record<string, unknown> {
    const mandates = this.#mandates(db);
    const controls = readDelegationControls(db);
    const now = this.#now();
    const since = new Date(Date.parse(now) - DELEGATION_WINDOW_MS).toISOString();
    return {
      enabled: mandates.length > 0,
      mandates: mandates.map((mandate) => {
        const stop = mandateStop(controls, mandate.id);
        const expired = (mandateExpiresAt(mandate.expires) ?? '') < now;
        return {
          id: mandate.id, holder: mandate.holder, expires: mandate.expires, cooldown: mandate.cooldown, limits: mandate.limits,
          state: stop ?? (expired ? 'expired' : 'active'),
          approved_24h: Number(db.get<{ n: number }>("SELECT count(*) AS n FROM approval WHERE mandate_id = ? AND decision = 'approved' AND at > ?", [mandate.id, since])?.n ?? 0),
          review_usd_24h: Number(db.get<{ total: number }>('SELECT coalesce(sum(cost_usd), 0) AS total FROM delegate_review WHERE mandate_id = ? AND at > ?', [mandate.id, since])?.total ?? 0),
        };
      }),
      paused_all: controls.filter((row) => row.action !== 'revoke' && row.mandate_id === null).at(-1)?.action === 'pause',
      recent_controls: controls.slice(-10).map((row: DelegationControlRow) => ({ action: row.action, mandate_id: row.mandate_id, actor: row.actor_id, reason: row.reason, at: row.at })),
    };
  }

  #show(kind: ApprovalSubject, id: string): Record<string, unknown> {
    const { db } = this.#o;
    if (kind === 'task') {
      const ctx = this.#taskContext(db, id);
      const status = approvalStatus(db, { kind: 'task', id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now(), authority: ctx.authority });
      return {
        kind, id, status: ctx.task.status, hash: ctx.hash, subject: ctx.subject, policy_version: ctx.policy.versionId,
        // 제안된 초안 (ADR-0015). payload 는 저장된 JSON 원문이다 — 비밀 가리기는 표시하는 쪽(CLI, 검토 화면)이 한다
        drafts: ctx.drafts.map((draft) => ({
          id: draft.id, seq: draft.seq, tool: draft.tool, action: draft.action, target: draft.target, payload_hash: draft.payload_hash,
          expires_at: draft.expires_at, expired: this.#now() >= draft.expires_at, influenced_by_external_input: draft.influenced_by_external_input === 1,
          // 표시용 가리기가 바꾸는 값의 경로 (비어 있어야 승인할 수 있다), 원장의 전송 상태 (none|planned|dispatched|confirmed|failed|unknown|compensated)
          masked_paths: ctx.masked.get(draft.id) ?? [], send_state: ctx.sendStates.get(draft.id) ?? 'none',
          payload: JSON.parse(draft.payload) as unknown,
        })),
        decisions: ctx.verdicts.map((v) => ({ action: v.request.action, resource: v.request.resource, scope: v.request.scope, impact: v.request.impact, decision: v.verdict.decision, reason: v.verdict.reason })),
        approval: {
          state: status.state, reason: status.reason, approvers: status.approvers, cooldown_ends_at: status.cooldownEndsAt,
          // 위임 승인이 정족수면 그 위임 id (ADR-0016, 제안). 사람 승인이면 키가 없다
          ...(status.mandateId == null ? {} : { mandate_id: status.mandateId }),
        },
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
    if (kind === 'org_proposal') {
      const ctx = this.#org(db, id);
      const status = approvalStatus(db, { kind, id, hash: ctx.hash, requesterId: ctx.requester, params: ctx.params, now: this.#now() });
      return {
        kind, id, status: ctx.row.status, hash: ctx.hash, change_class: ctx.row.change_class, subject: ctx.subject, policy_version: ctx.policy.versionId,
        diff: JSON.parse(ctx.row.diff), rationale: ctx.row.rationale, expected_effect: ctx.row.expected_effect, risk_assessment: JSON.parse(ctx.row.risk_assessment),
        trial_scope: JSON.parse(ctx.row.trial_scope), evaluation_plan: JSON.parse(ctx.row.evaluation_plan), rollback_plan: JSON.parse(ctx.row.rollback_plan),
        expires_at: ctx.row.expires_at, approval: { state: status.state, reason: status.reason, approvers: status.approvers, cooldown_ends_at: status.cooldownEndsAt },
      };
    }
    const latest = db.get<{ subject_hash: string | null }>(
      "SELECT subject_hash FROM approval WHERE subject_kind = 'policy_version' AND subject_id = ? AND decision = 'approved' ORDER BY at DESC, rowid DESC LIMIT 1", [id],
    ) ?? refuse(`no policy proposal '${id}'`, 'bad_request');
    const parsed = this.#o.store.byHash(latest.subject_hash ?? '') ?? refuse(`the content of policy proposal '${id}' is not in the policy store`, 'bad_request');
    const current = this.#policy(db);
    const change = classifyChange(current.document, parsed.document);
    const status = approvalStatus(db, { kind, id, hash: parsed.hash, requesterId: null, params: policyApprovalParams(current.document, change), now: this.#now() });
    return { kind, id, hash: parsed.hash, change_class: change.changeClass, reasons: change.reasons, approval: { state: status.state, reason: status.reason, cooldown_ends_at: status.cooldownEndsAt } };
  }

  #list(): Record<string, unknown> {
    const { db } = this.#o;
    const tasks = db.all<{ id: string; objective: string; reason: string | null; drafts: number }>(
      `SELECT t.id, t.objective, (SELECT reason FROM task_transition x WHERE x.task_id = t.id ORDER BY x.id DESC LIMIT 1) AS reason,
         (SELECT count(*) FROM effect_draft d WHERE d.task_id = t.id AND d.state = 'proposed') AS drafts
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
    const orgProposals = db.all<{ id: string; change_class: string; created_at: string }>("SELECT id, change_class, created_at FROM org_proposal WHERE status = 'proposed' ORDER BY created_at, id");
    return { tasks, publications, policy_proposals: policies.map((p) => p.subject_id), strategy_proposals: strategies, strategy_reviews: reviews, experiments, org_proposals: orgProposals };
  }
}

/** 승인·해제 직전 점검의 판단만 (읽기 전용): 만료됐거나 기준 버전이 더 이상 active 가 아니면 그 사유. 전이 기록은 엔진이 한다. 읽기 전용 검토 화면도 쓴다 */
export function orgProposalStaleness(db: Db, row: OrgProposalRow, now: string): { to: 'expired' | 'superseded'; reason: string; note: string } | null {
  if (now >= row.expires_at) return { to: 'expired', reason: 'expires_at passed', note: 'the proposal expired before it was approved; propose again' };
  const current = activeOrgVersion(db);
  if (!current || current.id !== row.base_org_version_id) {
    return { to: 'superseded', reason: `base org_version is no longer active (now ${current?.id ?? 'none'})`, note: 'the organization changed since this proposal was made; propose again on the latest org_version' };
  }
  return null;
}

/**
 * 정책 배포의 승인 요건: 지금(변경 전) 정책의 risky_change. 단, 위임을 추가·확대하는 변경은 지금 정책이 재인증을 꺼 두었어도 항상 TOTP 재인증을 요구한다
 * (ADR-0016: AI 가 사람 대신 결정할 범위를 넓히는 일이다). 이유 문구는 change.ts 의 `delegation ...` 으로 시작한다.
 */
function policyApprovalParams(current: PolicyDocument, change: { reasons: readonly string[] }): ApprovalParams {
  const params = riskyApprovalParams(current);
  return change.reasons.some((reason) => reason.startsWith('delegation ')) ? { ...params, reauth_before_effect: true } : params;
}

function requireHuman(db: Db, actorId: unknown): void {
  if (typeof actorId !== 'string' || actorId === '') refuse('an actor id is required', 'bad_request');
  const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId as string]);
  if (!actor) refuse(`unknown actor '${String(actorId)}'`, 'not_human');
  if (actor!.kind !== 'human') refuse(`only human actors can use the approval channel; '${String(actorId)}' is '${actor!.kind}'`, 'not_human');
}

function assertAllowed(from: 'needs_review' | 'queued', to: 'queued' | 'needs_review' | 'failed', approvalId: string, by: 'human' | 'policy' = 'human'): void {
  const check = checkTransition(TASK_MACHINE, { from, to, by, approvalId, reason: 'approval channel' });
  if (!check.ok) refuse(check.message, 'wrong_state');
}

const SUBJECTS: readonly string[] = ['task', 'publication', 'policy_version', 'strategy_version', 'org_proposal'];
/** 소켓이 받는 명령. 위임 보유자의 결정(`delegateDecide`)은 여기 없다 — 프로세스 안 호출만 가능하다 */
const CMDS: readonly string[] = ['whoami', 'list', 'show', 'approve', 'release', 'cancel', 'reject', 'request_changes', 'delegation'];
const DELEGATION_OPS: readonly string[] = ['status', 'pause', 'resume', 'revoke'];
const MANDATE_ID_ARG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH_ARG = /^[0-9a-f]{64}$/;

/** 변경 요청 사유의 길이 (앞뒤 공백을 자른 뒤) */
export const MAX_CHANGE_REQUEST_CHARS = 500;

function parseCommand(raw: unknown): ApprovalCommand {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('a request must be a JSON object', 'bad_request');
  const c = raw as Record<string, unknown>;
  if (typeof c['cmd'] !== 'string' || !CMDS.includes(c['cmd'])) refuse(`cmd must be one of ${CMDS.join('|')}`, 'bad_request');
  if (typeof c['actor'] !== 'string') refuse('actor is required', 'bad_request');
  const cmd = c['cmd'] as ApprovalCommand['cmd'];
  const actor = c['actor'] as string;
  // via(자기 신고 값, 감사용)는 모르는 값이면 거부한다. 알 수 없는 *다른* 필드는 지금처럼 무시한다
  if (c['via'] !== undefined && !(DECISION_VIA as readonly unknown[]).includes(c['via'])) refuse(`via must be one of ${DECISION_VIA.join('|')}`, 'bad_request');
  const via: { via?: DecisionVia } = c['via'] === undefined ? {} : { via: c['via'] as DecisionVia };
  if (cmd === 'whoami' || cmd === 'list') return { cmd, actor, ...via };
  const optional = (key: string): { [k: string]: string } => (typeof c[key] === 'string' ? { [key]: c[key] as string } : {});
  if (cmd === 'delegation') {
    if (typeof c['op'] !== 'string' || !DELEGATION_OPS.includes(c['op'])) refuse(`op must be one of ${DELEGATION_OPS.join('|')}`, 'bad_request');
    if (c['mandate_id'] !== undefined && (typeof c['mandate_id'] !== 'string' || !MANDATE_ID_ARG.test(c['mandate_id']))) refuse('mandate_id must be a mandate id', 'bad_request');
    return { cmd, actor, op: c['op'] as 'status' | 'pause' | 'resume' | 'revoke', ...optional('mandate_id'), ...optional('comment'), ...optional('totp'), ...via };
  }
  if (typeof c['kind'] !== 'string' || !SUBJECTS.includes(c['kind'])) refuse(`kind must be one of ${SUBJECTS.join('|')}`, 'bad_request');
  const kind = c['kind'] as ApprovalSubject;
  if (cmd === 'approve' && kind === 'policy_version') {
    if (typeof c['policy_text'] !== 'string') refuse('policy_text is required', 'bad_request');
    return { cmd, actor, kind, policy_text: c['policy_text'] as string, ...optional('comment'), ...via };
  }
  if (typeof c['id'] !== 'string' || c['id'] === '') refuse('id is required', 'bad_request');
  const id = c['id'] as string;
  if (cmd === 'approve') {
    if (typeof c['hash'] !== 'string') refuse('hash is required (from `show`)', 'bad_request');
    return { cmd, actor, kind: kind as 'task' | 'publication' | 'strategy_version' | 'org_proposal', id, hash: c['hash'] as string, ...optional('comment'), ...via };
  }
  if (cmd === 'show') return { cmd, actor, kind, id, ...via };
  // 낡은 결정 막기: reject·cancel·request_changes·release 는 선택 필드 expected_hash(show 의 hash)를 받는다
  if (c['expected_hash'] !== undefined && (typeof c['expected_hash'] !== 'string' || !HASH_ARG.test(c['expected_hash']))) refuse('expected_hash must be the 64-hex hash from `show`', 'bad_request');
  const expecting: { expected_hash?: string } = c['expected_hash'] === undefined ? {} : { expected_hash: c['expected_hash'] as string };
  if (cmd === 'request_changes') {
    if (kind !== 'task') refuse('request_changes applies to a task (kind task)', 'bad_request');
    const reason = typeof c['comment'] === 'string' ? c['comment'].trim() : '';
    if (reason === '' || reason.length > MAX_CHANGE_REQUEST_CHARS) refuse(`a comment of 1 to ${MAX_CHANGE_REQUEST_CHARS} characters is required (why the draft must change)`, 'bad_request');
    return { cmd, actor, kind: 'task', id, comment: reason, ...expecting, ...via };
  }
  if (cmd === 'release') return { cmd, actor, kind, id, ...optional('totp'), ...expecting, ...via };
  return { cmd, actor, kind, id, ...optional('comment'), ...expecting, ...via };
}
