// 메일 조립 (ADR-0017 §1): 코어 패키지들이 서로 모르는 조각을 여기서 만난다.
//   MailTransport(SMTP 어댑터) + 부작용 원장(task-engine 의 RunContext.performEffect) + 게이트웨이 도구(@aot/agent-runtime)
// SMTP 어댑터와 그 비밀값은 이 앱(조립 지점)에서 주입한다. 코어 패키지는 업체 이름을 모른다.
import {
  createMailEffectTool, createMailToolExecutor, mailToolSpecs, MAIL_SEND_TOOL,
  type GatewayToolSpec, type MailEffectTool, type ToolExecutor,
} from '@aot/agent-runtime';
import type { Clock, Db, MailTransport } from '@aot/domain';
import type { RunContext } from '@aot/task-engine';

export interface MailOptions {
  /** 전송 어댑터 (SMTP, 또는 시험용 가짜) */
  transport: MailTransport;
  /** 보내는 사람 키 → 설정. 명세의 `mail_send` target `mail:<키>` 가 가리킨다 */
  senders: Readonly<Record<string, { address: string }>>;
  unsubscribeMailto: string;
  bounceAddress?: string;
  messageIdDomain?: string;
  /** 하루 전송 수 상한 (이 인스턴스 전체) */
  maxPerDay: number;
  /** 전송 사이 최소 간격(ms) */
  minIntervalMs: number;
  /** 시험용 주입점 */
  sleep?: (ms: number) => Promise<void>;
}

export interface MailRuntime {
  readonly transport: MailTransport;
  /** 부작용 원장이 부르는 도구 (워커의 `tools` 에 합쳐진다) */
  readonly effectTools: Readonly<Record<string, MailEffectTool>>;
  /** 게이트웨이에 내줄 수 있는 메일 도구 선언 */
  readonly toolSpecs: readonly GatewayToolSpec[];
  /** run 마다 만드는 게이트웨이 실행기 */
  executorsFor(context: RunContext): ReadonlyMap<string, ToolExecutor>;
}

/** 명세가 `mail_send` 에 선언한 보내는 사람 target 목록 */
function declaredTargets(spec: RunContext['spec']): string[] {
  return spec.allowed_tools.filter((entry) => entry.tool === MAIL_SEND_TOOL && entry.target !== undefined).map((entry) => entry.target!);
}

export function createMailRuntime(deps: { db: Db; clock: Clock; options: MailOptions }): MailRuntime {
  const { db, clock, options } = deps;
  const effectTool = createMailEffectTool({
    db, clock, transport: options.transport, senders: options.senders, unsubscribeMailto: options.unsubscribeMailto,
    maxPerDay: options.maxPerDay, minIntervalMs: options.minIntervalMs,
    ...(options.bounceAddress === undefined ? {} : { bounceAddress: options.bounceAddress }),
    ...(options.messageIdDomain === undefined ? {} : { messageIdDomain: options.messageIdDomain }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  return {
    transport: options.transport,
    effectTools: { [MAIL_SEND_TOOL]: effectTool },
    toolSpecs: mailToolSpecs(),
    executorsFor: (context) => new Map<string, ToolExecutor>([[MAIL_SEND_TOOL, createMailToolExecutor({
      // 메일 도구의 실행기는 원장에 묶인다(bindToEffectLedger): 초안 단계면 원장이 보내지 않고 초안으로 남기고, 전송은 승인된 초안을 호스트가 보낸다
      ledger: (tool, step, meta) => context.performEffect(tool, step, meta),
      db, targets: declaredTargets(context.spec), senders: options.senders,
    })]]),
  };
}
