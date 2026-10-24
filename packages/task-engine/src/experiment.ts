// 실험 활성화·종료 (A6-U15, 주간 사이클 6단계). 승인(policy 승인 엔진)이 같은 트랜잭션에서 `proposed → experiment` 까지 하고,
// 이 모듈은 승인 트랜잭션 *밖*에서 실험을 켠다. apps 의 주간 사이클(`cycle.advance()`)이 부른다.
//
// activateExperiment: 전략 하나에 한 번 (event 멱등 키 `experiment-activate:<전략 id>`, domain strategy.ts). 한 `Db.writeTx` 에서
//   1. 이미 활성화 기록이 있으면 아무것도 하지 않는다 (다른 프로세스가 먼저 했거나, 다시 부름)
//   2. 상태가 `experiment` 이고, 주입된 승인 확인(`verifyApproval`, apps 가 policy 의 verifyStrategyApproval 을 넘김)이 통과해야 한다 — 활성화 전 취소·승인 뒤 내용 변경이면 거부
//   3. `experiment_scope.task` 에 따라
//      - `task_template`(팩 템플릿 참조): 그 템플릿을 가리키는 루틴(`routine.task_template`)을 `enabled=1` 로 켠다. 없으면 거부(no_routine)
//      - `task_spec`(일회성 명세): 업무를 만든다(정책 생성 게이트를 그대로 거친다). trigger = `{kind: 'event', ref: <활성화 event id>}`, `task.strategy_version_id` = 전략
//   4. 활성화 event 를 쓴다. `occurred_at` = 활성화 시각 = 켠 루틴의 발화 기준점(routine.ts). routine 행에 켠 시각 열이 없어 새 열 대신 이 event 로 표현한다
//   거부는 `ExperimentActivationError`(사유 코드). 업무 생성이 정책에 거부되면 트랜잭션은 되돌려지고 거부 판정만 새 트랜잭션에 남는다(createTask 와 같은 규칙).
// endExperiment: 실험의 루틴을 끈다(`enabled=0`) + 종료 event(`experiment-end:<전략 id>`, 멱등). 전략 상태는 바꾸지 않는다(판정과 전이는 U16).
// 마케팅 업무의 외부 부작용은 여기서 승인되지 않는다 — 업무가 실행 직전에 정책 게이트(beforeRun)의 판정과 업무 승인 절차를 따로 거친다.
// 시각은 주입된 Clock 에서만 얻는다.
import {
  EXPERIMENT_ACTIVATION_EVENT, EXPERIMENT_END_EVENT, experimentActivationKey, experimentEndKey, findExperimentActivation, isPlainObject,
  type Clock, type Db, type StrategyVersionRow, type TransitionActor,
} from '@aot/domain';

import { sha256 } from './canonical.ts';
import { createTaskInTx, withRefusalRecord, type CreateContext } from './create.ts';
import { TaskCreationError } from './errors.ts';

export type ExperimentRefusalCode = 'agent_forbidden' | 'not_found' | 'not_experiment' | 'approval_invalid' | 'invalid_scope' | 'no_routine' | 'task_refused';

export class ExperimentActivationError extends Error {
  readonly code: ExperimentRefusalCode;
  constructor(code: ExperimentRefusalCode, message: string) {
    super(message);
    this.name = 'ExperimentActivationError';
    this.code = code;
  }
}

/** 실험 업무를 만든 주체로 task_transition.caused_by 에 남는 값 (actor 가 아니므로 업무의 "요청자"가 없다 — 승인 규칙은 업무 승인 쪽에서 그대로) */
export const EXPERIMENT_TASK_CAUSE = 'system:experiment-cycle';

export interface ApprovalCheck {
  ok: boolean;
  reason: string;
  approvalId: string | null;
}

export interface ActivateExperimentInput {
  strategyVersionId: string;
  /** 활성화 직전 승인 확인. 활성화와 같은 쓰기 트랜잭션 안에서 불린다. ok 가 아니면 아무것도 쓰지 않는다 */
  verifyApproval: (tx: Db, strategyVersionId: string) => ApprovalCheck;
  /** 기록하는 주체 (기본 'system'). 에이전트면 거부 */
  by?: TransitionActor;
}

export interface ActivateExperimentResult {
  /** false 면 이미 활성화되어 있어 아무것도 하지 않았다 */
  activated: boolean;
  eventId: string;
  activatedAt: string;
  routineIds: string[];
  taskIds: string[];
}

const eventIdOf = (key: string): string => `event-${sha256(key).slice(0, 32)}`;

type ScopeTask = { kind: 'task_template'; ref: string } | { kind: 'task_spec'; spec: Record<string, unknown> };

function scopeTaskOf(row: StrategyVersionRow): ScopeTask {
  let scope: unknown;
  try {
    scope = row.experiment_scope === null ? null : JSON.parse(row.experiment_scope);
  } catch {
    scope = null;
  }
  const task = isPlainObject(scope) ? scope['task'] : undefined;
  if (isPlainObject(task) && task['kind'] === 'task_template' && typeof task['ref'] === 'string' && task['ref'] !== '') return { kind: 'task_template', ref: task['ref'] };
  if (isPlainObject(task) && task['kind'] === 'task_spec' && isPlainObject(task['spec'])) return { kind: 'task_spec', spec: task['spec'] };
  throw new ExperimentActivationError('invalid_scope', `strategy_version '${row.id}' has no experiment_scope.task ({kind: task_template, ref} or {kind: task_spec, spec})`);
}

/** 승인된 실험을 켠다 (멱등). 쓰기 트랜잭션을 스스로 연다 */
export function activateExperiment(db: Db, context: CreateContext, input: ActivateExperimentInput): ActivateExperimentResult {
  if (input.by === 'agent') throw new ExperimentActivationError('agent_forbidden', 'agents cannot activate an experiment; they only submit results');
  try {
    return withRefusalRecord(db, () => db.writeTx((tx) => activateInTx(tx, context, input)));
  } catch (error) {
    if (error instanceof TaskCreationError) throw new ExperimentActivationError('task_refused', `the experiment task was refused: ${error.message}`);
    throw error;
  }
}

function activateInTx(tx: Db, context: CreateContext, input: ActivateExperimentInput): ActivateExperimentResult {
  const id = input.strategyVersionId;
  const existing = findExperimentActivation(tx, id);
  if (existing) return { activated: false, eventId: existing.eventId, activatedAt: existing.activatedAt, routineIds: existing.routineIds, taskIds: existing.taskIds };
  const row = tx.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [id]);
  if (!row) throw new ExperimentActivationError('not_found', `strategy_version '${id}' does not exist`);
  if (row.status !== 'experiment') throw new ExperimentActivationError('not_experiment', `strategy_version '${id}' is '${row.status}'; only an approved experiment can be activated`);
  const approval = input.verifyApproval(tx, id);
  if (!approval.ok) throw new ExperimentActivationError('approval_invalid', `strategy_version '${id}' cannot be activated: ${approval.reason}`);
  const task = scopeTaskOf(row);

  const key = experimentActivationKey(id);
  const eventId = eventIdOf(key);
  const now = context.clock.nowIso();
  const routineIds: string[] = [];
  const taskIds: string[] = [];
  if (task.kind === 'task_template') {
    const routines = tx.all<{ id: string }>('SELECT id FROM routine WHERE task_template = ? ORDER BY slug, id', [task.ref]);
    if (routines.length === 0) throw new ExperimentActivationError('no_routine', `no routine runs the task template '${task.ref}' of strategy_version '${id}'`);
    for (const routine of routines) {
      tx.run('UPDATE routine SET enabled = 1 WHERE id = ?', [routine.id]);
      routineIds.push(routine.id);
    }
  } else {
    const created = createTaskInTx(tx, context, {
      spec: { ...task.spec, trigger: { kind: 'event', ref: eventId } }, strategyVersionId: id, causedBy: EXPERIMENT_TASK_CAUSE,
    });
    taskIds.push(created.taskId);
  }
  tx.run(
    `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      eventId, EXPERIMENT_ACTIVATION_EVENT.source, id, EXPERIMENT_ACTIVATION_EVENT.type,
      JSON.stringify({
        strategy_version_id: id, approval_id: approval.approvalId, task_kind: task.kind, ...(task.kind === 'task_template' ? { task_template: task.ref } : {}),
        routine_ids: routineIds, task_ids: taskIds,
      }),
      key, now, now,
    ],
  );
  return { activated: true, eventId, activatedAt: now, routineIds, taskIds };
}

export interface EndExperimentInput {
  strategyVersionId: string;
  /** 기록하는 주체 (U16 의 판정 단계 = 'evaluator', 사람 = 'human'). 에이전트면 거부 */
  by: TransitionActor;
  reason?: string;
}

export interface EndExperimentResult {
  /** false 면 이미 종료 기록이 있어 아무것도 하지 않았다 */
  ended: boolean;
  eventId: string;
  /** 끈 루틴 (활성화 기록이 켠 것) */
  routineIds: string[];
}

/** 실험을 끝낸다: 활성화가 켠 루틴을 끄고(`enabled=0`) 종료 기록을 남긴다 (멱등). 전략 상태 전이는 하지 않는다 */
export function endExperiment(db: Db, clock: Clock, input: EndExperimentInput): EndExperimentResult {
  if (input.by === 'agent') throw new ExperimentActivationError('agent_forbidden', 'agents cannot end an experiment; they only submit results');
  return db.writeTx((tx) => {
    const id = input.strategyVersionId;
    const key = experimentEndKey(id);
    const existing = tx.get<{ id: string; payload: string }>('SELECT id, payload FROM event WHERE idempotency_key = ?', [key]);
    if (existing) {
      const payload = JSON.parse(existing.payload) as { routine_ids?: unknown };
      return { ended: false, eventId: existing.id, routineIds: Array.isArray(payload.routine_ids) ? payload.routine_ids.map(String) : [] };
    }
    if (!tx.get('SELECT 1 AS one FROM strategy_version WHERE id = ?', [id])) throw new ExperimentActivationError('not_found', `strategy_version '${id}' does not exist`);
    const routineIds = findExperimentActivation(tx, id)?.routineIds ?? [];
    for (const routineId of routineIds) tx.run('UPDATE routine SET enabled = 0 WHERE id = ?', [routineId]);
    const eventId = eventIdOf(key);
    const now = clock.nowIso();
    tx.run(
      `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [eventId, EXPERIMENT_END_EVENT.source, id, EXPERIMENT_END_EVENT.type, JSON.stringify({ strategy_version_id: id, routine_ids: routineIds, by: input.by, reason: input.reason ?? null }), key, now, now],
    );
    return { ended: true, eventId, routineIds };
  });
}
