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
  | 'experiment_scope_required';

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
