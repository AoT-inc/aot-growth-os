// 가짜 LLM 검증기 (A6-U12). 모델을 호출하지 않는 결정적 구현이다: 이름이 `Stub` 인 이유는 운영 코드에 있어도 이것이 실제 검증이 아님을 드러내기 위해서다.
// 실제 모델 연결(모델 등급·비용 비율)은 Q22 후속이며, 그때까지 데몬 설정 `llm_verifier: {kind: "stub"}` 로 통합 시나리오를 확인하는 데 쓴다.
//
// 판정 규칙 (주장마다, 위가 우선):
//   1. 주입된 판정표(`verdicts[claim.id]`)에 있으면 그 값
//   2. 주입된 규칙(`rule`)이 있으면 그 값
//   3. 기본 규칙: 출처 본문을 읽지 못했으면 unclear, 주장 문장이 본문에 (공백 차이 무시, 대소문자 구분) 부분 문자열로 있으면 supported, 아니면 unsupported
// 전체 판정: 하나라도 unsupported 면 unsupported, 아니면 하나라도 unclear 면 unclear(주장이 하나도 없는 경우 포함), 아니면 supported.
// 입력은 `buildIsolatedInput` 이 만든 모양(check, claims, criteria, sources)뿐이어야 한다: 다른 키가 딸려 오면 거부한다(격리 위반).
import { ISOLATED_INPUT_KEYS, IsolationError } from './isolation.ts';
import type { ClaimStatement, IsolatedVerificationInput, LlmVerdict, LlmVerifier, SourceText } from './ports.ts';

export const STUB_LLM_VERIFIER_ID = 'stub-llm-verifier@v1';

export type StubClaimVerdict = LlmVerdict['verdict'];

export interface StubLlmVerifierOptions {
  /** 평가 기록에 남는 검증기 식별. 기본 `stub-llm-verifier@v1` */
  id?: string;
  /** 검증 호출 한 번의 비용(USD). 기본 0. 0 보다 크면 평가기가 `units.source='validation'` 으로 원장에 남긴다 */
  costUsd?: number;
  /** 주장 id → 판정 */
  verdicts?: Readonly<Record<string, StubClaimVerdict>>;
  /** 판정표에 없는 주장에 적용할 규칙. 없으면 기본 규칙 */
  rule?: (claim: ClaimStatement, source: SourceText | undefined) => StubClaimVerdict;
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** 기본 규칙: 주장 문장이 출처 본문에 부분 문자열로 있으면 supported */
export function substringRule(claim: ClaimStatement, source: SourceText | undefined): StubClaimVerdict {
  if (source === undefined || source.text === null) return 'unclear';
  const statement = normalize(claim.statement);
  if (statement === '') return 'unclear';
  return normalize(source.text).includes(statement) ? 'supported' : 'unsupported';
}

export function createStubLlmVerifier(options: StubLlmVerifierOptions = {}): LlmVerifier {
  const id = options.id ?? STUB_LLM_VERIFIER_ID;
  const costUsd = options.costUsd ?? 0;
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new RangeError('costUsd must be a finite number >= 0');
  const rule = options.rule ?? substringRule;
  return {
    id,
    verify(input: IsolatedVerificationInput): Promise<LlmVerdict> {
      try {
        return Promise.resolve(judge(input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };

  function judge(input: IsolatedVerificationInput): LlmVerdict {
    const keys = Object.keys(input).sort();
    if (keys.length !== ISOLATED_INPUT_KEYS.length || keys.some((key, index) => key !== ISOLATED_INPUT_KEYS[index])) {
      throw new IsolationError(`the verification input must have exactly the keys ${ISOLATED_INPUT_KEYS.join(', ')}`);
    }
    const sources = new Map(input.sources.map((source) => [source.ref, source]));
    const unsupported: string[] = [];
    const unclear: string[] = [];
    for (const claim of input.claims) {
      const verdict = options.verdicts !== undefined && Object.hasOwn(options.verdicts, claim.id)
        ? options.verdicts[claim.id]!
        : rule(claim, sources.get(claim.sourceRef));
      if (verdict === 'unsupported') unsupported.push(claim.id);
      else if (verdict === 'unclear') unclear.push(claim.id);
    }
    const verdict: StubClaimVerdict = unsupported.length > 0 ? 'unsupported' : unclear.length > 0 || input.claims.length === 0 ? 'unclear' : 'supported';
    const note = input.claims.length === 0 ? 'no claim to verify'
      : verdict === 'unsupported' ? `unsupported claim(s): ${unsupported.join(', ')}`
        : verdict === 'unclear' ? `undecided claim(s): ${unclear.join(', ')}`
          : `${input.claims.length} claim(s) supported by their sources`;
    return { verdict, note: `stub (no model call): ${note}`.slice(0, 500), ...(costUsd > 0 ? { costUsd } : {}) };
  }
}
