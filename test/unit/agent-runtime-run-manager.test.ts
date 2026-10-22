// A5 U4: 실행 관리(runAgentTask). 시간 제한 → killed, 예산 초과 → killed 와 초과 시점 비용 보존, 중복·역행 cost_progress 거부, 늦은 결과 폐기,
// 정상 종료 비용 이중 계상 없음, 정책 재판정 거부는 run 을 죽이지 않음. DB 는 쓰지 않는다(AgentRunHost 가짜). DB 를 쓰는 통합은 test/integration/agent-run-management.test.ts.
// 시간은 손으로 돌리는 타이머와 FakeClock 이다(실제 시계·지연 없음).
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { FakeClock, type AgentBudgetBreach, type AgentCostSource, type AgentCostTotals, type AgentRunHost, type AgentRunOutputRecord, type ToolCallPolicyVerdict } from '@aot/domain';
import {
  createFakeAgentAdapter, createFileRunLogStore, createToolGateway, DEFAULT_TERMINATION_GRACE_MS, DEFAULT_TIME_LIMIT_MS, runAgentTask,
  type AdapterInput, type AdapterOutput, type AgentAdapter, type AgentTaskReport, type CostProgressEvent, type GatewayToolSpec, type RunLogEntry, type RunLogStore,
} from '@aot/agent-runtime';

import { contractInput } from '../support/adapter-contract.ts';
import { deferred, ManualGatewayTimers, tick } from '../support/gateway-contract.ts';
import { makeTempDir } from '../support/temp.ts';

const START = '2026-10-23T00:00:00.000Z';
const MIN = 60_000;

class FakeHost implements AgentRunHost {
  readonly costCalls: { source: AgentCostSource; totals: AgentCostTotals }[] = [];
  readonly outputs: AgentRunOutputRecord[] = [];
  limitUsd = 1;
  throwOnCost = false;
  throwOnOutput = false;
  readonly #latest: Record<AgentCostSource, number> = { adapter: 0, gateway: 0 };

  reportCost(source: AgentCostSource, totals: AgentCostTotals): AgentBudgetBreach | null {
    if (this.throwOnCost) throw new Error('ledger unavailable');
    this.costCalls.push({ source, totals: { ...totals } });
    this.#latest[source] = totals.usd ?? 0;
    const total = this.#latest.adapter + this.#latest.gateway;
    return total > this.limitUsd ? { reason: 'budget_usd_exceeded', detail: `spent ${total} USD exceeds the budget ${this.limitUsd} USD` } : null;
  }

  recordOutput(record: AgentRunOutputRecord): void {
    if (this.throwOnOutput) throw new Error('database is busy');
    this.outputs.push(record);
  }

  usdCalls(source: AgentCostSource): (number | undefined)[] {
    return this.costCalls.filter((c) => c.source === source).map((c) => c.totals.usd);
  }
}

const TOOL = 'example_search';
const searchTool: GatewayToolSpec = { tool: TOOL, operation: 'search', scope: 'internal', sideEffect: false, unitCost: { usd: 0.5 } };

interface Env {
  clock: FakeClock;
  timers: ManualGatewayTimers;
  host: FakeHost;
  policy: { decide: () => ToolCallPolicyVerdict };
  done(): boolean;
  start(adapter: AgentAdapter, options?: Partial<StartOptions>): Promise<AgentTaskReport>;
}

interface StartOptions {
  input: Omit<AdapterInput, 'time_limit_ms'>;
  signal: AbortSignal;
  runLogStore: RunLogStore;
  defaultTimeLimitMs: number;
}

function env(): Env {
  const clock = new FakeClock(START);
  const timers = new ManualGatewayTimers();
  const host = new FakeHost();
  const policy = { decide: (): ToolCallPolicyVerdict => ({ decision: 'allow' }) };
  let finished = false;
  return {
    clock, timers, host, policy,
    done: () => finished,
    start(adapter, options = {}) {
      const { time_limit_ms: _ignored, ...base } = contractInput();
      void _ignored;
      const input = options.input ?? base;
      const run = runAgentTask({
        adapter, input, host, clock, timers,
        createGateway: (hooks) => createToolGateway({
          runId: input.run_id, subject: 'generalist@v1', tools: [searchTool], executors: new Map([[TOOL, () => Promise.resolve({ result: { hits: 1 } })]]),
          policy: { judge: () => policy.decide() }, clock, constraints: { max_usd: input.budget.max_usd }, toolTimeoutMs: 1000, timers,
          signal: hooks.signal, onCostProgress: hooks.onCostProgress,
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.runLogStore === undefined ? {} : { runLogStore: options.runLogStore }),
        ...(options.defaultTimeLimitMs === undefined ? {} : { defaultTimeLimitMs: options.defaultTimeLimitMs }),
      });
      void run.then(() => { finished = true; }, () => { finished = true; });
      return run;
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await tick();
};

const submitted = (cost: { usd: number }, extra: Partial<AdapterOutput> = {}): AdapterOutput => ({
  status: 'submitted', result: { summary: 'done' }, evidence: [{ kind: 'source_url', ref: 'https://docs.example.com/a', captured_at: START }], run_log: [{ at: START, message: 'adapter finished' }], cost, ...extra,
});

/** 취소 신호를 무시하고 `release` 가 풀릴 때까지 기다렸다가 결과를 낸다 */
function stubbornAdapter(release: Promise<void>, onLate?: (progress: (event: CostProgressEvent) => void) => void): AgentAdapter {
  return {
    name: 'stubborn-agent',
    async run(_input, context) {
      await release;
      onLate?.(context.onCostProgress);
      return submitted({ usd: 0.9 });
    },
  };
}

function reporting(events: readonly unknown[], final: AdapterOutput): AgentAdapter {
  return {
    name: 'reporting-agent',
    run(_input, context) {
      for (const event of events) context.onCostProgress(event as CostProgressEvent);
      return Promise.resolve(final);
    },
  };
}

describe('time limit', () => {
  it('constraints.time_limit passes => killed(time_limit) exactly at the limit; the agent sees the abort; no timer is left', async () => {
    const e = env();
    const run = e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'wait_for_cancel' }));
    await settle();
    e.timers.advance(30 * MIN - 1);
    await settle();
    assert.equal(e.done(), false, 'still running one millisecond before the limit');
    e.timers.advance(1);
    const report = await run;
    assert.equal(report.end.kind, 'killed');
    assert.equal(report.end.kind === 'killed' && report.end.reason, 'time_limit');
    assert.match(report.end.kind === 'killed' ? report.end.detail : '', /30m/);
    assert.equal(report.terminationConfirmed, true);
    assert.equal(e.timers.pending, 0, 'limit and grace timers are cleared');
    assert.equal(e.host.outputs.length, 1, 'the partial output of the cancelled agent is recorded');
    assert.ok(report.runLog.some((entry) => /cancel signal received/.test(entry.message)), 'the agent saw the abort signal');
  });

  it('passes time_limit_ms to the adapter; without constraints.time_limit the default applies (30 min, or the configured one)', async () => {
    const e = env();
    let seen: number | undefined;
    const probe: AgentAdapter = { name: 'probe', async run(input, context) { seen = input.time_limit_ms; await new Promise<void>((r) => context.signal.addEventListener('abort', () => r(), { once: true })); return submitted({ usd: 0 }, { status: 'cancelled' }); } };
    const base = contractInput();
    const { time_limit: _t, ...constraints } = base.task_spec.constraints;
    void _t;
    const input = { ...base, task_spec: { ...base.task_spec, constraints } };
    const run = e.start(probe, { input });
    await settle();
    assert.equal(seen, DEFAULT_TIME_LIMIT_MS);
    e.timers.advance(DEFAULT_TIME_LIMIT_MS);
    assert.equal((await run).end.kind, 'killed');

    const e2 = env();
    const run2 = e2.start(probe, { input, defaultTimeLimitMs: 5000 });
    await settle();
    assert.equal(seen, 5000);
    e2.timers.advance(5000);
    assert.equal((await run2).end.kind, 'killed');
  });

  it('a time_limit that cannot be interpreted does not start the agent (fail closed, no silent default)', async () => {
    for (const bad of ['soon', '0m', '1.5h', '30 m', '1h30m', '8d', '']) {
      const e = env();
      let started = false;
      const base = contractInput();
      const input = { ...base, task_spec: { ...base.task_spec, constraints: { ...base.task_spec.constraints, time_limit: bad } } };
      const report = await e.start({ name: 'never', run() { started = true; return Promise.resolve(submitted({ usd: 0 })); } }, { input });
      assert.equal(report.end.kind, 'failed', bad);
      assert.equal(report.end.kind === 'failed' && report.end.code, 'invalid_time_limit', bad);
      assert.equal(started, false, bad);
      assert.equal(e.host.outputs.length, 0);
    }
  });
});

describe('budget', () => {
  it('cost_progress over the budget => abort and killed(budget_exceeded); the cost up to that point is kept', async () => {
    const e = env();
    const report = await e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'over_budget' }));
    assert.equal(report.end.kind, 'killed');
    assert.equal(report.end.kind === 'killed' && report.end.reason, 'budget_exceeded');
    assert.deepEqual(e.host.usdCalls('adapter'), [1, 3], 'reported 50% then 150% of the 2 USD input budget; both reached the ledger before the abort');
    assert.deepEqual(report.cost.adapter, { usd: 3 });
    assert.equal(e.timers.pending, 0);
    assert.ok(report.runLog.some((entry) => /cancel signal received/.test(entry.message)), 'the agent was told to stop');
  });

  it('a first report that already exceeds the budget kills the run right away (the check runs on every report)', async () => {
    const e = env();
    e.host.limitUsd = 0.1;
    const report = await e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'cost_progress', costSteps: [0.5, 0.6] }));
    assert.equal(report.end.kind, 'killed');
    assert.deepEqual(e.host.usdCalls('adapter'), [0.5], 'the second report was never made: the agent had been told to stop');
  });

  it('the gateway-metered tool cost counts too: the third 0.5 USD tool call crosses 1 USD', async () => {
    const e = env();
    const calls = [{ tool: TOOL }, { tool: TOOL }, { tool: TOOL }, { tool: TOOL }];
    const report = await e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'tool_calls', toolCalls: calls }));
    assert.equal(report.end.kind, 'killed');
    assert.equal(report.end.kind === 'killed' && report.end.reason, 'budget_exceeded');
    assert.deepEqual(e.host.usdCalls('gateway'), [0.5, 1, 1.5]);
    assert.deepEqual(report.cost.gateway, { usd: 1.5 });
    assert.equal(e.host.usdCalls('adapter').length, 0);
  });

  it('adapter and gateway costs add up against one budget (neither alone crosses it)', async () => {
    const e = env();
    e.host.limitUsd = 1;
    const adapter: AgentAdapter = {
      name: 'mixed',
      async run(_input, context) {
        context.onCostProgress({ cumulative: 0.7, unit: 'usd' });
        const response = await context.gateway.call(TOOL, {}); // gateway 0.5 => 1.2 in total
        assert.equal(response.ok, true);
        await Promise.resolve();
        return context.signal.aborted ? submitted({ usd: 0.7 }, { status: 'cancelled', result: null }) : submitted({ usd: 0.7 });
      },
    };
    const report = await e.start(adapter);
    assert.equal(report.end.kind, 'killed');
    assert.equal(report.end.kind === 'killed' && report.end.reason, 'budget_exceeded');
  });

  it('a final cost above the budget with no progress reports kills the run; the submitted result is discarded but the cost stays', async () => {
    const e = env();
    const report = await e.start(reporting([], submitted({ usd: 5 })));
    assert.equal(report.end.kind, 'killed');
    assert.deepEqual(report.cost.adapter, { usd: 5 });
    assert.deepEqual(e.host.outputs[0]?.evidence, [], 'evidence of the discarded result is not recorded');
    assert.ok(report.runLog.some((entry) => /discarded/.test(entry.message)));
  });
});

describe('cost_progress filtering', () => {
  it('duplicate, decreasing, negative, non-finite and fractional-token reports are rejected before the ledger; the last good cumulative stays', async () => {
    const e = env();
    e.host.limitUsd = 100;
    const events = [
      { cumulative: 0.1, unit: 'usd' }, { cumulative: 0.1, unit: 'usd' }, { cumulative: 0.05, unit: 'usd' }, { cumulative: 0.2, unit: 'usd' },
      { cumulative: -1, unit: 'usd' }, { cumulative: Number.NaN, unit: 'usd' }, { cumulative: 5.5, unit: 'tokens' }, { cumulative: 10, unit: 'tokens' }, { cumulative: 10, unit: 'tokens' },
    ];
    const report = await e.start(reporting(events, submitted({ usd: 0.2 })));
    assert.equal(report.end.kind, 'submitted');
    assert.deepEqual(e.host.costCalls.map((c) => c.totals), [{ usd: 0.1 }, { usd: 0.2 }, { usd: 0.2, tokens: 10 }]);
    assert.equal(report.rejectedCostReports, 6);
    assert.deepEqual(report.cost.adapter, { usd: 0.2, tokens: 10 });
    assert.ok(report.runLog.some((entry) => /cumulative value went down from 0.1/.test(entry.message)));
  });

  it('the cumulative values of the two sources are tracked separately', async () => {
    const e = env();
    e.host.limitUsd = 100;
    const adapter: AgentAdapter = {
      name: 'both',
      async run(_input, context) {
        await context.gateway.call(TOOL, {}); // gateway 0.5
        context.onCostProgress({ cumulative: 0.1, unit: 'usd' }); // adapter 0.1 is lower than the gateway total but a different stream
        await context.gateway.call(TOOL, {}); // gateway 1
        return submitted({ usd: 0.1 });
      },
    };
    const report = await e.start(adapter);
    assert.equal(report.rejectedCostReports, 0);
    assert.deepEqual(e.host.usdCalls('gateway'), [0.5, 1]);
    assert.deepEqual(e.host.usdCalls('adapter'), [0.1]);
  });

  it('a ledger failure stops the agent and fails the run (never silently continues without budget enforcement)', async () => {
    const e = env();
    e.host.throwOnCost = true;
    const report = await e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'cost_progress' }));
    assert.equal(report.end.kind, 'failed');
    assert.equal(report.end.kind === 'failed' && report.end.code, 'cost_recording_failed');
  });
});

describe('final cost', () => {
  it('the final cost is not counted twice: progress 0.01, 0.03 and a final 0.03 reach the ledger as 0.01 and 0.03 only', async () => {
    const e = env();
    const report = await e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'cost_progress' }));
    assert.equal(report.end.kind, 'submitted');
    assert.deepEqual(e.host.usdCalls('adapter'), [0.01, 0.03]);
    assert.equal(e.timers.pending, 0);
  });

  it('only the difference is added when the final cost is above the last progress; a lower final cost keeps the reported value', async () => {
    const above = env();
    await above.start(reporting([{ cumulative: 0.03, unit: 'usd' }], submitted({ usd: 0.05 })));
    assert.deepEqual(above.host.usdCalls('adapter'), [0.03, 0.05]);

    const below = env();
    const report = await below.start(reporting([{ cumulative: 0.03, unit: 'usd' }], submitted({ usd: 0.02 })));
    assert.deepEqual(below.host.usdCalls('adapter'), [0.03]);
    assert.deepEqual(report.cost.adapter, { usd: 0.03 });
    assert.ok(report.runLog.some((entry) => /below the reported/.test(entry.message)));
  });

  it('the cost of an error or cancelled output is recorded too', async () => {
    const e = env();
    const report = await e.start(reporting([], { status: 'error', result: null, evidence: [], run_log: [], cost: { usd: 0.25 }, error: { code: 'agent_crashed', message: 'boom' } }));
    assert.equal(report.end.kind, 'failed');
    assert.equal(report.end.kind === 'failed' && report.end.code, 'agent_crashed');
    assert.deepEqual(e.host.usdCalls('adapter'), [0.25]);
  });
});

describe('late results', () => {
  it('a result that arrives right after the cancel signal is discarded (killed, no evidence recorded)', async () => {
    const e = env();
    const adapter: AgentAdapter = {
      name: 'slow-stopper',
      async run(_input, context) {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        return submitted({ usd: 0.4 });
      },
    };
    const run = e.start(adapter);
    await settle();
    e.timers.advance(30 * MIN);
    const report = await run;
    assert.equal(report.end.kind, 'killed');
    assert.equal(report.terminationConfirmed, true);
    assert.deepEqual(e.host.outputs[0]?.evidence, []);
    assert.deepEqual(report.cost.adapter, { usd: 0.4 }, 'the money it spent is still recorded');
  });

  it('an agent that ignores the cancel signal is given up on after the grace period; whatever it reports afterwards is ignored', async () => {
    const e = env();
    const release = deferred<void>();
    let lateReport: ((event: CostProgressEvent) => void) | null = null;
    const run = e.start(stubbornAdapter(release.promise, (progress) => { lateReport = progress; }));
    await settle();
    e.timers.advance(30 * MIN);
    await settle();
    assert.equal(e.done(), false, 'waits for the agent to stop during the grace period');
    e.timers.advance(DEFAULT_TERMINATION_GRACE_MS);
    const report = await run;
    assert.equal(report.end.kind, 'killed');
    assert.equal(report.terminationConfirmed, false);
    assert.ok(report.runLog.some((entry) => /giving up/.test(entry.message)));
    const callsAtEnd = e.host.costCalls.length;

    release.resolve();
    await settle();
    (lateReport as ((event: CostProgressEvent) => void) | null)?.({ cumulative: 0.9, unit: 'usd' });
    assert.equal(e.host.costCalls.length, callsAtEnd, 'a late cost_progress does not reach the ledger');
    assert.equal(e.host.outputs.length, 1, 'the late result is not recorded');
  });
});

describe('ending without a kill', () => {
  it('a policy denial inside the gateway does not kill the run: the agent gets an error answer and finishes normally', async () => {
    for (const verdict of [{ decision: 'deny', reason: 'rule x' }, { decision: 'require_approval', reason: 'needs a person' }] as const) {
      const e = env();
      e.policy.decide = () => verdict;
      const report = await e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'tool_calls', toolCalls: [{ tool: TOOL }] }));
      assert.equal(report.end.kind, 'submitted', verdict.decision);
      const result = report.end.kind === 'submitted' ? report.end.result : {};
      assert.deepEqual(result['tool_errors'], [{ tool: TOOL, error: verdict.decision === 'deny' ? 'policy_denied' : 'approval_required' }]);
      assert.equal(report.runLog.filter((entry) => /policy_denied|approval_required/.test(entry.message)).length >= 2, true, 'the gateway call record is in the run log');
      assert.equal(e.host.costCalls.length, 0, 'a denied call costs nothing');
    }
  });

  it('a successful run records the adapter evidence and the merged, time-ordered run log; the run log reference comes from the store', async () => {
    const e = env();
    const saved: { runId: string; entries: readonly RunLogEntry[] }[] = [];
    const store: RunLogStore = { save: (runId, entries) => { saved.push({ runId, entries }); return `run-log:${runId}`; } };
    const report = await e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'tool_calls', toolCalls: [{ tool: TOOL }], evidence: [{ kind: 'source_url', ref: 'https://docs.example.com/a' }] }), { runLogStore: store });
    assert.equal(report.end.kind, 'submitted');
    assert.equal(report.runLogRef, 'run-log:run-contract-1');
    assert.deepEqual(e.host.outputs.map((o) => [o.runLogRef, o.evidence.map((i) => [i.kind, i.ref])]), [['run-log:run-contract-1', [['source_url', 'https://docs.example.com/a']]]]);
    const messages = saved[0]!.entries.map((entry) => entry.message);
    assert.ok(messages.some((m) => m.startsWith('tool_call #1 example_search.search: ok')), 'gateway record');
    assert.ok(messages.some((m) => m.startsWith('started run-contract-1')), 'adapter log');
    assert.ok(messages.some((m) => m.startsWith('agent fake-agent started')), 'manager note');
    assert.deepEqual(messages, [...saved[0]!.entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((entry) => entry.message), 'ordered by time');
  });

  it('an outside cancel (lease lost) stops the agent, ends cancelled and records nothing', async () => {
    const e = env();
    const outside = new AbortController();
    const run = e.start(createFakeAgentAdapter({ clock: e.clock, scenario: 'wait_for_cancel' }), { signal: outside.signal });
    await settle();
    outside.abort();
    const report = await run;
    assert.equal(report.end.kind, 'cancelled');
    assert.equal(e.host.outputs.length, 0);
    assert.equal(e.timers.pending, 0);

    const pre = new AbortController();
    pre.abort();
    let started = false;
    const never = await env().start({ name: 'never', run() { started = true; return Promise.resolve(submitted({ usd: 0 })); } }, { signal: pre.signal });
    assert.equal(never.end.kind, 'cancelled');
    assert.equal(started, false);
  });

  it('an adapter that throws, returns a malformed output, or cancels by itself ends failed (retryable), not submitted', async () => {
    const cases: [string, AgentAdapter, string][] = [
      ['throws', { name: 'x', run: () => Promise.reject(new Error('kaput')) }, 'adapter_exception'],
      ['throws synchronously', { name: 'x', run: () => { throw new Error('kaput'); } }, 'adapter_exception'],
      ['malformed', { name: 'x', run: () => Promise.resolve({ status: 'bogus' } as unknown as AdapterOutput) }, 'invalid_adapter_output'],
      ['cancels itself', { name: 'x', run: () => Promise.resolve(submitted({ usd: 0 }, { status: 'cancelled', result: null })) }, 'adapter_cancelled'],
    ];
    for (const [label, adapter, code] of cases) {
      const e = env();
      const report = await e.start(adapter);
      assert.equal(report.end.kind, 'failed', label);
      assert.equal(report.end.kind === 'failed' && report.end.code, code, label);
      assert.equal(e.timers.pending, 0, label);
    }
  });

  it('if the evidence cannot be recorded a submitted result is not handed on', async () => {
    const e = env();
    e.host.throwOnOutput = true;
    const report = await e.start(createFakeAgentAdapter({ clock: e.clock }));
    assert.equal(report.end.kind, 'failed');
    assert.equal(report.end.kind === 'failed' && report.end.code, 'output_not_recorded');
  });

  it('a run log store failure does not change how the run ended', async () => {
    const e = env();
    const report = await e.start(createFakeAgentAdapter({ clock: e.clock }), { runLogStore: { save: () => Promise.reject(new Error('disk full')) } });
    assert.equal(report.end.kind, 'submitted');
    assert.equal(report.runLogRef, null);
  });
});

describe('file run log store', () => {
  it('writes one masked JSON line per entry to <dir>/<run id>.jsonl with owner-only permissions and returns the run-log: reference', async (t) => {
    const dir = join(makeTempDir(t), 'run-logs');
    const store = createFileRunLogStore({ dir });
    const secret = ['sk', 'runlog', 'z'.repeat(24)].join('-');
    const ref = await store.save('run-1', [{ at: START, message: `called with ${secret}` }, { at: START, message: 'second' }]);
    assert.equal(ref, 'run-log:run-1');
    const text = readFileSync(join(dir, 'run-1.jsonl'), 'utf8');
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as RunLogEntry);
    assert.equal(lines.length, 2);
    assert.ok(!text.includes(secret), 'secrets are masked');
    assert.equal(statSync(join(dir, 'run-1.jsonl')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    await assert.rejects(async () => store.save('../escape', []), /file name/);
  });
});
