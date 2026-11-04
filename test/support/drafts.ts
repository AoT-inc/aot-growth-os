// 초안 시험 공용: effect_draft 행을 직접 넣는 도우미 (ADR-0015).
import { canonicalJson, sha256Hex, type Db, type EffectDraftRow } from '@aot/domain';
import { effectKeyOf } from '@aot/task-engine';

import { MESSAGE_TARGET, MESSAGE_TOOL, examplePayload } from './message-tool.ts';

let counter = 0;

/** 기본 메시지 초안 행 (payload_hash·effect_key 는 payload 에서 계산한다) */
export function draftRowFor(taskId: string, runId: string, over: Partial<EffectDraftRow> & { request?: unknown } = {}): EffectDraftRow {
  counter += 1;
  const { request, ...rest } = over;
  const payload = over.payload ?? canonicalJson(request ?? examplePayload());
  const stepId = over.step_id ?? `step-${counter}`;
  return {
    id: `draft-${counter}`, task_id: taskId, task_run_id: runId, seq: counter, tool: MESSAGE_TOOL, action: 'send', target: MESSAGE_TARGET,
    step_id: stepId, payload, payload_hash: sha256Hex(payload), effect_key: effectKeyOf(taskId, stepId, JSON.parse(payload)),
    influenced_by_external_input: 0, state: 'proposed', created_at: '2026-10-19T00:00:00.000Z', expires_at: '2026-10-22T00:00:00.000Z',
    at: '2026-10-19T00:00:00.000Z', ...rest,
  };
}

export function insertDraftRow(db: Db, row: EffectDraftRow): EffectDraftRow {
  db.writeTx((tx) => tx.run(
    `INSERT INTO effect_draft (id, task_id, task_run_id, seq, tool, action, target, step_id, payload, payload_hash, effect_key,
      influenced_by_external_input, state, created_at, expires_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.task_id, row.task_run_id, row.seq, row.tool, row.action, row.target, row.step_id, row.payload, row.payload_hash,
      row.effect_key, row.influenced_by_external_input, row.state, row.created_at, row.expires_at, row.at],
  ));
  return row;
}

export const draftsOf = (db: Db, taskId: string): EffectDraftRow[] =>
  db.all<EffectDraftRow>('SELECT * FROM effect_draft WHERE task_id = ? ORDER BY task_run_id, seq', [taskId]);

/** 끝난 run 행 하나 (초안 행의 외래 키용) */
export function insertClosedRun(db: Db, taskId: string, runId: string, attempt: number, actorId: string, at: string, adapter = 'fake-adapter'): void {
  db.writeTx((tx) => tx.run(
    `INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'w1', ?, ?, 'submitted')`,
    [runId, taskId, attempt, actorId, adapter, at, at, at, at],
  ));
}
