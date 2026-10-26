// 에이전트 실행기 조립 (A5 U4): agent-runtime 의 실행 관리(runAgentTask)를 업무 엔진의 TaskExecutor 포트에 연결한다.
// agent-runtime 은 task-engine·evaluation 을 모르므로(경계 lint) 여기서 domain 포트(AgentRunHost)를 구현해 만난다:
//   비용 → evaluation 의 reportCostProgress(차액만 cost_entry 에 더하고 업무 전체 예산 초과를 판정), 증거·run_log 위치 → task-engine 의 RunContext.recordOutput(lease 펜싱).
// 결과 매핑: submitted → {result} (워커가 submitted → validating), killed → RunKilledError (워커가 run 을 killed 로, 업무는 허용표 안에서 전이),
//            failed → Error (워커가 error 로 닫고 재시도/실패), 단 사람이 풀어야 하는 오류 코드(isClaudeCodeReviewCode: 로그인 만료·사용량 한도 등)는
//            RunKilledError('review_required') (run killed, 업무 running → needs_review, 시도 소모 없음),
//            usage_deferred(사람 우선 게이트)는 RunKilledError('deferred') (run killed, 업무 running → retry_wait, 시도 소모 없음), cancelled(lease 상실) → Error (워커는 abort 를 보고 lease_lost 로 처리).
import type { AgentCostSource, AgentCostTotals, AgentRunHost, Clock, Db, ToolCallPolicy } from '@aot/domain';
import { reportCostProgress } from '@aot/evaluation';
import {
  createToolGateway, gatewayNameOf, isClaudeCodeDeferredCode, isClaudeCodeReviewCode, toolCallConstraintsOf, runAgentTask,
  type AdapterInput, type AgentAdapter, type GatewayTimers, type GatewayToolSpec, type JsonObject, type RunLogStore, type ToolCallRecorder, type ToolExecutor,
} from '@aot/agent-runtime';
import { subjectOf } from '@aot/policy';
import { RunKilledError, type AdapterSelector, type RunContext, type TaskExecutor } from '@aot/task-engine';

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface AgentOptions {
  /** 기본 어댑터: 가짜 어댑터 또는 `containerAgentAdapter(runner)`. `selectAdapter` 가 없거나 null 을 주면 모든 업무가 이 어댑터로 실행된다 */
  adapter: AgentAdapter;
  /**
   * 업무마다 다른 어댑터를 쓰기 위한 추가 어댑터 (A6-U11). 키는 어댑터의 `name` 과 같아야 한다(`task_run.adapter` 에 남는 이름이 실제로 쓴 어댑터의 이름이 되도록).
   * 기본 어댑터와 같은 이름은 둘 수 없다. 생략하면 단일 어댑터(이전 동작)다.
   */
  adapters?: ReadonlyMap<string, AgentAdapter>;
  /**
   * 명세 → 어댑터 이름 해석 (A6-U11). null 이면 기본 `adapter`. 돌려준 이름이 기본 어댑터의 이름도 `adapters` 의 키도 아니면 그 업무는 실행되지 않고 `needs_review` 가 된다.
   * 어댑터 선택은 권한이 아니다: 어댑터가 무엇이든 도구는 명세 `allowed_tools` 와 도구 게이트웨이의 정책 판정이 정한다. `adapterByRole` 이 역할 기준 해석기다
   */
  selectAdapter?: AdapterSelector;
  /** 게이트웨이가 내줄 수 있는 도구(범위·영향·부작용은 여기 선언이 기준이다). 명세의 `allowed_tools` 와 도구·operation 이 맞는 것만 그 run 에 열린다 */
  tools?: readonly GatewayToolSpec[];
  /** 도구 이름 → 실행기 (비밀값은 실행기가 안에서 주입한다) */
  executors?: ReadonlyMap<string, ToolExecutor>;
  /**
   * run 마다 만드는 도구 실행기 (전화 Capability 처럼 run 의 업무·부작용 원장에 묶이는 도구, ADR-0014). 정적 `executors` 와 합쳐지고 이름이 겹치면 거부한다 —
   * 같은 이름의 도구를 run 이 조용히 바꿔치기하지 못하게 한다.
   */
  runExecutors?: (context: RunContext) => ReadonlyMap<string, ToolExecutor>;
  /** 도구 호출 타임아웃 기본값. 기본 30초 */
  toolTimeoutMs?: number;
  /** 도구 호출·시간 제한·종료 유예에 쓰는 타이머. 시험은 손으로 돌리는 타이머를 넣는다 */
  timers?: GatewayTimers;
  runLogStore?: RunLogStore;
  /**
   * 게이트웨이 호출 기록(`ToolCallRecord`)을 구조화된 채로 받는 훅. 모든 run 의 모든 호출(허용·거부·타임아웃·오류)에 대해 호출 직후, 응답 전에 불린다(기록에 `run_id`).
   * run_log 파일(문자열 메시지)과 별개이며, 던져도 에이전트 응답에는 영향이 없다. 시험과 감사 연결이 메시지 문자열을 파싱하지 않고 호출 기록을 읽는 길이다.
   */
  recorder?: ToolCallRecorder;
  /** 명세에 `time_limit` 이 없을 때의 시간 제한(ms). 기본 30분 */
  defaultTimeLimitMs?: number;
  terminationGraceMs?: number;
}

/** 역할(slug) → 어댑터 이름 해석기. 역할이 없거나 규칙에 없으면 null(기본 어댑터) */
export function adapterByRole(rules: Readonly<Record<string, string>>): AdapterSelector {
  const byRole = new Map(Object.entries(rules));
  return (spec) => (spec.role === undefined ? null : byRole.get(spec.role) ?? null);
}

/** 이 데몬이 실행할 수 있는 어댑터 이름 전체(기본 + 추가). 키와 `adapter.name` 이 다르거나 이름이 겹치면 던진다 */
export function registeredAdapterNames(agent: Pick<AgentOptions, 'adapter' | 'adapters'>): Set<string> {
  const names = new Set<string>([agent.adapter.name]);
  for (const [key, adapter] of agent.adapters ?? []) {
    if (key !== adapter.name) throw new Error(`adapter registered as '${key}' is named '${adapter.name}'; the key must be the adapter's name (it is what task_run.adapter records)`);
    if (names.has(key)) throw new Error(`adapter name '${key}' is registered more than once`);
    names.add(key);
  }
  return names;
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
      const executors = new Map<string, ToolExecutor>(agent.executors ?? []);
      for (const [name, runExecutor] of agent.runExecutors?.(ctx) ?? []) {
        if (executors.has(name)) throw new Error(`tool '${name}' is provided both as a static executor and as a run executor`);
        executors.set(name, runExecutor);
      }
      // 명세가 요청한 도구 중 게이트웨이가 내줄 수 있는 것만 연다
      const offered = (agent.tools ?? []).filter((tool) => executors.has(tool.tool) && spec.allowed_tools.some((requested) => requested.tool === tool.tool && requested.operations.includes(tool.operation)));
      // 선행 업무 결과(A6-U11): 호스트(task-engine)가 통과 평가가 있는 완료 업무에서 읽은 것만 온다. 신뢰 표시는 여기서 붙인다 —
      // 선행 결과는 다른 에이전트가 낸 산출물이라 항상 external_untrusted 데이터다(DB 값이 아니라 이 코드가 정한다).
      const upstream = ctx.upstream.map((entry) => ({ name: entry.name, task_ref: entry.taskRef, trust_origin: 'external_untrusted' as const, result: entry.result as JsonObject }));
      const input: Omit<AdapterInput, 'time_limit_ms'> = {
        run_id: ctx.lease.runId,
        task_spec: spec,
        allowed_tools: offered.map((tool) => ({ tool: gatewayNameOf(tool), operations: [tool.operation] })),
        evidence_refs: spec.evidence_refs ?? [],
        budget: { max_usd: spec.cost_budget.max_usd, ...(spec.cost_budget.max_tokens === undefined ? {} : { max_tokens: spec.cost_budget.max_tokens }) },
        ...(upstream.length === 0 ? {} : { upstream }),
      };
      // task_run.adapter 에 기록된 이름(ctx.adapter)의 어댑터로 실행한다. 등록되지 않은 이름이면 기본 어댑터(이름을 해석하는 쪽이 등록 여부를 먼저 확인한다)
      const adapter = agent.adapters?.get(ctx.adapter) ?? agent.adapter;
      const report = await runAgentTask({
        adapter,
        input,
        createGateway: (hooks) => createToolGateway({
          runId: ctx.lease.runId, taskId: ctx.taskId, subject: subjectOf(spec), tools: offered, executors,
          policy: deps.toolCallPolicy, clock: deps.clock, constraints: toolCallConstraintsOf(input), toolTimeoutMs: agent.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
          signal: hooks.signal, onCostProgress: hooks.onCostProgress, ...(upstream.length === 0 ? {} : { externalInput: true }), ...(agent.timers === undefined ? {} : { timers: agent.timers }),
          ...(agent.recorder === undefined ? {} : { recorder: agent.recorder }),
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
          // 재시도해도 같은 조건(로그인 없음·한도 도달 등)이라 시도를 소모하지 않고 사람의 검토로 보낸다. 한도 리셋 후 자동 재큐는 하지 않는다(문구 미확정)
          // 사람 우선 게이트가 일을 시작하지 않고 미뤘다: 실패가 아니라 시도를 소모하지 않는 retry_wait
          if (isClaudeCodeDeferredCode(end.code)) throw new RunKilledError('deferred', `${end.code}: ${end.message}`);
          if (isClaudeCodeReviewCode(end.code)) throw new RunKilledError('review_required', `${end.code}: ${end.message}`);
          throw new Error(`${end.code}: ${end.message}`);
        case 'cancelled':
          throw new Error(`run cancelled: ${end.detail}`);
      }
    },
  };
}
