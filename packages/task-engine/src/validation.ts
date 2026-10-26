// 검증 결과 → 업무 전이 (state-machines.md 업무 표의 validating 행). 검증기(evaluation)는 판정만 돌려주고(domain 의 TaskValidator 포트),
// 상태를 옮기는 것은 이 패키지다: 업무 상태 갱신의 유일한 경로는 transitions.ts 이고, 재시도 가능 여부(attempts)도 여기서 안다.
//
//   pass          → completed      (모든 acceptance_criteria 충족 AND safety != fail. 단 validation.human=true 면 needs_review)
//   fail          → retry_wait     (기준 미충족, 재시도 가능: attempts + 1 < max_attempts. 시도 1회를 소모한다)
//                   needs_review   (재시도 횟수를 다 썼거나 안전성 실패 — validating 에서 failed 로 가는 전이는 없으므로 사람이 정한다)
//   inconclusive  → needs_review   (증거 부족. 사용자 결정 2026-10-21)
// 평가 기록과 전이는 별개 트랜잭션이다(검증에 외부 접근이 있어 트랜잭션 밖에서 하므로). 둘 사이에서 죽어도 평가는 UNIQUE 로 흡수되므로
// 다음 tick 의 재검증이 같은 평가를 돌려받아 전이만 이어서 한다.
import { CALL_MACHINE, type Clock, type Db, type EvaluationRow, type TaskRow, type TaskRunRow, type TaskSpec, type TaskStatus, type TaskValidationVerdict, type TaskValidator } from '@aot/domain';

import { StaleStateError } from './errors.ts';
import { isoAfter } from './params.ts';
import { transitionTask } from './transitions.ts';

export type ValidationTarget = Extract<TaskStatus, 'completed' | 'retry_wait' | 'needs_review'>;

export interface ValidationRoute {
  to: ValidationTarget;
  reason: string;
  /** 소모한 시도 횟수 (retry_wait 만) */
  attempts?: number;
}

/** 판정 → 전이 대상 (순수). 모순된 판정(pass 인데 safety=fail)은 오류다 */
export function routeVerdict(task: Pick<TaskRow, 'attempts' | 'max_attempts'>, verdict: TaskValidationVerdict): ValidationRoute {
  if (verdict.outcome === 'pass' && verdict.safety === 'fail') throw new Error(`inconsistent verdict ${verdict.evaluationId}: pass with safety=fail`);
  const why = verdict.reason;
  if (verdict.safety === 'fail') {
    return { to: 'needs_review', reason: `safety failed; a person decides (a safety failure is not retried automatically): ${why}` };
  }
  switch (verdict.outcome) {
    case 'pass':
      return verdict.humanRequired
        ? { to: 'needs_review', reason: `validation.human=true; a person confirms: ${why}` }
        : { to: 'completed', reason: why };
    case 'fail': {
      const attempts = Number(task.attempts) + 1;
      return attempts < Number(task.max_attempts)
        ? { to: 'retry_wait', reason: `criteria not met, retrying: ${why}`, attempts }
        : { to: 'needs_review', reason: `criteria not met and attempts are exhausted (${attempts}/${task.max_attempts}); a person decides: ${why}` };
    }
    case 'inconclusive':
      return { to: 'needs_review', reason: `evaluation inconclusive (insufficient evidence); a person reviews: ${why}` };
  }
}

export interface ValidationOptions {
  clock: Clock;
  validator: TaskValidator;
  /** retry_wait 의 대기 시간 (ms). 기본 60초 */
  retryDelayMs?: number;
}

export interface ValidationEnd {
  taskId: string;
  runId: string;
  evaluationId: string;
  taskStatus: ValidationTarget;
}

const DEFAULT_RETRY_DELAY_MS = 60_000;

/**
 * `validating` 업무 하나를 검증하고 전이한다. 이미 다른 워커가 전이했으면(StaleStateError) null.
 * 검증(외부 접근 가능)은 트랜잭션 밖, 전이는 한 쓰기 트랜잭션이다.
 */
export async function validateTask(db: Db, options: ValidationOptions, taskId: string): Promise<ValidationEnd | null> {
  const task = db.get<TaskRow>("SELECT * FROM task WHERE id = ? AND status = 'validating'", [taskId]);
  if (!task) return null;
  const run = db.get<TaskRunRow>('SELECT * FROM task_run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1', [taskId]);
  if (!run || run.outcome !== 'submitted') throw new Error(`task ${taskId} is validating but its latest run is not 'submitted'`);
  const spec = JSON.parse(task.spec) as TaskSpec;

  const verdict = await options.validator.validate({ task, spec, runId: run.id });
  try {
    return db.writeTx((tx) => {
      const now = options.clock.nowIso();
      // 전이 조건 확인 (state-machines.md): 검증기가 돌려준 판정이 실제 기록과 같아야 한다.
      const evaluation = tx.get<EvaluationRow>('SELECT * FROM evaluation WHERE id = ? AND task_id = ? AND task_run_id = ?', [verdict.evaluationId, taskId, run.id]);
      if (!evaluation) throw new Error(`verdict refers to evaluation '${verdict.evaluationId}', which is not recorded for run ${run.id}`);
      if (evaluation.outcome !== verdict.outcome || evaluation.safety !== verdict.safety) {
        throw new Error(`verdict (${verdict.outcome}, safety ${verdict.safety}) differs from the recorded evaluation (${evaluation.outcome}, safety ${evaluation.safety})`);
      }
      const current = tx.get<Pick<TaskRow, 'attempts' | 'max_attempts'>>('SELECT attempts, max_attempts FROM task WHERE id = ?', [taskId])!;
      const route = routeVerdict(current, verdict);
      transitionTask(tx, {
        taskId, from: 'validating', to: route.to, by: 'validator', now, reason: route.reason.slice(0, 500),
        ...(route.to === 'retry_wait'
          ? { set: { attempts: route.attempts!, next_run_at: isoAfter(options.clock.nowMs(), options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) } }
          : {}),
      });
      return { taskId, runId: run.id, evaluationId: evaluation.id, taskStatus: route.to };
    });
  } catch (error) {
    if (error instanceof StaleStateError) return null;
    throw error;
  }
}

// 열린 통화가 있는 업무는 검증하지 않는다 (ADR-0014 §6, 측정 값 대기와 같은 성격): 에이전트는 통화를 걸고 바로 결과를 제출했지만 통화는 아직 진행 중이다.
// 전이도 시도 소모도 없이 `validating` 에 머물고, webhook 이 통화를 종료시키면 다음 tick 에 검증된다. SQL 조건이라 다른 업무의 검증을 막지 않는다.
// 이 패키지는 `call` 테이블의 상태만 알고 provider 는 모른다. 마감을 넘긴 통화는 데몬이 조회·종료한다(domain 의 expireCall).
const OPEN_CALL_STATUS_LIST = CALL_MACHINE.states.filter((status) => !CALL_MACHINE.terminal.includes(status)).map((status) => `'${status}'`).join(', ');
const NO_OPEN_CALL_SQL = `NOT EXISTS (SELECT 1 FROM call WHERE call.task_id = task.id AND call.status IN (${OPEN_CALL_STATUS_LIST}))`;

/** 가장 오래된 `validating` 업무 하나 (제외 목록 밖에서, 열린 통화가 없는 것만). 없으면 null */
export function nextValidatingTask(db: Db, exclude: ReadonlySet<string> = new Set()): string | null {
  const rows = db.all<{ id: string }>(`SELECT id FROM task WHERE status = 'validating' AND ${NO_OPEN_CALL_SQL} ORDER BY updated_at, rowid LIMIT 50`);
  return rows.find((row) => !exclude.has(row.id))?.id ?? null;
}

export interface CallWait {
  taskId: string;
  /** 아직 끝나지 않은 통화와 그 상태 */
  calls: { callId: string; status: string; createdAt: string }[];
}

/** 열린 통화 때문에 검증이 보류된 업무 (진단·승인 CLI용) */
export function listCallWaits(db: Db): CallWait[] {
  const rows = db.all<{ task_id: string; id: string; status: string; created_at: string }>(
    `SELECT call.task_id AS task_id, call.id AS id, call.status AS status, call.created_at AS created_at FROM call JOIN task ON task.id = call.task_id
     WHERE task.status = 'validating' AND call.status IN (${OPEN_CALL_STATUS_LIST}) ORDER BY call.created_at, call.id`,
  );
  const waits = new Map<string, CallWait>();
  for (const row of rows) {
    const wait = waits.get(row.task_id) ?? { taskId: row.task_id, calls: [] };
    wait.calls.push({ callId: row.id, status: row.status, createdAt: row.created_at });
    waits.set(row.task_id, wait);
  }
  return [...waits.values()];
}
