// 평가기 (ADR-0007, operations/evaluation.md). 한 run 에 대해 검증(결정론적 → LLM)을 돌리고 네 축(quality/effect/economics/safety)을
// 별도 필드로 기록해 `evaluation` 행 하나를 남긴다.
//
// 판정 순서 (decide, 순수 함수 — 시험이 표로 고정한다)
//   1. safety = fail                          → fail  (다른 점수와 무관, 거부권)
//   2. 결정론적 검사 실패                       → fail
//   3. 증거 부족                               → inconclusive
//        · 확인되지 않은 검사(unknown) · 원본 증거 없음(보고서만) · LLM 판단 불가 · 관측 수 부족 · 데이터 품질 불량 · 측정 불가
//   4. LLM 이 뒷받침 안 됨, 효과가 합격선 미달   → fail
//   5. 그 밖                                   → pass
// 원본 증거 = 확인된(verified) evidence 행, 비용 원장, 외부에서 주입된 측정 값. 에이전트 보고서(task_run.result)는 참고이며
// 보고서를 읽었으면 agent_report_used = 1 이다. 원본 증거가 하나도 없으면 pass 가 나올 수 없다.
//
// 같은 (업무, run, 평가기)를 다시 검증하면 처음 기록된 행을 돌려준다 (UNIQUE 로 흡수). 평가기 로직을 바꾸면 EVALUATOR_VERSION 을 올려
// 새 행이 생기게 한다 (버전 변경의 승인 경로는 phase-a.md A4 완료 기록의 이월 항목).
import { randomUUID } from 'node:crypto';

import type { Clock, Db, EvalOutcome, EvaluationRow, EvidenceRow, SafetyResult, TaskRow, TaskRunRow, TaskSpec } from '@aot/domain';

import {
  applyEvidenceVerification, runDeterministicChecks, SourceReader,
  type CheckContext, type CheckReport, type DeterministicCheck, type DeterministicReport,
} from './checks.ts';
import { claimsFromResult, type ReportedClaim } from './claims.ts';
import { costForRun, recordCost } from './cost.ts';
import { buildIsolatedInput } from './isolation.ts';
import type { EffectObservation, EffectSignalSource, LlmVerdict, LlmVerifier, SourceFetcher, SourceText } from './ports.ts';

export const EVALUATOR_ID = 'task-evaluator';
export const EVALUATOR_VERSION = 'v1';
/** evaluation.evaluator 에 기록되는 `id@version` */
export const EVALUATOR_REF = `${EVALUATOR_ID}@${EVALUATOR_VERSION}`;

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}

// ===== 판정 (순수) =====

export type LlmState = 'not_configured' | 'skipped' | 'supported' | 'unsupported' | 'unclear';

export type EffectAssessment =
  | { state: 'not_measured' }
  | { state: 'recorded_only'; mean: number; observations: number }
  | { state: 'met'; mean: number; observations: number }
  | { state: 'below_target'; mean: number; observations: number }
  | { state: 'insufficient' | 'poor_quality' | 'unmeasurable'; reason: string };

export interface DecisionFacts {
  /** 안전성 검사가 실패한 사유 (비면 safety = pass) */
  safetyFailures: readonly string[];
  checks: readonly Pick<CheckReport, 'id' | 'status'>[];
  llm: LlmState;
  /** 원본 증거 참조 수 (확인된 evidence 행 + 비용 원장 + 측정 값) */
  primaryEvidenceCount: number;
  effect: EffectAssessment;
}

export interface Decision {
  outcome: EvalOutcome;
  safety: SafetyResult;
  reasons: string[];
}

export function decide(facts: DecisionFacts): Decision {
  const safety: SafetyResult = facts.safetyFailures.length > 0 ? 'fail' : 'pass';
  if (safety === 'fail') return { outcome: 'fail', safety, reasons: [`safety failed: ${facts.safetyFailures.join('; ')}`] };

  const failed = facts.checks.filter((check) => check.status === 'fail').map((check) => check.id);
  if (failed.length > 0) return { outcome: 'fail', safety, reasons: [`deterministic check(s) failed: ${failed.join(', ')}`] };

  const insufficient: string[] = [];
  const unknown = facts.checks.filter((check) => check.status === 'unknown').map((check) => check.id);
  if (unknown.length > 0) insufficient.push(`check(s) could not be verified: ${unknown.join(', ')}`);
  if (facts.primaryEvidenceCount === 0) insufficient.push('no original evidence (only the agent report is available)');
  if (facts.llm === 'unclear') insufficient.push('LLM verification could not decide');
  if (facts.effect.state === 'insufficient' || facts.effect.state === 'poor_quality' || facts.effect.state === 'unmeasurable') {
    insufficient.push(`effect: ${facts.effect.reason}`);
  }
  if (insufficient.length > 0) return { outcome: 'inconclusive', safety, reasons: insufficient };

  const failures: string[] = [];
  if (facts.llm === 'unsupported') failures.push('LLM verification found unsupported claim(s)');
  if (facts.effect.state === 'below_target') failures.push(`effect below target (mean ${facts.effect.mean} over ${facts.effect.observations} observations)`);
  if (failures.length > 0) return { outcome: 'fail', safety, reasons: failures };
  return { outcome: 'pass', safety, reasons: ['all criteria met with original evidence'] };
}

/** evaluation 행이 지켜야 하는 불변식 (DB 에 쓰기 전 확인). 위반은 코드 오류다 */
export function assertEvaluationInvariants(row: Pick<EvaluationRow, 'outcome' | 'safety' | 'primary_evidence_refs' | 'agent_report_used'>): void {
  const primary = JSON.parse(row.primary_evidence_refs) as unknown[];
  if (row.outcome === 'pass' && primary.length === 0) throw new EvaluationError('pass requires original evidence; an agent report alone cannot pass');
  if (row.outcome === 'pass' && row.safety === 'fail') throw new EvaluationError('safety=fail cannot be a pass');
}

/** 성공 사례로 학습에 쓸 수 있는 평가인가: pass 이고 안전성 통과. inconclusive 는 성공도 실패도 아니다 (memory-item 규칙 8) */
export const isSuccessCase = (row: Pick<EvaluationRow, 'outcome' | 'safety'>): boolean => row.outcome === 'pass' && row.safety === 'pass';

// ===== 평가 실행 =====

export interface EvaluatorDeps {
  db: Db;
  clock: Clock;
  fetcher: SourceFetcher;
  /** 없으면 LLM 검증을 요구하는 업무는 inconclusive */
  llm?: LlmVerifier;
  /** 없으면 효과는 측정하지 않는다 (effect = null) */
  effect?: EffectSignalSource;
  /** 명세 id 에 없는 검사를 더한다 (예: 필수 테스트 결과) */
  extraChecks?: readonly DeterministicCheck[];
  newId?: () => string;
}

export interface EvaluateRunRequest {
  taskId: string;
  taskRunId: string;
}

export interface EvaluationReport {
  evaluation: EvaluationRow;
  /** false 면 이미 있던 평가를 돌려준 것 (재검증 흡수) */
  created: boolean;
}

export const findEvaluation = (db: Db, taskId: string, taskRunId: string, evaluator: string = EVALUATOR_REF): EvaluationRow | undefined =>
  db.get<EvaluationRow>('SELECT * FROM evaluation WHERE task_id = ? AND task_run_id = ? AND evaluator = ?', [taskId, taskRunId, evaluator]);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const mean = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;

function assessEffect(observation: EffectObservation | null): EffectAssessment {
  if (observation === null) return { state: 'not_measured' };
  if (!observation.measurable) return { state: 'unmeasurable', reason: `not measurable: ${observation.reason}` };
  const { signal } = observation;
  const n = signal.values.length;
  if (n < signal.minObservations) return { state: 'insufficient', reason: `${n} observation(s), fewer than the required ${signal.minObservations}` };
  if (!signal.dataQualityOk) return { state: 'poor_quality', reason: 'data quality condition not met' };
  const m = round(mean(signal.values));
  if (signal.passAtLeast === undefined) return { state: 'recorded_only', mean: m, observations: n };
  return { state: m >= signal.passAtLeast ? 'met' : 'below_target', mean: m, observations: n };
}

export async function evaluateRun(deps: EvaluatorDeps, request: EvaluateRunRequest): Promise<EvaluationReport> {
  const { db, clock } = deps;
  const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [request.taskId]);
  if (!task) throw new EvaluationError(`task '${request.taskId}' does not exist`);
  const run = db.get<TaskRunRow>('SELECT * FROM task_run WHERE id = ?', [request.taskRunId]);
  if (!run || run.task_id !== task.id) throw new EvaluationError(`task_run '${request.taskRunId}' does not belong to task '${request.taskId}'`);
  if (run.outcome !== 'submitted') throw new EvaluationError(`task_run '${run.id}' has no submitted result (outcome ${run.outcome ?? 'running'})`);

  const earlier = findEvaluation(db, task.id, run.id);
  if (earlier) return { evaluation: earlier, created: false };

  const spec = JSON.parse(task.spec) as TaskSpec;
  const claims = claimsFromResult(run.result);
  const evidence = db.all<EvidenceRow>(
    'SELECT * FROM evidence WHERE task_id = ? AND (task_run_id = ? OR task_run_id IS NULL) ORDER BY captured_at, id', [task.id, run.id],
  );
  const sources = new SourceReader(deps.fetcher);
  const context: CheckContext = { db, task, spec, run, evidence, claims, sources };

  // 1층: 결정론적 검증
  const deterministic = await runDeterministicChecks(context, spec.validation.deterministic, deps.extraChecks);
  const allChecksPass = deterministic.checks.every((check) => check.status === 'pass');

  // 2층: 컨텍스트 분리 LLM 검증 (앞 층이 모두 통과했을 때만)
  const llm = await runLlmVerification(deps, spec, claims, evidence, sources, allChecksPass);

  // 효과 측정 (외부에서 주입된 관측 값)
  const observation = deps.effect === undefined ? null : await deps.effect.read({ taskId: task.id, taskRunId: run.id });
  const effect = assessEffect(observation);

  const runCost = costForRun(db, run.id);
  const verificationCostUsd = llm.verdict?.costUsd ?? 0;
  const totalCostUsd = round(runCost.totalUsd + verificationCostUsd);

  const verifiedAfter = (row: EvidenceRow): boolean => deterministic.evidence.get(row.id)?.verified ?? Number(row.verified) === 1;
  const primary = [
    ...evidence.filter(verifiedAfter).map((row) => `evidence:${row.id}`),
    ...(runCost.entries > 0 ? [`cost_ledger:${run.id}`] : []),
    ...(observation?.measurable && effect.state !== 'insufficient' && effect.state !== 'poor_quality' ? [`measurement:${observation.signal.name}`] : []),
  ];

  const decision = decide({
    safetyFailures: deterministic.checks.filter((check) => check.safety && check.status === 'fail').map((check) => `${check.id}: ${check.note}`),
    checks: deterministic.checks,
    llm: llm.state,
    primaryEvidenceCount: primary.length,
    effect,
  });

  const reportUsed = claims.length > 0;
  const row = buildRow({
    deps, task, run, spec, deterministic, llmState: llm.state, llmNote: llm.note, effect, decision, primary, evidence, totalCostUsd, humanMinutes: runCost.humanMinutes, reportUsed,
  });
  assertEvaluationInvariants(row);

  return db.writeTx((tx) => {
    const raced = findEvaluation(tx, task.id, run.id);
    if (raced) return { evaluation: raced, created: false };
    applyEvidenceVerification(tx, deterministic.evidence);
    if (verificationCostUsd > 0) {
      recordCost(tx, clock, {
        taskId: task.id, taskRunId: run.id, category: 'llm', amountUsd: verificationCostUsd,
        units: { source: 'validation', verifier: deps.llm?.id ?? 'unknown' },
      });
    }
    tx.run(
      `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, agent_report_used,
         quality, quality_note, effect, effect_note, economics, economics_note, safety, safety_note, evidence_refs, total_cost_usd, human_minutes, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.task_id, row.task_run_id, row.evaluator, row.validation_passed, row.outcome, row.primary_evidence_refs, row.agent_report_used,
        row.quality, row.quality_note, row.effect, row.effect_note, row.economics, row.economics_note, row.safety, row.safety_note,
        row.evidence_refs, row.total_cost_usd, row.human_minutes, row.at,
      ],
    );
    return { evaluation: tx.get<EvaluationRow>('SELECT * FROM evaluation WHERE id = ?', [row.id])!, created: true };
  });
}

interface LlmRun {
  state: LlmState;
  note: string;
  verdict: LlmVerdict | null;
}

async function runLlmVerification(
  deps: EvaluatorDeps, spec: TaskSpec, claims: readonly ReportedClaim[], evidence: readonly EvidenceRow[], sources: SourceReader, allChecksPass: boolean,
): Promise<LlmRun> {
  const wanted = spec.validation.llm;
  if (wanted === null) return { state: 'not_configured', note: 'no LLM verification requested', verdict: null };
  if (!allChecksPass) return { state: 'skipped', note: 'skipped: deterministic checks did not all pass', verdict: null };
  if (wanted.isolated_context === false) return { state: 'unclear', note: 'LLM verification without an isolated context is not supported', verdict: null };
  if (!deps.llm) return { state: 'unclear', note: 'no LLM verifier is configured', verdict: null };
  if (claims.length === 0) return { state: 'unclear', note: 'no claim to verify', verdict: null };
  try {
    const fetched = await sources.fetched();
    const texts: SourceText[] = [];
    for (const [url, result] of fetched) {
      const row = evidence.find((candidate) => candidate.kind === 'source_url' && candidate.ref === url);
      // 본문은 검증기가 출처 조회기로 바깥에서 직접 읽은 것이므로, 근거 행의 `evidence.trust_origin` 이 무엇이든(에이전트 출처 행은 호스트가 항상 external_untrusted 로 쓴다) 외부 입력이다
      texts.push({ ref: url, kind: 'source_url', text: result.reachable ? result.text : null, contentHash: row?.content_hash ?? null, trustOrigin: 'external_untrusted' });
    }
    const input = buildIsolatedInput({
      check: wanted.check,
      criteria: spec.acceptance_criteria,
      claims: claims.map((claim) => ({ id: claim.id, statement: claim.statement, sourceRef: claim.sourceUrl })),
      sources: texts,
    });
    const verdict = await deps.llm.verify(input);
    return { state: verdict.verdict, note: `${deps.llm.id}: ${verdict.verdict} (${verdict.note})`, verdict };
  } catch (error) {
    return { state: 'unclear', note: `LLM verification failed: ${error instanceof Error ? error.message : String(error)}`, verdict: null };
  }
}

interface RowParts {
  deps: EvaluatorDeps;
  task: TaskRow;
  run: TaskRunRow;
  spec: TaskSpec;
  deterministic: DeterministicReport;
  llmState: LlmState;
  llmNote: string;
  effect: EffectAssessment;
  decision: Decision;
  primary: readonly string[];
  evidence: readonly EvidenceRow[];
  totalCostUsd: number;
  humanMinutes: number;
  reportUsed: boolean;
}

function buildRow(parts: RowParts): EvaluationRow {
  const { deterministic, decision, effect } = parts;
  const checks = deterministic.checks;
  const quality = checks.length === 0 ? null : round(checks.filter((check) => check.status === 'pass').length / checks.length);
  const budget = Number(parts.task.cost_budget_usd);
  const economics = budget > 0 ? round(clamp01(1 - parts.totalCostUsd / budget)) : null;
  const measured = effect.state === 'met' || effect.state === 'below_target' || effect.state === 'recorded_only';
  const effectScore = measured ? effect.mean : null;
  const effectNote = measured ? `${effect.state}: mean ${effect.mean} over ${effect.observations} observation(s)`
    : effect.state === 'not_measured' ? 'no effect measurement requested' : effect.reason;
  const evidenceRefs = [
    ...parts.evidence.map((row) => `evidence:${row.id}`),
    ...parts.primary.filter((ref) => !ref.startsWith('evidence:')),
    ...(parts.reportUsed ? [`agent_report:${parts.run.id}`] : []),
  ];
  return {
    id: (parts.deps.newId ?? (() => `eval-${randomUUID()}`))(),
    task_id: parts.task.id,
    task_run_id: parts.run.id,
    evaluator: EVALUATOR_REF,
    validation_passed: checks.every((check) => check.status === 'pass') && (parts.llmState === 'not_configured' || parts.llmState === 'supported') ? 1 : 0,
    outcome: decision.outcome,
    primary_evidence_refs: JSON.stringify(parts.primary),
    agent_report_used: parts.reportUsed ? 1 : 0,
    quality,
    quality_note: [`decision: ${decision.reasons.join(' / ')}`, ...checks.map((check) => `${check.id}=${check.status}${check.status === 'pass' ? '' : ` (${check.note})`}`), `llm: ${parts.llmNote}`].join('; ').slice(0, 1000),
    effect: effectScore,
    effect_note: effectNote,
    economics,
    economics_note: `spent ${parts.totalCostUsd} of ${budget} USD`,
    safety: decision.safety,
    safety_note: decision.safety === 'fail' ? decision.reasons.join('; ').slice(0, 1000) : 'no safety check failed',
    evidence_refs: JSON.stringify(evidenceRefs),
    total_cost_usd: parts.totalCostUsd,
    human_minutes: parts.humanMinutes,
    at: parts.deps.clock.nowIso(),
  };
}
