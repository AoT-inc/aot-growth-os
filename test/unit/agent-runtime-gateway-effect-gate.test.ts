// `approvalViaEffectGate` (gateway.ts): 부작용을 원장으로만 보내는 도구는 호출별 정책 판정이 require_approval 이어도 실행기로 넘어간다
// (사람의 업무 승인은 원장이 전송 직전에 확인한다). deny 와 외부 입력 영향 하한은 그대로이고, 선언하지 않은 도구는 계속 막힌다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock, type ToolCallPolicyVerdict } from '@aot/domain';
import { createToolGateway, type GatewayToolSpec, type ToolExecutor } from '@aot/agent-runtime';

import { ManualGatewayTimers } from '../support/gateway-contract.ts';

const SPEC: GatewayToolSpec = { tool: 'mailer', operation: 'send', scope: 'customer', impact: 'external_effect', sideEffect: true };

function gateway(verdict: ToolCallPolicyVerdict, spec: GatewayToolSpec, options: { externalInput?: boolean } = {}) {
  let executed = 0;
  const executor: ToolExecutor = () => { executed += 1; return Promise.resolve({ result: { sent: true } }); };
  const g = createToolGateway({
    runId: 'run-1', taskId: null, subject: 'generalist@v1', tools: [spec], executors: new Map([[spec.tool, executor]]),
    policy: { judge: () => verdict }, clock: new FakeClock(), constraints: { max_usd: 1 }, toolTimeoutMs: 1000, timers: new ManualGatewayTimers(),
    ...(options.externalInput === undefined ? {} : { externalInput: options.externalInput }),
  });
  return { g, executed: () => executed };
}

const NEEDS_APPROVAL: ToolCallPolicyVerdict = { decision: 'require_approval', reason: 'external effect' };

test('a side-effect tool without the declaration stays blocked on require_approval (the gateway has no approval path)', async () => {
  const { g, executed } = gateway(NEEDS_APPROVAL, SPEC);
  assert.deepEqual(await g.call('mailer', {}), { ok: false, error: 'approval_required' });
  assert.equal(executed(), 0);
});

test('with approvalViaEffectGate the call reaches the executor, which is where the ledger re-checks the person\'s approval', async () => {
  const { g, executed } = gateway(NEEDS_APPROVAL, { ...SPEC, approvalViaEffectGate: true });
  assert.deepEqual(await g.call('mailer', {}), { ok: true, result: { sent: true } });
  assert.equal(executed(), 1);
  assert.equal(g.records()[0]?.decision, 'require_approval', 'the recorded decision is still what the policy said');
});

test('deny is never deferred', async () => {
  const { g, executed } = gateway({ decision: 'deny', reason: 'no' }, { ...SPEC, approvalViaEffectGate: true });
  assert.deepEqual(await g.call('mailer', {}), { ok: false, error: 'policy_denied' });
  assert.equal(executed(), 0);
});

test('a run influenced by external input cannot defer: the side-effect floor still blocks it, even when the policy says allow', async () => {
  for (const verdict of [NEEDS_APPROVAL, { decision: 'allow' } as const]) {
    const { g, executed } = gateway(verdict, { ...SPEC, approvalViaEffectGate: true }, { externalInput: true });
    assert.deepEqual(await g.call('mailer', {}), { ok: false, error: 'approval_required' }, verdict.decision);
    assert.equal(executed(), 0);
  }
});
