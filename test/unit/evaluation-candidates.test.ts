// A6-U14: 실험 후보 형식(`candidates`), 결정론적 검사 `experiment_candidates`, 후보 비교기 `compareCandidates`.
// 비교기는 순수 함수다: 위험 판정은 주입하고, 에이전트의 기대 효과·비용 주장은 비교 기록의 `agent_claim` 아래에만 둔다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EvidenceRow, MeasurementSignal, TaskRow, TaskRunRow, TaskSpec } from '@aot/domain';
import {
  candidatesFromResult, checkExperimentCandidates, compareCandidates, COMPARATOR_REF, defaultChecks, evaluateRun, inconclusiveComparison, MAX_CANDIDATES,
  MAX_HYPOTHESIS_CHARS, RANKING_ORDER, runDeterministicChecks,
  type EffectObservation, type ExperimentCandidate, type RiskJudge, type RiskVerdict,
} from '@aot/evaluation';

import { submittedRun, validationSpec } from '../support/evaluation.ts';
import { PACK_SIGNAL } from '../support/measurement.ts';
import { seededDb } from '../support/seeded-db.ts';
import { minimalDraft } from '../support/spec-fixtures.ts';

const SIGNAL = PACK_SIGNAL.id;
const OTHER_SIGNAL: MeasurementSignal = { ...PACK_SIGNAL, id: 'weekly-landing-visits', action: 'visit' };
const SIGNALS: readonly MeasurementSignal[] = [PACK_SIGNAL, OTHER_SIGNAL];
const json = (value: unknown): string => JSON.stringify(value);

/** 마케팅 업무 명세 초안 (trigger 는 엔진이 정하므로 없다) */
function marketingSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const draft: Record<string, unknown> = { ...minimalDraft(), objective: 'example-product 랜딩 페이지 문구를 한 주 동안 바꿔 본다', ...overrides };
  delete draft['trigger'];
  return draft;
}

function candidate(id: string, extra: Partial<ExperimentCandidate> & Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, hypothesis: `hypothesis ${id}`, expected_effect: 20, est_cost_usd: 1, task_spec: marketingSpec(),
    measurement: { signal_id: SIGNAL, period: 'iso_week' }, ...extra,
  };
}

const withoutSpec = (entry: Record<string, unknown>): Record<string, unknown> => {
  const copy = { ...entry };
  delete copy['task_spec'];
  return copy;
};

const FORMAT_TABLE: { name: string; result: string | null; ok: boolean; reason?: RegExp; count?: number }[] = [
  { name: 'one candidate with a task spec', result: json({ candidates: [candidate('a')] }), ok: true, count: 1 },
  { name: 'a candidate naming a pack template instead', result: json({ candidates: [{ ...withoutSpec(candidate('a')), task_template_ref: 'weekly-landing-copy@1' }] }), ok: true, count: 1 },
  { name: 'the maximum number of candidates', result: json({ candidates: Array.from({ length: MAX_CANDIDATES }, (_, i) => candidate(`c${i}`)) }), ok: true, count: MAX_CANDIDATES },
  { name: 'other result fields do not matter', result: json({ summary: 'x', uncertainties: [], candidates: [candidate('a'), candidate('b')] }), ok: true, count: 2 },
  { name: 'no result', result: null, ok: false, reason: /no result/ },
  { name: 'not JSON', result: 'candidates: a', ok: false, reason: /not valid JSON/ },
  { name: 'the field is missing', result: json({ summary: 'x' }), ok: false, reason: /no 'candidates' field/ },
  { name: 'the field is not an array', result: json({ candidates: candidate('a') }), ok: false, reason: /not an array/ },
  { name: 'an empty list', result: json({ candidates: [] }), ok: false, reason: /is empty/ },
  { name: 'too many candidates', result: json({ candidates: Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => candidate(`c${i}`)) }), ok: false, reason: /at most 10/ },
  { name: 'a duplicate id', result: json({ candidates: [candidate('a'), candidate('a')] }), ok: false, reason: /'a' is used more than once/ },
  { name: 'a bad id', result: json({ candidates: [candidate('Has Space')] }), ok: false, reason: /\.id must be lowercase/ },
  { name: 'a blank hypothesis', result: json({ candidates: [candidate('a', { hypothesis: ' ' })] }), ok: false, reason: /hypothesis must be a non-empty string/ },
  { name: 'a hypothesis that is too long', result: json({ candidates: [candidate('a', { hypothesis: 'h'.repeat(MAX_HYPOTHESIS_CHARS + 1) })] }), ok: false, reason: /longer than 500/ },
  { name: 'expected_effect is a string', result: json({ candidates: [candidate('a', { expected_effect: '20' as unknown as number })] }), ok: false, reason: /expected_effect must be a finite number/ },
  { name: 'a negative cost', result: json({ candidates: [candidate('a', { est_cost_usd: -1 })] }), ok: false, reason: /est_cost_usd must be a finite number >= 0/ },
  { name: 'neither a template nor a spec', result: json({ candidates: [withoutSpec(candidate('a'))] }), ok: false, reason: /exactly one of task_template_ref and task_spec/ },
  { name: 'both a template and a spec', result: json({ candidates: [candidate('a', { task_template_ref: 'x@1' })] }), ok: false, reason: /exactly one of/ },
  { name: 'a malformed template ref', result: json({ candidates: [{ ...withoutSpec(candidate('a')), task_template_ref: 'x' }] }), ok: false, reason: /task_template_ref must look like/ },
  { name: 'a spec that fails validateTaskSpec', result: json({ candidates: [candidate('a', { task_spec: marketingSpec({ acceptance_criteria: [] }) })] }), ok: false, reason: /task_spec\.acceptance_criteria: acceptance_criteria must be a non-empty array/ },
  { name: 'a spec with a wildcard network allowlist', result: json({ candidates: [candidate('a', { task_spec: marketingSpec({ constraints: { network_allowlist: ['*'] } }) })] }), ok: false, reason: /forbidden/ },
  { name: 'a spec that sets its own trigger', result: json({ candidates: [candidate('a', { task_spec: { ...marketingSpec(), trigger: { kind: 'manual', ref: 'x' } } })] }), ok: false, reason: /task_spec\.trigger: is filled by the engine/ },
  { name: 'a spec with system fields', result: json({ candidates: [candidate('a', { task_spec: { ...marketingSpec(), policy_version: 'p' } })] }), ok: false, reason: /filled by the system/ },
  { name: 'measurement is missing', result: json({ candidates: [candidate('a', { measurement: undefined as never })] }), ok: false, reason: /measurement must be \{signal_id, period\}/ },
  { name: 'an unknown period', result: json({ candidates: [candidate('a', { measurement: { signal_id: SIGNAL, period: 'day' as never } })] }), ok: false, reason: /period must be one of iso_week/ },
  { name: 'an unknown key on a candidate', result: json({ candidates: [candidate('a', { score: 9 })] }), ok: false, reason: /unknown key\(s\): score/ },
  { name: 'an unknown key in measurement', result: json({ candidates: [candidate('a', { measurement: { signal_id: SIGNAL, period: 'iso_week', week: '2026-W44' } as never })] }), ok: false, reason: /measurement has unknown key\(s\): week/ },
];

test('candidatesFromResult: the format table', () => {
  for (const row of FORMAT_TABLE) {
    const found = candidatesFromResult(row.result);
    assert.equal(found.ok, row.ok, `${row.name}: ${found.ok ? '' : found.reason}`);
    if (found.ok) assert.equal(found.items.length, row.count, row.name);
    else assert.match(found.reason, row.reason!, row.name);
  }
});

test('experiment_candidates check table: pass, fail with a reason, unknown without signal definitions', () => {
  const rows: { name: string; result: string; signals: readonly MeasurementSignal[] | undefined; status: string; note: RegExp }[] = [
    { name: 'well-formed and defined signals', result: json({ candidates: [candidate('a'), candidate('b', { measurement: { signal_id: OTHER_SIGNAL.id, period: 'iso_week' } })] }), signals: SIGNALS, status: 'pass', note: /2 candidate\(s\) are well-formed and measure defined signals/ },
    { name: 'an undefined signal', result: json({ candidates: [candidate('a', { measurement: { signal_id: 'weekly-unknown', period: 'iso_week' } })] }), signals: SIGNALS, status: 'fail', note: /candidate 'a': measurement signal 'weekly-unknown' is not defined/ },
    { name: 'a duplicate id', result: json({ candidates: [candidate('a'), candidate('a')] }), signals: SIGNALS, status: 'fail', note: /used more than once/ },
    { name: 'an invalid marketing spec', result: json({ candidates: [candidate('a', { task_spec: marketingSpec({ cost_budget: { max_usd: -1 } }) })] }), signals: SIGNALS, status: 'fail', note: /max_usd must be a finite number/ },
    { name: 'the field is missing', result: json({ summary: 'x' }), signals: SIGNALS, status: 'fail', note: /no 'candidates' field/ },
    { name: 'no signal definitions configured', result: json({ candidates: [candidate('a')] }), signals: undefined, status: 'unknown', note: /no measurement signal definition is configured/ },
    { name: 'an empty definition list', result: json({ candidates: [candidate('a')] }), signals: [], status: 'unknown', note: /no measurement signal definition/ },
    { name: 'a malformed result fails even without definitions', result: json({ candidates: [] }), signals: undefined, status: 'fail', note: /is empty/ },
  ];
  for (const row of rows) {
    const outcome = checkExperimentCandidates(row.result, row.signals);
    assert.equal(outcome.status, row.status, row.name);
    assert.match(outcome.note, row.note, row.name);
  }
});

test('experiment_candidates is registered like uncertainty_listed (not through extraChecks) and reads the signals given to the evaluator', async (t) => {
  assert.equal(defaultChecks().get('experiment_candidates')?.safety, false);
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: validationSpec(['experiment_candidates']), result: { candidates: [candidate('a')], uncertainties: [] } });
  const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [run.taskId])!;
  const context = {
    db, task, run: db.get<TaskRunRow>('SELECT * FROM task_run WHERE id = ?', [run.runId])!, spec: JSON.parse(task.spec) as TaskSpec, claims: [],
    evidence: db.all<EvidenceRow>('SELECT * FROM evidence WHERE task_id = ?', [run.taskId]), sources: undefined as never,
  };
  assert.equal((await runDeterministicChecks({ ...context, signals: SIGNALS }, ['experiment_candidates'])).checks[0]?.status, 'pass');
  assert.equal((await runDeterministicChecks(context, ['experiment_candidates'])).checks[0]?.status, 'unknown');

  // 평가기: 정의가 없으면 inconclusive, 정의가 있고 후보의 신호가 모르는 것이면 fail
  const other = seededDb(t);
  const bad = submittedRun(other.db, other.clock, { spec: validationSpec(['experiment_candidates']), result: { candidates: [candidate('a', { measurement: { signal_id: 'weekly-unknown', period: 'iso_week' } })] } });
  const noSignals = await evaluateRun({ db, clock, fetcher: { fetch: () => Promise.reject(new Error('no network')) } }, { taskId: run.taskId, taskRunId: run.runId });
  assert.equal(noSignals.evaluation.outcome, 'inconclusive');
  const failed = await evaluateRun({ db: other.db, clock: other.clock, fetcher: { fetch: () => Promise.reject(new Error('no network')) }, signals: SIGNALS }, { taskId: bad.taskId, taskRunId: bad.runId });
  assert.equal(failed.evaluation.outcome, 'fail');
  assert.match(failed.evaluation.quality_note ?? '', /experiment_candidates=fail \(candidate signal/);
});

// ===== compareCandidates =====

const baseline = (overrides: Partial<{ value: number; observations: number; minObservations: number; dataQualityOk: boolean; name: string }> = {}): EffectObservation => ({
  measurable: true,
  signal: {
    name: overrides.name ?? `${SIGNAL}@2026-W43`, values: [overrides.value ?? 10], observations: overrides.observations ?? 3,
    minObservations: overrides.minObservations ?? 1, dataQualityOk: overrides.dataQualityOk ?? true,
  },
});

const parse = (...entries: Record<string, unknown>[]): ExperimentCandidate[] => {
  const found = candidatesFromResult(json({ candidates: entries }));
  if (!found.ok) throw new Error(found.reason);
  return found.items;
};
const allow: RiskJudge = () => ({ decision: 'allow', reasons: ['allowed (test)'] });
const riskTable = (table: Record<string, RiskVerdict['decision']>): RiskJudge => (c) => ({ decision: table[c.id] ?? 'allow', reasons: [`${table[c.id] ?? 'allow'} (test)`] });
const compare = (candidates: ExperimentCandidate[], extra: Partial<Parameters<typeof compareCandidates>[0]> = {}) =>
  compareCandidates({ candidates, baseline: baseline(), signals: SIGNALS, riskOf: allow, budgetUsd: 5, ...extra });
const statusOf = (record: ReturnType<typeof compare>) => Object.fromEntries(record.candidates.map((c) => [c.id, [c.status, c.rank, c.exclusions.map((e) => e.code)]]));

test('compareCandidates: deny candidates are excluded with the judge reasons; require_approval stays but ranks after allow', () => {
  const record = compare(parse(candidate('a', { expected_effect: 30 }), candidate('b', { expected_effect: 20 }), candidate('c', { expected_effect: 40 })), {
    riskOf: riskTable({ c: 'deny', a: 'require_approval' }),
  });
  assert.equal(record.outcome, 'recommended');
  assert.equal(record.recommended, 'b', 'allow ranks before require_approval even with a smaller claim');
  assert.deepEqual(statusOf(record), { b: ['ranked', 1, []], a: ['ranked', 2, []], c: ['excluded', null, ['risk_denied']] });
  assert.match(record.candidates.find((c) => c.id === 'c')!.exclusions[0]!.detail, /deny \(test\)/);
});

test('compareCandidates: a candidate measuring another signal, an undefined signal, or over the budget is excluded with the reason', () => {
  const record = compare(parse(
    candidate('a'),
    candidate('other', { measurement: { signal_id: OTHER_SIGNAL.id, period: 'iso_week' } }),
    candidate('ghost', { measurement: { signal_id: 'weekly-ghost', period: 'iso_week' } }),
    candidate('pricey', { est_cost_usd: 6 }),
    candidate('big-budget', { task_spec: marketingSpec({ cost_budget: { max_usd: 9 } }) }),
  ));
  assert.deepEqual(statusOf(record), {
    a: ['ranked', 1, []], 'big-budget': ['excluded', null, ['over_budget']], ghost: ['excluded', null, ['unknown_signal']],
    other: ['excluded', null, ['signal_mismatch']], pricey: ['excluded', null, ['over_budget']],
  });
  assert.equal(record.recommended, 'a');
  assert.match(record.candidates.find((c) => c.id === 'big-budget')!.exclusions[0]!.detail, /cost_budget\.max_usd 9 exceeds the budget 5/);
});

test('compareCandidates: the pass line is set from the baseline; a claim below it is excluded; nothing left -> no_candidate (review)', () => {
  const record = compare(parse(candidate('low', { expected_effect: 10.5 }), candidate('denied')), { riskOf: riskTable({ denied: 'deny' }) });
  assert.equal(record.pass_at_least, 11, 'baseline 10 + max(1, 10 x 0.1)');
  assert.deepEqual(statusOf(record), { denied: ['excluded', null, ['risk_denied']], low: ['excluded', null, ['below_pass_line']] });
  assert.equal(record.outcome, 'no_candidate');
  assert.equal(record.review_required, true);
  assert.equal(record.recommended, null);
  assert.equal(compare(parse(candidate('a', { expected_effect: 200 })), { baseline: baseline({ value: 100 }) }).pass_at_least, 110, 'relative lift dominates a large baseline');
});

test('compareCandidates: an insufficient, poor-quality, unmeasurable or missing baseline makes the comparison inconclusive; no candidate is chosen', () => {
  const cases: [string, EffectObservation | null, RegExp, string][] = [
    ['insufficient', baseline({ observations: 0, minObservations: 1 }), /baseline insufficient/, 'insufficient'],
    ['poor quality', baseline({ dataQualityOk: false }), /baseline poor_quality/, 'poor_quality'],
    ['unmeasurable', { measurable: false, reason: 'no value is recorded' }, /baseline unmeasurable/, 'unmeasurable'],
    ['missing', null, /no baseline measurement/, 'missing'],
    ['undefined baseline signal', baseline({ name: 'weekly-ghost@2026-W43' }), /not a defined measurement signal/, 'recorded_only'],
  ];
  for (const [name, observation, reason, state] of cases) {
    const record = compare(parse(candidate('a'), candidate('d')), { baseline: observation, riskOf: riskTable({ d: 'deny' }) });
    assert.equal(record.outcome, 'inconclusive', name);
    assert.equal(record.recommended, null, name);
    assert.equal(record.review_required, true, name);
    assert.equal(record.pass_at_least, null, name);
    assert.equal(record.baseline_state, state, name);
    assert.match(record.reasons.join(' '), reason, name);
    assert.deepEqual(statusOf(record), { a: ['not_compared', null, []], d: ['excluded', null, ['risk_denied']] }, name);
    assert.equal(record.candidates.find((c) => c.id === 'a')!.agent_claim.lift, null, `${name}: no lift without a baseline`);
  }
});

test('compareCandidates: the ranking order is documented; ties fall back to lift, then cost, then id', () => {
  assert.deepEqual(record0().ranking, RANKING_ORDER);
  // 같은 비용당 상승: e1(lift 10, cost 1) 과 e2(lift 20, cost 2) → lift 큰 e2. 완전 동점 t-b/t-a → id 순
  const record = compare(parse(
    candidate('e1', { expected_effect: 20, est_cost_usd: 1 }),
    candidate('e2', { expected_effect: 30, est_cost_usd: 2 }),
    candidate('t-b', { expected_effect: 15, est_cost_usd: 1 }),
    candidate('t-a', { expected_effect: 15, est_cost_usd: 1 }),
    candidate('zero', { expected_effect: 12, est_cost_usd: 0 }),
  ));
  assert.deepEqual(record.candidates.map((c) => [c.id, c.rank]), [['zero', 1], ['e2', 2], ['e1', 3], ['t-a', 4], ['t-b', 5]]);
  assert.equal(record.candidates[0]!.agent_claim.lift_per_usd, 200, 'a zero cost uses the 0.01 USD floor');
  // 같은 입력이면 같은 기록, 입력 순서와 무관
  const shuffled = compare(parse(candidate('t-a', { expected_effect: 15, est_cost_usd: 1 }), candidate('t-b', { expected_effect: 15, est_cost_usd: 1 })));
  const ordered = compare(parse(candidate('t-b', { expected_effect: 15, est_cost_usd: 1 }), candidate('t-a', { expected_effect: 15, est_cost_usd: 1 })));
  assert.deepEqual(shuffled, ordered);
  assert.equal(shuffled.recommended, 't-a');
});

function record0() {
  return compare(parse(candidate('a')));
}

test('compareCandidates: the agent claim appears only under agent_claim; evaluator facts are separate', () => {
  const record = compare(parse(candidate('a', { expected_effect: 27.5, est_cost_usd: 1.25 })));
  const [entry] = record.candidates;
  assert.deepEqual(entry!.agent_claim, { hypothesis: 'hypothesis a', expected_effect: 27.5, est_cost_usd: 1.25, lift: 17.5, lift_per_usd: 14 });
  assert.deepEqual(Object.keys(entry!).sort(), ['agent_claim', 'exclusions', 'id', 'measurement', 'rank', 'risk', 'status']);
  // 주장 값(27.5, 1.25, 17.5, 14)은 agent_claim 밖 어디에도 없다
  const outside = JSON.stringify({ ...record, candidates: record.candidates.map((entry) => {
    const copy: Partial<typeof entry> = { ...entry };
    delete copy.agent_claim;
    return copy;
  }) });
  for (const value of ['27.5', '1.25', '17.5', ':14']) assert.ok(!outside.includes(value), `${value} must not appear outside agent_claim`);
  assert.deepEqual(record.baseline, { signal_id: SIGNAL, week: '2026-W43', value: 10, observations: 3, min_observations: 1 });
  assert.equal(record.comparator, COMPARATOR_REF);
});

test('compareCandidates: a throwing or odd risk judge counts as deny; bad budgets are refused; inconclusiveComparison has no candidates', () => {
  const record = compare(parse(candidate('a'), candidate('b')), {
    riskOf: (c) => {
      if (c.id === 'a') throw new Error('policy unavailable');
      return { decision: 'maybe' as never, reasons: [] };
    },
  });
  assert.equal(record.outcome, 'no_candidate');
  assert.match(record.candidates[0]!.exclusions[0]!.detail, /risk judgement failed: policy unavailable/);
  assert.match(record.candidates[1]!.exclusions[0]!.detail, /unknown decision 'maybe'/);
  assert.throws(() => compare(parse(candidate('a')), { budgetUsd: -1 }), /budgetUsd must be a finite number >= 0/);
  const none = inconclusiveComparison(['no result'], { budgetUsd: 5 });
  assert.deepEqual([none.outcome, none.review_required, none.candidates, none.recommended], ['inconclusive', true, [], null]);
});
