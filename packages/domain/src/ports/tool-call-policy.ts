// 도구 게이트웨이(agent-runtime, A5)가 호출마다 정책을 다시 판정받는 자리. agent-runtime 과 policy 는 서로 참조할 수 없으므로
// (경계 lint) 인터페이스를 domain 에 둔다: policy 가 구현하고(`createToolCallPolicy`), agent-runtime 의 게이트웨이가 호출하며,
// apps/daemon 이 조립한다 (TaskPolicyGate·TaskValidator 와 같은 방식).
//
// 의미
//  - 판정은 호출마다 새로 한다. 업무 시작(beforeRun) 때의 판정은 재사용하지 않는다 (trust-boundaries §2-1, §3.1-3, §4).
//  - 구현은 판정을 `policy_decision` 에 남긴다 (task_run_id = runId). 판정할 수 없으면(정책 없음·기록 실패) 던지거나 deny 를 돌려준다.
//    게이트웨이는 던져진 예외를 deny 로 취급한다 (기본 거부).
//  - `require_approval` 은 "호출이 막힘"이다. 게이트웨이는 승인 경로를 갖지 않고 에이전트는 승인을 대신할 수 없다.
//  - `influencedByExternalInput` 은 이 run 에서 외부 입력(웹 페이지 등, trust_origin='external_untrusted')이 이미 에이전트에 전달된 뒤의
//    호출임을 뜻한다 (trust-boundaries §2-3). 그런 run 의 부작용 호출(`sideEffect`)은 승인을 요구해야 한다.
//  - 에이전트에는 판정 결과(코드)만 돌려주고 사유와 규칙 id 는 기록에만 남는다 (trust-boundaries §2-2).
import type { Impact, Scope, Sensitivity } from '../entities/enums.ts';

/** 업무의 제약. policy 의 `RequestConstraints` 와 같은 모양이다 */
export interface ToolCallConstraints {
  max_usd: number;
  max_tokens?: number;
  time_limit?: string;
  network_allowlist?: string[];
  publish_scope?: Scope;
  data_classes?: Sensitivity[];
}

export interface ToolCallPolicyRequest {
  runId: string;
  taskId: string | null;
  /** 주체 `<role>@v<role_version>` (policy 의 subjectOf 와 같은 형식) */
  subject: string;
  tool: string;
  operation: string;
  /** 허용 도구에 선언된 대상. 선언이 없으면 null */
  target: string | null;
  scope: Scope;
  impact: Impact;
  /** 이 도구가 부작용을 일으키는가 (impact 가 read 가 아니면 true) */
  sideEffect: boolean;
  influencedByExternalInput: boolean;
  constraints: ToolCallConstraints;
  /** Clock.nowIso() */
  now: string;
}

export type ToolCallPolicyVerdict =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'require_approval'; reason: string };

export interface ToolCallPolicy {
  judge(request: ToolCallPolicyRequest): ToolCallPolicyVerdict | Promise<ToolCallPolicyVerdict>;
}
