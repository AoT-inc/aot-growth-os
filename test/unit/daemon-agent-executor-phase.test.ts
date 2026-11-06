// 에이전트 실행기는 전송 단계(dispatch)에서 불리면 안 된다 (ADR-0015 I2): 첫 줄에서 던지고 어댑터·도구에 닿지 않는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Clock, Db } from '@aot/domain';
import type { RunContext } from '@aot/task-engine';

import { createAgentExecutor, type AgentExecutorDeps } from '../../apps/daemon/src/agent-executor.ts';

test('the agent executor refuses a dispatch-phase run before touching the adapter', async () => {
  const touched: string[] = [];
  const deps = {
    db: {} as Db, clock: {} as Clock,
    agent: new Proxy({}, { get: (_target, key) => { touched.push(String(key)); return undefined; } }),
    toolCallPolicy: { judge: () => { touched.push('judge'); return { decision: 'allow' }; } },
  } as unknown as AgentExecutorDeps;
  const executor = createAgentExecutor(deps);
  await assert.rejects(() => executor.execute({ phase: 'dispatch' } as unknown as RunContext), /must not run in a dispatch phase/);
  assert.deepEqual(touched, []);
});
