// policy_decision 기록 (append-only, ADR-0006). 판정마다 한 행: 입력 요약(7요소), 결과, 사유, 정책 버전 id.
// 정책 내용 해시는 policy_version.content_hash 로 이어진다. 비밀값(TOTP 등)은 여기에 넣지 않는다.
import type { Db, PolicyDecisionValue } from '@aot/domain';

import type { PolicyRequest, PolicyVerdict } from './evaluate.ts';

export interface DecisionRecord {
  taskId?: string | null;
  taskRunId?: string | null;
  request: PolicyRequest;
  /** 최종 결과 (정책 판정에 승인 확인 등을 더한 뒤의 값일 수 있다) */
  decision: PolicyDecisionValue;
  reason: string;
  approvalRequired: unknown;
  policyVersionId: string;
  now: string;
}

/** 선언되지 않은 범위·영향은 열의 CHECK 때문에 가장 넓은 값으로 적고, 사유에 그 사실을 남긴다. */
export function recordDecision(tx: Db, record: DecisionRecord): void {
  const notes: string[] = [];
  if (record.request.scope === null) notes.push("scope not declared (recorded as 'public')");
  if (record.request.impact === null) notes.push("impact not declared (recorded as 'external_effect')");
  tx.run(
    `INSERT INTO policy_decision (task_id, task_run_id, subject, action, resource, scope, impact, constraints, approval_required,
       decision, reason, policy_version_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.taskId ?? null, record.taskRunId ?? null, record.request.subject, record.request.action,
      record.request.resource ?? '(none)', record.request.scope ?? 'public', record.request.impact ?? 'external_effect',
      JSON.stringify(record.request.constraints), record.approvalRequired === null || record.approvalRequired === undefined ? null : JSON.stringify(record.approvalRequired),
      record.decision, [record.reason, ...notes].join('; ').slice(0, 1000), record.policyVersionId, record.now,
    ],
  );
}

export function recordVerdict(
  tx: Db, base: Omit<DecisionRecord, 'decision' | 'reason' | 'approvalRequired' | 'request'>, request: PolicyRequest, verdict: PolicyVerdict,
): void {
  recordDecision(tx, { ...base, request, decision: verdict.decision, reason: verdict.reason, approvalRequired: verdict.approval });
}
