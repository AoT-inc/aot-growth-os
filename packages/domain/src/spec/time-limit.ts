// `constraints.time_limit` 문자열("30m" 같은 형식)을 밀리초로 해석한다 (docs/schema/task-spec.md).
// 형식: 1 이상의 정수 + 단위 하나 (`s` 초, `m` 분, `h` 시간, `d` 일). 소수·복합("1h30m")·공백은 받지 않는다.
// 상한은 7일이다: Node 의 setTimeout 은 약 24.8일(2^31-1 ms)을 넘으면 즉시 발화하므로, 큰 값이 "제한 없음"이나 "즉시 취소"로 바뀌지 않게 막는다.
// 시간 제한은 안전 장치라 해석할 수 없는 값은 기본값으로 대신하지 않고 거부한다(null).

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const PATTERN = /^([1-9][0-9]{0,8})([smhd])$/;

/** 허용하는 가장 긴 시간 제한 (7일) */
export const MAX_TIME_LIMIT_MS = 7 * UNIT_MS.d;

export function parseTimeLimit(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = PATTERN.exec(text);
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return ms <= MAX_TIME_LIMIT_MS ? ms : null;
}
