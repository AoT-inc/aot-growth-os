// 가짜 어댑터 (프로세스 안). 모델·네트워크·난수·실제 시계를 쓰지 않고, 설정으로 고른 시나리오대로 결정적으로 움직인다.
// 어댑터 계약(contract.ts)을 구현하며 어댑터 계약 테스트(test/support/adapter-contract.ts)를 통과해야 한다.
// 정책을 판단하지 않는다: 허용 목록 밖 도구도 일단 게이트웨이에 요청하고, 거부 응답을 받아 기록한 뒤 계속한다.
// (test/support/fake-adapter.ts 는 A0 의 동기식 골격으로, 비용 집계 시험이 아직 쓴다. 새 시험은 이 어댑터를 쓴다.)
import type { Clock, EvidenceKind } from '@aot/domain';

import type {
  AdapterContext, AdapterInput, AdapterOutput, AdapterStatus, AgentAdapter, EvidenceItem, JsonObject, JsonValue, RunLogEntry, ToolGatewayResponse,
} from './contract.ts';

/**
 * success        결과만 내고 끝난다.
 * tool_calls     `toolCalls` 를 차례로 게이트웨이에 요청한 뒤 끝난다 (거부 응답이 와도 기록하고 이어 간다).
 * denied_tool    허용 목록 밖의 도구(`deniedTool`)를 요청한다. 거부 응답을 기록하고 크래시 없이 끝난다.
 * cost_progress  `costSteps`(누적 USD)를 차례로 보고한다. 마지막 값이 최종 비용이다.
 * over_budget    예산(`budget.max_usd`)의 50%, 150% 를 보고한다. 예산 강제는 호출자 몫이므로 abort 되지 않으면 끝까지 간다.
 * wait_for_cancel 취소 신호가 올 때까지 기다렸다가 `cancelled` 로 끝난다 (신호가 안 오면 끝나지 않는다).
 */
export type FakeScenario = 'success' | 'tool_calls' | 'denied_tool' | 'cost_progress' | 'over_budget' | 'wait_for_cancel';

export interface FakeToolCall {
  tool: string;
  args?: JsonObject;
}

export interface FakeAdapterConfig {
  clock: Clock;
  scenario?: FakeScenario;
  /** task_run.adapter 에 남는 이름. 기본 'fake-agent' */
  name?: string;
  /** 결과 본문. 기본 `{summary:'fake result'}` */
  result?: JsonObject;
  /** 증거. 기본은 run_log 증거 한 건 */
  evidence?: readonly { kind: EvidenceKind; ref: string }[];
  /** tool_calls 시나리오에서 요청할 도구 */
  toolCalls?: readonly FakeToolCall[];
  /** denied_tool 시나리오에서 요청할 (허용되지 않은) 도구. 기본 'example_forbidden_tool' */
  deniedTool?: string;
  /** cost_progress 시나리오의 누적 USD 단계. 기본 [0.01, 0.03] */
  costSteps?: readonly number[];
}

export const DEFAULT_FAKE_COST_STEPS: readonly number[] = [0.01, 0.03];
export const DEFAULT_DENIED_TOOL = 'example_forbidden_tool';

export function createFakeAgentAdapter(config: FakeAdapterConfig): AgentAdapter {
  const { clock } = config;
  const scenario = config.scenario ?? 'success';

  return {
    name: config.name ?? 'fake-agent',
    async run(input: AdapterInput, context: AdapterContext): Promise<AdapterOutput> {
      const runLog: RunLogEntry[] = [];
      let spentUsd = 0;
      const toolResults: JsonValue[] = [];
      const toolErrors: JsonValue[] = [];
      const note = (message: string): void => void runLog.push({ at: clock.nowIso(), message });

      const finish = (status: AdapterStatus): AdapterOutput => {
        const base: JsonObject = status === 'submitted' ? { ...(config.result ?? { summary: 'fake result' }) } : {};
        if (toolResults.length > 0) base['tool_results'] = toolResults;
        if (toolErrors.length > 0) base['tool_errors'] = toolErrors;
        const evidence: EvidenceItem[] = (config.evidence ?? [{ kind: 'run_log', ref: `run-log:${input.run_id}` }])
          .map((item) => ({ kind: item.kind, ref: item.ref, captured_at: clock.nowIso() }));
        note(`finished: ${status}`);
        return {
          status,
          result: status === 'submitted' || Object.keys(base).length > 0 ? base : null,
          evidence,
          run_log: runLog,
          cost: { usd: spentUsd },
        };
      };

      const reportUsd = (cumulative: number): void => {
        if (cumulative < spentUsd) return; // 누적 값은 줄지 않는다
        spentUsd = cumulative;
        context.onCostProgress({ cumulative, unit: 'usd' });
        note(`cost_progress: ${cumulative} usd`);
      };

      const requestTool = async (call: FakeToolCall): Promise<void> => {
        note(`tool_call: ${call.tool}`);
        let response: ToolGatewayResponse;
        try {
          response = await context.gateway.call(call.tool, call.args ?? {});
        } catch {
          response = { ok: false, error: 'gateway_error' };
        }
        if (response.ok) {
          toolResults.push({ tool: call.tool, result: response.result });
          note(`tool_result: ${call.tool} ok`);
        } else {
          toolErrors.push({ tool: call.tool, error: response.error });
          note(`tool_result: ${call.tool} error ${response.error}`);
        }
      };

      note(`started ${input.run_id}: ${input.allowed_tools.length} allowed tool(s), budget ${input.budget.max_usd} usd`
        + (input.time_limit_ms === undefined ? '' : `, time limit ${input.time_limit_ms} ms`));
      const cancelled = (): AdapterOutput => {
        note('cancel signal received');
        return finish('cancelled');
      };
      if (context.signal.aborted) return cancelled();

      switch (scenario) {
        case 'success':
          break;
        case 'tool_calls':
        case 'denied_tool': {
          const calls: readonly FakeToolCall[] = scenario === 'denied_tool'
            ? [{ tool: config.deniedTool ?? DEFAULT_DENIED_TOOL, args: {} }]
            : (config.toolCalls ?? []);
          for (const call of calls) {
            if (context.signal.aborted) return cancelled();
            await requestTool(call);
          }
          break;
        }
        case 'cost_progress':
        case 'over_budget': {
          const steps = scenario === 'over_budget'
            ? [input.budget.max_usd * 0.5, input.budget.max_usd * 1.5]
            : (config.costSteps ?? DEFAULT_FAKE_COST_STEPS);
          for (const step of steps) {
            reportUsd(step);
            await Promise.resolve(); // 호출자가 보고를 받고 abort 할 틈을 준다
            if (context.signal.aborted) return cancelled();
          }
          break;
        }
        case 'wait_for_cancel':
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return cancelled();
      }
      if (context.signal.aborted) return cancelled();
      return finish('submitted');
    },
  };
}
