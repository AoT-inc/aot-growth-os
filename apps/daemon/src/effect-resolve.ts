// 효과 해소 채널: 사람 승인 채널(Unix 소켓, trust-boundaries §3.1)에 얹은 `effects`·`resolve-effect` 명령.
// 응답을 잃어 `unknown` 이 된 external_effect 를 사람이 바깥을 확인한 뒤 confirmed / failed 로 확정한다(task-engine 의 `resolveUnknownEffect`).
// 소켓 처리기 조합(assemble.ts)이 이 두 명령을 가장 먼저 여기로 보내고 나머지는 측정·실험 채널·승인 엔진으로 넘긴다.
//
// 인증 경계: 승인 CLI 와 같다 — 소켓 파일 권한(0700 디렉터리 + 0600 소켓, 다른 UID 는 접속 불가)과 요청의 actor 가 `actor.kind='human'` 인지 확인.
//   confirmed: 사람 1인 + 메모. TOTP 는 요구하지 않고, 보내도 무시한다(검사도 하지 않는다).
//   failed: 위의 것에 TOTP 재인증이 무조건 더 붙는다(다시 보내도 된다는 결정이라 되돌리기 어렵다). 재인증은 승인 엔진의 `reauthenticateInTx` 를 주입받아
//     해소와 같은 write 트랜잭션 안에서 한다 — release 와 같은 연속 실패 잠금을 공유하고, 목적은 `effect-resolve:<효과 id>:failed`.
//     risky_change.reauth_before_effect 와는 무관하다(그 플래그는 승인 → cooldown → release 흐름의 것). cooldown·min_approvers 는 적용하지 않는다(승인 행이 필요한데
//     approval.subject_kind 에 external_effect 가 없다. 실제 재전송은 여전히 정책의 resend_failed 판정을 거친다).
//   에이전트는 컨테이너 안에서 돌며 소켓이 보이지 않는다(Q26). task-engine 이 사람 actor 를 한 번 더 확인한다.
// apps/daemon 은 task-engine 과 policy 를 조립하는 자리라 둘 다 가져온다. task-engine 은 policy 를 모르므로 재인증은 `authorize` 콜백으로 주입하고, 여기서 오류를 코드로 옮긴다.
//
// 요청 (한 줄 JSON, 허용 키: cmd, actor, effect_id, outcome, note, totp. 그 밖의 키는 invalid_request):
//   {cmd:'effects', actor}                                              → unknown 효과 목록 (읽기 전용)
//   {cmd:'resolve-effect', actor, effect_id, outcome:'confirmed'|'failed', note, totp?}
// 응답: {ok:true, ...} 또는 {ok:false, code, error, ...extra}. 코드: invalid_request, unknown_actor, not_human, invalid_outcome, note_required, note_too_long,
//   not_found, key_in_use, resolved_before, outcome_conflict, not_unknown, run_active, reauth_required, reauth_failed, reauth_locked, reauth_reused, reauth_unavailable.
// 응답과 목록에는 effect_key·요청 본문·TOTP 코드가 나오지 않는다. `effects` 목록에는 response_ref·메모도 없다
// (resolve-effect 의 applied:true 응답은 response_ref 를 돌려준다: 설계상 그렇다).
import { ApprovalRefusedError, ReauthError, ReauthRefusedError, TotpSecretError } from '@aot/policy';
import type { Clock, Db } from '@aot/domain';
import { EffectResolutionError, listUnresolvedEffects, resolveUnknownEffect, type EffectResolutionOutcome } from '@aot/task-engine';

export const EFFECT_COMMANDS = ['effects', 'resolve-effect'] as const;

/** failed 해소의 재인증 목적 (human_reauth.purpose). `release:` 로 시작하지 않아야 한다 */
export const effectResolvePurpose = (effectId: string): string => `effect-resolve:${effectId}:failed`;

export interface EffectResolutionChannelOptions {
  db: Db;
  clock: Clock;
  /** = `ApprovalEngine.reauthenticateInTx` (호출자의 write 트랜잭션 안에서 TOTP 재인증, 실패하면 던진다) */
  reauth: (tx: Db, actorId: string, code: string | undefined, purpose: string) => void;
}

/** 이 요청이 효과 해소 명령인가 (소켓 처리기 조합이 고르는 기준) */
export function isEffectResolutionCommand(request: unknown): boolean {
  return typeof request === 'object' && request !== null && !Array.isArray(request)
    && (EFFECT_COMMANDS as readonly unknown[]).includes((request as Record<string, unknown>)['cmd']);
}

const KEYS = ['cmd', 'actor', 'effect_id', 'outcome', 'note', 'totp'];

const refused = (code: string, error: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ok: false, code, error, ...extra });

function requireHuman(db: Db, actorId: unknown): Record<string, unknown> | string {
  if (typeof actorId !== 'string' || actorId === '') return refused('unknown_actor', 'an actor id is required');
  const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId]);
  if (!actor) return refused('unknown_actor', `unknown actor '${actorId}'`);
  if (actor.kind !== 'human') return refused('not_human', `only human actors can use the effect resolution channel; '${actorId}' is '${actor.kind}'`);
  return actorId;
}

export function createEffectResolutionHandler(options: EffectResolutionChannelOptions): (request: unknown) => Record<string, unknown> {
  return (raw) => {
    const request = raw as Record<string, unknown>;
    const actor = requireHuman(options.db, request['actor']);
    if (typeof actor !== 'string') return actor;
    const unknown = Object.keys(request).filter((key) => !KEYS.includes(key));
    if (unknown.length > 0) return refused('invalid_request', `unknown field(s): ${unknown.join(', ')}`);

    if (request['cmd'] === 'effects') {
      if (['effect_id', 'outcome', 'note', 'totp'].some((key) => request[key] !== undefined)) return refused('invalid_request', 'effects takes no arguments');
      const now = options.clock.nowIso();
      return {
        ok: true,
        now,
        effects: listUnresolvedEffects(options.db, now).map((e) => ({
          effect_id: e.effectId, task_id: e.taskId, task_status: e.taskStatus, task_run_id: e.taskRunId, tool: e.tool, action: e.action, target: e.target,
          request_hash: e.requestHash, planned_at: e.plannedAt, last_transition_at: e.lastTransitionAt, supports_idempotency: e.supportsIdempotency,
          resend_window_open: e.resendWindowOpen, run_active: e.runActive, resolved_before: e.resolvedBefore,
        })),
      };
    }

    const effectId = request['effect_id'];
    const totp = request['totp'];
    if (totp !== undefined && typeof totp !== 'string') return refused('invalid_request', 'totp must be a string');
    try {
      const result = resolveUnknownEffect(options.db, { clock: options.clock }, {
        effectId: effectId as string,
        actorId: actor,
        outcome: request['outcome'] as EffectResolutionOutcome,
        note: request['note'] as string,
        // 재인증은 failed 에만 붙는다. confirmed 는 totp 를 보지도 않는다
        ...(request['outcome'] === 'failed'
          ? { authorize: (tx: Db) => options.reauth(tx, actor, totp, effectResolvePurpose(effectId as string)) }
          : {}),
      });
      if (!result.applied) {
        return {
          ok: true, applied: false, effect_id: result.effectId, task_id: result.taskId, state: result.state, outcome: result.outcome, event_id: result.eventId,
          key: result.key, resolved_by: result.resolvedBy, resolved_at: result.resolvedAt, note: result.note,
        };
      }
      return {
        ok: true, applied: true, effect_id: result.effectId, task_id: result.taskId, task_status: result.taskStatus, previous_state: result.previousState,
        state: result.state, event_id: result.eventId, key: result.key, response_ref: result.responseRef,
      };
    } catch (error) {
      if (error instanceof EffectResolutionError) return refused(error.code, error.message, error.extra);
      if (error instanceof ReauthRefusedError) return refused(error.code, error.message);
      if (error instanceof ReauthError) return refused('reauth_reused', error.message);
      if (error instanceof TotpSecretError) return refused('reauth_unavailable', error.message);
      if (error instanceof ApprovalRefusedError) return refused('not_human', error.message);
      throw error;
    }
  };
}
