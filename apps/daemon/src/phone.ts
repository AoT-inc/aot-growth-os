// 전화 조립 (ADR-0014 §1): 코어 패키지들이 서로 모르는 조각을 여기서 만난다.
//   PhonePort(provider 어댑터) + 전화 정책(@aot/policy) + 부작용 원장(task-engine 의 RunContext.performEffect) + 게이트웨이 도구(@aot/agent-runtime)
// provider 어댑터와 그 비밀값은 이 앱(조립 지점)에서 주입한다. 코어 패키지는 provider 이름을 모른다.
import {
  createInboundHandler, createPhoneCapability, createPhoneEffectTools, createPhoneToolExecutors, ingestPhoneWebhook, phoneToolSpecs, reconcileOverdueCalls,
  type GatewayToolSpec, type InboundTaskFactory, type IngestResponse, type PhoneEffectTool, type ReconcileReport, type ToolExecutor,
} from '@aot/agent-runtime';
import type { Clock, Db, InboundRoute, PhoneCallPolicy, PhonePort, PhoneWebhookRequest } from '@aot/domain';
import { createPhoneCallPolicy, subjectOf, type PolicyStore } from '@aot/policy';
import type { RunContext } from '@aot/task-engine';

export interface PhoneOptions {
  /** provider 어댑터 (Vapi 등, 또는 시험용 가짜) */
  port: PhonePort;
  /** 인바운드 라우팅 규칙. 없으면 모든 수신 통화를 거절한다(기본 거부) */
  inboundRoutes?: readonly InboundRoute[];
  /** 에이전트가 받는 수신 통화의 업무를 만든다. 없으면 에이전트 대상 라우트는 거절로 처리된다 */
  createInboundTask?: InboundTaskFactory;
  /** 마감 유예 (최대 통화시간 위에 더한다). 기본 5분 */
  graceMs?: number;
}

export interface PhoneRuntime {
  readonly port: PhonePort;
  readonly policy: PhoneCallPolicy;
  /** 부작용 원장이 부르는 도구 (워커의 `tools` 에 합쳐진다) */
  readonly effectTools: Readonly<Record<string, PhoneEffectTool>>;
  /** 게이트웨이에 내줄 수 있는 전화 도구 선언 */
  readonly toolSpecs: readonly GatewayToolSpec[];
  /** run 마다 만드는 게이트웨이 실행기 */
  executorsFor(context: RunContext): ReadonlyMap<string, ToolExecutor>;
  /** provider webhook 한 건 처리 (HTTP 리스너는 배포 결정이다 — 이 함수는 본문과 헤더를 받아 응답을 돌려준다) */
  ingest(request: PhoneWebhookRequest): Promise<IngestResponse>;
  /** 마감을 넘긴 열린 통화를 provider 에 조회하고 닫는다. 주기 루프가 부른다 */
  reconcile(): Promise<ReconcileReport>;
}

/** 명세가 전화 도구에 선언한 대상 목록. 선언이 없으면 빈 목록이고, 그 도구는 어느 번호에도 쓸 수 없다 */
function declaredTargets(spec: RunContext['spec']): { call: string[]; transfer: string[] } {
  const of = (tool: string): string[] => spec.allowed_tools.filter((entry) => entry.tool === tool && entry.target !== undefined).map((entry) => entry.target!);
  return { call: of('phone_call'), transfer: of('phone_transfer') };
}

export function createPhoneRuntime(deps: { db: Db; clock: Clock; store: PolicyStore; options: PhoneOptions }): PhoneRuntime {
  const { db, clock, store, options } = deps;
  const { port } = options;
  const policy = createPhoneCallPolicy({ db, store });
  const effectTools = createPhoneEffectTools({ db, clock, port });
  const inbound = createInboundHandler({
    db, clock, routes: options.inboundRoutes ?? [], createTask: options.createInboundTask ?? (() => null),
  });
  return {
    port, policy, effectTools, toolSpecs: phoneToolSpecs(),
    executorsFor: (context) => createPhoneToolExecutors(createPhoneCapability({
      db, clock, policy,
      run: { taskId: context.taskId, runId: context.lease.runId, subject: subjectOf(context.spec), allowedTargets: declaredTargets(context.spec) },
      dispatch: (tool, step) => context.performEffect(tool, step),
    })),
    ingest: (request) => ingestPhoneWebhook({ db, clock, port, inbound }, request),
    reconcile: () => reconcileOverdueCalls({ db, clock, port, ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }) }),
  };
}
