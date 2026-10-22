// 가짜 에이전트 어댑터 (A0 골격). 대본(script)대로 결정적으로 동작하고 모델·네트워크를 쓰지 않는다.
// 입출력 모양은 ADR-0005 를 따른다: 입력 = task_spec + 허용 도구 + 근거 참조 + 예산,
// 출력 = result + evidence[] + run_log + cost (+ 실행 중 cost_progress).
// 어댑터 계약은 A5 U1 에서 정해졌다: 계약을 구현하는 가짜는 `@aot/agent-runtime` 의 `createFakeAgentAdapter` 다.
// 이 동기식 골격은 비용 집계 시험(evaluation-cost)이 아직 쓰므로 남겨 두며, U3(비용 기록 연결)에서 새 가짜로 옮기고 지운다.
import type { Clock } from '@aot/domain';

export interface FakeAdapterInput {
  taskSpec: Readonly<Record<string, unknown>>;
  allowedTools: readonly string[];
  evidenceRefs: readonly string[];
  budgetUsd: number;
}

export interface FakeAdapterOutput {
  result: unknown;
  evidence: { kind: string; ref: string; observedAt: string }[];
  runLog: string[];
  cost: { amount: number; unit: 'USD' };
  /** 실행 중 보고된 누적 비용 (ADR-0005 Amendment) */
  costProgress: number[];
}

export interface FakeAdapterScript {
  result?: unknown;
  evidence?: { kind: string; ref: string }[];
  /** 누적 비용이 단계별로 이 값들이 되도록 보고한다. 마지막 값이 최종 비용 */
  costSteps?: number[];
}

export interface FakeAdapter {
  readonly name: string;
  run(input: FakeAdapterInput): FakeAdapterOutput;
}

export function createFakeAdapter(clock: Clock, script: FakeAdapterScript = {}): FakeAdapter {
  return {
    name: 'fake-adapter',
    run(input) {
      const costProgress = [...(script.costSteps ?? [0.01])];
      const observedAt = clock.nowIso();
      return {
        result: script.result ?? { summary: 'fake result' },
        evidence: (script.evidence ?? []).map((e) => ({ ...e, observedAt })),
        runLog: [
          `fake-adapter: started at ${observedAt}`,
          `fake-adapter: ${input.allowedTools.length} allowed tool(s), budget ${input.budgetUsd} USD`,
        ],
        cost: { amount: costProgress.at(-1) ?? 0, unit: 'USD' },
        costProgress,
      };
    },
  };
}
