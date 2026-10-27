// 산출물 속 비밀값 모양 찾기 (`no_secret_in_outputs`). 모양만 보고하고 값은 어디에도 돌려주지 않는다: 결과에는 종류와 개수뿐이다.
// 패턴은 호출 기록 마스킹(packages/agent-runtime/src/mask.ts 의 VALUE_PATTERNS)과 같은 집합이다 — 기록에서 가리는 모양을 산출물에서도 같은 모양으로 찾는다.
// 두 목록이 어긋나지 않는지는 test/unit/evaluation-secret-patterns.test.ts 가 같은 표본으로 대조한다(evaluation 은 agent-runtime 을 참조할 수 없다: 경계 lint).
// 이 목록에 없는 비밀은 못 잡는다. 스캐너(gitleaks)가 1차이고 이것은 산출물 재확인(2차)이다.

export type SecretShapeKind = 'private_key' | 'bearer_token' | 'url_credentials' | 'query_secret' | 'jwt' | 'api_key_prefix' | 'github_token' | 'slack_token' | 'aws_access_key';

const SHAPES: readonly (readonly [SecretShapeKind, RegExp])[] = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['bearer_token', /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi],
  ['url_credentials', /(:\/\/[^/\s:@]+:)[^/\s@]+@/g],
  ['query_secret', /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|passwd|sig|signature)=)[^&\s#]+/gi],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['api_key_prefix', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g],
];

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
export const isPlaceholderValue = (value: string): boolean => PLACEHOLDER_FORMS.some((form) => {
  const name = form.exec(value)?.[1];
  return name !== undefined && isPlaceholderName(name);
});
/** URL 사용자 자리: 치환 문법이거나 평범한 이름(글자로 시작, 끝에만 숫자 최대 3개) */
export const isPlainUsername = (user: string): boolean => isPlaceholderValue(user) || /^[A-Za-z][A-Za-z._-]{0,31}[0-9]{0,3}$/.test(user);

export interface SecretShapeFinding {
  kind: SecretShapeKind;
  count: number;
}

/** 텍스트에서 비밀값 모양을 찾는다. 종류별 개수만 돌려주며 일치한 문자열은 돌려주지 않는다 */
export function findSecretShapes(text: string): SecretShapeFinding[] {
  const found: SecretShapeFinding[] = [];
  for (const [kind, pattern] of SHAPES) {
    let count = 0;
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      // 비밀 자리가 치환 문법뿐이면 값이 없다: url_credentials 는 `://user:<값>@`, query_secret 은 `?key=<값>`
      const secret = kind === 'url_credentials' ? match[0].slice(match[1]!.length, -1) : kind === 'query_secret' ? match[0].slice(match[1]!.length) : null;
      const userOk = kind !== 'url_credentials' || isPlainUsername(match[1]!.slice(3, -1));
      if (secret !== null && userOk && isPlaceholderValue(secret)) continue;
      count += 1;
    }
    if (count > 0) found.push({ kind, count });
  }
  return found;
}
