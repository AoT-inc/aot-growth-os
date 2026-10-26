// PhoneCapability 구현 (ADR-0014 §1). 에이전트는 업무 의도만 표현하고, 이 모듈이 입력 검증 → 전화 정책 → 부작용 원장(performEffect)을 거쳐 통화를 접수시킨다.
// provider 이름을 모른다: 모든 provider 접근은 `PhonePort` 를 쓰는 부작용 도구(effect-tools.ts)가 한다. run 하나에 인스턴스 하나를 만든다(업무·주체가 run 별이다).
// `call` 은 CallHandle 을 바로 돌려준다. 통화가 끝나길 기다리지 않는다 — 결과는 webhook 이벤트가 Call 상태로 반영하고 업무 검증이 그것을 기다린다 (ADR-0014 §6).
import {
  applyPhoneEvent, callIntentKey, getCall, getCallRow, validateMakeCallInput, validateTransferInput,
  type Call, type CallHandle, type Clock, type Db, type Issue, type PhoneCallPolicy, type PhoneCapability,
} from '@aot/domain';

export type PhoneCapabilityErrorCode =
  | 'invalid_input'
  | 'policy_denied'
  | 'approval_required'
  | 'provider_failed'
  | 'outcome_unknown'
  | 'not_found'
  | 'not_allowed';

export class PhoneCapabilityError extends Error {
  readonly code: PhoneCapabilityErrorCode;
  constructor(code: PhoneCapabilityErrorCode, message: string) {
    super(message);
    this.name = 'PhoneCapabilityError';
    this.code = code;
  }
}

export interface PhoneEffectStep {
  stepId: string;
  action: string;
  target: string;
  request: unknown;
}

export interface PhoneEffectOutcome { state: 'confirmed' | 'failed' | 'unknown' | 'compensated'; effectId: string; responseRef?: string | null | undefined }

/**
 * 부작용 원장을 거쳐 도구를 실행하는 함수. 데몬 조립이 `RunContext.performEffect` 를 여기에 연결한다.
 * 게이트웨이용 실행기에서는 `noEffect` 가 있다: 외부 부작용 없이 끝나는 길(provider 에 닿지 않은 통화의 로컬 취소)을 원장 묶음에 밝힌다 (effect-ledger.ts)
 */
export type PhoneEffectRunner = ((tool: string, step: PhoneEffectStep) => Promise<PhoneEffectOutcome>) & { noEffect?: (reason: string) => void };

export interface PhoneCapabilityDeps {
  db: Db;
  clock: Clock;
  policy: PhoneCallPolicy;
  dispatch: PhoneEffectRunner;
  run: {
    taskId: string;
    runId: string | null;
    /** 정책 주체 `<role>@v<role_version>` */
    subject: string;
    /**
     * 명세 `allowed_tools` 의 전화 도구 `target` 목록(E.164 정확 일치 또는 끝이 `*` 인 접두어). 사람이 승인한 명세에 적힌 대상이므로 이 범위 밖으로는 걸 수 없다.
     * 목록이 비어 있으면 그 도구는 어느 번호에도 쓸 수 없다(기본 거부): 대상을 밝히지 않은 승인은 번호 범위를 승인한 것이 아니다
     */
    allowedTargets: { call: readonly string[]; transfer: readonly string[] };
  };
}

const issueText = (issues: readonly Issue[]): string => issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`).join('; ');

export function createPhoneCapability(deps: PhoneCapabilityDeps): PhoneCapability {
  const { db, clock, policy, dispatch, run } = deps;

  /** 이 run 의 업무에 속한 통화만 다룰 수 있다 (다른 업무의 통화는 존재하지 않는 것처럼 답한다) */
  function ownCall(callId: string): Call {
    const row = getCallRow(db, callId);
    if (!row || row.task_id !== run.taskId) throw new PhoneCapabilityError('not_found', `call '${callId}' does not exist for this task`);
    return getCall(db, callId);
  }

  async function judge(kind: 'call' | 'transfer', to: string, call: Parameters<PhoneCallPolicy['judge']>[0]['call'], callAllowsTransfer?: boolean) {
    const verdict = await policy.judge({ kind, runId: run.runId, taskId: run.taskId, subject: run.subject, to, call, callAllowsTransfer, now: clock.nowIso() });
    if (verdict.decision === 'deny') throw new PhoneCapabilityError('policy_denied', verdict.reason);
    if (verdict.decision === 'require_approval') throw new PhoneCapabilityError('approval_required', verdict.reason);
    return verdict.grant;
  }

  /** 부작용 원장에 기록하는 대상 = 이 번호를 허용하는 명세의 대상 선언(정책 재검증이 선언과 일치를 요구한다). 맞는 선언이 없으면 거부한다 */
  function ledgerTarget(kind: 'call' | 'transfer', to: string): string {
    const declared = run.allowedTargets[kind].find((pattern) => (pattern.endsWith('*') ? to.startsWith(pattern.slice(0, -1)) : pattern === to));
    if (declared === undefined) throw new PhoneCapabilityError('not_allowed', 'the number is outside the targets of the approved task (a phone tool without a declared target cannot be used)');
    return declared;
  }

  return {
    async call(raw): Promise<CallHandle> {
      const checked = validateMakeCallInput(raw);
      if (!checked.ok) throw new PhoneCapabilityError('invalid_input', issueText(checked.errors));
      const input = checked.value;
      const target = ledgerTarget('call', input.to);
      const grant = await judge('call', input.to, { from: input.from, objective: input.objective, constraints: input.constraints });
      const request = {
        to: input.to, from: grant.from, objective: input.objective, context: input.context ?? {},
        maxDurationSeconds: grant.maxDurationSeconds, allowTransfer: grant.allowTransfer, recording: grant.recording,
      };
      // 같은 의도(번호·목적·맥락)의 재요청은 같은 단계다: 재시도해도 같은 effect_key 가 나와 전화를 두 번 걸지 않는다
      const stepId = `phone.call:${callIntentKey(input.to, input.objective, input.context).slice(0, 24)}`;
      const outcome = await dispatch('phone_call', { stepId, action: 'call', target, request });
      return handleOf(outcome.state, outcome.responseRef, 'call');
    },

    getCall(callId): Promise<Call> {
      try {
        return Promise.resolve(ownCall(callId));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async transfer(raw): Promise<void> {
      const checked = validateTransferInput(raw);
      if (!checked.ok) throw new PhoneCapabilityError('invalid_input', issueText(checked.errors));
      const input = checked.value;
      const call = ownCall(input.callId);
      if (call.status !== 'connected') throw new PhoneCapabilityError('not_allowed', `call '${call.id}' is ${call.status}; only a connected call can be transferred`);
      await judge('transfer', input.to, null, call.allowTransfer);
      const target = ledgerTarget('transfer', input.to);
      const request = { callId: call.id, to: input.to, ...(input.reason === undefined ? {} : { reason: input.reason }) };
      const outcome = await dispatch('phone_transfer', { stepId: `phone.transfer:${call.id}:${callIntentKey(input.to, 'transfer', undefined).slice(0, 16)}`, action: 'transfer', target, request });
      handleOf(outcome.state, outcome.responseRef, 'transfer');
    },

    async hangup(callId): Promise<void> {
      const call = ownCall(callId);
      if (call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled') return; // 이미 끝났다 (멱등)
      if (call.status === 'queued' && call.providerCallId === null) {
        // provider 에 닿지 않은 통화는 provider 호출 없이 취소한다 (외부 부작용이 없다 — 원장 묶음에 그 사실을 밝힌다)
        dispatch.noEffect?.('cancelled before dialing');
        applyPhoneEvent(db, clock, {
          type: 'phone.call.cancelled', eventId: `cancel:${call.id}`, provider: 'aot', providerCallId: null, callId: call.id, occurredAt: clock.nowIso(), reason: 'cancelled before dialing',
        });
        return;
      }
      const outcome = await dispatch('phone_hangup', { stepId: `phone.hangup:${call.id}`, action: 'hangup', target: call.id, request: { callId: call.id } });
      handleOf(outcome.state, outcome.responseRef, 'hangup');
    },
  };
}

function handleOf(state: 'confirmed' | 'failed' | 'unknown' | 'compensated', responseRef: string | null | undefined, what: string): CallHandle {
  switch (state) {
    case 'confirmed':
      if (responseRef === null || responseRef === undefined) throw new PhoneCapabilityError('provider_failed', `${what}: the provider accepted the request but no call reference was recorded`);
      return { callId: responseRef, status: 'initiated', providerCallId: null };
    case 'failed':
      throw new PhoneCapabilityError('provider_failed', `${what}: the provider refused the request`);
    case 'unknown':
      // 도달 여부를 알 수 없다. 자동으로 다시 걸지 않는다: 사람이 확인한다 (recovery §3, ADR-0014 §10)
      throw new PhoneCapabilityError('outcome_unknown', `${what}: it is not known whether the provider received the request; it is not retried automatically`);
    case 'compensated':
      throw new PhoneCapabilityError('provider_failed', `${what}: the request was already compensated`);
  }
}

