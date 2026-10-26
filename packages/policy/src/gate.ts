// TaskPolicyGate(domain 포트)의 실제 구현. apps/daemon 이 조립해 task-engine 에 넘긴다.
//  - beforeCreate: 명세의 모든 요청(도구 × 작업)을 현재 정책으로 판정. deny 가 하나라도 있으면 생성 거부
//  - beforeRun:    실행 직전 재검증 — 현재 정책으로 다시 판정(정책이 강화됐으면 새 정책이 적용된다), 예산 잔여,
//                  require_approval 이면 승인 확인(approved_hash = 현재 대상 해시, 정책 버전, 승인자 수, cooldown, 재인증)
//  - beforeEffect: 부작용 직전 재검증 — 요청에 있던 도구·작업·대상인지, 영향이 external_effect 로 선언됐는지, 판정과 승인.
//                  `failed` 재전송은 정책 판정이 allow 일 때만 (승인은 한 번의 전송에 대한 것이므로 재전송을 덮지 않는다)
// 모든 판정은 policy_decision 에 남는다. 판정할 정책 내용을 찾지 못하면 거부한다(기본 거부).
import type { Db, TaskPolicyGate, TaskRow, TaskSpec } from '@aot/domain';

import { approvalStatus, taskRequester, taskSubject, taskSubjectHash, type ApprovalStatus } from './approval.ts';
import { recordDecision, recordVerdict } from './decisions.ts';
import { evaluateRequest, requestOf, requestsFromSpec, taskApprovalParams, type PolicyRequest, type PolicyVerdict } from './evaluate.ts';
import type { ActivePolicy, PolicyStore } from './store.ts';

export interface PolicyGateOptions {
  store: PolicyStore;
}

export function createPolicyGate(options: PolicyGateOptions): TaskPolicyGate {
  const { store } = options;

  const activeOrNull = (tx: Db): { policy: ActivePolicy } | { missing: string; versionId: string | null } => {
    const active = store.active(tx);
    if (!active) return { missing: 'no policy_version is deployed', versionId: null };
    if (!active.policy) return { missing: `content for policy_version '${active.versionId}' (hash ${active.contentHash.slice(0, 12)}…) was not found or does not match`, versionId: active.versionId };
    return { policy: active.policy };
  };

  const recordMissing = (tx: Db, spec: TaskSpec, versionId: string | null, reason: string, now: string, taskId: string | null) => {
    if (versionId === null) return;
    for (const request of requestsFromSpec(spec)) {
      recordDecision(tx, { taskId, request, decision: 'deny', reason: `${reason}; default deny`, approvalRequired: null, policyVersionId: versionId, now });
    }
  };

  return {
    beforeCreate(tx, { spec, taskId, now }) {
      const found = activeOrNull(tx);
      if ('missing' in found) {
        const reason = `${found.missing}; default deny`;
        return { decision: 'deny', reason, recordRefusal: (t) => recordMissing(t, spec, found.versionId, found.missing, now, null) };
      }
      const { policy } = found;
      const requests = requestsFromSpec(spec);
      const verdicts = requests.map((request) => evaluateRequest(policy.document, request));
      const budget = budgetCap(policy, spec);
      const denied = verdicts.filter((v) => v.decision === 'deny');
      if (denied.length > 0 || budget) {
        const reasons = [...(budget ? [budget] : []), ...denied.map((v) => v.reason)];
        return {
          decision: 'deny',
          reason: `denied by policy ${policy.versionId}: ${reasons.join('; ')}`.slice(0, 1000),
          recordRefusal: (t) => requests.forEach((request, i) => recordVerdict(t, { policyVersionId: policy.versionId, now }, request, verdicts[i]!)),
        };
      }
      requests.forEach((request, i) => recordVerdict(tx, { taskId, policyVersionId: policy.versionId, now }, request, verdicts[i]!));
      return { decision: 'allow' };
    },

    beforeRun(tx, { task, spec, now }) {
      const found = activeOrNull(tx);
      if ('missing' in found) {
        recordMissing(tx, spec, found.versionId, found.missing, now, task.id);
        return { decision: 'needs_review', reason: `${found.missing}; default deny` };
      }
      const { policy } = found;
      const requests = requestsFromSpec(spec);
      const verdicts = requests.map((request) => evaluateRequest(policy.document, request));
      const budget = budgetCap(policy, spec) ?? budgetSpent(tx, task);
      const denied = verdicts.filter((v) => v.decision === 'deny');
      const needsApproval = verdicts.some((v) => v.decision === 'require_approval');
      const approval = denied.length === 0 && needsApproval ? verifyTaskApproval(tx, task, spec, policy, now) : null;
      requests.forEach((request, i) => {
        const verdict = verdicts[i]!;
        const suffix = verdict.decision === 'require_approval' && approval ? `; approval: ${approval.ok ? 'valid' : approval.reason}` : '';
        recordDecision(tx, {
          taskId: task.id, request, decision: verdict.decision, reason: `${verdict.reason}${suffix} (re-check before run)`,
          approvalRequired: verdict.approval, policyVersionId: policy.versionId, now,
        });
      });
      if (budget) return { decision: 'needs_review', reason: budget };
      if (denied.length > 0) return { decision: 'needs_review', reason: `denied by the current policy ${policy.versionId}: ${denied.map((v) => v.reason).join('; ')}`.slice(0, 1000) };
      if (approval && !approval.ok) return { decision: 'needs_review', reason: approval.reason };
      return { decision: 'allow' };
    },

    beforeEffect(tx, { task, spec, runId, tool, action, target, dispatch, now }) {
      const found = activeOrNull(tx);
      if ('missing' in found) return { decision: 'refuse', reason: `${found.missing}; default deny` };
      const { policy } = found;
      const base = { taskId: task.id, taskRunId: runId, policyVersionId: policy.versionId, now };
      const entry = spec.allowed_tools.find((t) => t.tool === tool && t.operations.includes(action) && (t.target === undefined || t.target === target));
      if (!entry) {
        const request: PolicyRequest = { ...requestOf(spec, { tool }, action), resource: target, impact: 'external_effect' };
        const reason = `${tool}.${action} on ${target} was not requested in allowed_tools (tool, operation and target must match)`;
        recordDecision(tx, { ...base, request, decision: 'deny', reason, approvalRequired: null });
        return { decision: 'refuse', reason };
      }
      const request = requestOf(spec, entry, action, { resource: target });
      if (entry.impact !== 'external_effect') {
        const reason = `${tool}.${action} was requested with impact '${entry.impact ?? '(none)'}' but performs an external effect`;
        recordDecision(tx, { ...base, request, decision: 'deny', reason, approvalRequired: null });
        return { decision: 'refuse', reason };
      }
      const verdict: PolicyVerdict = evaluateRequest(policy.document, request);
      const label = `(re-check before external effect, ${dispatch})`;
      if (verdict.decision === 'deny') {
        recordVerdict(tx, base, request, { ...verdict, reason: `${verdict.reason} ${label}` });
        return { decision: 'refuse', reason: verdict.reason };
      }
      if (dispatch === 'resend_failed' && verdict.decision !== 'allow') {
        const reason = `${verdict.reason}; resending a failed effect needs an 'allow' decision (an approval covers one dispatch)`;
        recordVerdict(tx, base, request, { ...verdict, reason: `${reason} ${label}` });
        return { decision: 'refuse', reason };
      }
      if (verdict.decision === 'require_approval') {
        const approval = verifyTaskApproval(tx, task, spec, policy, now);
        recordVerdict(tx, base, request, { ...verdict, reason: `${verdict.reason}; approval: ${approval.ok ? 'valid' : approval.reason} ${label}` });
        return approval.ok ? { decision: 'allow' } : { decision: 'refuse', reason: approval.reason };
      }
      recordVerdict(tx, base, request, { ...verdict, reason: `${verdict.reason} ${label}` });
      return { decision: 'allow' };
    },
  };
}

function budgetCap(policy: ActivePolicy, spec: TaskSpec): string | null {
  const cap = policy.document.limits.max_usd_per_task;
  return spec.cost_budget.max_usd > cap ? `cost_budget.max_usd ${spec.cost_budget.max_usd} exceeds the policy limit ${cap}` : null;
}

/** queued → running 조건 "예산 잔여" (state-machines.md): 이미 기록된 비용이 예산 이상이면 실행하지 않는다. */
function budgetSpent(tx: Db, task: TaskRow): string | null {
  const spent = Number(tx.get<{ total: number | null }>('SELECT sum(amount_usd) AS total FROM cost_entry WHERE task_id = ?', [task.id])?.total ?? 0);
  return spent >= Number(task.cost_budget_usd) ? `budget exhausted: ${spent} of ${task.cost_budget_usd} USD already recorded` : null;
}

/**
 * 승인이 필요한 업무의 실행 시점 확인 (trust-boundaries §4).
 *  1. 현재 대상 해시(명세 + 현재 정책 버전) = task.approved_hash. 다르면 실행 인자가 바뀌었거나 정책이 바뀐 것 → 재승인
 *  2. 역할 버전·상태가 승인 당시와 같은가 (조직·역할 변경이 승인 범위를 벗어나면 재검토)
 *  3. 승인자 수·자기 승인·취소 (approvalStatus). 외부 부작용이 있으면 cooldown·재인증도 (그 밖의 require_approval 은 사람 1인 승인만)
 */
export function verifyTaskApproval(tx: Db, task: TaskRow, spec: TaskSpec, policy: ActivePolicy, now: string): ApprovalStatus {
  const subject = taskSubject(task, spec, policy.versionId);
  const hash = taskSubjectHash(subject);
  const fail = (state: ApprovalStatus['state'], reason: string): ApprovalStatus => ({
    ok: false, state, reason, approvers: [], quorumApprovalId: null, quorumAt: null, cooldownEndsAt: null,
  });
  if (task.approved_hash === null) return fail('missing', 'approval required (no approval recorded)');
  if (task.approved_hash !== hash) {
    const snapshot = task.approved_snapshot === null ? null : (JSON.parse(task.approved_snapshot) as { policy_version_id?: string });
    if (snapshot?.policy_version_id !== undefined && snapshot.policy_version_id !== policy.versionId) {
      return fail('hash_mismatch', `policy changed since approval (approved under ${snapshot.policy_version_id}, current ${policy.versionId}); re-approval required`);
    }
    return fail('hash_mismatch', 'approved_hash mismatch: the execution arguments differ from the approved snapshot; re-approval required');
  }
  if (task.role_id !== null) {
    const role = tx.get<{ version: number; lifecycle: string }>('SELECT version, lifecycle FROM role WHERE id = ?', [task.role_id]);
    if (!role || Number(role.version) !== Number(task.role_version) || !['trial', 'active'].includes(role.lifecycle)) {
      return fail('hash_mismatch', 'the role changed since approval (version or lifecycle); re-review required');
    }
  }
  return approvalStatus(tx, {
    kind: 'task', id: task.id, hash, requesterId: taskRequester(tx, task), params: taskApprovalParams(policy.document, requestsFromSpec(spec)), now,
  });
}

