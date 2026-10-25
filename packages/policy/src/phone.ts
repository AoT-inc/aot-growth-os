// PhoneCallPolicy(domain 포트)의 실제 구현 (ADR-0014 §8). 도구 게이트웨이의 일반 7요소 판정에 더해 전화 전용 제약을 판정한다.
//  - 정책 문서의 `phone:` 섹션이 없으면 모든 통화를 거부한다(기본 거부).
//  - 발신: 금지 번호 → 허용 지역 → 영업시간 → 발신 번호 → 최근 24시간 통화량 → 녹취. 하나라도 어긋나면 deny. 허용되면 요청 값을 정책 상한으로 줄인 값(grant)을 돌려준다.
//  - 전환: 대상이 `transfer_targets` 에 있어야 하고, 대상 통화가 전환을 허용하며 만들어졌어야 한다.
//  - 모든 판정은 policy_decision 에 남는다. 전화번호는 마스킹해서 남긴다(개인정보). 에이전트에는 판정 코드만 돌아간다.
import { countOutboundCallsSince, maskNumber, withinBusinessHours } from '@aot/domain';
import type { Db, PhoneCallPolicy, PhoneCallPolicyRequest, PhoneCallPolicyVerdict } from '@aot/domain';

import { recordDecision } from './decisions.ts';
import type { PhonePolicySection } from './document.ts';
import type { PolicyRequest } from './evaluate.ts';
import { approvalRequirement } from './evaluate.ts';
import type { PolicyStore } from './store.ts';

export interface PhoneCallPolicyOptions {
  db: Db;
  store: PolicyStore;
  /** 일일 통화량을 세는 창. 기본 24시간 */
  windowMs?: number;
}

const DAY_MS = 24 * 3600 * 1000;

/** 판정이 동기인 구현 (포트는 비동기도 허용한다) */
export interface SyncPhoneCallPolicy extends PhoneCallPolicy {
  judge(request: PhoneCallPolicyRequest): PhoneCallPolicyVerdict;
}

export function createPhoneCallPolicy(options: PhoneCallPolicyOptions): SyncPhoneCallPolicy {
  const { db, store } = options;
  return {
    judge(call: PhoneCallPolicyRequest): PhoneCallPolicyVerdict {
      const request: PolicyRequest = {
        subject: call.subject, action: call.kind === 'call' ? 'phone_call.call' : 'phone_call.transfer', resource: maskNumber(call.to), scope: 'customer', impact: 'external_effect',
        constraints: { max_usd: 0 },
      };
      return db.writeTx((tx) => {
        const active = store.active(tx);
        if (!active) return { decision: 'deny', reason: 'no policy_version is deployed; default deny' };
        const finish = (verdict: PhoneCallPolicyVerdict, reason: string): PhoneCallPolicyVerdict => {
          const approval = verdict.decision === 'require_approval' && active.policy ? approvalRequirement(active.policy.document, 'external_effect') : null;
          recordDecision(tx, {
            taskId: call.taskId, taskRunId: call.runId, request, decision: verdict.decision, reason: `${reason} (phone policy)`, approvalRequired: approval,
            policyVersionId: active.versionId, now: call.now,
          });
          return verdict;
        };
        if (!active.policy) return finish({ decision: 'deny', reason: 'policy content not found or does not match; default deny' }, 'policy content not found; default deny');
        const section = active.policy.document.phone;
        if (section === undefined) return finish({ decision: 'deny', reason: 'the policy has no phone section; phone calls are denied by default' }, 'no phone section; default deny');
        const verdict = call.kind === 'call' ? judgeCall(db, section, call, options.windowMs ?? DAY_MS) : judgeTransfer(section, call);
        return finish(verdict, verdict.decision === 'allow' ? 'allowed by the phone section' : verdict.reason);
      });
    },
  };
}

const deny = (reason: string): PhoneCallPolicyVerdict => ({ decision: 'deny', reason });

function judgeCall(db: Db, section: PhonePolicySection, call: PhoneCallPolicyRequest, windowMs: number): PhoneCallPolicyVerdict {
  const input = call.call;
  if (input === null) return deny('a call request is missing');
  if (section.denied_numbers.includes(call.to)) return deny('the number is on the denied list');
  if (!section.allowed_regions.some((prefix) => call.to.startsWith(prefix))) return deny('the number is outside the allowed regions');
  if (section.business_hours !== undefined && !withinBusinessHours(section.business_hours, new Date(call.now))) return deny('outside the allowed calling hours');
  const from = input.from ?? section.caller_ids[0] ?? null;
  if (from === null || !section.caller_ids.includes(from)) return deny('the caller id is not an allowed number');
  const since = new Date(Date.parse(call.now) - windowMs).toISOString();
  if (countOutboundCallsSince(db, since) >= section.max_calls_per_day) return deny(`the daily call limit (${section.max_calls_per_day}) is reached`);
  const wantsRecording = input.constraints?.recording === true;
  if (wantsRecording && section.recording === 'forbidden') return deny('recording is forbidden by policy');
  return {
    decision: 'allow',
    grant: {
      from,
      maxDurationSeconds: Math.min(input.constraints?.maxDurationSeconds ?? section.max_duration_seconds, section.max_duration_seconds),
      recording: section.recording === 'required' ? true : wantsRecording,
      allowTransfer: input.constraints?.allowTransfer === true && section.transfer_targets.length > 0,
    },
  };
}

function judgeTransfer(section: PhonePolicySection, call: PhoneCallPolicyRequest): PhoneCallPolicyVerdict {
  if (call.callAllowsTransfer !== true) return deny('this call was not created with transfer allowed');
  if (!section.transfer_targets.includes(call.to)) return deny('the transfer target is not an allowed number');
  return { decision: 'allow', grant: { from: null, maxDurationSeconds: section.max_duration_seconds, recording: false, allowTransfer: true } };
}

