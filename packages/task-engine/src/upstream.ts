// 업무 간 결과 전달 (A6-U11): 명세 `inputs[]` 의 `kind: 'task_result'` (`ref: 'task:<선행 업무 id>'`)를 실행 직전에 읽는다.
//
// 읽는 것은 *선행 업무가 완료(`completed`)이고, 그 업무에 통과 평가(`outcome='pass'` AND `safety='pass'`)가 있을 때, 그 평가가 대상으로 한 run 의 `task_run.result`* 뿐이다.
// 사람이 `needs_review → completed` 로 끝낸 업무도 통과 평가가 없으면 넘기지 않는다(사람의 완료 판단이 에이전트 보고를 원본 증거로 바꾸지는 않는다).
// 선행 입력은 *필수*다: 하나라도 충족되지 않으면 업무를 실행하지 않는다. `claimNextTask` 가 이 업무를 `queued → needs_review`(시도 소모 없음, run 만들지 않음)로
// 보내고 사유 코드를 남긴다. 기다리지 않는 이유: 선행 업무가 `completed` 가 된 뒤에는 상태가 더 바뀌지 않으므로(`completed` 는 종단) 기다려도 충족되지 않는다.
// 선행 업무가 아직 끝나지 않은 경우는 `dependencies`(task_dependency)가 이미 막는다 — 이 파일에 닿는 업무의 선행 업무는 모두 `completed` 다(방어로 한 번 더 본다).
//
// 결과는 *데이터*다. 이 파일은 내용을 해석하지 않고 JSON 객체인지와 크기 상한만 본다. 신뢰 표시(`external_untrusted`)는 어댑터 입력을 만드는 쪽(apps/daemon 의 실행기)이 붙인다.
import { Buffer } from 'node:buffer';

import {
  isPlainObject, MAX_TASK_RESULT_BYTES, MAX_TASK_RESULT_TOTAL_BYTES, TASK_RESULT_INPUT_KIND, taskIdOfResultRef,
  type Db, type TaskInput, type TaskSpec,
} from '@aot/domain';

/** 실행기에 넘기는 선행 업무 결과 하나 */
export interface UpstreamResult {
  /** 명세 `inputs[].name` */
  name: string;
  /** 선행 업무 id */
  taskId: string;
  /** `task:<id>` (명세의 `inputs[].ref`) */
  taskRef: string;
  /** 읽은 결과를 낸 run 과, 그 run 을 통과시킨 평가 (감사용) */
  runId: string;
  evaluationId: string;
  /** `task_run.result` (JSON 객체). 에이전트가 낸 값이므로 신뢰할 수 없는 데이터다 */
  result: Record<string, unknown>;
}

/** 충족되지 않은 이유. 업무의 `task_transition.reason` 에 `upstream_unmet: <code>: ...` 로 남는다 */
export const UPSTREAM_UNMET_CODES = [
  'upstream_invalid_ref', 'upstream_not_found', 'upstream_not_completed', 'upstream_not_evaluated', 'upstream_not_passed',
  'upstream_result_missing', 'upstream_result_not_object', 'upstream_result_too_large', 'upstream_total_too_large',
] as const;
export type UpstreamUnmetCode = (typeof UPSTREAM_UNMET_CODES)[number];

export type UpstreamResolution =
  | { ok: true; upstream: UpstreamResult[] }
  | { ok: false; code: UpstreamUnmetCode; input: string; detail: string };

const taskResultInputs = (spec: Pick<TaskSpec, 'inputs'>): TaskInput[] =>
  (Array.isArray(spec.inputs) ? spec.inputs : []).filter((input) => input.kind === TASK_RESULT_INPUT_KIND);

/** 명세에 선행 결과 입력이 있는가 */
export const hasTaskResultInputs = (spec: Pick<TaskSpec, 'inputs'>): boolean => taskResultInputs(spec).length > 0;

/**
 * 명세의 `task_result` 입력을 모두 읽는다. 첫 번째로 충족되지 않은 입력에서 멈추고 이유를 돌려준다(일부만 넘기지 않는다).
 * 읽기만 하므로 쓰기 트랜잭션 안(`claimNextTask`)에서 불러도 된다.
 */
export function resolveUpstream(db: Db, spec: Pick<TaskSpec, 'inputs'>): UpstreamResolution {
  const upstream: UpstreamResult[] = [];
  let total = 0;
  for (const input of taskResultInputs(spec)) {
    const unmet = (code: UpstreamUnmetCode, detail: string): UpstreamResolution => ({ ok: false, code, input: input.name, detail });
    const taskId = taskIdOfResultRef(input.ref);
    if (taskId === null) return unmet('upstream_invalid_ref', `ref '${input.ref}' is not 'task:<task id>'`);

    const task = db.get<{ status: string }>('SELECT status FROM task WHERE id = ?', [taskId]);
    if (task === undefined) return unmet('upstream_not_found', `task '${taskId}' does not exist`);
    if (task.status !== 'completed') return unmet('upstream_not_completed', `task '${taskId}' is '${task.status}', not 'completed'`);

    // 통과 평가: 가장 최근의 pass AND safety pass. 평가가 아예 없는 것과 통과하지 못한 것을 구분해 알린다
    const evaluated = db.get<{ n: number }>('SELECT count(*) AS n FROM evaluation WHERE task_id = ?', [taskId]);
    if (Number(evaluated?.n ?? 0) === 0) return unmet('upstream_not_evaluated', `task '${taskId}' has no evaluation`);
    const passing = db.get<{ id: string; task_run_id: string | null }>(
      "SELECT id, task_run_id FROM evaluation WHERE task_id = ? AND outcome = 'pass' AND safety = 'pass' ORDER BY at DESC, rowid DESC LIMIT 1", [taskId],
    );
    if (passing === undefined) return unmet('upstream_not_passed', `task '${taskId}' has no evaluation with outcome 'pass' and safety 'pass'`);
    if (passing.task_run_id === null) return unmet('upstream_result_missing', `the passing evaluation ${passing.id} of task '${taskId}' names no run`);

    const run = db.get<{ result: string | null }>('SELECT result FROM task_run WHERE id = ? AND task_id = ?', [passing.task_run_id, taskId]);
    if (run?.result === null || run === undefined) return unmet('upstream_result_missing', `run ${passing.task_run_id} of task '${taskId}' has no result`);
    const bytes = Buffer.byteLength(run.result, 'utf8');
    if (bytes > MAX_TASK_RESULT_BYTES) return unmet('upstream_result_too_large', `the result of task '${taskId}' is ${bytes} bytes (limit ${MAX_TASK_RESULT_BYTES}); it is never truncated`);
    total += bytes;
    if (total > MAX_TASK_RESULT_TOTAL_BYTES) return unmet('upstream_total_too_large', `the upstream results together exceed ${MAX_TASK_RESULT_TOTAL_BYTES} bytes`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(run.result);
    } catch {
      return unmet('upstream_result_not_object', `the result of task '${taskId}' is not valid JSON`);
    }
    if (!isPlainObject(parsed)) return unmet('upstream_result_not_object', `the result of task '${taskId}' is not a JSON object`);
    upstream.push({ name: input.name, taskId, taskRef: input.ref, runId: passing.task_run_id, evaluationId: passing.id, result: parsed });
  }
  return { ok: true, upstream };
}
