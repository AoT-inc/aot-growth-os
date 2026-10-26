// 같은 줄이 tick 마다(기본 5초) 되풀이되어 로그를 덮지 않게 한다. 대표 사례: 구독 한도·로그인 문제로 검증기를 쓸 수 없는 업무(`VerifierUnavailableError`)는 풀릴 때까지
// `validating` 에 남아 매 tick 같은 오류를 낸다. 키(업무 id)별로 문구가 바뀌었거나 `repeatAfterMs` 가 지났을 때만 찍는다.
export interface RepeatFilter {
  /** 이 키의 이 문구를 지금 찍어야 하면 true (처음, 문구가 바뀜, 마지막으로 찍은 지 repeatAfterMs 이상) */
  shouldLog(key: string, text: string): boolean;
  /** 이 키가 풀렸다: 다음 문제는 처음처럼 찍는다 */
  clear(key: string): void;
}

export const DEFAULT_REPEAT_AFTER_MS = 30 * 60_000;

export function createRepeatFilter(nowMs: () => number, repeatAfterMs: number = DEFAULT_REPEAT_AFTER_MS): RepeatFilter {
  const last = new Map<string, { text: string; atMs: number }>();
  return {
    shouldLog(key, text) {
      const now = nowMs();
      const previous = last.get(key);
      if (previous !== undefined && previous.text === text && now - previous.atMs < repeatAfterMs) return false;
      last.set(key, { text, atMs: now });
      return true;
    },
    clear(key) {
      last.delete(key);
    },
  };
}
