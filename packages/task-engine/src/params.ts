// lease 파라미터. 기본값의 근거는 docs/spikes/q15-lease-parameters.md (스파이크 Q15).
// 시각 계산은 모두 주입된 Clock 의 값으로 하고 SQL 파라미터로 넘긴다 (recovery §2 규칙 5).

export interface LeaseParams {
  /** lease 유효 시간. heartbeat 마다 now + leaseMs 로 갱신된다 */
  leaseMs: number;
  /** heartbeat 주기 */
  heartbeatMs: number;
}

/**
 * Q15 결과 (2026-10-19): lease 90초, heartbeat 30초. 쓰기 경합·heartbeat 실패·이벤트 루프 정지 시나리오에서 오탐 인수 0,
 * 폴링 5초와 합친 최대 복구 지연 약 95초 (복구 지연 목표 120초는 잠정 — 스파이크 문서 "열린 점").
 */
export const DEFAULT_LEASE_PARAMS: LeaseParams = { leaseMs: 90_000, heartbeatMs: 30_000 };

/** 데몬 폴링 주기 기본값 (Q15 모의의 인수자 폴링과 같은 값) */
export const DEFAULT_POLL_MS = 5_000;

export function checkLeaseParams(params: LeaseParams): LeaseParams {
  const { leaseMs, heartbeatMs } = params;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new RangeError('leaseMs must be a positive integer');
  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0) throw new RangeError('heartbeatMs must be a positive integer');
  if (heartbeatMs >= leaseMs) throw new RangeError('heartbeatMs must be shorter than leaseMs');
  return params;
}

export const isoAfter = (nowMs: number, ms: number): string => new Date(nowMs + ms).toISOString();
