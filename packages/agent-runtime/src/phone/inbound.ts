// 인바운드 통화 처리 (ADR-0014 §9). 명시적 라우팅 규칙으로 수신 통화를 에이전트·사람·거절 중 하나로 보낸다. AI 라우터는 없다.
// 라우팅은 "누가 받는가"만 정한다 — 에이전트가 받아도 도구·예산·승인은 업무 명세와 정책이 정한다(trust-boundaries §2-7).
// 에이전트가 받으면 업무 하나를 만들어 통화에 연결한다. 업무 생성은 데몬이 주입한 함수가 한다(task-engine 과 정책 게이트를 아는 쪽):
// 이 모듈은 업무 엔진도 provider 도 모른다.
import {
  applyPhoneEvent, linkCallToTask, routeInboundCall,
  type Call, type Clock, type Db, type InboundDirective, type InboundRoute,
} from '@aot/domain';

import type { InboundHandler } from './webhook.ts';

export interface InboundAgentTarget {
  orgUnit: string;
  role: string;
  objective: string;
}

/** 수신 통화를 맡을 업무를 만든다. 만들 수 없으면 null (통화는 거절된다) */
export type InboundTaskFactory = (call: Call, target: InboundAgentTarget) => { taskId: string } | null | Promise<{ taskId: string } | null>;

export interface InboundHandlerOptions {
  db: Db;
  clock: Clock;
  routes: readonly InboundRoute[];
  createTask: InboundTaskFactory;
}

export function createInboundHandler(options: InboundHandlerOptions): InboundHandler {
  const { db, clock, routes } = options;
  const close = (call: Call, reason: string): InboundDirective => {
    applyPhoneEvent(db, clock, {
      type: 'phone.call.cancelled', eventId: `inbound-reject:${call.id}`, provider: 'aot', providerCallId: null, callId: call.id, occurredAt: clock.nowIso(), reason: `rejected: ${reason}`.slice(0, 120),
    });
    return { action: 'reject', callId: call.id, reason };
  };
  return {
    async handle(call): Promise<InboundDirective> {
      const decision = routeInboundCall(routes, { to: call.to, from: call.from }, new Date(clock.nowIso()));
      switch (decision.target.kind) {
        case 'reject':
          return close(call, decision.target.reason);
        case 'human':
          return { action: 'transfer', callId: call.id, to: decision.target.number };
        case 'agent': {
          const created = await options.createTask(call, decision.target);
          if (created === null) return close(call, 'no_task');
          linkCallToTask(db, clock, call.id, { taskId: created.taskId, objective: decision.target.objective });
          return { action: 'connect_agent', callId: call.id, objective: decision.target.objective };
        }
      }
    },
  };
}
