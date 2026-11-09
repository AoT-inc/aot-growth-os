// 커넥터가 주입한 비밀값이 서버 응답·오류 문구에 그대로 되돌아오면 `[redacted]` 로 바꾼다 (ADR-0018 §5).
// 문자열 값과 객체 키를 모두 본다. 값 비교는 구조화된 값(파싱 뒤)에서 하므로 JSON 이스케이프에 속지 않는다.
export const CONNECTOR_REDACTED = '[redacted]';

export interface Redactor {
  text(value: string): string;
  deep<T>(value: T): T;
}

export function createRedactor(secrets: readonly string[]): Redactor {
  // 긴 값부터 바꾼다(짧은 비밀이 긴 비밀의 일부여도 긴 쪽이 먼저 통째로 가려진다)
  const list = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  const text = (value: string): string => {
    let out = value;
    for (const secret of list) if (out.includes(secret)) out = out.split(secret).join(CONNECTOR_REDACTED);
    return out;
  };
  const deep = <T>(value: T): T => {
    if (list.length === 0) return value;
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return text(item);
      if (Array.isArray(item)) return item.map(walk);
      if (item !== null && typeof item === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(item)) out[text(key)] = walk(child);
        return out;
      }
      return item;
    };
    return walk(value) as T;
  };
  return { text, deep };
}
