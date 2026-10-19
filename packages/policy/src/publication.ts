// 게시 게이트 (state-machines.md 게시, trust-boundaries §2-5, memory-item 규칙 7, phase-a §3 "외부 게시" A3 판정).
//  - `audience` 가 internal 이 아니면 published 전환에 유효한 사람 승인이 필요하다 (approval_id 필수)
//  - 게시 입력의 민감도가 internal 이상(internal/confidential/restricted)이면 public 대상에는 쓸 수 없다 (승인과 무관하게 거부)
//  - 입력 중 confidential 이상이 있으면 audience 와 무관하게 승인이 필요하다 (규칙 7)
//  - 그리고 7요소 판정: 주체 = 게시를 만든 업무의 주체, 행위 `publication.publish`, 대상 `<channel>:<content_ref>`,
//    범위 = audience, 영향 = internal 이면 write, 아니면 external_effect
// 승인 확인은 업무와 같다 (대상 해시, 승인자 수, 자기 승인, cooldown, 재인증). 판정은 policy_decision 에 남는다.
import {
  assertTransition, contentHash, PUBLICATION_MACHINE,
  type Db, type PublicationRow, type PublicationStatus, type Sensitivity, type TaskRow, type TaskSpec, type TransitionActor,
} from '@aot/domain';

import { approvalStatus, publicationSubject, taskRequester } from './approval.ts';
import { recordDecision } from './decisions.ts';
import { constraintsOf, evaluateRequest, subjectOf, type PolicyRequest } from './evaluate.ts';
import type { PolicyStore } from './store.ts';

export interface PublicationTransitionRequest {
  publicationId: string;
  to: PublicationStatus;
  by: TransitionActor;
  /** 게시 내용을 만드는 데 쓴 입력의 민감도 (memory_item.sensitivity, 업무 constraints.data_classes 등) */
  inputSensitivities?: readonly Sensitivity[];
  now: string;
}

export type PublicationGateResult = { ok: true; approvalId: string | null } | { ok: false; reason: string };

const NOT_PUBLIC: readonly Sensitivity[] = ['internal', 'confidential', 'restricted'];
const NEEDS_APPROVAL: readonly Sensitivity[] = ['confidential', 'restricted'];

/** 게시 상태 전이. published 로 갈 때 게이트를 통과해야 한다. 쓰기 트랜잭션 안에서 부른다. 거부해도 판정 기록은 남는다. */
export function transitionPublication(tx: Db, store: PolicyStore, request: PublicationTransitionRequest): PublicationGateResult {
  const row = tx.get<PublicationRow>('SELECT * FROM publication WHERE id = ?', [request.publicationId]);
  if (!row) return { ok: false, reason: `publication '${request.publicationId}' does not exist` };
  if (request.to !== 'published') {
    assertTransition(PUBLICATION_MACHINE, { from: row.status, to: request.to, by: request.by, audience: row.audience });
    tx.run('UPDATE publication SET status = ? WHERE id = ? AND status = ?', [request.to, row.id, row.status]);
    return { ok: true, approvalId: row.approval_id };
  }
  const gate = publishGate(tx, store, row, request);
  if (!gate.ok) return gate;
  assertTransition(PUBLICATION_MACHINE, { from: row.status, to: 'published', by: request.by, audience: row.audience, approvalId: gate.approvalId });
  const changed = tx.run('UPDATE publication SET status = ?, approval_id = ?, published_at = ? WHERE id = ? AND status = ?', [
    'published', gate.approvalId, request.now, row.id, row.status,
  ]);
  if (changed.changes !== 1) return { ok: false, reason: `publication '${row.id}' changed concurrently` };
  return gate;
}

function publishGate(tx: Db, store: PolicyStore, row: PublicationRow, request: PublicationTransitionRequest): PublicationGateResult {
  const active = store.active(tx);
  if (!active?.policy) return { ok: false, reason: 'the deployed policy content is not available; default deny' };
  const policy = active.policy;
  const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [row.task_id]);
  if (!task) return { ok: false, reason: `task '${row.task_id}' of the publication does not exist` };
  const spec = JSON.parse(task.spec) as TaskSpec;
  const sensitivities = [...new Set(request.inputSensitivities ?? [])].sort();
  const policyRequest: PolicyRequest = {
    subject: subjectOf(spec),
    action: 'publication.publish',
    resource: `${row.channel}:${row.content_ref}`,
    scope: row.audience,
    impact: row.audience === 'internal' ? 'write' : 'external_effect',
    constraints: { ...constraintsOf(spec), data_classes: sensitivities },
  };
  const record = (decision: 'allow' | 'deny' | 'require_approval', reason: string, approval: unknown) =>
    recordDecision(tx, { taskId: task.id, request: policyRequest, decision, reason: `${reason} (publication ${row.id})`, approvalRequired: approval, policyVersionId: policy.versionId, now: request.now });

  if (row.audience === 'public') {
    const leaking = sensitivities.filter((s) => NOT_PUBLIC.includes(s));
    if (leaking.length > 0) {
      const reason = `inputs with sensitivity ${leaking.join(', ')} cannot be published to 'public'`;
      record('deny', reason, null);
      return { ok: false, reason };
    }
  }
  const verdict = evaluateRequest(policy.document, policyRequest);
  if (verdict.decision === 'deny') {
    record('deny', verdict.reason, null);
    return { ok: false, reason: verdict.reason };
  }
  const why = [
    ...(verdict.decision === 'require_approval' ? [verdict.reason] : []),
    ...(row.audience !== 'internal' ? [`audience '${row.audience}' needs an approval`] : []),
    ...(sensitivities.some((s) => NEEDS_APPROVAL.includes(s)) ? ['confidential or restricted inputs need an approval (memory-item rule 7)'] : []),
  ];
  if (why.length === 0) {
    record('allow', verdict.reason, null);
    return { ok: true, approvalId: row.approval_id };
  }
  const subject = publicationSubject(row, policy.versionId);
  const status = approvalStatus(tx, {
    kind: 'publication', id: row.id, hash: contentHash(subject), requesterId: taskRequester(tx, task), params: policy.document.risky_change, now: request.now,
  });
  const approval = { approver_kind: 'human', channel: 'approval-socket', ...policy.document.risky_change };
  record('require_approval', `${why.join('; ')}; approval: ${status.ok ? 'valid' : status.reason}`, approval);
  if (!status.ok) return { ok: false, reason: status.reason };
  return { ok: true, approvalId: status.quorumApprovalId };
}
