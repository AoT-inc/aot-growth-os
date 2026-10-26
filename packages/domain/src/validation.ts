// 검증 결과 공통 형태와 작은 보조 함수. 검증기는 예외 대신 모든 문제를 모아 돌려준다.

export interface Issue {
  /** 예: `constraints.network_allowlist[1]` */
  path: string;
  /** 기계가 구분할 짧은 코드 */
  code: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: Issue[] };

export class ValidationError extends Error {
  readonly errors: readonly Issue[];
  constructor(what: string, errors: readonly Issue[]) {
    super(`${what} is invalid: ${errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export type PlainObject = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export const isNonBlankString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export const joinPath = (base: string, key: string | number): string =>
  typeof key === 'number' ? `${base}[${key}]` : base === '' ? key : `${base}.${key}`;

/** 수집기: 문제를 쌓고 마지막에 결과로 바꾼다. */
export class IssueCollector {
  readonly issues: Issue[] = [];
  add(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }
  result<T>(value: T): ValidationResult<T> {
    return this.issues.length === 0 ? { ok: true, value } : { ok: false, errors: this.issues };
  }
}

/** `allowed` 밖의 키가 있으면 각각 문제로 쌓는다. */
export function rejectUnknownKeys(obj: PlainObject, allowed: readonly string[], path: string, out: IssueCollector): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) out.add(joinPath(path, key), 'unknown_field', `unknown field '${key}'`);
  }
}
