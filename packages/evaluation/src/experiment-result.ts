// 실험 결과 기록 (A6-U16, 주간 사이클 7단계): 결과 검토 업무의 평가가 `pass` 또는 `fail` 로 정해졌을 때 실제 결과를 비용과 함께 기억(`memory_item`)에 남긴다.
//
//   · `measurement`  : 실험 주의 측정 값·관측 수·기준선·합격선·효과(= 값 − 기준선). 값은 사람이 입력한 측정 이벤트(원본)에서 읽는다(에이전트 보고서가 아니다).
//                      `source_ref` = 그 업무에 붙은 측정 근거(`evidence:<id>`, internal). 효과를 측정했으면(평가의 effect 가 있으면) verified, 아니면 unverified.
//                      근거가 `external_untrusted` 면 규칙 9·3 에 따라 `hypothesis`/`unverified` 로만 쓴다.
//   · `strategy_record`: 전략 id·결론(pass/fail)·평가 id·실험 총비용(아래)·판정 근거 요약. `source_ref` = `evaluation:<id>`. 시스템이 계산한 값만 담는다 —
//                      기획·검토 에이전트의 문장(가설, 보고서)은 넣지 않는다(다음 주 입력으로 읽혀도 지시가 될 수 없다). verified, internal.
//   · `inconclusive` 평가는 `lesson`/`strategy_record` 를 만들지 않는다 (규칙 8, `inconclusive_not_learnable`): 아무것도 쓰지 않고 거부한다. 사람이 검토한다.
//
// 실험 총비용 = `task.strategy_version_id` 가 그 전략인 업무들(실험 업무와 결과 검토 업무)의 `cost_entry` 합계(`summarizeCosts`: tool·llm·human_time 등 모든 범주, 사람 시간 분 포함)
//   + 업무에 붙지 못한 측정 입력의 사람 시간(`task_id` 없음, `units.measurement` = 그 측정 키). 같은 줄을 두 번 세지 않는다.
//
// 멱등: 전략당 한 번(event `experiment-result:<전략 id>`). 이미 있으면 아무것도 쓰지 않고 처음 기록을 돌려준다. 기억 항목과 event 는 호출자의 같은 쓰기 트랜잭션에 묶인다.
// 만료: `memory.default_validity`(정책 파라미터, 비어 있으면 만료 없음 — Q17 은 열려 있다)를 `defaultValiditySeconds` 로 받는다. 시각은 주입된 Clock.
import {
  canonicalJson, createMemoryItem, EVALUATION_SOURCE_PREFIX, EVIDENCE_SOURCE_PREFIX, experimentEventId, experimentResultKey, EXPERIMENT_RESULT_EVENT,
  findExperimentResult, findExperimentReview, MemoryRuleError,
  type Clock, type CostEntryRow, type Db, type EvaluationRow, type ExperimentResult, type MemoryKind, type NewMemoryItem, type PlainObject, type TransitionActor,
} from '@aot/domain';

import { summarizeCosts, type CostSummary } from './cost.ts';

export type ExperimentResultErrorCode = 'agent_forbidden' | 'no_review' | 'unknown_evaluation' | 'not_review_evaluation' | 'no_measurement' | 'recorder_not_human';

export class ExperimentResultError extends Error {
  readonly code: ExperimentResultErrorCode;
  constructor(code: ExperimentResultErrorCode, message: string) {
    super(message);
    this.name = 'ExperimentResultError';
    this.code = code;
  }
}

export interface RecordExperimentResultInput {
  strategyVersionId: string;
  /** 결과 검토 업무의 평가 (pass 또는 fail 이어야 한다) */
  evaluationId: string;
  /** 기록하는 주체 (사이클 = 'evaluator'). 에이전트면 거부 */
  by: TransitionActor;
  defaultValiditySeconds?: (kind: MemoryKind) => number | null;
  newId?: () => string;
}

export interface RecordedExperimentResult {
  /** false 면 이미 기록되어 있어 아무것도 쓰지 않았다 */
  created: boolean;
  result: ExperimentResult;
}

export interface ExperimentCost {
  total_usd: number;
  human_minutes: number;
  tokens: number;
  by_category: CostSummary['byCategory'];
  entries: number;
  task_ids: string[];
}

/** 전략의 실험 총비용 (읽기 전용). 결과 기록이 원장 합계와 같음을 시험이 이 함수와 원장 직접 합계로 대조한다 */
export function experimentCost(db: Db, strategyVersionId: string, measurementKey: string | null): ExperimentCost {
  const taskIds = db.all<{ id: string }>('SELECT id FROM task WHERE strategy_version_id = ? ORDER BY created_at, rowid', [strategyVersionId]).map((row) => row.id);
  const rows = db.all<CostEntryRow>(
    `SELECT category, amount_usd, units FROM cost_entry
     WHERE task_id IN (SELECT id FROM task WHERE strategy_version_id = ?)
        OR (? IS NOT NULL AND task_id IS NULL AND json_extract(units, '$.measurement') = ?)
     ORDER BY at, id`,
    [strategyVersionId, measurementKey, measurementKey],
  );
  const summary = summarizeCosts(rows);
  return { total_usd: summary.totalUsd, human_minutes: summary.humanMinutes, tokens: summary.tokens, by_category: summary.byCategory, entries: summary.entries, task_ids: taskIds };
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * 결과를 기록한다. Db.writeTx 안에서 부른다. 전략 상태는 바꾸지 않는다(fail 이면 시스템 거절, pass 면 사람 승격 — 호출자/CLI 의 몫).
 * @throws MemoryRuleError `inconclusive_not_learnable` — 평가가 inconclusive 일 때(아무것도 쓰지 않는다)
 */
export function recordExperimentResult(tx: Db, clock: Clock, input: RecordExperimentResultInput): RecordedExperimentResult {
  if (input.by === 'agent') throw new ExperimentResultError('agent_forbidden', 'agents cannot record an experiment result; they only submit results');
  const id = input.strategyVersionId;
  const earlier = findExperimentResult(tx, id);
  if (earlier) return { created: false, result: earlier };

  const review = findExperimentReview(tx, id);
  if (review === null) throw new ExperimentResultError('no_review', `strategy_version '${id}' has no result review record`);
  const evaluation = tx.get<EvaluationRow>('SELECT * FROM evaluation WHERE id = ?', [input.evaluationId]);
  if (!evaluation) throw new ExperimentResultError('unknown_evaluation', `evaluation '${input.evaluationId}' does not exist`);
  if (evaluation.task_id !== review.reviewTaskId) throw new ExperimentResultError('not_review_evaluation', `evaluation '${evaluation.id}' is not an evaluation of the review task '${review.reviewTaskId}'`);
  if (evaluation.outcome === 'inconclusive') {
    throw new MemoryRuleError('inconclusive_not_learnable', `evaluation '${evaluation.id}' is inconclusive; no measurement or strategy_record is stored (a person reviews it)`);
  }
  const conclusion: 'pass' | 'fail' = evaluation.outcome === 'pass' ? 'pass' : 'fail';

  // 측정 값의 원본: 사람이 입력한 측정 이벤트
  const measurementKey = `measurement:${review.signalId}@${review.experimentWeek}`;
  const event = tx.get<{ id: string; payload: string }>(
    "SELECT id, payload FROM event WHERE idempotency_key = ? AND source = 'measurement' AND type = 'measurement.recorded'", [measurementKey],
  );
  if (!event) throw new ExperimentResultError('no_measurement', `no measurement is recorded for ${measurementKey}`);
  const measured = JSON.parse(event.payload) as PlainObject;
  const recorder = typeof measured['recorded_by'] === 'string' ? measured['recorded_by'] : '';
  const recorderRow = tx.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [recorder]);
  if (!recorderRow || recorderRow.kind !== 'human') {
    throw new ExperimentResultError('recorder_not_human', `the measurement ${measurementKey} was not recorded by a human actor ('${recorder}')`);
  }
  const value = finite(measured['value']);
  const observations = finite(measured['observations']);
  const baseline = review.baseline;
  const measuredEffect = evaluation.effect !== null;

  const task = tx.get<{ product_id: string | null }>('SELECT product_id FROM task WHERE id = ?', [review.reviewTaskId]);
  const evidence = tx.get<{ id: string; trust_origin: string }>(
    "SELECT id, trust_origin FROM evidence WHERE task_id = ? AND kind = 'measurement' AND ref = ? ORDER BY captured_at, id LIMIT 1", [review.reviewTaskId, measurementKey],
  );
  const cost = experimentCost(tx, id, measurementKey);

  const memoryContext = {
    clock,
    ...(input.newId === undefined ? {} : { newId: input.newId }),
    ...(input.defaultValiditySeconds === undefined ? {} : { defaultValiditySeconds: input.defaultValiditySeconds }),
  };
  const common = {
    observed_at: review.period.end,
    product_id: task?.product_id ?? null,
    strategy_version_id: id,
    created_by: recorder,
  };

  const measurementBody = canonicalJson({
    kind: 'experiment_measurement',
    strategy_version_id: id,
    signal_id: review.signalId,
    week: review.experimentWeek,
    period: review.period,
    value,
    observations,
    data_quality: measured['data_quality'] ?? null,
    baseline: baseline,
    pass_at_least: review.passAtLeast,
    effect: value !== null && baseline !== null ? { lift_over_baseline: Math.round((value - baseline.value) * 1e6) / 1e6, met_pass_line: review.passAtLeast === null ? null : value >= review.passAtLeast } : null,
    measured_by: recorder,
  });
  // 규칙 9·3: 근거가 외부 입력 유래면 hypothesis/unverified 로만. 근거 행이 없으면(측정 이벤트만) 이벤트를 출처로 삼는다.
  const external = evidence?.trust_origin === 'external_untrusted';
  const measurementItem: NewMemoryItem = {
    ...common,
    kind: external ? 'hypothesis' : 'measurement',
    body: measurementBody,
    source_ref: evidence === undefined ? `event:${event.id}` : `${EVIDENCE_SOURCE_PREFIX}${evidence.id}`,
    verification_status: external || !measuredEffect ? 'unverified' : 'verified',
    ...(external ? { trust_origin: 'external_untrusted' as const } : {}),
  };
  const measurementMemory = createMemoryItem(tx, measurementItem, memoryContext);

  const recordBody = canonicalJson({
    kind: 'experiment_record',
    strategy_version_id: id,
    conclusion,
    evaluation_id: evaluation.id,
    evaluator: evaluation.evaluator,
    safety: evaluation.safety,
    review_task_id: review.reviewTaskId,
    signal_id: review.signalId,
    week: review.experimentWeek,
    measured_value: value,
    baseline_value: baseline === null ? null : baseline.value,
    pass_at_least: review.passAtLeast,
    cost,
    measurement_memory_id: measurementMemory.id,
  });
  const recordMemory = createMemoryItem(tx, {
    ...common,
    kind: 'strategy_record',
    body: recordBody,
    source_ref: `${EVALUATION_SOURCE_PREFIX}${evaluation.id}`,
    verification_status: 'verified',
  }, memoryContext);

  const key = experimentResultKey(id);
  const eventId = experimentEventId(key);
  const now = clock.nowIso();
  const payload: PlainObject = {
    strategy_version_id: id, review_task_id: review.reviewTaskId, evaluation_id: evaluation.id, conclusion,
    measurement_memory_id: measurementMemory.id, strategy_record_memory_id: recordMemory.id,
    total_cost_usd: cost.total_usd, human_minutes: cost.human_minutes, recorded_by: input.by,
  };
  tx.run(
    `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [eventId, EXPERIMENT_RESULT_EVENT.source, id, EXPERIMENT_RESULT_EVENT.type, JSON.stringify(payload), key, now, now],
  );
  return { created: true, result: findExperimentResult(tx, id)! };
}

/** 검토 업무의 평가 중 결과를 정하는 것: 가장 최근 평가가 pass 거나, fail 이고 업무가 더 시도하지 않는 상태(needs_review/failed/cancelled)일 때 */
export function decisiveReviewEvaluation(db: Db, reviewTaskId: string): EvaluationRow | null {
  const latest = db.get<EvaluationRow>('SELECT * FROM evaluation WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', [reviewTaskId]);
  if (!latest) return null;
  if (latest.outcome === 'pass') return latest;
  if (latest.outcome !== 'fail') return null;
  const task = db.get<{ status: string }>('SELECT status FROM task WHERE id = ?', [reviewTaskId]);
  return task !== undefined && ['needs_review', 'failed', 'cancelled'].includes(task.status) ? latest : null;
}

