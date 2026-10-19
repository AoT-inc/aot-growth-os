// 외부 부작용 원장 — docs/operations/recovery.md §3.
// 모든 외부 부작용은 호출 전에 `planned` 로 기록하고, 전송 직전 `planned → dispatched` 를 lease 펜싱과 같은 트랜잭션에서
// 기록한 뒤에만 보낸다. effect_key = hash(task_id, step_id, canonical(request)) — 재시도해도 같은 키.
//
// 재시도 규칙 (§3 표)
//   planned               → 전송
//   dispatched/unknown    → 멱등 지원: 조회로 확인되면 confirmed, 아니면 같은 키로 재전송
//                           멱등 미지원: 재전송 금지. 조회로 확인되면 confirmed, 아니면 unknown 으로 둔다 → needs_review
//   confirmed             → 재전송하지 않고 결과 재사용
//   failed                → 재전송은 정책 허용 시 (정책 게이트 beforeEffect 가 'resend_failed' 를 허용할 때만)
// 모든 전송(처음·재전송) 직전에 정책 게이트(TaskPolicyGate.beforeEffect)로 재검증한다 (task-spec "외부 부작용 직전").
// 처음 전송·같은 키 재전송이 거부되면 보내지 않고 run 을 멈춘다(running → needs_review, EffectRefusedError).
// 외부 호출(send, lookup)은 쓰기 트랜잭션 밖에서 한다.
import { randomUUID } from 'node:crypto';

import type { Clock, Db, EffectDispatchKind, ExternalEffectRow, TaskPolicyGate, TaskRow, TaskSpec } from '@aot/domain';

import { canonicalJson, sha256 } from './canonical.ts';
import { EffectRefusedError, StaleStateError } from './errors.ts';
import { assertLeaseHeld, heartbeatInTx, stopRunForReview, type Lease } from './lease.ts';
import { transitionEffect } from './transitions.ts';

/** 외부 부작용 도구의 계약 (실제 구현은 A5 의 도구 게이트웨이). */
export interface EffectTool {
  readonly name: string;
  /** 외부 시스템의 멱등 키 지원 여부 (tool_contract_version 에 포함되는 선언값) */
  readonly supportsIdempotency: boolean;
  /**
   * 부작용을 보낸다. `effectKey` 를 외부 멱등 키로 쓴다(지원 시).
   * 예외(타임아웃·응답 유실 등)는 "실패"가 아니라 `unknown` 으로 기록된다 (recovery §5).
   */
  send(call: EffectCall): Promise<EffectSendResult> | EffectSendResult;
  /** 같은 키로 이미 전달됐는지 외부 상태 조회. 조회 API 가 없으면 생략 */
  lookup?: (effectKey: string) => Promise<EffectLookupResult> | EffectLookupResult;
}

export interface EffectCall {
  effectKey: string;
  action: string;
  target: string;
  request: unknown;
}

export type EffectSendResult =
  | { status: 'confirmed'; responseRef: string | null }
  /** 외부가 명확히 실패 응답 */
  | { status: 'failed'; responseRef: string | null };

export type EffectLookupResult = { found: true; responseRef: string | null } | { found: false };

export interface EffectStep {
  /** 업무 안에서 이 부작용의 단계 id. 재시도해도 같아야 한다 */
  stepId: string;
  action: string;
  target: string;
  request: unknown;
}

export type EffectOutcome =
  | { state: 'confirmed'; effectId: string; responseRef: string | null; reused: boolean }
  | { state: 'failed'; effectId: string; reused: boolean }
  | { state: 'unknown'; effectId: string }
  | { state: 'compensated'; effectId: string };

export function effectKeyOf(taskId: string, stepId: string, request: unknown): string {
  return sha256(canonicalJson([taskId, stepId, request]));
}

/**
 * `planned` 기록 (펜싱). 같은 키가 이미 있으면 새로 만들지 않는다. 다른(닫힌) run 이 남긴 것은 지금 run 으로 가져오고,
 * 그 run 에서 `dispatched` 로 끝난 것은 `unknown`(워커 사망)으로 돌린다.
 */
export function planEffect(db: Db, clock: Clock, lease: Lease, tool: Pick<EffectTool, 'name' | 'supportsIdempotency'>, step: EffectStep): ExternalEffectRow {
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    assertLeaseHeld(tx, lease, now, 'plan external effect');
    const key = effectKeyOf(lease.taskId, step.stepId, step.request);
    const existing = tx.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE effect_key = ?', [key]);
    if (!existing) {
      const id = `effect-${randomUUID()}`;
      tx.run(
        `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
        [id, key, lease.taskId, lease.runId, tool.name, step.action, step.target, sha256(canonicalJson(step.request)),
          tool.supportsIdempotency ? 1 : 0, now],
      );
      return tx.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE id = ?', [id])!;
    }
    if (existing.task_run_id !== lease.runId) {
      if (existing.state === 'dispatched') {
        transitionEffect(tx, { effectId: existing.id, from: 'dispatched', to: 'unknown', by: 'system', now, set: { task_run_id: lease.runId } });
      } else if (existing.state !== 'confirmed' && existing.state !== 'compensated') {
        tx.run('UPDATE external_effect SET task_run_id = ? WHERE id = ?', [lease.runId, existing.id]);
      }
    } else if (existing.state === 'dispatched') {
      throw new StaleStateError(`external effect ${existing.id} is already being dispatched by this run`);
    }
    return tx.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE id = ?', [existing.id])!;
  });
}

export type DispatchStart = { started: true } | { started: false; reason: string; runStopped: boolean };

/**
 * 전송 직전: 펜싱 + heartbeat + 정책 재검증 + `planned|unknown|failed → dispatched` 를 한 트랜잭션에서 (recovery §2 규칙 2).
 * `unknown` 에서의 재전송은 멱등 지원 도구만, `failed` 에서의 재전송은 정책이 허용할 때만 한다.
 * 정책이 거부하면 보내지 않는다: 처음 전송·같은 키 재전송이면 run 을 멈추고(`runStopped`), `failed` 재전송이면 그대로 둔다.
 * 펜싱에 실패하면 LeaseLostError 이고 호출자는 보내지 않는다.
 */
export function beginDispatch(
  db: Db, clock: Clock, lease: Lease, effect: Pick<ExternalEffectRow, 'id' | 'state' | 'supports_idempotency' | 'tool' | 'action' | 'target'>,
  gate: TaskPolicyGate,
): DispatchStart {
  if (effect.state === 'unknown' && Number(effect.supports_idempotency) !== 1) {
    throw new Error(`external effect ${effect.id}: resending an 'unknown' effect is forbidden for tools without idempotency keys`);
  }
  const kinds: Partial<Record<ExternalEffectRow['state'], EffectDispatchKind>> = { planned: 'first', unknown: 'retry_unknown', failed: 'resend_failed' };
  const dispatch = kinds[effect.state];
  if (dispatch === undefined) throw new Error(`external effect ${effect.id}: cannot dispatch from '${effect.state}'`);
  return db.writeTx((tx) => {
    heartbeatInTx(tx, clock, lease);
    const now = clock.nowIso();
    const task = tx.get<TaskRow>('SELECT * FROM task WHERE id = ?', [lease.taskId])!;
    const verdict = gate.beforeEffect(tx, {
      task, spec: JSON.parse(task.spec) as TaskSpec, runId: lease.runId, tool: effect.tool, action: effect.action, target: effect.target,
      dispatch, now,
    });
    if (verdict.decision !== 'allow') {
      if (dispatch === 'resend_failed') return { started: false, reason: verdict.reason, runStopped: false };
      stopRunForReview(tx, lease, now, verdict.reason);
      return { started: false, reason: verdict.reason, runStopped: true };
    }
    transitionEffect(tx, { effectId: effect.id, from: effect.state, to: 'dispatched', by: 'system', now });
    return { started: true };
  });
}

/** 전송 결과 기록 (펜싱). lease 를 잃었으면 기록하지 않는다 — 인수한 워커가 `dispatched` 를 §3 절차로 처리한다. */
export function recordDispatchResult(
  db: Db, clock: Clock, lease: Lease, effectId: string, result: EffectSendResult | { status: 'unknown' },
): void {
  db.writeTx((tx) => {
    const now = clock.nowIso();
    assertLeaseHeld(tx, lease, now, 'record external effect result');
    if (result.status === 'unknown') {
      transitionEffect(tx, { effectId, from: 'dispatched', to: 'unknown', by: 'system', now });
    } else {
      transitionEffect(tx, { effectId, from: 'dispatched', to: result.status, by: 'system', now, set: { response_ref: result.responseRef } });
    }
  });
}

/** 외부 조회로 전달이 확인된 `unknown` 을 confirmed 로 (펜싱). */
export function confirmByLookup(db: Db, clock: Clock, lease: Lease, effectId: string, responseRef: string | null): void {
  db.writeTx((tx) => {
    const now = clock.nowIso();
    assertLeaseHeld(tx, lease, now, 'confirm external effect');
    transitionEffect(tx, { effectId, from: 'unknown', to: 'confirmed', by: 'system', now, set: { response_ref: responseRef } });
  });
}

/**
 * 부작용 한 건을 §3 규칙대로 수행한다: 기록 → (필요하면 조회) → 펜싱·정책 재검증 후 전송 → 결과 기록.
 * lease 를 잃으면 LeaseLostError, 정책이 처음 전송을 거부하면 EffectRefusedError 를 던지고, 그 뒤로는 아무것도 보내지 않는다.
 */
export async function performEffect(
  db: Db, clock: Clock, lease: Lease, tool: EffectTool, step: EffectStep, gate: TaskPolicyGate,
): Promise<EffectOutcome> {
  let effect = planEffect(db, clock, lease, tool, step);

  switch (effect.state) {
    case 'confirmed':
      return { state: 'confirmed', effectId: effect.id, responseRef: effect.response_ref, reused: true };
    case 'compensated':
      return { state: 'compensated', effectId: effect.id };
    case 'unknown': {
      if (tool.lookup) {
        const found = await tool.lookup(effect.effect_key);
        if (found.found) {
          confirmByLookup(db, clock, lease, effect.id, found.responseRef);
          return { state: 'confirmed', effectId: effect.id, responseRef: found.responseRef, reused: true };
        }
      }
      if (Number(effect.supports_idempotency) !== 1) return { state: 'unknown', effectId: effect.id };
      break;
    }
    default:
      break;
  }

  const start = beginDispatch(db, clock, lease, effect, gate);
  if (!start.started) {
    if (!start.runStopped) return { state: 'failed', effectId: effect.id, reused: true };
    throw new EffectRefusedError(effect.id, start.reason);
  }
  let result: EffectSendResult | { status: 'unknown' };
  try {
    result = await tool.send({ effectKey: effect.effect_key, action: step.action, target: step.target, request: step.request });
  } catch {
    result = { status: 'unknown' };
  }
  recordDispatchResult(db, clock, lease, effect.id, result);
  effect = { ...effect, state: result.status };
  if (result.status === 'confirmed') return { state: 'confirmed', effectId: effect.id, responseRef: result.responseRef, reused: false };
  if (result.status === 'failed') return { state: 'failed', effectId: effect.id, reused: false };
  return { state: 'unknown', effectId: effect.id };
}
