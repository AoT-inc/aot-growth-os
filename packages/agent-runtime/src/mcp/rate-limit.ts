// 사이트별 분당 호출 상한 (설계 §5.6). 토큰 버킷: 용량 = 분당 상한, 시간에 비례해 채운다. 시각은 주입된 Clock 이다.
import type { Clock } from '@aot/domain';

export interface SiteRateLimiter {
  /** 토큰이 있으면 하나 쓰고 true. 없으면 false (읽기는 즉시 거부) */
  tryAcquire(): boolean;
  /** 다음 토큰까지 남은 시간(ms). 지금 있으면 0 */
  waitMs(): number;
}

export function createSiteRateLimiter(clock: Clock, perMinute: number): SiteRateLimiter {
  const perMs = perMinute / 60_000;
  let tokens = perMinute;
  let last = clock.nowMs();
  const refill = (): void => {
    const now = clock.nowMs();
    if (now > last) tokens = Math.min(perMinute, tokens + (now - last) * perMs);
    last = now; // 시계가 거꾸로 가도 토큰을 늘리지 않는다
  };
  return {
    tryAcquire() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    waitMs() {
      refill();
      return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / perMs);
    },
  };
}
