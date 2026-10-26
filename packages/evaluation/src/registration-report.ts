// 상품 등록 검증 업무(workflows/product-registration.md)의 보고서 형식 `registration-report@1`. 보고서는 에이전트가 낸 참고 자료이고(evaluation.md §3-2),
// 여기서 읽는 것은 *근거를 가리키는 참조*뿐이다: 값 자체는 호스트가 저장한 근거 본문에서 평가기가 직접 읽는다.
//
//   {
//     "claims":         [ { "id"?: string, "statement": string, "evidence_id": string } ],            // LLM 검증 대상 문장. 근거는 이 업무의 evidence 행 id
//     "collection":     [ { "item": <COLLECTION_ITEMS>, "status": "collected", "evidence_ids": [string] }
//                       | { "item": <COLLECTION_ITEMS>, "status": "unavailable", "reason": string } ],  // 수집 항목 표(§2)의 항목마다 정확히 하나
//     "classification": { "proposal": "public_candidate" | "internal" | "restricted", "rationale_evidence_ids": [string] },
//     "uncertainties":  [ ... ]                                                                       // 기존 형식(uncertainties.ts)
//   }
//
// 모양이 틀린 부분은 사유로 모아 돌려준다(보고서를 믿지 않는다). `claims` 에서 `evidence_id` 대신 `source_url` 을 가진 항목은 출처 URL 주장(claims.ts)이라 여기서는 무시한다.
export const COLLECTION_ITEMS = [
  'repo_structure', 'stack', 'readme_summary', 'remote', 'default_branch', 'activity_history', 'license', 'environment', 'secret_scan',
] as const;
export type CollectionItem = (typeof COLLECTION_ITEMS)[number];

export const CLASSIFICATIONS = ['public_candidate', 'internal', 'restricted'] as const;
export type ClassificationProposal = (typeof CLASSIFICATIONS)[number];

export const MAX_EVIDENCE_IDS_PER_ITEM = 50;
export const MAX_REASON_CHARS = 500;
const MAX_EVIDENCE_ID_CHARS = 200;

export type CollectionEntry =
  | { item: CollectionItem; status: 'collected'; evidenceIds: string[] }
  | { item: CollectionItem; status: 'unavailable'; reason: string };

export interface RegistrationReport {
  collection: CollectionEntry[];
  classification: { proposal: ClassificationProposal; rationaleEvidenceIds: string[] };
}

export interface EvidenceClaim {
  id: string;
  statement: string;
  evidenceId: string;
}

export type RegistrationReportParse = { ok: true; report: RegistrationReport } | { ok: false; reasons: string[] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEvidenceId = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_EVIDENCE_ID_CHARS;

function parseJson(result: string | null): unknown {
  if (result === null) return undefined;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

function evidenceIdList(value: unknown, where: string, reasons: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_IDS_PER_ITEM || !value.every(isEvidenceId)) {
    reasons.push(`${where}: evidence ids must be a non-empty list of at most ${MAX_EVIDENCE_IDS_PER_ITEM} evidence row ids`);
    return [];
  }
  return [...new Set(value as string[])];
}

export function parseRegistrationReport(result: string | null): RegistrationReportParse {
  const parsed = parseJson(result);
  if (!isObject(parsed)) return { ok: false, reasons: ['the run result is not a JSON object'] };
  const reasons: string[] = [];

  const collection: CollectionEntry[] = [];
  const list = parsed['collection'];
  if (!Array.isArray(list)) {
    reasons.push('collection must be a list with one entry per collection item');
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      const where = `collection[${index}]`;
      if (!isObject(entry)) {
        reasons.push(`${where} is not an object`);
        continue;
      }
      const item = entry['item'];
      if (typeof item !== 'string' || !(COLLECTION_ITEMS as readonly string[]).includes(item)) {
        reasons.push(`${where}: unknown item '${String(item).slice(0, 40)}'`);
        continue;
      }
      if (seen.has(item)) {
        reasons.push(`${where}: item '${item}' appears more than once`);
        continue;
      }
      seen.add(item);
      if (entry['status'] === 'collected') {
        const ids = evidenceIdList(entry['evidence_ids'], `${where} (${item})`, reasons);
        if (ids.length > 0) collection.push({ item: item as CollectionItem, status: 'collected', evidenceIds: ids });
      } else if (entry['status'] === 'unavailable') {
        const reason = entry['reason'];
        if (typeof reason !== 'string' || reason.trim() === '' || reason.length > MAX_REASON_CHARS) reasons.push(`${where} (${item}): an unavailable item needs a reason of at most ${MAX_REASON_CHARS} characters`);
        else collection.push({ item: item as CollectionItem, status: 'unavailable', reason: reason.trim() });
      } else {
        reasons.push(`${where} (${item}): status must be collected or unavailable`);
      }
    }
    const missing = COLLECTION_ITEMS.filter((item) => !seen.has(item));
    if (missing.length > 0) reasons.push(`collection is missing item(s): ${missing.join(', ')}`);
  }

  const proposal = isObject(parsed['classification']) ? parsed['classification'] : undefined;
  let classification: RegistrationReport['classification'] | null = null;
  if (proposal === undefined) {
    reasons.push('classification is missing');
  } else if (typeof proposal['proposal'] !== 'string' || !(CLASSIFICATIONS as readonly string[]).includes(proposal['proposal'])) {
    reasons.push(`classification.proposal must be one of ${CLASSIFICATIONS.join(', ')}`);
  } else {
    const rationale = evidenceIdList(proposal['rationale_evidence_ids'], 'classification.rationale_evidence_ids', reasons);
    if (rationale.length > 0) classification = { proposal: proposal['proposal'] as ClassificationProposal, rationaleEvidenceIds: rationale };
  }

  if (reasons.length > 0 || classification === null) return { ok: false, reasons: reasons.length > 0 ? reasons : ['classification is missing'] };
  return { ok: true, report: { collection, classification } };
}

/** 보고서의 `claims` 중 근거 행을 가리키는 항목. 모양이 맞지 않는 항목은 버린다 */
export function evidenceClaimsFromResult(result: string | null): EvidenceClaim[] {
  const parsed = parseJson(result);
  const list = isObject(parsed) ? parsed['claims'] : undefined;
  if (!Array.isArray(list)) return [];
  const claims: EvidenceClaim[] = [];
  list.forEach((item: unknown, index) => {
    if (!isObject(item)) return;
    const statement = item['statement'];
    const evidenceId = item['evidence_id'];
    if (typeof statement !== 'string' || statement.trim() === '' || !isEvidenceId(evidenceId)) return;
    const id = item['id'];
    claims.push({ id: typeof id === 'string' && id.trim() !== '' ? id : `claim-${index + 1}`, statement: statement.trim(), evidenceId });
  });
  return claims;
}

/** 보고서가 가리키는 근거 행 id 전부 (수집 항목·분류 근거·근거 주장) */
export function referencedEvidenceIds(report: RegistrationReport, claims: readonly EvidenceClaim[]): string[] {
  const ids = new Set<string>();
  for (const entry of report.collection) if (entry.status === 'collected') for (const id of entry.evidenceIds) ids.add(id);
  for (const id of report.classification.rationaleEvidenceIds) ids.add(id);
  for (const claim of claims) ids.add(claim.evidenceId);
  return [...ids];
}
