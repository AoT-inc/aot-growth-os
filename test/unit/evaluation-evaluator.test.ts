// 필수 테스트 "평가 독립성: 실행 에이전트 보고서만으로 성과 확정 불가" (phase-a.md §3, A4) 와 evaluation.md §3·§5.
//  - 보고서만 있는 입력은 `pass`가 나오지 않는다.
//  - 관측 수 부족은 `inconclusive`.
//  - `safety='fail'`이면 효과 점수와 무관하게 `fail`.
//  - `inconclusive`가 성공 사례로 기록되지 않는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryItem, EVALUATION_SOURCE_PREFIX, MemoryRuleError, SEED_IDS, type Db, type EvaluationRow, type FakeClock } from '@aot/domain';
import {
  assertEvaluationInvariants, decide, EVALUATOR_REF, EvaluationError, evaluateRun, findEvaluation, isSuccessCase, reportCostProgress,
  type DecisionFacts, type EffectObservation, type EvaluatorDeps,
} from '@aot/evaluation';

import {
  addEvidence, EXAMPLE_URL, evaluationsOf, evidenceRow, fakeEffect, FakeFetcher, OTHER_URL, researchReport, submittedRun, validationSpec,
  type SubmittedRun,
} from '../support/evaluation.ts';
import { claimNextTask } from '@aot/task-engine';
import { ALLOW_ALL_GATE, queuedTask } from '../support/engine.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const PAGE = 'The quarterly price is fixed for all plans. Support is included.';
const CHECKS = ['url_reachable', 'quote_in_source', 'dedupe', 'budget'];
const goodReport = () => researchReport([
  { id: 'c1', statement: 'Prices are fixed.', source_url: EXAMPLE_URL, quote: 'quarterly price is fixed' },
  { id: 'c2', statement: 'Support is included.', source_url: OTHER_URL, quote: 'Support is included' },
]);

interface Env { db: Db; clock: FakeClock; run: SubmittedRun; deps: EvaluatorDeps }

/** 원본 증거(출처 URL 2건)와 비용 원장이 있는 정상 run */
function withOriginals(t: Parameters<typeof seededDb>[0], options: { report?: unknown; checks?: string[]; effect?: EffectObservation | null; pages?: Record<string, string> } = {}): Env {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: validationSpec(options.checks ?? CHECKS), result: options.report ?? goodReport() });
  addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL, id: 'ev-a' });
  addEvidence(db, clock, run, { kind: 'source_url', ref: OTHER_URL, id: 'ev-b' });
  reportCostProgress(db, clock, { taskRunId: run.runId, cumulativeUsd: 0.5 });
  const fetcher = new FakeFetcher(options.pages ?? { [EXAMPLE_URL]: PAGE, [OTHER_URL]: PAGE });
  return { db, clock, run, deps: { db, clock, fetcher, ...(options.effect === undefined ? {} : { effect: fakeEffect(options.effect) }) } };
}

const evaluate = (env: Env) => evaluateRun(env.deps, { taskId: env.run.taskId, taskRunId: env.run.runId });
const refs = (json: string) => JSON.parse(json) as string[];

test('original evidence that checks out: pass, with the original evidence listed separately from the agent report', async (t) => {
  const env = withOriginals(t);
  const { evaluation, created } = await evaluate(env);
  assert.equal(created, true);
  assert.equal(evaluation.outcome, 'pass');
  assert.equal(evaluation.safety, 'pass');
  assert.equal(evaluation.validation_passed, 1);
  assert.deepEqual(refs(evaluation.primary_evidence_refs), ['evidence:ev-a', 'evidence:ev-b', `cost_ledger:${env.run.runId}`]);
  assert.equal(evaluation.agent_report_used, 1, 'claims were taken from the report, which is only a reference');
  assert.ok(refs(evaluation.evidence_refs).includes(`agent_report:${env.run.runId}`));
  assert.ok(!refs(evaluation.primary_evidence_refs).some((ref) => ref.startsWith('agent_report')));
  // 결정론적 검사가 evidence 를 갱신했다
  assert.equal(evidenceRow(env.db, 'ev-a').verified, 1);
  assert.match(evidenceRow(env.db, 'ev-a').verification_note ?? '', /url_reachable: reachable/);
  assert.equal(isSuccessCase(evaluation), true);
});

test('independence: input with only the agent report never passes (inconclusive, evidence insufficient)', async (t) => {
  const { db, clock } = seededDb(t);
  // 보고서는 훌륭하지만 원본 증거(evidence 행, 비용 원장, 측정 값)가 하나도 없다
  const run = submittedRun(db, clock, { spec: validationSpec(['dedupe']), result: researchReport([{ statement: 'Everything is excellent.', source_url: EXAMPLE_URL }]) });
  const fetcher = new FakeFetcher({ [EXAMPLE_URL]: PAGE });
  const { evaluation } = await evaluateRun({ db, clock, fetcher }, { taskId: run.taskId, taskRunId: run.runId });
  assert.equal(evaluation.outcome, 'inconclusive');
  assert.equal(evaluation.agent_report_used, 1);
  assert.deepEqual(refs(evaluation.primary_evidence_refs), []);
  assert.match(evaluation.quality_note ?? '', /no original evidence \(only the agent report is available\)/);
  assert.equal(isSuccessCase(evaluation), false);

  // 보고서가 아무리 많은 출처를 대도, 원본 증거가 없으면 마찬가지다 (URL 에 접근되어도)
  const cited = submittedRun(db, clock, {
    taskId: 'task-cited', spec: { ...validationSpec(['url_reachable']), inputs: [{ name: 'k', ref: 'r:k', kind: 'k' }] }, result: researchReport([{ statement: 'x', source_url: EXAMPLE_URL }]),
  });
  const again = await evaluateRun({ db, clock, fetcher }, { taskId: cited.taskId, taskRunId: cited.runId });
  assert.equal(again.evaluation.outcome, 'inconclusive');
});

test('independence: the invariant is also enforced when a row is built by hand (pass without original evidence, pass with safety fail)', () => {
  const base = { outcome: 'pass' as const, safety: 'pass' as const, primary_evidence_refs: '[]', agent_report_used: 1 };
  assert.throws(() => assertEvaluationInvariants(base), EvaluationError);
  assert.throws(() => assertEvaluationInvariants({ ...base, primary_evidence_refs: '["evidence:x"]', safety: 'fail' }), EvaluationError);
  assertEvaluationInvariants({ ...base, primary_evidence_refs: '["evidence:x"]' });
  assertEvaluationInvariants({ ...base, outcome: 'inconclusive' });
});

test('decide: the decision table (safety veto first, definite failures before insufficiency, pass only with everything met)', () => {
  const ok: DecisionFacts = { safetyFailures: [], checks: [{ id: 'a', status: 'pass' }], llm: 'not_configured', primaryEvidenceCount: 1, effect: { state: 'not_measured' } };
  const outcome = (facts: Partial<DecisionFacts>) => decide({ ...ok, ...facts }).outcome;
  assert.equal(outcome({}), 'pass');
  assert.equal(outcome({ safetyFailures: ['x'], checks: [{ id: 'a', status: 'unknown' }], primaryEvidenceCount: 0 }), 'fail', 'safety wins over everything');
  assert.equal(outcome({ checks: [{ id: 'a', status: 'fail' }, { id: 'b', status: 'unknown' }] }), 'fail');
  assert.equal(outcome({ checks: [{ id: 'a', status: 'unknown' }] }), 'inconclusive');
  assert.equal(outcome({ primaryEvidenceCount: 0 }), 'inconclusive');
  assert.equal(outcome({ llm: 'unclear' }), 'inconclusive');
  assert.equal(outcome({ llm: 'unsupported' }), 'fail');
  assert.equal(outcome({ llm: 'supported' }), 'pass');
  assert.equal(outcome({ effect: { state: 'insufficient', reason: 'few' } }), 'inconclusive');
  assert.equal(outcome({ effect: { state: 'poor_quality', reason: 'dirty' } }), 'inconclusive');
  assert.equal(outcome({ effect: { state: 'unmeasurable', reason: 'no data' } }), 'inconclusive');
  assert.equal(outcome({ effect: { state: 'below_target', mean: 1, observations: 9 } }), 'fail');
  assert.equal(outcome({ effect: { state: 'met', mean: 9, observations: 9 } }), 'pass');
  assert.equal(outcome({ effect: { state: 'recorded_only', mean: 0, observations: 9 } }), 'pass');
  assert.equal(decide({ ...ok, safetyFailures: ['x'] }).safety, 'fail');
});

const signal = (over: Partial<Extract<EffectObservation, { measurable: true }>['signal']> = {}): EffectObservation => ({
  measurable: true,
  signal: { name: 'weekly-conversions', values: [10, 12, 14, 12, 12], minObservations: 5, dataQualityOk: true, passAtLeast: 10, ...over },
});

test('independence: too few observations -> inconclusive; poor data quality or an unmeasurable signal -> inconclusive', async (t) => {
  const few = await evaluate(withOriginals(t, { effect: signal({ values: [100, 100, 100], minObservations: 5 }) }));
  assert.equal(few.evaluation.outcome, 'inconclusive');
  assert.equal(few.evaluation.effect, null, 'no effect score is claimed from too few observations');
  assert.match(few.evaluation.effect_note ?? '', /3 observation\(s\), fewer than the required 5/);

  const dirty = await evaluate(withOriginals(t, { effect: signal({ dataQualityOk: false }) }));
  assert.equal(dirty.evaluation.outcome, 'inconclusive');
  assert.match(dirty.evaluation.effect_note ?? '', /data quality/);

  const none = await evaluate(withOriginals(t, { effect: { measurable: false, reason: 'analytics source offline' } }));
  assert.equal(none.evaluation.outcome, 'inconclusive');
  assert.match(none.evaluation.effect_note ?? '', /analytics source offline/);
});

test('effect: enough observations are judged against the pass line; the measurement is an original-evidence reference', async (t) => {
  const met = await evaluate(withOriginals(t, { effect: signal() }));
  assert.equal(met.evaluation.outcome, 'pass');
  assert.equal(met.evaluation.effect, 12);
  assert.ok(refs(met.evaluation.primary_evidence_refs).includes('measurement:weekly-conversions'));

  const low = await evaluate(withOriginals(t, { effect: signal({ values: [1, 2, 3, 2, 2] }) }));
  assert.equal(low.evaluation.outcome, 'fail');
  assert.equal(low.evaluation.effect, 2);

  const noLine = signal({ values: [1, 2, 3, 2, 2] });
  if (noLine.measurable) delete (noLine.signal as { passAtLeast?: number }).passAtLeast;
  const recordOnly = await evaluate(withOriginals(t, { effect: noLine }));
  assert.equal(recordOnly.evaluation.outcome, 'pass', 'without a pass line the effect is recorded but does not decide');
});

test('independence: safety=fail is a fail whatever the effect score is, and the four axes stay in separate fields', async (t) => {
  const env = withOriginals(t, { checks: [...CHECKS, 'policy_compliance'], effect: signal({ values: [1000, 1000, 1000, 1000, 1000] }) });
  // 정책 판정 기록 없이 외부 부작용이 나갔다 = 안전성 위반
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, at)
     VALUES ('eff-1', 'k1', ?, ?, 'notify-tool', 'send', 'mailbox:example', 'h', 'confirmed', 1, ?)`,
    [env.run.taskId, env.run.runId, env.clock.nowIso()],
  ));
  const { evaluation } = await evaluate(env);
  assert.equal(evaluation.outcome, 'fail');
  assert.equal(evaluation.safety, 'fail');
  assert.equal(evaluation.effect, 1000, 'the (huge) effect score is recorded, but it cannot outweigh safety');
  assert.match(evaluation.safety_note ?? '', /policy_compliance/);
  // 네 축은 별도 필드
  assert.ok(evaluation.quality !== null && evaluation.quality < 1);
  assert.equal(evaluation.economics, 0.75, '1 - 0.5/2');
  assert.equal(evaluation.total_cost_usd, 0.5);
  assert.equal(isSuccessCase(evaluation), false);
});

test('a clean safety record with the same huge effect passes (the veto is the only difference)', async (t) => {
  const { evaluation } = await evaluate(withOriginals(t, { effect: signal({ values: [1000, 1000, 1000, 1000, 1000] }) }));
  assert.equal(evaluation.outcome, 'pass');
  assert.equal(evaluation.safety, 'pass');
});

test('a definite deterministic failure is a fail; an unverifiable check id makes it inconclusive', async (t) => {
  const failEnv = withOriginals(t, { pages: { [EXAMPLE_URL]: PAGE } });
  const failing = await evaluate(failEnv);
  assert.equal(failing.evaluation.outcome, 'fail', 'OTHER_URL is unreachable');
  assert.equal(failing.evaluation.validation_passed, 0);
  assert.equal(evidenceRow(failEnv.db, 'ev-a').verified, 1);
  assert.equal(evidenceRow(failEnv.db, 'ev-b').verified, 0);
  assert.deepEqual(refs(failing.evaluation.primary_evidence_refs), ['evidence:ev-a', `cost_ledger:${failEnv.run.runId}`], 'an unverified row is not original evidence');

  const unknown = await evaluate(withOriginals(t, { checks: [...CHECKS, 'required_tests'] }));
  assert.equal(unknown.evaluation.outcome, 'inconclusive');
  assert.match(unknown.evaluation.quality_note ?? '', /required_tests=unknown/);
});

test('the evaluator is recorded as id@version, and re-evaluating the same run is absorbed (UNIQUE task, run, evaluator)', async (t) => {
  const env = withOriginals(t);
  const first = await evaluate(env);
  assert.equal(first.evaluation.evaluator, EVALUATOR_REF);
  assert.match(EVALUATOR_REF, /^[a-z-]+@v\d+$/);
  const calls = (env.deps.fetcher as FakeFetcher).calls.length;
  const second = await evaluate(env);
  assert.equal(second.created, false);
  assert.equal(second.evaluation.id, first.evaluation.id);
  assert.equal((env.deps.fetcher as FakeFetcher).calls.length, calls, 'an absorbed re-validation does not fetch again');
  assert.equal(evaluationsOf(env.db, env.run.taskId).length, 1);

  // 데이터베이스도 같은 키로 중복을 막는다 (다른 프로세스와 경쟁한 경우의 안전망)
  assert.throws(() => env.db.writeTx((tx) => tx.run(
    `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, safety, evidence_refs, at)
     VALUES ('dup', ?, ?, ?, 1, 'pass', '[]', 'pass', '[]', ?)`,
    [env.run.taskId, env.run.runId, EVALUATOR_REF, env.clock.nowIso()],
  )), /UNIQUE/);
  // 평가기 버전이 다르면 새 행이다
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, safety, evidence_refs, at)
     VALUES ('v2', ?, ?, 'task-evaluator@v2', 1, 'pass', '["evidence:ev-a"]', 'pass', '[]', ?)`,
    [env.run.taskId, env.run.runId, env.clock.nowIso()],
  ));
  assert.equal(findEvaluation(env.db, env.run.taskId, env.run.runId)?.id, first.evaluation.id);
  assert.equal(findEvaluation(env.db, env.run.taskId, env.run.runId, 'task-evaluator@v2')?.id, 'v2');
});

test('only a submitted run of that task can be evaluated', async (t) => {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  const taskId = queuedTask(db, clock);
  const claim = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: 'w1', actorId, adapter: 'fake-adapter', leaseMs: 60_000 });
  const deps = { db, clock, fetcher: new FakeFetcher() };
  await assert.rejects(evaluateRun(deps, { taskId, taskRunId: claim.claimed!.lease.runId }), /no submitted result/);
  await assert.rejects(evaluateRun(deps, { taskId, taskRunId: 'run-other' }), EvaluationError);
  await assert.rejects(evaluateRun(deps, { taskId: 'task-missing', taskRunId: 'x' }), EvaluationError);
});

test('inconclusive evaluation is not stored as a lesson or strategy_record (memory rule 8, end to end)', async (t) => {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: validationSpec(['dedupe']), result: researchReport([{ statement: 'Only the agent says so.', source_url: EXAMPLE_URL }]) });
  const { evaluation } = await evaluateRun({ db, clock, fetcher: new FakeFetcher() }, { taskId: run.taskId, taskRunId: run.runId });
  assert.equal(evaluation.outcome, 'inconclusive');
  const attempt = (kind: 'lesson' | 'strategy_record') => db.writeTx((tx) => createMemoryItem(tx, {
    kind, body: 'what we learned', source_ref: `${EVALUATION_SOURCE_PREFIX}${evaluation.id}`, observed_at: '2026-10-20T00:00:00Z', created_by: SEED_IDS.owner,
  }, { clock }));
  for (const kind of ['lesson', 'strategy_record'] as const) {
    assert.throws(() => attempt(kind), (error: unknown) => error instanceof MemoryRuleError && error.code === 'inconclusive_not_learnable');
  }
  assert.equal(db.get('SELECT count(*) AS n FROM memory_item')?.['n'], 0);
});

test('economics and human time come from the ledger, not from the report', async (t) => {
  const env = withOriginals(t, { report: { ...goodReport(), reported_cost_usd: 0, human_minutes: 0 } });
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES ('c-h', ?, ?, NULL, 'human_time', 0.5, '{\"minutes\":15}', ?)",
    [env.run.taskId, env.run.runId, env.clock.nowIso()],
  ));
  const { evaluation } = (await evaluate(env));
  const row: EvaluationRow = evaluation;
  assert.equal(row.total_cost_usd, 1);
  assert.equal(row.human_minutes, 15);
  assert.equal(row.economics, 0.5);
});
