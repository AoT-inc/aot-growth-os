// 승인을 부작용 원장에 넘기는 예외 (effect-ledger.ts, gateway.ts): 이 예외는 스펙의 표시가 아니라 `bindToEffectLedger` 로 만든 실행기에만 있다.
// 호출별 정책 판정이 `require_approval` 일 때 원장에 묶인 실행기만 막히지 않고(원장이 전송 직전에 사람의 업무 승인을 확인한다), 그 밖의 모든 경우는 그대로 막힌다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock, type ToolCallPolicyVerdict } from '@aot/domain';
import { bindToEffectLedger, createToolGateway, isEffectLedgerBound, type GatewayToolSpec, type ToolExecutionRequest, type ToolExecutionResult, type ToolExecutor } from '@aot/agent-runtime';

import { ManualGatewayTimers } from '../support/gateway-contract.ts';

const SPEC: GatewayToolSpec = { tool: 'mailer', operation: 'send', scope: 'customer', impact: 'external_effect', sideEffect: true };
const NEEDS_APPROVAL: ToolCallPolicyVerdict = { decision: 'require_approval', reason: 'external effect' };

interface Ledger { calls: string[]; refuse: boolean }
const ledgerOf = (state: Ledger) => (tool: string, step: { stepId: string }) => {
  state.calls.push(`${tool}:${step.stepId}`);
  return state.refuse ? Promise.reject(new Error('the effect ledger refused: no valid approval')) : Promise.resolve({ state: 'confirmed' as const });
};

/** 원장에 묶인 실행기. body 가 부작용을 보내는 쪽(`sent`)을 센다 */
function bound(state: Ledger, sent: { n: number }, body?: (request: ToolExecutionRequest, perform: Parameters<Parameters<typeof bindToEffectLedger<ToolExecutionRequest, ToolExecutionResult, { stepId: string }, { state: 'confirmed' }>>[0]['run']>[1]) => Promise<ToolExecutionResult>): ToolExecutor {
  return bindToEffectLedger<ToolExecutionRequest, ToolExecutionResult, { stepId: string }, { state: 'confirmed' }>({
    ledger: ledgerOf(state),
    run: body ?? (async (_request, perform) => {
      await perform('mailer', { stepId: 's1' });
      sent.n += 1; // 원장이 허락한 뒤에만 도달한다
      return { result: { sent: true } };
    }),
  }) as ToolExecutor;
}

function gateway(verdict: ToolCallPolicyVerdict, executor: ToolExecutor, options: { externalInput?: boolean; spec?: GatewayToolSpec } = {}) {
  const spec = options.spec ?? SPEC;
  return createToolGateway({
    runId: 'run-1', taskId: null, subject: 'generalist@v1', tools: [spec], executors: new Map([[spec.tool, executor]]),
    policy: { judge: () => verdict }, clock: new FakeClock(), constraints: { max_usd: 1 }, toolTimeoutMs: 1000, timers: new ManualGatewayTimers(),
    ...(options.externalInput === undefined ? {} : { externalInput: options.externalInput }),
  });
}

const plain = (counter: { n: number }): ToolExecutor => () => { counter.n += 1; return Promise.resolve({ result: { sent: true } }); };

test('an ordinary executor on a side-effect tool stays blocked on require_approval (the gateway has no approval path)', async () => {
  const ran = { n: 0 };
  assert.deepEqual(await gateway(NEEDS_APPROVAL, plain(ran)).call('mailer', {}), { ok: false, error: 'approval_required' });
  assert.equal(ran.n, 0);
});

test('a ledger-bound executor reaches the ledger on require_approval; the recorded decision is still what the policy said', async () => {
  const state: Ledger = { calls: [], refuse: false };
  const sent = { n: 0 };
  const g = gateway(NEEDS_APPROVAL, bound(state, sent));
  assert.deepEqual(await g.call('mailer', {}), { ok: true, result: { sent: true } });
  assert.deepEqual(state.calls, ['mailer:s1']);
  assert.equal(sent.n, 1);
  const record = g.records()[0]!;
  assert.equal(record.decision, 'require_approval');
  assert.match(record.reason ?? '', /re-checked by the effect ledger/);
});

test('when the ledger refuses (no valid person approval), nothing is sent and the agent gets a tool error', async () => {
  const state: Ledger = { calls: [], refuse: true };
  const sent = { n: 0 };
  assert.deepEqual(await gateway(NEEDS_APPROVAL, bound(state, sent)).call('mailer', {}), { ok: false, error: 'tool_error' });
  assert.equal(sent.n, 0, 'the side effect after the ledger call was never reached');
});

test('deny is never deferred, even for a ledger-bound executor', async () => {
  const state: Ledger = { calls: [], refuse: false };
  assert.deepEqual(await gateway({ decision: 'deny', reason: 'no' }, bound(state, { n: 0 })).call('mailer', {}), { ok: false, error: 'policy_denied' });
  assert.deepEqual(state.calls, []);
});

test('a run influenced by external input cannot defer: the floor blocks it, whatever the policy says', async () => {
  for (const verdict of [NEEDS_APPROVAL, { decision: 'allow' } as const]) {
    const state: Ledger = { calls: [], refuse: false };
    assert.deepEqual(await gateway(verdict, bound(state, { n: 0 }), { externalInput: true }).call('mailer', {}), { ok: false, error: 'approval_required' }, verdict.decision);
    assert.deepEqual(state.calls, []);
  }
});

test('the exception cannot be forged: a spec flag, a lookalike property, or a wrapper around a bound executor does not count', async () => {
  const state: Ledger = { calls: [], refuse: false };
  const inner = bound(state, { n: 0 });
  const ran = { n: 0 };
  const forgeries: [string, ToolExecutor, GatewayToolSpec][] = [
    ['spec flag', plain(ran), { ...SPEC, approvalViaEffectGate: true } as GatewayToolSpec],
    ['lookalike property', Object.assign(plain(ran), { approvalViaEffectGate: true, effectLedgerBound: true }), SPEC],
    ['wrapper around a bound executor', (request) => inner(request), SPEC],
  ];
  for (const [name, executor, spec] of forgeries) {
    assert.equal(isEffectLedgerBound(executor), false, name);
    assert.deepEqual(await gateway(NEEDS_APPROVAL, executor, { spec }).call('mailer', {}), { ok: false, error: 'approval_required' }, name);
  }
  assert.equal(ran.n, 0);
  assert.deepEqual(state.calls, []);
  assert.equal(isEffectLedgerBound(inner), true);
});

test('a ledger-bound executor that never passes the ledger is an error, not a success', async () => {
  const state: Ledger = { calls: [], refuse: false };
  const skipping = bound(state, { n: 0 }, () => Promise.resolve({ result: { sent: 'directly, around the ledger' } }));
  assert.deepEqual(await gateway(NEEDS_APPROVAL, skipping).call('mailer', {}), { ok: false, error: 'tool_error' });
  // 부작용이 없는 길은 이유를 밝혀야 한다
  const acknowledged = bound(state, { n: 0 }, (_request, perform) => { perform.noEffect('cancelled before dialing'); return Promise.resolve({ result: { done: true } }); });
  assert.deepEqual(await gateway(NEEDS_APPROVAL, acknowledged).call('mailer', {}), { ok: true, result: { done: true } });
  const silent = bound(state, { n: 0 }, (_request, perform) => { perform.noEffect(' '); return Promise.resolve({ result: {} }); });
  assert.deepEqual(await gateway(NEEDS_APPROVAL, silent).call('mailer', {}), { ok: false, error: 'tool_error' });
});

test('a ledger-bound executor is accepted only for side-effect tools with impact external_effect', () => {
  const state: Ledger = { calls: [], refuse: false };
  const executor = bound(state, { n: 0 });
  assert.throws(() => gateway(NEEDS_APPROVAL, executor, { spec: { tool: 'mailer', operation: 'send', scope: 'internal', sideEffect: false } }), /ledger-bound executor needs sideEffect=true/);
  assert.throws(() => gateway(NEEDS_APPROVAL, executor, { spec: { tool: 'mailer', operation: 'send', scope: 'internal', impact: 'write', sideEffect: true } }), /ledger-bound executor needs sideEffect=true and impact external_effect/);
  assert.doesNotThrow(() => gateway(NEEDS_APPROVAL, executor));
});
