// 도구 게이트웨이 계약 테스트 스위트 (단계 A5 U2). 어댑터 계약 스위트(adapter-contract.ts)와 별개다:
// 그쪽은 "어댑터가 게이트웨이를 올바르게 쓰는가", 이쪽은 "게이트웨이가 정책을 강제하는가"를 본다.
// `createToolGateway` 와 같은 옵션(`ToolGatewayOptions`)을 받아 `RunToolGateway` 를 돌려주는 factory 라면 무엇이든 같은 스위트를 통과해야 한다
// (예: 호스트 쪽 프레임 처리기가 감싼 게이트웨이). node:test 안에서 부른다:
//
//   runGatewayContractTests((options) => createToolGateway(options));
//
// 스위트는 정책·실행기·타이머·기록기를 직접 만들어 넣고(호출 횟수·요청을 센다), 시계는 FakeClock, 타임아웃은 손으로 돌리는 타이머를 쓴다
// (실제 시계·난수·지연 없음). 비밀값처럼 보이는 시험 값은 소스에 통째로 두지 않고 실행 때 조립한다(비밀 스캐너 오탐 방지).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeClock, type ToolCallPolicy, type ToolCallPolicyRequest, type ToolCallPolicyVerdict } from '@aot/domain';

import { encodeFrame, MAX_FRAME_BYTES, MAX_TOOL_RESULT_BYTES, REDACTED } from '@aot/agent-runtime';
import type {
  AdapterCost, CostProgressEvent, GatewayTimers, GatewayToolSpec, JsonObject, RunToolGateway, ToolCallRecord, ToolExecutionRequest,
  ToolExecutionResult, ToolGatewayOptions, ToolGatewayResponse,
} from '@aot/agent-runtime';

export type GatewayFactory = (options: ToolGatewayOptions) => RunToolGateway;

export interface GatewaySuiteOptions {
  name?: string;
}

// ===== 시험 도구 =====

export const TOOL_SEARCH = 'example_search';
export const TOOL_FETCH = 'example_web_fetch';
export const TOOL_NOTES = 'example_notes_write';
export const TOOL_TIMEOUT_MS = 1000;

/** 허용 도구: 내부 읽기, 외부 출처 읽기(웹 조회), 부작용 있는 내부 쓰기 */
export function contractTools(): GatewayToolSpec[] {
  return [
    { tool: TOOL_SEARCH, operation: 'search', scope: 'internal', sideEffect: false, unitCost: { usd: 0.01 } },
    { tool: TOOL_FETCH, operation: 'fetch', scope: 'internal', sideEffect: false, resultOrigin: 'external_untrusted', unitCost: { usd: 0.02 } },
    { tool: TOOL_NOTES, operation: 'write', scope: 'internal', impact: 'write', sideEffect: true, target: 'notes:task-own', unitCost: { usd: 0.03 } },
  ];
}

// ===== 시험 도구 상자 =====

export interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 저절로 흐르지 않는 타이머. `advance(ms)` 로 가상 시간을 보내면 기한이 된 콜백이 돈다 */
export class ManualGatewayTimers implements GatewayTimers {
  #now = 0;
  #next = 1;
  readonly #pending = new Map<number, { due: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#pending.set(id, { due: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#pending.delete(handle as number);
  }

  advance(ms: number): void {
    this.#now += ms;
    for (const [id, entry] of [...this.#pending]) {
      if (entry.due > this.#now || !this.#pending.has(id)) continue;
      this.#pending.delete(id);
      entry.fn();
    }
  }

  get pending(): number {
    return this.#pending.size;
  }
}

export type ExecutorImpl = (request: ToolExecutionRequest) => Promise<ToolExecutionResult>;
const echoExecutor: ExecutorImpl = (request) => Promise.resolve({ result: { tool: request.tool, args: request.args as JsonObject } });

export interface PolicyScript extends ToolCallPolicy {
  /** 받은 판정 요청 (호출 순서) */
  readonly requests: ToolCallPolicyRequest[];
  /** 판정 규칙을 바꾼다. 기본은 모두 allow */
  decide: (request: ToolCallPolicyRequest) => ToolCallPolicyVerdict | Promise<ToolCallPolicyVerdict>;
}

export interface Harness {
  gateway: RunToolGateway;
  clock: FakeClock;
  timers: ManualGatewayTimers;
  policy: PolicyScript;
  progress: CostProgressEvent[];
  recorded: ToolCallRecord[];
  /** 실행기에 도착한 요청 (도구 이름별) */
  executed(tool?: string): ToolExecutionRequest[];
  abort(reason?: unknown): void;
}

export interface HarnessOptions {
  tools?: GatewayToolSpec[];
  executors?: Record<string, ExecutorImpl>;
  decide?: PolicyScript['decide'];
  externalInput?: boolean;
  recorder?: (record: ToolCallRecord) => void | Promise<void>;
  /** 처음부터 abort 된 신호로 시작 */
  aborted?: boolean;
}

const START = '2026-10-22T00:00:00.000Z';

function buildHarness(factory: GatewayFactory, options: HarnessOptions = {}): Harness {
  const clock = new FakeClock(START);
  const timers = new ManualGatewayTimers();
  const tools = options.tools ?? contractTools();
  const calls: ToolExecutionRequest[] = [];
  const executors = new Map(tools.map((spec) => {
    const impl = options.executors?.[spec.tool] ?? echoExecutor;
    return [spec.tool, (request: ToolExecutionRequest) => {
      calls.push(request);
      return impl(request);
    }] as const;
  }));
  const policy: PolicyScript = {
    requests: [],
    decide: options.decide ?? (() => ({ decision: 'allow' })),
    judge(request) {
      this.requests.push(request);
      return this.decide(request);
    },
  };
  const progress: CostProgressEvent[] = [];
  const recorded: ToolCallRecord[] = [];
  const controller = new AbortController();
  if (options.aborted) controller.abort(new Error('run cancelled'));
  const gateway = factory({
    runId: 'run-gw-1',
    taskId: 'task-gw-1',
    subject: 'generalist@v1',
    tools,
    executors,
    policy,
    recorder: { record: async (record) => { recorded.push(record); await options.recorder?.(record); } },
    clock,
    constraints: { max_usd: 2, time_limit: '30m', network_allowlist: ['search.example.com'] },
    toolTimeoutMs: TOOL_TIMEOUT_MS,
    timers,
    signal: controller.signal,
    onCostProgress: (event) => void progress.push(event),
    ...(options.externalInput === undefined ? {} : { externalInput: options.externalInput }),
  });
  return {
    gateway, clock, timers, policy, progress, recorded,
    executed: (tool) => (tool === undefined ? calls : calls.filter((c) => c.tool === tool)),
    abort: (reason) => controller.abort(reason ?? new Error('run cancelled')),
  };
}

// 비밀처럼 보이는 시험 값 (소스에 통째로 두지 않는다)
export const FAKE_API_KEY = ['sk', 'contract', 'x'.repeat(24)].join('-');
export const FAKE_BEARER = `Bearer ${'ab12'.repeat(8)}`;
export const FAKE_PASSWORD = ['pw', 'contract', 'y'.repeat(10)].join('-');

const refusal = (response: ToolGatewayResponse): string => {
  assert.equal(response.ok, false, `expected a refusal, got ${JSON.stringify(response).slice(0, 200)}`);
  return (response as { ok: false; error: string }).error;
};
const okResult = (response: ToolGatewayResponse) => {
  assert.equal(response.ok, true, `expected ok, got ${JSON.stringify(response).slice(0, 200)}`);
  return (response as { ok: true; result: unknown }).result;
};
const sumUsd = (records: readonly ToolCallRecord[]): number => records.reduce((sum, r) => sum + (r.cost.usd ?? 0), 0);

export function runGatewayContractTests(factory: GatewayFactory, options: GatewaySuiteOptions = {}): void {
  const make = (o: HarnessOptions = {}): Harness => buildHarness(factory, o);

  describe(`gateway contract: ${options.name ?? 'gateway'}`, () => {
    describe('allow list', () => {
      it('refuses a tool outside the allowed list with tool_not_allowed; neither the policy nor any executor is touched', async () => {
        const h = make();
        for (const name of ['example_forbidden_tool', 'constructor', '__proto__', 'toString', '']) {
          assert.equal(refusal(await h.gateway.call(name, {})), 'tool_not_allowed', `tool '${name}'`);
        }
        assert.equal(h.policy.requests.length, 0);
        assert.equal(h.executed().length, 0);
        assert.equal(h.gateway.records().length, 5);
        assert.ok(h.gateway.records().every((r) => r.outcome === 'tool_not_allowed' && r.decision === null));
      });

      it('rejects arguments that are not a JSON object with invalid_args before any judgement', async () => {
        const h = make();
        const bad: unknown[] = [null, [1], 'text', { fn: () => 1 }, { n: Number.NaN }, { undef: undefined }];
        for (const args of bad) assert.equal(refusal(await h.gateway.call(TOOL_SEARCH, args as JsonObject)), 'invalid_args');
        assert.equal(h.policy.requests.length, 0);
        assert.equal(h.executed().length, 0);
      });
    });

    describe('policy re-judgement on every call', () => {
      it('a deny verdict means the executor is never called (call count 0) and the agent only sees the code', async () => {
        const reason = 'denied by rule internal-secret-rule-7';
        const h = make({ decide: () => ({ decision: 'deny', reason }) });
        const response = await h.gateway.call(TOOL_SEARCH, { query: 'example' });
        assert.equal(refusal(response), 'policy_denied');
        assert.equal(h.executed().length, 0);
        assert.equal(h.policy.requests.length, 1);
        assert.ok(!JSON.stringify(response).includes('secret-rule'), 'the policy reason must not reach the agent');
        const [record] = h.gateway.records();
        assert.equal(record!.outcome, 'policy_denied');
        assert.equal(record!.decision, 'deny');
        assert.match(record!.reason ?? '', /internal-secret-rule-7/, 'the reason is kept in the record');
        assert.equal(h.timers.pending, 0, 'no timeout timer is left for a call that never ran');
      });

      it('require_approval blocks the call: no execution, and the agent cannot approve its own call', async () => {
        const h = make({ decide: () => ({ decision: 'require_approval', reason: 'needs a human' }) });
        assert.equal(refusal(await h.gateway.call(TOOL_NOTES, { text: 'x' })), 'approval_required');
        // 에이전트가 승인을 주장하는 인자를 넣어도 판정은 바뀌지 않는다
        assert.equal(refusal(await h.gateway.call(TOOL_NOTES, { text: 'x', approved: true, approval_id: 'a-1' })), 'approval_required');
        assert.equal(h.executed().length, 0);
        assert.deepEqual(h.gateway.records().map((r) => [r.outcome, r.decision]), [['approval_required', 'require_approval'], ['approval_required', 'require_approval']]);
      });

      it('a policy that throws or returns a malformed verdict is a default deny (policy_unavailable), not an allow', async () => {
        const h = make({ decide: () => { throw new Error('policy store offline'); } });
        assert.equal(refusal(await h.gateway.call(TOOL_SEARCH, {})), 'policy_unavailable');
        h.policy.decide = (() => ({ decision: 'maybe' })) as unknown as PolicyScript['decide'];
        assert.equal(refusal(await h.gateway.call(TOOL_SEARCH, {})), 'policy_unavailable');
        h.policy.decide = (() => Promise.reject(new Error('rejected'))) as PolicyScript['decide'];
        assert.equal(refusal(await h.gateway.call(TOOL_SEARCH, {})), 'policy_unavailable');
        assert.equal(h.executed().length, 0);
        assert.ok(h.gateway.records().every((r) => r.decision === 'deny'));
      });

      it('judges again on every call: the same tool twice gives two judgements, and a policy change in between refuses the second call', async () => {
        const h = make();
        okResult(await h.gateway.call(TOOL_SEARCH, { query: 'one' }));
        assert.equal(h.policy.requests.length, 1);
        h.clock.advance(5000);
        okResult(await h.gateway.call(TOOL_SEARCH, { query: 'two' }));
        assert.equal(h.policy.requests.length, 2, 'the verdict of the first call is not reused');
        assert.notEqual(h.policy.requests[0]!.now, h.policy.requests[1]!.now, 'each judgement carries its own time');

        h.policy.decide = () => ({ decision: 'deny', reason: 'policy tightened' });
        assert.equal(refusal(await h.gateway.call(TOOL_SEARCH, { query: 'three' })), 'policy_denied');
        assert.equal(h.policy.requests.length, 3);
        assert.equal(h.executed(TOOL_SEARCH).length, 2, 'the third call never reached the executor');
      });

      it('hands the policy the declared facts of the tool (7-element inputs) and never the arguments', async () => {
        const h = make();
        await h.gateway.call(TOOL_NOTES, { text: 'private note' });
        const request = h.policy.requests[0]!;
        assert.deepEqual(
          { ...request, now: undefined },
          {
            runId: 'run-gw-1', taskId: 'task-gw-1', subject: 'generalist@v1', tool: TOOL_NOTES, operation: 'write', target: 'notes:task-own',
            scope: 'internal', impact: 'write', sideEffect: true, influencedByExternalInput: false,
            constraints: { max_usd: 2, time_limit: '30m', network_allowlist: ['search.example.com'] }, now: undefined,
          },
        );
        assert.equal(request.now, START);
        assert.ok(!JSON.stringify(request).includes('private note'));
        await h.gateway.call(TOOL_SEARCH, {});
        assert.equal(h.policy.requests[1]!.target, null, 'a tool without a declared target is judged with target null');
        assert.equal(h.policy.requests[1]!.impact, 'read');
      });
    });

    describe('tool call timeout', () => {
      it('aborts the executor signal and answers tool_timeout without waiting for an executor that ignores the signal', async () => {
        const never = deferred<ToolExecutionResult>();
        const h = make({ executors: { [TOOL_SEARCH]: () => never.promise } });
        const pending = h.gateway.call(TOOL_SEARCH, { query: 'slow' });
        await tick();
        assert.equal(h.executed(TOOL_SEARCH).length, 1);
        const signal = h.executed(TOOL_SEARCH)[0]!.signal;
        assert.equal(signal.aborted, false);
        h.timers.advance(TOOL_TIMEOUT_MS - 1);
        assert.equal(signal.aborted, false, 'not before the timeout');
        h.timers.advance(1);
        assert.equal(refusal(await pending), 'tool_timeout');
        assert.equal(signal.aborted, true, 'the executor is told to stop');
        assert.equal(h.gateway.records()[0]!.outcome, 'tool_timeout');
        assert.equal(h.timers.pending, 0);
      });

      it('a result that arrives after the timeout is not mixed into any response, record, cost or influence state', async () => {
        const late = deferred<ToolExecutionResult>();
        const h = make({ executors: { [TOOL_FETCH]: () => late.promise } });
        const pending = h.gateway.call(TOOL_FETCH, { url: 'https://example.com/' });
        await tick();
        h.timers.advance(TOOL_TIMEOUT_MS);
        assert.equal(refusal(await pending), 'tool_timeout');
        const before = JSON.stringify([h.gateway.records(), h.gateway.cost(), h.progress]);

        late.resolve({ result: { page: 'late page content' }, cost: { usd: 0.5 } });
        await tick();
        await tick();
        assert.equal(JSON.stringify([h.gateway.records(), h.gateway.cost(), h.progress]), before, 'nothing changes when the late result arrives');
        assert.equal(h.gateway.externalInputSeen(), false, 'a result the agent never received does not taint the run');

        // 다음 호출은 자기 결과만 받는다
        const next = await h.gateway.call(TOOL_SEARCH, { query: 'after' });
        assert.deepEqual(okResult(next), { tool: TOOL_SEARCH, args: { query: 'after' } });
        assert.equal(h.policy.requests.at(-1)!.influencedByExternalInput, false);
      });

      it('a late rejection after the timeout is swallowed (no unhandled rejection) and a per-tool timeout applies', async () => {
        const late = deferred<ToolExecutionResult>();
        const tools = contractTools().map((t) => (t.tool === TOOL_SEARCH ? { ...t, timeoutMs: 10 } : t));
        const h = make({ tools, executors: { [TOOL_SEARCH]: () => late.promise } });
        const pending = h.gateway.call(TOOL_SEARCH, {});
        await tick();
        h.timers.advance(10);
        assert.equal(refusal(await pending), 'tool_timeout');
        late.reject(new Error('connection reset'));
        await tick();
        assert.equal(h.gateway.records().length, 1);
      });
    });

    describe('external input influence (trust-boundaries 2-3)', () => {
      it('marks calls after an external-origin result as influenced; earlier calls and internal results do not', async () => {
        const h = make();
        okResult(await h.gateway.call(TOOL_SEARCH, {}));
        okResult(await h.gateway.call(TOOL_NOTES, { text: 'before external input' }));
        assert.deepEqual(h.policy.requests.map((r) => r.influencedByExternalInput), [false, false]);
        assert.equal(h.gateway.externalInputSeen(), false);

        okResult(await h.gateway.call(TOOL_FETCH, { url: 'https://example.com/' }));
        assert.equal(h.policy.requests[2]!.influencedByExternalInput, false, 'the fetch itself ran before any external content arrived');
        assert.equal(h.gateway.externalInputSeen(), true);

        okResult(await h.gateway.call(TOOL_SEARCH, {}));
        assert.equal(h.policy.requests[3]!.influencedByExternalInput, true, 'reads after external content are marked too');
        assert.deepEqual(h.gateway.records().map((r) => r.influenced_by_external_input), [false, false, false, true]);
      });

      it('a side-effect call after external input carries the flag into the policy request and is blocked when the policy answers approval', async () => {
        const h = make({ decide: (r) => (r.sideEffect && r.influencedByExternalInput ? { decision: 'require_approval', reason: 'external influence' } : { decision: 'allow' }) });
        okResult(await h.gateway.call(TOOL_FETCH, { url: 'https://example.com/' }));
        assert.equal(refusal(await h.gateway.call(TOOL_NOTES, { text: 'injected instruction' })), 'approval_required');
        const request = h.policy.requests.at(-1)!;
        assert.equal(request.sideEffect, true);
        assert.equal(request.influencedByExternalInput, true);
        assert.equal(h.executed(TOOL_NOTES).length, 0);
        const record = h.gateway.records().at(-1)!;
        assert.equal(record.influenced_by_external_input, true);
        assert.equal(record.side_effect, true);
      });

      it('even a permissive policy cannot let an influenced side-effect call through (gateway floor); influenced reads stay allowed', async () => {
        const h = make({ decide: () => ({ decision: 'allow' }) });
        okResult(await h.gateway.call(TOOL_FETCH, { url: 'https://example.com/' }));
        assert.equal(refusal(await h.gateway.call(TOOL_NOTES, { text: 'x' })), 'approval_required');
        assert.equal(h.executed(TOOL_NOTES).length, 0);
        okResult(await h.gateway.call(TOOL_SEARCH, {}));
      });

      it('external content already in the run input marks every call from the start', async () => {
        const h = make({ externalInput: true });
        assert.equal(h.gateway.externalInputSeen(), true);
        assert.equal(refusal(await h.gateway.call(TOOL_NOTES, { text: 'x' })), 'approval_required');
        assert.equal(h.policy.requests[0]!.influencedByExternalInput, true);
      });

      it('a failed or refused external call delivers no content, so it does not taint the run', async () => {
        const h = make({ executors: { [TOOL_FETCH]: () => Promise.reject(new Error('dns failure')) } });
        assert.equal(refusal(await h.gateway.call(TOOL_FETCH, {})), 'tool_error');
        assert.equal(h.gateway.externalInputSeen(), false);
        h.policy.decide = () => ({ decision: 'deny', reason: 'no' });
        assert.equal(refusal(await h.gateway.call(TOOL_FETCH, {})), 'policy_denied');
        assert.equal(h.gateway.externalInputSeen(), false);
        h.policy.decide = () => ({ decision: 'allow' });
        okResult(await h.gateway.call(TOOL_NOTES, { text: 'still fine' }));
      });
    });

    describe('cost metering', () => {
      it('accumulates per-call cost monotonically and reports it as cost_progress', async () => {
        const reported: AdapterCost[] = [{ usd: 0.25, tokens: 100 }, { tokens: 50 }, {}];
        let n = 0;
        const h = make({ executors: { [TOOL_SEARCH]: () => Promise.resolve({ result: { n }, cost: reported[n++] ?? {} }) } });
        const seen: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          await h.gateway.call(TOOL_SEARCH, {});
          seen.push(h.gateway.cost().usd ?? 0);
        }
        assert.deepEqual(h.gateway.cost(), { usd: 0.25, tokens: 150 });
        assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'usd never decreases');
        const lastByUnit: Partial<Record<CostProgressEvent['unit'], number>> = {};
        for (const event of h.progress) {
          const before = lastByUnit[event.unit] ?? 0;
          assert.ok(event.cumulative > before, `cumulative ${event.unit} must grow: ${before} -> ${event.cumulative}`);
          lastByUnit[event.unit] = event.cumulative;
        }
        assert.deepEqual(lastByUnit, { usd: 0.25, tokens: 150 });
        assert.deepEqual(h.gateway.records().map((r) => r.cost), [{ usd: 0.25, tokens: 100 }, { tokens: 50 }, {}, {}]);
      });

      it('falls back to the tool unit cost when the executor reports none (or an invalid value); refusals cost nothing', async () => {
        const h = make({ executors: { [TOOL_FETCH]: () => Promise.resolve({ result: 'page', cost: { usd: -1 } }) } });
        await h.gateway.call(TOOL_SEARCH, {});
        await h.gateway.call(TOOL_FETCH, {});
        assert.ok(Math.abs((h.gateway.cost().usd ?? 0) - 0.03) < 1e-9);
        const before = h.gateway.cost();
        h.policy.decide = () => ({ decision: 'deny', reason: 'no' });
        await h.gateway.call(TOOL_SEARCH, {});
        await h.gateway.call('example_forbidden_tool', {});
        assert.deepEqual(h.gateway.cost(), before);
        assert.ok(Math.abs(sumUsd(h.gateway.records()) - 0.03) < 1e-9);
      });

      it('a timed-out or failed call is still charged the unit cost; the late result does not change it', async () => {
        const late = deferred<ToolExecutionResult>();
        const h = make({ executors: { [TOOL_SEARCH]: () => late.promise, [TOOL_NOTES]: () => Promise.reject(new Error('boom')) } });
        const pending = h.gateway.call(TOOL_SEARCH, {});
        await tick();
        h.timers.advance(TOOL_TIMEOUT_MS);
        await pending;
        await h.gateway.call(TOOL_NOTES, { text: 'x' });
        assert.ok(Math.abs((h.gateway.cost().usd ?? 0) - 0.04) < 1e-9);
        late.resolve({ result: 'late', cost: { usd: 9 } });
        await tick();
        assert.ok(Math.abs((h.gateway.cost().usd ?? 0) - 0.04) < 1e-9);
      });
    });

    describe('run_log and records', () => {
      it('records every call - allowed, refused, timed out, failed - in order, one run_log entry each, with the Clock time', async () => {
        const never = deferred<ToolExecutionResult>();
        const h = make({ executors: { [TOOL_FETCH]: () => never.promise, [TOOL_NOTES]: () => Promise.reject(new Error('boom')) } });
        await h.gateway.call(TOOL_SEARCH, { query: 'a' });
        await h.gateway.call('example_forbidden_tool', {});
        h.policy.decide = (r) => (r.tool === TOOL_SEARCH ? { decision: 'deny', reason: 'no' } : { decision: 'allow' });
        await h.gateway.call(TOOL_SEARCH, { query: 'b' });
        const pending = h.gateway.call(TOOL_FETCH, {});
        await tick();
        h.clock.advance(TOOL_TIMEOUT_MS);
        h.timers.advance(TOOL_TIMEOUT_MS);
        await pending;
        await h.gateway.call(TOOL_NOTES, { text: 'c' });

        const records = h.gateway.records();
        assert.deepEqual(records.map((r) => r.outcome), ['ok', 'tool_not_allowed', 'policy_denied', 'tool_timeout', 'tool_error']);
        assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4, 5]);
        assert.ok(records.every((r) => r.run_id === 'run-gw-1'));
        assert.equal(records[0]!.at, START);
        const log = h.gateway.runLog();
        assert.equal(log.length, 5);
        assert.ok(log.every((entry, i) => entry.at === records[i]!.at && entry.message.includes(`#${records[i]!.seq}`) && entry.message.includes(records[i]!.outcome)));
        assert.deepEqual(h.recorded.map((r) => r.seq), [1, 2, 3, 4, 5], 'the recorder port saw every call');
        assert.equal(records[3]!.duration_ms, TOOL_TIMEOUT_MS);
      });

      it('a recorder that throws does not change the response, and the failure is counted', async () => {
        const h = make({ recorder: () => { throw new Error('disk full'); } });
        okResult(await h.gateway.call(TOOL_SEARCH, {}));
        assert.equal(h.gateway.recorderFailures(), 1);
        assert.equal(h.gateway.records().length, 1);
      });

      it('hands the recorder frozen records', async () => {
        const h = make();
        await h.gateway.call(TOOL_SEARCH, {});
        assert.throws(() => { (h.recorded[0] as { outcome: string }).outcome = 'tampered'; }, TypeError);
      });
    });

    describe('arguments are never altered', () => {
      it('the executor receives an equal, frozen copy; the caller\'s object is untouched even when it changes while the policy is deciding', async () => {
        const args: JsonObject = { query: 'example', filters: { lang: ['ko', 'en'] } };
        const pristine = structuredClone(args);
        const h = make({
          decide: () => {
            (args['filters'] as JsonObject)['lang'] = ['evil'];
            args['query'] = 'changed after the verdict';
            return { decision: 'allow' };
          },
        });
        okResult(await h.gateway.call(TOOL_SEARCH, args));
        const received = h.executed(TOOL_SEARCH)[0]!.args;
        assert.deepEqual(received, pristine, 'what is executed is what was submitted for judgement');
        assert.ok(Object.isFrozen(received) && Object.isFrozen(received['filters']));
        assert.throws(() => { (received as JsonObject)['query'] = 'x'; }, TypeError);
      });

      it('a deep-frozen caller object is accepted and stays unchanged', async () => {
        const args = Object.freeze({ query: Object.freeze(['a', 'b']) }) as unknown as JsonObject;
        const h = make();
        okResult(await h.gateway.call(TOOL_SEARCH, args));
        assert.deepEqual(args, { query: ['a', 'b'] });
      });
    });

    describe('secrets in records', () => {
      it('masks secret-looking arguments, results and error messages in the records, but returns the result to the agent unchanged', async () => {
        const result = { page: `see ${FAKE_BEARER}`, access_token: FAKE_API_KEY, max_tokens: 4096 };
        const h = make({
          executors: {
            [TOOL_SEARCH]: () => Promise.resolve({ result }),
            [TOOL_NOTES]: () => Promise.reject(new Error(`login failed for https://user:${FAKE_PASSWORD}@example.com/ with ${FAKE_API_KEY}`)),
          },
        });
        const args = { query: 'example', api_key: FAKE_API_KEY, headers: { Authorization: FAKE_BEARER }, url: `https://user:${FAKE_PASSWORD}@example.com/x?token=${FAKE_API_KEY}` };
        assert.deepEqual(okResult(await h.gateway.call(TOOL_SEARCH, args)), result, 'the agent gets the executor result as is');
        assert.equal(refusal(await h.gateway.call(TOOL_NOTES, { text: 'x', password: FAKE_PASSWORD })), 'tool_error');

        const dump = JSON.stringify([h.gateway.records(), h.gateway.runLog(), h.recorded]);
        for (const secret of [FAKE_API_KEY, FAKE_PASSWORD, FAKE_BEARER.slice(7)]) assert.ok(!dump.includes(secret), `a secret value leaked into the records: ${secret.slice(0, 6)}...`);
        assert.ok(dump.includes(REDACTED));
        const first = h.gateway.records()[0]!;
        assert.match(first.args_preview, /"query":"example"/, 'non-secret arguments stay readable');
        assert.match(first.result_preview ?? '', /"max_tokens":4096/, 'counters named like tokens are not mistaken for secrets');
      });

      it('a synchronously throwing executor is a tool_error, not a crash', async () => {
        const h = make({ executors: { [TOOL_SEARCH]: () => { throw new Error('sync failure'); } } });
        assert.deepEqual(await h.gateway.call(TOOL_SEARCH, {}), { ok: false, error: 'tool_error' });
        assert.equal(h.timers.pending, 0);
      });

      it('does not echo the executor error message to the agent', async () => {
        const h = make({ executors: { [TOOL_SEARCH]: () => Promise.reject(new Error('internal path /srv/example/secret-config')) } });
        const response = await h.gateway.call(TOOL_SEARCH, {});
        assert.deepEqual(response, { ok: false, error: 'tool_error' });
      });
    });

    describe('result size', () => {
      const FRAME_ID = Number.MAX_SAFE_INTEGER;
      const asFrame = (response: ToolGatewayResponse) => encodeFrame({ type: 'tool_result', id: FRAME_ID, ...(response.ok ? { result: response.result } : { error: response.error }) });

      it('truncates an oversized result so the tool_result frame still fits MAX_FRAME_BYTES, and says so', async () => {
        const shapes: Record<string, string> = {
          ascii: 'x'.repeat(MAX_FRAME_BYTES * 2),
          multibyte: '가'.repeat(MAX_FRAME_BYTES),
          escaped: '\u0001'.repeat(MAX_FRAME_BYTES),
          quotes: '"\\'.repeat(MAX_FRAME_BYTES),
        };
        for (const [shape, blob] of Object.entries(shapes)) {
          const h = make({ executors: { [TOOL_SEARCH]: () => Promise.resolve({ result: { blob } }) } });
          const response = await h.gateway.call(TOOL_SEARCH, {});
          const result = okResult(response) as { truncated?: boolean; original_bytes?: number; preview?: string };
          assert.equal(result.truncated, true, shape);
          assert.ok((result.original_bytes ?? 0) > MAX_TOOL_RESULT_BYTES, shape);
          assert.ok((result.preview ?? '').length > 0 && (result.preview ?? '').startsWith('{"blob":"'), shape);
          assert.ok(asFrame(response).ok, `${shape}: the truncated response must fit one frame`);
          const [record] = h.gateway.records();
          assert.equal(record!.result_truncated, true);
          assert.equal(record!.result_bytes, result.original_bytes);
          assert.ok((record!.result_preview ?? '').length <= 1030, 'the record keeps only a short preview');
        }
      });

      it('passes a result under the limit through untouched', async () => {
        const result = { page: 'y'.repeat(MAX_TOOL_RESULT_BYTES - 1000) };
        const h = make({ executors: { [TOOL_SEARCH]: () => Promise.resolve({ result }) } });
        const response = await h.gateway.call(TOOL_SEARCH, {});
        assert.deepEqual(okResult(response), result);
        assert.ok(asFrame(response).ok);
        assert.equal(h.gateway.records()[0]!.result_truncated, false);
      });

      it('treats a non-JSON executor result as a tool error', async () => {
        const h = make({ executors: { [TOOL_SEARCH]: () => Promise.resolve({ result: { fn: () => 1 } } as unknown as ToolExecutionResult) } });
        assert.equal(refusal(await h.gateway.call(TOOL_SEARCH, {})), 'tool_error');
      });
    });

    describe('run cancellation', () => {
      it('an already-cancelled run refuses calls with run_cancelled without judging or executing', async () => {
        const h = make({ aborted: true });
        assert.equal(refusal(await h.gateway.call(TOOL_SEARCH, {})), 'run_cancelled');
        assert.equal(h.policy.requests.length, 0);
        assert.equal(h.executed().length, 0);
        assert.equal(h.gateway.records()[0]!.outcome, 'run_cancelled');
      });

      it('cancelling while a call is in flight aborts the executor and answers run_cancelled promptly', async () => {
        const never = deferred<ToolExecutionResult>();
        const h = make({ executors: { [TOOL_SEARCH]: () => never.promise } });
        const pending = h.gateway.call(TOOL_SEARCH, {});
        await tick();
        h.abort();
        assert.equal(refusal(await pending), 'run_cancelled');
        assert.equal(h.executed(TOOL_SEARCH)[0]!.signal.aborted, true);
        assert.equal(h.timers.pending, 0);
        assert.equal(refusal(await h.gateway.call(TOOL_SEARCH, {})), 'run_cancelled');
      });
    });
  });
}
