// 초안 → 전송 시험용 엔진 조립 (ADR-0015). 정책 대신 단계만 정하는 가짜 게이트로 task-engine 의 draft/dispatch 단계를 시험한다.
// (정책 게이트와 승인 엔진까지 함께 보는 시험은 policy-draft-approval / daemon-draft-approval 이 한다.)
import { proposedDraftsOf, type Db, type FakeClock, type TaskPolicyGate } from '@aot/domain';
import { TaskWorker, type EffectTool, type RunContext, type WorkerOptions } from '@aot/task-engine';

import { manualTimers, queuedTask } from './engine.ts';
import { MESSAGE_TARGET, MESSAGE_TOOL } from './message-tool.ts';
import { addAgent, seededDb } from './seeded-db.ts';

/** 제안된 초안이 있으면 dispatch, 없으면 draft 를 고르는 게이트. 정책·승인은 보지 않는다. `refuseResend`: failed 재전송을 거부(기본 정책의 동작) */
export function phaseGate(options: { refuseResend?: boolean; refuseAll?: string } = {}): TaskPolicyGate {
  return {
    beforeCreate: () => ({ decision: 'allow' }),
    beforeRun: (tx, { task }) => ({ decision: 'allow', phase: proposedDraftsOf(tx, task.id).length > 0 ? 'dispatch' : 'draft' }),
    beforeEffect: (tx, request) => {
      if (options.refuseAll !== undefined) return { decision: 'refuse', reason: options.refuseAll };
      if (options.refuseResend === true && request.dispatch === 'resend_failed') return { decision: 'refuse', reason: 'resend needs allow' };
      // 실제 게이트처럼 판정을 남긴다 (정책 준수 검사가 본다)
      tx.run(
        `INSERT INTO policy_decision (task_id, task_run_id, subject, action, resource, scope, impact, decision, reason, policy_version_id, at)
         SELECT ?, ?, 'generalist@v1', ?, ?, 'customer', 'external_effect', 'allow', 'test gate', id, ? FROM policy_version LIMIT 1`,
        [request.task.id, request.runId, `${request.tool}.${request.action}`, request.target, request.now],
      );
      return { decision: 'allow' };
    },
  };
}

export const MAIL_TOOLS = [{ tool: MESSAGE_TOOL, operations: ['send'], scope: 'customer', impact: 'external_effect', target: MESSAGE_TARGET }];

export interface DraftEngine {
  db: Db;
  clock: FakeClock;
  taskId: string;
  actorId: string;
  /** 초안 run 하나를 돌려 초안을 남기고 검증을 건너뛰어 proposed 로 만든 뒤 업무를 queued 로 되돌린다 (승인 절차 생략) */
  draftAndPropose(requests: { stepId: string; request: unknown }[], tool: EffectTool): Promise<void>;
  worker(tool: EffectTool, executed: { count: number }, gate?: TaskPolicyGate, extra?: Partial<WorkerOptions>): TaskWorker;
}

export function draftEngine(t: Parameters<typeof seededDb>[0], specOverrides: Record<string, unknown> = {}): DraftEngine {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  const taskId = queuedTask(db, clock, { allowed_tools: MAIL_TOOLS, ...specOverrides });
  const build = (tool: EffectTool, executed: { count: number }, gate: TaskPolicyGate, execute?: (ctx: RunContext) => Promise<unknown>, extra: Partial<WorkerOptions> = {}) => new TaskWorker({
    db, clock, workerId: 'w1', actorId, adapter: 'fake-adapter', gate, tools: { [tool.name]: tool }, timers: manualTimers(),
    executor: {
      execute: async (ctx) => {
        executed.count += 1;
        return { result: await (execute?.(ctx) ?? Promise.resolve({})) };
      },
    },
    ...extra,
  });
  return {
    db, clock, taskId, actorId,
    async draftAndPropose(requests, tool) {
      const executed = { count: 0 };
      await build(tool, executed, phaseGate(), async (ctx) => {
        for (const { stepId, request } of requests) await ctx.performEffect(tool.name, { stepId, action: 'send', target: MESSAGE_TARGET, request });
        return {};
      }).tick();
      db.writeTx((tx) => {
        tx.run("UPDATE effect_draft SET state = 'proposed' WHERE task_id = ? AND state = 'pending'", [taskId]);
        tx.run("UPDATE task SET status = 'queued' WHERE id = ?", [taskId]);
      });
    },
    worker: (tool, executed, gate = phaseGate(), extra = {}) => build(tool, executed, gate, undefined, extra),
  };
}
