// ToolCallPolicy(domain 포트)의 실제 구현. 도구 게이트웨이(agent-runtime)가 호출마다 부르고 apps/daemon 이 조립한다.
//  - 호출마다 현재 배포된 정책으로 7요소 판정을 새로 한다 (업무 시작 때의 판정을 재사용하지 않는다. trust-boundaries §4).
//  - 외부 입력이 영향을 준 부작용 호출(trust-boundaries §2-3)은 정책이 allow 여도 require_approval 로 올린다. deny 는 그대로 deny.
//    두 플래그(`side_effect`, `influenced_by_external_input`)는 판정 입력(constraints)으로 policy_decision 에 남는다.
//  - 모든 판정(allow·deny·require_approval)이 policy_decision 에 남는다 (task_run_id = 호출한 run). 정책 내용을 찾지 못하면 거부한다(기본 거부).
//  - 게이트웨이에는 승인 경로가 없다: 여기서 require_approval 은 "호출이 막힘"이고, 업무 전체 승인(approved_hash)은 이 호출들을 덮지 않는다.
import type { Db, ToolCallPolicy, ToolCallPolicyRequest, ToolCallPolicyVerdict } from '@aot/domain';

import { recordDecision } from './decisions.ts';
import { approvalRequirement, evaluateRequest, type PolicyRequest, type PolicyVerdict } from './evaluate.ts';
import type { PolicyStore } from './store.ts';

export interface ToolCallPolicyOptions {
  /** 쓰기 트랜잭션을 여는 루트 Db (판정마다 `Db.writeTx` 한 번) */
  db: Db;
  store: PolicyStore;
}

export function createToolCallPolicy(options: ToolCallPolicyOptions): ToolCallPolicy {
  const { db, store } = options;
  return {
    judge(call: ToolCallPolicyRequest): ToolCallPolicyVerdict {
      const request = policyRequestOf(call);
      return db.writeTx((tx) => {
        const active = store.active(tx);
        if (!active) return { decision: 'deny', reason: 'no policy_version is deployed; default deny' };
        if (!active.policy) {
          const reason = `content for policy_version '${active.versionId}' was not found or does not match; default deny`;
          recordDecision(tx, { taskId: call.taskId, taskRunId: call.runId, request, decision: 'deny', reason, approvalRequired: null, policyVersionId: active.versionId, now: call.now });
          return { decision: 'deny', reason };
        }
        let verdict: PolicyVerdict = evaluateRequest(active.policy.document, request);
        if (verdict.decision === 'allow' && call.sideEffect && call.influencedByExternalInput) {
          verdict = {
            ...verdict,
            decision: 'require_approval',
            reason: `${verdict.reason}; raised to require_approval: side-effect call influenced by external input`,
            approval: approvalRequirement(active.policy.document, request.impact),
          };
        }
        recordDecision(tx, {
          taskId: call.taskId, taskRunId: call.runId, request, decision: verdict.decision, reason: `${verdict.reason} (per-call gateway check)`,
          approvalRequired: verdict.approval, policyVersionId: active.versionId, now: call.now,
        });
        return verdict.decision === 'allow' ? { decision: 'allow' } : { decision: verdict.decision, reason: verdict.reason };
      });
    },
  };
}

function policyRequestOf(call: ToolCallPolicyRequest): PolicyRequest {
  return {
    subject: call.subject,
    action: `${call.tool}.${call.operation}`,
    resource: call.target,
    scope: call.scope,
    impact: call.impact,
    constraints: {
      ...call.constraints,
      ...(call.sideEffect ? { side_effect: true } : {}),
      ...(call.influencedByExternalInput ? { influenced_by_external_input: true } : {}),
    },
  };
}
