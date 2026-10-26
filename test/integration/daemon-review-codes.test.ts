// claude-code-cli 의 검토 대상 오류 코드(로그인 만료·사용량 한도 등)는 데몬 조립에서 재시도(retry_wait)가 아니라 needs_review 로 간다.
//  - 시도를 소모하지 않는다(재시도해도 같은 조건). run 은 killed. 사람이 조건을 풀고 다시 큐에 넣는다.
//  - 그 밖의 어댑터 오류(cli_failed, usage_deferred 등)는 이전과 같이 retry_wait 로 간다(시도 소모).
// 외부 접근은 없다(어댑터 출력을 직접 내는 시험용 어댑터).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { CLAUDE_CODE_REVIEW_CODES, type AdapterOutput, type AgentAdapter } from '@aot/agent-runtime';
import type { Db } from '@aot/domain';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { manualTimers, runsOf, taskStatus } from '../support/engine.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { AGENT, createWithGate, policyEnv, readOnlyDraft } from '../support/policy.ts';

function failingAdapter(code: string): AgentAdapter {
  return {
    name: 'failing-fake',
    run: (): Promise<AdapterOutput> => Promise.resolve({
      status: 'error', result: null, evidence: [], run_log: [], cost: { tokens: 0 }, error: { code, message: `${code} (test)` },
    }),
  };
}

const attemptsOf = (db: Db, taskId: string): number => Number(db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts']);
const lastTransition = (db: Db, taskId: string) => db.get<{ to_status: string; reason: string }>('SELECT to_status, reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!;

async function runOnce(t: Parameters<typeof policyEnv>[0], code: string) {
  const env = policyEnv(t);
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: { adapter: failingAdapter(code), timers: new ManualGatewayTimers() },
  });
  const taskId = createWithGate(env, readOnlyDraft({}));
  await daemon.worker.tick();
  return { env, taskId };
}

for (const code of CLAUDE_CODE_REVIEW_CODES) {
  test(`${code}: run killed, task needs_review, no attempt used`, async (t) => {
    const { env, taskId } = await runOnce(t, code);
    assert.equal(taskStatus(env.db, taskId), 'needs_review');
    assert.equal(attemptsOf(env.db, taskId), 0);
    assert.deepEqual(runsOf(env.db, taskId).map((run) => run.outcome), ['killed']);
    const last = lastTransition(env.db, taskId);
    assert.equal(last.to_status, 'needs_review');
    assert.match(last.reason, new RegExp(`killed: review_required: ${code}:`));
  });
}

test('a non-review adapter error (cli_failed) still goes to retry_wait and uses an attempt', async (t) => {
  const { env, taskId } = await runOnce(t, 'cli_failed');
  assert.equal(taskStatus(env.db, taskId), 'retry_wait');
  assert.equal(attemptsOf(env.db, taskId), 1);
  assert.deepEqual(runsOf(env.db, taskId).map((run) => run.outcome), ['error']);
});
