// 사람의 external_effect `unknown` 해소 (resolveUnknownEffect / listUnresolvedEffects).
// 응답을 잃어 효과가 `unknown` 이 되면 submitRun 이 업무를 needs_review 로 보낸다. 엔진은 보냈는지 알 수 없어 자동으로 닫지 못하므로,
// 사람이 바깥(수신함, 외부 서비스 화면)을 확인하고 `confirmed`(보냈다) 또는 `failed`(보내지 않았다)로 확정한다. 업무 상태는 바꾸지 않는다:
// 해소 뒤에 업무를 다시 queued 로 올리는 것은 기존 승인 경로의 몫이고, 다음 run 은 확정된 행을 보고 이어간다
// (confirmed → 재전송 없이 재사용, failed → 정책 게이트의 `resend_failed` 판정을 거쳐 재전송).
//
// 한 `Db.writeTx` 에서 (검사 → authorize → 효과 전이 → 이벤트 INSERT) 가 전부 되거나 전혀 안 된다.
//   ① external_effect: unknown → confirmed|failed (by 'human'). confirmed 면 response_ref = `human:<event id>`. 다른 열은 그대로.
//   ② event: source='effect-resolution', type='external_effect.resolved', idempotency_key = `effect-resolve:<effect id>`, id 는 키의 해시(결정적).
//      payload 에 누가·무엇을·왜(메모)·재인증 방식만 남긴다. TOTP 코드·시간창·요청 본문·effect_key 는 남기지 않는다.
//   task, task_transition, task_run, approval, policy_decision, cost_entry 는 쓰지 않는다.
// 인증 경계: 사람 actor(`actor.kind='human'`)만. 채널(apps/daemon)이 소켓 권한과 같은 확인을 하고 이 함수가 트랜잭션 안에서 한 번 더 본다.
// failed 의 TOTP 재인증은 이 패키지가 모른다(@aot/policy 와 서로 모른다): 호출자가 `authorize` 를 주면 모든 검사가 통과한 뒤 첫 쓰기 전에
// 같은 트랜잭션 안에서 한 번 부른다. 던지면 그 오류가 그대로 나가고 트랜잭션이 되돌려진다(재인증 행도 함께).
//
// 검사 순서(앞이 우선): 입력(outcome → effectId → note) → 행위자 → 행 존재 → 같은 키의 이벤트(key_in_use / resolved_before / outcome_conflict / 재생)
//   → 상태 unknown → 만든 run 이 끝났는가 → failed 의 authorize → 전이 → 이벤트.
// 같은 결정을 되풀이하면 아무것도 쓰지 않고 처음 기록을 돌려준다(`applied: false`, authorize 도 부르지 않는다 = TOTP 를 다시 쓰지 않는다).
// 키가 효과마다 하나라서 해소는 효과당 한 번만 기록된다: 해소 뒤 재전송이 또 unknown 이 되면 `resolved_before` 로 거부한다(열린 항목).
import { sha256Hex, isNonBlankString, type Clock, type Db, type ExternalEffectRow, type ExternalEffectState, type TaskStatus } from '@aot/domain';

import { EffectResolutionError, StaleStateError } from './errors.ts';
import { resendAllowed } from './idempotency.ts';
import { transitionEffect } from './transitions.ts';

export const EFFECT_RESOLUTION_OUTCOMES = ['confirmed', 'failed'] as const;
export type EffectResolutionOutcome = (typeof EFFECT_RESOLUTION_OUTCOMES)[number];
export const EFFECT_RESOLUTION_EVENT = { source: 'effect-resolution', type: 'external_effect.resolved' } as const;
export const EFFECT_RESOLUTION_KEY_PREFIX = 'effect-resolve:';
export const MAX_RESOLUTION_NOTE_CHARS = 1000;

/** 해소 이벤트의 멱등 키 (= event.idempotency_key). 효과마다 하나 */
export const effectResolutionKey = (effectId: string): string => `${EFFECT_RESOLUTION_KEY_PREFIX}${effectId}`;

/** 해소 이벤트의 id: 키의 해시라 같은 효과면 언제나 같다 (`response_ref` 의 `human:<id>` 가 여기를 가리킨다) */
export const effectResolutionEventId = (effectId: string): string => `event-${sha256Hex(effectResolutionKey(effectId)).slice(0, 32)}`;

export interface ResolveEffectInput {
  effectId: string;
  /** 해소하는 사람. `actor.kind='human'` 이어야 한다 */
  actorId: string;
  outcome: EffectResolutionOutcome;
  /** 사유 메모. 앞뒤 공백을 자른 뒤 비어 있지 않고 MAX_RESOLUTION_NOTE_CHARS 이하 */
  note: string;
  /**
   * 모든 상태 검사를 통과한 뒤, 다른 쓰기 전에 write 트랜잭션 안에서 한 번 부른다. 던지면 거부(오류는 그대로 전파, 트랜잭션 롤백).
   * outcome 이 'failed' 이면 필수(없으면 `reauth_required`). 주면 어느 결과에든 정확히 한 번 불린다(데몬은 failed 에만 준다).
   * 검사에서 거부되거나 재생(`applied: false`)이면 부르지 않는다.
   */
  authorize?: (tx: Db, effect: ExternalEffectRow) => void;
}

export interface ResolveEffectContext {
  clock: Clock;
}

export type ResolveEffectResult =
  | {
    applied: true; effectId: string; taskId: string; taskStatus: TaskStatus; previousState: 'unknown'; state: EffectResolutionOutcome;
    eventId: string; key: string; responseRef: string | null;
  }
  | {
    applied: false; effectId: string; taskId: string; state: ExternalEffectState; outcome: EffectResolutionOutcome;
    eventId: string; key: string; resolvedBy: string; resolvedAt: string; note: string;
  };

interface ResolutionPayload {
  outcome: EffectResolutionOutcome;
  actor_id: string;
  resolved_at: string;
  note: string;
}

const refuse = (code: ConstructorParameters<typeof EffectResolutionError>[0], message: string, extra: Record<string, unknown> = {}): never => {
  throw new EffectResolutionError(code, message, extra);
};

/**
 * `unknown` 효과 하나를 사람이 확정한다. 거부는 모두 `EffectResolutionError`(사유 코드, 필요하면 extra) 이거나 `authorize` 가 던진 값 그대로다.
 */
export function resolveUnknownEffect(db: Db, context: ResolveEffectContext, input: ResolveEffectInput): ResolveEffectResult {
  // 1. 입력 (트랜잭션 전): outcome → effectId → note
  if (!(EFFECT_RESOLUTION_OUTCOMES as readonly unknown[]).includes(input.outcome)) {
    refuse('invalid_outcome', `outcome must be one of ${EFFECT_RESOLUTION_OUTCOMES.join('|')}`);
  }
  if (!isNonBlankString(input.effectId)) refuse('invalid_request', 'an effect id is required');
  if (typeof input.note !== 'string' || input.note.trim() === '') refuse('note_required', 'a note saying what was checked is required');
  const note = input.note.trim();
  if (note.length > MAX_RESOLUTION_NOTE_CHARS) refuse('note_too_long', `the note is at most ${MAX_RESOLUTION_NOTE_CHARS} characters`);
  const { effectId, outcome, actorId } = input;
  const key = effectResolutionKey(effectId);
  const eventId = effectResolutionEventId(effectId);

  return db.writeTx((tx): ResolveEffectResult => {
    // 2. 행위자
    const actor = typeof actorId === 'string' ? tx.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId]) : undefined;
    if (!actor) return refuse('unknown_actor', `unknown actor '${String(actorId)}'`);
    if (actor.kind !== 'human') return refuse('not_human', `only human actors can resolve an effect; '${actorId}' is '${actor.kind}'`);

    // 3. 행
    const row = tx.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE id = ?', [effectId]);
    if (!row) return refuse('not_found', `external effect '${effectId}' does not exist`);

    // 4. 같은 키의 이벤트
    const prior = tx.get<{ source: string; type: string; payload: string }>('SELECT source, type, payload FROM event WHERE idempotency_key = ?', [key]);
    if (prior) {
      if (prior.source !== EFFECT_RESOLUTION_EVENT.source || prior.type !== EFFECT_RESOLUTION_EVENT.type) {
        return refuse('key_in_use', `the key ${key} is already used by an event that is not an effect resolution`);
      }
      const recorded = JSON.parse(prior.payload) as ResolutionPayload;
      const resolved = { outcome: recorded.outcome, by: recorded.actor_id, at: recorded.resolved_at };
      if (row.state === 'unknown') {
        return refuse('resolved_before', `effect '${effectId}' was resolved as ${recorded.outcome} before and is unknown again; a second human resolution is not supported`, { resolved });
      }
      if (recorded.outcome !== outcome) {
        return refuse('outcome_conflict', `effect '${effectId}' was already resolved as ${recorded.outcome}; it is not overwritten`, { resolved });
      }
      return {
        applied: false, effectId, taskId: row.task_id, state: row.state, outcome: recorded.outcome, eventId, key,
        resolvedBy: recorded.actor_id, resolvedAt: recorded.resolved_at, note: recorded.note,
      };
    }

    // 5. 상태
    if (row.state !== 'unknown') return refuse('not_unknown', `effect '${effectId}' is '${row.state}', not 'unknown'`, { state: row.state });

    // 6. 업무의 run 이 아직 열려 있으면 실행 중인 쪽이 행을 다시 쓸 수 있다
    const open = tx.get<{ id: string }>('SELECT id FROM task_run WHERE task_id = ? AND outcome IS NULL ORDER BY started_at, id LIMIT 1', [row.task_id]);
    if (open) return refuse('run_active', `task '${row.task_id}' has an open run '${open.id}'; resolve after it has ended`, { task_run_id: open.id });

    // 7. 재인증 (failed 는 필수)
    if (outcome === 'failed' && input.authorize === undefined) return refuse('reauth_required', 'resolving an effect as failed needs re-authentication');
    input.authorize?.(tx, row);

    // 8. 효과 전이
    const now = context.clock.nowIso();
    const responseRef = outcome === 'confirmed' ? `human:${eventId}` : null;
    try {
      transitionEffect(tx, {
        effectId, from: 'unknown', to: outcome, by: 'human', now, ...(responseRef === null ? {} : { set: { response_ref: responseRef } }),
      });
    } catch (error) {
      if (error instanceof StaleStateError) return refuse('not_unknown', `effect '${effectId}' is no longer 'unknown'`, { state: tx.get<{ state: string }>('SELECT state FROM external_effect WHERE id = ?', [effectId])?.state ?? null });
      throw error;
    }

    // 9. 이벤트
    const task = tx.get<{ status: TaskStatus; product_id: string | null }>('SELECT status, product_id FROM task WHERE id = ?', [row.task_id])!;
    const payload = {
      effect_id: effectId, task_id: row.task_id, task_run_id: row.task_run_id, tool: row.tool, action: row.action, target: row.target,
      request_hash: row.request_hash, previous_state: 'unknown', outcome, previous_response_ref: row.response_ref, response_ref: responseRef,
      actor_id: actorId, note, resolved_at: now, reauth: outcome === 'failed' ? 'totp' : null,
    };
    tx.run(
      `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, EFFECT_RESOLUTION_EVENT.source, effectId, EFFECT_RESOLUTION_EVENT.type, JSON.stringify(payload), task.product_id, key, now, now],
    );
    return { applied: true, effectId, taskId: row.task_id, taskStatus: task.status, previousState: 'unknown', state: outcome, eventId, key, responseRef };
  });
}

export interface UnresolvedEffect {
  effectId: string;
  taskId: string;
  taskStatus: TaskStatus;
  taskRunId: string;
  tool: string;
  action: string;
  target: string;
  requestHash: string;
  plannedAt: string;
  /** external_effect.at (마지막 상태 전이 시각) */
  lastTransitionAt: string;
  supportsIdempotency: boolean;
  /** `resendAllowed(row, now)` — 행만 보는 순수 판정이다 (창을 닫지도 스냅숏을 바꾸지도 않는다) */
  resendWindowOpen: boolean;
  /** 업무에 아직 끝나지 않은 run 이 있다 (있으면 해소가 거부된다) */
  runActive: boolean;
  /** 같은 효과의 해소 기록이 이미 있다 (unknown 으로 돌아왔다) */
  resolvedBefore: boolean;
}

/** `unknown` 인 효과만 (planned_at, id 순). 읽기 전용: 요청 본문·effect_key·참조·메모는 담지 않는다 */
export function listUnresolvedEffects(db: Db, now: string): UnresolvedEffect[] {
  const rows = db.all<ExternalEffectRow & { task_status: TaskStatus; run_active: number; resolved_before: number }>(
    `SELECT e.*, t.status AS task_status,
            EXISTS (SELECT 1 FROM task_run r WHERE r.task_id = e.task_id AND r.outcome IS NULL) AS run_active,
            EXISTS (SELECT 1 FROM event v WHERE v.idempotency_key = ? || e.id AND v.source = ? AND v.type = ?) AS resolved_before
     FROM external_effect e JOIN task t ON t.id = e.task_id
     WHERE e.state = 'unknown'
     ORDER BY e.planned_at, e.id`,
    [EFFECT_RESOLUTION_KEY_PREFIX, EFFECT_RESOLUTION_EVENT.source, EFFECT_RESOLUTION_EVENT.type],
  );
  return rows.map((row) => ({
    effectId: row.id, taskId: row.task_id, taskStatus: row.task_status, taskRunId: row.task_run_id, tool: row.tool, action: row.action, target: row.target,
    requestHash: row.request_hash, plannedAt: row.planned_at, lastTransitionAt: row.at, supportsIdempotency: Number(row.supports_idempotency) === 1,
    resendWindowOpen: resendAllowed(row, now), runActive: Number(row.run_active) === 1, resolvedBefore: Number(row.resolved_before) === 1,
  }));
}
