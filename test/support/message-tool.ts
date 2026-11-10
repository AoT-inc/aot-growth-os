// 가짜 메시지 도구 (ADR-0015 시험용). 원장에 묶인 부작용 도구이고 `approval: 'draft'` 로 선언한다.
// payload 는 `{to, cc?, bcc?, subject, text}`. 실제 네트워크를 호출하지 않고 받은 요청을 그대로 기록한다.
import { bindToEffectLedger, type GatewayToolSpec, type JsonObject, type ToolExecutionRequest, type ToolExecutionResult, type ToolExecutor } from '@aot/agent-runtime';
import { canonicalJson, sha256Hex } from '@aot/domain';
import type { EffectCall, EffectOutcome, EffectStep, EffectTool, RunContext } from '@aot/task-engine';

export const MESSAGE_TOOL = 'notify-tool';
export const MESSAGE_TARGET = 'mailbox:example';

export interface MessagePayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
}

export interface FakeMessageTool {
  readonly tool: EffectTool;
  /** `send` 가 받은 호출 (보낸 횟수 = 길이) */
  readonly sent: EffectCall[];
  /** 다음 `count` 번의 호출은 보낸 뒤 응답을 잃는다(예외 → unknown) */
  loseNextResponses(count: number): void;
}

export interface FakeMessageToolOptions {
  name?: string;
  approval?: 'draft' | 'scope';
  /** 멱등 키 지원 여부(기본 지원, 보존 24h) */
  idempotent?: boolean;
}

export function createFakeMessageTool(options: FakeMessageToolOptions = {}): FakeMessageTool {
  const sent: EffectCall[] = [];
  let lose = 0;
  const tool: EffectTool = {
    name: options.name ?? MESSAGE_TOOL,
    actions: {
      send: {
        approval: options.approval ?? 'draft',
        idempotency: options.idempotent === false ? { supported: false } : { supported: true, retention_ms: 86_400_000 },
      },
    },
    send(call) {
      sent.push(call);
      if (lose > 0) {
        lose -= 1;
        throw new Error('response lost');
      }
      return { status: 'confirmed', responseRef: `msg-${sent.length}` };
    },
  };
  return { tool, sent, loseNextResponses: (count) => { lose = count; } };
}

export const examplePayload = (over: Partial<MessagePayload> = {}): MessagePayload => ({
  to: ['customer@example.com'], subject: 'Hello', text: 'First line\nSecond line', ...over,
});

// ===== 게이트웨이 쪽: 원장에 묶인 실행기 (에이전트가 부르는 도구) =====

/** 에이전트가 부르는 메시지 도구의 게이트웨이 선언 (원장에 묶인 부작용 도구) */
export const MESSAGE_GATEWAY_SPEC: GatewayToolSpec = {
  tool: MESSAGE_TOOL, operation: 'send', target: MESSAGE_TARGET, scope: 'customer', impact: 'external_effect', sideEffect: true,
};

/**
 * run 하나의 메시지 도구 실행기. 인자(`to`, `cc`, `bcc`, `subject`, `text`)를 그대로 원장 입구(`RunContext.performEffect`)에 넘긴다.
 * 초안 단계면 원장이 보내지 않고 초안으로 남기고 `{status:'drafted', draft_id}` 를 돌려준다. 단계 id 는 payload 에서 정해져 같은 내용은 같은 단계다.
 */
export function messageExecutorFor(context: Pick<RunContext, 'performEffect'>): ToolExecutor {
  return bindToEffectLedger<ToolExecutionRequest, ToolExecutionResult, EffectStep, EffectOutcome>({
    ledger: (tool, step, meta) => context.performEffect(tool, step, meta),
    run: async (request, perform) => {
      const payload = request.args as JsonObject;
      const outcome = await perform(MESSAGE_TOOL, {
        stepId: `send-${sha256Hex(canonicalJson(payload)).slice(0, 16)}`, action: 'send', target: MESSAGE_TARGET, request: payload,
      });
      return { result: outcome.state === 'drafted' ? { status: 'drafted', draft_id: outcome.draftId } : { status: outcome.state } };
    },
  }) as ToolExecutor;
}
