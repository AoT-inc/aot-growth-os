// 조직 변경 채널 (Phase B / B5): 사람 승인 채널(Unix 소켓, trust-boundaries §3.1)에 얹은 `org` 명령. 소켓 처리기 조합(assemble.ts)이 `cmd:'org'` 요청만 여기로 보낸다.
// 인증 경계는 승인 CLI 와 같다 — 소켓 파일 권한 + 요청 actor 의 `actor.kind='human'` 확인(에이전트는 소켓이 보이지 않고, 여기서 한 번 더 확인한다).
// 제안의 *승인*(proposed → approved)·거절·취소·위험 변경 해제는 승인 엔진의 `approve|reject|cancel|release org_proposal` 이 한다(해시 확인·대기·TOTP).
// 이 채널이 하는 일:
//   {cmd:'org', actor, op:'propose', draft:{task_type, role_slug, unit?}}  신호에서 제안서를 자동으로 만들어 등록 (JSON 을 쓸 필요 없음: 도구는 generalist 와 같게 =
//                                                              권한 확대 없음, 평가·롤백 계획은 기본값, 근거는 unassigned 업무 건수). 사람은 `show` 로 보고 승인만 한다
//   {cmd:'org', actor, op:'propose', proposal:{...}}           제안서를 직접 쓴 경우의 등록 (권한이 다른 역할 등 기본값으로 안 되는 경우)
//   {cmd:'org', actor, op:'signals'}                           재편 신호 집계 (모델 호출 없음)
//   {cmd:'org', actor, op:'status', id?}                       제안 목록/상세 + 시험 판정 기록
//   {cmd:'org', actor, op:'confirm', id, comment}              시험 평가 pass 뒤 사람 확인 → trial → active
//   {cmd:'org', actor, op:'retrial', id, evaluation_plan, comment}  inconclusive → trial (새 평가 계획, 연장 1회 상한)
//   {cmd:'org', actor, op:'rollback', id, comment}             확정된(active) 변경을 되돌린다 (사유 필수)
//   {cmd:'org', actor, op:'retire', id, comment}               확정된 변경의 역할·부서를 폐지한다 (삭제가 아니다, 사유 필수)
// 확인·재시험은 사람의 `approval` 행(subject_kind='org_proposal')을 남기고 같은 트랜잭션에서 전이한다. 시각은 주입된 Clock 에서만 얻는다.
import { randomUUID } from 'node:crypto';

import {
  createOrgProposal, getOrgProposal, ORG_SIGNAL_THRESHOLDS, OrgRuleError, taskTypeOf, transitionOrgProposal, TransitionError,
  type Clock, type Db, type OrgProposalInput,
} from '@aot/domain';

export interface OrgChannelOptions {
  db: Db;
  clock: Clock;
}

const OPS = ['propose', 'signals', 'status', 'confirm', 'retrial', 'rollback', 'retire'] as const;
const KEYS = ['cmd', 'actor', 'op', 'proposal', 'draft', 'id', 'comment', 'evaluation_plan'];
const DRAFT_KEYS = ['task_type', 'role_slug', 'unit'];
const PROPOSAL_KEYS = [
  'diff', 'rationale', 'evidence_refs', 'expected_effect', 'risk_assessment', 'evaluation_plan', 'rollback_plan', 'trial_scope', 'trial_min_days', 'ttl_days',
];
const DAY_MS = 86_400_000;

class Refused extends Error {}
const refuse = (message: string): never => {
  throw new Refused(message);
};

export function isOrgCommand(request: unknown): boolean {
  return typeof request === 'object' && request !== null && !Array.isArray(request) && (request as Record<string, unknown>)['cmd'] === 'org';
}

function requireHuman(db: Db, actorId: unknown): string {
  if (typeof actorId !== 'string' || actorId === '') refuse('an actor id is required');
  const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId as string]);
  if (!actor) refuse(`unknown actor '${String(actorId)}'`);
  if (actor!.kind !== 'human') refuse(`only human actors can use the organization channel; '${String(actorId)}' is '${actor!.kind}'`);
  return actorId as string;
}

/** 재편 신호 (ADR-0011 §5, 임계값 Q13 잠정값): unassigned 업무 유형별 건수, 역할별 반복 needs_review·failed. 읽기 전용 */
export function orgSignals(db: Db, clock: Clock): Record<string, unknown> {
  const since = new Date(clock.nowMs() - ORG_SIGNAL_THRESHOLDS.window_days * DAY_MS).toISOString();
  const byType = new Map<string, number>();
  for (const task of db.all<{ trigger_kind: string; trigger_ref: string }>("SELECT trigger_kind, trigger_ref FROM task WHERE status = 'unassigned' AND created_at >= ?", [since])) {
    const type = taskTypeOf({ kind: task.trigger_kind, ref: task.trigger_ref });
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  const unassigned = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([task_type, count]) => ({
    task_type, count, candidate: count >= ORG_SIGNAL_THRESHOLDS.unassigned, hint: 'a role for this task type may be missing (add_role)',
  }));
  const roleProblems = db.all<{ slug: string; needs_review: number; failed: number }>(
    `SELECT r.slug, SUM(t.status = 'needs_review') AS needs_review, SUM(t.status = 'failed') AS failed
     FROM task t JOIN role r ON r.id = t.role_id WHERE t.created_at >= ? AND t.status IN ('needs_review', 'failed') GROUP BY r.slug ORDER BY r.slug`, [since],
  ).map((row) => ({
    role: row.slug, needs_review: Number(row.needs_review), failed: Number(row.failed),
    candidate: Number(row.needs_review) + Number(row.failed) >= ORG_SIGNAL_THRESHOLDS.role_problems, hint: 'repeated problems: the role scope may need adjusting',
  }));
  return { window_days: ORG_SIGNAL_THRESHOLDS.window_days, thresholds: ORG_SIGNAL_THRESHOLDS, unassigned, role_problems: roleProblems };
}

/**
 * 재편 신호에서 제안서를 만든다 (사람이 JSON 을 쓰지 않게). 맞는 역할이 없어 unassigned 인 업무가 이 유형으로 있어야 한다(근거).
 * 새 역할의 도구는 지금 `generalist` 와 같다 → 권한 확대가 아니라 일반 변경이다. 평가·롤백 기본값은 phase-b.md 와 같다.
 * 새 부서가 필요하면 `unit` 에 새 slug 를, 기존 부서에 넣으려면 기존 slug 를 준다(기본은 `core`).
 */
export function draftProposalFromSignal(db: Db, clock: Clock, draft: { taskType: string; roleSlug: string; unit?: string }): Record<string, unknown> {
  const since = new Date(clock.nowMs() - ORG_SIGNAL_THRESHOLDS.window_days * DAY_MS).toISOString();
  const count = db.all<{ trigger_kind: string; trigger_ref: string }>("SELECT trigger_kind, trigger_ref FROM task WHERE status = 'unassigned' AND created_at >= ?", [since])
    .filter((task) => taskTypeOf({ kind: task.trigger_kind, ref: task.trigger_ref }) === draft.taskType).length;
  if (count === 0) refuse(`there is no unassigned task of type '${draft.taskType}' in the last ${ORG_SIGNAL_THRESHOLDS.window_days} days (see \`org signals\`)`);
  const base = db.get<{ allowed_tools: string }>("SELECT allowed_tools FROM role WHERE slug = 'generalist' AND lifecycle = 'active'") ?? refuse("the default tool set comes from the active 'generalist' role, which does not exist");
  const unitSlug = draft.unit ?? 'core';
  const unit = db.get('SELECT 1 AS one FROM org_unit WHERE slug = ? AND lifecycle = \'active\'', [unitSlug])
    ? unitSlug : { slug: unitSlug, name: unitSlug, responsibility: `${draft.taskType} 업무 담당` };
  return {
    diff: { ops: [{ op: 'add_role', role: { slug: draft.roleSlug, description: `${draft.taskType} 업무 담당 (재편 신호로 자동 생성한 초안)`, allowed_tools: JSON.parse(base!.allowed_tools) as unknown, unit } }] },
    rationale: `최근 ${ORG_SIGNAL_THRESHOLDS.window_days}일 동안 '${draft.taskType}' 유형의 업무 ${count}건이 맞는 역할이 없어 멈춰 있었다.`,
    evidence_refs: [`signals:unassigned:${draft.taskType}`],
    expected_effect: `'${draft.taskType}' 업무가 새 역할에 배정되어 처리된다.`,
    risk_assessment: { risks: ['새 역할의 결과 품질이 낮을 수 있다'], mitigations: ['시험 기간에는 이 업무 유형만 받는다', '안전성 실패·비용 초과는 즉시 중단·롤백된다'] },
    evaluation_plan: { min_pass_rate: 0.8, min_observations: 3, max_cost_usd: 5, baseline_window_days: 30, evaluation_days: 14 },
    rollback_plan: { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: 'generalist' }, running_tasks: 'finish', external_effects: 'human' },
    trial_scope: { task_types: [draft.taskType] },
  };
}

export function createOrgChannel(options: OrgChannelOptions): (request: unknown) => Record<string, unknown> {
  const { db, clock } = options;
  const insertApproval = (tx: Db, id: string, hash: string, actor: string, comment: string): string => {
    const approvalId = `approval-${randomUUID()}`;
    tx.run('INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      approvalId, 'org_proposal', id, 'approved', hash, actor, comment.slice(0, 500), clock.nowIso(),
    ]);
    return approvalId;
  };
  return (raw) => {
    try {
      const request = raw as Record<string, unknown>;
      const actor = requireHuman(db, request['actor']);
      const unknown = Object.keys(request).filter((key) => !KEYS.includes(key));
      if (unknown.length > 0) refuse(`unknown field(s): ${unknown.join(', ')}`);
      const op = OPS.find((candidate) => candidate === request['op']) ?? refuse(`op must be one of ${OPS.join('|')}`);
      if (op === 'signals') return { ok: true, ...orgSignals(db, clock) };
      if (op === 'propose') {
        let body = request['proposal'];
        if ((body === undefined) === (request['draft'] === undefined)) refuse('give exactly one of proposal (a full proposal) or draft ({task_type, role_slug, unit?})');
        if (request['draft'] !== undefined) {
          const d = request['draft'];
          if (typeof d !== 'object' || d === null || Array.isArray(d)) return refuse('draft must be an object');
          const bad = Object.keys(d).filter((key) => !DRAFT_KEYS.includes(key));
          if (bad.length > 0) refuse(`draft has unknown field(s): ${bad.join(', ')}`);
          const f = d as Record<string, unknown>;
          if (typeof f['task_type'] !== 'string' || typeof f['role_slug'] !== 'string') refuse('draft needs task_type and role_slug');
          if (f['unit'] !== undefined && typeof f['unit'] !== 'string') refuse('draft.unit must be a unit slug');
          body = draftProposalFromSignal(db, clock, { taskType: f['task_type'] as string, roleSlug: f['role_slug'] as string, ...(f['unit'] === undefined ? {} : { unit: f['unit'] as string }) });
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse('proposal must be an object');
        const extra = Object.keys(body).filter((key) => !PROPOSAL_KEYS.includes(key));
        if (extra.length > 0) refuse(`proposal has unknown field(s): ${extra.join(', ')}`);
        const p = body as Record<string, unknown>;
        const input: OrgProposalInput = {
          proposedBy: actor, diff: p['diff'], rationale: p['rationale'] as string, evidenceRefs: p['evidence_refs'], expectedEffect: p['expected_effect'] as string,
          riskAssessment: p['risk_assessment'], evaluationPlan: p['evaluation_plan'], rollbackPlan: p['rollback_plan'], trialScope: p['trial_scope'],
          ...(p['trial_min_days'] === undefined ? {} : { trialMinDays: p['trial_min_days'] as number }),
          ...(p['ttl_days'] === undefined ? {} : { ttlDays: p['ttl_days'] as number }),
        };
        const created = db.writeTx((tx) => createOrgProposal(tx, clock, input));
        return {
          ok: true, proposal_id: created.proposalId, created: created.created, change_class: created.changeClass, reasons: created.riskReasons,
          next: `approve it with \`show org_proposal ${created.proposalId}\` then \`approve org_proposal ${created.proposalId} --hash <hash>\`${created.changeClass === 'risky' ? ' (risky: cooldown, then `release` with TOTP)' : ''}`,
        };
      }
      if (op === 'status') {
        const id = typeof request['id'] === 'string' && request['id'] !== '' ? request['id'] : null;
        const rowsFor = (where: string, params: string[]) => db.all<{ id: string; status: string; change_class: string; trial_extensions: number; expires_at: string; org_version_id: string | null; scope: string }>(
          `SELECT id, status, change_class, trial_extensions, expires_at, org_version_id, scope FROM org_proposal ${where} ORDER BY created_at, id`, params,
        );
        const rows = id === null ? rowsFor('', []) : rowsFor('WHERE id = ?', [id]);
        if (id !== null && rows.length === 0) return refuse(`org_proposal '${id}' does not exist`);
        const proposals = rows.map((row) => ({
          id: row.id, status: row.status, change_class: row.change_class, trial_extensions: row.trial_extensions, expires_at: row.expires_at, org_version_id: row.org_version_id,
          scope: JSON.parse(row.scope) as unknown,
          results: db.all<{ outcome: string; abort_reason: string | null; observations: number; at: string; metrics: string }>(
            'SELECT outcome, abort_reason, observations, at, metrics FROM org_trial_result WHERE proposal_id = ? ORDER BY at, rowid', [row.id],
          ).map((result) => ({ outcome: result.outcome, abort_reason: result.abort_reason, observations: result.observations, at: result.at, metrics: JSON.parse(result.metrics) as unknown })),
        }));
        return { ok: true, proposals };
      }
      const id = typeof request['id'] === 'string' && request['id'] !== '' ? request['id'] : refuse('an id is required');
      const comment = typeof request['comment'] === 'string' && request['comment'].trim() !== '' ? request['comment'].trim() : refuse('a reason (--comment) is required');
      const row = getOrgProposal(db, id) ?? refuse(`org_proposal '${id}' does not exist`);
      if (op === 'confirm') {
        const result = db.writeTx((tx) => {
          const approvalId = insertApproval(tx, id, row.proposal_hash, actor, `confirmed: ${comment}`);
          return { approvalId, ...transitionOrgProposal(tx, clock, { proposalId: id, to: 'active', by: 'system', actorId: actor, approvalId, reason: comment }) };
        });
        return { ok: true, proposal_id: id, status: 'active', org_version_id: result.orgVersionId, approval_id: result.approvalId };
      }
      if (op === 'retrial') {
        if (request['evaluation_plan'] === undefined) refuse('a new evaluation_plan is required');
        const result = db.writeTx((tx) => {
          const approvalId = insertApproval(tx, id, row.proposal_hash, actor, `retrial: ${comment}`);
          return { approvalId, ...transitionOrgProposal(tx, clock, { proposalId: id, to: 'trial', by: 'human', actorId: actor, approvalId, reason: comment, evaluationPlan: request['evaluation_plan'] }) };
        });
        return { ok: true, proposal_id: id, status: 'trial', approval_id: result.approvalId };
      }
      if (op === 'rollback' || op === 'retire') {
        const result = db.writeTx((tx) => transitionOrgProposal(tx, clock, { proposalId: id, to: op === 'rollback' ? 'rolled_back' : 'retired', by: 'human', actorId: actor, reason: comment }));
        return { ok: true, proposal_id: id, status: result.to, rerouted_task_ids: result.reroutedTaskIds, disabled_routine_ids: result.disabledRoutineIds, note: op === 'rollback' ? 'external effects already sent are not undone; handle them by hand' : 'roles and units are retired, not deleted' };
      }
      return refuse(`unknown op '${String(request['op'])}'`);
    } catch (error) {
      if (error instanceof Refused) return { ok: false, error: error.message };
      if (error instanceof OrgRuleError || error instanceof TransitionError) return { ok: false, error: error.message, code: error.code };
      throw error;
    }
  };
}
