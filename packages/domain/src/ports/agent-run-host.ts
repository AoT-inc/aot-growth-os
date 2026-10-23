// 에이전트 실행 관리(agent-runtime, A5 U4)가 업무 엔진·평가의 기록 기능을 부르는 자리. agent-runtime 은 task-engine·evaluation 의 내부를 참조하지 않으므로
// (경계 lint) 인터페이스를 domain 에 둔다: apps/daemon 의 assemble 이 run 마다 구현을 만들어(task-engine 의 lease·evidence 기록, evaluation 의 비용 원장)
// 실행 관리에 넘긴다 (TaskPolicyGate·TaskValidator·ToolCallPolicy 와 같은 방식).
//
// 비용: 실행 관리는 보고를 단조 증가하는 *누적* 값으로 거른 뒤(중복·역행은 호스트에 닿기 전에 거부) 현재 누적을 넘긴다. 구현은 이미 원장에 기록한 분과의
// 차액만 `cost_entry` 에 더하고, 업무 전체(모든 시도 포함) 누적이 예산을 넘었는지 돌려준다. 비용은 실제로 쓴 돈이라 lease 를 잃었어도 기록한다.
// 출력: 증거와 run_log 위치를 이 run 에 남긴다. 결과·부작용과 같이 lease 펜싱을 받으므로 lease 를 잃었으면 던진다.
import type { EvidenceKind, TrustOrigin } from '../entities/enums.ts';

/** 누적 비용의 출처. adapter = 어댑터가 보고한 모델 비용(`cost_progress`), gateway = 도구 게이트웨이가 호출별로 계량한 도구 비용 */
export type AgentCostSource = 'adapter' | 'gateway';

/** 한 출처의 누적 비용. 보고된 적 없는 단위는 없다 */
export interface AgentCostTotals {
  usd?: number;
  tokens?: number;
}

/** 예산 초과 사유 (`reason` 은 evaluation 의 CancelSignal 코드: budget_usd_exceeded | budget_tokens_exceeded) */
export interface AgentBudgetBreach {
  reason: string;
  detail: string;
}

export interface AgentEvidenceInput {
  kind: EvidenceKind;
  ref: string;
  /** 근거의 신뢰 출처. 어댑터가 밝힌 값을 그대로 옮긴다 (`evidence.trust_origin`) */
  trustOrigin: TrustOrigin;
  /** Clock.nowIso() 형식 */
  capturedAt: string;
  contentHash?: string;
}

export interface AgentRunOutputRecord {
  evidence: readonly AgentEvidenceInput[];
  /** `task_run.run_log_ref`. 저장소가 없으면 null */
  runLogRef: string | null;
}

export interface AgentRunHost {
  /** 출처별 누적 비용을 원장에 반영하고 예산 초과면 사유를 돌려준다. 동기 (어댑터의 `onCostProgress` 안에서 불린다) */
  reportCost(source: AgentCostSource, totals: AgentCostTotals): AgentBudgetBreach | null;
  /** 증거와 run_log 위치를 남긴다 (lease 펜싱, 잃었으면 던진다) */
  recordOutput(record: AgentRunOutputRecord): void;
}
