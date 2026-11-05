// 결정 위임 시험 공용 (ADR-0016, 제안): 위임을 선언한 정책 텍스트, 위임 환경(정책 배포 + 위임 보유자 행위자), 초안 승인 업무 만들기.
import { ensureApprovalDelegate, type Db } from '@aot/domain';
import type { ApprovalResponse } from '@aot/policy';
import { claimNextTask, createTask, recordDraft, submitRun, validateTask, type EffectStep } from '@aot/task-engine';

import { draftsOf } from './drafts.ts';
import { recordEvaluation } from './evaluation.ts';
import { claimWith, recordedEvaluationValidator } from './draft-flow.ts';
import { createFakeMessageTool, examplePayload, MESSAGE_TARGET, type FakeMessageTool } from './message-tool.ts';
import { DEFAULT_TEMPLATE_TEXT, effectDraft, policyEnv, type PolicyEnv } from './policy.ts';
import type { TestContext } from 'node:test';

export const DELEGATE = 'approval-delegate';
export const MANDATE = 'routine-mail';

export interface MandateOptions {
  id?: string;
  holder?: string;
  actions?: string[];
  targets?: string[];
  scopes?: string[];
  limits?: Partial<Record<'max_per_day' | 'max_drafts_per_task' | 'max_recipients_per_draft' | 'max_payload_bytes' | 'max_task_usd' | 'max_rewrites_per_task' | 'max_review_usd_per_day', number>>;
  cooldown?: string;
  guidance?: string;
  expires?: string;
}

const quoted = (items: readonly string[]): string => `[${items.map((item) => `'${item}'`).join(', ')}]`;

/** 위임 한 건의 YAML 줄들 (정책 `delegation.mandates` 의 항목, 들여쓰기 4칸 목록) */
export function mandateLines(options: MandateOptions = {}): string {
  const limits = {
    max_per_day: 5, max_drafts_per_task: 1, max_recipients_per_draft: 1, max_payload_bytes: 20_000, max_task_usd: 2, max_rewrites_per_task: 1, max_review_usd_per_day: 1,
    ...options.limits,
  };
  return [
    `    - id: ${options.id ?? MANDATE}`,
    `      holder: ${options.holder ?? DELEGATE}`,
    '      subjects: [task]',
    '      match:',
    `        actions: ${quoted(options.actions ?? ['notify-tool.send'])}`,
    `        targets: ${quoted(options.targets ?? ['mailbox:*'])}`,
    `        scopes: [${(options.scopes ?? ['customer']).join(', ')}]`,
    '      limits:',
    ...Object.entries(limits).map(([key, value]) => `        ${key}: ${value}`),
    `      cooldown: ${options.cooldown ?? '1h'}`,
    `      guidance: '${options.guidance ?? 'routine notices only; escalate prices, contracts and apologies'}'`,
    `      expires: ${options.expires ?? '2026-12-31'}`,
  ].join('\n');
}

/** 기본 정책 + 위임 섹션. `mandates` 가 비면 섹션 없이 기본 정책 그대로 */
export function delegationPolicyText(mandates: readonly MandateOptions[] = [{}], base: string = DEFAULT_TEMPLATE_TEXT): string {
  if (mandates.length === 0) return base;
  return `${base.trimEnd()}\n\ndelegation:\n  mandates:\n${mandates.map((m) => mandateLines(m)).join('\n')}\n`;
}

/** 위임 보유자 행위자를 만든 정책 환경. `policy` 가 주어지면(기본: 위임 하나) 승인 절차 없이 배포한다 */
export function delegationEnv(t: TestContext, mandates: readonly MandateOptions[] = [{}], options: { file?: boolean } = {}): PolicyEnv {
  const env = policyEnv(t, options);
  env.db.writeTx((tx) => ensureApprovalDelegate(tx, env.clock));
  env.db.writeTx((tx) => {
    const parsed = env.store.archive(delegationPolicyText(mandates));
    tx.run('INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at, rollback_of) VALUES (?, ?, ?, ?, ?, NULL)', [
      parsed.versionId, parsed.hash, 'risky', JSON.stringify(['actor-owner']), env.clock.nowIso(),
    ]);
  });
  return env;
}

export interface Drafted {
  taskId: string;
  fake: FakeMessageTool;
  draftRunId: string;
}

/** `draftedTask`(test/support/draft-flow.ts)와 같은 흐름에 요청자(causedBy)를 더한 것: needs_review + proposed 초안 */
export async function draftedFor(
  env: PolicyEnv, options: { requests?: object[]; influenced?: boolean; spec?: Record<string, unknown>; causedBy?: string; dedupeKey?: string } = {},
): Promise<Drafted> {
  const fake = createFakeMessageTool();
  const created = createTask(env.db, { clock: env.clock, gate: env.gate }, {
    spec: effectDraft(options.spec ?? {}),
    ...(options.causedBy === undefined ? {} : { causedBy: options.causedBy }),
    ...(options.dedupeKey === undefined ? {} : { dedupeKey: options.dedupeKey }),
  });
  const taskId = created.taskId;
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

export { claimNextTask };

/** 이 업무의 지금 해시 (`show` 의 hash) */
export const hashOf = (env: PolicyEnv, taskId: string): string => String(env.send({ cmd: 'show', actor: 'actor-owner', kind: 'task', id: taskId })['hash']);

export const approvalsOf = (db: Db, taskId: string) =>
  db.all<{ decision: string; decided_by: string; subject_hash: string | null; comment: string | null; mandate_id: string | null; via: string | null }>(
    "SELECT decision, decided_by, subject_hash, comment, mandate_id, via FROM approval WHERE subject_kind = 'task' AND subject_id = ? ORDER BY at, rowid", [taskId],
  ).map((row) => ({ ...row }));

export const reviewsOf = (db: Db, taskId: string) =>
  db.all<{ verdict: string; outcome: string; reason: string; subject_hash: string; mandate_id: string; cost_usd: number }>(
    'SELECT verdict, outcome, reason, subject_hash, mandate_id, cost_usd FROM delegate_review WHERE task_id = ? ORDER BY id', [taskId],
  );

export const controlsOf = (db: Db) =>
  db.all<{ action: string; mandate_id: string | null; actor_id: string; reason: string }>('SELECT action, mandate_id, actor_id, reason FROM delegation_control ORDER BY id').map((row) => ({ ...row }));

/** 위임 보유자의 결정 한 번 (프로세스 안 호출) */
export function decide(env: PolicyEnv, taskId: string, verdict: 'approve' | 'request_changes' | 'escalate' = 'approve', reason = 'looks routine', over: Record<string, unknown> = {}) {
  return env.engine.delegateDecide({ task_id: taskId, hash: hashOf(env, taskId), verdict, reason, ...over } as Parameters<PolicyEnv['engine']['delegateDecide']>[0]);
}

export const send = (env: PolicyEnv, command: Record<string, unknown>): ApprovalResponse => env.send(command);
