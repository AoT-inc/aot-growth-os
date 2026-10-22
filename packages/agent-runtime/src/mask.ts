// 호출 기록(run_log)에 남기는 인자·결과·오류 문구의 비밀값 가리기. 응답(에이전트가 받는 값)은 바꾸지 않고 기록만 가린다.
// 두 방법을 함께 쓴다: (1) 키 이름이 비밀을 가리키면 값 전체를 가린다, (2) 문자열 값 안의 알려진 비밀 모양을 가린다.
// 이름·모양에 없는 비밀은 못 잡는다: 비밀은 애초에 도구 실행기(어댑터)가 주입하고 인자·결과에 싣지 않는 것이 1차 방어이고(trust-boundaries §3),
// 이 마스킹은 실수로 섞인 값이 기록에 남는 것을 줄이는 2차 방어다.
import type { JsonValue } from './contract.ts';

export const REDACTED = '[REDACTED]';

/** 키 이름(소문자, 영숫자만 남김)이 비밀을 가리키는가. `max_tokens` 같은 개수 필드는 가리지 않는다 */
const SECRET_KEY = /(password|passwd|passphrase|secret|apikey|accesskey|privatekey|authorization|cookie|credential|bearer|signature|totp)/;
const SECRET_KEY_SUFFIX = /(token|otp)$/;

export function isSecretKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY.test(compact) || SECRET_KEY_SUFFIX.test(compact);
}

const VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/(:\/\/[^/\s:@]+:)[^/\s@]+@/g, `$1${REDACTED}@`],
  [/([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|passwd|sig|signature)=)[^&\s#]+/gi, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
];

export function maskString(text: string): string {
  let out = text;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** 값의 사본을 만들어 비밀로 보이는 부분을 가린다. 원본은 바꾸지 않는다. 입력은 JSON 값(깊이 32 이내)이다 */
export function maskSecrets(value: JsonValue): JsonValue {
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) out[key] = isSecretKey(key) ? REDACTED : maskSecrets(child);
    return out;
  }
  return value;
}

/** 가린 뒤 JSON 문자열로 만들고 `maxChars` 를 넘으면 자른다. 잘렸는지도 알려 준다 */
export function previewJson(value: JsonValue, maxChars: number): { text: string; truncated: boolean } {
  const text = JSON.stringify(maskSecrets(value));
  return text.length <= maxChars ? { text, truncated: false } : { text: `${text.slice(0, maxChars)}…`, truncated: true };
}
