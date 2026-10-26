// 업무·부작용 상태 갱신의 유일한 경로. 허용 여부는 domain 의 허용표(TASK_MACHINE, EXTERNAL_EFFECT_MACHINE)로만 판정하고,
// 갱신은 비교 후 갱신(WHERE status = from)이라 다른 쓰기가 먼저 일어났으면 0건 → StaleStateError.
// 반드시 Db.writeTx 안에서 부른다 (Db 가 트랜잭션 밖 쓰기를 거부한다).
import {
  assertTransition, EXTERNAL_EFFECT_MACHINE, TASK_MACHINE,
  type Db, type ExternalEffectState, type SqlValue, type TaskStatus, type TransitionActor,
} from '@aot/domain';

import { StaleStateError } from './errors.ts';

export interface TaskTransitionRequest {
  taskId: string;
  from: TaskStatus | null;
  to: TaskStatus;
  by: TransitionActor;
  reason: string;
  now: string;
  /** task_transition.caused_by. 기본은 `system:<by>` (사람이면 actor id 를 넘긴다) */
  causedBy?: string;
  approvalId?: string;
  /** 상태와 함께 바꿀 task 열 (attempts, next_run_at 등) */
  set?: Readonly<Record<string, SqlValue>>;
}

/** 이미 있는 업무의 상태를 바꾸고 task_transition 에 남긴다. 생성(from=null)은 create.ts 가 INSERT 와 함께 기록한다. */
export function transitionTask(tx: Db, request: TaskTransitionRequest): void {
  if (request.from === null) throw new Error('transitionTask: use recordTaskCreation for creation');
  assertTransition(TASK_MACHINE, {
    from: request.from, to: request.to, by: request.by, reason: request.reason, approvalId: request.approvalId ?? null,
  });
  const extra = Object.entries(request.set ?? {});
  for (const [column] of extra) {
    if (!/^[a-z_]+$/.test(column) || column === 'status' || column === 'id') throw new Error(`transitionTask: column '${column}' cannot be set`);
  }
  const assignments = ['status = ?', 'updated_at = ?', ...extra.map(([column]) => `${column} = ?`)].join(', ');
  const changed = tx.run(`UPDATE task SET ${assignments} WHERE id = ? AND status = ?`, [
    request.to, request.now, ...extra.map(([, value]) => value), request.taskId, request.from,
  ]);
  if (changed.changes !== 1) {
    throw new StaleStateError(`task ${request.taskId} is no longer '${request.from}' (wanted -> '${request.to}')`);
  }
  insertTransitionRow(tx, request);
}

/** 생성 전이((none) → queued/unassigned)의 허용 확인과 기록. task 행 INSERT 직후에 부른다. */
export function recordTaskCreation(tx: Db, request: Omit<TaskTransitionRequest, 'from' | 'set'>): void {
  assertTransition(TASK_MACHINE, { from: null, to: request.to, by: request.by, reason: request.reason });
  insertTransitionRow(tx, { ...request, from: null });
}

function insertTransitionRow(tx: Db, request: TaskTransitionRequest): void {
  tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
    request.taskId, request.from, request.to, request.reason, request.causedBy ?? `system:${request.by}`, request.now,
  ]);
}

export interface EffectTransitionRequest {
  effectId: string;
  from: ExternalEffectState;
  to: ExternalEffectState;
  by: TransitionActor;
  now: string;
  set?: Readonly<Record<string, SqlValue>>;
}

const EFFECT_PROTECTED_COLUMNS = ['state', 'id', 'planned_at', 'supports_idempotency', 'idempotency_retention_ms'];

/** external_effect.state 갱신. 허용표 확인 + 비교 후 갱신. planned_at 과 멱등 스냅숏 열은 여기서 쓸 수 없다 (강화는 planEffect 만). */
export function transitionEffect(tx: Db, request: EffectTransitionRequest): void {
  assertTransition(EXTERNAL_EFFECT_MACHINE, { from: request.from, to: request.to, by: request.by });
  const extra = Object.entries(request.set ?? {});
  for (const [column] of extra) {
    if (!/^[a-z_]+$/.test(column) || EFFECT_PROTECTED_COLUMNS.includes(column)) throw new Error(`transitionEffect: column '${column}' cannot be set`);
  }
  const assignments = ['state = ?', 'at = ?', ...extra.map(([column]) => `${column} = ?`)].join(', ');
  const changed = tx.run(`UPDATE external_effect SET ${assignments} WHERE id = ? AND state = ?`, [
    request.to, request.now, ...extra.map(([, value]) => value), request.effectId, request.from,
  ]);
  if (changed.changes !== 1) {
    throw new StaleStateError(`external_effect ${request.effectId} is no longer '${request.from}' (wanted -> '${request.to}')`);
  }
}
