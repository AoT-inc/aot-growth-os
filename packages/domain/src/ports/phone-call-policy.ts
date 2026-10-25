// 전화 정책 포트 (ADR-0014 §8). 도구 게이트웨이의 일반 정책 판정(ToolCallPolicy, 7요소)에 더해, 전화에만 있는 제약
// (발신 가능 번호·국가·영업시간·최대 통화시간·하루 통화량·녹취·전환 대상)을 판정한다. 구현은 @aot/policy 이고 apps/daemon 이 조립한다.
// 정책 섹션(`phone:`)이 없으면 모든 통화를 거부한다(기본 거부). 에이전트는 이 정책을 읽거나 바꿀 수 없다.
import type { MakeCallInput } from '../phone/model.ts';

export interface PhoneCallPolicyRequest {
  kind: 'call' | 'transfer';
  /** 판정을 기록할 run (없으면 null) */
  runId: string | null;
  taskId: string | null;
  /** 주체 `<role>@v<role_version>` */
  subject: string;
  to: string;
  /** 발신 요청의 의도·제약. 전환이면 null */
  call: Pick<MakeCallInput, 'from' | 'objective' | 'constraints'> | null;
  /** 전환이면 대상 통화가 전환을 허용하며 만들어졌는가 */
  callAllowsTransfer?: boolean | undefined;
  /** Clock.nowIso() */
  now: string;
}

/** 허용될 때 정책이 확정한 값. 요청이 더 크면 정책 상한으로 줄어든다 */
export interface PhoneCallGrant {
  from: string | null;
  maxDurationSeconds: number;
  recording: boolean;
  allowTransfer: boolean;
}

export type PhoneCallPolicyVerdict =
  | { decision: 'allow'; grant: PhoneCallGrant }
  | { decision: 'deny'; reason: string }
  | { decision: 'require_approval'; reason: string };

export interface PhoneCallPolicy {
  judge(request: PhoneCallPolicyRequest): PhoneCallPolicyVerdict | Promise<PhoneCallPolicyVerdict>;
}

/** 정책이 연결되지 않았을 때의 기본값: 모든 통화 거부 */
export const DENY_ALL_PHONE_CALL_POLICY: PhoneCallPolicy = {
  judge: () => ({ decision: 'deny', reason: 'phone call policy not configured: default deny' }),
};
