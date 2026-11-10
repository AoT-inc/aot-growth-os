// 초안 승인 시험 공용 (ADR-0015): 정책 환경에서 실제 흐름 그대로 초안 run → 평가 pass → 검증기 전이로 `needs_review` + proposed 초안을 만든다.
import type { TaskValidator } from '@aot/domain';
import { claimNextTask, recordDraft, submitRun, validateTask, type EffectStep } from '@aot/task-engine';

import { draftsOf } from './drafts.ts';
import { recordEvaluation } from './evaluation.ts';
import { createFakeMessageTool, examplePayload, MESSAGE_TARGET, type FakeMessageTool } from './message-tool.ts';
import { AGENT, createWithGate, effectDraft, type PolicyEnv } from './policy.ts';

export const LEASE_MS = 90_000;

/** 기록된 평가를 그대로 돌려주는 검증기 */
export const recordedEvaluationValidator = (env: Pick<PolicyEnv, 'db'>): TaskValidator => ({
  validate: ({ spec, runId }) => {
    const row = env.db.get<{ id: string; outcome: 'pass' | 'fail' | 'inconclusive'; safety: 'pass' | 'fail' }>('SELECT id, outcome, safety FROM evaluation WHERE task_run_id = ?', [runId])!;
    return Promise.resolve({ evaluationId: row.id, outcome: row.outcome, safety: row.safety, humanRequired: spec.validation.human, reason: `recorded ${row.outcome}` });
  },
});

export const claimWith = (env: PolicyEnv, taskId: string, workerId = 'w1') =>
  claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId, actorId: AGENT, adapter: 'fake-adapter', leaseMs: LEASE_MS, taskId, effectApprovalOf: () => 'draft' });

export interface DraftedTask {
  taskId: string;
  fake: FakeMessageTool;
  draftRunId: string;
}

/**
 * 초안 승인 업무를 만들어 초안 run 을 돌리고 평가 pass 로 검증해 `needs_review` + proposed 초안 상태로 둔다.
 * `requests` 의 각 요청이 초안 하나다 (기본: 메시지 하나). `influenced`: 첫 초안에 외부 입력 영향 표시.
 */
export async function draftedTask(
  env: PolicyEnv, options: { requests?: object[]; influenced?: boolean; spec?: Record<string, unknown>; dedupeKey?: string } = {},
): Promise<DraftedTask> {
  const fake = createFakeMessageTool();
  const taskId = createWithGate(env, effectDraft(options.spec ?? {}), options.dedupeKey === undefined ? {} : { dedupeKey: options.dedupeKey });
  const claimed = claimWith(env, taskId).claimed;
  if (claimed === null || claimed.phase !== 'draft') throw new Error(`test setup: expected a draft-phase claim, got ${claimed?.phase ?? 'no claim'}`);
  const requests = options.requests ?? [examplePayload()];
  requests.forEach((request, index) => {
    const step: EffectStep = { stepId: `step-${index + 1}`, action: 'send', target: MESSAGE_TARGET, request };
    recordDraft(env.db, env.clock, claimed.lease, fake.tool, step, { influenced: options.influenced === true && index === 0 });
  });
  submitRun(env.db, env.clock, claimed.lease, {});
  recordEvaluation(env.db, env.clock, { taskId, runId: claimed.lease.runId }, { outcome: 'pass' });
  const end = await validateTask(env.db, { clock: env.clock, validator: recordedEvaluationValidator(env) }, taskId);
  if (end?.taskStatus !== 'needs_review') throw new Error(`test setup: expected needs_review, got ${end?.taskStatus}`);
  if (draftsOf(env.db, taskId).some((draft) => draft.state !== 'proposed')) throw new Error('test setup: drafts are not proposed');
  return { taskId, fake, draftRunId: claimed.lease.runId };
}
