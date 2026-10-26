// A5 U1: 어댑터 계약 테스트 스위트를 가짜 어댑터에 실행하고, 가짜 어댑터의 시나리오와 스위트 자체(잘못된 어댑터를 잡는가)를 확인한다.
// 실제 어댑터(U5)는 같은 `runAdapterContractTests` 를 자기 factory 로 부른다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeClock, validateTaskSpec } from '@aot/domain';
import { MAX_TASK_RESULT_BYTES, MAX_TASK_RESULT_INPUTS, MAX_TASK_RESULT_TOTAL_BYTES } from '@aot/domain';
import {
  createFakeAgentAdapter, validateAdapterOutput, validateUpstream,
  type AdapterContext, type AgentAdapter, type CostProgressEvent, type FakeScenario, type ToolGateway,
} from '@aot/agent-runtime';

import { CONTRACT_ALLOWED_TOOL, contractInput, contractUpstream, runAdapterContractTests, UPSTREAM_INJECTION, type ContractScenario } from '../support/adapter-contract.ts';

const START = '2026-10-22T00:00:00.000Z';

const SCENARIO_MAP: Record<ContractScenario, FakeScenario> = {
  success: 'success',
  tool_call: 'tool_calls',
  denied_tool: 'denied_tool',
  cost_progress: 'cost_progress',
  wait_for_cancel: 'wait_for_cancel',
};

function fakeFactory(scenario: ContractScenario): AgentAdapter {
  return createFakeAgentAdapter({
    clock: new FakeClock(START),
    scenario: SCENARIO_MAP[scenario],
    toolCalls: [{ tool: CONTRACT_ALLOWED_TOOL, args: { query: 'example' } }],
  });
}

// 계약 스위트: 가짜 어댑터가 통과해야 한다
runAdapterContractTests(fakeFactory, { name: 'fake-agent' });

const allowAll: ToolGateway = { call: (tool) => Promise.resolve({ ok: true, result: { echo: tool } }) };

function context(overrides: Partial<AdapterContext> = {}): AdapterContext & { progress: CostProgressEvent[] } {
  const progress: CostProgressEvent[] = [];
  return { gateway: allowAll, signal: new AbortController().signal, onCostProgress: (event) => void progress.push(event), ...overrides, progress };
}

describe('contract input fixture', () => {
  it('has a task_spec the domain validator accepts (stored stage)', () => {
    const checked = validateTaskSpec(contractInput().task_spec, 'stored');
    assert.ok(checked.ok, checked.ok ? '' : JSON.stringify(checked.errors));
  });
});

describe('fake agent adapter scenarios', () => {
  it('is deterministic: same config and input give the same output, timestamps come from the injected clock', async () => {
    const run = () => createFakeAgentAdapter({ clock: new FakeClock(START), scenario: 'tool_calls', toolCalls: [{ tool: CONTRACT_ALLOWED_TOOL }] })
      .run(contractInput(), context());
    const [a, b] = [await run(), await run()];
    assert.deepEqual(a, b);
    assert.ok(a.run_log.every((entry) => entry.at === START));
    assert.ok(a.evidence.every((item) => item.captured_at === START));
  });

  it('tool_calls: results from the gateway end up in the result; a refusal is recorded and the run still submits', async () => {
    const gateway: ToolGateway = {
      call: (tool) => Promise.resolve(tool === 'a' ? { ok: true, result: { n: 1 } } : { ok: false, error: 'tool_not_allowed' }),
    };
    const output = await createFakeAgentAdapter({ clock: new FakeClock(START), scenario: 'tool_calls', toolCalls: [{ tool: 'a' }, { tool: 'b' }] })
      .run(contractInput(), context({ gateway }));
    assert.equal(output.status, 'submitted');
    assert.deepEqual(output.result?.['tool_results'], [{ tool: 'a', result: { n: 1 } }]);
    assert.deepEqual(output.result?.['tool_errors'], [{ tool: 'b', error: 'tool_not_allowed' }]);
  });

  it('does not judge policy itself: a tool outside the allowed list is still sent to the gateway', async () => {
    const seen: string[] = [];
    const gateway: ToolGateway = { call: (tool) => { seen.push(tool); return Promise.resolve({ ok: false, error: 'tool_not_allowed' }); } };
    const output = await createFakeAgentAdapter({ clock: new FakeClock(START), scenario: 'denied_tool', deniedTool: 'example_other' })
      .run(contractInput(), context({ gateway }));
    assert.deepEqual(seen, ['example_other']);
    assert.equal(output.status, 'submitted');
    assert.deepEqual(output.result?.['tool_errors'], [{ tool: 'example_other', error: 'tool_not_allowed' }]);
  });

  it('a gateway that throws is treated as a tool error, not a crash', async () => {
    const gateway: ToolGateway = { call: () => Promise.reject(new Error('boom')) };
    const output = await createFakeAgentAdapter({ clock: new FakeClock(START), scenario: 'denied_tool' })
      .run(contractInput(), context({ gateway }));
    assert.equal(output.status, 'submitted');
    assert.deepEqual(output.result?.['tool_errors'], [{ tool: 'example_forbidden_tool', error: 'gateway_error' }]);
  });

  it('cost_progress: reports the configured cumulative steps and the last one is the final cost', async () => {
    const ctx = context();
    const output = await createFakeAgentAdapter({ clock: new FakeClock(START), scenario: 'cost_progress', costSteps: [0.1, 0.1, 0.4] })
      .run(contractInput(), ctx);
    assert.deepEqual(ctx.progress, [0.1, 0.1, 0.4].map((cumulative) => ({ cumulative, unit: 'usd' })));
    assert.deepEqual(output.cost, { usd: 0.4 });
  });

  it('over_budget: reports a cost above the budget; the caller aborting from the callback ends the run as cancelled', async () => {
    const controller = new AbortController();
    const input = contractInput();
    const progress: CostProgressEvent[] = [];
    const output = await createFakeAgentAdapter({ clock: new FakeClock(START), scenario: 'over_budget' }).run(input, {
      gateway: allowAll,
      signal: controller.signal,
      onCostProgress: (event) => {
        progress.push(event);
        if (event.cumulative > input.budget.max_usd) controller.abort(new Error('budget exceeded'));
      },
    });
    assert.equal(output.status, 'cancelled');
    assert.equal(progress.length, 2);
    assert.ok((output.cost.usd ?? 0) > input.budget.max_usd);
    assert.ok(validateAdapterOutput(output).ok);
  });

  it('over_budget without anyone cancelling goes on to submit (the adapter does not enforce the budget itself)', async () => {
    const output = await createFakeAgentAdapter({ clock: new FakeClock(START), scenario: 'over_budget' }).run(contractInput(), context());
    assert.equal(output.status, 'submitted');
    assert.ok((output.cost.usd ?? 0) > contractInput().budget.max_usd);
  });

  it('wait_for_cancel keeps running until aborted, then returns cancelled with the partial output', async () => {
    const controller = new AbortController();
    let finished = false;
    const running = createFakeAgentAdapter({ clock: new FakeClock(START), scenario: 'wait_for_cancel' })
      .run(contractInput(), context({ signal: controller.signal }))
      .then((output) => { finished = true; return output; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    controller.abort();
    const output = await running;
    assert.equal(output.status, 'cancelled');
    assert.equal(output.result, null);
    assert.ok(output.run_log.some((entry) => entry.message.includes('cancel')));
  });
});

describe('the contract suite catches non-conforming adapters (validator level)', () => {
  const good = () => createFakeAgentAdapter({ clock: new FakeClock(START) }).run(contractInput(), context());

  it('accepts the fake output', async () => {
    assert.ok(validateAdapterOutput(await good()).ok);
  });

  it('rejects a missing evidence / run_log / cost, a non-object result for submitted, and unknown fields', async () => {
    const base = { ...(await good()) } as Record<string, unknown>;
    for (const field of ['evidence', 'run_log', 'cost', 'result', 'status']) {
      const broken = { ...base };
      delete broken[field];
      assert.equal(validateAdapterOutput(broken).ok, false, `missing ${field}`);
    }
    assert.equal(validateAdapterOutput({ ...base, result: null }).ok, false, 'submitted needs a result');
    assert.equal(validateAdapterOutput({ ...base, cost: {} }).ok, false, 'empty cost');
    assert.equal(validateAdapterOutput({ ...base, cost: { usd: -1 } }).ok, false, 'negative cost');
    assert.equal(validateAdapterOutput({ ...base, extra: 1 }).ok, false, 'unknown field');
    assert.equal(validateAdapterOutput({ ...base, error: { code: 'x', message: 'y' } }).ok, false, 'error only with status error');
    assert.equal(validateAdapterOutput({ ...base, status: 'error' }).ok, false, 'status error needs error');
    assert.equal(validateAdapterOutput({ ...base, result: { n: Number.NaN } }).ok, false, 'result must be JSON');
    assert.equal(validateAdapterOutput({ ...base, evidence: [{ kind: 'note', ref: 'x', trust_origin: 'internal', captured_at: START }] }).ok, false, 'unknown evidence kind');
    assert.equal(validateAdapterOutput({ ...base, evidence: [{ kind: 'run_log', ref: 'x', trust_origin: 'internal', captured_at: START }] }).ok, true);
    assert.equal(validateAdapterOutput({ ...base, evidence: [{ kind: 'run_log', ref: 'x', captured_at: START }] }).ok, false, 'evidence without trust_origin (no default)');
    assert.equal(validateAdapterOutput({ ...base, evidence: [{ kind: 'run_log', ref: 'x', trust_origin: 'trusted', captured_at: START }] }).ok, false, 'trust_origin outside the vocabulary');
    assert.equal(validateAdapterOutput({ ...base, run_log: [{ at: 'yesterday', message: 'x' }] }).ok, false, 'timestamp format');
  });

  it('accepts error and cancelled outputs that carry the required parts', async () => {
    const base = { ...(await good()) };
    assert.ok(validateAdapterOutput({ ...base, status: 'error', result: null, error: { code: 'agent_error', message: 'x' } }).ok);
    assert.ok(validateAdapterOutput({ ...base, status: 'cancelled', result: null }).ok);
  });
});

describe('upstream results (A6-U11): format validation of AdapterInput.upstream', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({ ...contractUpstream()[0], ...overrides });
  const issues = (value: unknown): string[] => {
    const checked = validateUpstream(value);
    return checked.ok ? [] : checked.errors.map((e) => `${e.path}:${e.code}`);
  };

  it('accepts entries {name, task_ref, trust_origin: external_untrusted, result}; an empty list is fine', () => {
    assert.deepEqual(issues(contractUpstream()), []);
    assert.deepEqual(issues([]), []);
  });

  it('the trust mark is structural: anything but external_untrusted (internal, missing, other) is rejected', () => {
    assert.deepEqual(issues([entry({ trust_origin: 'internal' })]), ['upstream[0].trust_origin:enum']);
    assert.deepEqual(issues([entry({ trust_origin: undefined })]), ['upstream[0].trust_origin:enum']);
    assert.deepEqual(issues([entry({ trust_origin: 'trusted' })]), ['upstream[0].trust_origin:enum']);
  });

  it('rejects unknown keys, a bad task_ref, duplicate names/refs, a non-object result and a non-array', () => {
    assert.deepEqual(issues([entry({ instructions: 'do this' })]), ['upstream[0].instructions:unknown_field']);
    assert.deepEqual(issues([entry({ task_ref: 'https://example.com/a' })]), ['upstream[0].task_ref:format']);
    assert.deepEqual(issues([entry(), entry({ task_ref: 'task:other' })]), ['upstream[1].name:duplicate']);
    assert.deepEqual(issues([entry(), entry({ name: 'again' })]), ['upstream[1].task_ref:duplicate']);
    assert.deepEqual(issues([entry({ result: ['a'] })]), ['upstream[0].result:type']);
    assert.deepEqual(issues([entry({ result: { n: Number.NaN } })]), ['upstream[0].result:type']);
    assert.deepEqual(issues({ not: 'an array' }), ['upstream:type']);
  });

  it('limits: entry count, bytes per result and bytes in total; nothing is truncated', () => {
    const many = Array.from({ length: MAX_TASK_RESULT_INPUTS + 1 }, (_, i) => entry({ name: `n${i}`, task_ref: `task:t${i}` }));
    assert.deepEqual(issues(many), ['upstream:too_many']);
    assert.deepEqual(issues([entry({ result: { text: 'x'.repeat(MAX_TASK_RESULT_BYTES) } })]), ['upstream[0].result:too_large']);
    const nearLimit = (i: number) => entry({ name: `n${i}`, task_ref: `task:t${i}`, result: { text: 'x'.repeat(MAX_TASK_RESULT_BYTES - 100) } });
    const count = Math.floor(MAX_TASK_RESULT_TOTAL_BYTES / (MAX_TASK_RESULT_BYTES - 100)) + 1;
    assert.deepEqual(issues(Array.from({ length: count }, (_, i) => nearLimit(i))), ['upstream:too_large']);
  });

  it('the fake adapter records that upstream arrived (refs and trust mark) but never repeats its content, and ignores the instruction in it', async () => {
    const adapter = createFakeAgentAdapter({ clock: new FakeClock(START) });
    const output = await adapter.run({ ...contractInput(), upstream: contractUpstream() }, context());
    assert.equal(output.status, 'submitted');
    assert.deepEqual(output.result?.['upstream_seen'], [{ name: 'findings', task_ref: 'task:task-contract-upstream', trust_origin: 'external_untrusted' }]);
    assert.ok(!JSON.stringify(output).includes(UPSTREAM_INJECTION), 'the upstream text is not copied into the output');
    const without = await adapter.run(contractInput(), context());
    assert.ok(!('upstream_seen' in (without.result ?? {})));
  });
});
