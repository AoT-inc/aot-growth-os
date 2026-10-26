// 도구 결과 본문을 호스트 근거로 저장하는 포트. 데몬이 run 마다 만들어 넘긴다(본문 저장소 + `RunContext.recordEvidence`).
// 에이전트는 이 포트에 닿을 수 없다: 근거 행은 도구 *실행기*(호스트 코드)만 만들고, 에이전트는 결과에 담겨 온 `evidence_id` 로 보고서에서 가리킬 뿐이다.
// 본문은 UTF-8 텍스트이고 행의 `content_hash` 는 그 바이트의 sha256 이다 — 평가기가 저장된 본문을 읽어 다시 계산해 대조한다.
export interface CapturedEvidence {
  /** `evidence.id` — 도구 결과에 실어 에이전트가 보고서에서 인용하게 한다 */
  evidenceId: string;
  sha256: string;
}

export interface EvidenceCapture {
  /** 본문을 저장하고 근거 행(kind=document)을 남긴다. 신뢰 출처: 저장소·README에서 온 것은 `external_untrusted`, 호스트가 만든 스캔 요약은 `internal` */
  capture(input: { text: string; trustOrigin: 'internal' | 'external_untrusted' }): Promise<CapturedEvidence>;
}

/** 이 run 이 읽을 저장소. 데몬이 명세의 `repo:<slug>` 대상과 `product_repo` 에서 해석한다(에이전트는 경로를 주지 못한다) */
export interface RepoBinding {
  slug: string;
  /** 저장소 루트의 절대 경로 */
  root: string;
}

export interface RegistrationToolRun {
  /** 호출 때마다 부른다: 접근 범위가 회수됐거나 대상이 바뀌었으면 던진다(`repo_access_not_granted`/`repo_not_bound`) */
  repo(): RepoBinding;
  evidence: EvidenceCapture;
}
