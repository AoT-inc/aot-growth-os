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

export interface SecretShapeFinding {
  kind: SecretShapeKind;
  count: number;
}

/** 텍스트에서 비밀값 모양을 찾는다. 종류별 개수만 돌려주며 일치한 문자열은 돌려주지 않는다 */
export function findSecretShapes(text: string): SecretShapeFinding[] {
  const found: SecretShapeFinding[] = [];
  for (const [kind, pattern] of SHAPES) {
    const count = [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
    if (count > 0) found.push({ kind, count });
  }
  return found;
}
