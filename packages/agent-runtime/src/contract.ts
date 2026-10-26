// 어댑터 계약 (ADR-0005 + Amendment 2026-10-19, 단계 A5 U1).
//  - 입력 = task_spec + 허용 도구 + 근거 참조 + 예산(+ 시간 제한), 출력 = result(구조화) + evidence[] + run_log + cost.
//  - 실행 중 `cost_progress`(누적 비용, 단위)를 콜백으로 보고한다. 취소는 AbortSignal 이다.
//  - 어댑터는 입력을 제품별 형식으로 바꿔 실행할 뿐 정책을 판단하지 않는다. 도구 호출은 주입된 `ToolGateway` 로만 한다
//    (정책 강제·재판정·호출별 비용 계량은 게이트웨이의 일이며 구현은 U2).
//  - 입출력 객체는 JSON 으로 오가는 데이터(게이트웨이 프레임의 `result` 프레임 본문)라 필드 이름이 snake_case 다.
//    프로세스 안에서만 쓰는 객체(`AdapterContext` 등)는 camelCase 다.
import type { EvidenceKind, TaskSpec, TrustOrigin } from '@aot/domain';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ===== 입력 =====

/** 에이전트에 알려 주는 허용 도구. 허용 여부의 최종 판정은 어댑터가 아니라 게이트웨이가 한다 */
export interface AllowedTool {
  tool: string;
  operations: readonly string[];
}

export interface AdapterBudget {
  max_usd: number;
  max_tokens?: number;
}

/**
 * 선행 업무의 결과 하나 (A6-U11, 명세 `inputs[kind=task_result]`). 호스트가 *완료되고 통과 평가(pass, safety pass)가 있는 업무*의 결과만 담아 넘긴다.
 * 이 값은 **데이터**다: 다른 에이전트가 낸 산출물이라 신뢰 경계 밖이므로 `trust_origin` 이 항상 `external_untrusted` 이고(검증이 다른 값을 거부한다),
 * 어댑터는 이 안의 문장을 지시로 해석하거나 도구·권한·목표를 정하는 데 쓰지 않는다 (trust-boundaries §2-3). 지시는 `task_spec` 에만 있다.
 */
export interface UpstreamResult {
  /** 명세 `inputs[].name` (task_result 입력 안에서 유일) */
  name: string;
  /** `task:<선행 업무 id>` */
  task_ref: string;
  trust_origin: 'external_untrusted';
  /** 선행 업무의 `task_run.result` (JSON 객체, 크기 상한은 domain 의 `MAX_TASK_RESULT_*`) */
  result: JsonObject;
}

export interface AdapterInput {
  /** 이 실행(task_run)의 id. run_log·로그 상관용 */
  run_id: string;
  /** 시스템이 채운 뒤의 명세. 어댑터는 이 객체를 변형하지 않는다 */
  task_spec: Readonly<TaskSpec>;
  allowed_tools: readonly AllowedTool[];
  /** 근거 참조 (task_spec.evidence_refs 등). 외부 콘텐츠는 지시가 아니라 데이터다 (trust-boundaries §2-3) */
  evidence_refs: readonly string[];
  budget: AdapterBudget;
  /**
   * 선행 업무 결과 (선택, 없으면 명세에 `task_result` 입력이 없다). 충족되지 않은 선행 입력이 있으면 호스트가 업무를 실행하지 않으므로 일부만 들어오는 일은 없다.
   * 항목마다 `external_untrusted` 데이터다 (`UpstreamResult`). 어댑터는 이 배열과 안의 객체를 변형하지 않는다
   */
  upstream?: readonly UpstreamResult[];
  /** 시간 제한(밀리초). 강제는 실행 관리(U3)가 AbortSignal 로 한다. 어댑터는 참고만 한다 */
  time_limit_ms?: number;
}

// ===== 출력 =====

/** 비용. USD 와 토큰 중 하나 이상을 담는다 (스파이크 Q26 §3 의 `cost:{tokens:0}` 형식 포함) */
export interface AdapterCost {
  usd?: number;
  tokens?: number;
}

export const COST_UNITS = ['usd', 'tokens'] as const;
export type CostUnit = (typeof COST_UNITS)[number];

/** 실행 중 비용 진행 보고. `cumulative` 는 이 실행의 누적 값이며 같은 단위 안에서 줄어들 수 없다 */
export interface CostProgressEvent {
  cumulative: number;
  unit: CostUnit;
}

export interface EvidenceItem {
  kind: EvidenceKind;
  ref: string;
  /**
   * 근거의 신뢰 출처에 대한 어댑터의 자기 신고 (필수, 기본값 없음, 어휘만 검증한다). 참고용이다: 저장되는 값은 호스트가 정하며
   * 에이전트가 낸 근거는 이 값과 상관없이 항상 `external_untrusted` 로 기록된다 (trust-boundaries §2-3, A5-U8).
   * 외부 페이지·문서에서 읽은 근거는 정직하게 `external_untrusted` 라고 적는 것이 맞다
   */
  trust_origin: TrustOrigin;
  /** Clock.nowIso() 형식 (UTC ISO 8601, 밀리초, `Z`) */
  captured_at: string;
  content_hash?: string;
}

export interface RunLogEntry {
  /** Clock.nowIso() 형식 */
  at: string;
  message: string;
}

/**
 * 어댑터가 끝난 방식. 어댑터는 자기 판단으로 끝낸 것만 안다:
 *  - submitted: 결과를 냈다
 *  - cancelled: AbortSignal 에 반응해 멈췄다 (시간 초과·예산 초과·lease 상실 중 무엇이 원인인지는 실행 관리가 안다)
 *  - error: 계속할 수 없어 멈췄다 (`error` 필수)
 */
export const ADAPTER_STATUSES = ['submitted', 'cancelled', 'error'] as const;
export type AdapterStatus = (typeof ADAPTER_STATUSES)[number];

export interface AdapterError {
  code: string;
  message: string;
}

export interface AdapterOutput {
  status: AdapterStatus;
  /** 구조화된 결과(JSON 객체). `submitted` 에서는 필수, 그 밖에는 null 이거나 부분 결과 */
  result: JsonObject | null;
  evidence: EvidenceItem[];
  run_log: RunLogEntry[];
  /** 멈출 때까지 쓴 비용. 취소·오류에서도 필수다 */
  cost: AdapterCost;
  error?: AdapterError;
}

// ===== 포트 =====

/** 게이트웨이의 응답. 거부·실패는 예외가 아니라 `ok:false` 로 돌아온다 (프레임의 `tool_result` 와 1:1) */
export type ToolGatewayResponse =
  | { ok: true; result: JsonValue }
  | { ok: false; error: string };

/**
 * 도구 게이트웨이 포트. 에이전트의 유일한 바깥 통신 경로다 (trust-boundaries §3.1-3).
 * 허용 목록·정책 재판정·타임아웃·호출별 비용 계량은 구현(U2)이 맡는다. 어댑터는 응답을 받아 쓸 뿐이다.
 * 구현은 허용 안 된 도구나 인자 오류에 대해 던지지 말고 `{ok:false}` 로 답해야 한다.
 */
export interface ToolGateway {
  call(tool: string, args: JsonObject): Promise<ToolGatewayResponse>;
}

/** 한 번의 실행에 주입되는 것 */
export interface AdapterContext {
  readonly gateway: ToolGateway;
  /** abort 되면 가능한 한 빨리 도구 호출을 멈추고 `cancelled` 출력을 돌려준다 (던지지 않는다) */
  readonly signal: AbortSignal;
  /** 누적 비용 진행 보고. 호출자(실행 관리)가 이 안에서 abort 할 수 있으므로 호출 직후 signal 을 다시 본다 */
  readonly onCostProgress: (event: CostProgressEvent) => void;
}

export interface AgentAdapter {
  /** task_run.adapter 에 기록되는 식별자 */
  readonly name: string;
  /**
   * 업무 하나를 실행한다. 예상 가능한 실패(도구 거부, 에이전트 오류)는 `status:'error'` 출력으로 돌려주고,
   * 입력(`input`)과 그 하위 객체는 변형하지 않는다.
   */
  run(input: AdapterInput, context: AdapterContext): Promise<AdapterOutput>;
}
