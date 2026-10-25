// 통화 상태 보완 (ADR-0014 §6): webhook 이 늦거나 오지 않을 때를 위한 조회와 마감.
//  1. 마감을 넘긴 열린 통화마다 provider 에 현재 상태를 조회해(`fetchCallEvents`) canonical 이벤트로 적용한다.
//  2. 그래도 닫히지 않은 통화는 `failed`(deadline_exceeded)로 닫는다 → 업무 검증이 풀리고 평가기가 증거 부족을 판정한다.
// provider 조회가 실패해도(네트워크 등) 마감은 지킨다. 데몬의 주기 루프가 부른다.
import {
  applyPhoneEvent, expireCall, overdueOpenCalls, getCall,
  type Clock, type Db, type PhonePort,
} from '@aot/domain';

export interface ReconcileOptions {
  db: Db;
  clock: Clock;
  port: PhonePort;
  /** 최대 통화시간 위에 더하는 유예. 기본 5분 */
  graceMs?: number;
  /** 통화에 최대 시간이 없을 때의 기준. 기본 1시간 */
  defaultMaxSeconds?: number;
}

export interface ReconcileReport {
  checked: string[];
  closedByProvider: string[];
  expired: string[];
}

export const DEFAULT_CALL_GRACE_MS = 5 * 60_000;
export const DEFAULT_CALL_MAX_SECONDS = 3600;

export async function reconcileOverdueCalls(options: ReconcileOptions): Promise<ReconcileReport> {
  const { db, clock, port } = options;
  const overdue = overdueOpenCalls(db, clock, { graceMs: options.graceMs ?? DEFAULT_CALL_GRACE_MS, defaultMaxSeconds: options.defaultMaxSeconds ?? DEFAULT_CALL_MAX_SECONDS });
  const report: ReconcileReport = { checked: [], closedByProvider: [], expired: [] };
  for (const call of overdue) {
    report.checked.push(call.id);
    if (call.providerCallId !== null && call.provider === port.name) {
      try {
        for (const event of await port.fetchCallEvents(call.providerCallId)) applyPhoneEvent(db, clock, event);
      } catch {
        // 조회 실패는 "알 수 없음"이다 — 아래 마감으로 간다
      }
    }
    if (getCall(db, call.id).status === 'completed' || getCall(db, call.id).status === 'failed' || getCall(db, call.id).status === 'cancelled') {
      report.closedByProvider.push(call.id);
      continue;
    }
    expireCall(db, clock, call.id);
    report.expired.push(call.id);
  }
  return report;
}
