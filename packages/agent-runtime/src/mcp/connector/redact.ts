// 커넥터가 주입한 비밀값이 서버 응답·오류 문구에 그대로 되돌아오면 `[redacted]` 로 바꾼다 (ADR-0018 §5).
// 문자열 값과 객체 키를 모두 본다. 값 비교는 구조화된 값(파싱 뒤)에서 하므로 JSON 이스케이프에 속지 않는다.
export const CONNECTOR_REDACTED = '[redacted]';

export interface Redactor {
  /** 나중에 알게 된 비밀(호스트가 보낸 접근 토큰)의 목록을 바꾼다. 처음 받은 비밀은 그대로 두고 이 목록만 교체한다(쌓이지 않는다) */
  setDynamic(secrets: readonly string[]): void;
  text(value: string): string;
  deep<T>(value: T): T;
}

export function createRedactor(secrets: readonly string[]): Redactor {
  // 긴 값부터 바꾼다(짧은 비밀이 긴 비밀의 일부여도 긴 쪽이 먼저 통째로 가려진다)
  const fixed = [...new Set(secrets.filter((s) => s.length > 0))];
  let list = [...fixed].sort((a, b) => b.length - a.length);
  const setDynamic = (dynamic: readonly string[]): void => {
    list = [...new Set([...fixed, ...dynamic.filter((s) => s.length > 0)])].sort((a, b) => b.length - a.length);
  };
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
        // `__proto__` 키도 자기 키로 남겨 가린다(대입이면 프로토타입이 바뀌어 값이 가려지지 않은 채 사라진다)
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [text(key), walk(child)]));
      }
      return item;
    };
    return walk(value) as T;
  };
  return { setDynamic, text, deep };
}

/** 서버가 정한 문자열(이름 등)을 사람이 읽는 출력·로그에 싣기 전에 제어 문자를 `?` 로 바꾸고 길이를 자른다 */
// eslint-disable-next-line no-control-regex -- 제어 문자를 찾는 것이 목적이다
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
export const safeText = (value: string, max = 200): string => value.replace(CONTROL_CHARS, '?').slice(0, max);

/** `token xxx`·`Bearer xxx`·`Basic xxx` 처럼 인증 방식 접두가 붙은 값은 알맹이(접두 뒤 전부, 마지막 조각)도 비밀로 가린다. 알맹이만 응답에 돌아와도 가려진다 */
export function secretPieces(value: string): string[] {
  const out = new Set<string>();
  const trimmed = value.trim();
  const cut = trimmed.search(/\s/);
  if (cut > 0) out.add(trimmed.slice(cut).trim());
  const last = trimmed.split(/\s+/).pop();
  if (last !== undefined) out.add(last);
  out.delete(value);
  return [...out].filter((piece) => piece.length >= 4);
}
