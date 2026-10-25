// 전화 부작용 도구 (ADR-0014 §2): task-engine 의 부작용 원장(performEffect)이 부르는 도구. provider 호출은 여기서만 일어난다.
// 원장이 먼저 `planned → dispatched` 를 펜싱·정책 재검증과 한 트랜잭션에서 기록한 뒤에 send 를 부른다.
//  - phone_call.call      : Call 행을 만들고(같은 effect_key 면 같은 Call) provider 에 발신을 접수시킨다. `supportsIdempotency=false`: 응답을 잃으면 `unknown` 이고
//                           자동 재전송하지 않는다(전화를 두 번 거는 것이 더 나쁘다). lookup 은 effect_key 로 만든 Call 이 provider 에 접수됐는지 본다
//  - phone_transfer.transfer: 연결된 통화를 사람에게 넘긴다. 성공하면 `phone.call.transferred` 로 Call 상태에 반영한다
//  - phone_hangup.hangup  : 통화를 끊는다. 끊기는 여러 번 해도 같아서 멱등이다(`supportsIdempotency=true`). 종료는 provider 의 이벤트가 반영한다
// provider 가 요청을 처리하지 않았음이 확실한 오류(PhoneProviderError.definite)만 `failed` 로, 그 밖의 예외는 던져서 원장이 `unknown` 으로 기록한다.
import {
  applyPhoneEvent, callIntentKey, createOutboundCall, findSameIntentCall, getCallRow, isE164, PhoneProviderError,
  type CallRow, type Clock, type Db, type PhoneFailureCode, type PhonePort,
} from '@aot/domain';


/** task-engine 의 EffectTool 과 구조가 같다 (agent-runtime 은 task-engine 을 import 하지 않는다 — 구조적 타입으로 만난다) */
export interface PhoneEffectTool {
  readonly name: string;
  readonly supportsIdempotency: boolean;
  send(call: { effectKey: string; action: string; target: string; request: unknown }): Promise<{ status: 'confirmed' | 'failed'; responseRef: string | null }>;
  lookup?: (effectKey: string) => Promise<{ found: true; responseRef: string | null } | { found: false }>;
}

export interface PhoneEffectToolsOptions {
  db: Db;
  clock: Clock;
  port: PhonePort;
}

interface CallRequest {
  to: string;
  from: string | null;
  objective: string;
  context: Record<string, unknown>;
  maxDurationSeconds: number;
  allowTransfer: boolean;
  recording: boolean;
}

const isCallRequest = (value: unknown): value is CallRequest => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isE164(v['to']) && typeof v['objective'] === 'string' && typeof v['maxDurationSeconds'] === 'number' && typeof v['context'] === 'object' && v['context'] !== null;
};

const failureCodeOf = (error: PhoneProviderError): PhoneFailureCode => (error.code === 'invalid_request' ? 'rejected' : 'provider_error');

/** 이 부작용을 보내는 run 의 정보. 원장 행이 정본이다(인수한 run 으로 갱신된다) */
function runOf(db: Db, effectKey: string): { taskId: string; runId: string; actorId: string | null; orgUnitId: string | null } {
  const row = db.get<{ task_id: string; task_run_id: string; actor_id: string | null; org_unit_id: string | null }>(
    `SELECT e.task_id AS task_id, e.task_run_id AS task_run_id, r.actor_id AS actor_id, t.org_unit_id AS org_unit_id
     FROM external_effect e JOIN task_run r ON r.id = e.task_run_id JOIN task t ON t.id = e.task_id WHERE e.effect_key = ?`, [effectKey],
  );
  if (!row) throw new Error('no external_effect row for this effect key: phone tools run only through the effect ledger');
  return { taskId: row.task_id, runId: row.task_run_id, actorId: row.actor_id, orgUnitId: row.org_unit_id };
}

export function createPhoneEffectTools(options: PhoneEffectToolsOptions): Record<'phone_call' | 'phone_transfer' | 'phone_hangup', PhoneEffectTool> {
  const { db, clock, port } = options;

  const phoneCall: PhoneEffectTool = {
    name: 'phone_call',
    supportsIdempotency: false,
    async send(call) {
      if (!isCallRequest(call.request)) throw new Error('phone_call: malformed request');
      const request = call.request;
      const run = runOf(db, call.effectKey);
      // 같은 의도(번호·목적·맥락)의 통화가 이 업무에 이미 있으면(실패·취소 제외) 새로 걸지 않고 그 통화를 돌려준다.
      // 정책이 바뀌어 effect_key 가 달라진 재요청이 같은 사람에게 전화를 두 번 걸지 못하게 하는 두 번째 방어선이다.
      const intentKey = callIntentKey(request.to, request.objective, request.context);
      const same = findSameIntentCall(db, run.taskId, intentKey, call.effectKey);
      if (same) return { status: 'confirmed', responseRef: same.id };

      const { call: row } = createOutboundCall(db, clock, {
        provider: port.name, to: request.to, from: request.from, taskId: run.taskId, taskRunId: run.runId, actorId: run.actorId, orgUnitId: run.orgUnitId,
        objective: request.objective, effectKey: call.effectKey, intentKey, maxDurationSeconds: request.maxDurationSeconds, allowTransfer: request.allowTransfer, recording: request.recording,
      });
      if (row.providerCallId !== null) return { status: 'confirmed', responseRef: row.id }; // 이미 접수됨
      try {
        const accepted = await port.startCall({
          callId: row.id, effectKey: call.effectKey, to: request.to, from: request.from, objective: request.objective, context: request.context,
          maxDurationSeconds: request.maxDurationSeconds, allowTransfer: request.allowTransfer, recording: request.recording,
        });
        applyPhoneEvent(db, clock, {
          type: 'phone.call.initiated', eventId: `accepted:${call.effectKey}`, provider: port.name, providerCallId: accepted.providerCallId, callId: row.id, occurredAt: clock.nowIso(),
        });
        return { status: 'confirmed', responseRef: row.id };
      } catch (error) {
        if (error instanceof PhoneProviderError && error.definite) {
          applyPhoneEvent(db, clock, {
            type: 'phone.call.failed', eventId: `refused:${call.effectKey}`, provider: 'aot', providerCallId: null, callId: row.id, occurredAt: clock.nowIso(),
            code: failureCodeOf(error), reason: error.code,
          });
          return { status: 'failed', responseRef: row.id };
        }
        throw error; // 도달 여부를 알 수 없다 → 원장이 unknown 으로 기록한다
      }
    },
    lookup(effectKey) {
      const row = db.get<CallRow>('SELECT * FROM call WHERE effect_key = ?', [effectKey]);
      return Promise.resolve(row && row.provider_call_id !== null ? { found: true, responseRef: row.id } : { found: false });
    },
  };

  const providerRef = (callId: string): { row: CallRow; providerCallId: string } => {
    const row = getCallRow(db, callId);
    if (!row?.provider_call_id) throw new Error('the call has not been accepted by the provider');
    return { row, providerCallId: row.provider_call_id };
  };

  const phoneTransfer: PhoneEffectTool = {
    name: 'phone_transfer',
    supportsIdempotency: false,
    async send(call) {
      const request = call.request as { callId?: unknown; to?: unknown; reason?: unknown };
      if (typeof request.callId !== 'string' || !isE164(request.to)) throw new Error('phone_transfer: malformed request');
      const { row, providerCallId } = providerRef(request.callId);
      try {
        await port.transfer(providerCallId, { to: request.to, ...(typeof request.reason === 'string' ? { reason: request.reason } : {}) });
      } catch (error) {
        if (error instanceof PhoneProviderError && error.definite) return { status: 'failed', responseRef: row.id };
        throw error;
      }
      applyPhoneEvent(db, clock, {
        type: 'phone.call.transferred', eventId: `transfer:${call.effectKey}`, provider: port.name, providerCallId, callId: row.id, occurredAt: clock.nowIso(), target: request.to,
      });
      return { status: 'confirmed', responseRef: row.id };
    },
    /**
     * 응답을 잃은 전환(`unknown`)이 실제로 일어났는지 본다: provider 의 상태 이벤트가 이미 이 업무의 통화를 `transferred` 로 옮겼으면 확인된 것이다.
     * 통화는 한 번만 전환될 수 있으므로(`connected → transferred`) 업무에 전환된 통화가 정확히 하나일 때만 확인으로 본다. 그 밖에는 "알 수 없음"이고,
     * 멱등 키가 없는 도구라 자동으로 다시 전환하지 않는다(사람이 본다).
     */
    lookup(effectKey) {
      const effect = db.get<{ task_id: string }>('SELECT task_id FROM external_effect WHERE effect_key = ?', [effectKey]);
      if (!effect) return Promise.resolve({ found: false });
      const moved = db.all<{ id: string }>(
        "SELECT DISTINCT c.id AS id FROM call c JOIN event e ON e.external_id = c.id AND e.type = 'phone.call.transferred' WHERE c.task_id = ?", [effect.task_id],
      );
      return Promise.resolve(moved.length === 1 ? { found: true, responseRef: moved[0]!.id } : { found: false });
    },
  };

  const phoneHangup: PhoneEffectTool = {
    name: 'phone_hangup',
    supportsIdempotency: true,
    async send(call) {
      const request = call.request as { callId?: unknown };
      if (typeof request.callId !== 'string') throw new Error('phone_hangup: malformed request');
      const { row, providerCallId } = providerRef(request.callId);
      try {
        await port.hangup(providerCallId);
      } catch (error) {
        if (error instanceof PhoneProviderError && error.definite) {
          if (error.code === 'not_found') return { status: 'confirmed', responseRef: row.id }; // 이미 끝난 통화
          return { status: 'failed', responseRef: row.id };
        }
        throw error;
      }
      return { status: 'confirmed', responseRef: row.id };
    },
  };

  return { phone_call: phoneCall, phone_transfer: phoneTransfer, phone_hangup: phoneHangup };
}

