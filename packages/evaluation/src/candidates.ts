// 기획 업무 결과의 실험 후보 (A6-U14, 주간 사이클 4단계, docs/schema/task-spec.md "실험 후보", 검사 id `experiment_candidates`).
// 기획 역할(generalist)이 조사 결과와 기준선 측정을 받아 결과에 `candidates: [...]` 를 싣는다. 이 모듈은 그 *형식*만 본다:
//   { id, hypothesis, expected_effect, est_cost_usd, task_template_ref | task_spec, measurement: { signal_id, period } }
// 값은 모두 에이전트의 자기 신고다. 기대 효과·비용은 비교기(compare.ts)가 *참고*로만 쓰고 비교 기록에 `agent_claim` 으로 표시한다.
// 마케팅 업무 명세(`task_spec`)는 task-spec 초안이며 `validateTaskSpec` 을 통과해야 한다(trigger·dependencies 는 엔진이 정하므로 넣을 수 없다 — 팩 템플릿과 같은 규칙).
// 신호가 알려진 정의인지는 정의 목록이 있어야 알 수 있으므로 `candidateSignalProblems` 로 따로 본다.
import { Buffer } from 'node:buffer';

import {
  isPlainObject, MEASUREMENT_PERIODS, validateTaskSpec,
  type MeasurementPeriod, type MeasurementSignal, type PlainObject,
} from '@aot/domain';

export const EXPERIMENT_CANDIDATES_CHECK_ID = 'experiment_candidates';
export const MAX_CANDIDATES = 10;
export const MAX_CANDIDATE_ID_CHARS = 64;
export const MAX_HYPOTHESIS_CHARS = 500;
/** 후보 하나의 마케팅 업무 명세(JSON, UTF-8) 상한 */
export const MAX_CANDIDATE_SPEC_BYTES = 16 * 1024;

const CANDIDATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 팩 템플릿 참조 `<id>@<version>` (pack-loader 의 routine.task_template 과 같은 모양) */
const TEMPLATE_REF = /^[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/;
const CANDIDATE_KEYS = ['id', 'hypothesis', 'expected_effect', 'est_cost_usd', 'task_template_ref', 'task_spec', 'measurement'];
const MEASUREMENT_KEYS = ['signal_id', 'period'];
/** 엔진이 정하는 필드. 후보 명세에 있으면 거부한다 */
const ENGINE_OWNED_SPEC_FIELDS = ['trigger', 'dependencies'];
/** 명세 검증용 임시 trigger. 실제 trigger 는 실험 승인(U15) 뒤 업무를 만들 때 엔진이 정한다 */
const PROBE_TRIGGER = { kind: 'manual', ref: 'experiment-candidate' } as const;
/** 서로 다른 형식 오류를 이만큼까지만 사유에 적는다 */
const MAX_REPORTED_PROBLEMS = 8;

export interface CandidateMeasurement {
  signal_id: string;
  period: MeasurementPeriod;
}

export interface ExperimentCandidate {
  id: string;
  hypothesis: string;
  /** 에이전트가 주장하는 실험 주의 신호 값 (신호와 같은 단위) */
  expected_effect: number;
  est_cost_usd: number;
  /** 둘 중 정확히 하나 */
  task_template_ref?: string;
  task_spec?: PlainObject;
  measurement: CandidateMeasurement;
}

export type CandidatesParse = { ok: true; items: ExperimentCandidate[] } | { ok: false; reason: string };

const summarize = (label: string, problems: readonly string[]): string =>
  `${label}: ${problems.slice(0, MAX_REPORTED_PROBLEMS).join('; ')}${problems.length > MAX_REPORTED_PROBLEMS ? ` (and ${problems.length - MAX_REPORTED_PROBLEMS} more)` : ''}`;

/** `run.result`(JSON 문자열)에서 `candidates` 를 읽고 형식을 확인한다. 누락·형식 오류는 `ok:false` 와 사유다 */
export function candidatesFromResult(result: string | null): CandidatesParse {
  if (result === null) return { ok: false, reason: 'the run submitted no result' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return { ok: false, reason: 'the run result is not valid JSON' };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'the run result is not a JSON object' };
  if (!Object.hasOwn(parsed, 'candidates')) return { ok: false, reason: "the result has no 'candidates' field" };
  return parseCandidates(parsed['candidates']);
}

/** `candidates` 값의 형식 확인 (최소 1개, 최대 MAX_CANDIDATES, id 중복 없음) */
export function parseCandidates(list: unknown): CandidatesParse {
  if (!Array.isArray(list)) return { ok: false, reason: "'candidates' is not an array" };
  if (list.length === 0) return { ok: false, reason: "'candidates' is empty (a planning result proposes at least one candidate)" };
  if (list.length > MAX_CANDIDATES) return { ok: false, reason: `'candidates' has ${list.length} items (at most ${MAX_CANDIDATES})` };
  const problems: string[] = [];
  const items: ExperimentCandidate[] = [];
  const ids = new Set<string>();
  list.forEach((item: unknown, index) => {
    const at = `candidates[${index}]`;
    if (!isPlainObject(item)) return void problems.push(`${at} is not an object`);
    const found = parseCandidate(item, at, problems);
    if (found === null) return;
    if (ids.has(found.id)) problems.push(`${at}.id '${found.id}' is used more than once`);
    ids.add(found.id);
    items.push(found);
  });
  if (problems.length > 0) return { ok: false, reason: summarize("'candidates' is malformed", problems) };
  return { ok: true, items };
}

function parseCandidate(entry: PlainObject, at: string, problems: string[]): ExperimentCandidate | null {
  const before = problems.length;
  const extra = Object.keys(entry).filter((key) => !CANDIDATE_KEYS.includes(key));
  if (extra.length > 0) problems.push(`${at} has unknown key(s): ${extra.join(', ')}`);

  const { id, hypothesis, expected_effect: effect, est_cost_usd: cost, measurement } = entry;
  if (typeof id !== 'string' || !CANDIDATE_ID.test(id)) problems.push(`${at}.id must be lowercase letters, digits and hyphens (at most ${MAX_CANDIDATE_ID_CHARS} characters)`);
  if (typeof hypothesis !== 'string' || hypothesis.trim() === '') problems.push(`${at}.hypothesis must be a non-empty string`);
  else if (hypothesis.length > MAX_HYPOTHESIS_CHARS) problems.push(`${at}.hypothesis is longer than ${MAX_HYPOTHESIS_CHARS} characters`);
  if (typeof effect !== 'number' || !Number.isFinite(effect)) problems.push(`${at}.expected_effect must be a finite number (in the unit of the measurement signal)`);
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) problems.push(`${at}.est_cost_usd must be a finite number >= 0`);

  const hasRef = Object.hasOwn(entry, 'task_template_ref');
  const hasSpec = Object.hasOwn(entry, 'task_spec');
  if (hasRef === hasSpec) problems.push(`${at} must give exactly one of task_template_ref and task_spec`);
  const ref = entry['task_template_ref'];
  if (hasRef && (typeof ref !== 'string' || !TEMPLATE_REF.test(ref))) problems.push(`${at}.task_template_ref must look like "<template-id>@<version>"`);
  const spec = entry['task_spec'];
  if (hasSpec) problems.push(...candidateSpecProblems(spec).map((problem) => `${at}.task_spec${problem}`));

  if (!isPlainObject(measurement)) {
    problems.push(`${at}.measurement must be {signal_id, period}`);
  } else {
    const unknown = Object.keys(measurement).filter((key) => !MEASUREMENT_KEYS.includes(key));
    if (unknown.length > 0) problems.push(`${at}.measurement has unknown key(s): ${unknown.join(', ')}`);
    if (typeof measurement['signal_id'] !== 'string' || measurement['signal_id'].trim() === '') problems.push(`${at}.measurement.signal_id must be a non-empty string`);
    if (!(MEASUREMENT_PERIODS as readonly unknown[]).includes(measurement['period'])) problems.push(`${at}.measurement.period must be one of ${MEASUREMENT_PERIODS.join('|')}`);
  }
  if (problems.length > before) return null;
  const m = measurement as PlainObject;
  return {
    id: id as string,
    hypothesis: hypothesis as string,
    expected_effect: effect as number,
    est_cost_usd: cost as number,
    ...(hasRef ? { task_template_ref: ref as string } : { task_spec: structuredClone(spec as PlainObject) }),
    measurement: { signal_id: m['signal_id'] as string, period: m['period'] as MeasurementPeriod },
  };
}

/** 마케팅 업무 명세(task-spec 초안)의 문제. 경로는 `.<필드>: 사유` 모양이다 */
export function candidateSpecProblems(spec: unknown): string[] {
  if (!isPlainObject(spec)) return [': must be a task-spec draft object'];
  const problems: string[] = [];
  const bytes = Buffer.byteLength(JSON.stringify(spec), 'utf8');
  if (bytes > MAX_CANDIDATE_SPEC_BYTES) problems.push(`: is ${bytes} bytes (at most ${MAX_CANDIDATE_SPEC_BYTES})`);
  for (const field of ENGINE_OWNED_SPEC_FIELDS) {
    if (field in spec) problems.push(`.${field}: is filled by the engine when the experiment's task is created; a candidate cannot specify it`);
  }
  if (problems.length > 0) return problems;
  const checked = validateTaskSpec({ ...spec, trigger: PROBE_TRIGGER }, 'draft');
  if (!checked.ok) for (const e of checked.errors) problems.push(`${e.path === '' ? '' : `.${e.path}`}: ${e.message}`);
  return problems;
}

/** 후보의 측정 신호가 알려진 정의와 맞는지 (정의 id 와 period). 문제 목록을 돌려준다 */
export function candidateSignalProblems(items: readonly ExperimentCandidate[], signals: readonly MeasurementSignal[]): string[] {
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  const problems: string[] = [];
  for (const item of items) {
    const signal = byId.get(item.measurement.signal_id);
    if (signal === undefined) problems.push(`candidate '${item.id}': measurement signal '${item.measurement.signal_id}' is not defined (known: ${[...byId.keys()].sort().join(', ') || 'none'})`);
    else if (signal.period !== item.measurement.period) problems.push(`candidate '${item.id}': period '${item.measurement.period}' differs from the signal's period '${signal.period}'`);
  }
  return problems;
}

/** 검사 `experiment_candidates` 의 판정 (순수). 정의 목록이 없으면 신호를 확인할 수 없어 'unknown' */
export function checkExperimentCandidates(result: string | null, signals: readonly MeasurementSignal[] | undefined): { status: 'pass' | 'fail' | 'unknown'; note: string } {
  const found = candidatesFromResult(result);
  if (!found.ok) return { status: 'fail', note: found.reason };
  if (signals === undefined || signals.length === 0) {
    return { status: 'unknown', note: `${found.items.length} candidate(s) are well-formed, but no measurement signal definition is configured to check their signals against` };
  }
  const problems = candidateSignalProblems(found.items, signals);
  if (problems.length > 0) return { status: 'fail', note: summarize('candidate signal(s) do not match a defined measurement signal', problems) };
  return { status: 'pass', note: `${found.items.length} candidate(s) are well-formed and measure defined signals` };
}
