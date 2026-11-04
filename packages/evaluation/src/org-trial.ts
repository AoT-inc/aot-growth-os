// 조직 변경 시험 평가기 (Phase B / B4, ADR-0011 Amendment 1, operations/evaluation.md). 조직 관리팀이 아니라 평가 모듈이 판정한다:
// 시험 업무(새 역할이 시험 시작 뒤에 받은 업무)의 *독립 평가* 기록(evaluation.outcome·safety)과 비용 원장(cost_entry)에서 직접 계산한다 — 에이전트 보고서는 쓰지 않는다.
//
// 판정 (`evaluateOrgTrial`, 읽기 전용):
//  - 즉시 중단 → `fail` + abort_reason: 시험 업무 중 평가 safety='fail' 1건(`safety`), 시험 업무 비용 합계 > evaluation_plan.max_cost_usd(`budget`)
//  - 관측 = 시험 업무 중 끝난 것(completed·failed). 통과 = completed AND 평가 pass AND safety pass. 취소된 업무는 관측이 아니다.
//  - 관측 ≥ min_observations 이고 통과율 < min_pass_rate → `fail` (기간이 남아도 선언한다)
//  - 기간(시험 시작 + evaluation_days) 안: 위 조건이 아니면 `pending` (아직 결과 없음)
//  - 기간 경과: 관측 < min_observations → `inconclusive`(증거 부족을 억지로 판정하지 않는다). 충분하고 통과율 ≥ min_pass_rate 이면 `pass`,
//    단 최소 시험 기간(trial_min_days)이 지나야 한다(아니면 pending). 기준선(시험 전 같은 유형의 끝난 업무의 통과율)이 있고 시험 통과율이 기준선보다
//    BASELINE_TOLERANCE 이상 낮으면 `fail`. 기준선이 없으면(그 유형은 배정할 역할이 없던 업무라 흔하다) 최소 통과율만으로 판정하고 metrics 에 `baseline: null` 로 남긴다.
//  - `quality` 중단은 쓰지 않는다(심각한 품질 저하는 최소 통과율 미달 `fail` 로 잡는다).
// 기록 (`recordOrgTrialResult`): pending 이 아니면 org_trial_result 에 한 행(append-only). 직전 행과 판정·관측 수가 같으면 쓰지 않는다(멱등).
import { canonicalJson, contentHash, parseOrgDiff, taskTypeOf, type Clock, type Db, type OrgEvaluationPlan, type OrgProposalRow } from '@aot/domain';

export const ORG_TRIAL_EVALUATOR_ID = 'org-trial-evaluator';
export const ORG_TRIAL_EVALUATOR_VERSION = 1;
export const ORG_TRIAL_EVALUATOR_REF = `${ORG_TRIAL_EVALUATOR_ID}@${ORG_TRIAL_EVALUATOR_VERSION}`;
export const BASELINE_TOLERANCE = 0.1;
const DAY_MS = 86_400_000;

export type OrgTrialVerdict = 'pending' | 'pass' | 'fail' | 'inconclusive';

export interface OrgTrialAssessment {
  verdict: OrgTrialVerdict;
  abortReason: 'safety' | 'budget' | null;
  observations: number;
  reason: string;
  metrics: Record<string, unknown>;
  evidenceRefs: string[];
}

type TrialTaskRow = {
  id: string;
  status: string;
  trigger_kind: string;
  trigger_ref: string;
  outcome: string | null;
  safety: string | null;
};

const passRate = (passed: number, observations: number): number | null => (observations === 0 ? null : Math.round((passed / observations) * 10_000) / 10_000);

/** 시험 업무: 이 제안이 만든 역할이 시험 시작 뒤에 받은 업무 */
function trialTasks(db: Db, proposal: OrgProposalRow, startedAt: string): TrialTaskRow[] {
  const slugs = parseOrgDiff(JSON.parse(proposal.diff)).ops.map((op) => op.role.slug);
  if (slugs.length === 0) return [];
  const marks = slugs.map(() => '?').join(', ');
  return db.all<TrialTaskRow>(
    `SELECT t.id, t.status, t.trigger_kind, t.trigger_ref,
       (SELECT e.outcome FROM evaluation e WHERE e.task_id = t.id ORDER BY e.at DESC, e.rowid DESC LIMIT 1) AS outcome,
       (SELECT e.safety FROM evaluation e WHERE e.task_id = t.id ORDER BY e.at DESC, e.rowid DESC LIMIT 1) AS safety
     FROM task t JOIN role r ON r.id = t.role_id
     WHERE r.slug IN (${marks}) AND t.created_at >= ? ORDER BY t.created_at, t.id`,
    [...slugs, startedAt],
  );
}

function baselineOf(db: Db, types: string[], startedAt: string, windowDays: number): { observations: number; pass_rate: number | null } {
  const since = new Date(Date.parse(startedAt) - windowDays * DAY_MS).toISOString();
  const rows = db.all<{ trigger_kind: string; trigger_ref: string; status: string; outcome: string | null; safety: string | null }>(
    `SELECT t.trigger_kind, t.trigger_ref, t.status,
       (SELECT e.outcome FROM evaluation e WHERE e.task_id = t.id ORDER BY e.at DESC, e.rowid DESC LIMIT 1) AS outcome,
       (SELECT e.safety FROM evaluation e WHERE e.task_id = t.id ORDER BY e.at DESC, e.rowid DESC LIMIT 1) AS safety
     FROM task t WHERE t.created_at >= ? AND t.created_at < ? AND t.status IN ('completed', 'failed') AND t.role_id IS NOT NULL`,
    [since, startedAt],
  ).filter((row) => types.includes(taskTypeOf({ kind: row.trigger_kind, ref: row.trigger_ref })));
  const passed = rows.filter((row) => row.status === 'completed' && row.outcome === 'pass' && row.safety === 'pass').length;
  return { observations: rows.length, pass_rate: passRate(passed, rows.length) };
}

/** 시험 판정을 계산한다 (읽기 전용). 시험이 시작되지 않은 제안은 오류 */
export function evaluateOrgTrial(db: Db, clock: Clock, proposal: OrgProposalRow): OrgTrialAssessment {
  if (proposal.status !== 'trial' || proposal.org_version_id === null) throw new Error(`org_proposal '${proposal.id}' is '${proposal.status}'; only a trial can be evaluated`);
  const version = db.get<{ created_at: string }>('SELECT created_at FROM org_version WHERE id = ?', [proposal.org_version_id]);
  if (!version) throw new Error(`trial org_version '${proposal.org_version_id}' does not exist`);
  // 재시험이면 마지막 재시험 승인 시각부터 센다 (이전 시험의 업무는 이미 판정된 것)
  const retry = db.get<{ at: string }>("SELECT occurred_at AS at FROM event WHERE source = 'org-proposal' AND external_id = ? AND type = 'org.proposal.trial' ORDER BY occurred_at DESC, rowid DESC LIMIT 1", [proposal.id]);
  const startedAt = retry?.at ?? version.created_at;
  const plan = JSON.parse(proposal.evaluation_plan) as OrgEvaluationPlan;
  const trialScope = JSON.parse(proposal.trial_scope) as { task_types: string[] };
  const now = clock.nowIso();

  const tasks = trialTasks(db, proposal, startedAt);
  const finished = tasks.filter((task) => task.status === 'completed' || task.status === 'failed');
  const passed = finished.filter((task) => task.status === 'completed' && task.outcome === 'pass' && task.safety === 'pass');
  const safetyFailures = tasks.filter((task) => task.safety === 'fail');
  const cost = tasks.length === 0 ? 0 : Number(db.get<{ total: number | null }>(
    `SELECT SUM(amount_usd) AS total FROM cost_entry WHERE task_id IN (${tasks.map(() => '?').join(', ')})`, tasks.map((task) => task.id),
  )?.total ?? 0);
  const baseline = baselineOf(db, trialScope.task_types, startedAt, plan.baseline_window_days);
  const rate = passRate(passed.length, finished.length);
  const periodEnd = Date.parse(startedAt) + plan.evaluation_days * DAY_MS;
  const minEnd = Date.parse(startedAt) + proposal.trial_min_days * DAY_MS;
  const metrics = {
    evaluator: ORG_TRIAL_EVALUATOR_REF, started_at: startedAt, evaluated_at: now, trial_tasks: tasks.length, observations: finished.length, passed: passed.length,
    pass_rate: rate, safety_failures: safetyFailures.length, cost_usd: Math.round(cost * 1e6) / 1e6, baseline: baseline.observations === 0 ? null : baseline,
    plan: { min_pass_rate: plan.min_pass_rate, min_observations: plan.min_observations, max_cost_usd: plan.max_cost_usd },
  };
  const evidenceRefs = tasks.map((task) => `task:${task.id}`);
  const result = (verdict: OrgTrialVerdict, reason: string, abortReason: 'safety' | 'budget' | null = null): OrgTrialAssessment => ({
    verdict, abortReason, observations: finished.length, reason, metrics, evidenceRefs,
  });

  if (safetyFailures.length > 0) return result('fail', `safety evaluation failed on ${safetyFailures.length} trial task(s): immediate stop`, 'safety');
  if (cost > plan.max_cost_usd) return result('fail', `trial cost $${cost.toFixed(4)} exceeds the allowed $${plan.max_cost_usd}: immediate stop`, 'budget');
  if (finished.length >= plan.min_observations && rate !== null && rate < plan.min_pass_rate) {
    return result('fail', `pass rate ${rate} is below the required ${plan.min_pass_rate} over ${finished.length} observations`);
  }
  if (Date.parse(now) < periodEnd) {
    const enough = finished.length >= plan.min_observations;
    if (!enough || Date.parse(now) < minEnd) return result('pending', `trial in progress (${finished.length}/${plan.min_observations} observations, evaluation period ends ${new Date(periodEnd).toISOString()})`);
  }
  if (finished.length < plan.min_observations) {
    return result('inconclusive', `the evaluation period ended with ${finished.length} of ${plan.min_observations} required observations (insufficient evidence)`);
  }
  if (Date.parse(now) < minEnd) return result('pending', `minimum trial period not over yet (until ${new Date(minEnd).toISOString()})`);
  if (baseline.pass_rate !== null && rate !== null && rate < baseline.pass_rate - BASELINE_TOLERANCE) {
    return result('fail', `pass rate ${rate} is more than ${BASELINE_TOLERANCE} below the baseline ${baseline.pass_rate}`);
  }
  return result('pass', `pass rate ${rate} over ${finished.length} observations meets ${plan.min_pass_rate}${baseline.pass_rate === null ? ' (no baseline: these task types had no executor before)' : ` and the baseline ${baseline.pass_rate}`}`);
}

/** pending 이 아닌 판정을 org_trial_result 에 남긴다 (평가기만 쓴다). 직전 행과 판정·관측 수가 같으면 쓰지 않는다. 쓴 행 id 또는 null */
export function recordOrgTrialResult(tx: Db, clock: Clock, proposalId: string, assessment: OrgTrialAssessment): string | null {
  if (assessment.verdict === 'pending') return null;
  const last = tx.get<{ outcome: string; observations: number; at: string }>(
    'SELECT outcome, observations, at FROM org_trial_result WHERE proposal_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', [proposalId],
  );
  const startedAt = String(assessment.metrics['started_at']);
  if (last && last.at >= startedAt && last.outcome === assessment.verdict && last.observations === assessment.observations) return null;
  const now = clock.nowIso();
  const id = `org-trial-result-${contentHash({ proposalId, verdict: assessment.verdict, observations: assessment.observations, now }).slice(0, 24)}`;
  tx.run(
    'INSERT INTO org_trial_result (id, proposal_id, evaluator, outcome, abort_reason, observations, metrics, evidence_refs, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, proposalId, ORG_TRIAL_EVALUATOR_REF, assessment.verdict, assessment.abortReason, assessment.observations, canonicalJson({ ...assessment.metrics, reason: assessment.reason }), JSON.stringify(assessment.evidenceRefs), now],
  );
  return id;
}
