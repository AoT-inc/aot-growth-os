// 가짜 메시지 도구 (ADR-0015 시험용). 원장에 묶인 부작용 도구이고 `approval: 'draft'` 로 선언한다.
// payload 는 `{to, cc?, bcc?, subject, text}`. 실제 네트워크를 호출하지 않고 받은 요청을 그대로 기록한다.
import type { EffectCall, EffectTool } from '@aot/task-engine';

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
