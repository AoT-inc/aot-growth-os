// provider webhook 수신 (ADR-0014 §5, §9): 요청 → (어댑터가 서명 검증·canonical 변환) → PhoneEvent → 통화 상태 적용.
// 이 함수는 HTTP 서버가 아니다: 원문 본문과 헤더를 받아 응답(상태 코드·본문)을 돌려준다. 외부에 노출하는 리스너·TLS·IP 제한은 배포 결정이다 (ADR-0014 §10).
//  - 인증 실패는 401, 형식 오류는 400: 아무것도 적용하지 않는다.
//  - 이벤트 하나가 규칙을 어겨도(알 수 없는 형식, provider 불일치) 나머지는 적용하고 200 으로 답한다: 재전송해도 같은 결과일 이벤트로 provider 가 무한 재시도하지 않게 한다.
//  - 예상 밖 오류(DB 등)는 던진다 → 호출자가 5xx 로 답하면 provider 가 재전송하고, 이벤트는 멱등이다.
//  - 인바운드 `initiated` 가 통화를 새로 만들면 인바운드 처리기로 넘기고, provider 가 지시를 기다리면 지시를 응답 본문으로 돌려준다.
//  - 원본 본문은 저장하지 않는다.
import {
  applyPhoneEvent, getCall, PhoneRuleError, PhoneWebhookError, ValidationError,
  type ApplyResult, type Call, type Clock, type Db, type InboundDirective, type PhonePort, type PhoneWebhookRequest,
} from '@aot/domain';

export interface InboundHandler {
  /** 새 인바운드 통화를 처리하고 지시를 돌려준다. 던지면 거절로 처리한다(기본 거부) */
  handle(call: Call): InboundDirective | Promise<InboundDirective>;
}

export interface IngestOptions {
  db: Db;
  clock: Clock;
  port: PhonePort;
  inbound?: InboundHandler;
}

export interface IngestResponse {
  status: number;
  body: unknown;
  /** 이벤트별 적용 결과 (진단·시험용. 응답 본문에는 넣지 않는다) */
  applied: ApplyResult[];
  rejected: number;
}

export async function ingestPhoneWebhook(options: IngestOptions, request: PhoneWebhookRequest): Promise<IngestResponse> {
  const { db, clock, port } = options;
  let parsed;
  try {
    parsed = port.parseWebhook(request);
  } catch (error) {
    if (error instanceof PhoneWebhookError) return { status: error.code === 'unauthorized' ? 401 : 400, body: { error: error.code }, applied: [], rejected: 0 };
    throw error;
  }

  const applied: ApplyResult[] = [];
  let rejected = 0;
  let directive: InboundDirective | null = null;
  for (const event of parsed.events) {
    let result: ApplyResult;
    try {
      result = applyPhoneEvent(db, clock, event);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof PhoneRuleError) {
        rejected += 1;
        continue;
      }
      throw error;
    }
    applied.push(result);
    if (result.result === 'applied' && result.callCreated && options.inbound) {
      directive = await directiveFor(options.inbound, db, clock, result.callId);
    }
  }

  if (parsed.awaitingDirective) {
    // provider 가 응답으로 지시를 기다린다. 처리기가 없거나 통화가 만들어지지 않았으면 거절한다(기본 거부)
    const callId = applied.find((entry): entry is Extract<ApplyResult, { result: 'applied' }> => entry.result === 'applied')?.callId ?? '';
    const answer = directive ?? { action: 'reject', callId, reason: 'no_handler' } satisfies InboundDirective;
    if (port.buildInboundReply) {
      const reply = port.buildInboundReply(answer);
      return { status: reply.status, body: reply.body, applied, rejected };
    }
  }
  return { status: 200, body: { received: parsed.events.length }, applied, rejected };
}

async function directiveFor(handler: InboundHandler, db: Db, clock: Clock, callId: string): Promise<InboundDirective> {
  try {
    return await handler.handle(getCall(db, callId));
  } catch {
    // 처리기가 실패하면 통화를 받지 않는다 (기본 거부). 사유는 호출 기록에 남는다
    applyPhoneEvent(db, clock, {
      type: 'phone.call.cancelled', eventId: `inbound-error:${callId}`, provider: 'aot', providerCallId: null, callId, occurredAt: clock.nowIso(), reason: 'inbound handler failed',
    });
    return { action: 'reject', callId, reason: 'handler_error' };
  }
}
