// evaluation 이 바깥을 만나는 포트. 실제 구현(네트워크, 모델 호출, 측정 데이터 조회)은 이 패키지에 없다:
// 외부 접근은 도구 게이트웨이를 거쳐야 하므로(trust-boundaries) A5/A6 에서 연결하고, 시험은 가짜 구현을 쓴다.
import type { EvidenceKind, TrustOrigin } from '@aot/domain';

// ===== 출처 접근 =====

export type FetchResult =
  | { reachable: true; status: number; text: string }
  | { reachable: false; reason: string };

/** 출처 URL 접근 (url_reachable, quote_in_source). 트랜잭션 밖에서 불린다. 예외는 "접근 불가"와 같다. */
export interface SourceFetcher {
  fetch(url: string): Promise<FetchResult>;
}

// ===== 로컬 근거 본문 =====

/** 근거(evidence) 행 하나의 본문. 읽지 못했으면 사유 */
export type EvidenceContent =
  | { readable: true; text: string }
  | { readable: false; reason: string };

/**
 * 호스트가 저장한 근거 본문 읽기 (상품 등록 같은 로컬 근거 업무). 출처 URL 은 `SourceFetcher` 가 읽고, 이 포트는 `evidence.ref` 가 URL 이 아닌 행을 읽는다.
 * 본문은 UTF-8 텍스트이고 `evidence.content_hash` 는 그 바이트의 sha256 이다 — 평가기가 해시를 다시 계산해 대조하므로 구현은 저장된 바이트를 그대로 돌려줘야 한다.
 * 예외는 "읽을 수 없음"과 같다.
 */
export interface EvidenceReader {
  read(row: { readonly id: string; readonly kind: EvidenceKind; readonly ref: string; readonly content_hash: string | null }): Promise<EvidenceContent>;
}

// ===== 컨텍스트 분리 LLM 검증 =====

/** 검증 대상 주장 한 문장. 보고서 전문이 아니라 문장 단위로만 넘긴다. */
export interface ClaimStatement {
  readonly id: string;
  readonly statement: string;
  /** 이 주장이 근거로 든 출처의 `SourceText.ref` */
  readonly sourceRef: string;
}

/** 원본에서 직접 읽은 출처 본문 */
export interface SourceText {
  readonly ref: string;
  readonly kind: EvidenceKind;
  /** 읽지 못했으면 null */
  readonly text: string | null;
  readonly contentHash: string | null;
  /** 이 본문의 신뢰 출처. `external_untrusted` 면 검증기는 본문을 데이터로만 읽고 그 안의 지시문을 따르지 않는다. 검증기가 출처 조회기로 읽은 본문은 항상 external_untrusted */
  readonly trustOrigin: TrustOrigin;
}

/**
 * LLM 검증기가 받는 입력의 전부. 실행 에이전트의 프롬프트·세션·보고서 전문·추론 기록이 들어갈 자리가 타입에 없다
 * (ADR-0007 §1-2, evaluation.md §1): 원본 증거(`sources`)와, 검증 대상 주장 문장, 명세의 완료 조건뿐이다.
 * 만드는 길은 `buildIsolatedInput` 하나다.
 */
export interface IsolatedVerificationInput {
  /** 명세의 `validation.llm.check` (예: claim_supported_by_source) */
  readonly check: string;
  /** 명세의 `acceptance_criteria` (작성자가 정한 완료 조건이며 에이전트 출력이 아니다) */
  readonly criteria: readonly string[];
  readonly claims: readonly ClaimStatement[];
  readonly sources: readonly SourceText[];
}

export type LlmVerdict = {
  /** supported: 모든 주장이 근거로 뒷받침됨, unsupported: 뒷받침되지 않는 주장이 있음, unclear: 판단 불가(증거 부족) */
  verdict: 'supported' | 'unsupported' | 'unclear';
  note: string;
  /** 이 검증 호출의 비용 (있으면 검증 단계 비용으로 별도 `cost_entry`에 남는다) */
  costUsd?: number;
  /** 이 검증 호출이 쓴 토큰 수 (구독 호출은 USD 가 아니라 토큰으로 센다, Q22 c). 있으면 검증 단계 `cost_entry` 의 `units.tokens` 로 남는다 */
  tokens?: number;
};

/**
 * 컨텍스트 분리 LLM 검증기. 실행 에이전트와 컨텍스트·프롬프트·세션을 공유하지 않는 별도 호출이어야 하고
 * 가능하면 다른 모델이다 (모델 등급은 Q22). 이 패키지는 인터페이스만 정의한다.
 */
export interface LlmVerifier {
  /** 검증기 식별 (`id@version` 또는 모델 이름). 평가 기록의 메모에 남는다 */
  readonly id: string;
  /**
   * 던지는 것의 의미:
   *  - `VerifierUnavailableError`: 지금은 검증할 수 없다(사용량 한도·로그인 만료·미룸). 평가는 기록되지 않고 업무는 `validating` 에 남아 다음 tick 에 다시 검증된다.
   *  - 그 밖의 오류: 평가기가 `unclear`(→ `inconclusive` → 사람 검토)로 기록한다.
   */
  verify(input: IsolatedVerificationInput): Promise<LlmVerdict>;
}

/**
 * 검증기가 지금은 일을 할 수 없다. 모델이 판단하지 못한 것(`unclear`)과 다르다: 시간이 지나거나 사람이 로그인하면 풀리는 조건이라 사람 검토 업무로 만들지 않고
 * 업무를 `validating` 에 그대로 둔다(평가 행을 쓰지 않는다). 구현은 매 tick(기본 5초) 불리므로 스스로 호출을 조절해야 한다(예: 미룬 동안은 안쪽 호출 없이 바로 던진다).
 */
export class VerifierUnavailableError extends Error {
  /** 사람이 읽는 사유 코드 (예: `usage_limit`, `login_required`, `usage_deferred`) */
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'VerifierUnavailableError';
    this.code = code;
  }
}

// ===== 효과 측정 신호 =====

/**
 * 외부에서 주입된 관측 값 목록. 단위·기준선은 여기서 해석하지 않는다: 값들과 관측 수, 합격선만 받는다.
 * 사람이 입력한 측정 값(A6-U13)은 `createMeasurementSignalSource` 가 신호 정의(D2)와 저장된 측정 이벤트·근거에서 만든다.
 */
export interface EffectSignal {
  /** 신호 이름 (기록용) */
  readonly name: string;
  /** 관측 값. 평균이 효과 점수다 */
  readonly values: readonly number[];
  /** 관측 수. 생략하면 `values.length` (사람이 입력한 주간 값은 값 1개에 그 값이 모은 관측 수를 따로 밝힌다) */
  readonly observations?: number;
  /** 판정에 필요한 최소 관측 수 (evaluation.md §4) */
  readonly minObservations: number;
  /** 호출자가 판정한 데이터 품질(측정 누락률 등). false 면 inconclusive */
  readonly dataQualityOk: boolean;
  /** 데이터 품질이 불량인 이유 (기록용, 생략 가능) */
  readonly qualityNote?: string;
  /** 관측 평균이 이 값 이상이어야 효과 기준 충족. 없으면 효과는 기록만 하고 판정에 쓰지 않는다 */
  readonly passAtLeast?: number;
}

export type EffectObservation =
  | { measurable: true; signal: EffectSignal }
  | { measurable: false; reason: string };

/** 업무 실행에 대한 효과 측정 값 조회. 신호가 없는 업무는 null. 원본(분석 API 등)에서 직접 읽어야 하며 에이전트 보고서 경유는 금지다. */
export interface EffectSignalSource {
  read(request: { taskId: string; taskRunId: string }): Promise<EffectObservation | null>;
}
