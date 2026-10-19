// lease 파라미터. 기본값은 스파이크 Q15 로 정한다.
// 시각 계산은 모두 주입된 Clock 의 값으로 하고 SQL 파라미터로 넘긴다 (recovery §2 규칙 5).

export interface LeaseParams {
  /** lease 유효 시간. heartbeat 마다 now + leaseMs 로 갱신된다 */
  leaseMs: number;
  /** heartbeat 주기 */
  heartbeatMs: number;
}

/** 잠정값. 스파이크 Q15 로 확정한다 */
export const DEFAULT_LEASE_PARAMS: LeaseParams = { leaseMs: 60_000, heartbeatMs: 15_000 };

export function checkLeaseParams(params: LeaseParams): LeaseParams {
  const { leaseMs, heartbeatMs } = params;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new RangeError('leaseMs must be a positive integer');
  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0) throw new RangeError('heartbeatMs must be a positive integer');
  if (heartbeatMs >= leaseMs) throw new RangeError('heartbeatMs must be shorter than leaseMs');
  return params;
}

export const isoAfter = (nowMs: number, ms: number): string => new Date(nowMs + ms).toISOString();
