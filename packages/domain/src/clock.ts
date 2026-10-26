// 시계 주입. lease 판정·heartbeat·만료 계산은 여기서 받은 시각을 SQL 파라미터로 넘긴다.
// SQL 의 now()/CURRENT_TIMESTAMP 는 쓰지 않는다 (operations/recovery.md §2, db/sql-guard.ts 가 강제).

/** 시각 공급원. 시각 문자열은 UTC ISO 8601(밀리초, `Z`)이라 문자열 비교가 시간순과 같다. */
export interface Clock {
  /** 에포크 밀리초 */
  nowMs(): number;
  /** 예: 2026-10-19T00:00:00.000Z */
  nowIso(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/** 시험용 가짜 시계. 자동으로 흐르지 않고 `set`/`advance` 로만 움직인다. */
export class FakeClock implements Clock {
  #ms: number;

  constructor(start: string | number = '2026-01-01T00:00:00.000Z') {
    this.#ms = typeof start === 'number' ? start : parseIso(start);
  }

  nowMs(): number {
    return this.#ms;
  }

  nowIso(): string {
    return new Date(this.#ms).toISOString();
  }

  set(to: string | number): void {
    this.#ms = typeof to === 'number' ? to : parseIso(to);
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError('FakeClock cannot go backwards via advance()');
    this.#ms += ms;
  }
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`invalid ISO timestamp: ${iso}`);
  return ms;
}
