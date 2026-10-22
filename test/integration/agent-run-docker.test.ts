// A5 U4 Docker 통합: 데몬 조립 + 컨테이너 러너(실제 docker, 가짜 에이전트 이미지)로 실행 관리를 끝까지 돈다.
//  (a) 멈춘 컨테이너가 constraints.time_limit 으로 killed 가 되고(task_run killed, 업무 retry_wait) 컨테이너가 하나도 남지 않는다
//  (b) 컨테이너 에이전트의 cost_progress 가 예산을 넘으면 killed(budget_exceeded)·needs_review, 초과 시점까지의 비용이 cost_entry 에 남고 컨테이너가 남지 않는다
//  (c) 시작 준비(prepareAgentRuntime)가 docker 를 확인하고 라벨 `aot.run` 으로 남은 컨테이너(이전 데몬의 고아)를 지운다
// docker 가 없거나 이미지를 빌드할 수 없으면(오프라인) 전체를 skip 하고 이유를 출력한다. 시험이 만든 컨테이너는 라벨로 반드시 정리한다.
// 시간 제한은 실제 타이머(3초)다 — 가상 시간 시험은 test/integration/agent-run-management.test.ts.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { cleanupOrphanContainers, containerAgentAdapter, createContainerRunner, createFileRunLogStore } from '@aot/agent-runtime';
import { systemClock } from '@aot/domain';
import { costForTask } from '@aot/evaluation';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { dockerOut, labeledContainers, prepareSandbox, waitUntilNoContainers, type SandboxEnvironment } from '../support/container-sandbox.ts';
import { manualTimers, runsOf, taskStatus } from '../support/engine.ts';
import { AGENT, createWithGate, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';

const prepared = await prepareSandbox();
if (!prepared.ok) console.log(`[agent-run-docker] SKIPPED: ${prepared.reason}`);
const skip = prepared.ok ? false : `agent run docker tests skipped: ${prepared.reason}`;
const sandbox = (prepared.ok ? prepared.env : null) as SandboxEnvironment;

const LIMITS = { memoryMiB: 128, cpus: 0.5, pidsLimit: 32, tmpfsMiB: 16 };

function daemonWith(env: PolicyEnv, agentArgs: string[]) {
  const runner = createContainerRunner({ docker: sandbox.docker, image: sandbox.imageId, limits: LIMITS, namePrefix: 'aot-test', clock: systemClock, agentArgs });
  return assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: { adapter: containerAgentAdapter(runner), docker: sandbox.docker, runLogStore: createFileRunLogStore({ dir: join(env.dir, 'run-logs') }) },
  });
}

const draft = (n: number, extra: Record<string, unknown> = {}) => readOnlyDraft({ inputs: [{ name: 'k', ref: `r:${n}`, kind: 'k' }], ...extra });

describe('agent run management with the container sandbox (real docker)', { skip }, () => {
  afterEach(async () => {
    await cleanupOrphanContainers({ docker: sandbox.docker, label: 'aot.run' });
  });
  after(async () => {
    assert.deepEqual(await labeledContainers(sandbox.docker, 'aot.run'), [], 'no aot.run container is left behind by this file');
  });

  it('(a) a hung container is killed at constraints.time_limit: run killed, task retry_wait, no container remains', async (t) => {
    const env = policyEnv(t);
    const daemon = daemonWith(env, ['hang']);
    const readiness = await daemon.prepareAgentRuntime();
    assert.ok(readiness, 'a container adapter is configured, so docker is checked at start');
    assert.equal(readiness.dockerVersion, sandbox.dockerVersion);
    const taskId = createWithGate(env, draft(1, { constraints: { time_limit: '3s', network_allowlist: [] } }));

    const started = Date.now();
    const report = await daemon.worker.tick();
    const elapsed = Date.now() - started;
    assert.deepEqual(report.executed?.end, { outcome: 'killed', taskStatus: 'retry_wait' });
    assert.ok(elapsed >= 3000, `not killed before the limit (${elapsed} ms)`);
    assert.ok(elapsed < 3000 + 12_000, `killed promptly after the limit (${elapsed} ms)`);
    assert.equal(taskStatus(env.db, taskId), 'retry_wait');
    const [run] = runsOf(env.db, taskId);
    assert.equal(run?.outcome, 'killed');
    assert.equal(run?.lease_owner, 'w1');
    const reason = env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!.reason;
    assert.match(reason, /killed: time_limit: time limit 3s exceeded/);
    assert.deepEqual(await waitUntilNoContainers(sandbox.docker, 'aot.run'), [], 'docker ps -a shows no aot.run container');
    assert.equal(await dockerOut(sandbox.docker, ['ps', '-aq', '--filter', 'label=aot.run']), '');
  });

  it('(b) cost_progress from the container over the budget: killed(budget_exceeded), needs_review, the cost up to that point is kept', async (t) => {
    const env = policyEnv(t);
    const daemon = daemonWith(env, ['roundtrip']);
    const taskId = createWithGate(env, draft(2, { cost_budget: { max_usd: 0.004 } }));
    const report = await daemon.worker.tick();
    assert.deepEqual(report.executed?.end, { outcome: 'killed', taskStatus: 'needs_review' });
    assert.equal(taskStatus(env.db, taskId), 'needs_review');
    assert.equal(runsOf(env.db, taskId)[0]?.outcome, 'killed');
    assert.ok(costForTask(env.db, taskId).totalUsd >= 0.005, 'the 0.005 USD reported before the kill is in the ledger');
    assert.match(env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!.reason, /budget_exceeded/);
    assert.deepEqual(await waitUntilNoContainers(sandbox.docker, 'aot.run'), []);
  });

  it('(c) starting up removes containers left behind by an earlier daemon (label aot.run)', async (t) => {
    const env = policyEnv(t);
    const orphan = (await dockerOut(sandbox.docker, [
      'run', '-d', '--rm', '--network', 'none', '--label', 'aot.run=orphan-test', '--entrypoint', '/nodejs/bin/node', sandbox.imageId, '-e', 'setInterval(() => {}, 1 << 30)',
    ])).trim();
    assert.ok(orphan !== '');
    assert.deepEqual((await labeledContainers(sandbox.docker, 'aot.run')).length, 1);
    const readiness = await daemonWith(env, ['hang']).prepareAgentRuntime();
    assert.equal(readiness?.orphans.found.length, 1);
    assert.deepEqual(readiness?.orphans.failures, []);
    assert.deepEqual(await waitUntilNoContainers(sandbox.docker, 'aot.run'), []);
  });
});
