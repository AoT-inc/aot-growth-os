// 전화 영역의 오류. provider 오류는 canonical 코드로 바꿔 던진다: 호출자(부작용 도구)는 provider 별 오류 모양을 알 필요가 없다.

export type PhoneRuleCode =
  | 'invalid_input'
  | 'invalid_event'
  | 'call_not_found'
  | 'provider_mismatch'
  | 'outcome_conflict'
  | 'agent_forbidden'
  | 'link_conflict'
  | 'not_open';

/** AoT 규칙 위반 (입력 검증 실패는 ValidationError, 이 오류는 상태·권한 규칙) */
export class PhoneRuleError extends Error {
  readonly code: PhoneRuleCode;
  constructor(code: PhoneRuleCode, message: string) {
    super(message);
    this.name = 'PhoneRuleError';
    this.code = code;
  }
}

export const PROVIDER_ERROR_CODES = ['invalid_request', 'unauthorized', 'not_found', 'rate_limited', 'unavailable', 'timeout', 'unknown'] as const;
export type PhoneProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * provider 호출 실패. `definite` 가 참이면 provider 가 요청을 처리하지 않았다는 뜻이다(잘못된 요청·인증 실패·한도 초과 등) — 부작용 원장은 `failed` 로 기록한다.
 * 거짓이면 요청이 도달했는지 알 수 없다(타임아웃·5xx·연결 끊김) — 원장은 `unknown` 이 되고, 멱등 키를 지원하지 않는 도구는 자동 재전송하지 않는다
 * (전화를 두 번 거는 것은 더 나쁘다, ADR-0014 §10).
 */
export class PhoneProviderError extends Error {
  readonly code: PhoneProviderErrorCode;
  readonly definite: boolean;
  readonly status: number | null;
  constructor(code: PhoneProviderErrorCode, message: string, options: { status?: number | null } = {}) {
    super(message);
    this.name = 'PhoneProviderError';
    this.code = code;
    this.status = options.status ?? null;
    this.definite = code === 'invalid_request' || code === 'unauthorized' || code === 'not_found' || code === 'rate_limited';
  }
}

/** HTTP 상태 → canonical provider 오류. 어댑터가 공통으로 쓴다. 메시지에는 응답 본문을 넣지 않는다(비밀·개인정보 가능성) */
export function providerErrorFromHttp(status: number, what: string): PhoneProviderError {
  const message = `${what}: provider answered HTTP ${status}`;
  if (status === 401 || status === 403) return new PhoneProviderError('unauthorized', message, { status });
  if (status === 404) return new PhoneProviderError('not_found', message, { status });
  if (status === 429) return new PhoneProviderError('rate_limited', message, { status });
  if (status === 408 || status === 504) return new PhoneProviderError('timeout', message, { status });
  if (status >= 400 && status < 500) return new PhoneProviderError('invalid_request', message, { status });
  if (status >= 500) return new PhoneProviderError('unavailable', message, { status });
  return new PhoneProviderError('unknown', message, { status });
}

/** webhook 을 받아들이지 않은 이유. 어댑터가 서명/비밀 검증과 형식 검사에서 던진다 */
export class PhoneWebhookError extends Error {
  readonly code: 'unauthorized' | 'malformed';
  constructor(code: 'unauthorized' | 'malformed', message: string) {
    super(message);
    this.name = 'PhoneWebhookError';
    this.code = code;
  }
}
