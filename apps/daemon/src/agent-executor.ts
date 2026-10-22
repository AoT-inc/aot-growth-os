// 에이전트 실행기 조립 (A5 U4): agent-runtime 의 실행 관리(runAgentTask)를 업무 엔진의 TaskExecutor 포트에 연결한다.
// agent-runtime 은 task-engine·evaluation 을 모르므로(경계 lint) 여기서 domain 포트(AgentRunHost)를 구현해 만난다:
//   비용 → evaluation 의 reportCostProgress(차액만 cost_entry 에 더하고 업무 전체 예산 초과를 판정), 증거·run_log 위치 → task-engine 의 RunContext.recordOutput(lease 펜싱).
// 결과 매핑: submitted → {result} (워커가 submitted → validating), killed → RunKilledError (워커가 run 을 killed 로, 업무는 허용표 안에서 전이),
//            failed → Error (워커가 error 로 닫고 재시도/실패), cancelled(lease 상실) → Error (워커는 abort 를 보고 lease_lost 로 처리).
import type { AgentCostSource, AgentCostTotals, AgentRunHost, Clock, Db, ToolCallPolicy } from '@aot/domain';
import { reportCostProgress } from '@aot/evaluation';
import {
  createToolGateway, toolCallConstraintsOf, runAgentTask,
  type AdapterInput, type AgentAdapter, type GatewayTimers, type GatewayToolSpec, type RunLogStore, type ToolExecutor,
} from '@aot/agent-runtime';
import { subjectOf } from '@aot/policy';
import { RunKilledError, type RunContext, type TaskExecutor } from '@aot/task-engine';

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface AgentOptions {
  /** 가짜 어댑터 또는 `containerAgentAdapter(runner)` */
  adapter: AgentAdapter;
  /** 게이트웨이가 내줄 수 있는 도구(범위·영향·부작용은 여기 선언이 기준이다). 명세의 `allowed_tools` 와 도구·operation 이 맞는 것만 그 run 에 열린다 */
  tools?: readonly GatewayToolSpec[];
  /** 도구 이름 → 실행기 (비밀값은 실행기가 안에서 주입한다) */
  executors?: ReadonlyMap<string, ToolExecutor>;
  /** 도구 호출 타임아웃 기본값. 기본 30초 */
  toolTimeoutMs?: number;
  /** 도구 호출·시간 제한·종료 유예에 쓰는 타이머. 시험은 손으로 돌리는 타이머를 넣는다 */
  timers?: GatewayTimers;
  runLogStore?: RunLogStore;
  /** 명세에 `time_limit` 이 없을 때의 시간 제한(ms). 기본 30분 */
  defaultTimeLimitMs?: number;
  terminationGraceMs?: number;
}

export interface AgentExecutorDeps {
  db: Db;
  clock: Clock;
  agent: AgentOptions;
  toolCallPolicy: ToolCallPolicy;
}

/** run 하나의 AgentRunHost: 비용 원장과 증거 기록을 task-engine·evaluation 에 연결한다 */
export function createRunHost(deps: Pick<AgentExecutorDeps, 'db' | 'clock'>, ctx: RunContext): AgentRunHost {
  const category = (source: AgentCostSource): 'llm' | 'tool' => (source === 'adapter' ? 'llm' : 'tool');
  return {
    reportCost(source: AgentCostSource, totals: AgentCostTotals) {
      const result = reportCostProgress(deps.db, deps.clock, {
        taskRunId: ctx.lease.runId,
        cumulativeUsd: totals.usd ?? 0,
        ...(totals.tokens === undefined ? {} : { cumulativeTokens: totals.tokens }),
        category: category(source),
      });
      return result.cancel === null ? null : { reason: result.cancel.reason, detail: result.cancel.detail };
    },
    recordOutput: (record) => ctx.recordOutput(record),
  };
}

export function createAgentExecutor(deps: AgentExecutorDeps): TaskExecutor {
  const { agent } = deps;
  return {
    async execute(ctx) {
      const spec = ctx.spec;
      // 명세가 요청한 도구 중 게이트웨이가 내줄 수 있는 것만 연다
      const offered = (agent.tools ?? []).filter((tool) => agent.executors?.has(tool.tool) === true && spec.allowed_tools.some((requested) => requested.tool === tool.tool && requested.operations.includes(tool.operation)));
      const input: Omit<AdapterInput, 'time_limit_ms'> = {
        run_id: ctx.lease.runId,
        task_spec: spec,
        allowed_tools: offered.map((tool) => ({ tool: tool.tool, operations: [tool.operation] })),
        evidence_refs: spec.evidence_refs ?? [],
        budget: { max_usd: spec.cost_budget.max_usd, ...(spec.cost_budget.max_tokens === undefined ? {} : { max_tokens: spec.cost_budget.max_tokens }) },
      };
      const report = await runAgentTask({
        adapter: agent.adapter,
        input,
        createGateway: (hooks) => createToolGateway({
          runId: ctx.lease.runId, taskId: ctx.taskId, subject: subjectOf(spec), tools: offered, executors: agent.executors ?? new Map(),
          policy: deps.toolCallPolicy, clock: deps.clock, constraints: toolCallConstraintsOf(input), toolTimeoutMs: agent.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
          signal: hooks.signal, onCostProgress: hooks.onCostProgress, ...(agent.timers === undefined ? {} : { timers: agent.timers }),
        }),
        host: createRunHost(deps, ctx),
        clock: deps.clock,
        signal: ctx.signal,
        ...(agent.timers === undefined ? {} : { timers: agent.timers }),
        ...(agent.runLogStore === undefined ? {} : { runLogStore: agent.runLogStore }),
        ...(agent.defaultTimeLimitMs === undefined ? {} : { defaultTimeLimitMs: agent.defaultTimeLimitMs }),
        ...(agent.terminationGraceMs === undefined ? {} : { terminationGraceMs: agent.terminationGraceMs }),
      });
      const end = report.end;
      switch (end.kind) {
        case 'submitted':
          return { result: end.result };
        case 'killed':
          throw new RunKilledError(end.reason, end.detail);
        case 'failed':
          throw new Error(`${end.code}: ${end.message}`);
        case 'cancelled':
          throw new Error(`run cancelled: ${end.detail}`);
      }
    },
  };
}
