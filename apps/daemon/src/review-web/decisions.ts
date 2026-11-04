// "결정할 일" 모델: 사람이 짧은 시간에 판단할 수 있도록 각 결정을 질문 한 줄 + 핵심 사실 3줄 + 판정 배지 + 선택(승인/거절 명령)으로 만든다.
// 업무 규칙은 새로 만들지 않는다: 해시·승인 단계는 승인 엔진 `show`, 만료·기준 버전은 `orgProposalStaleness`, 상품 승인 조건은 `registrationApproveBlocker`,
// 신호는 `orgSignals`, 시험 판정은 `evaluateOrgTrial`, 효과는 `listUnresolvedEffects` — 모두 읽기 전용이다. 이 파일은 그 결과를 사람 말로 옮긴다.
// 첫 화면에는 id·해시·ISO 시각·엔진 상태 문구·JSON 을 내지 않는다(명령 상자와 "자세히" 안에만).
import { createHash } from 'node:crypto';

import { getOrgProposal, type OrgProposalRow } from '@aot/domain';
import { evaluateOrgTrial } from '@aot/evaluation';
import { orgProposalStaleness } from '@aot/policy';
import { listUnresolvedEffects } from '@aot/task-engine';

import { listExperimentReviews } from '../cycle.ts';
import { orgSignals } from '../org-channel.ts';
import { productReader, registrationApproveBlocker } from '../product-channel.ts';
import { REGISTRATION_TRIGGER_PREFIX } from '../registration-task.ts';
import type { ReviewContext } from './context.ts';
import { ago, clip, monthDay, percent, until } from './format.ts';
import { APPROVE_CLI, choices, command, h, kv, link, list, num, prettyJson, shellArg, table, type Raw } from './html.ts';
import { arr, json, metricsCharts, metricsOf, orgProposalSummary, rec, str, type Metrics } from './org-summary.ts';
import { barChart } from './svg.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';

export interface Decision {
  key: string;
  href: string;
  question: string;
  /** 질문 바로 아래 한 문장 ("바뀌는 것") */
  lead?: string;
  /** 최대 3줄: 왜 지금 · 위험 · 기한 */
  facts: [string, string][];
  badge?: { label: string; tone: Tone };
  /** 작을수록 급하다 (기한 시각 또는 우선순위) */
  urgency: number;
  /** 승인/거절 선택 (상세에서만) */
  actions: Raw;
  /** "자세히" 안 */
  details: Raw;
}

const DAY = 86_400_000;
type Shown = Record<string, unknown>;
const obj = rec;

function shownOf(ctx: ReviewContext, kind: string, id: string): Shown | null {
  if (ctx.actor === null) return null;
  const response = ctx.engine.handle({ cmd: 'show', actor: ctx.actor, kind, id });
  return response.ok ? (response as unknown as Shown) : null;
}

const stateOf = (shown: Shown | null): string | null => {
  const state = obj(shown?.['approval'])['state'];
  return typeof state === 'string' ? state : null;
};
const hashArg = (shown: Shown | null): string => (shown !== null && typeof shown['hash'] === 'string' ? shellArg(shown['hash']) : '<해시를 확인할 수 없다>');
const rejectCmd = (alias: string, id: string): string => `${APPROVE_CLI} reject ${alias} ${shellArg(id)} --comment "사유"`;
const approveCmd = (alias: string, id: string, shown: Shown | null): string => `${APPROVE_CLI} approve ${alias} ${shellArg(id)} --hash ${hashArg(shown)} --comment "사유"`;

// ----- 승인 엔진의 대기 목록 -----
interface PendingLists {
  tasks: { id: string; objective: string }[];
  publications: { id: string; audience: string }[];
  policy_proposals: string[];
  strategy_proposals: { id: string; title: string }[];
  strategy_reviews: { planning_task_id: string; outcome: string; reasons: string[]; recorded_at: string }[];
  org_proposals: { id: string }[];
}
const EMPTY: PendingLists = { tasks: [], publications: [], policy_proposals: [], strategy_proposals: [], strategy_reviews: [], org_proposals: [] };

export function pendingLists(ctx: ReviewContext): { lists: PendingLists; problem: string | null } {
  if (ctx.actor === null) return { lists: EMPTY, problem: '이 DB 에 사람(human) 행위자가 없어 승인 대기 목록을 읽을 수 없습니다.' };
  const response = ctx.engine.handle({ cmd: 'list', actor: ctx.actor });
  if (!response.ok) return { lists: EMPTY, problem: '승인 대기 목록을 읽지 못했습니다.' };
  return { lists: { ...EMPTY, ...(response as unknown as Partial<PendingLists>) }, problem: null };
}

// ----- 조직 변경 제안 -----
export function orgDecision(ctx: ReviewContext, row: OrgProposalRow): Decision {
  const now = ctx.clock.nowMs();
  const shown = shownOf(ctx, 'org_proposal', row.id);
  const state = stateOf(shown);
  const diff = arr(obj(json(row.diff))['ops']).map(rec);
  const roles = diff.map((op) => rec(op['role']));
  const slugs = roles.map((r) => `'${str(r['slug'])}'`).join(', ');
  const types = arr(obj(json(row.trial_scope))['task_types']).map(str);
  const plan = rec(json(row.evaluation_plan));
  const newUnits = roles.map((r) => rec(r['unit'])).filter((u) => typeof u['slug'] === 'string').map((u) => `'${str(u['slug'])}'`);
  const risky = row.change_class === 'risky';
  const staleness = orgProposalStaleness(ctx.db, row, ctx.clock.nowIso());
  const staleText = staleness === null ? null : staleness.to === 'expired' ? '만료됨' : '기준 조직이 바뀜';
  const lead = `${types.length === 0 ? '일부' : types.map((t) => `'${t}'`).join(', ')} 업무를 맡을 역할 ${roles.length === 1 ? '하나' : `${roles.length}개`}를 추가합니다`
    + `${roles.length === 1 && str(roles[0]?.['description']) !== '' ? ` — ${clip(str(roles[0]?.['description']).replace(/\s*\([^)]*\)\s*$/, ''), 40)}` : ''}. `
    + `최소 ${row.trial_min_days}일 동안 이 업무만 맡기고, 통과율 ${percent(typeof plan['min_pass_rate'] === 'number' ? plan['min_pass_rate'] : null)} 미만이거나 안전 문제 1건이면 자동으로 되돌립니다.`
    + `${newUnits.length > 0 ? ` 새 부서 ${newUnits.join(', ')}도 만듭니다.` : ''}`;
  let badgeOut: Decision['badge'];
  if (staleText !== null) badgeOut = { label: `승인 불가 — ${staleText}`, tone: 'bad' };
  else if (state === 'cooldown') badgeOut = { label: '승인됨 — 대기 시간 중', tone: 'info' };
  else if (state === 'reauth_required') badgeOut = { label: 'OTP 해제 필요', tone: 'warn' };
  const alias = 'org';
  let actions: Raw;
  if (staleText !== null) {
    actions = choices({ approve: { blocked: `${staleText}라서 승인해도 엔진이 거절합니다. 새로 제안해야 합니다.` }, reject: { command: rejectCmd(alias, row.id), note: '정리하려면 거절로 닫습니다' } });
  } else if (state === 'cooldown') {
    actions = choices({ approve: { blocked: '이미 승인했고 대기 시간 중입니다.' }, reject: { label: '취소', command: `${APPROVE_CLI} cancel ${alias} ${shellArg(row.id)} --comment "사유"`, note: '대기 중에는 취소할 수 있습니다' } });
  } else if (state === 'reauth_required') {
    actions = choices({ approve: { label: '해제 (OTP)', command: `${APPROVE_CLI} release ${alias} ${shellArg(row.id)} --totp-stdin`, note: 'OTP 코드 한 줄을 표준 입력으로 넣습니다' }, reject: { label: '취소', command: `${APPROVE_CLI} cancel ${alias} ${shellArg(row.id)} --comment "사유"` } });
  } else {
    actions = choices({ approve: { command: approveCmd(alias, row.id, shown), ...(risky ? { note: '승인 뒤 대기 시간이 지나면 release 가 한 번 더 필요합니다' } : {}) }, reject: { command: rejectCmd(alias, row.id) } });
  }
  const original = obj(shown?.['approval']);
  return {
    key: `org:${row.id}`, href: `/approvals/org_proposal/${encodeURIComponent(row.id)}`,
    question: `새 역할 ${slugs} 시험 투입을 승인할까요?`, lead,
    facts: [
      ['왜 지금', clip(row.rationale, 80)],
      ['위험', risky ? '위험 변경 — 승인 후 OTP 해제 필요' : '일반 변경 — 시험 중에만 적용되고 문제가 생기면 자동으로 되돌립니다'],
      ['기한', until(row.expires_at, now)],
    ],
    ...(badgeOut === undefined ? {} : { badge: badgeOut }),
    urgency: Date.parse(row.expires_at), actions,
    details: h`${orgProposalSummary(ctx, row)}<h2>엔진 원문</h2>${kv([['승인 단계', str(original['state'])], ['설명', str(original['reason'])], ['제안 id', row.id]])}`,
  };
}

// ----- 업무 (사람 확인 필요) -----
interface TaskInfo {
  id: string; objective: string; reason: string; kind: 'customer' | 'external' | 'plain'; sig: string; waitingSince: string | null; denied: boolean; shown: Shown | null;
}

function taskInfo(ctx: ReviewContext, id: string): TaskInfo | null {
  const row = ctx.db.get<{ objective: string; spec: string; trigger_ref: string }>('SELECT objective, spec, trigger_ref FROM task WHERE id = ?', [id]);
  if (row === undefined || row.trigger_ref.startsWith(REGISTRATION_TRIGGER_PREFIX)) return null;
  if (ctx.db.get('SELECT 1 AS one FROM external_effect WHERE task_id = ? AND state = ?', [id, 'unknown']) !== undefined) return null; // 효과 확인 카드가 맡는다
  const tools = arr(rec(json(row.spec))['allowed_tools']).map(rec);
  const customer = tools.some((t) => t['impact'] === 'external_effect' && t['scope'] === 'customer');
  const external = tools.some((t) => t['impact'] === 'external_effect');
  const reason = ctx.db.get<{ reason: string; at: string }>('SELECT reason, at FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [id]);
  const shown = shownOf(ctx, 'task', id);
  const denied = arr(shown?.['decisions']).some((d) => rec(d)['decision'] === 'deny');
  return {
    id, objective: row.objective, reason: reason?.reason ?? '', kind: customer ? 'customer' : external ? 'external' : 'plain',
    sig: tools.map((t) => `${str(t['tool'])}:${str(t['impact'])}:${str(t['scope'])}`).sort().join(','), waitingSince: reason?.at ?? null, denied, shown,
  };
}

const TASK_LABEL = { customer: '고객에게 나가는 작업', external: '외부로 나가는 작업', plain: '사람 확인이 필요한 업무' } as const;
const TASK_WHY = { customer: '고객 대상 외부 효과라 정책상 사람 승인이 필요합니다', external: '외부 효과라 정책상 사람 승인이 필요합니다', plain: '정책이 사람 확인을 요구했습니다' } as const;
const TASK_RISK = { customer: '고객에게 실제로 전달되며 되돌릴 수 없습니다', external: '외부로 나가며 되돌리기 어렵습니다', plain: '내부 작업이라 되돌릴 수 있습니다' } as const;

const groupId = (info: TaskInfo): string => createHash('sha256').update(`${info.reason}|${info.kind}|${info.sig}`).digest('hex').slice(0, 12);

export function taskGroups(ctx: ReviewContext): TaskInfo[][] {
  const groups = new Map<string, TaskInfo[]>();
  for (const task of pendingLists(ctx).lists.tasks) {
    const info = taskInfo(ctx, task.id);
    if (info === null) continue;
    const gid = groupId(info);
    groups.set(gid, [...(groups.get(gid) ?? []), info]);
  }
  return [...groups.values()];
}

function waitingText(items: readonly TaskInfo[], now: number): string {
  const oldest = items.map((i) => i.waitingSince).filter((v): v is string => v !== null).sort()[0];
  return oldest === undefined ? '대기 중' : `${ago(oldest, now)}부터 멈춰 있음`;
}

export function taskDecision(ctx: ReviewContext, info: TaskInfo): Decision {
  const now = ctx.clock.nowMs();
  const actions = info.denied
    ? choices({ approve: { blocked: '현재 정책이 거부하는 작업이라 승인해도 실행되지 않습니다.' }, reject: { command: rejectCmd('task', info.id) } })
    : choices({ approve: { command: approveCmd('task', info.id, info.shown) }, reject: { command: rejectCmd('task', info.id) } });
  return {
    key: `task:${info.id}`, href: `/approvals/task/${encodeURIComponent(info.id)}`,
    question: `'${clip(info.objective)}' — ${info.kind === 'plain' ? '진행해도 될까요?' : '실행해도 될까요?'}`,
    facts: [['왜 지금', TASK_WHY[info.kind]], ['위험', TASK_RISK[info.kind]], ['대기', waitingText([info], now)]],
    ...(info.denied ? { badge: { label: '승인 불가 — 정책 거부', tone: 'bad' as const } } : {}),
    urgency: now, actions,
    details: h`${kv([['목표', info.objective], ['엔진 원문(전이 사유)', info.reason], ['업무 id', info.id]])}
      <h2>정책 판정 (원문)</h2>${table(['작업', '자원', '범위', '영향', '판정', '이유'], arr(info.shown?.['decisions']).map(rec).map((d) => [d['action'], d['resource'], d['scope'], d['impact'], d['decision'], d['reason']]))}`,
  };
}

export function batchDecision(ctx: ReviewContext, items: TaskInfo[]): Decision {
  const now = ctx.clock.nowMs();
  const first = items[0]!;
  const gid = groupId(first);
  return {
    key: `batch:${gid}`, href: `/batch/${gid}`,
    question: `${TASK_LABEL[first.kind]} ${items.length}건을 승인할까요?`,
    lead: '같은 사유로 멈춘 업무입니다. 건별로 승인·거절합니다.',
    facts: [['왜 지금', TASK_WHY[first.kind]], ['위험', TASK_RISK[first.kind]], ['대기', waitingText(items, now)]],
    urgency: now,
    actions: h`${items.map((info) => h`<div class="card"><h3>${clip(info.objective, 50)}</h3>${choices({
      approve: info.denied ? { blocked: '현재 정책이 거부합니다.' } : { command: approveCmd('task', info.id, info.shown) }, reject: { command: rejectCmd('task', info.id) },
    })}</div>`)}`,
    details: h`${kv([['엔진 원문(전이 사유)', first.reason]])}${list(items.map((i) => `${i.objective} (${i.id})`))}`,
  };
}

// ----- 게시 · 정책 · 전략 -----
export function publicationDecision(ctx: ReviewContext, id: string): Decision | null {
  const row = ctx.db.get<{ channel: string; audience: string; content_ref: string }>('SELECT channel, audience, content_ref FROM publication WHERE id = ?', [id]);
  if (row === undefined) return null;
  const shown = shownOf(ctx, 'publication', id);
  const who = row.audience === 'public' ? '누구나 볼 수 있게 공개' : row.audience === 'customer' ? '고객에게 공개' : '내부에 공개';
  return {
    key: `publication:${id}`, href: `/approvals/publication/${encodeURIComponent(id)}`,
    question: `게시물을 ${row.channel} 에 ${who}할까요?`,
    facts: [['왜 지금', '작성이 끝나 게시 승인을 기다립니다'], ['위험', row.audience === 'internal' ? '내부용이라 영향이 작습니다' : '게시하면 바깥 사람이 보게 됩니다']],
    urgency: ctx.clock.nowMs(), actions: choices({ approve: { command: approveCmd('publication', id, shown) }, reject: { command: rejectCmd('publication', id) } }),
    details: kv([['채널', row.channel], ['대상', row.audience], ['내용 위치', row.content_ref], ['게시 id', id]]),
  };
}

export function policyDecision(ctx: ReviewContext, id: string): Decision | null {
  const shown = shownOf(ctx, 'policy_version', id);
  if (shown === null) return null;
  const risky = shown['change_class'] === 'risky';
  const state = stateOf(shown);
  const alias = 'policy';
  const actions = state === 'cooldown'
    ? choices({ approve: { blocked: '이미 승인했고 대기 시간 중입니다.' }, reject: { label: '취소', command: `${APPROVE_CLI} cancel ${alias} ${shellArg(id)} --comment "사유"` } })
    : choices({ approve: { label: '해제 (OTP)', command: `${APPROVE_CLI} release ${alias} ${shellArg(id)} --totp-stdin`, note: '대기가 끝난 위험 변경만 해제됩니다' }, reject: { label: '취소', command: `${APPROVE_CLI} cancel ${alias} ${shellArg(id)} --comment "사유"` } });
  return {
    key: `policy:${id}`, href: `/approvals/policy_version/${encodeURIComponent(id)}`,
    question: '정책 변경을 배포할까요?',
    facts: [['왜 지금', '새 정책안이 승인을 거쳐 배포를 기다립니다'], ['위험', risky ? '위험 변경 — 대기 시간 뒤 OTP 해제 필요' : '일반 변경']],
    urgency: ctx.clock.nowMs() + 20 * DAY, actions,
    details: h`${kv([['변경 등급(원문)', str(shown['change_class'])], ['사유(원문)', arr(shown['reasons']).map(str).join(' / ')], ['승인 단계(원문)', str(obj(shown['approval'])['reason'])], ['제안 id', id]])}`,
  };
}

export function strategyDecision(ctx: ReviewContext, id: string): Decision | null {
  const row = ctx.db.get<{ title: string; body: string; experiment_scope: string | null }>('SELECT title, body, experiment_scope FROM strategy_version WHERE id = ?', [id]);
  if (row === undefined) return null;
  const shown = shownOf(ctx, 'strategy_version', id);
  const running = arr(shown?.['experiments_in_progress']).map(str);
  const scope = row.experiment_scope === null ? null : json(row.experiment_scope);
  return {
    key: `strategy:${id}`, href: `/approvals/strategy_version/${encodeURIComponent(id)}`,
    question: `'${clip(row.title)}' 실험을 시작할까요?`, lead: clip(row.body, 120),
    facts: [['왜 지금', '기획 결과에서 추천된 실험안입니다'], ['위험', '승인하면 실험 범위 안에서 주간 루틴이 켜집니다']],
    ...(running.length > 0 ? { badge: { label: '승인 불가 — 진행 중인 실험 있음', tone: 'bad' as const } } : {}),
    urgency: ctx.clock.nowMs() + 20 * DAY,
    actions: choices({ approve: running.length > 0 ? { blocked: '이미 진행 중인 실험이 있어 한 번에 하나만 승인할 수 있습니다.' } : { command: approveCmd('strategy', id, shown) }, reject: { command: rejectCmd('strategy', id) } }),
    details: h`${scope === null ? '' : h`<h2>실험 범위</h2><pre>${prettyJson(scope)}</pre>`}${kv([['전략 id', id]])}`,
  };
}

// ----- 상품 등록 -----
const KIND_LABEL: Readonly<Record<string, string>> = { source_url: '출처 주소', document: '문서', test_result: '시험 결과', run_log: '실행 기록', measurement: '측정값', approval: '승인 기록', other: '기타' };
export const evidenceKindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;
const SHADOW_LABEL: Readonly<Record<string, string>> = { supported: '검증기 의견: 근거가 뒷받침됨', unsupported: '검증기 의견: 근거가 부족함', unclear: '검증기 의견: 판단 불확실' };

export function productsAwaitingReview(ctx: ReviewContext): string[] {
  const reader = productReader(ctx.db);
  return ctx.db.all<{ slug: string; registration_status: string }>("SELECT slug, registration_status FROM product WHERE registration_status IN ('pending_approval', 'verifying') ORDER BY created_at, slug")
    .filter((p) => p.registration_status === 'pending_approval' || reader.awaitingReview(p.slug)).map((p) => p.slug);
}

export function productDecision(ctx: ReviewContext, slug: string): Decision | null {
  const reader = productReader(ctx.db);
  const product = reader.productBySlug(slug);
  if (product === undefined) return null;
  const view = reader.view(product) as {
    task: { id: string; status: string } | null; evaluation: { outcome: string; safety: string; note: string | null } | null; shadow_verdict: Record<string, unknown> | null;
    evidence: { id: string; kind: string; verified: boolean; trust_origin: string }[]; review_hash: string | null; repo_path: string | null;
  };
  const waiting = product.registration_status === 'pending_approval' || (product.registration_status === 'verifying' && reader.awaitingReview(slug));
  const task = reader.latestTask(slug);
  const blocked = !waiting || task === undefined ? null : registrationApproveBlocker({ registration_status: 'pending_approval' }, task, reader.evaluationOf(task.id), reader.evidenceOf(task.id));
  const evaluation = view.evaluation;
  const passed = evaluation !== null && evaluation.outcome === 'pass' && evaluation.safety === 'pass';
  const verdict = str(view.shadow_verdict?.['verdict']);
  const confirmed = view.evidence.filter((e) => e.verified).length;
  const external = view.evidence.filter((e) => e.trust_origin === 'external_untrusted').length;
  const BLOCK: Readonly<Record<string, string>> = { evaluation_not_passed: '검증이 통과하지 못했습니다', no_evidence: '확인된 증거가 없습니다', wrong_state: '지금은 결정할 단계가 아닙니다' };
  return {
    key: `product:${slug}`, href: `/products/${encodeURIComponent(slug)}`,
    question: `상품 '${product.name}'을 등록할까요?`,
    facts: [
      ['왜 지금', '코드 검증이 끝나 사람의 결정을 기다립니다'],
      ['검증', SHADOW_LABEL[verdict] ?? (evaluation === null ? '독립 평가가 아직 없습니다' : passed ? '독립 평가 통과' : '독립 평가 미통과')],
      ['증거', `${view.evidence.length}건 중 ${confirmed}건 확인됨${external > 0 ? `, 외부 입력 ${external}건 포함` : ''}`],
    ],
    badge: blocked !== null || !passed ? { label: '검증 실패 — 승인 불가', tone: 'bad' } : { label: '검증 통과', tone: 'ok' },
    urgency: ctx.clock.nowMs(),
    actions: choices({
      approve: blocked !== null ? { blocked: `${BLOCK[blocked.code] ?? '엔진이 승인을 거절합니다'}. 반려하거나 다시 검증하세요.` }
        : { command: `${APPROVE_CLI} product decide ${shellArg(slug)} approve --hash ${view.review_hash === null ? '<해시를 확인할 수 없다>' : shellArg(view.review_hash)} --comment "사유"`, note: '아래 증거를 읽은 뒤' },
      reject: { command: `${APPROVE_CLI} product decide ${shellArg(slug)} reject --comment "사유"`, note: '사유가 필수입니다' },
      extra: command(`${APPROVE_CLI} product restart ${shellArg(slug)} --comment "사유"`, '수정한 코드로 다시 검증하려면'),
    }),
    details: h`${kv([['종류', product.kind], ['단계', product.lifecycle_stage], ['저장소', view.repo_path ?? '-']])}
      <h2>독립 평가 (원문)</h2>${evaluation === null ? h`<p class="empty">없음</p>` : kv([['판정', evaluation.outcome], ['안전성', evaluation.safety], ['메모', evaluation.note ?? '-']])}
      <h2>검증기 판정 (원문)</h2>${view.shadow_verdict === null ? h`<p class="empty">없음</p>` : h`<pre>${prettyJson(view.shadow_verdict)}</pre>`}
      <h2>증거</h2>${table(['증거', '종류', '확인', '출처'], view.evidence.map((e) => [link(['evidence', e.id], evidenceKindLabel(e.kind)), evidenceKindLabel(e.kind), e.verified ? '확인됨' : '미확인', e.trust_origin === 'external_untrusted' ? '외부 입력 — 지시 아님' : '내부']), '증거 없음')}`,
  };
}

// ----- 외부 효과 -----
export function effectsDecision(ctx: ReviewContext): Decision | null {
  const now = ctx.clock.nowMs();
  const effects = listUnresolvedEffects(ctx.db, ctx.clock.nowIso());
  if (effects.length === 0) return null;
  const oldest = effects.map((e) => e.plannedAt).sort()[0]!;
  const tools = [...new Set(effects.map((e) => e.tool))].map((t) => `'${t}'`).join(', ');
  return {
    key: 'effects', href: '/effects',
    question: `보냈는지 확인 안 된 ${tools} 작업 ${effects.length}건 — 실제로 나갔나요?`,
    facts: [['왜 지금', '응답을 받지 못해 실제로 나갔는지 시스템이 모릅니다'], ['위험', '잘못 답하면 같은 내용이 두 번 나가거나 아예 안 나갑니다'], ['대기', `${ago(oldest, now)}부터 멈춰 있음`]],
    urgency: now,
    actions: h`${effects.map((e) => h`<div class="card"><h3>${e.tool} · ${e.action} → ${clip(e.target, 50)}</h3>${choices({
      approve: e.runActive ? { blocked: '실행 중인 작업이 있어 지금은 확인할 수 없습니다.' } : e.resolvedBefore ? { blocked: '이미 한 번 확인된 건이라 다시 확인할 수 없습니다.' }
        : { label: '나갔다고 확인', command: `${APPROVE_CLI} resolve-effect ${shellArg(e.effectId)} --outcome confirmed --note "확인한 내용"`, note: '받는 쪽(수신함 등)을 직접 확인한 뒤' },
      reject: e.runActive || e.resolvedBefore ? undefined : { label: '나가지 않았다고 확인', command: `${APPROVE_CLI} resolve-effect ${shellArg(e.effectId)} --outcome failed --note "확인한 내용" --totp-stdin`, note: 'OTP 코드 한 줄을 입력합니다. 이후 재전송은 정책 판정을 거칩니다' },
    })}</div>`)}`,
    details: table(['효과', '도구', '대상', '업무 상태', '재전송 허가'], effects.map((e) => [e.effectId, `${e.tool} ${e.action}`, e.target, e.taskStatus, e.supportsIdempotency ? (e.resendWindowOpen ? '가능' : '불가(보존 기간 지남)') : '지원 안 함'])),
  };
}

// ----- 실험 결과 -----
export function experimentDecisions(ctx: ReviewContext): Decision[] {
  const reviews = listExperimentReviews(ctx.db);
  const title = (id: string): string => ctx.db.get<{ title: string }>('SELECT title FROM strategy_version WHERE id = ?', [id])?.title ?? id;
  const out: Decision[] = [];
  for (const e of reviews.awaitingPromotion) {
    out.push({
      key: `promote:${e.strategyVersionId}`, href: `/experiments/${encodeURIComponent(e.strategyVersionId)}`,
      question: `'${clip(title(e.strategyVersionId))}' 실험이 목표를 넘겼습니다. 정식 전략으로 올릴까요?`,
      facts: [['왜 지금', '결과 평가가 통과해 사람의 승격 결정을 기다립니다'], ['위험', '이전 활성 전략은 보관(retired) 처리됩니다']],
      badge: { label: '검증 통과', tone: 'ok' }, urgency: ctx.clock.nowMs(),
      actions: choices({ approve: { label: '정식 전략으로 올리기', command: `${APPROVE_CLI} promote strategy ${shellArg(e.strategyVersionId)} --comment "사유"` }, reject: { command: rejectCmd('strategy', e.strategyVersionId) } }),
      details: kv([['실험 비용(USD)', num(e.totalCostUsd)], ['평가 id', e.evaluationId], ['전략 id', e.strategyVersionId]]),
    });
  }
  for (const e of reviews.needsHuman) {
    out.push({
      key: `needs:${e.strategyVersionId}`, href: `/experiments/${encodeURIComponent(e.strategyVersionId)}`,
      question: `'${clip(title(e.strategyVersionId))}' 실험 결과를 판정하지 못했습니다. 이 실험을 끝낼까요?`,
      facts: [['왜 지금', '결과를 가릴 증거가 부족합니다'], ['위험', '끝내도 기억(결과 기록)은 만들어지지 않습니다']],
      badge: { label: '판정 보류', tone: 'warn' }, urgency: ctx.clock.nowMs() + DAY,
      actions: choices({ reject: { label: '실험 끝내기', command: rejectCmd('strategy', e.strategyVersionId), note: '사유가 필수입니다. 그대로 두면 계속 대기합니다' } }),
      details: kv([['엔진 원문', e.reason], ['검토 업무', e.reviewTaskId], ['전략 id', e.strategyVersionId]]),
    });
  }
  return out;
}

// ----- 조직 시험 -----
export interface TrialState {
  row: OrgProposalRow; roleSlugs: string[]; verdict: string; reason: string; metrics: Metrics | null; endsAt: string | null; minDays: number;
  results: { outcome: string; observations: number; at: string }[]; latest: string | null;
}

export function trialState(ctx: ReviewContext, row: OrgProposalRow): TrialState {
  const results = ctx.db.all<{ outcome: string; observations: number; at: string; metrics: string }>('SELECT outcome, observations, at, metrics FROM org_trial_result WHERE proposal_id = ? ORDER BY at, rowid', [row.id]);
  let verdict = results.at(-1)?.outcome ?? 'pending';
  let reason = '';
  let metrics: Metrics | null = results.length === 0 ? null : metricsOf(json(results.at(-1)!.metrics));
  let startedAt: string | null = null;
  if (row.status === 'trial') {
    try {
      const a = evaluateOrgTrial(ctx.db, ctx.clock, row);
      verdict = results.at(-1)?.outcome === 'pass' && a.verdict === 'pass' ? 'pass' : a.verdict;
      reason = a.reason;
      metrics = metricsOf(a.metrics);
      startedAt = typeof a.metrics['started_at'] === 'string' ? a.metrics['started_at'] : null;
    } catch { /* 계산할 수 없으면 기록된 값만 쓴다 */ }
  }
  const evalDays = Number(rec(json(row.evaluation_plan))['evaluation_days']);
  return {
    row, roleSlugs: arr(obj(json(row.diff))['ops']).map((op) => str(rec(rec(op)['role'])['slug'])), verdict, reason, metrics,
    endsAt: startedAt !== null && Number.isFinite(evalDays) ? new Date(Date.parse(startedAt) + evalDays * DAY).toISOString() : null,
    minDays: row.trial_min_days, results: results.map((r) => ({ outcome: r.outcome, observations: r.observations, at: r.at })), latest: results.at(-1)?.outcome ?? null,
  };
}

function trialLine(t: TrialState): string {
  const m = t.metrics;
  const obs = m?.observations ?? 0;
  const min = m?.minObservations ?? null;
  const rate = m?.passRate ?? null;
  const base = rate === null ? '' : ` 지금까지 통과율 ${percent(rate)}${m?.minRate == null ? '' : `로 기준(${percent(m.minRate)}) ${rate >= m.minRate ? '이상' : '미만'}`}.`;
  if (t.verdict === 'pass') return `통과 — ${obs}건 관측.${base}`;
  if (t.verdict === 'inconclusive') return `판정 불충분 — ${min ?? '?'}건이 필요한데 ${obs}건만 관측됐습니다.${base}`;
  if (t.verdict === 'fail') return `실패 — ${obs}건 관측.${base}`;
  return `아직 판정 전 — ${min ?? '?'}건 중 ${obs}건 관측.${base}`;
}

export function trialDecision(ctx: ReviewContext, row: OrgProposalRow): Decision | null {
  const t = trialState(ctx, row);
  const slugs = t.roleSlugs.map((s) => `'${s}'`).join(', ');
  const common = { urgency: ctx.clock.nowMs() + 2 * DAY, href: `/trials/${encodeURIComponent(row.id)}` };
  const detail = trialDetails(ctx, t);
  if (row.status === 'trial' && t.latest === 'pass') {
    return {
      ...common, key: `confirm:${row.id}`, question: `${slugs} 시험이 통과했습니다. 정식 확정할까요?`, lead: trialLine(t),
      facts: [['왜 지금', '평가 기간이 끝나 통과 판정이 났습니다'], ['위험', '확정하면 시험 범위가 아니라 정식 조직이 됩니다 (이후 되돌리기 가능)']],
      badge: { label: '검증 통과', tone: 'ok' },
      actions: choices({ approve: { label: '정식 확정', command: `${APPROVE_CLI} org confirm ${shellArg(row.id)} --comment "사유"` }, extra: h`<p class="mute">확정하지 않으면 시험 상태로 남습니다.</p>` }), details: detail,
    };
  }
  if (row.status === 'inconclusive') {
    return {
      ...common, key: `retrial:${row.id}`, question: `${slugs} 시험은 관측이 부족했습니다. 한 번 더 시험할까요?`, lead: trialLine(t),
      facts: [['왜 지금', '평가 기간이 끝났지만 판단할 만큼 업무가 쌓이지 않았습니다'], ['위험', `재시험은 제안당 1회까지입니다 (지금까지 ${row.trial_extensions}회)`]],
      badge: { label: '판정 보류', tone: 'warn' },
      actions: choices({ approve: { label: '재시험', command: `${APPROVE_CLI} org retrial ${shellArg(row.id)} --file evaluation-plan.json --comment "사유"`, note: '새 평가 계획 JSON 파일이 필요합니다' }, extra: h`<p class="mute">재시험하지 않으면 판정 불충분 상태로 남습니다.</p>` }), details: detail,
    };
  }
  return null;
}

export function trialDetails(ctx: ReviewContext, t: TrialState): Raw {
  return h`${t.metrics === null ? '' : metricsCharts(t.metrics, '관측·비용')}
    <h2>판정 기록</h2>${table(['날짜', '판정', '관측'], t.results.map((r) => [monthDay(r.at), r.outcome, r.observations]), '아직 기록된 판정이 없습니다')}
    ${t.reason === '' ? '' : h`<h2>평가기 원문</h2><p>${t.reason}</p>`}
    ${orgProposalSummary(ctx, t.row)}`;
}

/** 시험 상세 한 장: 판정 한 줄 → 작은 그래프 1개 → 선택 */
export function trialPage(ctx: ReviewContext, row: OrgProposalRow): { title: string; lead: string; body: Raw } {
  const t = trialState(ctx, row);
  const decision = trialDecision(ctx, row);
  const m = t.metrics;
  const chart = m === null ? h`` : barChart('통과율 — 시험 vs 시험 전 기준선', [
    { label: '시험 중', value: m.passRate, note: m.passRate === null ? undefined : `${percent(m.passRate)} (${m.observations}건)` },
    { label: '시험 전 기준선', value: m.baselineRate, tone: 'b2', note: m.baselineRate === null ? undefined : `${percent(m.baselineRate)} (${m.baselineObservations}건)` },
  ], { max: 1, ...(m.minRate === null ? {} : { ref: { value: m.minRate, label: `기준 ${percent(m.minRate)}` } }) });
  const slugs = t.roleSlugs.map((s) => `'${s}'`).join(', ');
  return {
    title: decision?.question ?? `${slugs} 시험 중`, lead: trialLine(t),
    body: h`${t.endsAt === null ? '' : h`<p class="mute">${until(t.endsAt, ctx.clock.nowMs(), '판정')} (${monthDay(t.endsAt)})</p>`}${chart}${decision?.actions ?? h`<p class="mute">지금은 할 일이 없습니다. 판정이 나면 결정할 일에 올라옵니다.</p>`}<details><summary>자세히</summary>${decision?.details ?? trialDetails(ctx, t)}</details>`,
  };
}

// ----- 조직 신호 -----
export function signalDecisions(ctx: ReviewContext): Decision[] {
  const signals = orgSignals(ctx.db, ctx.clock) as { window_days: number; unassigned: { task_type: string; count: number; candidate: boolean }[] };
  const covered = new Set(ctx.db.all<{ trial_scope: string }>("SELECT trial_scope FROM org_proposal WHERE status IN ('proposed', 'approved', 'trial', 'inconclusive')")
    .flatMap((r) => arr(rec(json(r.trial_scope))['task_types']).map(str)));
  return signals.unassigned.filter((s) => s.candidate && !covered.has(s.task_type)).map((s) => ({
    key: `signal:${s.task_type}`, href: `/signals/${encodeURIComponent(s.task_type)}`,
    question: `'${s.task_type}' 업무 ${s.count}건이 담당자 없이 멈췄습니다 — 새 역할 제안서를 만들까요?`,
    facts: [['왜 지금', `최근 ${signals.window_days}일 동안 ${s.count}건이 맡을 역할이 없어 멈췄습니다`], ['위험', '제안서만 만들어집니다. 아무것도 바뀌지 않고 승인은 따로 합니다']],
    urgency: ctx.clock.nowMs() + 25 * DAY,
    actions: choices({ approve: { label: '제안서 만들기', command: `${APPROVE_CLI} org propose --type ${shellArg(s.task_type)} --role <새-역할-slug> [--unit <부서-slug>]`, note: '역할 slug 는 직접 정합니다' }, extra: h`<p class="mute">그대로 두면 이 업무는 계속 멈춰 있습니다.</p>` }),
    details: h`<p>맡을 역할이 없는 업무 유형 '${s.task_type}' (최근 ${signals.window_days}일 ${s.count}건). 기준은 3건 이상입니다.</p>`,
  }));
}

// ----- 모아 보기 -----
export function buildInbox(ctx: ReviewContext): { decisions: Decision[]; problem: string | null } {
  const { lists, problem } = pendingLists(ctx);
  const out: Decision[] = [];
  for (const { id } of lists.org_proposals) {
    const row = getOrgProposal(ctx.db, id);
    if (row !== undefined) out.push(orgDecision(ctx, row));
  }
  for (const group of taskGroups(ctx)) out.push(group.length === 1 ? taskDecision(ctx, group[0]!) : batchDecision(ctx, group));
  for (const p of lists.publications) {
    const d = publicationDecision(ctx, p.id);
    if (d !== null) out.push(d);
  }
  for (const id of lists.policy_proposals) {
    const d = policyDecision(ctx, id);
    if (d !== null) out.push(d);
  }
  for (const s of lists.strategy_proposals) {
    const d = strategyDecision(ctx, s.id);
    if (d !== null) out.push(d);
  }
  for (const slug of productsAwaitingReview(ctx)) {
    const d = productDecision(ctx, slug);
    if (d !== null) out.push(d);
  }
  const effects = effectsDecision(ctx);
  if (effects !== null) out.push(effects);
  out.push(...experimentDecisions(ctx));
  for (const row of ctx.db.all<OrgProposalRow>("SELECT * FROM org_proposal WHERE status IN ('trial', 'inconclusive') ORDER BY created_at, id")) {
    const d = trialDecision(ctx, row);
    if (d !== null) out.push(d);
  }
  out.push(...signalDecisions(ctx));
  return { decisions: out.sort((a, b) => a.urgency - b.urgency || a.key.localeCompare(b.key)), problem };
}

/** 지켜보는 중 (할 일 없음): 한 줄씩 */
export function watchLines(ctx: ReviewContext): { text: string; href?: string }[] {
  const lines: { text: string; href?: string }[] = [];
  for (const row of ctx.db.all<OrgProposalRow>("SELECT * FROM org_proposal WHERE status IN ('trial', 'approved') ORDER BY created_at, id")) {
    if (row.status === 'approved') {
      lines.push({ text: `${arr(obj(json(row.diff))['ops']).map((op) => `'${str(rec(rec(op)['role'])['slug'])}'`).join(', ')} 승인됨 — 시험 시작 대기` });
      continue;
    }
    if (trialDecision(ctx, row) !== null) continue; // 결정할 일에 올라와 있다
    const t = trialState(ctx, row);
    const m = t.metrics;
    lines.push({
      text: `${t.roleSlugs.map((s) => `'${s}'`).join(', ')} 시험 중 — ${m?.observations ?? 0}/${m?.minObservations ?? '?'}건 관측${m?.passRate == null ? '' : `, 지금까지 통과 ${percent(m.passRate)}`}${t.endsAt === null ? '' : `, ${monthDay(t.endsAt)} 판정`}`,
      href: `/trials/${encodeURIComponent(row.id)}`,
    });
  }
  for (const e of listExperimentReviews(ctx.db).awaitingResult) {
    const title = ctx.db.get<{ title: string }>('SELECT title FROM strategy_version WHERE id = ?', [e.strategyVersionId])?.title ?? '';
    lines.push({ text: `실험 '${clip(title)}' — 결과를 기다리는 중` });
  }
  const reviews = pendingLists(ctx).lists.strategy_reviews;
  if (reviews.length > 0) lines.push({ text: `추천 없이 끝난 실험 비교 ${reviews.length}건 — 읽어 보고 다음 기획에 반영합니다` });
  const problems = (orgSignals(ctx.db, ctx.clock) as { role_problems: { role: string; needs_review: number; failed: number; candidate: boolean }[] }).role_problems.filter((r) => r.candidate);
  for (const r of problems) lines.push({ text: `역할 '${r.role}' — 최근 사람 확인 필요 ${r.needs_review}건·실패 ${r.failed}건이 반복됩니다` });
  return lines;
}
