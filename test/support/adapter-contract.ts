// 어댑터 계약 테스트 스위트 (ADR-0005 Consequences: 어댑터마다 같은 계약 테스트).
// 가짜 어댑터와 실제 어댑터(U5)가 같은 `runAdapterContractTests(factory)` 를 통과해야 한다. node:test 안에서 부른다:
//
//   runAdapterContractTests((scenario) => createFakeAgentAdapter({ clock, scenario: ... }));
//
// factory 는 시나리오마다 새 어댑터를 만든다. 실제 어댑터는 고정된 시험용 모델/대본으로 같은 행동을 내게 하고, 만들 수 없는
// 시나리오에는 null 을 돌려준다(그 항목은 skip 으로 보고되며 통과로 세지 않는다). 시나리오가 요구하는 행동:
//   success         도구 호출 없이 결과를 낸다
//   tool_call       허용된 도구 `example_search` 를 한 번 이상 게이트웨이로 호출하고 결과를 낸다
//   denied_tool     허용 목록 밖의 도구를 한 번 이상 호출한다 (게이트웨이가 거부한다)
//   cost_progress   `cost_progress` 를 한 번 이상 보고한다
//   wait_for_cancel 취소 신호가 올 때까지 끝나지 않고, 신호가 오면 멈춘다
// 이 스위트는 시간 제한 대기에 실제 타이머를 쓴다(시험 하네스의 데드라인일 뿐 어댑터에는 시계를 주지 않는다).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TaskSpec } from '@aot/domain';

import { validateAdapterOutput, validateCostProgress } from '@aot/agent-runtime';
import type {
  AdapterContext, AdapterInput, AdapterOutput, AgentAdapter, CostProgressEvent, JsonObject, ToolGateway, ToolGatewayResponse,
} from '@aot/agent-runtime';

export type ContractScenario = 'success' | 'tool_call' | 'denied_tool' | 'cost_progress' | 'wait_for_cancel';
export type ContractAdapterFactory = (scenario: ContractScenario) => AgentAdapter | null | Promise<AgentAdapter | null>;

export interface ContractSuiteOptions {
  /** describe 이름에 붙는다 */
  name?: string;
  /** abort 뒤 어댑터가 끝나야 하는 제한 시간(밀리초). 기본 2000 */
  cancelDeadlineMs?: number;
  /** 시험 입력을 바꾸고 싶을 때(시나리오별로 다른 입력을 줄 수 있다). 기본은 `contractInput()`. 호출마다 새 객체를 돌려줘야 한다 */
  input?: (scenario: ContractScenario) => AdapterInput;
}

/** 계약 시험이 쓰는 허용 도구 이름 */
export const CONTRACT_ALLOWED_TOOL = 'example_search';

/** 유효한 `stored` 명세를 가진 기본 시험 입력. 호출마다 새 객체 */
export function contractInput(): AdapterInput {
  const task_spec: TaskSpec = {
    objective: 'example-product 관련 시장 변화를 출처와 함께 정리한다',
    trigger: { kind: 'manual', ref: 'actor:example-owner' },
    inputs: [{ name: 'keywords', ref: 'strategy:active#research_keywords', kind: 'strategy' }],
    allowed_tools: [{ tool: CONTRACT_ALLOWED_TOOL, operations: ['search'], scope: 'internal', impact: 'read' }],
    constraints: { time_limit: '30m', network_allowlist: ['search.example.com'], publish_scope: 'internal' },
    acceptance_criteria: ['각 주장에 출처 URL이 1개 이상 있다'],
    validation: { deterministic: ['url_reachable'], llm: null, human: false },
    cost_budget: { max_usd: 2 },
    policy_version: 'policy-v1',
    versions: { org_version: 1, role_version: 1, task_spec_version: 1, strategy_version: 1, tool_contract_version: 1 },
  };
  return {
    run_id: 'run-contract-1',
    task_spec,
    allowed_tools: [{ tool: CONTRACT_ALLOWED_TOOL, operations: ['search'] }],
    evidence_refs: ['evidence:example-1'],
    budget: { max_usd: 2 },
    time_limit_ms: 30 * 60_000,
  };
}

interface GatewayCall { tool: string; args: JsonObject; allowed: boolean }

/** 호출을 기록하고, 입력의 허용 목록 밖 도구는 `tool_not_allowed` 로 거부하는 시험용 게이트웨이 */
function recordingGateway(allowed: readonly string[]): ToolGateway & { readonly calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  return {
    calls,
    call(tool, args): Promise<ToolGatewayResponse> {
      const ok = allowed.includes(tool);
      calls.push({ tool, args, allowed: ok });
      return Promise.resolve(ok ? { ok: true, result: { echo: tool } } : { ok: false, error: 'tool_not_allowed' });
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function assertValidOutput(output: unknown): asserts output is AdapterOutput {
  const checked = validateAdapterOutput(output);
  assert.ok(checked.ok, checked.ok ? '' : `invalid adapter output: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
}

export function runAdapterContractTests(factory: ContractAdapterFactory, options: ContractSuiteOptions = {}): void {
  const makeInput = options.input ?? ((): AdapterInput => contractInput());
  const deadlineMs = options.cancelDeadlineMs ?? 2000;

  /** 실행 하나. abort 와 비용 보고를 수집한다 */
  function start(adapter: AgentAdapter, input: AdapterInput, signal: AbortSignal = new AbortController().signal) {
    const allowed = input.allowed_tools.map((tool) => tool.tool);
    const gateway = recordingGateway(allowed);
    const progress: CostProgressEvent[] = [];
    const context: AdapterContext = { gateway, signal, onCostProgress: (event) => void progress.push(event) };
    return { gateway, progress, done: adapter.run(input, context) };
  }

  describe(`adapter contract: ${options.name ?? 'adapter'}`, () => {
    it('submitted output has the contract shape: structured result, evidence[], run_log, cost', async (t) => {
      const adapter = await factory('success');
      if (adapter === null) return void t.skip('scenario not supported');
      const output = await start(adapter, makeInput('success')).done;
      assertValidOutput(output);
      assert.equal(output.status, 'submitted');
      assert.notEqual(output.result, null);
      assert.ok(Array.isArray(output.evidence));
      assert.ok(output.run_log.length > 0, 'run_log must record the run');
      assert.ok(output.cost.usd !== undefined || output.cost.tokens !== undefined, 'cost is required');
      assert.ok(adapter.name.trim() !== '', 'adapter needs a name (task_run.adapter)');
    });

    it('calls tools only through the gateway and keeps a record in run_log', async (t) => {
      const adapter = await factory('tool_call');
      if (adapter === null) return void t.skip('scenario not supported');
      const { gateway, done } = start(adapter, makeInput('tool_call'));
      const output = await done;
      assertValidOutput(output);
      assert.equal(output.status, 'submitted');
      assert.ok(gateway.calls.length >= 1, 'the scenario must call a tool via the gateway');
      assert.ok(gateway.calls.every((call) => call.allowed), 'tool_call scenario only uses allowed tools');
      assert.ok(output.run_log.length > 1);
    });

    it('cost_progress is valid and never decreases; the final cost is not below the last report', async (t) => {
      const adapter = await factory('cost_progress');
      if (adapter === null) return void t.skip('scenario not supported');
      const { progress, done } = start(adapter, makeInput('cost_progress'));
      const output = await done;
      assertValidOutput(output);
      assert.ok(progress.length >= 1, 'at least one cost_progress report is expected');
      const last: Partial<Record<CostProgressEvent['unit'], number>> = {};
      for (const event of progress) {
        const checked = validateCostProgress(event);
        assert.ok(checked.ok, checked.ok ? '' : checked.errors.map((e) => e.message).join('; '));
        const before = last[event.unit];
        assert.ok(before === undefined || event.cumulative >= before, `cumulative ${event.unit} went down: ${before ?? 0} -> ${event.cumulative}`);
        last[event.unit] = event.cumulative;
      }
      for (const unit of ['usd', 'tokens'] as const) {
        const reported = last[unit];
        if (reported === undefined) continue;
        const final = output.cost[unit];
        assert.ok(final !== undefined && final >= reported, `final cost.${unit} (${final ?? 'missing'}) must cover the last report ${reported}`);
      }
    });

    it('stops within the deadline after the cancel signal and returns status cancelled with a complete output', async (t) => {
      const adapter = await factory('wait_for_cancel');
      if (adapter === null) return void t.skip('scenario not supported');
      const controller = new AbortController();
      const { done } = start(adapter, makeInput('wait_for_cancel'), controller.signal);
      await tick();
      controller.abort(new Error('contract-test cancel'));
      const output = await withDeadline(done, deadlineMs, `adapter did not finish within ${deadlineMs} ms after the cancel signal`);
      assertValidOutput(output);
      assert.equal(output.status, 'cancelled');
    });

    it('an already-aborted signal ends the run as cancelled without calling any tool', async (t) => {
      const adapter = await factory('tool_call');
      if (adapter === null) return void t.skip('scenario not supported');
      const controller = new AbortController();
      controller.abort(new Error('contract-test cancel'));
      const { gateway, done } = start(adapter, makeInput('tool_call'), controller.signal);
      const output = await withDeadline(done, deadlineMs, `adapter did not finish within ${deadlineMs} ms with an aborted signal`);
      assertValidOutput(output);
      assert.equal(output.status, 'cancelled');
      assert.equal(gateway.calls.length, 0);
    });

    it('survives the gateway refusing a tool outside the allowed list (no crash, valid output, refusal recorded)', async (t) => {
      const adapter = await factory('denied_tool');
      if (adapter === null) return void t.skip('scenario not supported');
      const { gateway, done } = start(adapter, makeInput('denied_tool'));
      const output = await done;
      assertValidOutput(output);
      assert.ok(gateway.calls.some((call) => !call.allowed), 'the scenario must request a tool outside the allowed list');
      assert.notEqual(output.status, 'cancelled');
      assert.ok(output.run_log.length > 0);
    });

    it('does not mutate the input (deep-frozen input, unchanged afterwards)', async (t) => {
      let ran = 0;
      for (const scenario of ['success', 'tool_call', 'denied_tool', 'cost_progress'] as const) {
        const adapter = await factory(scenario);
        if (adapter === null) {
          t.diagnostic(`scenario ${scenario} not supported`);
          continue;
        }
        const input = deepFreeze(makeInput(scenario));
        const pristine = structuredClone(input);
        const output = await start(adapter, input).done; // 동결된 객체를 쓰려 하면 strict 모드에서 TypeError 로 실패한다
        assertValidOutput(output);
        assert.deepEqual(input, pristine, `input changed in scenario ${scenario}`);
        ran += 1;
      }
      if (ran === 0) t.skip('no scenario supported');
    });
  });
}
