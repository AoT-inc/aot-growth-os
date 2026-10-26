// A6-U11 통합: 데몬 조립(실제 정책 게이트 + 업무 엔진 + 평가기 + 에이전트 실행 관리)에서
//  1. 업무 간 결과 전달: 선행 업무가 통과 평가를 받고 completed 가 된 뒤에야 후속 업무의 어댑터 입력 `upstream` 으로 간다. 항목은 external_untrusted 로 표시된다.
//     선행 결과에 심은 지시문은 후속 어댑터의 도구 호출·정책 판정을 바꾸지 못한다(같은 업무를 upstream 없이 돌린 대조와 같다). 단 외부 입력이 들어 있는 run 이므로
//     모든 호출이 `influenced_by_external_input` 으로 표시된다.
//     선행이 completed 가 아니거나 통과 평가가 없거나 fail 이면 후속 어댑터는 시작되지 않고 needs_review 다.
//  2. 업무별 어댑터 선택: 역할에 따라 업무마다 다른 어댑터가 실행되고 task_run.adapter 가 각각 맞다. 단일 어댑터 구성은 그대로다.
// 외부 접근은 없다(가짜 어댑터, 가짜 출처 조회기).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createFakeAgentAdapter, type AdapterInput, type AgentAdapter, type FakeAdapterConfig, type GatewayToolSpec, type JsonObject, type ToolCallRecord, type ToolExecutor,
} from '@aot/agent-runtime';
import { SEED_IDS, type Db } from '@aot/domain';
import { transitionTask } from '@aot/task-engine';

import { adapterByRole } from '../../apps/daemon/src/agent-executor.ts';
import { assembleDaemon, type AssembleOptions } from '../../apps/daemon/src/assemble.ts';
import { manualTimers, runsOf, taskStatus } from '../support/engine.ts';
import { evaluationsOf, EXAMPLE_URL, FakeFetcher, researchReport, validationSpec } from '../support/evaluation.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { AGENT, createWithGate, decisionsOf, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';
import { UPSTREAM_FORBIDDEN_TOOL, UPSTREAM_INJECTION } from '../support/adapter-contract.ts';

const SEARCH: GatewayToolSpec = { tool: 'web_search', operation: 'search', scope: 'internal', sideEffect: false };
/** JSON 문자열 안에서의 모양(따옴표가 이스케이프된다) */
const ESCAPED_INJECTION = JSON.stringify(UPSTREAM_INJECTION).slice(1, -1);
const PAGE = 'The quarterly price is fixed for all plans.';

/** 입력을 복사해 두고 안쪽 어댑터에 넘기는 어댑터 (시작 횟수도 센다) */
function recording(inner: AgentAdapter, inputs: AdapterInput[]): AgentAdapter {
  return { name: inner.name, run: (input, context) => { inputs.push(structuredClone(input)); return inner.run(input, context); } };
}

function addPlannerRole(env: PolicyEnv): void {
  env.db.writeTx((tx) => tx.run(
    'INSERT OR IGNORE INTO role (id, org_unit_id, slug, description, allowed_tools, lifecycle, version, trial_scope, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)',
    ['role-planner', SEED_IDS.unit, 'planner', 'planning role (test)', '[]', 'active', env.clock.nowIso()],
  ));
}

interface Rig {
  env: PolicyEnv;
  daemon: ReturnType<typeof assembleDaemon>;
  researchInputs: AdapterInput[];
  plannerInputs: AdapterInput[];
  records: ToolCallRecord[];
}

/** generalist(기본) = research-fake, planner = planner-fake. 두 어댑터 모두 같은 도구 호출 하나를 한다 */
function rig(env: PolicyEnv, options: { researchResult?: FakeAdapterConfig['result']; agent?: Partial<NonNullable<AssembleOptions['agent']>> } = {}): Rig {
  addPlannerRole(env);
  const researchInputs: AdapterInput[] = [];
  const plannerInputs: AdapterInput[] = [];
  const records: ToolCallRecord[] = [];
  const common = { clock: env.clock, scenario: 'tool_calls' as const, toolCalls: [{ tool: 'web_search', args: { q: 'example' } }] };
  const research = recording(createFakeAgentAdapter({
    ...common, name: 'research-fake',
    evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }],
    result: options.researchResult ?? (researchReport([{ id: 'c1', statement: UPSTREAM_INJECTION, source_url: EXAMPLE_URL, quote: 'quarterly price is fixed' }]) as JsonObject),
  }), researchInputs);
  const planner = recording(createFakeAgentAdapter({ ...common, name: 'planner-fake', result: { plan: 'draft plan' } }), plannerInputs);
  const executors = new Map<string, ToolExecutor>([[SEARCH.tool, () => Promise.resolve({ result: { hits: 2 } })]]);
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: PAGE }) },
    agent: {
      adapter: research, adapters: new Map([['planner-fake', planner]]), selectAdapter: adapterByRole({ planner: 'planner-fake' }),
      tools: [SEARCH], executors, timers: new ManualGatewayTimers(), recorder: { record: (record) => void records.push(record) },
      ...options.agent,
    },
  });
  return { env, daemon, researchInputs, plannerInputs, records };
}

const researchDraft = (n: number) => readOnlyDraft({
  ...validationSpec(['url_reachable', 'dedupe', 'budget']), inputs: [{ name: 'k', ref: `r:${n}`, kind: 'k' }],
});
const plannerDraft = (n: number, extra: Record<string, unknown> = {}) => readOnlyDraft({
  role: 'planner', ...validationSpec(['budget']), inputs: [{ name: 'k', ref: `r:${n}`, kind: 'k' }], ...extra,
});
const followerDraft = (upstreamId: string, n = 100) => plannerDraft(n, {
  inputs: [{ name: 'findings', ref: `task:${upstreamId}`, kind: 'task_result' }], dependencies: [upstreamId],
});

const adapterOf = (db: Db, taskId: string) => runsOf(db, taskId).length === 0 ? null : db.get('SELECT adapter FROM task_run WHERE task_id = ?', [taskId])?.['adapter'];
const lastTransition = (db: Db, taskId: string) => db.get<{ to_status: string; reason: string }>('SELECT to_status, reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!;

/** 선행 업무를 끝까지 돌려 completed (통과 평가) 로 만든다 */
async function completeResearch(r: Rig, taskId: string): Promise<void> {
  await r.daemon.worker.tick(); // 실행
  const checked = await r.daemon.worker.tick(); // 검증
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['completed'], 'the predecessor must be completed for these tests');
  assert.equal(evaluationsOf(r.env.db, taskId)[0]?.outcome, 'pass');
}

test('the predecessor result reaches the follower as external_untrusted data; the injected instruction changes no tool call and no policy decision', async (t) => {
  const env = policyEnv(t);
  const r = rig(env);
  const researchId = createWithGate(env, researchDraft(1));
  await completeResearch(r, researchId);
  assert.equal(adapterOf(env.db, researchId), 'research-fake');
  const upstreamResult = JSON.parse(env.db.get<{ result: string }>('SELECT result FROM task_run WHERE task_id = ?', [researchId])!.result) as Record<string, unknown>;
  assert.ok(JSON.stringify(upstreamResult).includes(ESCAPED_INJECTION), 'the predecessor result really carries the injected instruction');

  // 같은 업무를 선행 결과 없이 돌린 대조와, 선행 결과를 받는 후속 업무
  const controlId = createWithGate(env, plannerDraft(2));
  const followerId = createWithGate(env, followerDraft(researchId));
  r.records.length = 0;
  const first = await r.daemon.worker.tick();
  const second = await r.daemon.worker.tick();
  assert.deepEqual([first.executed?.taskId, second.executed?.taskId].sort(), [controlId, followerId].sort());

  // 어댑터 입력: 항목마다 external_untrusted, 값은 선행 업무의 run 결과 그대로
  assert.equal(r.plannerInputs.length, 2);
  const followerInput = r.plannerInputs.find((input) => input.upstream !== undefined)!;
  const controlInput = r.plannerInputs.find((input) => input.upstream === undefined)!;
  assert.deepEqual(followerInput.upstream, [{ name: 'findings', task_ref: `task:${researchId}`, trust_origin: 'external_untrusted', result: upstreamResult }]);
  assert.ok(!('upstream' in controlInput));
  assert.equal(followerInput.task_spec.objective, controlInput.task_spec.objective, 'the objective is the spec, not the upstream text');
  assert.deepEqual(followerInput.allowed_tools, controlInput.allowed_tools, 'the tools offered come from the spec and policy, not from the upstream result');

  // 도구 호출: 같은 호출 하나씩, 금지 도구 없음. 외부 입력이 들어 있는 run 이라 호출이 영향 표시된다(대조는 아니다)
  const callsOf = (taskId: string) => {
    const runIds = runsOf(env.db, taskId).map((run) => run.id);
    return r.records.filter((rec) => runIds.includes(rec.run_id)).map((rec) => [rec.tool, rec.outcome, rec.influenced_by_external_input]);
  };
  assert.deepEqual(callsOf(controlId), [['web_search', 'ok', false]]);
  assert.deepEqual(callsOf(followerId), [['web_search', 'ok', true]]);
  assert.ok(r.records.every((rec) => rec.tool !== UPSTREAM_FORBIDDEN_TOOL));

  // 정책 판정: 후속 업무와 대조가 같은 판정을 받는다(선행 결과가 판정을 바꾸지 못한다)
  const shape = (taskId: string) => decisionsOf(env.db, taskId).filter((d) => d.task_run_id !== null).map((d) => [d.action, d.decision, d.scope, d.impact]);
  assert.deepEqual(shape(followerId), shape(controlId));
  assert.ok(shape(followerId).length > 0);
  assert.ok(decisionsOf(env.db, followerId).every((d) => !d.action.includes(UPSTREAM_FORBIDDEN_TOOL)));

  // 후속 업무가 낸 결과에는 선행 결과의 문장이 되풀이되지 않는다(가짜 어댑터는 받은 사실만 남긴다)
  const followerResult = env.db.get<{ result: string }>('SELECT result FROM task_run WHERE task_id = ?', [followerId])!.result;
  assert.ok(!followerResult.includes(ESCAPED_INJECTION));
});

test('different adapters run different tasks and task_run.adapter says which: research = research-fake (default), planning = planner-fake', async (t) => {
  const env = policyEnv(t);
  const r = rig(env);
  const researchId = createWithGate(env, researchDraft(1));
  const plannerId = createWithGate(env, plannerDraft(2));
  await r.daemon.worker.tick();
  await r.daemon.worker.tick();
  assert.equal(adapterOf(env.db, researchId), 'research-fake');
  assert.equal(adapterOf(env.db, plannerId), 'planner-fake');
  assert.equal(r.researchInputs.length, 1);
  assert.equal(r.plannerInputs.length, 1);
  assert.equal(r.researchInputs[0]?.task_spec.role, 'generalist');
  assert.equal(r.plannerInputs[0]?.task_spec.role, 'planner');
});

test('without a selector (the previous single-adapter set-up) every task runs on the one adapter', async (t) => {
  const env = policyEnv(t);
  addPlannerRole(env);
  const inputs: AdapterInput[] = [];
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: { adapter: recording(createFakeAgentAdapter({ clock: env.clock, name: 'only-fake' }), inputs), timers: new ManualGatewayTimers() },
  });
  const a = createWithGate(env, researchDraft(1));
  const b = createWithGate(env, plannerDraft(2));
  await daemon.worker.tick();
  await daemon.worker.tick();
  assert.deepEqual([adapterOf(env.db, a), adapterOf(env.db, b)], ['only-fake', 'only-fake']);
  assert.equal(inputs.length, 2);
});

test('a selector naming an adapter that is not registered: the task is not run on another adapter, it goes to needs_review', async (t) => {
  const env = policyEnv(t);
  const r = rig(env, { agent: { selectAdapter: adapterByRole({ planner: 'ghost-adapter' }) } });
  const plannerId = createWithGate(env, plannerDraft(2));
  const report = await r.daemon.worker.tick();
  assert.deepEqual(report.sentToReview, [plannerId]);
  assert.equal(report.executed, null);
  assert.equal(taskStatus(env.db, plannerId), 'needs_review');
  assert.equal(runsOf(env.db, plannerId).length, 0);
  assert.match(lastTransition(env.db, plannerId).reason, /^adapter_unresolved: adapter 'ghost-adapter' is not registered/);
  assert.equal(r.researchInputs.length + r.plannerInputs.length, 0, 'no adapter was started');
});

test('assembly refuses an adapter registered under a name that is not its own, or twice', (t) => {
  const env = policyEnv(t);
  const base = { clock: env.clock, name: 'x' };
  const build = (adapters: Map<string, AgentAdapter>) => () => rig(env, { agent: { adapters } });
  assert.throws(build(new Map([['other-name', createFakeAgentAdapter({ ...base, name: 'planner-fake' })]])), /must be the adapter's name/);
  assert.throws(build(new Map([['research-fake', createFakeAgentAdapter({ ...base, name: 'research-fake' })]])), /registered more than once/);
});

// ===== 선행 입력이 충족되지 않을 때 =====

/** 선행 업무를 평가 없이 사람이 끝낸 것처럼 completed 로 둔다 */
function completeWithoutEvaluation(env: PolicyEnv, taskId: string, resultJson: string): void {
  env.db.writeTx((tx) => {
    const actorId = AGENT;
    tx.run(
      `INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, outcome, result)
       VALUES (?, ?, 1, ?, 'research-fake', ?, ?, 'w0', ?, ?, 'submitted', ?)`,
      [`run-${taskId}`, taskId, actorId, env.clock.nowIso(), env.clock.nowIso(), env.clock.nowIso(), env.clock.nowIso(), resultJson],
    );
    transitionTask(tx, { taskId, from: 'queued', to: 'running', by: 'scheduler', reason: 'test', now: env.clock.nowIso() });
    transitionTask(tx, { taskId, from: 'running', to: 'validating', by: 'scheduler', reason: 'test', now: env.clock.nowIso() });
    transitionTask(tx, { taskId, from: 'validating', to: 'completed', by: 'validator', reason: 'test: a person finished it', now: env.clock.nowIso() });
  });
}

test('predecessor completed without a passing evaluation: the follower adapter is never started; needs_review with the reason code', async (t) => {
  const env = policyEnv(t);
  const r = rig(env);
  const researchId = createWithGate(env, researchDraft(1));
  completeWithoutEvaluation(env, researchId, JSON.stringify({ summary: UPSTREAM_INJECTION }));
  const followerId = createWithGate(env, followerDraft(researchId));

  const report = await r.daemon.worker.tick();
  assert.deepEqual(report.sentToReview, [followerId]);
  assert.equal(report.executed, null);
  assert.equal(taskStatus(env.db, followerId), 'needs_review');
  assert.equal(runsOf(env.db, followerId).length, 0);
  assert.match(lastTransition(env.db, followerId).reason, /^upstream_unmet: upstream_not_evaluated: input 'findings'/);
  assert.equal(r.plannerInputs.length, 0, 'the follower adapter was not started, with or without the upstream');
});

test('predecessor not completed: the follower waits (dependencies) and is neither run nor sent to review', async (t) => {
  const env = policyEnv(t);
  const r = rig(env);
  const researchId = createWithGate(env, researchDraft(1));
  const followerId = createWithGate(env, followerDraft(researchId));
  // 선행 업무를 아직 실행하지 않은 채로는 후속 업무가 집히지 않는다: 이번 tick 은 선행 업무 하나만 실행
  const first = await r.daemon.worker.tick();
  assert.equal(first.executed?.taskId, researchId);
  assert.equal(taskStatus(env.db, followerId), 'queued');
  const second = await r.daemon.worker.tick(); // 선행 검증 → completed. 같은 tick 에서 후속 업무가 집힌다
  assert.deepEqual(second.validated.map((v) => v.taskStatus), ['completed']);
  assert.equal(second.executed?.taskId, followerId);
  assert.equal(r.plannerInputs.length, 1);
  assert.equal(r.plannerInputs[0]?.upstream?.[0]?.task_ref, `task:${researchId}`);
});

test('predecessor evaluated fail and then completed by a person: the follower does not get the result (upstream_not_passed)', async (t) => {
  const env = policyEnv(t);
  // 보고된 인용문이 원문에 없다 → 평가 fail → retry_wait. 그 뒤 사람이 completed 로 끝낸 상황을 만든다
  const r = rig(env, { researchResult: researchReport([{ id: 'c1', statement: 'Prices are fixed.', source_url: EXAMPLE_URL, quote: 'a quotation that is not in the page' }]) as JsonObject });
  const researchId = createWithGate(env, readOnlyDraft({ ...validationSpec(['url_reachable', 'quote_in_source', 'dedupe', 'budget']), inputs: [{ name: 'k', ref: 'r:9', kind: 'k' }] }));
  await r.daemon.worker.tick();
  const checked = await r.daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['retry_wait']);
  assert.equal(evaluationsOf(env.db, researchId)[0]?.outcome, 'fail');
  env.db.writeTx((tx) => tx.run("UPDATE task SET status = 'completed' WHERE id = ?", [researchId])); // 상태 기계를 거치지 않는 시험 준비: 사람이 끝냈다고 친다

  const followerId = createWithGate(env, followerDraft(researchId));
  const report = await r.daemon.worker.tick();
  assert.deepEqual(report.sentToReview, [followerId]);
  assert.match(lastTransition(env.db, followerId).reason, /^upstream_unmet: upstream_not_passed: input 'findings'/);
  assert.equal(r.plannerInputs.length, 0);
});
