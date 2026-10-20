// 컨텍스트 분리 LLM 검증의 입력을 만드는 유일한 길. 인자 타입에 보고서 전문·프롬프트·세션이 들어갈 자리가 없고(타입 시험으로 고정),
// 문장 길이와 개수를 제한해 보고서 전체가 "주장"인 척 들어오지 못하게 한다.
import type { ClaimStatement, IsolatedVerificationInput, SourceText } from './ports.ts';

export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationError';
  }
}

/** 주장 한 문장의 최대 길이. 보고서 전문을 한 항목으로 밀어 넣는 것을 막는다 */
export const MAX_STATEMENT_CHARS = 1000;
export const MAX_CLAIMS = 200;

export interface IsolatedInputParts {
  check: string;
  criteria: readonly string[];
  claims: readonly ClaimStatement[];
  sources: readonly SourceText[];
}

/** 입력의 키 집합. 검증기 구현이 받은 객체가 이 모양인지 확인할 때도 쓴다 */
export const ISOLATED_INPUT_KEYS = ['check', 'claims', 'criteria', 'sources'] as const;

export function buildIsolatedInput(parts: IsolatedInputParts): IsolatedVerificationInput {
  if (parts.check.trim() === '') throw new IsolationError('check must not be empty');
  if (parts.claims.length > MAX_CLAIMS) throw new IsolationError(`too many claims (${parts.claims.length} > ${MAX_CLAIMS})`);
  const sourceRefs = new Set(parts.sources.map((source) => source.ref));
  const claims: ClaimStatement[] = parts.claims.map((claim) => {
    if (claim.statement.length > MAX_STATEMENT_CHARS) {
      throw new IsolationError(`claim '${claim.id}' is longer than ${MAX_STATEMENT_CHARS} characters; only single statements are passed, not report text`);
    }
    if (!sourceRefs.has(claim.sourceRef)) throw new IsolationError(`claim '${claim.id}' cites '${claim.sourceRef}', which is not among the original sources`);
    return Object.freeze({ id: claim.id, statement: claim.statement, sourceRef: claim.sourceRef });
  });
  // 필드를 하나씩 복사한다: 호출자가 넘긴 객체에 딸려 온 다른 속성(보고서 조각 등)이 전달되지 않는다.
  return Object.freeze({
    check: parts.check,
    criteria: Object.freeze([...parts.criteria]),
    claims: Object.freeze(claims),
    sources: Object.freeze(parts.sources.map((source) => Object.freeze({
      ref: source.ref, kind: source.kind, text: source.text, contentHash: source.contentHash,
    }))),
  });
}
