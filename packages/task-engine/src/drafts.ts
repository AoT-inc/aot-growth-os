// 외부 부작용 초안 (ADR-0015, docs/plans/draft-before-approval.md).
//  - effectApprovalOf: 업무가 초안 승인 업무인가 — 명세의 모든 `external_effect` 요청이 등록된 도구의 `approval: 'draft'` 동작일 때만 'draft'
//  - recordDraft:      초안 단계(draft) run 이 원장에 넘기려던 `EffectStep` 을 보내지 않고 `effect_draft` 에 남긴다 (펜싱과 한 트랜잭션).
//                      payload = canonicalJson(요청) 문자열 그대로, payload_hash = sha256(payload) = 전송 때의 `external_effect.request_hash`
// 초안 행은 호스트(이 모듈)만 쓴다. 에이전트는 DB 에 닿지 못하고, 같은 run 에서 다시 부르면 새 초안(다른 effect_key)이 늘 뿐 기존 행은 바뀌지 않는다.
import { randomUUID } from 'node:crypto';

import { DRAFT_LIMITS, proposedDraftsOf, sha256Hex, type Clock, type Db, type EffectApprovalMode, type EffectDraftRow, type TaskPolicyGate, type TaskRow, type TaskSpec } from '@aot/domain';

import { canonicalJson } from './canonical.ts';
import { effectKeyOf, performEffect, type EffectOutcome, type EffectStep, type EffectTool } from './effects.ts';
import { EffectDeclarationError } from './errors.ts';
import { resolveActionDeclaration } from './idempotency.ts';
import { assertLeaseHeld, type Lease } from './lease.ts';
import { isoAfter } from './params.ts';

/** 초안 기한 기본값 (72시간, ADR-0015 D8) */
export const DEFAULT_DRAFT_TTL_MS = 72 * 3_600_000;

/** 이 호출은 초안으로 만들 수 없다 (설정 오류·상한 초과·명세 범위 밖). 호출한 쪽에는 도구 오류로 보인다. */
export class DraftRefusedError extends Error {
  readonly code: 'not_draft_phase' | 'scope_action' | 'out_of_scope' | 'too_many_drafts' | 'payload_too_large' | 'not_json';

  constructor(code: DraftRefusedError['code'], message: string) {
    super(`draft refused (${code}): ${message}`);
    this.name = 'DraftRefusedError';
    this.code = code;
  }
}

/**
 * 업무의 승인 방식 (§2.3): 명세의 `impact: external_effect` 항목마다 같은 이름의 등록된 도구가 있고, 요청한 operation 이 모두 `approval: 'draft'` 로 선언돼 있으면 'draft'.
 * 하나라도 `scope`이거나 등록되지 않았거나 선언이 잘못됐으면(또는 외부 부작용 요청이 없으면) 'scope'(지금 동작).
 */
export function effectApprovalOf(spec: TaskSpec, tools: Readonly<Record<string, EffectTool>> | undefined): EffectApprovalMode {
  const effects = spec.allowed_tools.filter((entry) => entry.impact === 'external_effect');
  if (effects.length === 0) return 'scope';
  for (const entry of effects) {
    const tool = tools?.[entry.tool];
    if (!tool || entry.operations.length === 0) return 'scope';
    for (const operation of entry.operations) {
      const declared = resolveActionDeclaration(tool, operation);
      if (!declared.ok || declared.declaration.approval !== 'draft') return 'scope';
    }
  }
  return 'draft';
}

export interface RecordDraftOptions {
  /** 초안 기한(밀리초). 기본 72시간 */
  ttlMs?: number;
  /** 외부 입력이 영향을 준 호출인가 (게이트웨이가 표시, 초안 행과 화면 배지로 남는다) */
  influenced?: boolean;
}

/**
 * 초안 기록 (한 쓰기 트랜잭션): 펜싱, draft 단계 확인, (도구, action) 이 `approval:'draft'` 인지, 명세의 (도구, 작업, 대상) 범위 안인지, 크기·개수 상한을 확인한 뒤 저장한다.
 * 같은 run·같은 effect_key 의 초안이 이미 있으면 그 행을 돌려준다(중복 없음). 아무것도 보내지 않는다.
 * lease 를 잃었으면 LeaseLostError (행을 만들지 않는다).
 */
export function recordDraft(
  db: Db, clock: Clock, lease: Lease, tool: Pick<EffectTool, 'name' | 'actions' | 'lookup'>, step: EffectStep, options: RecordDraftOptions = {},
): EffectOutcome & { state: 'drafted' } {
  const resolved = resolveActionDeclaration(tool, step.action);
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    assertLeaseHeld(tx, lease, now, 'record external effect draft');
    if (lease.phase !== 'draft') throw new DraftRefusedError('not_draft_phase', 'drafts can only be recorded by a draft-phase run');
    if (!resolved.ok) throw new EffectDeclarationError(tool.name, [resolved.error]);
    if (resolved.declaration.approval !== 'draft') {
      throw new DraftRefusedError('scope_action', `${tool.name}.${step.action} is declared approval 'scope'; it cannot be drafted (configuration error)`);
    }
    const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [lease.taskId])!;
    const spec = JSON.parse(task.spec) as TaskSpec;
    const inScope = spec.allowed_tools.some((entry) =>
      entry.tool === tool.name && entry.impact === 'external_effect' && entry.operations.includes(step.action) && (entry.target === undefined || entry.target === step.target));
    if (!inScope) {
      throw new DraftRefusedError('out_of_scope', `${tool.name}.${step.action} on ${step.target} was not requested in allowed_tools (tool, operation and target must match)`);
    }
    const payload = canonicalJson(step.request);
    if (typeof payload !== 'string') throw new DraftRefusedError('not_json', 'the request is not JSON data');
    if (Buffer.byteLength(payload, 'utf8') > DRAFT_LIMITS.payloadBytes) {
      throw new DraftRefusedError('payload_too_large', `payload exceeds ${DRAFT_LIMITS.payloadBytes} bytes`);
    }
    // 전송 run 이 같은 키를 다시 계산하므로, 키는 저장된 payload 를 되읽은 값에서 만든다
    const request = JSON.parse(payload) as unknown;
    const effectKey = effectKeyOf(lease.taskId, step.stepId, request);
    const existing = tx.get<EffectDraftRow>('SELECT * FROM effect_draft WHERE task_run_id = ? AND effect_key = ?', [lease.runId, effectKey]);
    if (existing) return { state: 'drafted' as const, draftId: existing.id };
    const stats = tx.get<{ n: number; max_seq: number | null }>('SELECT count(*) AS n, max(seq) AS max_seq FROM effect_draft WHERE task_run_id = ?', [lease.runId])!;
    if (Number(stats.n) >= DRAFT_LIMITS.perRun) {
      throw new DraftRefusedError('too_many_drafts', `a run may leave at most ${DRAFT_LIMITS.perRun} drafts`);
    }
    const id = `draft-${randomUUID()}`;
    tx.run(
      `INSERT INTO effect_draft (id, task_id, task_run_id, seq, tool, action, target, step_id, payload, payload_hash, effect_key,
        influenced_by_external_input, state, created_at, expires_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [id, lease.taskId, lease.runId, Number(stats.max_seq ?? 0) + 1, tool.name, step.action, step.target, step.stepId, payload, sha256Hex(payload), effectKey,
        options.influenced === true ? 1 : 0, now, isoAfter(clock.nowMs(), options.ttlMs ?? DEFAULT_DRAFT_TTL_MS), now],
    );
    return { state: 'drafted' as const, draftId: id };
  });
}

export interface DispatchedDraft {
  draft_id: string;
  effect_id: string;
  state: 'confirmed' | 'failed' | 'unknown' | 'compensated';
}

export interface DispatchResult {
  dispatched: DispatchedDraft[];
}

/** 저장된 초안이 변조됐거나(payload 해시·effect_key 불일치) 보낼 수 없다. 아무것도 보내지 않았다(보내기 전에 모든 초안을 확인한다). */
export class DraftIntegrityError extends Error {
  constructor(message: string) {
    super(`draft integrity check failed: ${message}`);
    this.name = 'DraftIntegrityError';
  }
}

/**
 * 호스트 전송기 (§2.7). `proposed` 초안을 `seq` 순으로 기존 원장 규칙대로 보낸다 — 펜싱, planned → dispatched → confirmed/failed/unknown, 재전송 창, 정책 재확인
 * (`beforeEffect` 가 `request_hash` 가 승인된 초안의 해시인지 한 번 더 막는다)은 바꾸지 않는다.
 *  1. 보내기 전에 모든 초안의 `sha256(payload) = payload_hash` 와 `effectKeyOf(task_id, step_id, payload) = effect_key` 를 확인한다. 다르면 DraftIntegrityError (전송 0)
 *  2. `performEffect(..., {stepId, action, target, request: JSON.parse(payload)})`
 *  3. `confirmed`(새로 보냈든 재사용이든)면 다음 초안, `unknown` 이나 `failed` 면 멈춘다(뒤 초안은 보내지 않는다, D9). `failed` 는 호출한 쪽이 run 오류로 처리한다.
 * 이 함수는 에이전트 실행기·LLM 을 부르지 않는다. lease 를 잃으면 LeaseLostError, 정책이 거부하면 EffectRefusedError 를 그대로 던진다.
 */
export async function dispatchApprovedDrafts(
  db: Db, clock: Clock, lease: Lease, tools: Readonly<Record<string, EffectTool>>, gate: TaskPolicyGate,
): Promise<DispatchResult> {
  if (lease.phase !== 'dispatch') throw new Error(`run ${lease.runId} is not a dispatch-phase run`);
  const drafts = proposedDraftsOf(db, lease.taskId);
  if (drafts.length === 0) throw new DraftIntegrityError('the task has no proposed drafts to dispatch');
  const prepared = drafts.map((draft) => {
    if (sha256Hex(draft.payload) !== draft.payload_hash) throw new DraftIntegrityError(`draft ${draft.id}: payload does not match payload_hash`);
    let request: unknown;
    try {
      request = JSON.parse(draft.payload);
    } catch {
      throw new DraftIntegrityError(`draft ${draft.id}: payload is not JSON`);
    }
    if (canonicalJson(request) !== draft.payload) throw new DraftIntegrityError(`draft ${draft.id}: payload is not canonical JSON`);
    if (effectKeyOf(lease.taskId, draft.step_id, request) !== draft.effect_key) throw new DraftIntegrityError(`draft ${draft.id}: effect_key does not match`);
    const tool = tools[draft.tool];
    if (!tool) throw new DraftIntegrityError(`draft ${draft.id}: tool '${draft.tool}' is not registered`);
    return { draft, tool, request };
  });
  const dispatched: DispatchedDraft[] = [];
  for (const { draft, tool, request } of prepared) {
    const outcome = await performEffect(db, clock, lease, tool, { stepId: draft.step_id, action: draft.action, target: draft.target, request }, gate);
    if (outcome.state === 'drafted') throw new Error('a dispatch run must not draft');
    dispatched.push({ draft_id: draft.id, effect_id: outcome.effectId, state: outcome.state });
    if (outcome.state !== 'confirmed') break;
  }
  const failed = dispatched.find((entry) => entry.state === 'failed');
  if (failed) throw new Error(`draft ${failed.draft_id}: the external service answered with a failure; later drafts were not sent`);
  return { dispatched };
}
