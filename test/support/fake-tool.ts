// 가짜 외부 도구 (A0 골격). 멱등 키를 지원하는 종류와 지원하지 않는 종류 두 가지를 낸다.
// A2 의 external_effect 상태 머신·재시작 복구 시험이 이 둘로 규칙을 검증한다 (docs/operations/recovery.md §3).
// 실제 네트워크·외부 서비스를 호출하지 않고, 같은 입력에 항상 같은 결과를 낸다.

export interface FakeToolRequest {
  /** hash(task_id, step_id, canonical(request)) — 재시도해도 같다 */
  effectKey: string;
  payload: unknown;
}

export interface FakeToolDelivery {
  deliveryId: string;
  effectKey: string;
  payload: unknown;
}

export interface FakeToolResponse {
  deliveryId: string;
  /** 멱등 키 지원 도구가 같은 키의 재전송을 받아 기존 결과를 돌려준 경우 true */
  duplicate: boolean;
}

/** 부작용은 일어났지만 응답이 유실된 경우 (타임아웃). 호출자는 external_effect 를 `unknown` 으로 둔다. */
export class FakeToolTimeoutError extends Error {
  readonly effectKey: string;

  constructor(effectKey: string) {
    super(`fake tool response lost for ${effectKey}`);
    this.name = 'FakeToolTimeoutError';
    this.effectKey = effectKey;
  }
}

export interface FakeTool {
  readonly name: string;
  /** 계약 선언값 (tool_contract_version 에 포함될 `supports_idempotency`) */
  readonly supportsIdempotency: boolean;
  call(request: FakeToolRequest): FakeToolResponse;
  /** 같은 키로 이미 전송됐는지 조회. 조회 API 가 없는 도구는 undefined */
  readonly lookup: ((effectKey: string) => FakeToolDelivery | undefined) | undefined;
  /** 실제로 일어난 부작용(전달) 목록 — 시험이 "부작용 1건"을 확인하는 곳 */
  readonly deliveries: readonly FakeToolDelivery[];
  /** 다음 `count` 번의 호출에서 부작용을 일으킨 뒤 응답을 유실시킨다 */
  loseNextResponses(count: number): void;
}

export interface FakeToolOptions {
  name?: string;
}

function build(supportsIdempotency: boolean, name: string): FakeTool {
  const deliveries: FakeToolDelivery[] = [];
  const byKey = new Map<string, FakeToolDelivery>();
  let loseResponses = 0;

  return {
    name,
    supportsIdempotency,
    deliveries,
    lookup: supportsIdempotency ? (effectKey) => byKey.get(effectKey) : undefined,
    loseNextResponses(count) {
      loseResponses = count;
    },
    call(request) {
      const existing = supportsIdempotency ? byKey.get(request.effectKey) : undefined;
      let delivery = existing;
      if (!delivery) {
        delivery = {
          deliveryId: `${name}-delivery-${deliveries.length + 1}`,
          effectKey: request.effectKey,
          payload: request.payload,
        };
        deliveries.push(delivery);
        byKey.set(request.effectKey, delivery);
      }
      if (loseResponses > 0) {
        loseResponses -= 1;
        throw new FakeToolTimeoutError(request.effectKey);
      }
      return { deliveryId: delivery.deliveryId, duplicate: existing !== undefined };
    },
  };
}

/** 멱등 키 지원: 같은 키의 재전송은 부작용을 새로 만들지 않고 기존 결과를 돌려준다. 상태 조회 가능. */
export function createIdempotentFakeTool(options: FakeToolOptions = {}): FakeTool {
  return build(true, options.name ?? 'fake-idempotent-tool');
}

/** 멱등 키 미지원: 호출할 때마다 부작용이 생긴다. 상태 조회 불가 — 재전송 금지 규칙의 시험 대상. */
export function createNonIdempotentFakeTool(options: FakeToolOptions = {}): FakeTool {
  return build(false, options.name ?? 'fake-plain-tool');
}
