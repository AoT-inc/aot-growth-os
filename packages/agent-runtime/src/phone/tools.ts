// 전화 도구의 게이트웨이 쪽 (ADR-0014 §1): 에이전트가 요청할 수 있는 도구 선언과 실행기. 실행기는 PhoneCapability 를 부를 뿐 provider 를 모른다.
// 도구 이름 하나에 operation 하나다(게이트웨이 규칙)이고, 이름은 부작용 도구(effect-tools.ts)와 같아 정책 판정(`<tool>.<operation>`)과 원장 기록이 일치한다.
// 모두 `customer` 범위의 외부 부작용이다: 호출마다 정책을 다시 판정받고, 외부 입력의 영향을 받은 run 에서는 승인 없이 막힌다.
import { isPlainObject, type PhoneCapability } from '@aot/domain';

import type { JsonObject } from '../contract.ts';
import type { GatewayToolSpec, ToolExecutor } from '../gateway.ts';

export const PHONE_CALL_TOOL = 'phone_call';
export const PHONE_TRANSFER_TOOL = 'phone_transfer';
export const PHONE_HANGUP_TOOL = 'phone_hangup';

// approvalViaEffectGate: 실행기(Capability)가 부작용을 원장으로만 보내므로 사람의 업무 승인은 원장이 전송 직전에 확인한다 (gateway.ts GatewayToolSpec)
const base = { scope: 'customer', impact: 'external_effect', sideEffect: true, approvalViaEffectGate: true } as const;

/** 에이전트에 내줄 수 있는 전화 도구. 명세의 `allowed_tools` 와 도구·operation 이 맞는 것만 그 run 에 열린다 */
export function phoneToolSpecs(): GatewayToolSpec[] {
  return [
    { tool: PHONE_CALL_TOOL, operation: 'call', ...base },
    { tool: PHONE_TRANSFER_TOOL, operation: 'transfer', ...base },
    { tool: PHONE_HANGUP_TOOL, operation: 'hangup', ...base },
  ];
}

/**
 * run 하나의 전화 도구 실행기. 인자는 에이전트가 낸 JSON 이라 검증은 Capability 가 한다(알 수 없는 키 거부).
 * 결과는 통화 식별자와 상태뿐이다: 통화가 끝났는지는 에이전트가 기다리지 않고, 결과는 시스템이 증거로 확인한다.
 */
export function createPhoneToolExecutors(capability: PhoneCapability): Map<string, ToolExecutor> {
  return new Map<string, ToolExecutor>([
    [PHONE_CALL_TOOL, async (request) => {
      const handle = await capability.call(request.args as never);
      return { result: { callId: handle.callId, status: handle.status } satisfies JsonObject };
    }],
    [PHONE_TRANSFER_TOOL, async (request) => {
      await capability.transfer(request.args as never);
      return { result: { transferred: true } };
    }],
    [PHONE_HANGUP_TOOL, async (request) => {
      const callId = isPlainObject(request.args) ? request.args['callId'] : undefined;
      if (typeof callId !== 'string') throw new Error('callId is required');
      await capability.hangup(callId);
      return { result: { hungUp: true } };
    }],
  ]);
}
