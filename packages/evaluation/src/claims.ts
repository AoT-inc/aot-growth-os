// 실행 에이전트의 보고서(`task_run.result`)에서 검증 대상 주장을 뽑는다. 보고서는 참고 자료이며(evaluation.md §3-2)
// 여기서 뽑은 주장은 "검증받을 대상"이지 근거가 아니다: 출처 본문은 원본(SourceFetcher)에서 직접 읽는다.
// 어댑터 출력 계약(A5, ADR-0005)이 정해지면 이 추출기를 계약에 맞춘다. 지금은 다음 모양만 받는다:
//   { "claims": [ { "id"?: string, "statement": string, "source_url": string, "quote"?: string } ] }
// 모양이 맞지 않는 항목은 버린다(보고서를 믿지 않는다).
export interface ReportedClaim {
  id: string;
  statement: string;
  sourceUrl: string;
  quote: string | null;
}

export function claimsFromResult(result: string | null): ReportedClaim[] {
  if (result === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return [];
  }
  const list = typeof parsed === 'object' && parsed !== null ? (parsed as { claims?: unknown }).claims : undefined;
  if (!Array.isArray(list)) return [];
  const claims: ReportedClaim[] = [];
  list.forEach((item: unknown, index) => {
    if (typeof item !== 'object' || item === null) return;
    const entry = item as Record<string, unknown>;
    const statement = entry['statement'];
    const sourceUrl = entry['source_url'];
    if (typeof statement !== 'string' || statement.trim() === '' || typeof sourceUrl !== 'string' || sourceUrl.trim() === '') return;
    const quote = entry['quote'];
    const id = entry['id'];
    claims.push({
      id: typeof id === 'string' && id.trim() !== '' ? id : `claim-${index + 1}`,
      statement: statement.trim(),
      sourceUrl: sourceUrl.trim(),
      quote: typeof quote === 'string' && quote.trim() !== '' ? quote : null,
    });
  });
  return claims;
}
