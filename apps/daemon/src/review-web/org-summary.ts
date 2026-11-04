// 조직 변경 화면: 제안 요약(승인 대기 상세), 시험 현황, 재편 신호. 업무 규칙은 기존 읽기 함수를 그대로 쓴다
// (orgSignals, classifyOrgDiff, evaluateOrgTrial 은 모두 읽기 전용이다. 이 파일은 그 결과를 사람 말로 옮기고 그래프로 그린다).
import { classifyOrgDiff, parseOrgDiff, type OrgDiff, type OrgProposalRow } from '@aot/domain';
import { BASELINE_TOLERANCE } from '@aot/evaluation';

import type { ReviewContext } from './context.ts';
import { badge, h, kv, list, num, prettyJson, type Raw } from './html.ts';
import { barChart } from './svg.ts';

export function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const rec = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : prettyJson(value));
export const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export const ORG_STATUS_LABEL: Readonly<Record<string, string>> = {
  proposed: '승인 대기', approved: '승인됨(시험 시작 전)', trial: '시험 중', inconclusive: '판정 불충분(사람 결정 대기)', active: '확정', rejected: '거절됨',
  rolled_back: '되돌림', retired: '폐지', expired: '만료', superseded: '기준 버전 변경으로 무효',
};

/** 한 줄 설명: 어떤 역할을 어떤 업무 유형에 추가하나 */
export function orgHeadline(row: Pick<OrgProposalRow, 'diff' | 'trial_scope'>): string {
  const types = arr(rec(json(row.trial_scope))['task_types']).map(str).join(', ');
  try {
    const roles = parseOrgDiff(json(row.diff)).ops.map((op) => `'${op.role.slug}'`).join(', ');
    return `역할 ${roles} 추가${types === '' ? '' : ` (업무 유형: ${types})`}`;
  } catch {
    return '조직 변경 제안 (내용을 해석할 수 없다)';
  }
}

function diffSummary(diff: OrgDiff): Raw {
  return h`<ul>${diff.ops.map((op) => {
    const unit = typeof op.role.unit === 'string'
      ? h`기존 부서 <b>${op.role.unit}</b> 에 둔다`
      : h`새 부서 <b>${op.role.unit.slug}</b> (${op.role.unit.name}) 를 만들고 그 부서에 둔다. 부서 책임: ${op.role.unit.responsibility}`;
    return h`<li>새 역할 <b>${op.role.slug}</b> 를 추가한다 — ${op.role.description}<br>${unit}<br>
      <span class="mute">요청 도구:</span> ${op.role.allowed_tools.length === 0 ? '없음' : op.role.allowed_tools.map((tool) => h`<code>${tool.tool}</code> (${tool.operations.join(', ')}) `)}</li>`;
  })}</ul>`;
}

/** 시험·평가 계획을 사람 말로 */
function planSummary(plan: Record<string, unknown>, minDays: number): Raw {
  const rate = numOrNull(plan['min_pass_rate']);
  return list([
    h`<b>성공 기준</b>: 시험 업무 ${num(plan['min_observations'])}건 이상을 끝내고, 평가 통과율이 ${rate === null ? '-' : `${Math.round(rate * 100)}%`} 이상이며, 시험 전 같은 유형 업무의 통과율(기준선)보다 ${BASELINE_TOLERANCE} 넘게 낮지 않다`,
    h`<b>실패 기준</b>: 관측이 충분한데 통과율이 기준에 못 미치거나 기준선보다 많이 낮다. 제안이 기준으로 삼은 조직 버전이 그 사이 바뀌어도 실패(되돌림)`,
    h`<b>즉시 중단 기준</b>: 시험 업무에서 안전성 평가 실패 1건, 또는 비용 합계가 $${num(plan['max_cost_usd'])} 초과`,
    h`<b>최소 관측</b>: ${num(plan['min_observations'])}건. 평가 기간이 끝났는데 부족하면 "판정 불충분"이 되고 사람이 재시험 여부를 정한다`,
    h`<b>기간</b>: 최소 ${num(minDays)}일, 평가 기간 ${num(plan['evaluation_days'])}일. 기준선은 시험 전 ${num(plan['baseline_window_days'])}일의 같은 유형 업무`,
  ]);
}

function rollbackSummary(plan: Record<string, unknown>): Raw {
  return list([
    h`조직 버전: 시험 전 버전으로 복구한다 (${str(plan['org_version'])})`,
    h`예약 루틴: ${plan['routines'] === 'disable' ? '끈다' : str(plan['routines'])}`,
    h`대기 중 업무: <b>${str(rec(plan['queued_tasks'])['reroute_to'])}</b> 역할로 옮긴다`,
    h`실행 중 업무: ${plan['running_tasks'] === 'finish' ? '끝까지 마친다' : str(plan['running_tasks'])}`,
    h`이미 나간 외부 효과: ${plan['external_effects'] === 'human' ? '되돌리지 않는다 — 사람이 직접 처리한다' : str(plan['external_effects'])}`,
  ]);
}

/** 조직 제안 하나의 사람용 요약 (승인 대기 상세·시험 현황이 같이 쓴다) */
export function orgProposalSummary(ctx: ReviewContext, row: OrgProposalRow): Raw {
  const diff = ((): OrgDiff | null => {
    try {
      return parseOrgDiff(json(row.diff));
    } catch {
      return null;
    }
  })();
  const classified = diff === null ? null : ((): { changeClass: string; reasons: string[] } | null => {
    try {
      return classifyOrgDiff(ctx.db, diff);
    } catch {
      return null;
    }
  })();
  const risk = rec(json(row.risk_assessment));
  const plan = rec(json(row.evaluation_plan));
  const scope = rec(json(row.trial_scope));
  return h`
    <div><h2>무엇을 바꾸나</h2>${diff === null ? h`<p class="empty">변경 내용을 해석할 수 없다</p>` : diffSummary(diff)}
      ${kv([
        ['영향 받는 업무 유형', arr(scope['task_types']).map(str).join(', ') || '-'],
        ['변경 등급', h`${badge(row.change_class === 'risky' ? '위험 변경 (권한 확대)' : '일반 변경', row.change_class === 'risky' ? 'bad' : 'ok')} ${classified?.reasons.length ? classified.reasons.join(' / ') : ''}`],
        ['상태', badge(ORG_STATUS_LABEL[row.status] ?? row.status, 'info')],
        ['기준 조직 버전', row.base_org_version_id],
        ['만료', row.expires_at],
        ['제안자', row.proposed_by],
      ])}</div>
    <div><h2>왜 필요한가 (근거)</h2><p>${row.rationale}</p>
      <p class="mute">근거 참조: ${arr(json(row.evidence_refs)).map((ref) => h`<code>${str(ref)}</code> `)}</p></div>
    <div><h2>기대 효과</h2><p>${row.expected_effect}</p></div>
    <div><h2>위험과 완화책</h2><h3>위험</h3>${list(arr(risk['risks']).map(str))}<h3>완화책</h3>${list(arr(risk['mitigations']).map(str))}</div>
    <div><h2>평가 계획</h2>${planSummary(plan, row.trial_min_days)}</div>
    <div><h2>롤백 계획</h2>${rollbackSummary(rec(json(row.rollback_plan)))}</div>`;
}

// ----- 시험 현황 -----

export interface Metrics {
  passRate: number | null;
  observations: number;
  baselineRate: number | null;
  baselineObservations: number;
  minRate: number | null;
  minObservations: number | null;
  cost: number | null;
  maxCost: number | null;
  safetyFailures: number;
}

export function metricsOf(raw: unknown): Metrics {
  const m = rec(raw);
  const baseline = rec(m['baseline']);
  const plan = rec(m['plan']);
  return {
    passRate: numOrNull(m['pass_rate']), observations: numOrNull(m['observations']) ?? 0, baselineRate: numOrNull(baseline['pass_rate']), baselineObservations: numOrNull(baseline['observations']) ?? 0,
    minRate: numOrNull(plan['min_pass_rate']), minObservations: numOrNull(plan['min_observations']), cost: numOrNull(m['cost_usd']), maxCost: numOrNull(plan['max_cost_usd']),
    safetyFailures: numOrNull(m['safety_failures']) ?? 0,
  };
}

export const VERDICT: Readonly<Record<string, [string, 'ok' | 'bad' | 'warn' | 'info']>> = {
  pass: ['통과', 'ok'], fail: ['실패', 'bad'], inconclusive: ['판정 불충분', 'warn'], pending: ['진행 중', 'info'],
};

export function metricsCharts(m: Metrics, heading: string): Raw {
  const obsMax = Math.max(m.observations, m.minObservations ?? 0, 1);
  return h`<h3>${heading}</h3>
    ${barChart('통과율 (시험 vs 시험 전 기준선)', [
      { label: '시험 중 통과율', value: m.passRate, note: m.passRate === null ? undefined : `${Math.round(m.passRate * 100)}% (${m.observations}건)` },
      { label: '시험 전 기준선', value: m.baselineRate, tone: 'b2', note: m.baselineRate === null ? undefined : `${Math.round(m.baselineRate * 100)}% (${m.baselineObservations}건)` },
    ], { max: 1, ...(m.minRate === null ? {} : { ref: { value: m.minRate, label: `최소 ${Math.round(m.minRate * 100)}%` } }) })}
    ${barChart('관측 수 vs 최소 관측', [
      { label: '끝난 시험 업무', value: m.observations, note: `${m.observations}건` },
      { label: '최소 관측', value: m.minObservations, tone: 'b2', note: m.minObservations === null ? undefined : `${m.minObservations}건` },
    ], { max: obsMax })}
    ${m.cost === null || m.maxCost === null ? '' : barChart('비용 vs 허용 비용 (USD)', [
      { label: '시험 비용', value: m.cost, note: `$${num(m.cost)}` },
      { label: '허용 비용', value: m.maxCost, tone: 'b2', note: `$${num(m.maxCost)}` },
    ], { max: Math.max(m.cost, m.maxCost, 0.0001) })}`;
}


