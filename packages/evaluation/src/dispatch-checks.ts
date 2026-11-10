// 호스트 전송 run 의 평가 (ADR-0015 §2.7 "전송 run 검증"). 전송 run 은 에이전트가 일을 새로 하지 않았으므로 수용 기준을 다시 보지 않고 세 가지만 본다.
//   draft_run_passed   ① 초안을 만든 run 의 평가가 pass 이고 안전성 pass 다 (사람은 독립 평가를 통과한 초안만 승인할 수 있었다)
//   drafts_confirmed   ② proposed 초안마다 같은 effect_key 의 external_effect 가 confirmed 이고 request_hash = payload_hash 다 (초안 = 보낸 것)
//   policy_compliance  ③ 이 run 이 보낸 부작용마다 기록된 정책 판정이 있다 (안전성 검사)
// 사람 검토(`validation.human`)는 초안 승인 때 이미 했으므로 이 run 에서는 요구하지 않는다(humanRequired=false는 validator.ts 가 정한다).
// 원본 증거 = 원장의 external_effect 행. 평가 행은 기존 형식을 그대로 쓴다(UNIQUE(task_id, task_run_id, evaluator)).
import { randomUUID } from 'node:crypto';

import { proposedDraftsOf, type Db, type EffectDraftRow, type EvaluationRow, type ExternalEffectRow, type TaskRow, type TaskRunRow, type TaskSpec } from '@aot/domain';

import { runDeterministicChecks, SourceReader, type CheckContext, type CheckReport } from './checks.ts';
import { costForRun } from './cost.ts';
import { assertEvaluationInvariants, decide, EVALUATOR_REF, findEvaluation, type EvaluateRunRequest, type EvaluationReport, type EvaluatorDeps } from './evaluator.ts';

export const DRAFT_RUN_PASSED_CHECK_ID = 'draft_run_passed';
export const DRAFTS_CONFIRMED_CHECK_ID = 'drafts_confirmed';

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

function checkDraftRunPassed(db: Db, drafts: readonly EffectDraftRow[]): CheckReport {
  const base = { id: DRAFT_RUN_PASSED_CHECK_ID, safety: false };
  if (drafts.length === 0) return { ...base, status: 'fail', note: 'the task has no proposed drafts to have been sent' };
  const runs = [...new Set(drafts.map((draft) => draft.task_run_id))];
  const problems: string[] = [];
  for (const runId of runs) {
    const evaluation = db.get<Pick<EvaluationRow, 'outcome' | 'safety'>>('SELECT outcome, safety FROM evaluation WHERE task_run_id = ? ORDER BY at, id LIMIT 1', [runId]);
    if (!evaluation) problems.push(`draft run ${runId} has no evaluation`);
    else if (evaluation.outcome !== 'pass' || evaluation.safety !== 'pass') problems.push(`draft run ${runId} was evaluated ${evaluation.outcome}, safety ${evaluation.safety}`);
  }
  return problems.length === 0
    ? { ...base, status: 'pass', note: `the draft run's evaluation passed (${runs.length} run)` }
    : { ...base, status: 'fail', note: problems.join('; ') };
}

function checkDraftsConfirmed(db: Db, drafts: readonly EffectDraftRow[]): { report: CheckReport; effectIds: string[] } {
  const base = { id: DRAFTS_CONFIRMED_CHECK_ID, safety: false };
  const problems: string[] = [];
  const effectIds: string[] = [];
  for (const draft of drafts) {
    const effect = db.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE effect_key = ?', [draft.effect_key]);
    if (!effect) problems.push(`draft ${draft.id}: no external effect with its effect_key`);
    else if (effect.state !== 'confirmed') problems.push(`draft ${draft.id}: the external effect is '${effect.state}', not confirmed`);
    else if (effect.request_hash !== draft.payload_hash) problems.push(`draft ${draft.id}: request_hash differs from payload_hash (sent content is not the approved content)`);
    else if (effect.tool !== draft.tool || effect.action !== draft.action || effect.target !== draft.target || effect.task_id !== draft.task_id) {
      problems.push(`draft ${draft.id}: the external effect's tool, action or target differs from the draft`);
    } else effectIds.push(effect.id);
  }
  return {
    report: problems.length === 0
      ? { ...base, status: 'pass', note: `${drafts.length} draft(s) each confirmed with a matching request_hash` }
      : { ...base, status: 'fail', note: problems.join('; ').slice(0, 800) },
    effectIds,
  };
}

/** 전송 run 한 건을 평가해 `evaluation` 행을 남긴다. 같은 (업무, run, 평가기)면 처음 기록된 행을 돌려준다. */
export async function evaluateDispatchRun(deps: EvaluatorDeps, request: EvaluateRunRequest): Promise<EvaluationReport> {
  const { db, clock } = deps;
  const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [request.taskId]);
  if (!task) throw new Error(`task '${request.taskId}' does not exist`);
  const run = db.get<TaskRunRow>('SELECT * FROM task_run WHERE id = ?', [request.taskRunId]);
  if (!run || run.task_id !== task.id) throw new Error(`task_run '${request.taskRunId}' does not belong to task '${request.taskId}'`);
  if (run.outcome !== 'submitted') throw new Error(`task_run '${run.id}' has no submitted result (outcome ${run.outcome ?? 'running'})`);
  const earlier = findEvaluation(db, task.id, run.id);
  if (earlier) return { evaluation: earlier, created: false };

  const spec = JSON.parse(task.spec) as TaskSpec;
  const drafts = proposedDraftsOf(db, task.id);
  const draftRun = checkDraftRunPassed(db, drafts);
  const confirmed = checkDraftsConfirmed(db, drafts);
  const context: CheckContext = { db, task, spec, run, evidence: [], claims: [], sources: new SourceReader(deps.fetcher) };
  const compliance = await runDeterministicChecks(context, ['policy_compliance']);
  const checks: CheckReport[] = [draftRun, confirmed.report, ...compliance.checks];

  const decision = decide({
    safetyFailures: checks.filter((check) => check.safety && check.status === 'fail').map((check) => `${check.id}: ${check.note}`),
    checks, llm: 'not_configured', primaryEvidenceCount: confirmed.effectIds.length, effect: { state: 'not_measured' },
  });
  const spent = costForRun(db, run.id).totalUsd;
  const budget = Number(task.cost_budget_usd);
  const primary = confirmed.effectIds.map((id) => `external_effect:${id}`);
  const row: EvaluationRow = {
    id: (deps.newId ?? (() => `eval-${randomUUID()}`))(), task_id: task.id, task_run_id: run.id, evaluator: EVALUATOR_REF,
    validation_passed: checks.every((check) => check.status === 'pass') ? 1 : 0, outcome: decision.outcome,
    primary_evidence_refs: JSON.stringify(primary), agent_report_used: 0,
    quality: round(checks.filter((check) => check.status === 'pass').length / checks.length),
    quality_note: [`decision: ${decision.reasons.join(' / ')}`, `dispatch run (${run.adapter})`, ...checks.map((check) => `${check.id}=${check.status}${check.status === 'pass' ? '' : ` (${check.note})`}`)].join('; ').slice(0, 1000),
    effect: null, effect_note: 'no effect measurement requested',
    economics: budget > 0 ? round(Math.min(1, Math.max(0, 1 - spent / budget))) : null, economics_note: `spent ${spent} of ${budget} USD`,
    safety: decision.safety, safety_note: decision.safety === 'fail' ? decision.reasons.join('; ').slice(0, 1000) : 'no safety check failed',
    evidence_refs: JSON.stringify(primary), total_cost_usd: spent, human_minutes: 0, at: clock.nowIso(),
  };
  assertEvaluationInvariants(row);
  return db.writeTx((tx) => {
    const raced = findEvaluation(tx, task.id, run.id);
    if (raced) return { evaluation: raced, created: false };
    tx.run(
      `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, agent_report_used,
         quality, quality_note, effect, effect_note, economics, economics_note, safety, safety_note, evidence_refs, total_cost_usd, human_minutes, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.task_id, row.task_run_id, row.evaluator, row.validation_passed, row.outcome, row.primary_evidence_refs, row.agent_report_used,
        row.quality, row.quality_note, row.effect, row.effect_note, row.economics, row.economics_note, row.safety, row.safety_note,
        row.evidence_refs, row.total_cost_usd, row.human_minutes, row.at],
    );
    return { evaluation: tx.get<EvaluationRow>('SELECT * FROM evaluation WHERE id = ?', [row.id])!, created: true };
  });
}
