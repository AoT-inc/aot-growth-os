// A6-U14 통합: 주간 사이클 1~5단계를 데몬 조립(실제 정책 게이트 + 업무 엔진 + 평가기 + 에이전트 실행 관리 + 측정 채널 + 사이클)에서 가짜 어댑터로 돌린다.
//   조사 업무 → 통과 평가 → 기획 업무(조사 결과 task_result + 기준선 측정 measurement)가 실험 후보를 낸다 → 검사 experiment_candidates 통과 → completed
//   → cycle.advance(): 비교 기록(event) + 추천 후보의 strategy_version 1건 `proposed`. 다시 돌려도 늘지 않는다.
//   후보가 모두 정책 deny 이면 제안이 없고 비교 기록이 사람 검토 목록에 오른다. 사이클 옵션이 없으면 Daemon.cycle 은 null(이전 동작).
// 외부 접근은 없다(가짜 어댑터, 가짜 출처 조회기).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeAgentAdapter, type JsonObject } from '@aot/agent-runtime';
import { strategyProposalId, type Db } from '@aot/domain';

import { assembleDaemon, type AssembleOptions } from '../../apps/daemon/src/assemble.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { evaluationsOf, EXAMPLE_URL, FakeFetcher, researchReport, validationSpec } from '../support/evaluation.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { AFTER_W43, PACK_SIGNAL, W43_KEY } from '../support/measurement.ts';
import { AGENT, createWithGate, OWNER, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';

const PAGE = 'The quarterly price is fixed for all plans.';
const SHA = 'e'.repeat(64);

/** 기획 에이전트가 낼 마케팅 업무 명세 (내부 읽기만 → 기본 정책 allow) */
function marketingSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const draft: Record<string, unknown> = { ...readOnlyDraft({ objective: 'example-product 랜딩 페이지 문구를 한 주 동안 바꿔 본다' }), ...overrides };
  delete draft['trigger'];
  return draft;
}
/** 기본 정책에 규칙이 없는 영향(delete) → 기본 거부 */
const deniedSpec = () => marketingSpec({ allowed_tools: [{ tool: 'cms', operations: ['remove'], scope: 'internal', impact: 'delete' }] });

const candidate = (id: string, spec: Record<string, unknown>, expected = 20) => ({
  id, hypothesis: `hypothesis ${id}`, expected_effect: expected, est_cost_usd: 1, task_spec: spec, measurement: { signal_id: PACK_SIGNAL.id, period: 'iso_week' },
});

function rig(env: PolicyEnv, candidates: unknown[], extra: Partial<AssembleOptions> = { cycle: { budgetUsd: 5 } }) {
  env.clock.set(AFTER_W43);
  const research = createFakeAgentAdapter({
    clock: env.clock, name: 'research-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }],
    result: { ...researchReport([{ id: 'c1', statement: 'Prices are fixed.', source_url: EXAMPLE_URL, quote: 'quarterly price is fixed' }]), uncertainties: [] } as JsonObject,
  });
  const planner = createFakeAgentAdapter({ clock: env.clock, name: 'planner-fake', result: { candidates, uncertainties: [] } as unknown as JsonObject });
  return assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: PAGE }) },
    measurementSignals: [PACK_SIGNAL],
    agent: {
      adapter: research, adapters: new Map([['planner-fake', planner]]), timers: new ManualGatewayTimers(),
      selectAdapter: (spec) => (spec.validation.deterministic.includes('experiment_candidates') ? 'planner-fake' : null),
    },
    ...extra,
  });
}

/** 조사 → 기준선 입력 → 기획을 끝까지 돌린다. 기획 업무 id */
async function runCycle(env: PolicyEnv, daemon: ReturnType<typeof rig>): Promise<string> {
  const researchId = createWithGate(env, readOnlyDraft({ ...validationSpec(['url_reachable', 'dedupe', 'budget', 'uncertainty_listed']), inputs: [{ name: 'k', ref: 'r:1', kind: 'k' }] }));
  const planId = createWithGate(env, readOnlyDraft({
    objective: 'example-product 의 다음 1주 마케팅 실험 후보를 제안한다',
    allowed_tools: [],
    inputs: [{ name: 'findings', ref: `task:${researchId}`, kind: 'task_result' }, { name: 'baseline', ref: W43_KEY, kind: 'measurement' }],
    dependencies: [researchId],
    ...validationSpec(['schema_valid', 'experiment_candidates', 'uncertainty_listed', 'budget']),
  }));
  const measured = daemon.handleChannelRequest({
    cmd: 'measure', actor: OWNER, signal: PACK_SIGNAL.id, value: 10, observations: 3, quality: 'good', attachments: [{ ref: 'file:/example/week-43.png', sha256: SHA }],
  }) as { ok: boolean };
  assert.equal(measured.ok, true, JSON.stringify(measured));
  assert.equal((await daemon.worker.tick()).executed?.taskId, researchId);
  const second = await daemon.worker.tick();
  assert.deepEqual(second.validated.map((v) => [v.taskId, v.taskStatus]), [[researchId, 'completed']]);
  assert.equal(second.executed?.taskId, planId);
  const third = await daemon.worker.tick();
  assert.deepEqual(third.validated.map((v) => [v.taskId, v.taskStatus]), [[planId, 'completed']]);
  return planId;
}

const strategyRows = (db: Db) => db.all<{ id: string; status: string; created_by: string; body: string; rationale_refs: string; experiment_scope: string }>('SELECT * FROM strategy_version ORDER BY id');
const comparisons = (db: Db) => db.all<{ external_id: string; payload: string }>("SELECT external_id, payload FROM event WHERE type = 'experiment.compared'");

test('research -> planning completes -> one strategy_version proposed for the recommended candidate; running the cycle again adds nothing', async (t) => {
  const env = policyEnv(t);
  const daemon = rig(env, [candidate('copy-test', marketingSpec()), candidate('remove-page', deniedSpec(), 40)]);
  const planId = await runCycle(env, daemon);
  const evaluation = evaluationsOf(env.db, planId)[0]!;
  assert.equal(evaluation.outcome, 'pass');
  assert.equal(strategyRows(env.db).length, 0, 'nothing is proposed before the cycle runs');

  const report = await daemon.cycle!.advance();
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.compared.map((c) => [c.planningTaskId, c.outcome, c.recorded, c.proposalCreated]), [[planId, 'recommended', true, true]]);
  const rows = strategyRows(env.db);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row!.id, strategyProposalId(planId, 'copy-test'));
  assert.deepEqual([row!.status, row!.created_by, row!.body], ['proposed', AGENT, 'hypothesis copy-test']);
  const refs = JSON.parse(row!.rationale_refs) as string[];
  assert.ok(refs.includes(`task:${planId}`) && refs.includes(`evaluation:${evaluation.id}`) && refs.some((ref) => ref.startsWith('event:')));
  const scope = JSON.parse(row!.experiment_scope) as Record<string, Record<string, unknown>> & { comparison: { rank: number; agent_claim: { expected_effect: number } } };
  assert.deepEqual(scope['duration'], { period: 'iso_week', weeks: 1 });
  assert.deepEqual(scope['measurement'], { signal_id: PACK_SIGNAL.id, period: 'iso_week', observations_per_experiment: 1, baseline_week: '2026-W43', baseline_value: 10, pass_at_least: 11 });
  assert.deepEqual(scope['task'], { kind: 'task_spec', spec: marketingSpec() });
  assert.equal(scope['comparison']['rank'], 1);
  assert.equal(scope['comparison']['agent_claim']['expected_effect'], 20);
  assert.equal(scope['trust_origin'], 'external_untrusted');

  // 비교 기록: 거부된 후보는 사유와 함께 제외, 추천은 하나
  const [comparison] = comparisons(env.db);
  const record = JSON.parse(comparison!.payload) as { recommended: string; candidates: { id: string; status: string; exclusions: { code: string }[] }[] };
  assert.equal(record.recommended, 'copy-test');
  assert.deepEqual(record.candidates.map((c) => [c.id, c.status, c.exclusions.map((e) => e.code)]), [['copy-test', 'ranked', []], ['remove-page', 'excluded', ['risk_denied']]]);
  // 비교용 사전 판정은 policy_decision 에 남지 않는다
  assert.equal(env.db.get<{ n: number }>("SELECT count(*) AS n FROM policy_decision WHERE action = 'cms.remove'")!.n, 0);

  for (let i = 0; i < 3; i += 1) {
    const again = await daemon.cycle!.advance();
    assert.deepEqual(again, { compared: [], failed: [] });
  }
  assert.equal(strategyRows(env.db).length, 1);
  assert.equal(comparisons(env.db).length, 1);
  assert.deepEqual(daemon.cycle!.pendingReviews(), []);
  assert.equal(taskStatus(env.db, planId), 'completed');
});

test('every candidate denied by the policy: no proposal, the comparison waits for a person to review', async (t) => {
  const env = policyEnv(t);
  const daemon = rig(env, [candidate('remove-a', deniedSpec()), candidate('remove-b', deniedSpec())]);
  const planId = await runCycle(env, daemon);
  const report = await daemon.cycle!.advance();
  assert.deepEqual(report.compared.map((c) => [c.outcome, c.strategyVersionId, c.proposalCreated]), [['no_candidate', null, false]]);
  assert.equal(strategyRows(env.db).length, 0);
  assert.deepEqual(daemon.cycle!.pendingReviews().map((r) => [r.planningTaskId, r.outcome]), [[planId, 'no_candidate']]);
  assert.deepEqual(await daemon.cycle!.advance(), { compared: [], failed: [] });
  assert.equal(daemon.cycle!.pendingReviews().length, 1);
});

test('without the cycle option the daemon has no cycle (previous behaviour) and the planning task still completes', async (t) => {
  const env = policyEnv(t);
  const daemon = rig(env, [candidate('copy-test', marketingSpec())], {});
  assert.equal(daemon.cycle, null);
  await runCycle(env, daemon);
  assert.equal(strategyRows(env.db).length, 0);
  assert.equal(comparisons(env.db).length, 0);
});
