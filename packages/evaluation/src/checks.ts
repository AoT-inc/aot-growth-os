// 결정론적 검증기 (ADR-0007 §1-1, evaluation.md §1 첫 층). 명세의 `validation.deterministic` 에 적힌 검사 id 를 코드로 실행한다.
// 같은 입력이면 같은 결과를 내며 모델을 쓰지 않는다. 외부 접근(출처 URL 조회)은 SourceFetcher 포트로만 한다.
//
// 지원하는 검사 id (docs/schema/task-spec.md 예시와 workflows/product-registration.md 의 이름을 따른다)
//   schema | schema_valid  저장된 명세가 스키마를 통과하고 run 결과가 JSON 이다
//   url_reachable          출처 URL(evidence source_url + 보고된 주장의 출처)에 접근할 수 있다
//   quote_in_source        인용문이 출처 원문에 있다 (공백 차이는 무시). 보고된 주장의 인용문과, 명세의 `expected_quotes` 전부:
//                          기대 인용문은 (1) 검증기가 원본에서 직접 읽은 출처에 있어야 하고 (2) 에이전트 보고에도 같은 출처·같은 문장의 주장으로 올라와 있어야 한다.
//                          하나라도 빠지면 fail (보고가 일부만 담고 있어도 pass 가 아니다)
//   dedupe                 같은 주장·같은 출처가 중복되지 않는다
//   budget                 비용 원장 합계가 업무 예산(USD, 토큰) 이내다
//   policy_compliance      보낸 외부 부작용마다 기록된 정책 판정이 있다 (안전성 검사)
//   uncertainty_listed     run 결과에 `uncertainties` 필드가 있고 형식이 유효하다 (빈 목록은 "알려진 불확실성 없음"이라는 명시로 유효). 누락·형식 오류는 fail
//   call_completed | call_transcript_present | call_outcome_recorded  전화 업무의 통화 기록·발화 기록·구조화 결과 (ADR-0014 §7, call-checks.ts)
//   experiment_candidates  기획 업무 결과의 `candidates` 형식이 유효하고(id 중복 없음, 마케팅 업무 명세는 validateTaskSpec 통과), 각 후보의 측정 신호가
//                          알려진 신호 정의와 맞는다(A6-U14, candidates.ts). 위반은 fail. 신호 정의가 주입되지 않았으면 신호를 확인할 수 없어 unknown
// 이 목록에 없는 id 는 'unknown' (검증할 수 없음 → 평가는 inconclusive). 필수 테스트 결과(test_result)는 합격 표현 형식이
// 문서에 없어 구현하지 않았다 — `extraChecks` 로 주입할 수 있다 (phase-a.md A4 완료 기록).
//
// 비동기 검사(URL 조회)는 트랜잭션 밖에서 하고, 결과는 `applyEvidenceVerification` 이 Db.writeTx 안에서
// evidence.verified / verification_note 에 반영한다.
import {
  resolveExpectedQuotes, validateTaskSpec, type Db, type EvidenceRow, type ExternalEffectRow, type MeasurementSignal, type TaskRow, type TaskRunRow, type TaskSpec,
} from '@aot/domain';

import { CALL_COMPLETED_CHECK_ID, CALL_OUTCOME_CHECK_ID, CALL_TRANSCRIPT_CHECK_ID, checkCallCompleted, checkCallOutcome, checkCallTranscript, type CallCheckInput } from './call-checks.ts';
import { checkExperimentCandidates, EXPERIMENT_CANDIDATES_CHECK_ID } from './candidates.ts';
import type { ReportedClaim } from './claims.ts';
import { budgetLimitsOf, costForTask, evaluateBudget } from './cost.ts';
import type { FetchResult, SourceFetcher } from './ports.ts';
import { uncertaintiesFromResult } from './uncertainties.ts';

export type CheckStatus = 'pass' | 'fail' | 'unknown';

/** 근거(evidence) 한 줄에 대한 검사 기여. 한 줄의 verified 는 기여한 모든 검사가 통과일 때만 1 이다 */
export interface EvidenceContribution {
  verified: boolean;
  note: string;
}

export interface CheckOutcome {
  status: CheckStatus;
  note: string;
  /** evidence.id → 기여 */
  evidence?: ReadonlyMap<string, EvidenceContribution>;
}

export interface CheckContext {
  db: Db;
  task: TaskRow;
  spec: TaskSpec;
  run: TaskRunRow;
  evidence: readonly EvidenceRow[];
  claims: readonly ReportedClaim[];
  sources: SourceReader;
  /** 측정 신호 정의 (팩의 `measurement-signals/`). `experiment_candidates` 가 후보의 신호를 대조한다. 없으면 그 검사는 unknown */
  signals?: readonly MeasurementSignal[];
}

export interface DeterministicCheck {
  id: string;
  /** true 면 실패가 안전성 실패(safety='fail')다 */
  safety: boolean;
  run(context: CheckContext): Promise<CheckOutcome>;
}

/** 같은 URL 은 한 번만 가져온다 (한 번의 검증 안에서). 예외는 접근 불가로 바꾼다 */
export class SourceReader {
  readonly #fetcher: SourceFetcher;
  readonly #cache = new Map<string, Promise<FetchResult>>();

  constructor(fetcher: SourceFetcher) {
    this.#fetcher = fetcher;
  }

  read(url: string): Promise<FetchResult> {
    let found = this.#cache.get(url);
    if (!found) {
      found = this.#fetcher.fetch(url).catch((error: unknown): FetchResult => ({
        reachable: false, reason: error instanceof Error ? error.message : String(error),
      }));
      this.#cache.set(url, found);
    }
    return found;
  }

  /** 이미 읽은 URL 들 (LLM 검증 입력용) */
  async fetched(): Promise<Map<string, FetchResult>> {
    const result = new Map<string, FetchResult>();
    for (const [url, pending] of this.#cache) result.set(url, await pending);
    return result;
  }
}

const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();
const normalizeUrl = (url: string): string => url.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();

const sourceUrlEvidence = (context: CheckContext): EvidenceRow[] => context.evidence.filter((row) => row.kind === 'source_url');

function sourceUrls(context: CheckContext): string[] {
  const urls = new Set<string>(sourceUrlEvidence(context).map((row) => row.ref));
  for (const claim of context.claims) urls.add(claim.sourceUrl);
  return [...urls].sort();
}

const urlReachable: DeterministicCheck = {
  id: 'url_reachable',
  safety: false,
  async run(context) {
    const urls = sourceUrls(context);
    if (urls.length === 0) return { status: 'unknown', note: 'no source URL to check' };
    const failures: string[] = [];
    const reached = new Map<string, FetchResult>();
    for (const url of urls) {
      const result = await context.sources.read(url);
      reached.set(url, result);
      if (!result.reachable) failures.push(`${url}: ${result.reason}`);
    }
    const evidence = new Map<string, EvidenceContribution>();
    for (const row of sourceUrlEvidence(context)) {
      const result = reached.get(row.ref);
      evidence.set(row.id, result?.reachable ? { verified: true, note: `reachable (${result.status})` } : { verified: false, note: `unreachable: ${result?.reachable === false ? result.reason : 'not fetched'}` });
    }
    return failures.length === 0
      ? { status: 'pass', note: `${urls.length} source(s) reachable`, evidence }
      : { status: 'fail', note: `unreachable: ${failures.join('; ')}`, evidence };
  },
};

const quoteInSource: DeterministicCheck = {
  id: 'quote_in_source',
  safety: false,
  async run(context) {
    const quoted = context.claims.filter((claim) => claim.quote !== null);
    const expected = resolveExpectedQuotes(context.spec);
    if (quoted.length === 0 && expected.length === 0) return { status: 'unknown', note: 'no quotation to check' };
    const failures: string[] = [];
    const missingByUrl = new Set<string>();
    for (const claim of quoted) {
      const source = await context.sources.read(claim.sourceUrl);
      if (!source.reachable) {
        failures.push(`${claim.id}: source unreachable (${source.reason})`);
        missingByUrl.add(claim.sourceUrl);
      } else if (!normalizeText(source.text).includes(normalizeText(claim.quote!))) {
        failures.push(`${claim.id}: quotation not found in ${claim.sourceUrl}`);
        missingByUrl.add(claim.sourceUrl);
      }
    }
    // 명세의 기대 인용문: 보고서에 없는 인용문이 조용히 빠지지 않도록 하나씩 원본과 보고서 양쪽에서 확인한다
    for (const [index, want] of expected.entries()) {
      const label = `expected quotation #${index + 1} of '${want.source}'`;
      const source = await context.sources.read(want.url);
      if (!source.reachable) {
        failures.push(`${label}: source unreachable (${source.reason})`);
        missingByUrl.add(want.url);
      } else if (!normalizeText(source.text).includes(normalizeText(want.text))) {
        failures.push(`${label}: not found in ${want.url}`);
        missingByUrl.add(want.url);
      } else if (!quoted.some((claim) => normalizeUrl(claim.sourceUrl) === normalizeUrl(want.url) && normalizeText(claim.quote!) === normalizeText(want.text))) {
        failures.push(`${label}: the source has it but the agent report does not claim it (incomplete report)`);
        missingByUrl.add(want.url);
      }
    }
    const checkedUrls = new Set<string>([...quoted.map((claim) => claim.sourceUrl), ...expected.map((want) => want.url)]);
    const evidence = new Map<string, EvidenceContribution>();
    for (const row of sourceUrlEvidence(context)) {
      if (!checkedUrls.has(row.ref)) continue;
      evidence.set(row.id, missingByUrl.has(row.ref) ? { verified: false, note: 'a quotation is not in the source' } : { verified: true, note: 'quotations found in the source' });
    }
    return failures.length === 0
      ? { status: 'pass', note: expected.length === 0 ? `${quoted.length} quotation(s) found in their sources` : `${expected.length} expected and ${quoted.length} reported quotation(s) found in their sources`, evidence }
      : { status: 'fail', note: failures.join('; '), evidence };
  },
};

const dedupe: DeterministicCheck = {
  id: 'dedupe',
  safety: false,
  run(context) {
    const claims = context.claims;
    const evidence = sourceUrlEvidence(context);
    if (claims.length === 0 && evidence.length === 0) return Promise.resolve({ status: 'unknown', note: 'no claim or source to compare' });
    const duplicates: string[] = [];
    const seenClaims = new Map<string, string>();
    for (const claim of claims) {
      const key = normalizeText(claim.statement).toLowerCase();
      const first = seenClaims.get(key);
      if (first !== undefined) duplicates.push(`claim ${claim.id} repeats ${first}`);
      else seenClaims.set(key, claim.id);
    }
    const seenUrls = new Map<string, string>();
    const marked = new Map<string, EvidenceContribution>();
    for (const row of evidence) {
      const key = normalizeUrl(row.ref);
      const first = seenUrls.get(key);
      if (first !== undefined) {
        duplicates.push(`source ${row.ref} repeats evidence ${first}`);
        marked.set(row.id, { verified: false, note: 'duplicate source' });
      } else {
        seenUrls.set(key, row.id);
      }
    }
    return Promise.resolve(duplicates.length === 0
      ? { status: 'pass', note: 'no duplicate claims or sources' }
      : { status: 'fail', note: duplicates.join('; '), evidence: marked });
  },
};

const budget: DeterministicCheck = {
  id: 'budget',
  safety: false,
  run(context) {
    const spent = costForTask(context.db, context.task.id);
    const cancel = evaluateBudget(spent, budgetLimitsOf(context.task));
    return Promise.resolve(cancel === null
      ? { status: 'pass', note: `spent ${spent.totalUsd} of ${context.task.cost_budget_usd} USD` }
      : { status: 'fail', note: cancel.detail });
  },
};

const policyCompliance: DeterministicCheck = {
  id: 'policy_compliance',
  safety: true,
  run(context) {
    const sent = context.db.all<Pick<ExternalEffectRow, 'id' | 'tool' | 'action' | 'state'>>(
      "SELECT id, tool, action, state FROM external_effect WHERE task_run_id = ? AND state <> 'planned' ORDER BY id", [context.run.id],
    );
    const violations: string[] = [];
    for (const effect of sent) {
      const decision = context.db.get(
        "SELECT 1 AS one FROM policy_decision WHERE task_run_id = ? AND action = ? AND decision <> 'deny' LIMIT 1", [context.run.id, `${effect.tool}.${effect.action}`],
      );
      if (!decision) violations.push(`external effect ${effect.id} (${effect.tool}.${effect.action}, ${effect.state}) has no allowing policy decision`);
    }
    return Promise.resolve(violations.length === 0
      ? { status: 'pass', note: `${sent.length} external effect(s), each with a recorded policy decision` }
      : { status: 'fail', note: violations.join('; ') });
  },
};

const schemaValid: DeterministicCheck = {
  id: 'schema_valid',
  safety: false,
  run(context) {
    const checked = validateTaskSpec(JSON.parse(context.task.spec), 'stored');
    if (!checked.ok) return Promise.resolve({ status: 'fail', note: `task_spec invalid: ${checked.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ')}` });
    if (context.run.result === null) return Promise.resolve({ status: 'fail', note: 'the run submitted no result' });
    try {
      JSON.parse(context.run.result);
    } catch {
      return Promise.resolve({ status: 'fail', note: 'the run result is not valid JSON' });
    }
    return Promise.resolve({ status: 'pass', note: 'task_spec and run result are well-formed' });
  },
};

const uncertaintyListed: DeterministicCheck = {
  id: 'uncertainty_listed',
  safety: false,
  run(context) {
    const found = uncertaintiesFromResult(context.run.result);
    if (!found.ok) return Promise.resolve({ status: 'fail', note: found.reason });
    return Promise.resolve({
      status: 'pass',
      note: found.items.length === 0 ? 'the result states no known uncertainty (empty list)' : `${found.items.length} uncertainty item(s) listed`,
    });
  },
};

const experimentCandidates: DeterministicCheck = {
  id: EXPERIMENT_CANDIDATES_CHECK_ID,
  safety: false,
  run(context) {
    return Promise.resolve(checkExperimentCandidates(context.run.result, context.signals));
  },
};

const callInputOf = (context: CheckContext): CallCheckInput => ({ db: context.db, taskId: context.task.id, spec: context.spec, evidence: context.evidence });
const callCompleted: DeterministicCheck = { id: CALL_COMPLETED_CHECK_ID, safety: false, run: (context) => Promise.resolve(checkCallCompleted(callInputOf(context))) };
const callTranscriptPresent: DeterministicCheck = { id: CALL_TRANSCRIPT_CHECK_ID, safety: false, run: (context) => Promise.resolve(checkCallTranscript(callInputOf(context))) };
const callOutcomeRecorded: DeterministicCheck = { id: CALL_OUTCOME_CHECK_ID, safety: false, run: (context) => Promise.resolve(checkCallOutcome(callInputOf(context))) };

/** 검사 id → 검사. `schema` 는 `schema_valid` 의 별칭 */
export function defaultChecks(): Map<string, DeterministicCheck> {
  const map = new Map<string, DeterministicCheck>();
  for (const check of [schemaValid, urlReachable, quoteInSource, dedupe, budget, policyCompliance, uncertaintyListed, experimentCandidates, callCompleted, callTranscriptPresent, callOutcomeRecorded]) map.set(check.id, check);
  map.set('schema', schemaValid);
  return map;
}

export interface CheckReport {
  id: string;
  status: CheckStatus;
  note: string;
  safety: boolean;
}

export interface DeterministicReport {
  checks: CheckReport[];
  /** evidence.id → 최종 verified / note (기여가 있는 줄만) */
  evidence: Map<string, EvidenceContribution>;
}

/** 명세가 요구한 검사를 모두 실행한다 (쓰기 없음). 등록되지 않은 id 는 'unknown'. 검사가 던진 예외는 'fail' 로 기록한다. */
export async function runDeterministicChecks(
  context: CheckContext, ids: readonly string[], extraChecks: readonly DeterministicCheck[] = [],
): Promise<DeterministicReport> {
  const registry = defaultChecks();
  for (const check of extraChecks) registry.set(check.id, check);
  const checks: CheckReport[] = [];
  const contributions = new Map<string, EvidenceContribution[]>();
  for (const id of [...new Set(ids)]) {
    const check = registry.get(id);
    if (!check) {
      checks.push({ id, status: 'unknown', note: `no deterministic check '${id}' is registered`, safety: false });
      continue;
    }
    let outcome: CheckOutcome;
    try {
      outcome = await check.run(context);
    } catch (error) {
      outcome = { status: 'fail', note: `check threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    checks.push({ id, status: outcome.status, note: outcome.note, safety: check.safety });
    for (const [evidenceId, contribution] of outcome.evidence ?? []) {
      const list = contributions.get(evidenceId) ?? [];
      list.push({ verified: contribution.verified, note: `${id}: ${contribution.note}` });
      contributions.set(evidenceId, list);
    }
  }
  const evidence = new Map<string, EvidenceContribution>();
  for (const [evidenceId, list] of contributions) {
    evidence.set(evidenceId, { verified: list.every((item) => item.verified), note: list.map((item) => item.note).join('; ').slice(0, 500) });
  }
  return { checks, evidence };
}

/** `evidence.verified` / `verification_note` 갱신. 반드시 Db.writeTx 안에서 부른다 (Db 가 트랜잭션 밖 쓰기를 거부한다) */
export function applyEvidenceVerification(tx: Db, evidence: ReadonlyMap<string, EvidenceContribution>): void {
  for (const [id, contribution] of evidence) {
    tx.run('UPDATE evidence SET verified = ?, verification_note = ? WHERE id = ?', [contribution.verified ? 1 : 0, contribution.note, id]);
  }
}
