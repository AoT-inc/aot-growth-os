// 실험 후보 비교기 (A6-U14, 주간 사이클 5단계, operations/evaluation.md §7). 순수 함수: 같은 입력이면 같은 비교 기록이다(시계·난수·DB 없음).
//
// 입력: 후보(candidates.ts 형식), 기준선 측정(U13 의 `EffectObservation`, 기획 업무의 `inputs[kind=measurement]`), 신호 정의, 위험 판정 함수(주입), 예산 상한.
// 위험 판정은 *주입*이다: 이 패키지는 정책(@aot/policy)을 모른다(경계 lint). apps/daemon 이 정책 판정 함수를 `riskOf` 로 넘긴다.
//
// 규칙
//   1. 기준선이 없거나 측정 불가·관측 수 부족·데이터 품질 불량이면 비교 자체가 `inconclusive` 다. 후보를 고르지 않는다(평가기의 효과 판정과 같은 규칙, assessEffect).
//   2. 제외(사유를 모두 기록): 위험 판정 `deny`, 신호가 정의에 없음·기준선과 다른 신호·주기 불일치, 예산 초과(에이전트 추정 비용 또는 마케팅 업무 명세의
//      `cost_budget.max_usd` 가 상한 초과), 합격선 미달(에이전트가 주장한 기대 효과가 합격선보다 낮음).
//   3. 합격선 = 기준선 + max(최소 절대 상승, 기준선 × 최소 상대 상승). 비교기가 기준선 대비로 정한다(A6 결정 ②). 실험 주(1주, 관측 1)의 측정 값이 이 값 이상이면 효과 충족이다.
//   4. 남은 후보의 정렬(RANKING_ORDER): 위험 allow 가 require_approval 보다 먼저 → 비용당 상승(lift ÷ max(비용, 0.01 USD)) 큰 순 → 상승 큰 순 → 비용 작은 순 → id 순.
//      상승(lift) = 기대 효과 − 기준선. 1위가 추천이다. 남은 후보가 없으면 `no_candidate`.
//   5. 평가기 독립: 기대 효과·추정 비용과 그로부터 계산한 상승·비용당 상승은 에이전트의 주장이므로 후보마다 `agent_claim` 아래에만 둔다.
//      비교기가 스스로 확인한 사실(위험 판정, 신호·예산 대조, 기준선, 합격선)과 섞지 않는다. 주장은 순서를 정하는 참고일 뿐 효과의 근거가 아니다 —
//      효과는 실험 주의 실제 측정 값으로 평가기가 따로 판정한다(U16).
import type { MeasurementSignal, PlainObject } from '@aot/domain';

import type { ExperimentCandidate } from './candidates.ts';
import { assessEffect, type EffectAssessment } from './evaluator.ts';
import type { EffectObservation } from './ports.ts';

export const COMPARATOR_ID = 'candidate-comparator';
export const COMPARATOR_VERSION = 'v1';
export const COMPARATOR_REF = `${COMPARATOR_ID}@${COMPARATOR_VERSION}`;

export const DEFAULT_MIN_RELATIVE_LIFT = 0.1;
export const DEFAULT_MIN_ABSOLUTE_LIFT = 1;
/** 비용당 상승을 셀 때 비용의 하한(USD). 비용 0 인 후보가 무한대 점수를 얻지 않게 한다 */
export const MIN_COST_FOR_RATIO_USD = 0.01;

/** 정렬 기준 (앞이 우선). 비교 기록에 그대로 남는다 */
export const RANKING_ORDER = [
  'risk.decision: allow before require_approval',
  'agent_claim.lift_per_usd: higher first (lift / max(est_cost_usd, 0.01))',
  'agent_claim.lift: higher first',
  'agent_claim.est_cost_usd: lower first',
  'id: ascending',
] as const;

export type RiskDecision = 'allow' | 'require_approval' | 'deny';

export interface RiskVerdict {
  decision: RiskDecision;
  reasons: string[];
}

/** 후보 하나의 위험 판정 (주입). 예외는 deny 로 다룬다 */
export type RiskJudge = (candidate: ExperimentCandidate) => RiskVerdict;

export type ExclusionCode = 'risk_denied' | 'unknown_signal' | 'signal_mismatch' | 'period_mismatch' | 'over_budget' | 'below_pass_line';

export interface Exclusion {
  code: ExclusionCode;
  detail: string;
}

/** 에이전트의 주장과 그 주장만으로 계산한 값. 참고용이다 */
export interface AgentClaim {
  hypothesis: string;
  expected_effect: number;
  est_cost_usd: number;
  /** 기대 효과 − 기준선. 기준선이 없으면 null */
  lift: number | null;
  lift_per_usd: number | null;
}

export interface CandidateComparison {
  id: string;
  /** ranked: 정렬됨, excluded: 제외(사유 있음), not_compared: 비교가 inconclusive 라 순위를 매기지 않음 */
  status: 'ranked' | 'excluded' | 'not_compared';
  rank: number | null;
  risk: RiskVerdict;
  exclusions: Exclusion[];
  measurement: { signal_id: string; period: string };
  agent_claim: AgentClaim;
}

export interface BaselineFacts {
  signal_id: string;
  week: string;
  value: number;
  observations: number;
  min_observations: number;
}

export type ComparisonOutcome = 'recommended' | 'no_candidate' | 'inconclusive';

export interface ComparisonRecord {
  comparator: string;
  outcome: ComparisonOutcome;
  /** 추천 없이 끝났으면(no_candidate, inconclusive) 사람이 검토한다 */
  review_required: boolean;
  reasons: string[];
  /** 기준선의 효과 판정 상태 (평가기 assessEffect 의 state) */
  baseline_state: EffectAssessment['state'] | 'missing';
  baseline: BaselineFacts | null;
  pass_at_least: number | null;
  budget_usd: number;
  min_relative_lift: number;
  min_absolute_lift: number;
  ranking: readonly string[];
  recommended: string | null;
  /** 순위 순, 그다음 제외·미비교 후보 id 순 */
  candidates: CandidateComparison[];
}

export interface CompareCandidatesInput {
  candidates: readonly ExperimentCandidate[];
  /** 기획 업무의 기준선 측정. 없으면 null */
  baseline: EffectObservation | null;
  signals: readonly MeasurementSignal[];
  riskOf: RiskJudge;
  /** 실험 하나의 비용 상한(USD) */
  budgetUsd: number;
  minRelativeLift?: number;
  minAbsoluteLift?: number;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const RISK_ORDER: Record<RiskDecision, number> = { allow: 0, require_approval: 1, deny: 2 };

function judge(riskOf: RiskJudge, candidate: ExperimentCandidate): RiskVerdict {
  try {
    const verdict = riskOf(candidate);
    if (!(verdict.decision in RISK_ORDER)) return { decision: 'deny', reasons: [`risk judgement returned an unknown decision '${String(verdict.decision)}'`] };
    return { decision: verdict.decision, reasons: [...verdict.reasons] };
  } catch (error) {
    return { decision: 'deny', reasons: [`risk judgement failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function nonNegative(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite number >= 0`);
  return value;
}

/** 비교할 수 없을 때의 기록 (기획 결과를 읽을 수 없음 등). 후보 없이 사유만 남긴다 */
export function inconclusiveComparison(reasons: readonly string[], options: Pick<CompareCandidatesInput, 'budgetUsd' | 'minRelativeLift' | 'minAbsoluteLift'>): ComparisonRecord {
  return {
    comparator: COMPARATOR_REF, outcome: 'inconclusive', review_required: true, reasons: [...reasons], baseline_state: 'missing', baseline: null, pass_at_least: null,
    budget_usd: nonNegative('budgetUsd', options.budgetUsd),
    min_relative_lift: nonNegative('minRelativeLift', options.minRelativeLift ?? DEFAULT_MIN_RELATIVE_LIFT),
    min_absolute_lift: nonNegative('minAbsoluteLift', options.minAbsoluteLift ?? DEFAULT_MIN_ABSOLUTE_LIFT),
    ranking: RANKING_ORDER, recommended: null, candidates: [],
  };
}

/** 기준선 판정: 비교에 쓸 수 있으면 사실, 아니면 inconclusive 사유 */
function readBaseline(observation: EffectObservation | null, signals: ReadonlyMap<string, MeasurementSignal>):
  { ok: true; facts: BaselineFacts; state: EffectAssessment['state'] } | { ok: false; reason: string; state: EffectAssessment['state'] | 'missing' } {
  if (observation === null) return { ok: false, reason: 'the planning task has no baseline measurement input', state: 'missing' };
  const assessed = assessEffect(observation);
  if (assessed.state === 'unmeasurable' || assessed.state === 'insufficient' || assessed.state === 'poor_quality') {
    return { ok: false, reason: `baseline ${assessed.state}: ${assessed.reason}`, state: assessed.state };
  }
  if (!observation.measurable || (assessed.state !== 'met' && assessed.state !== 'below_target' && assessed.state !== 'recorded_only')) {
    return { ok: false, reason: 'baseline is not measured', state: assessed.state };
  }
  const { signal } = observation;
  const at = signal.name.lastIndexOf('@');
  const signalId = at > 0 ? signal.name.slice(0, at) : '';
  const week = at > 0 ? signal.name.slice(at + 1) : '';
  if (signalId === '' || week === '') return { ok: false, reason: `baseline signal name '${signal.name}' is not '<signal id>@<week>'`, state: assessed.state };
  if (!signals.has(signalId)) return { ok: false, reason: `baseline signal '${signalId}' is not a defined measurement signal`, state: assessed.state };
  return {
    ok: true, state: assessed.state,
    facts: { signal_id: signalId, week, value: assessed.mean, observations: assessed.observations, min_observations: signal.minObservations },
  };
}

export function compareCandidates(input: CompareCandidatesInput): ComparisonRecord {
  const budget = nonNegative('budgetUsd', input.budgetUsd);
  const relative = nonNegative('minRelativeLift', input.minRelativeLift ?? DEFAULT_MIN_RELATIVE_LIFT);
  const absolute = nonNegative('minAbsoluteLift', input.minAbsoluteLift ?? DEFAULT_MIN_ABSOLUTE_LIFT);
  const signals = new Map(input.signals.map((signal) => [signal.id, signal]));
  const candidates = [...input.candidates].sort(byId);

  const base = { comparator: COMPARATOR_REF, budget_usd: budget, min_relative_lift: relative, min_absolute_lift: absolute, ranking: RANKING_ORDER };
  const duplicate = candidates.find((candidate, index) => index > 0 && candidates[index - 1]!.id === candidate.id);
  if (duplicate !== undefined) {
    return { ...base, outcome: 'inconclusive', review_required: true, reasons: [`candidate id '${duplicate.id}' is given more than once`], baseline_state: 'missing', baseline: null, pass_at_least: null, recommended: null, candidates: [] };
  }

  const baseline = readBaseline(input.baseline, signals);
  const passAtLeast = baseline.ok ? round(baseline.facts.value + Math.max(absolute, baseline.facts.value * relative)) : null;

  const compared = candidates.map((candidate): CandidateComparison => {
    const risk = judge(input.riskOf, candidate);
    const exclusions: Exclusion[] = [];
    if (risk.decision === 'deny') exclusions.push({ code: 'risk_denied', detail: risk.reasons.join('; ') || 'denied' });
    const signal = signals.get(candidate.measurement.signal_id);
    if (signal === undefined) {
      exclusions.push({ code: 'unknown_signal', detail: `measurement signal '${candidate.measurement.signal_id}' is not defined` });
    } else {
      if (signal.period !== candidate.measurement.period) exclusions.push({ code: 'period_mismatch', detail: `period '${candidate.measurement.period}' differs from the signal's '${signal.period}'` });
      if (baseline.ok && candidate.measurement.signal_id !== baseline.facts.signal_id) {
        exclusions.push({ code: 'signal_mismatch', detail: `measures '${candidate.measurement.signal_id}' but the baseline is '${baseline.facts.signal_id}'` });
      }
    }
    if (candidate.est_cost_usd > budget) exclusions.push({ code: 'over_budget', detail: `estimated cost ${candidate.est_cost_usd} USD exceeds the budget ${budget} USD` });
    const specBudget = specMaxUsd(candidate.task_spec);
    if (specBudget !== null && specBudget > budget) exclusions.push({ code: 'over_budget', detail: `the task's cost_budget.max_usd ${specBudget} exceeds the budget ${budget} USD` });

    const lift = baseline.ok ? round(candidate.expected_effect - baseline.facts.value) : null;
    const liftPerUsd = lift === null ? null : round(lift / Math.max(candidate.est_cost_usd, MIN_COST_FOR_RATIO_USD));
    if (passAtLeast !== null && candidate.expected_effect < passAtLeast) {
      exclusions.push({ code: 'below_pass_line', detail: `the claimed effect ${candidate.expected_effect} is below the pass line ${passAtLeast}` });
    }
    return {
      id: candidate.id,
      status: exclusions.length > 0 ? 'excluded' : baseline.ok ? 'ranked' : 'not_compared',
      rank: null,
      risk,
      exclusions,
      measurement: { signal_id: candidate.measurement.signal_id, period: candidate.measurement.period },
      agent_claim: { hypothesis: candidate.hypothesis, expected_effect: candidate.expected_effect, est_cost_usd: candidate.est_cost_usd, lift, lift_per_usd: liftPerUsd },
    };
  });

  if (!baseline.ok) {
    return {
      ...base, outcome: 'inconclusive', review_required: true, reasons: [`comparison inconclusive: ${baseline.reason}`], baseline_state: baseline.state, baseline: null,
      pass_at_least: null, recommended: null, candidates: compared,
    };
  }

  const ranked = compared.filter((entry) => entry.status === 'ranked').sort(rankOrder);
  ranked.forEach((entry, index) => { entry.rank = index + 1; });
  const rest = compared.filter((entry) => entry.status !== 'ranked');
  const recommended = ranked[0]?.id ?? null;
  return {
    ...base,
    outcome: recommended === null ? 'no_candidate' : 'recommended',
    review_required: recommended === null,
    reasons: recommended === null
      ? [`no candidate remains: ${rest.length} excluded`]
      : [`recommended '${recommended}' (rank 1 of ${ranked.length} ranked, ${rest.length} excluded)`],
    baseline_state: baseline.state,
    baseline: baseline.facts,
    pass_at_least: passAtLeast,
    recommended,
    candidates: [...ranked, ...rest],
  };
}

function rankOrder(a: CandidateComparison, b: CandidateComparison): number {
  const risk = RISK_ORDER[a.risk.decision] - RISK_ORDER[b.risk.decision];
  if (risk !== 0) return risk;
  const perUsd = (b.agent_claim.lift_per_usd ?? 0) - (a.agent_claim.lift_per_usd ?? 0);
  if (perUsd !== 0) return perUsd;
  const lift = (b.agent_claim.lift ?? 0) - (a.agent_claim.lift ?? 0);
  if (lift !== 0) return lift;
  const cost = a.agent_claim.est_cost_usd - b.agent_claim.est_cost_usd;
  if (cost !== 0) return cost;
  return byId(a, b);
}

function specMaxUsd(spec: PlainObject | undefined): number | null {
  const budget = spec?.['cost_budget'];
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) return null;
  const usd = (budget as Record<string, unknown>)['max_usd'];
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : null;
}
