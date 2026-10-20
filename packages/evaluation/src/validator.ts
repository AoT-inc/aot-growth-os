// domain 의 TaskValidator 포트 구현: 평가기를 돌려 판정(pass/fail/inconclusive)과 안전성을 돌려준다.
// 업무 상태 전이는 하지 않는다 — task-engine 이 판정을 validating → completed / retry_wait / needs_review 로 옮긴다 (경계 lint).
import type { EvaluationRow, TaskValidationRequest, TaskValidationVerdict, TaskValidator } from '@aot/domain';

import { evaluateRun, type EvaluatorDeps } from './evaluator.ts';

export function summarizeEvaluation(row: Pick<EvaluationRow, 'id' | 'evaluator' | 'outcome' | 'safety' | 'quality_note'>): string {
  const note = row.quality_note === null ? '' : `: ${row.quality_note}`;
  return `evaluation ${row.id} by ${row.evaluator}: ${row.outcome}, safety ${row.safety}${note}`.slice(0, 400);
}

export function createTaskValidator(deps: EvaluatorDeps): TaskValidator {
  return {
    async validate(request: TaskValidationRequest): Promise<TaskValidationVerdict> {
      const { evaluation } = await evaluateRun(deps, { taskId: request.task.id, taskRunId: request.runId });
      return {
        evaluationId: evaluation.id,
        outcome: evaluation.outcome,
        safety: evaluation.safety,
        humanRequired: request.spec.validation.human,
        reason: summarizeEvaluation(evaluation),
      };
    },
  };
}
