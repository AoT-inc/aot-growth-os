// 비밀값 스캔 결과 요약의 형식 (`secret_scan_summary@1`). 도구 어댑터(secret_scan)가 스캐너 출력에서 *필드를 골라* 만들어 근거 본문으로 저장하고,
// 평가기가 `scan_coverage_complete`·`classification_present` 에서 읽는다. 값 원문은 이 형식에 들어갈 자리가 없다: 위치·종류·개수·범위뿐이다.
// 허용 키 목록은 닫혀 있다 — 스캐너 출력의 `Secret`·`Match` 같은 필드가 딸려 와도 파서가 거부한다.
export const SECRET_SCAN_SUMMARY_TYPE = 'secret_scan_summary@1';

export const SCAN_SCOPES = ['tree', 'history'] as const;
export type ScanScope = (typeof SCAN_SCOPES)[number];

export const SCAN_CONFIDENCES = ['low', 'medium', 'high'] as const;

export interface SecretScanFindingSummary {
  /** 작업 트리 경로 또는 이력 위치(`<커밋>:<경로>`). 비밀값이 아니다 */
  location: string;
  /** 스캐너 규칙 종류(예: `aws-access-token`) */
  kind: string;
  confidence?: (typeof SCAN_CONFIDENCES)[number];
}

export interface SecretScanSummary {
  type: typeof SECRET_SCAN_SUMMARY_TYPE;
  scope: ScanScope;
  /** 범위 전체를 끝까지 스캔했는가. 시간 초과·크기 상한으로 일부만 봤으면 false */
  complete: boolean;
  /** 스캐너 이름과 버전 (예: `gitleaks@8.30.1`) */
  scanner: string;
  /** scope=tree 일 때만: 스캔한 파일 수 */
  files_scanned?: number;
  /** scope=history 일 때만: 스캔한 커밋 수 */
  commits_scanned?: number;
  findings: SecretScanFindingSummary[];
}

export const MAX_SCAN_FINDINGS = 10_000;

export type SecretScanSummaryParse = { ok: true; summary: SecretScanSummary } | { ok: false; reason: string };

const SUMMARY_KEYS = ['type', 'scope', 'complete', 'scanner', 'files_scanned', 'commits_scanned', 'findings'];
const FINDING_KEYS = ['location', 'kind', 'confidence'];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max;

/** 근거 본문 텍스트가 스캔 요약인지 검사한다. JSON 이 아니거나 `type` 이 다르면 `reason` 이 `not a scan summary` 로 시작한다(다른 종류의 근거) */
export function parseSecretScanSummary(text: string): SecretScanSummaryParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not a scan summary: the content is not JSON' };
  }
  if (!isObject(parsed) || parsed['type'] !== SECRET_SCAN_SUMMARY_TYPE) return { ok: false, reason: `not a scan summary: type is not ${SECRET_SCAN_SUMMARY_TYPE}` };
  const extra = Object.keys(parsed).filter((key) => !SUMMARY_KEYS.includes(key));
  if (extra.length > 0) return { ok: false, reason: `scan summary has unexpected field(s): ${extra.join(', ')}` };
  const scope = parsed['scope'];
  if (scope !== 'tree' && scope !== 'history') return { ok: false, reason: 'scan summary scope must be tree or history' };
  if (typeof parsed['complete'] !== 'boolean') return { ok: false, reason: 'scan summary complete must be a boolean' };
  if (!isText(parsed['scanner'], 80)) return { ok: false, reason: 'scan summary scanner must be a short non-empty string' };
  const files = parsed['files_scanned'];
  const commits = parsed['commits_scanned'];
  if (scope === 'tree' && (!isCount(files) || commits !== undefined)) return { ok: false, reason: 'a tree scan summary needs files_scanned (a count) and no commits_scanned' };
  if (scope === 'history' && (!isCount(commits) || files !== undefined)) return { ok: false, reason: 'a history scan summary needs commits_scanned (a count) and no files_scanned' };
  const findings = parsed['findings'];
  if (!Array.isArray(findings) || findings.length > MAX_SCAN_FINDINGS) return { ok: false, reason: `scan summary findings must be a list of at most ${MAX_SCAN_FINDINGS}` };
  const clean: SecretScanFindingSummary[] = [];
  for (const [index, item] of findings.entries()) {
    if (!isObject(item)) return { ok: false, reason: `finding #${index + 1} is not an object` };
    const unexpected = Object.keys(item).filter((key) => !FINDING_KEYS.includes(key));
    if (unexpected.length > 0) return { ok: false, reason: `finding #${index + 1} has unexpected field(s): ${unexpected.join(', ')}` };
    const confidence = item['confidence'];
    if (!isText(item['location'], 500) || !isText(item['kind'], 100) || (confidence !== undefined && !(SCAN_CONFIDENCES as readonly unknown[]).includes(confidence))) {
      return { ok: false, reason: `finding #${index + 1} needs a location, a kind and an optional confidence (low|medium|high)` };
    }
    clean.push({ location: item['location'], kind: item['kind'], ...(confidence === undefined ? {} : { confidence: confidence as NonNullable<SecretScanFindingSummary['confidence']> }) });
  }
  return {
    ok: true,
    summary: {
      type: SECRET_SCAN_SUMMARY_TYPE, scope, complete: parsed['complete'], scanner: parsed['scanner'],
      ...(scope === 'tree' ? { files_scanned: files as number } : { commits_scanned: commits as number }),
      findings: clean,
    },
  };
}
