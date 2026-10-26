// A5 U4 통합: 데몬 조립(실제 정책 게이트 + 업무 엔진 + 평가 비용 원장 + 에이전트 실행 관리)으로 가짜 어댑터를 돌린다. DB 는 실제 SQLite 다.
//  - 예산 초과 취소: task_run killed, cost_entry 에 초과 시점까지의 비용, 업무 needs_review, 증거·run_log 저장
//  - time_limit 취소: task_run killed, 업무 retry_wait(시도 1회 소모), 비용 기록 없음
//  - 정상 종료: submitted -> validating, 진행 비용과 최종 비용이 이중 계상되지 않음, 도구 비용은 'tool' 범주, 정책 재판정은 policy_decision 에 run 별로 남음
//  - 호스트 강제(A5-U8): 어댑터가 근거를 internal 로 밝혀도 evidence.trust_origin 은 external_untrusted, 어휘 밖 값은 거부, 그 근거로는 신뢰된 기억을 만들 수 없다
//  - 설정이 없는 기본 구성과 컨테이너 미설정 데몬의 시작 준비(prepareAgentRuntime)는 아무것도 하지 않는다
// 시간은 FakeClock 과 손으로 돌리는 타이머뿐이다(시간 제한은 가상 시간을 보내 발화시킨다).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDockerCli, createFakeAgentAdapter, createFileRunLogStore, type AdapterOutput, type AgentAdapter, type FakeAdapterConfig, type GatewayToolSpec, type ToolCallRecord, type ToolExecutor } from '@aot/agent-runtime';
import { createMemoryItem, currentFacts, EVIDENCE_SOURCE_PREFIX, listMemoryItems, MemoryRuleError, SEED_IDS, type MemoryRuleCode } from '@aot/domain';
import { costForRun, costForTask } from '@aot/evaluation';
import type { TaskExecutor } from '@aot/task-engine';

import { assembleDaemon, type AssembleOptions } from '../../apps/daemon/src/assemble.ts';
import { manualTimers, runsOf, taskStatus } from '../support/engine.ts';
import { FakeDocker } from '../support/fake-docker.ts';
import { ManualGatewayTimers, tick } from '../support/gateway-contract.ts';
import { AGENT, createWithGate, decisionsOf, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await tick();
};

const SEARCH: GatewayToolSpec = { tool: 'web_search', operation: 'search', scope: 'internal', sideEffect: false, unitCost: { usd: 0.25 } };

interface Rig {
  env: PolicyEnv;
  gwTimers: ManualGatewayTimers;
  daemon: ReturnType<typeof assembleDaemon>;
  logDir: string;
  executed: string[];
}

function rig(env: PolicyEnv, adapterConfig: Omit<FakeAdapterConfig, 'clock'>, extra: Partial<AssembleOptions> = {}): Rig {
  const gwTimers = new ManualGatewayTimers();
  const logDir = join(env.dir, 'run-logs');
  const executed: string[] = [];
  const executors = new Map<string, ToolExecutor>([[SEARCH.tool, () => { executed.push('search'); return Promise.resolve({ result: { hits: 2 } }); }]]);
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: {
      adapter: createFakeAgentAdapter({ clock: env.clock, ...adapterConfig }), tools: [SEARCH], executors, timers: gwTimers,
      runLogStore: createFileRunLogStore({ dir: logDir }),
    },
    ...extra,
  });
  return { env, gwTimers, daemon, logDir, executed };
}

const draft = (n: number, extra: Record<string, unknown> = {}) => readOnlyDraft({ inputs: [{ name: 'k', ref: `r:${n}`, kind: 'k' }], ...extra });

const ledger = (env: PolicyEnv, taskId: string) =>
  env.db.all<{ category: string; amount_usd: number; task_run_id: string; units: string }>('SELECT category, amount_usd, task_run_id, units FROM cost_entry WHERE task_id = ? ORDER BY at, rowid', [taskId]);
const transitions = (env: PolicyEnv, taskId: string) =>
  env.db.all<{ to_status: string; reason: string }>('SELECT to_status, reason FROM task_transition WHERE task_id = ? ORDER BY id', [taskId]);

test('budget exceeded: the run is cancelled and ends killed; the cost up to the overrun stays in the ledger; the task waits for a person', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(1, { cost_budget: { max_usd: 1 } }));
  const r = rig(env, { scenario: 'over_budget' });

  const report = await r.daemon.worker.tick();
  assert.deepEqual(report.executed?.end, { outcome: 'killed', taskStatus: 'needs_review' });
  assert.equal(taskStatus(env.db, taskId), 'needs_review');
  const [run] = runsOf(env.db, taskId);
  assert.equal(run?.outcome, 'killed');
  assert.equal(env.db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts'], 0, 'a budget kill does not use up an attempt');

  // 0.5 USD(50%) 다음 1.5 USD(150%) 누적 보고 → 증분 0.5, 1.0. 초과한 보고도 원장에 남는다
  assert.deepEqual(ledger(env, taskId).map((e) => [e.category, e.amount_usd]), [['llm', 0.5], ['llm', 1]]);
  assert.equal(costForTask(env.db, taskId).totalUsd, 1.5);
  assert.equal(costForRun(env.db, run!.id).totalUsd, 1.5);

  const last = transitions(env, taskId).at(-1)!;
  assert.equal(last.to_status, 'needs_review');
  assert.match(last.reason, /budget_exceeded: spent 1\.5 USD exceeds the budget 1 USD/);

  // 취소한 에이전트의 증거와 run_log 가 남는다
  const evidence = env.db.all<{ kind: string; ref: string; task_run_id: string }>('SELECT kind, ref, task_run_id FROM evidence WHERE task_id = ?', [taskId]);
  assert.deepEqual(evidence.map((e) => [e.kind, e.ref, e.task_run_id]), [['run_log', `run-log:${run!.id}`, run!.id]]);
  const ref = env.db.get('SELECT run_log_ref FROM task_run WHERE id = ?', [run!.id])?.['run_log_ref'];
  assert.equal(ref, `run-log:${run!.id}`);
  const lines = readFileSync(join(r.logDir, `${run!.id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { message: string });
  assert.ok(lines.some((l) => /stopping the agent \(budget_exceeded\)/.test(l.message)));
  assert.ok(lines.some((l) => /cancel signal received/.test(l.message)));
  assert.equal(r.gwTimers.pending, 0);
});

test('time_limit: the run is cancelled at the limit and ends killed; the task is retried later (one attempt used up)', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(2, { constraints: { time_limit: '10m', network_allowlist: [] } }));
  const r = rig(env, { scenario: 'wait_for_cancel' });

  const ticking = r.daemon.worker.tick();
  await settle();
  assert.equal(taskStatus(env.db, taskId), 'running');
  r.gwTimers.advance(10 * 60_000 - 1);
  await settle();
  assert.equal(taskStatus(env.db, taskId), 'running', 'one millisecond before the limit it is still running');
  r.gwTimers.advance(1);
  const report = await ticking;

  assert.deepEqual(report.executed?.end, { outcome: 'killed', taskStatus: 'retry_wait' });
  assert.equal(taskStatus(env.db, taskId), 'retry_wait');
  assert.equal(env.db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts'], 1);
  const [run] = runsOf(env.db, taskId);
  assert.equal(run?.outcome, 'killed');
  assert.match(transitions(env, taskId).at(-1)!.reason, /killed: time_limit: time limit 10m exceeded/);
  assert.equal(ledger(env, taskId).length, 0, 'nothing was spent');
  assert.equal(r.gwTimers.pending, 0);

  // 재시도 시간이 지나면 다시 실행된다 (새 attempt, 새 run)
  env.clock.advance(10_000);
  const again = r.daemon.worker.tick();
  await settle();
  r.gwTimers.advance(10 * 60_000);
  assert.deepEqual((await again).executed?.end, { outcome: 'killed', taskStatus: 'retry_wait' });
  assert.deepEqual(runsOf(env.db, taskId).map((x) => [x.attempt, x.outcome]), [[1, 'killed'], [2, 'killed']]);
});

test('normal end: submitted -> validating; progress and final cost are not counted twice; tool cost is its own category; re-judgements are recorded per run', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(3, { cost_budget: { max_usd: 2 } }));
  const r = rig(env, { scenario: 'tool_calls', toolCalls: [{ tool: 'web_search', args: { q: 'example-product' } }, { tool: 'web_search', args: { q: 'second' } }], result: { claims: [] } });

  const report = await r.daemon.worker.tick();
  assert.deepEqual(report.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  const [run] = runsOf(env.db, taskId);
  assert.equal(env.db.get('SELECT result FROM task_run WHERE id = ?', [run!.id])?.['result'] !== null, true);
  assert.deepEqual(r.executed, ['search', 'search']);
  assert.deepEqual(ledger(env, taskId).map((e) => [e.category, e.amount_usd]), [['tool', 0.25], ['tool', 0.25]], 'gateway cost 0.25 per call; the adapter\'s own final cost is 0 and adds nothing');
  assert.equal(costForTask(env.db, taskId).byCategory.tool, 0.5);

  // 호출마다 정책 재판정이 run 별로 남는다
  const decisions = decisionsOf(env.db, taskId).filter((d) => d.task_run_id === run!.id);
  assert.equal(decisions.filter((d) => d.action === 'web_search.search').length >= 2, true);

  // 증거 행 (미검증)과 run_log 파일
  const evidence = env.db.all<{ verified: number }>('SELECT verified FROM evidence WHERE task_id = ?', [taskId]);
  assert.deepEqual(evidence.map((e) => Number(e.verified)), [0]);
  assert.ok(existsSync(join(r.logDir, `${run!.id}.jsonl`)));
});

test('normal end with cost_progress: 0.01 then 0.03 and a final 0.03 give two ledger lines (0.01, 0.02) and no double count', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(4));
  const r = rig(env, { scenario: 'cost_progress' });
  const report = await r.daemon.worker.tick();
  assert.deepEqual(report.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  const entries = ledger(env, taskId);
  assert.deepEqual(entries.map((e) => [e.category, e.amount_usd]), [['llm', 0.01], ['llm', 0.02]]);
  assert.equal(costForTask(env.db, taskId).totalUsd, 0.03);
  assert.ok(entries.every((e) => (JSON.parse(e.units) as { source: string }).source === 'adapter'));
});

test('the default composition is unchanged: no agent => the given executor runs; prepareAgentRuntime does nothing without a container adapter', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(5));
  const executor: TaskExecutor = { execute: () => Promise.resolve({ result: { summary: 'given executor' } }) };
  const plain = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', executor, timers: manualTimers(),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
  });
  assert.equal(await plain.prepareAgentRuntime(), null);
  assert.deepEqual((await plain.worker.tick()).executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(taskStatus(env.db, taskId), 'validating');
  assert.equal(env.db.get('SELECT adapter FROM task_run WHERE task_id = ?', [taskId])?.['adapter'], 'fake-adapter');

  const withAgent = rig(env, {});
  assert.equal(await withAgent.daemon.prepareAgentRuntime(), null, 'an in-process adapter needs no docker');
  assert.throws(() => assembleDaemon({ db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, paths: { policyStoreDir: 'p', totpDir: 't', approvalSocket: 's' } }), /executor or an agent/);
});

test('a tool request outside the offered list: the agent gets tool_not_allowed from the gateway and the run is not killed', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(6));
  const r = rig(env, { scenario: 'denied_tool' });
  const report = await r.daemon.worker.tick();
  assert.deepEqual(report.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  assert.deepEqual(r.executed, []);
  assert.equal(taskStatus(env.db, taskId), 'validating');
});

test('the recorder hook hands over the gateway\'s ToolCallRecords as structured objects (allowed, refused, per run); the run_log file format is unchanged', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(7));
  const records: ToolCallRecord[] = [];
  const logDir = join(env.dir, 'run-logs');
  const executors = new Map<string, ToolExecutor>([[SEARCH.tool, () => Promise.resolve({ result: { hits: 2 } })]]);
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: {
      adapter: createFakeAgentAdapter({ clock: env.clock, scenario: 'tool_calls', toolCalls: [{ tool: 'web_search', args: { q: 'one' } }, { tool: 'send_email', args: { to: 'someone@example.com' } }], result: { claims: [] } }),
      tools: [SEARCH], executors, timers: new ManualGatewayTimers(), runLogStore: createFileRunLogStore({ dir: logDir }),
      recorder: { record: (record) => void records.push(record) },
    },
  });
  const report = await daemon.worker.tick();
  assert.deepEqual(report.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  const [run] = runsOf(env.db, taskId);
  assert.deepEqual(records.map((r) => [r.run_id, r.seq, r.tool, r.operation, r.outcome, r.decision, r.cost]), [
    [run!.id, 1, 'web_search', 'search', 'ok', 'allow', { usd: 0.25 }],
    [run!.id, 2, 'send_email', null, 'tool_not_allowed', null, {}],
  ]);
  assert.ok(records.every((r) => Object.isFrozen(r)), 'records are frozen: the hook cannot change what the gateway keeps');
  // 파일 형식은 그대로다: 한 줄에 {at, message}. 구조화된 기록은 별도 훅으로만 온다
  const lines = readFileSync(join(logDir, `${run!.id}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(lines.length >= 2 && lines.every((line) => Object.keys(line).sort().join() === 'at,message'));
  assert.ok(lines.some((line) => /^tool_call #1 web_search\.search: ok/.test(String(line['message']))));
});

test('a recorder that throws does not change the answer the agent gets or the run', async (t) => {
  const env = policyEnv(t);
  createWithGate(env, draft(8));
  const executors = new Map<string, ToolExecutor>([[SEARCH.tool, () => Promise.resolve({ result: { hits: 2 } })]]);
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: {
      adapter: createFakeAgentAdapter({ clock: env.clock, scenario: 'tool_calls', toolCalls: [{ tool: 'web_search', args: { q: 'one' } }], result: { claims: [] } }),
      tools: [SEARCH], executors, timers: new ManualGatewayTimers(),
      recorder: { record: () => { throw new Error('the hook is broken'); } },
    },
  });
  assert.deepEqual((await daemon.worker.tick()).executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
});

test('the container adapter is wired with an instance id: assembly refuses a docker without one, and daemon start lists orphans by the run label AND this instance\'s label', async (t) => {
  const env = policyEnv(t);
  const fake = new FakeDocker();
  fake.script = (record) => ({ code: 0, stdout: record.args[0] === 'version' ? '29.0.0\n' : '' });
  const docker = createDockerCli({ path: '/opt/example/bin/docker', process: fake });
  const agent = { adapter: createFakeAgentAdapter({ clock: env.clock }), docker };
  const paths = { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') };
  const base = { db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, paths };
  for (const instanceId of [undefined, '', 'bad id', 'x=y']) {
    assert.throws(() => assembleDaemon({ ...base, agent: { ...agent, ...(instanceId === undefined ? {} : { instanceId }) } }), /instanceId/);
  }
  const daemon = assembleDaemon({ ...base, agent: { ...agent, instanceId: 'inst-1' } });
  await daemon.prepareAgentRuntime();
  assert.deepEqual(fake.execs.map((e) => [...e.args]), [
    ['version', '--format', '{{.Server.Version}}'],
    ['ps', '-aq', '--filter', 'label=aot.run', '--filter', 'label=aot.instance=inst-1'],
  ]);
});

// ----- 호스트 강제: 에이전트가 낸 근거의 신뢰 출처 (A5-U8) -----

/** 진짜 가짜 어댑터를 돌린 뒤 출력을 고쳐 돌려주는 어댑터. 악의적/오작동 어댑터를 흉내 낸다 */
const tampering = (inner: AgentAdapter, patch: (output: AdapterOutput) => AdapterOutput): AgentAdapter => ({
  name: 'tampering-adapter',
  run: async (input, context) => patch(await inner.run(input, context)),
});
const claimsInternal = (output: AdapterOutput): AdapterOutput => ({
  ...output,
  evidence: [
    { kind: 'source_url', ref: 'https://docs.example.com/page', trust_origin: 'internal', captured_at: output.evidence[0]!.captured_at, content_hash: 'a'.repeat(64) },
    { kind: 'run_log', ref: 'run-log:claimed-internal', trust_origin: 'internal', captured_at: output.evidence[0]!.captured_at },
    { kind: 'document', ref: 'doc:honest', trust_origin: 'external_untrusted', captured_at: output.evidence[0]!.captured_at },
  ],
});
const rigWith = (env: PolicyEnv, adapter: AgentAdapter): Rig => {
  const base = rig(env, {});
  return { ...base, daemon: assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: { adapter, tools: [SEARCH], executors: new Map(), timers: new ManualGatewayTimers(), runLogStore: createFileRunLogStore({ dir: base.logDir }) },
  }) };
};
const evidenceRows = (env: PolicyEnv, taskId: string) =>
  env.db.all<{ id: string; kind: string; ref: string; trust_origin: string; verified: number }>('SELECT id, kind, ref, trust_origin, verified FROM evidence WHERE task_id = ? ORDER BY ref', [taskId]);
const rejectsWith = (code: MemoryRuleCode) => (error: unknown) => error instanceof MemoryRuleError && error.code === code;

test('host enforcement: whatever origin the adapter claims, every evidence row it produces is stored as external_untrusted — and cannot be turned into trusted memory', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(9));
  const r = rigWith(env, tampering(createFakeAgentAdapter({ clock: env.clock }), claimsInternal));

  const report = await r.daemon.worker.tick();
  assert.deepEqual(report.executed?.end, { outcome: 'submitted', taskStatus: 'validating' }, 'the claim is vocabulary-valid, so the run is accepted; only the stored value is the host\'s');
  const rows = evidenceRows(env, taskId);
  assert.deepEqual(rows.map((e) => [e.kind, e.ref, e.trust_origin]), [
    ['document', 'doc:honest', 'external_untrusted'],
    ['source_url', 'https://docs.example.com/page', 'external_untrusted'],
    ['run_log', 'run-log:claimed-internal', 'external_untrusted'],
  ]);
  assert.ok(rows.every((e) => Number(e.verified) === 0));

  // 기억 규칙 9: 이 근거를 internal 로 편입하려 하면 거부되고, hypothesis/unverified 로만 들어가며 현재 사실에 나오지 않는다
  const claimed = rows.find((e) => e.kind === 'source_url')!;
  let n = 0;
  const add = (extra: Record<string, unknown>) => env.db.writeTx((tx) => createMemoryItem(tx, {
    kind: 'hypothesis', body: '에이전트가 internal 이라 적은 외부 페이지의 주장', source_ref: `${EVIDENCE_SOURCE_PREFIX}${claimed.id}`,
    observed_at: '2026-10-18T00:00:00Z', created_by: SEED_IDS.owner, ...extra,
  }, { clock: env.clock, newId: () => `mem-u8-${(n += 1)}` }));
  assert.throws(() => add({ trust_origin: 'internal' }), rejectsWith('untrusted_evidence_origin'));
  assert.throws(() => add({ kind: 'fact', verification_status: 'verified' }), rejectsWith('external_must_be_hypothesis'));
  assert.equal(listMemoryItems(env.db).length, 0, 'the refused attempts left nothing behind');
  const stored = add({});
  assert.deepEqual([stored.kind, stored.verification_status, stored.trust_origin], ['hypothesis', 'unverified', 'external_untrusted']);
  assert.deepEqual(currentFacts(env.db, { clock: env.clock }).map((m) => m.id), [], 'it is not a current fact');
});

test('host enforcement: a trust_origin outside the vocabulary is still refused by the contract (the run fails and no evidence is stored)', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(10));
  const bogus = (output: AdapterOutput): AdapterOutput => ({ ...output, evidence: output.evidence.map((item) => ({ ...item, trust_origin: 'trusted' as unknown as 'internal' })) });
  const r = rigWith(env, tampering(createFakeAgentAdapter({ clock: env.clock }), bogus));
  const report = await r.daemon.worker.tick();
  assert.notEqual(taskStatus(env.db, taskId), 'validating', 'a contract violation is not a submitted result');
  assert.equal(report.executed?.end === 'lease_lost' ? null : report.executed?.end.outcome, 'error', 'the adapter output was invalid, so the run ended in error');
  assert.deepEqual(evidenceRows(env, taskId), []);
});
