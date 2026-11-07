// 메일 도구의 게이트웨이 쪽 (ADR-0017 §1, docs/plans/mail-tool.md §3·§4): 에이전트가 부르는 `mail_send` 선언과 실행기.
// 실행기는 인자를 검증하고 `from` 을 명세 target 의 설정 주소로 채운 뒤 원장 입구(`RunContext.performEffect`)에 넘길 뿐이다. 초안 단계면 원장이 보내지 않고 초안으로 남긴다.
// 에이전트는 `from`·`bcc`·`reply_to`·헤더를 정할 수 없다: 다섯 키 밖의 인자는 모두 거부한다.
import { canonicalJson, contactStatuses, mailRecipients, sha256Hex, validateMailPayload } from '@aot/domain';
import type { Db, MailPayload } from '@aot/domain';

import type { JsonObject } from '../contract.ts';
import { bindToEffectLedger } from '../effect-ledger.ts';
import type { GatewayToolSpec, ToolExecutionRequest, ToolExecutionResult, ToolExecutor } from '../gateway.ts';
import { maskString } from '../mask.ts';

export const MAIL_SEND_TOOL = 'mail_send';

const SENDER_TARGET = /^mail:([a-z0-9][a-z0-9-]{0,31})$/;

/** 부작용 원장의 target(`mail:<보내는 사람 키>`)에서 키를 꺼낸다. 모양이 맞지 않으면 null */
export const senderKeyOfTarget = (target: string): string | null => SENDER_TARGET.exec(target)?.[1] ?? null;

/** 에이전트에 내줄 수 있는 메일 도구. 명세의 `allowed_tools` 와 도구·operation 이 맞는 것만 그 run 에 열린다 */
export function mailToolSpecs(): GatewayToolSpec[] {
  return [{ tool: MAIL_SEND_TOOL, operation: 'send', scope: 'customer', impact: 'external_effect', sideEffect: true }];
}

export type MailToolErrorCode =
  | 'from_not_allowed' | 'invalid_args' | 'invalid_payload' | 'no_target' | 'ambiguous_sender' | 'unknown_sender' | 'recipient_suppressed' | 'secret_like';

/** 호출 단계에서 거부한 오류. 게이트웨이가 `tool_error` 로 에이전트에 알린다 (메시지에 비밀·서버 응답은 없다) */
export class MailToolError extends Error {
  readonly code: MailToolErrorCode;
  constructor(code: MailToolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MailToolError';
    this.code = code;
  }
}

export interface MailEffectStep { stepId: string; action: string; target: string; request: unknown }
export type MailEffectOutcome =
  | { state: 'confirmed' | 'failed' | 'unknown' | 'compensated'; effectId: string }
  | { state: 'drafted'; draftId: string };

/** 부작용 원장 입구. 데몬이 `RunContext.performEffect` 를 연결한다 */
export type MailEffectRunner = (tool: string, step: MailEffectStep, meta?: { influenced: boolean }) => Promise<MailEffectOutcome>;

export interface MailToolExecutorOptions {
  ledger: MailEffectRunner;
  db: Db;
  /** 이 run 의 명세 `allowed_tools` 에서 `mail_send` 항목이 밝힌 target 목록 (`mail:<키>`) */
  targets: readonly string[];
  /** 보내는 사람 키 → 설정 주소 (데몬 설정 `mail.senders`) */
  senders: Readonly<Record<string, { address: string }>>;
}

const AGENT_KEYS = ['to', 'cc', 'subject', 'text'];

/** 명세의 mail_send target 하나를 정한다. 없으면 `no_target`, 서로 다른 target 이 둘 이상이면 `ambiguous_sender` */
function resolveTarget(targets: readonly string[]): string {
  const distinct = [...new Set(targets)];
  if (distinct.length === 0) throw new MailToolError('no_target', "the task spec does not name a sender for mail_send (target 'mail:<sender key>')");
  if (distinct.length > 1) throw new MailToolError('ambiguous_sender', 'the task spec names more than one sender for mail_send; a task sends from one sender');
  return distinct[0]!;
}

export function createMailToolExecutor(options: MailToolExecutorOptions): ToolExecutor {
  return bindToEffectLedger<ToolExecutionRequest, ToolExecutionResult, MailEffectStep, MailEffectOutcome>({
    ledger: options.ledger,
    run: async (request, perform) => {
      const args = request.args as JsonObject;
      if ('from' in args) throw new MailToolError('from_not_allowed', 'the sender is set by the host from the task spec; do not pass from');
      const unknown = Object.keys(args).filter((key) => !AGENT_KEYS.includes(key));
      if (unknown.length > 0) throw new MailToolError('invalid_args', `unknown argument(s): ${unknown.join(', ')}; allowed: ${AGENT_KEYS.join(', ')}`);

      const target = resolveTarget(options.targets);
      const key = senderKeyOfTarget(target);
      const sender = key === null || !Object.hasOwn(options.senders, key) ? undefined : options.senders[key];
      if (sender === undefined) throw new MailToolError('unknown_sender', `sender '${target}' is not configured on this instance`);

      const checked = validateMailPayload({ from: sender.address, ...args }, { requireFrom: true });
      if (!checked.ok) throw new MailToolError('invalid_payload', checked.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; '));
      const payload: MailPayload = checked.value;

      const suppressed = [...contactStatuses(options.db, mailRecipients(payload))].filter(([, status]) => status === 'suppressed').map(([address]) => address);
      if (suppressed.length > 0) throw new MailToolError('recipient_suppressed', `${suppressed.join(', ')} unsubscribed or bounced; mail cannot be sent to this address`);
      // 사람이 가려지지 않은 바이트를 보고 승인한다: 비밀처럼 보여 가려지는 글은 승인할 수 없는 초안이므로 만들지 않는다
      if (maskString(payload.subject) !== payload.subject || maskString(payload.text) !== payload.text) {
        throw new MailToolError('secret_like', 'the subject or text looks like it contains a secret; remove it');
      }

      const outcome = await perform(MAIL_SEND_TOOL, {
        stepId: `mail-${sha256Hex(canonicalJson(payload)).slice(0, 16)}`, action: 'send', target, request: payload,
      });
      return { result: outcome.state === 'drafted' ? { status: 'drafted', draft_id: outcome.draftId } : { status: outcome.state } };
    },
  }) as ToolExecutor;
}
