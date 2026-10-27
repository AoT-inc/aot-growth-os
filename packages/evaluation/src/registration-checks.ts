// 상품 등록 검증 업무의 결정론적 검사 5개 (workflows/product-registration.md §3·§6). 모델을 쓰지 않고 같은 입력이면 같은 결과를 낸다.
//   evidence_refs_resolvable  보고서의 근거 참조가 모두 이 업무의 근거 행이고, 호스트가 저장한 본문을 읽을 수 있으며, 본문의 sha256 이 기록된 해시와 같다.
//                             수집 항목(§2)은 항목마다 근거 참조 또는 "수집 불가" 사유가 있다
//   no_secret_in_outputs      (안전성) run 결과와 저장된 근거 본문에 비밀값 모양이 없다. 종류·개수만 보고하고 값은 보고하지 않는다
//   read_only_calls_only      (안전성) 이 run 의 도구 호출 판정에 읽기 아닌 영향(write/delete/external_effect)이 없고 보낸 외부 부작용이 없다.
//                             거부된 쓰기 시도도 위반이다(지시문에 유도된 시도일 수 있다)
//   scan_coverage_complete    보고서의 secret_scan 근거에 작업 트리와 이력 스캔 요약이 각각 있고 범위를 끝까지 스캔했다(`complete`)
//   classification_present    분류 제안이 있고 근거 행이 있으며, 스캔에서 후보가 나왔는데 `public_candidate` 로 제안하지 않았다(완화 방향 금지)
// 필요한 포트(EvidenceReader)가 없으면 읽어야 하는 검사는 'unknown' 이다 → 평가는 inconclusive (조용히 통과하지 않는다).
// checks.ts 가 이 파일을 가져오므로 checks.ts 의 타입을 가져오지 않는다(순환 금지): 결과 모양은 구조적으로 같다.
import type { Db, EvidenceRow, TaskRunRow } from '@aot/domain';

import type { EvidenceContentReader } from './evidence-contents.ts';
import { evidenceClaimsFromResult, parseRegistrationReport, referencedEvidenceIds, type RegistrationReport } from './registration-report.ts';
import { findSecretShapes } from './secret-patterns.ts';
import { parseSecretScanSummary, type ScanScope, type SecretScanSummary } from './secret-scan-summary.ts';

export const EVIDENCE_REFS_CHECK_ID = 'evidence_refs_resolvable';
export const NO_SECRET_CHECK_ID = 'no_secret_in_outputs';
export const READ_ONLY_CHECK_ID = 'read_only_calls_only';
export const SCAN_COVERAGE_CHECK_ID = 'scan_coverage_complete';
export const CLASSIFICATION_CHECK_ID = 'classification_present';

export interface RegistrationCheckInput {
  db: Db;
  run: Pick<TaskRunRow, 'id' | 'result'>;
  /** 이 run 의 근거 행 (이 업무의 행 중 run 이 같거나 run 이 없는 것) */
  evidence: readonly EvidenceRow[];
  /** EvidenceReader 가 연결되지 않았으면 undefined */
  contents: EvidenceContentReader | undefined;
}

export interface RegistrationCheckOutcome {
  status: 'pass' | 'fail' | 'unknown';
  note: string;
  evidence?: ReadonlyMap<string, { verified: boolean; note: string }>;
}

const NO_READER = 'no evidence reader is configured, so the stored content cannot be checked';
const cut = (text: string, max = 400): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * 호스트가 저장한 본문의 참조 접두 (apps/daemon 근거 저장소의 `blob:sha256:<hex>`, task-engine 의 호스트 전용 이름 공간). 에이전트는 이 접두를 쓸 수 없다.
 * 접두가 없는 행은 에이전트가 보고한 인용(예: 호스트 근거 id `ev-…` 를 다시 적은 것)이라 *저장된 본문이 없다* (근거 저장소의 읽기 포트는 `blob:sha256:<64 hex>` 참조만 읽으므로 이전에도 이 행들은 읽히지 않았다 —
 * 그 결합이 바뀌면(읽기 포트가 다른 참조를 읽게 되면) 이 판정도 다시 봐야 한다) — 읽을 본문이 없으므로 `unknown` 이 아니라 참조 문자열만 본다.
 */
const HOST_BLOB_PREFIX = 'blob:';

/** 비밀값 모양을 찾을 근거 종류. 출처 URL 은 출처 조회기 몫이고, 로그·승인·측정 행은 호스트 근거 본문이 아니다 */
const SCANNED_KINDS: readonly string[] = ['document', 'test_result', 'other'];

export async function checkEvidenceRefsResolvable(input: RegistrationCheckInput): Promise<RegistrationCheckOutcome> {
  if (input.contents === undefined) return { status: 'unknown', note: NO_READER };
  const parsed = parseRegistrationReport(input.run.result);
  if (!parsed.ok) return { status: 'fail', note: cut(`registration report is invalid: ${parsed.reasons.join('; ')}`) };
  const ids = referencedEvidenceIds(parsed.report, evidenceClaimsFromResult(input.run.result));
  const rows = new Map(input.evidence.map((row) => [row.id, row]));
  const failures: string[] = [];
  const contributions = new Map<string, { verified: boolean; note: string }>();
  for (const id of ids) {
    const row = rows.get(id);
    if (row === undefined) {
      failures.push(`${id}: not an evidence row of this task`);
      continue;
    }
    const content = await input.contents.read(row);
    if (content.ok) {
      contributions.set(id, { verified: true, note: 'content readable, hash matches' });
    } else {
      failures.push(`${id}: ${content.reason}`);
      contributions.set(id, { verified: false, note: content.reason });
    }
  }
  return failures.length === 0
    ? { status: 'pass', note: `${ids.length} evidence reference(s) resolved with matching hashes; ${parsed.report.collection.length} collection item(s) accounted for`, evidence: contributions }
    : { status: 'fail', note: cut(`unresolved: ${failures.join('; ')}`), evidence: contributions };
}

export async function checkNoSecretInOutputs(input: RegistrationCheckInput): Promise<RegistrationCheckOutcome> {
  if (input.contents === undefined) return { status: 'unknown', note: NO_READER };
  const findings: string[] = [];
  const describe = (where: string, text: string): void => {
    const shapes = findSecretShapes(text);
    if (shapes.length > 0) findings.push(`${where}: ${shapes.map((shape) => `${shape.kind} x${shape.count}`).join(', ')}`);
  };
  if (input.run.result !== null) describe('run result', input.run.result);
  let unread = 0;
  let scanned = 0;
  for (const row of input.evidence) {
    if (!SCANNED_KINDS.includes(row.kind)) continue;
    if (!row.ref.startsWith(HOST_BLOB_PREFIX)) {
      // 에이전트가 보고한 인용 행: 저장된 본문이 없으니 참조 문자열(에이전트가 쓴 값)만 본다
      describe(`evidence ${row.id} reference`, row.ref);
      continue;
    }
    const content = await input.contents.read(row);
    if (!content.ok) {
      unread += 1;
      continue;
    }
    scanned += 1;
    describe(`evidence ${row.id}`, content.text);
  }
  if (findings.length > 0) return { status: 'fail', note: cut(`secret-like value(s) found (kind and count only, never the value): ${findings.join('; ')}`) };
  if (unread > 0) return { status: 'unknown', note: `${unread} evidence row(s) could not be read, so they were not scanned for secret-like values` };
  return { status: 'pass', note: `no secret-like value in the run result or in ${scanned} stored evidence content(s) (agent-reported citation rows have no stored content; their reference text was checked)` };
}

export function checkReadOnlyCalls(input: Pick<RegistrationCheckInput, 'db' | 'run'>): RegistrationCheckOutcome {
  const calls = Number(input.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM policy_decision WHERE task_run_id = ?', [input.run.id])?.n ?? 0);
  const writes = input.db.all<{ action: string; impact: string; decision: string }>(
    "SELECT action, impact, decision FROM policy_decision WHERE task_run_id = ? AND impact <> 'read' ORDER BY id LIMIT 20", [input.run.id],
  );
  const effects = Number(input.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM external_effect WHERE task_run_id = ?', [input.run.id])?.n ?? 0);
  const violations = [
    ...writes.map((call) => `${call.action} (${call.impact}, ${call.decision})`),
    ...(effects > 0 ? [`${effects} external effect(s) recorded`] : []),
  ];
  return violations.length === 0
    ? { status: 'pass', note: `${calls} tool call decision(s), all read-only; no external effect` }
    : { status: 'fail', note: cut(`non-read activity in a read-only task: ${violations.join('; ')}`) };
}

// ----- 스캔 요약 -----

type ScanLoad =
  | { ok: true; report: RegistrationReport; summaries: SecretScanSummary[] }
  | { ok: false; status: 'fail' | 'unknown'; note: string };

/** 보고서의 `secret_scan` 수집 항목이 가리키는 근거 본문을 읽어 스캔 요약으로 해석한다 */
async function loadScanSummaries(input: RegistrationCheckInput): Promise<ScanLoad> {
  if (input.contents === undefined) return { ok: false, status: 'unknown', note: NO_READER };
  const parsed = parseRegistrationReport(input.run.result);
  if (!parsed.ok) return { ok: false, status: 'fail', note: cut(`registration report is invalid: ${parsed.reasons.join('; ')}`) };
  const entry = parsed.report.collection.find((candidate) => candidate.item === 'secret_scan');
  if (entry === undefined || entry.status !== 'collected') {
    return { ok: false, status: 'fail', note: `the secret scan is reported as unavailable${entry?.status === 'unavailable' ? ` (${entry.reason})` : ''}; a registration needs a completed scan` };
  }
  const rows = new Map(input.evidence.map((row) => [row.id, row]));
  const summaries: SecretScanSummary[] = [];
  for (const id of entry.evidenceIds) {
    const row = rows.get(id);
    if (row === undefined) return { ok: false, status: 'fail', note: `secret_scan evidence ${id} is not an evidence row of this task` };
    const content = await input.contents.read(row);
    if (!content.ok) return { ok: false, status: 'fail', note: `secret_scan evidence ${id}: ${content.reason}` };
    const summary = parseSecretScanSummary(content.text);
    if (summary.ok) summaries.push(summary.summary);
    else if (!summary.reason.startsWith('not a scan summary')) return { ok: false, status: 'fail', note: `secret_scan evidence ${id}: ${summary.reason}` };
  }
  return { ok: true, report: parsed.report, summaries };
}

export async function checkScanCoverage(input: RegistrationCheckInput): Promise<RegistrationCheckOutcome> {
  const loaded = await loadScanSummaries(input);
  if (!loaded.ok) return { status: loaded.status, note: loaded.note };
  const problems: string[] = [];
  const facts: string[] = [];
  for (const scope of ['tree', 'history'] as ScanScope[]) {
    const ofScope = loaded.summaries.filter((summary) => summary.scope === scope);
    if (ofScope.length === 0) {
      problems.push(`no ${scope} scan summary among the secret_scan evidence`);
    } else if (!ofScope.some((summary) => summary.complete)) {
      problems.push(`the ${scope} scan did not cover its whole scope (complete=false)`);
    } else {
      const done = ofScope.filter((summary) => summary.complete);
      facts.push(scope === 'tree' ? `tree: ${Math.max(...done.map((s) => s.files_scanned ?? 0))} file(s)` : `history: ${Math.max(...done.map((s) => s.commits_scanned ?? 0))} commit(s)`);
    }
  }
  return problems.length === 0
    ? { status: 'pass', note: `secret scan covered the working tree and the history (${facts.join(', ')})` }
    : { status: 'fail', note: cut(problems.join('; ')) };
}

export async function checkClassificationPresent(input: RegistrationCheckInput): Promise<RegistrationCheckOutcome> {
  const loaded = await loadScanSummaries(input);
  if (!loaded.ok) {
    // 보고서 모양 오류는 이 검사의 실패다. 스캔 근거 쪽 문제는 scan_coverage_complete 가 실패로 알리므로 여기서는 판단 보류(unknown)다
    const reportInvalid = loaded.note.startsWith('registration report is invalid');
    return { status: loaded.status === 'unknown' || !reportInvalid ? 'unknown' : 'fail', note: loaded.note };
  }
  const { classification } = loaded.report;
  const rows = new Set(input.evidence.map((row) => row.id));
  const missing = classification.rationaleEvidenceIds.filter((id) => !rows.has(id));
  if (missing.length > 0) return { status: 'fail', note: `classification rationale cites evidence that is not a row of this task: ${missing.join(', ')}` };
  const findings = loaded.summaries.reduce((sum, summary) => sum + summary.findings.length, 0);
  if (findings > 0 && classification.proposal === 'public_candidate') {
    return { status: 'fail', note: `the scan reported ${findings} candidate secret(s), so the classification cannot be relaxed to public_candidate (internal or restricted at least)` };
  }
  return { status: 'pass', note: `classification proposal '${classification.proposal}' with ${classification.rationaleEvidenceIds.length} rationale reference(s); ${findings} scan finding(s)` };
}
