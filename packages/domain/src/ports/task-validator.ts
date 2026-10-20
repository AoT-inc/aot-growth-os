// 업무 엔진(task-engine)이 검증·평가(evaluation, A4)를 부르는 자리. task-engine 과 evaluation 은 서로 참조할 수 없으므로
// (경계 lint) 인터페이스를 domain 에 둔다: evaluation 이 구현하고, task-engine 이 호출하며, apps/daemon 이 조립한다 (TaskPolicyGate 와 같은 방식).
//
// 역할 분담
//  - 검증기(evaluation): 원본 증거를 조회·검사해 `evaluation` 행을 남기고, 판정(pass/fail/inconclusive)과 안전성만 돌려준다.
//    업무 상태는 건드리지 않는다.
//  - 업무 엔진(task-engine): 판정을 validating → completed / retry_wait / needs_review 로 옮긴다. 업무 상태 갱신의 유일한 경로는
//    task-engine 의 transitions 이고, 재시도 가능 여부(attempts)도 거기서 안다.
// 검증은 외부 접근(URL 조회, LLM 호출)을 하므로 비동기다. 트랜잭션 밖에서 불리고, 결과를 기록하는 쓰기는 구현이 Db.writeTx 안에서 한다.
import type { EvalOutcome, SafetyResult } from '../entities/enums.ts';
import type { TaskRow } from '../entities/rows.ts';
import type { TaskSpec } from '../spec/task-spec.ts';

export interface TaskValidationRequest {
  /** status = 'validating' 인 업무 */
  task: TaskRow;
  spec: TaskSpec;
  /** 검증할 run (outcome = 'submitted', 가장 최근 attempt) */
  runId: string;
}

export interface TaskValidationVerdict {
  /** 기록된 `evaluation.id`. 같은 (업무, run, 평가기)를 다시 검증하면 처음 기록된 행의 id 를 돌려준다 */
  evaluationId: string;
  outcome: EvalOutcome;
  safety: SafetyResult;
  /** 명세의 `validation.human` */
  humanRequired: boolean;
  /** 판정 요약 (task_transition.reason 에 들어간다) */
  reason: string;
}

export interface TaskValidator {
  validate(request: TaskValidationRequest): Promise<TaskValidationVerdict>;
}
