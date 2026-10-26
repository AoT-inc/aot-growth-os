// 실험 전략 제안 (A6-U14, 주간 사이클 5단계 → 6단계의 입력). `strategy_version` 행과 그 근거가 되는 후보 비교 기록(event)을 쓴다.
//
// 1. 비교 기록 (`recordStrategyComparison`): 완료된 기획 업무 하나에 한 번. `event`(source `experiment-cycle`, type `experiment.compared`,
//    `external_id` = 기획 업무 id, 멱등 키 `experiment-comparison:<기획 업무 id>`, payload = 비교기의 기록)에 남긴다. 같은 키는 다시 쓰지 않는다.
//    payload 의 `review_required` 가 참이면(추천 없음: inconclusive 또는 후보가 모두 제외) 사람이 검토할 목록(`listStrategyReviews`)에 보인다.
// 2. 제안 (`proposeStrategyVersion`): 비교 기록이 *추천한* 후보로만 `status='proposed'` 행을 만든다. id 는 (기획 업무 id, 후보 id)에서 결정적으로 정하므로
//    같은 쌍은 몇 번 불러도 한 행이다(멱등). 이미 있으면 아무것도 바꾸지 않는다.
//    생성은 허용표의 전이가 아니다(STRATEGY_MACHINE 에 `(none) → proposed` 행은 없고 더하지 않았다): `proposed` 는 시작 상태이고, 기록하는 주체는
//    시스템(비교 단계)이며 에이전트가 아니다. `created_by` 는 후보를 낸 기획 run 의 행위자(제안자)다.
// 3. 전이 (`transitionStrategyVersion`): STRATEGY_MACHINE 허용표(`checkTransition`)를 따른다. 에이전트는 어떤 전이도 일으킬 수 없다.
//    `human` 주체면 행위자가 실제로 `actor.kind='human'` 이어야 하고, 승인이 필요한 전이는 이 행을 가리키는 `approved` 승인 기록이 있어야 한다.
//    `experiment` 로 가려면 `experiment_scope` 가 있어야 한다. 승인 절차(해시 확인, 사람 1인)는 policy 승인 엔진이, 루틴 활성화는 task-engine 이 한다(A6-U15, 아래 기록 키).
// 시각은 주입된 Clock 에서만 얻고, 쓰기 함수는 Db.writeTx 안에서만 동작한다.
import { canonicalJson, sha256Hex } from './canonical.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db/types.ts';
import type { StrategyStatus } from './entities/enums.ts';
import type { StrategyVersionRow } from './entities/rows.ts';
import { assertTransition, type TransitionActor } from './state/machine.ts';
import { STRATEGY_MACHINE } from './state/machines.ts';
import { isNonBlankString, isPlainObject, type PlainObject } from './validation.ts';

export const STRATEGY_COMPARISON_EVENT = { source: 'experiment-cycle', type: 'experiment.compared' } as const;
export const STRATEGY_COMPARISON_KEY_PREFIX = 'experiment-comparison:';
export const MAX_STRATEGY_TITLE_CHARS = 200;
export const MAX_STRATEGY_BODY_CHARS = 2000;

export type StrategyRuleCode =
  | 'agent_forbidden'
  | 'invalid_field'
  | 'unknown_actor'
  | 'not_human'
  | 'unknown_task'
  | 'no_comparison'
  | 'not_recommended'
  | 'not_found'
  | 'stale_state'
  | 'approval_missing'
  | 'experiment_scope_required'
  | 'reason_required'
  | 'no_result'
  | 'not_passed';

export class StrategyRuleError extends Error {
  readonly code: StrategyRuleCode;
  constructor(code: StrategyRuleCode, message: string) {
    super(message);
    this.name = 'StrategyRuleError';
    this.code = code;
  }
}

export const comparisonEventKey = (planningTaskId: string): string => `${STRATEGY_COMPARISON_KEY_PREFIX}${planningTaskId}`;

/** (기획 업무 id, 후보 id) → 제안 id. 같은 쌍이면 같은 id 다 (멱등 키) */
export const strategyProposalId = (planningTaskId: string, candidateId: string): string =>
  `strategy-${sha256Hex(canonicalJson({ planning_task: planningTaskId, candidate: candidateId })).slice(0, 32)}`;

/** 쓰는 주체가 에이전트면 거부한다 (에이전트는 결과만 제출한다) */
function refuseAgent(by: TransitionActor, what: string): void {
  if (by === 'agent') throw new StrategyRuleError('agent_forbidden', `agents cannot ${what}; they only submit results`);
}

export interface StrategyComparisonInput {
  planningTaskId: string;
  /** 비교기의 기록. `outcome`·`review_required`·`recommended` 가 있어야 한다 */
  record: PlainObject;
  /** 기록하는 주체 (비교 단계 = 'evaluator' 또는 'system') */
  by: TransitionActor;
}

export interface StrategyComparisonResult {
  created: boolean;
  eventId: string;
}

/** 기획 업무 하나의 비교 기록을 남긴다(멱등). Db.writeTx 안에서 부른다 */
export function recordStrategyComparison(tx: Db, clock: Clock, input: StrategyComparisonInput): StrategyComparisonResult {
  refuseAgent(input.by, 'record an experiment comparison');
  const { record } = input;
  if (!isNonBlankString(record['outcome']) || typeof record['review_required'] !== 'boolean' || !(record['recommended'] === null || isNonBlankString(record['recommended']))) {
    throw new StrategyRuleError('invalid_field', 'a comparison record needs outcome, review_required and recommended');
  }
  const task = tx.get<{ product_id: string | null }>('SELECT product_id FROM task WHERE id = ?', [input.planningTaskId]);
  if (!task) throw new StrategyRuleError('unknown_task', `planning task '${input.planningTaskId}' does not exist`);
  const key = comparisonEventKey(input.planningTaskId);
  const existing = tx.get<{ id: string }>('SELECT id FROM event WHERE idempotency_key = ?', [key]);
  if (existing) return { created: false, eventId: existing.id };
  const eventId = `event-${sha256Hex(key).slice(0, 32)}`;
  const now = clock.nowIso();
  tx.run(
    `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [eventId, STRATEGY_COMPARISON_EVENT.source, input.planningTaskId, STRATEGY_COMPARISON_EVENT.type, JSON.stringify(record), task.product_id, key, now, now],
  );
  return { created: true, eventId };
}

/** 저장된 비교 기록 (없으면 null) */
export function findStrategyComparison(db: Db, planningTaskId: string): { eventId: string; record: PlainObject; recordedAt: string } | null {
  const row = db.get<{ id: string; payload: string; received_at: string }>(
    'SELECT id, payload, received_at FROM event WHERE idempotency_key = ? AND source = ? AND type = ?',
    [comparisonEventKey(planningTaskId), STRATEGY_COMPARISON_EVENT.source, STRATEGY_COMPARISON_EVENT.type],
  );
  if (!row) return null;
  const record = JSON.parse(row.payload) as unknown;
  return isPlainObject(record) ? { eventId: row.id, record, recordedAt: row.received_at } : null;
}

export interface StrategyReview {
  planningTaskId: string;
  eventId: string;
  outcome: string;
  reasons: string[];
  recordedAt: string;
}

/** 사람이 검토할 비교 기록 (추천 없이 끝난 것: inconclusive, 후보 모두 제외). 오래된 것부터 */
export function listStrategyReviews(db: Db): StrategyReview[] {
  const rows = db.all<{ id: string; external_id: string; payload: string; received_at: string }>(
    `SELECT id, external_id, payload, received_at FROM event WHERE source = ? AND type = ? AND json_extract(payload, '$.review_required') = 1
     ORDER BY received_at, rowid`,
    [STRATEGY_COMPARISON_EVENT.source, STRATEGY_COMPARISON_EVENT.type],
  );
  return rows.map((row) => {
    const record = JSON.parse(row.payload) as { outcome?: unknown; reasons?: unknown };
    return {
      planningTaskId: row.external_id, eventId: row.id, outcome: String(record.outcome),
      reasons: Array.isArray(record.reasons) ? record.reasons.map(String) : [], recordedAt: row.received_at,
    };
  });
}

export interface StrategyProposalInput {
  planningTaskId: string;
  candidateId: string;
  title: string;
  /** 가설 등 제안 본문 (기획 에이전트가 낸 문장이면 신뢰할 수 없는 데이터다) */
  body: string;
  /** 근거 참조 (task/evaluation/event id 등) */
  rationaleRefs: readonly string[];
  /** 실험 범위·기간 (마케팅 업무 명세, 측정 신호, 주, 비교 기록 요약) */
  experimentScope: PlainObject;
  /** 후보를 낸 행위자 (`created_by`, 기획 run 의 actor) */
  proposedBy: string;
  /** 기록하는 주체 */
  by: TransitionActor;
}

export interface StrategyProposalResult {
  created: boolean;
  strategyVersionId: string;
}

/** 비교 기록이 추천한 후보로 `proposed` 행을 만든다(멱등). Db.writeTx 안에서 부른다 */
export function proposeStrategyVersion(tx: Db, clock: Clock, input: StrategyProposalInput): StrategyProposalResult {
  refuseAgent(input.by, 'propose a strategy version');
  const id = strategyProposalId(input.planningTaskId, input.candidateId);
  if (tx.get('SELECT 1 AS one FROM strategy_version WHERE id = ?', [id])) return { created: false, strategyVersionId: id };

  if (!isNonBlankString(input.title) || input.title.length > MAX_STRATEGY_TITLE_CHARS) throw new StrategyRuleError('invalid_field', `title must be 1..${MAX_STRATEGY_TITLE_CHARS} characters`);
  if (!isNonBlankString(input.body) || input.body.length > MAX_STRATEGY_BODY_CHARS) throw new StrategyRuleError('invalid_field', `body must be 1..${MAX_STRATEGY_BODY_CHARS} characters`);
  if (input.rationaleRefs.length === 0 || !input.rationaleRefs.every(isNonBlankString)) throw new StrategyRuleError('invalid_field', 'rationale_refs must be a non-empty list of references');
  if (!isPlainObject(input.experimentScope)) throw new StrategyRuleError('invalid_field', 'experiment_scope must be an object');
  if (!tx.get('SELECT 1 AS one FROM actor WHERE id = ?', [input.proposedBy])) throw new StrategyRuleError('unknown_actor', `actor '${input.proposedBy}' does not exist`);

  // 비교 기록이 이 후보를 추천했어야 한다 (비교 없이, 또는 추천되지 않은 후보로 제안을 만들 수 없다)
  const comparison = findStrategyComparison(tx, input.planningTaskId);
  if (comparison === null) throw new StrategyRuleError('no_comparison', `planning task '${input.planningTaskId}' has no comparison record`);
  if (comparison.record['outcome'] !== 'recommended' || comparison.record['recommended'] !== input.candidateId) {
    throw new StrategyRuleError('not_recommended', `the comparison of planning task '${input.planningTaskId}' does not recommend candidate '${input.candidateId}'`);
  }
  tx.run(
    `INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at)
     VALUES (?, NULL, ?, ?, ?, 'proposed', ?, ?, ?)`,
    [id, input.title, input.body, JSON.stringify([...input.rationaleRefs]), JSON.stringify(input.experimentScope), input.proposedBy, clock.nowIso()],
  );
  return { created: true, strategyVersionId: id };
}

export interface StrategyTransitionRequest {
  strategyVersionId: string;
  from: StrategyStatus;
  to: StrategyStatus;
  by: TransitionActor;
  /** `by='human'` 이면 필수: 그 사람의 actor id */
  actorId?: string;
  approvalId?: string | null;
  reason?: string | null;
}

/** 허용표를 따르는 전이. Db.writeTx 안에서 부른다. 상태가 이미 바뀌었으면 stale_state */
export function transitionStrategyVersion(tx: Db, request: StrategyTransitionRequest): StrategyVersionRow {
  const rule = assertTransition(STRATEGY_MACHINE, {
    from: request.from, to: request.to, by: request.by,
    ...(request.approvalId === undefined ? {} : { approvalId: request.approvalId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  });
  if (request.by === 'human') {
    const actor = request.actorId === undefined ? undefined : tx.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [request.actorId]);
    if (actor === undefined) throw new StrategyRuleError('unknown_actor', `a human transition needs the person's actor id (got '${request.actorId ?? ''}')`);
    if (actor.kind !== 'human') throw new StrategyRuleError('not_human', `actor '${request.actorId!}' is '${actor.kind}', not a human`);
  }
  const row = tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [request.strategyVersionId]);
  if (!row) throw new StrategyRuleError('not_found', `strategy_version '${request.strategyVersionId}' does not exist`);
  if (row.status !== request.from) throw new StrategyRuleError('stale_state', `strategy_version '${row.id}' is '${row.status}', not '${request.from}'`);
  if ((rule.requires ?? []).includes('approval')) {
    const approval = tx.get(
      `SELECT 1 AS one FROM approval a JOIN actor p ON p.id = a.decided_by
       WHERE a.id = ? AND a.subject_kind = 'strategy_version' AND a.subject_id = ? AND a.decision = 'approved' AND p.kind = 'human'`,
      [request.approvalId!, row.id],
    );
    if (!approval) throw new StrategyRuleError('approval_missing', `approval '${request.approvalId!}' is not a human approval of strategy_version '${row.id}'`);
  }
  if (request.to === 'experiment' && (row.experiment_scope === null || row.experiment_scope === '')) {
    throw new StrategyRuleError('experiment_scope_required', `strategy_version '${row.id}' has no experiment_scope (range and period limits are required for an experiment)`);
  }
  const changed = tx.run('UPDATE strategy_version SET status = ? WHERE id = ? AND status = ?', [request.to, row.id, request.from]);
  if (changed.changes !== 1) throw new StrategyRuleError('stale_state', `strategy_version '${row.id}' changed concurrently`);
  return tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [row.id])!;
}

// ===== 실험 활성화·종료 기록 (A6-U15) =====
// 승인(policy)은 같은 트랜잭션에서 `proposed → experiment` 까지만 한다. 루틴을 켜고 일회성 업무를 만드는 활성화는 승인 트랜잭션 밖에서
// task-engine 의 `activateExperiment` 가 한 번만 한다: 그 기록이 `event`(멱등 키 `experiment-activate:<전략 id>`)이고, `occurred_at` 이 활성화 시각이다
// (routine 행에 켠 시각 열이 없으므로 새 열 대신 이 event 가 루틴 발화의 기준점이 된다). 종료는 `experiment-end:<전략 id>` event 다.
// 키와 조회는 policy(취소·목록)와 task-engine(활성화·발화) 모두가 읽으므로 여기에 둔다.

export const EXPERIMENT_ACTIVATION_EVENT = { source: 'experiment-cycle', type: 'experiment.activated' } as const;
export const EXPERIMENT_END_EVENT = { source: 'experiment-cycle', type: 'experiment.ended' } as const;
export const EXPERIMENT_ACTIVATION_KEY_PREFIX = 'experiment-activate:';
export const EXPERIMENT_END_KEY_PREFIX = 'experiment-end:';

export const experimentActivationKey = (strategyVersionId: string): string => `${EXPERIMENT_ACTIVATION_KEY_PREFIX}${strategyVersionId}`;
export const experimentEndKey = (strategyVersionId: string): string => `${EXPERIMENT_END_KEY_PREFIX}${strategyVersionId}`;

export interface ExperimentActivation {
  eventId: string;
  strategyVersionId: string;
  /** 활성화 시각 (event.occurred_at) — 켠 루틴의 발화 기준점 */
  activatedAt: string;
  approvalId: string | null;
  routineIds: string[];
  taskIds: string[];
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function activationOf(row: { id: string; external_id: string; payload: string; occurred_at: string }): ExperimentActivation {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    eventId: row.id, strategyVersionId: row.external_id, activatedAt: row.occurred_at,
    approvalId: typeof payload['approval_id'] === 'string' ? payload['approval_id'] : null,
    routineIds: stringList(payload['routine_ids']), taskIds: stringList(payload['task_ids']),
  };
}

/** 전략의 활성화 기록 (없으면 null) */
export function findExperimentActivation(db: Db, strategyVersionId: string): ExperimentActivation | null {
  const row = db.get<{ id: string; external_id: string; payload: string; occurred_at: string }>(
    'SELECT id, external_id, payload, occurred_at FROM event WHERE idempotency_key = ? AND source = ? AND type = ?',
    [experimentActivationKey(strategyVersionId), EXPERIMENT_ACTIVATION_EVENT.source, EXPERIMENT_ACTIVATION_EVENT.type],
  );
  return row ? activationOf(row) : null;
}

/** 루틴을 켠 가장 최근 활성화 기록 (없으면 null). 루틴 발화의 기준점과 업무의 전략 연결에 쓴다 */
export function latestRoutineActivation(db: Db, routineId: string): ExperimentActivation | null {
  const row = db.get<{ id: string; external_id: string; payload: string; occurred_at: string }>(
    `SELECT e.id, e.external_id, e.payload, e.occurred_at FROM event e
     WHERE e.source = ? AND e.type = ? AND EXISTS (SELECT 1 FROM json_each(e.payload, '$.routine_ids') r WHERE r.value = ?)
     ORDER BY e.occurred_at DESC, e.rowid DESC LIMIT 1`,
    [EXPERIMENT_ACTIVATION_EVENT.source, EXPERIMENT_ACTIVATION_EVENT.type, routineId],
  );
  return row ? activationOf(row) : null;
}

/** 전략의 종료 기록이 있는가 */
export const experimentEnded = (db: Db, strategyVersionId: string): boolean =>
  db.get('SELECT 1 AS one FROM event WHERE idempotency_key = ?', [experimentEndKey(strategyVersionId)]) !== undefined;

/** 그 전략의 가장 최근 승인 기록 결정 (`approved` 가 아니면 취소·거절된 것) */
const LATEST_DECISION_SQL = `(SELECT a.decision FROM approval a WHERE a.subject_kind = 'strategy_version' AND a.subject_id = s.id ORDER BY a.at DESC, a.rowid DESC LIMIT 1)`;

/**
 * 진행 중인 실험: `experiment` 상태이고 승인이 취소되지 않은 전략 (활성화 전후 모두, 종료 기록이 있어도 상태가 바뀌기 전까지는 진행 중이다).
 * 활성화 전에 승인이 취소된 전략은 실험이 시작되지 않았으므로 세지 않는다. 한 번에 실험 하나만 승인한다(두 번째 승인 거부)는 규칙이 이것을 본다.
 */
export function experimentsInProgress(db: Db): string[] {
  return db.all<{ id: string }>(
    `SELECT s.id FROM strategy_version s WHERE s.status = 'experiment' AND ${LATEST_DECISION_SQL} = 'approved' ORDER BY s.created_at, s.rowid`,
  ).map((row) => row.id);
}

/** 승인되어 `experiment` 이지만 아직 활성화 기록이 없는 전략 (승인이 취소된 것은 뺀다). 오래된 것부터 */
export function pendingExperimentActivations(db: Db, limit = 20): string[] {
  return db.all<{ id: string }>(
    `SELECT s.id FROM strategy_version s
     WHERE s.status = 'experiment' AND ${LATEST_DECISION_SQL} = 'approved'
       AND NOT EXISTS (SELECT 1 FROM event e WHERE e.idempotency_key = ? || s.id)
     ORDER BY s.created_at, s.rowid LIMIT ?`,
    [EXPERIMENT_ACTIVATION_KEY_PREFIX, limit],
  ).map((row) => row.id);
}


// ===== 실험 결과 검토·결정 기록 (A6-U16, 주간 사이클 7단계) =====
// 실험 1주가 지난 뒤 사이클이 결과 검토 업무를 만들고(event `experiment-review:<전략 id>`), 그 업무의 평가가 pass 또는 fail 로 정해지면 결과를 기록하며
// (event `experiment-result:<전략 id>`, 기억 항목은 평가 패키지의 `recordExperimentResult`), 전략 상태는 사람의 결정(승격·거절) 또는 fail 일 때의 시스템 거절로 바뀐다
// (event `experiment-decision:<전략 id>`). 키와 조회는 evaluation(합격선 읽기)·apps(사이클, 승인 CLI)가 모두 읽으므로 여기에 둔다.
//
// rejectExperiment: `experiment → rejected` (허용표, 사유 필수). 사람 또는 시스템(평가 fail)이 부르고 에이전트는 거부된다.
// promoteExperiment: `experiment → active` 승격은 사람만, 기록된 결과가 pass(평가 pass AND safety pass)일 때만. 이전 `active` 는 같은 트랜잭션에서 `retired` 로 둔다(롤백 지점).
// 둘 다 Db.writeTx 안에서만 부른다(루틴 끄기·종료 기록은 task-engine 의 endExperimentInTx 와 같은 트랜잭션에서 apps 가 묶는다).

export const EXPERIMENT_REVIEW_EVENT = { source: 'experiment-cycle', type: 'experiment.review_created' } as const;
export const EXPERIMENT_RESULT_EVENT = { source: 'experiment-cycle', type: 'experiment.result_recorded' } as const;
export const EXPERIMENT_DECISION_EVENT = { source: 'experiment-cycle', type: 'experiment.decided' } as const;
export const EXPERIMENT_REVIEW_KEY_PREFIX = 'experiment-review:';
export const EXPERIMENT_RESULT_KEY_PREFIX = 'experiment-result:';
export const EXPERIMENT_DECISION_KEY_PREFIX = 'experiment-decision:';

export const experimentReviewKey = (strategyVersionId: string): string => `${EXPERIMENT_REVIEW_KEY_PREFIX}${strategyVersionId}`;
export const experimentResultKey = (strategyVersionId: string): string => `${EXPERIMENT_RESULT_KEY_PREFIX}${strategyVersionId}`;
export const experimentDecisionKey = (strategyVersionId: string): string => `${EXPERIMENT_DECISION_KEY_PREFIX}${strategyVersionId}`;
/** 결정적 event id (같은 키는 같은 id) */
export const experimentEventId = (key: string): string => `event-${sha256Hex(key).slice(0, 32)}`;

export interface ExperimentReview {
  eventId: string;
  strategyVersionId: string;
  reviewTaskId: string;
  /** 판정 대상 주 (`YYYY-Www`, 측정 신호의 tz) */
  experimentWeek: string;
  signalId: string;
  period: { start: string; end: string; tz: string };
  activatedAt: string;
  /** 비교 기록의 기준선 (없으면 null) */
  baseline: { week: string; value: number } | null;
  /** 이 실험의 합격선 (비교 기록이 기준선 대비로 정함, 없으면 null) */
  passAtLeast: number | null;
  planningTaskId: string | null;
  createdAt: string;
}

export interface RecordExperimentReviewInput {
  strategyVersionId: string;
  reviewTaskId: string;
  experimentWeek: string;
  signalId: string;
  period: { start: string; end: string; tz: string };
  activatedAt: string;
  baseline: { week: string; value: number } | null;
  passAtLeast: number | null;
  planningTaskId: string | null;
  by: TransitionActor;
}

/** 결과 검토 업무를 만들었다는 기록 (멱등). 합격선·기준선을 이 시점의 값으로 고정해 둔다. Db.writeTx 안에서 부른다 */
export function recordExperimentReview(tx: Db, clock: Clock, input: RecordExperimentReviewInput): { created: boolean; eventId: string } {
  refuseAgent(input.by, 'record an experiment review');
  const key = experimentReviewKey(input.strategyVersionId);
  const eventId = experimentEventId(key);
  if (tx.get('SELECT 1 AS one FROM event WHERE idempotency_key = ?', [key])) return { created: false, eventId };
  const now = clock.nowIso();
  tx.run(
    `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      eventId, EXPERIMENT_REVIEW_EVENT.source, input.strategyVersionId, EXPERIMENT_REVIEW_EVENT.type,
      JSON.stringify({
        strategy_version_id: input.strategyVersionId, review_task_id: input.reviewTaskId, experiment_week: input.experimentWeek, signal_id: input.signalId,
        period: input.period, activated_at: input.activatedAt, baseline: input.baseline, pass_at_least: input.passAtLeast, planning_task_id: input.planningTaskId,
      }),
      key, now, now,
    ],
  );
  return { created: true, eventId };
}

function reviewOf(row: { id: string; payload: string; received_at: string }): ExperimentReview | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (!isPlainObject(payload) || !isNonBlankString(payload['strategy_version_id']) || !isNonBlankString(payload['review_task_id'])
    || !isNonBlankString(payload['experiment_week']) || !isNonBlankString(payload['signal_id']) || !isPlainObject(payload['period'])) return null;
  const period = payload['period'];
  const baseline = payload['baseline'];
  return {
    eventId: row.id,
    strategyVersionId: payload['strategy_version_id'],
    reviewTaskId: payload['review_task_id'],
    experimentWeek: payload['experiment_week'],
    signalId: payload['signal_id'],
    period: { start: String(period['start']), end: String(period['end']), tz: String(period['tz']) },
    activatedAt: String(payload['activated_at']),
    baseline: isPlainObject(baseline) && typeof baseline['value'] === 'number' ? { week: String(baseline['week']), value: baseline['value'] } : null,
    passAtLeast: typeof payload['pass_at_least'] === 'number' && Number.isFinite(payload['pass_at_least']) ? payload['pass_at_least'] : null,
    planningTaskId: typeof payload['planning_task_id'] === 'string' ? payload['planning_task_id'] : null,
    createdAt: row.received_at,
  };
}

/** 전략의 결과 검토 기록 (없으면 null) */
export function findExperimentReview(db: Db, strategyVersionId: string): ExperimentReview | null {
  const row = db.get<{ id: string; payload: string; received_at: string }>(
    'SELECT id, payload, received_at FROM event WHERE idempotency_key = ? AND source = ? AND type = ?',
    [experimentReviewKey(strategyVersionId), EXPERIMENT_REVIEW_EVENT.source, EXPERIMENT_REVIEW_EVENT.type],
  );
  return row ? reviewOf(row) : null;
}

/** 결과 검토 업무가 가리키는 검토 기록 (그 업무가 결과 검토 업무가 아니면 null). 평가기의 합격선 조회가 쓴다 */
export function findExperimentReviewByTask(db: Db, taskId: string): ExperimentReview | null {
  const row = db.get<{ id: string; payload: string; received_at: string }>(
    'SELECT id, payload, received_at FROM event WHERE source = ? AND type = ? AND json_extract(payload, \'$.review_task_id\') = ?',
    [EXPERIMENT_REVIEW_EVENT.source, EXPERIMENT_REVIEW_EVENT.type, taskId],
  );
  return row ? reviewOf(row) : null;
}

export interface ExperimentResult {
  eventId: string;
  strategyVersionId: string;
  reviewTaskId: string;
  evaluationId: string;
  conclusion: 'pass' | 'fail';
  measurementMemoryId: string;
  strategyRecordMemoryId: string;
  totalCostUsd: number;
  humanMinutes: number;
  recordedAt: string;
}

/** 전략의 기록된 결과 (없으면 null). 결과 기록은 평가 패키지의 `recordExperimentResult` 가 쓴다 */
export function findExperimentResult(db: Db, strategyVersionId: string): ExperimentResult | null {
  const row = db.get<{ id: string; payload: string; received_at: string }>(
    'SELECT id, payload, received_at FROM event WHERE idempotency_key = ? AND source = ? AND type = ?',
    [experimentResultKey(strategyVersionId), EXPERIMENT_RESULT_EVENT.source, EXPERIMENT_RESULT_EVENT.type],
  );
  if (!row) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (!isPlainObject(payload) || (payload['conclusion'] !== 'pass' && payload['conclusion'] !== 'fail')) return null;
  return {
    eventId: row.id,
    strategyVersionId: String(payload['strategy_version_id']),
    reviewTaskId: String(payload['review_task_id']),
    evaluationId: String(payload['evaluation_id']),
    conclusion: payload['conclusion'],
    measurementMemoryId: String(payload['measurement_memory_id']),
    strategyRecordMemoryId: String(payload['strategy_record_memory_id']),
    totalCostUsd: Number(payload['total_cost_usd']),
    humanMinutes: Number(payload['human_minutes']),
    recordedAt: row.received_at,
  };
}

export interface ExperimentDecision {
  eventId: string;
  strategyVersionId: string;
  decision: 'promoted' | 'rejected';
  by: TransitionActor;
  actorId: string | null;
  reason: string;
  retired: string[];
  decidedAt: string;
}

/** 전략의 결정 기록(승격·거절, 없으면 null) */
export function findExperimentDecision(db: Db, strategyVersionId: string): ExperimentDecision | null {
  const row = db.get<{ id: string; payload: string; occurred_at: string }>(
    'SELECT id, payload, occurred_at FROM event WHERE idempotency_key = ? AND source = ? AND type = ?',
    [experimentDecisionKey(strategyVersionId), EXPERIMENT_DECISION_EVENT.source, EXPERIMENT_DECISION_EVENT.type],
  );
  if (!row) return null;
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    eventId: row.id, strategyVersionId, decision: payload['decision'] === 'promoted' ? 'promoted' : 'rejected', by: payload['by'] as TransitionActor,
    actorId: typeof payload['actor_id'] === 'string' ? payload['actor_id'] : null, reason: String(payload['reason']), retired: stringList(payload['retired']), decidedAt: row.occurred_at,
  };
}

function writeDecision(tx: Db, clock: Clock, input: { strategyVersionId: string; decision: 'promoted' | 'rejected'; by: TransitionActor; actorId: string | null; reason: string; retired: string[] }): void {
  const key = experimentDecisionKey(input.strategyVersionId);
  const now = clock.nowIso();
  tx.run(
    `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      experimentEventId(key), EXPERIMENT_DECISION_EVENT.source, input.strategyVersionId, EXPERIMENT_DECISION_EVENT.type,
      JSON.stringify({ strategy_version_id: input.strategyVersionId, decision: input.decision, by: input.by, actor_id: input.actorId, reason: input.reason, retired: input.retired }),
      key, now, now,
    ],
  );
}

const requireReason = (reason: string | undefined, what: string): string => {
  if (!isNonBlankString(reason)) throw new StrategyRuleError('reason_required', `${what} needs a reason`);
  return reason.trim();
};

export interface RejectExperimentInput {
  strategyVersionId: string;
  /** 사람 또는 시스템(평가가 fail 일 때는 'evaluator'). 에이전트면 거부 */
  by: TransitionActor;
  /** `by='human'` 이면 필수: 그 사람의 actor id */
  actorId?: string;
  reason: string;
}

/** `experiment → rejected`. 사유를 상태 전이 사유와 결정 기록에 남긴다. 이미 `experiment` 가 아니면 stale_state. Db.writeTx 안에서 부른다 */
export function rejectExperiment(tx: Db, clock: Clock, input: RejectExperimentInput): StrategyVersionRow {
  refuseAgent(input.by, 'reject an experiment');
  const reason = requireReason(input.reason, 'rejecting an experiment');
  const row = transitionStrategyVersion(tx, {
    strategyVersionId: input.strategyVersionId, from: 'experiment', to: 'rejected', by: input.by, reason,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
  });
  writeDecision(tx, clock, { strategyVersionId: input.strategyVersionId, decision: 'rejected', by: input.by, actorId: input.actorId ?? null, reason, retired: [] });
  return row;
}

export interface PromoteExperimentInput {
  strategyVersionId: string;
  /** 승격하는 사람 (actor.kind='human') */
  actorId: string;
  reason: string;
}

/**
 * `experiment → active` 승격 (사람만). 기록된 결과가 pass 이고 그 평가가 pass AND safety pass 일 때만 가능하다 — fail·inconclusive·결과 없음은 승격 사유가 아니다.
 * 이전 `active` 전략은 같은 트랜잭션에서 `retired` 로 둔다(롤백 지점). Db.writeTx 안에서 부른다.
 */
export function promoteExperiment(tx: Db, clock: Clock, input: PromoteExperimentInput): { strategy: StrategyVersionRow; retired: string[] } {
  const reason = requireReason(input.reason, 'promoting an experiment');
  const id = input.strategyVersionId;
  const result = findExperimentResult(tx, id);
  if (result === null) throw new StrategyRuleError('no_result', `strategy_version '${id}' has no recorded experiment result; a strategy is promoted only after a passing review`);
  const evaluation = tx.get<{ outcome: string; safety: string }>('SELECT outcome, safety FROM evaluation WHERE id = ?', [result.evaluationId]);
  if (result.conclusion !== 'pass' || evaluation === undefined || evaluation.outcome !== 'pass' || evaluation.safety !== 'pass') {
    throw new StrategyRuleError('not_passed', `strategy_version '${id}' did not pass its review (recorded conclusion ${result.conclusion}); it is not promoted`);
  }
  const strategy = transitionStrategyVersion(tx, { strategyVersionId: id, from: 'experiment', to: 'active', by: 'human', actorId: input.actorId, reason });
  const retired: string[] = [];
  for (const previous of tx.all<{ id: string }>("SELECT id FROM strategy_version WHERE status = 'active' AND id <> ? ORDER BY created_at, rowid", [id])) {
    transitionStrategyVersion(tx, { strategyVersionId: previous.id, from: 'active', to: 'retired', by: 'human', actorId: input.actorId, reason: `replaced by ${id}: ${reason}` });
    retired.push(previous.id);
  }
  writeDecision(tx, clock, { strategyVersionId: id, decision: 'promoted', by: 'human', actorId: input.actorId, reason, retired });
  return { strategy, retired };
}
