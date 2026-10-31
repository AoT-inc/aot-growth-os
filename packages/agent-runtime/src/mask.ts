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

/**
 * 값 자리에 *값이 아니라 치환 문법*만 있는 경우(`${DB_PASSWORD}`, `$DB_PASS`, `<password>`, `{{db_pass}}`, `%(pass)s`): 비밀이 없으므로 찾지 않는다.
 * 설정 예시·compose 파일·문서에 흔한 모양이라 `postgres://${USER}:${PASS}@db` 를 자격 증명으로 오인하면 업무가 영구히 fail 이 된다.
 * 좁게 잡는다 — 치환 문법이면서 *이름이 환경 변수/설정 키처럼 보일 때*만: 이름이 대문자 스네이크(`DB_PASSWORD`)이거나 비밀·접속 정보를 뜻하는 낱말(pass·pwd·secret·token·key·cred·user·name·host·port·value)을 품어야 한다.
 * 그래서 `$HUNTER2`, `${Tr0ub4dor}`, `<hunter>`, `{hunter}` 처럼 이름 자리에 값이 들어 있을 수 있는 것은 치환 문법으로 보지 않는다. 기본값을 품은 `${PASS:-hunter2}`, 리터럴이 섞인 `pa${X}ss` 도 값이다.
 * URL 자격 증명에서는 사용자 자리도 본다: 사용자가 치환 문법이거나 평범한 이름(`deploy`, `admin01`)일 때만 면제한다(토큰을 사용자로 쓰고 비밀번호 자리만 치환한 URL 은 잡는다).
 * 두 구현(이 파일과 agent-runtime/src/mask.ts)은 같아야 한다(시험이 대조한다).
 */
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const NAME_HINT = /pass|pwd|secret|token|key|cred|user|name|host|port|value|placeholder|redacted/i;
const isPlaceholderName = (name: string): boolean => UPPER_SNAKE.test(name) || NAME_HINT.test(name);
const PLACEHOLDER_FORMS: readonly RegExp[] = [
  /^\$\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}$/, // ${NAME} (기본값 `:-` 은 불가)
  /^\$([A-Z_][A-Z0-9_]{1,63})$/, // $NAME (대문자 환경 변수 관례)
  /^<([A-Za-z_][A-Za-z_-]{0,40})>$/, // <password>
  /^\{\{([A-Za-z_][A-Za-z_.-]{0,63})\}\}$/, // {{name}}
  /^\{([A-Za-z_][A-Za-z_]{0,63})\}$/, // {name}
  /^%\(([A-Za-z_][A-Za-z_]{0,63})\)s$/, // %(name)s
  /^%([A-Za-z_][A-Za-z_]{0,63})%$/, // %NAME%
];
const isPlaceholderValue = (value: string): boolean => PLACEHOLDER_FORMS.some((form) => {
  const name = form.exec(value)?.[1];
  return name !== undefined && isPlaceholderName(name);
});
/** URL 사용자 자리: 치환 문법이거나 평범한 이름(글자로 시작, 끝에만 숫자 최대 3개) */
const isPlainUsername = (user: string): boolean => isPlaceholderValue(user) || /^[A-Za-z][A-Za-z._-]{0,31}[0-9]{0,3}$/.test(user);

type Replacer = string | ((match: string, prefix: string) => string);

const VALUE_PATTERNS: readonly (readonly [RegExp, Replacer])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/(:\/\/[^/\s:@]+:)([^/\s@]+)@/g, (match, prefix) => (isPlaceholderValue(match.slice(prefix.length, -1)) && isPlainUsername(prefix.slice(3, -1)) ? match : `${prefix}${REDACTED}@`)],
  [/([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|passwd|sig|signature)=)([^&\s#]+)/gi, (match, prefix) => (isPlaceholderValue(match.slice(prefix.length)) ? match : `${prefix}${REDACTED}`)],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
];

export function maskString(text: string): string {
  let out = text;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement as never);
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
