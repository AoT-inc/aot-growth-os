// "결정할 일" 모델: 사람이 짧은 시간에 판단할 수 있도록 각 결정을 질문 한 줄 + 핵심 사실 3줄 + 판정 배지 + 이력 + 결정 버튼(actions.ts)으로 만든다.
// 업무 규칙은 새로 만들지 않는다: 해시·승인 단계는 승인 엔진 `show`, 만료·기준 버전은 `orgProposalStaleness`, 상품 승인 조건은 `registrationApproveBlocker`,
// 신호는 `orgSignals`, 시험 판정은 `evaluateOrgTrial`, 효과는 `listUnresolvedEffects` — 모두 읽기 전용이다. 이 파일은 그 결과를 사람 말로 옮긴다.
// 첫 화면에는 id·해시·ISO 시각·엔진 상태 문구·JSON 을 내지 않는다("자세히" 안에만). 명령어는 어디에도 찍지 않는다: 결정은 버튼이고, 버튼이 보낼 요청은 여기서 데이터로만 만든다.
import { createHash } from 'node:crypto';

import { draftSendStates, getOrgProposal, maskedPathsOf, messagePreviewOf, proposedDraftsOf, type DraftSendState, type OrgProposalRow } from '@aot/domain';
import { evaluateOrgTrial } from '@aot/evaluation';
import { orgProposalStaleness } from '@aot/policy';
import { listUnresolvedEffects } from '@aot/task-engine';

import { listExperimentReviews } from '../cycle.ts';
import { orgSignals } from '../org-channel.ts';
import { productReader, registrationApproveBlocker } from '../product-channel.ts';
import { REGISTRATION_TRIGGER_PREFIX } from '../registration-task.ts';
import { maskMessagePayload, type ReviewContext } from './context.ts';
import { readEvidence } from './evidence-file.ts';
import { addressDomain, ago, clip, commonAffixes, draftExpiry, eulReul, maskAddress, monthDay, percent, until } from './format.ts';
import { renderActions, type Actions, type Blocked, type Button, type Step } from './actions.ts';
import { full, h, kv, link, list, num, prettyJson, table, type Raw } from './html.ts';
import { historyList, productLinks, subjectHistory, taskHistory } from './history.ts';
import { controlActions, delegatedActions, handedBackReason, CONTROL_KEY, DELEGATED_KEY } from './delegation.ts';
import { arr, json, metricsCharts, metricsOf, orgProposalSummary, rec, str, type Metrics } from './org-summary.ts';
import { barChart } from './svg.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';

export type Category = 'outside' | 'org' | 'experiment' | 'product' | 'other';

export interface Decision {
  key: string;
  /** 요약 한 줄에 쓰는 분류 */
  category: Category;
  /** "먼저" 묶음: 바깥에 나가거나, 하루 이상 업무를 막거나, 3일 안에 만료 */
  first: boolean;
  href: string;
  question: string;
  /** 질문 바로 아래 한 문장 ("바뀌는 것") */
  lead?: string;
  /** 최대 3줄: 무엇 · 확인할 것 · 위험·기한 */
  facts: [string, string][];
  badge?: { label: string; tone: Tone };
  /** 배지가 더 있을 때 (예: 외부 입력 영향 하에 작성됨) */
  badges?: { label: string; tone: Tone }[];
  /** 결정하기 상자 바로 위에 보이는 본문 (초안 승인: 받는 사람·제목·본문). 상세 화면에만 */
  body?: Raw;
  /** 작을수록 급하다 (기한 시각 또는 우선순위) */
  urgency: number;
  /** 결정 버튼 (상세에서만 그려진다) */
  actions: Actions;
  /** 이력 요약 최대 3줄 + 링크 (상세에서만) */
  history?: Raw[];
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

// ----- 결정 버튼을 만드는 작은 부품 -----
// 한 단계 = 엔진에 보낼 요청 하나. `hash` 는 사람이 본 내용의 엔진 해시(`show`)다. 엔진은 approve 의 hash 와 reject·cancel·request_changes·release 의 expected_hash(트랙 B)로 낡은 화면을 막는다.
const hashOf = (shown: Shown | null): string | null => (shown !== null && typeof shown['hash'] === 'string' ? shown['hash'] : null);
const approveStep = (kind: string, id: string, shown: Shown | null, label: string): Step | null => {
  const hash = hashOf(shown);
  return hash === null ? null : { label, request: { cmd: 'approve', kind, id, hash }, hash };
};
const plainStep = (cmd: 'reject' | 'cancel' | 'release', kind: string, id: string, shown: Shown | null, label: string): Step => ({ label, request: { cmd, kind, id }, hash: hashOf(shown) });
const changesStep = (id: string, shown: Shown | null, label: string): Step => ({ label, request: { cmd: 'request_changes', kind: 'task', id }, hash: hashOf(shown) });

type Part = { buttons?: Button[]; blocked?: Blocked[] };
const actionsOf = (extra: Raw | undefined, ...parts: Part[]): Actions => ({ buttons: parts.flatMap((p) => p.buttons ?? []), blocked: parts.flatMap((p) => p.blocked ?? []), extra });
const blockedPart = (label: string, why: string): Part => ({ blocked: [{ label, why }] });

const NO_HASH = '내용을 확인할 수 없어 승인할 수 없습니다. 화면을 새로 고쳐 보세요.';
/** 승인 버튼. 단계 중 해시를 읽지 못한 것이 있으면(엔진이 보여 주지 못함) 승인하지 않는다 */
function approvePart(steps: (Step | null)[], o: { label?: string; note?: string; done?: string; reason?: Button['reason'] } = {}): Part {
  if (steps.length === 0 || steps.some((s) => s === null)) return blockedPart('승인', NO_HASH);
  return { buttons: [{ verb: 'approve', label: o.label ?? '승인', tone: 'yes', steps: steps as Step[], reason: o.reason ?? 'none', ...(o.note === undefined ? {} : { note: o.note }), done: o.done ?? '승인했습니다.' }] };
}
/** 거절(이유는 선택, 접혀 있다) */
const rejectPart = (steps: Step[], o: { label?: string; note?: string; done?: string; reason?: Button['reason']; reasonLabel?: string } = {}): Part => ({
  buttons: [{ verb: 'reject', label: o.label ?? '거절', tone: 'no', steps, reason: o.reason ?? 'optional', ...(o.reasonLabel === undefined ? {} : { reasonLabel: o.reasonLabel }), ...(o.note === undefined ? {} : { note: o.note }), done: o.done ?? '거절했습니다.' }],
});
/** 다시 쓰게: 이유는 필수 (엔진 규칙 1~500자) */
const changesPart = (steps: Step[], label = '다시 쓰게'): Part => ({
  buttons: [{ verb: 'changes', label, tone: 'ch', steps, reason: 'required', reasonLabel: '다시 쓰게 하기 — 무엇을 고칠지 (필수)', collapse: true, note: '초안을 버리고 에이전트가 다시 쓰게 합니다', done: '다시 쓰라고 요청했습니다. 새 초안이 올라오면 결정할 일에 나타납니다.' }],
});
const cancelPart = (steps: Step[], note?: string): Part => ({ buttons: [{ verb: 'cancel', label: '취소', tone: 'no', steps, reason: 'none', ...(note === undefined ? {} : { note }), done: '취소했습니다.' }] });
const otpPart = (steps: Step[], note?: string): Part => ({ buttons: [{ verb: 'otp', label: 'OTP 확인', tone: 'yes', steps, reason: 'none', otp: true, ...(note === undefined ? {} : { note }), done: 'OTP 확인을 마쳤습니다. 곧 진행됩니다.' }] });

/** 화면에서 할 수 없는 결정(파일이 필요한 것): 버튼 대신 한 줄 안내 */
const NOT_HERE = (why: string): Raw => h`<p class="mute">이 결정은 화면에서 할 수 없습니다. ${why} 방법은 운영 문서(docs/operations/review-web.md)에 있습니다.</p>`;

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
const OTP_AGAIN = 'OTP 코드로 한 번 더 확인';

/** 역할을 사람 말로: 설명(끝의 괄호 제거)이 있으면 그것, 없으면 slug */
export function roleLabel(role: Record<string, unknown>): string {
  const desc = str(role['description']).replace(/\s*\([^)]*\)\s*$/, '').trim();
  return clip(desc === '' ? str(role['slug']) : desc, 28);
}

const rolesOf = (row: Pick<OrgProposalRow, 'diff'>): Record<string, unknown>[] => arr(obj(json(row.diff))['ops']).map((op) => rec(rec(op)['role']));

export function orgDecision(ctx: ReviewContext, row: OrgProposalRow): Decision {
  const now = ctx.clock.nowMs();
  const shown = shownOf(ctx, 'org_proposal', row.id);
  const state = stateOf(shown);
  const roles = rolesOf(row);
  const labels = roles.map(roleLabel);
  const types = arr(obj(json(row.trial_scope))['task_types']).map(str);
  const plan = rec(json(row.evaluation_plan));
  const newUnits = roles.map((r) => rec(r['unit'])).filter((u) => typeof u['slug'] === 'string').map((u) => `'${str(u['name'] ?? u['slug'])}'`);
  const risky = row.change_class === 'risky';
  const staleness = orgProposalStaleness(ctx.db, row, ctx.clock.nowIso());
  const staleText = staleness === null ? null : staleness.to === 'expired' ? '만료됨' : '기준 조직이 바뀜';
  // 질문에 이미 업무 유형이 보이면 문장에서는 "이 업무"라고만 한다 (같은 말을 두 번 쓰지 않는다)
  const typeInTitle = types.length > 0 && labels.some((l) => types.some((t) => l.includes(t)));
  const workText = types.length === 0 ? '일부 업무' : typeInTitle ? '이 업무' : `'${types.join(', ')}' 업무`;
  const days = row.trial_min_days;
  const rate = percent(typeof plan['min_pass_rate'] === 'number' ? plan['min_pass_rate'] : null);
  const lead = `${eulReul(workText)} 맡을 역할 ${roles.length === 1 ? '하나' : `${roles.length}개`}를 추가합니다. 최소 ${days}일 동안 이 업무만 맡기고, 통과율 ${rate} 미만이거나 안전 문제 1건이면 자동으로 되돌립니다.`
    + `${newUnits.length > 0 ? ` 새 부서 ${newUnits.join(', ')}도 만듭니다.` : ''}`;
  let badgeOut: Decision['badge'];
  if (staleText !== null) badgeOut = { label: `승인 불가 — ${staleText}`, tone: 'bad' };
  else if (state === 'cooldown') badgeOut = { label: '승인됨 — 대기 시간 중', tone: 'info' };
  else if (state === 'reauth_required') badgeOut = { label: `${OTP_AGAIN} 필요`, tone: 'warn' };
  const kind = 'org_proposal';
  const name = `'${labels.join(', ')}' 역할`;
  let actions: Actions;
  if (staleText !== null) {
    actions = actionsOf(undefined, blockedPart('승인', `${staleText}라서 승인할 수 없습니다. 새로 제안해야 합니다.`), rejectPart([plainStep('reject', kind, row.id, shown, name)], { note: '정리하려면 거절로 닫습니다' }));
  } else if (state === 'cooldown') {
    actions = actionsOf(undefined, blockedPart('승인', '이미 승인했고 대기 시간 중입니다.'), cancelPart([plainStep('cancel', kind, row.id, shown, name)], '대기 중에는 취소할 수 있습니다'));
  } else if (state === 'reauth_required') {
    actions = actionsOf(undefined, otpPart([plainStep('release', kind, row.id, shown, name)]), cancelPart([plainStep('cancel', kind, row.id, shown, name)]));
  } else {
    actions = actionsOf(undefined,
      approvePart([approveStep(kind, row.id, shown, name)], { ...(risky ? { note: `승인 뒤 대기 시간이 지나면 ${OTP_AGAIN}해야 합니다`, done: `승인했습니다. 대기 시간이 지나면 ${OTP_AGAIN}해야 진행됩니다.` } : {}) }),
      rejectPart([plainStep('reject', kind, row.id, shown, name)]));
  }
  const original = obj(shown?.['approval']);
  const expiry = Date.parse(row.expires_at);
  return {
    key: `org:${row.id}`, category: 'org', first: expiry - now <= 3 * DAY, href: `/approvals/org_proposal/${encodeURIComponent(row.id)}`,
    question: `'${labels.join(', ')}' 역할을 시험 투입할까요?`, lead,
    facts: [
      ['무엇', `새 역할을 ${days}일 시험 투입합니다 (${types.length === 0 ? '일부 업무' : typeInTitle ? '이 업무만' : `${types.join(', ')} 업무만`})`],
      ['확인할 것', `이 업무를 새 역할에 맡겨도 되는지 — ${clip(row.rationale, 60)}`],
      ['위험·기한', `${risky ? `위험 변경 — 승인 후 ${OTP_AGAIN}해야 함` : '일반 변경 — 문제가 생기면 자동으로 되돌림'} · ${until(row.expires_at, now)}`],
    ],
    ...(badgeOut === undefined ? {} : { badge: badgeOut }),
    urgency: expiry, actions, history: subjectHistory(ctx, 'org_proposal', row.id),
    details: h`${orgProposalSummary(ctx, row)}<h2>엔진 원문</h2>${kv([['승인 단계', str(original['state'])], ['설명', str(original['reason'])], ['제안 id', row.id]])}`,
  };
}

// ----- 업무 (사람 확인 필요) -----
interface TaskInfo {
  id: string; objective: string; reason: string; kind: 'customer' | 'external' | 'plain'; sig: string; waitingSince: string | null; denied: boolean; shown: Shown | null;
  /** 바깥으로 나가는 도구의 대상 (예: 받는 곳) */
  targets: string[]; spec: unknown;
  /** 사람이 승인할 제안된 초안 (ADR-0015). 없으면 지금까지의 업무 카드 */
  drafts: DraftInfo[];
}

interface DraftInfo {
  seq: number; tool: string; action: string; target: string; payloadHash: string; expiresAt: string; expired: boolean; influenced: boolean;
  /** 메시지 모양이면 받는 사람·제목·첫 줄, 아니면 null */
  preview: ReturnType<typeof messagePreviewOf>;
  /** 파싱한 payload (메시지 모양이 아니면 원문 확인용) */
  payload: unknown;
  /** 메시지 모양이면 본문 */
  body: string | null;
  /** 표시용 가리기가 바꾼 값의 경로. 비어 있지 않으면 승인할 수 없다 (엔진과 같은 maskedPathsOf) */
  maskedPaths: string[];
  /** 원장의 전송 상태 (`none` = 아직 시작 안 함) */
  sendState: DraftSendState;
}

function draftsOf(ctx: ReviewContext, taskId: string): DraftInfo[] {
  const now = ctx.clock.nowMs();
  const rows = proposedDraftsOf(ctx.db, taskId);
  const sendStates = draftSendStates(ctx.db, rows);
  return rows.map((row) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
    const preview = messagePreviewOf(payload);
    const text = preview === null ? null : (payload as { text: string }).text;
    return {
      seq: row.seq, tool: row.tool, action: row.action, target: row.target, payloadHash: row.payload_hash, expiresAt: row.expires_at, expired: Date.parse(row.expires_at) <= now,
      influenced: Number(row.influenced_by_external_input) === 1, preview, payload, body: text,
      maskedPaths: maskedPathsOf(payload, maskMessagePayload(payload)), sendState: sendStates.get(row.id) ?? 'none',
    };
  });
}

function taskInfo(ctx: ReviewContext, id: string): TaskInfo | null {
  const row = ctx.db.get<{ objective: string; spec: string; trigger_ref: string }>('SELECT objective, spec, trigger_ref FROM task WHERE id = ?', [id]);
  if (row === undefined || row.trigger_ref.startsWith(REGISTRATION_TRIGGER_PREFIX)) return null;
  const drafts = draftsOf(ctx, id);
  // 전송 여부 불명 효과가 있는 업무는 효과 확인 카드가 맡는다. 단, 초안 업무는 어느 초안이 나갔는지 보여 줘야 하므로 이 카드도 낸다
  if (drafts.length === 0 && ctx.db.get('SELECT 1 AS one FROM external_effect WHERE task_id = ? AND state = ?', [id, 'unknown']) !== undefined) return null;
  const spec = json(row.spec);
  const tools = arr(rec(spec)['allowed_tools']).map(rec);
  const customer = tools.some((t) => t['impact'] === 'external_effect' && t['scope'] === 'customer');
  const external = tools.some((t) => t['impact'] === 'external_effect');
  const reason = ctx.db.get<{ reason: string; at: string }>('SELECT reason, at FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [id]);
  const shown = shownOf(ctx, 'task', id);
  const denied = arr(shown?.['decisions']).some((d) => rec(d)['decision'] === 'deny');
  return {
    id, objective: row.objective, reason: reason?.reason ?? '', kind: customer ? 'customer' : external ? 'external' : 'plain',
    sig: tools.map((t) => `${str(t['tool'])}:${str(t['impact'])}:${str(t['scope'])}`).sort().join(','), waitingSince: reason?.at ?? null, denied, shown, spec,
    targets: [...new Set(tools.filter((t) => t['impact'] === 'external_effect').map((t) => str(t['target'])).filter((t) => t !== ''))],
    drafts,
  };
}

const TASK_CHECK = { customer: '받는 사람과 문구가 맞는지', external: '보내는 대상과 내용이 맞는지', plain: '업무 목표가 맞는지' } as const;
const TASK_RISK = { customer: '고객에게 실제로 전달되며 되돌릴 수 없습니다', external: '외부로 나가며 되돌리기 어렵습니다', plain: '내부 작업이라 되돌릴 수 있습니다' } as const;
const OUTSIDE = (kind: TaskInfo['kind']): boolean => kind !== 'plain';

// 초안이 있는 업무와 없는 업무는 한 장으로 묶지 않는다 (승인하는 것이 다르다)
// 가려진 값이 있거나 이미 나간 초안이 있는 업무는 할 수 있는 일이 달라서 따로 둔다
const draftClass = (info: TaskInfo): string => (info.drafts.length === 0 ? '' : `|drafts${isMasked(info) ? '-masked' : ''}${isSent(info) ? '-sent' : ''}`);
const groupId = (info: TaskInfo): string => createHash('sha256').update(`${info.reason}|${info.kind}|${info.sig}${draftClass(info)}`).digest('hex').slice(0, 12);

/** 엔진이 지금도 위임 승인을 유효로 세는 업무 (정지·철회·정책 변경이면 사람에게 돌아간다) */
const isDelegated = (info: TaskInfo): boolean => typeof obj(info.shown?.['approval'])['mandate_id'] === 'string';

export function taskGroups(ctx: ReviewContext): TaskInfo[][] {
  const groups = new Map<string, TaskInfo[]>();
  for (const task of pendingLists(ctx).lists.tasks) {
    const info = taskInfo(ctx, task.id);
    if (info === null || isDelegated(info)) continue; // AI가 이미 처리한 일은 결정할 일이 아니다: "AI가 처리함" 요약에만 보인다
    const gid = groupId(info);
    groups.set(gid, [...(groups.get(gid) ?? []), info]);
  }
  return [...groups.values()];
}

function waitDays(items: readonly TaskInfo[], now: number): number {
  const oldest = items.map((i) => i.waitingSince).filter((v): v is string => v !== null).sort()[0];
  return oldest === undefined ? 0 : Math.floor((now - Date.parse(oldest)) / DAY);
}
const waitingText = (items: readonly TaskInfo[], now: number): string => {
  const oldest = items.map((i) => i.waitingSince).filter((v): v is string => v !== null).sort()[0];
  return oldest === undefined ? '대기 중' : `${ago(oldest, now)}부터 대기`;
};
const specDetails = (items: readonly TaskInfo[]): Raw => h`${items.map((i) => h`<h2>${clip(i.objective, 50)} (원문)</h2><pre>${prettyJson(i.spec)}</pre>`)}`;

// ----- 초안 승인 업무 (ADR-0015): 화면에는 받는 사람 수·가린 주소·제목·본문만, 정확한 주소는 CLI show 에서 -----
const INFLUENCED = '외부 입력 영향 하에 작성됨';
const EXPIRED_HINT = '초안 기한이 지났습니다 — 다시 쓰게 해 주세요';
const MASKED_BADGE = '승인 불가 — 가려진 값이 있음';
const MASKED_HINT = '비밀값처럼 보이는 내용이 있어 사람이 전부 볼 수 없습니다. 다시 쓰게 해 주세요';
const SENT_HINT = '이미 나갔거나 전송 여부가 불명인 메일이 있어 거절·다시 쓰게를 할 수 없습니다. 전송 여부 카드에서 먼저 확인하세요';
const NO_PREVIEW = '내용 미리보기 없음 — 자세히에서 원문 확인';
const DRAFT_CHECK = '받는 사람과 문구가 이대로 나가도 되는지';
const UNSURE_HINT = '전송 여부가 불명인 메일이 있어 승인할 수 없습니다. 전송 여부 카드(/effects)에서 먼저 확인하세요';
const IRREVERSIBLE = '보내면 되돌릴 수 없음';

const isMasked = (info: TaskInfo): boolean => info.drafts.some((d) => d.maskedPaths.length > 0);
/** 엔진은 효과가 `planned` 를 넘은 초안이 있으면 변경 요청·거절을 거절한다 */
const isSent = (info: TaskInfo): boolean => info.drafts.some((d) => d.sendState !== 'none' && d.sendState !== 'planned');
const isExpired = (info: TaskInfo): boolean => info.drafts.some((d) => d.expired);

const SEND_WORD: Readonly<Partial<Record<DraftSendState, string>>> = {
  confirmed: '보냄', compensated: '보냄(이후 취소 처리됨)', dispatched: '전송 여부 불명', unknown: '전송 여부 불명', failed: '보내지 못함',
};
const sendWord = (d: DraftInfo): string | null => SEND_WORD[d.sendState] ?? null;

const allDrafts = (items: readonly TaskInfo[]): DraftInfo[] => items.flatMap((i) => i.drafts);
const uniqueRecipients = (drafts: readonly DraftInfo[]): string[] => [...new Set(drafts.flatMap((d) => d.preview?.recipients ?? []).map((r) => r.trim().toLowerCase()))];

/** 카드 「무엇」: 메일 모양 초안은 받는 사람 수·제목·첫 줄, 아니면 미리보기 없음 */
function draftSummary(drafts: readonly DraftInfo[]): string {
  const mails = drafts.filter((d) => d.preview !== null);
  const others = drafts.length - mails.length;
  if (mails.length === 0) return NO_PREVIEW;
  const recipients = uniqueRecipients(mails).length;
  const tail = others === 0 ? '' : ` · 그 밖 ${others}건은 미리보기 없음`;
  const subject = mails[0]!.preview!.subject;
  if (mails.length === 1) return `받는 사람 ${recipients}명 · 제목 '${clip(subject ?? '(제목 없음)', 30)}' · 첫 줄 ${clip(mails[0]!.preview!.firstLine ?? '(본문 없음)', 40)}${tail}`;
  return `메일 ${mails.length}통 · 받는 사람 모두 ${recipients}명 · 첫 제목 '${clip(subject ?? '(제목 없음)', 30)}'${tail}`;
}

const isUnsure = (d: DraftInfo): boolean => d.sendState === 'unknown' || d.sendState === 'dispatched';
const isPending = (d: DraftInfo): boolean => d.sendState === 'none' || d.sendState === 'planned';
const hasUnsure = (info: TaskInfo): boolean => info.drafts.some(isUnsure);

/** 이미 일부가 나간 업무의 「무엇」: 0 이 아닌 부분만 */
function sentSummary(drafts: readonly DraftInfo[], unit: string): string {
  const n = (f: (d: DraftInfo) => boolean): number => drafts.filter(f).length;
  return ([[n((d) => d.sendState === 'confirmed' || d.sendState === 'compensated'), '이미 나감'], [n(isUnsure), '전송 여부 불명'], [n((d) => d.sendState === 'failed'), '보내지 못함'], [n(isPending), '남은 초안']] as const)
    .filter(([count]) => count > 0).map(([count, what]) => `${what} ${count}${unit}`).join(' · ');
}

function draftNoun(items: readonly TaskInfo[]): string {
  const base = commonAffixes(items.map((i) => i.objective)).prefix || items[0]!.objective;
  return /^.*?메일/.exec(base)?.[0] ?? (items[0]!.kind === 'customer' ? '고객 메일' : '메일');
}

/** 질문: 메일 수(통)와 받는 사람 수로 말한다. 업무 수는 자세히에만 둔다 */
function draftQuestion(items: readonly TaskInfo[]): string {
  const unsure = allDrafts(items).filter(isUnsure).length;
  if (unsure > 0) return `메일 ${unsure}${countWord(items)}이 실제로 나갔는지 먼저 확인해 주세요`;
  if (items.some(isSent)) {
    const left = allDrafts(items).filter((d) => isPending(d) && d.preview !== null);
    return left.length === 0 ? '남은 메일이 없습니다 — 전송 결과를 확인해 주세요' : `남은 메일 ${left.length}통(받는 사람 ${uniqueRecipients(left).length}명)을 보낼까요?`;
  }
  const mails = allDrafts(items).filter((d) => d.preview !== null);
  if (mails.length === 0) return items.length === 1 ? `'${clip(items[0]!.objective, 30)}' — 이대로 보내도 될까요?` : `${batchName(items)} — 이대로 보내도 될까요?`;
  return `${clip(draftNoun(items), 24)} ${mails.length}통(받는 사람 ${uniqueRecipients(mails).length}명)을 보낼까요?`;
}

const countWord = (items: readonly TaskInfo[]): string => (allDrafts(items).every((d) => d.preview !== null) ? '통' : '건');

/** 카드 「위험·기한」: 한 줄에 둘까지 (되돌릴 수 없음 · 가장 가까운 기한). 막힌 이유가 있으면 그 이유가 먼저 나온다 */
function draftRisk(items: readonly TaskInfo[], now: number): string {
  const drafts = allDrafts(items);
  if (items.some(isMasked)) return MASKED_HINT;
  if (items.some(isSent)) {
    const count = (states: DraftSendState[]): number => drafts.filter((d) => states.includes(d.sendState)).length;
    const parts = [[count(['confirmed', 'compensated']), '이미 나간'], [count(['dispatched', 'unknown']), '전송 여부 불명'], [count(['failed']), '보내지 못한']] as const;
    const said = parts.filter(([n]) => n > 0).map(([n, what]) => `${what} ${n}${countWord(items)}`).join(', ');
    return `${said} · 전송 여부 카드에서 확인`;
  }
  const live = drafts.filter((d) => !d.expired).map((d) => d.expiresAt).sort()[0];
  if (live === undefined) return EXPIRED_HINT;
  return `${IRREVERSIBLE} · ${draftExpiry(live, now)}`;
}

type BadgeSpec = { label: string; tone: Tone };
function draftBadges(items: readonly TaskInfo[]): BadgeSpec[] {
  const out: BadgeSpec[] = [];
  const single = items.length === 1;
  const masked = items.filter(isMasked).length;
  if (masked > 0) out.push({ label: single ? MASKED_BADGE : `${MASKED_BADGE} (${masked}건)`, tone: 'bad' });
  const expired = allDrafts(items).filter((d) => d.expired).length;
  if (expired > 0) out.push(single ? { label: '승인 불가 — 초안 기한 지남', tone: 'bad' } : { label: `${expired}${countWord(items)} 기한 지남`, tone: 'warn' });
  const influenced = items.filter((i) => i.drafts.some((d) => d.influenced)).length;
  if (influenced > 0) out.push({ label: single ? INFLUENCED : `${INFLUENCED} (${influenced}건)`, tone: 'warn' });
  return out;
}

/** 상세: 초안마다 받는 사람(가림)·도메인별 수·제목·본문 전문. 정확한 주소는 싣지 않는다 */
const mailBadges = (d: DraftInfo): Raw => h`${d.expired ? h` <span class="badge bad">기한 지남</span>` : ''}${d.maskedPaths.length > 0 ? h` <span class="badge bad">가려진 값이 있음</span>` : ''}${isUnsure(d) ? h` <span class="badge warn">전송 여부 불명</span>` : ''}${d.influenced ? h` <span class="badge warn">${INFLUENCED}</span>` : ''}`;

function draftBody(info: TaskInfo, now: number): Raw {
  return h`<h2>보낼 내용</h2>${hasUnsure(info) ? h`<p><a href="/effects">전송 여부 카드로 이동</a></p>` : ''}<p class="mute">받는 사람은 주소를 가려 보여 줍니다. 정확한 주소는 화면에 내지 않습니다.</p>${mailSections(info, now)}`;
}

/** 묶음 상세: 업무마다 작은 제목 아래 그 업무의 메일을 모두 보여 준다 */
const batchBody = (items: readonly TaskInfo[], now: number): Raw => h`<h2>보낼 내용</h2>${items.some(hasUnsure) ? h`<p><a href="/effects">전송 여부 카드로 이동</a></p>` : ''}<p class="mute">받는 사람은 주소를 가려 보여 줍니다. 정확한 주소는 화면에 내지 않습니다.</p>${items.map((i) => h`<p><b>${clip(i.objective, 50)}</b> ${i.denied ? h`<span class="badge bad">정책 거부</span>` : ''}</p>${mailSections(i, now)}`)}`;

function mailSections(info: TaskInfo, now: number): Raw {
  const total = info.drafts.length;
  return h`${info.drafts.map((d, index) => {
    const heading = total === 1 ? '메일' : `메일 ${index + 1}/${total}`;
    const status = sendWord(d);
    const statusRows: [string, unknown][] = [...(status === null ? [] : [['전송 상태', status] as [string, unknown]]), ...(d.maskedPaths.length === 0 ? [] : [['가려진 값 위치', d.maskedPaths.join(', ')] as [string, unknown]])];
    if (d.preview === null) return h`<h3>${heading}${mailBadges(d)}</h3>${statusRows.length === 0 ? '' : kv(statusRows)}<p class="mute">메일 모양이 아닌 초안입니다. 원문을 그대로 보여 줍니다.</p><pre>${full(prettyJson(d.payload))}</pre>`;
    const domains = new Map<string, number>();
    for (const r of d.preview.recipients) domains.set(addressDomain(r), (domains.get(addressDomain(r)) ?? 0) + 1);
    const shownMax = 20;
    const masked = d.preview.recipients.slice(0, shownMax).map(maskAddress);
    return h`<h3>${heading}${mailBadges(d)}</h3>${kv([
      ...statusRows,
      ['받는 사람', `${d.preview.recipients.length}명 — ${masked.join(', ')}${d.preview.recipients.length > shownMax ? ` 외 ${d.preview.recipients.length - shownMax}명` : ''}`],
      ['도메인별', [...domains].map(([domain, n]) => `${domain} ${n}명`).join(', ')],
      ['제목', d.preview.subject ?? '(제목 없음)'],
      ['기한', draftExpiry(d.expiresAt, now)],
    ])}<pre>${full(d.body ?? '')}</pre>`;
  })}`;
}

const draftDetails = (items: readonly TaskInfo[]): Raw => h`${allDrafts(items).length === 0 ? '' : h`<h2>초안 상세 (원문)</h2>${table(['업무', '순번', '도구', '작업', '내용 해시(앞 12자)', '기한(원문)'], items.flatMap((i) => i.drafts.map((d) => [clip(i.objective, 30), d.seq, d.tool, d.action, d.payloadHash.slice(0, 12), d.expiresAt])))}`}`;

/** 초안 업무 한 건 또는 묶음의 결정. 같은 문구 규칙을 쓴다 */
function draftDecision(ctx: ReviewContext, items: TaskInfo[], now: number): Decision {
  const first = items[0]!;
  const single = items.length === 1;
  const gid = groupId(first);
  const stepLabel = (i: TaskInfo): string => clip(i.objective, 30);
  const approvable = items.filter((i) => !i.denied && !isExpired(i) && !isMasked(i) && !hasUnsure(i));
  const revisable = items.filter((i) => !isSent(i));
  const unit = countWord(items);
  const mailsIn = (list: readonly TaskInfo[]): number => allDrafts(list).length;
  const reasonNote = (): string => {
    const out = items.filter((i) => !approvable.includes(i));
    const part = (list: readonly TaskInfo[], what: string): string => (list.length === 0 ? '' : `${what} ${mailsIn(list)}${unit}`);
    const parts = [part(out.filter(isExpired), '기한 지난'), part(out.filter((i) => !isExpired(i) && isMasked(i)), '가려진 값이 있는'), part(out.filter((i) => !isExpired(i) && !isMasked(i) && hasUnsure(i)), '전송 여부 불명인'), part(out.filter((i) => !isExpired(i) && !isMasked(i) && !hasUnsure(i)), '정책이 거부한')].filter((x) => x !== '');
    return `${parts.join(', ')}은 빠졌습니다`;
  };
  const approve: Part = approvable.length === 0
    ? blockedPart('승인', items.some(isMasked) ? MASKED_HINT : items.some(isExpired) ? EXPIRED_HINT : items.some(hasUnsure) ? UNSURE_HINT : items.some(isSent) ? '이미 나간 메일이 있어 승인하지 않습니다 — 전송 여부 카드에서 먼저 확인하세요' : '현재 정책이 모두 거부합니다.')
    : approvePart(approvable.map((i) => approveStep('task', i.id, i.shown, stepLabel(i))), {
      label: single ? '승인' : approvable.length === items.length ? `메일 ${mailsIn(approvable)}${unit} 모두 승인 (업무 ${approvable.length}건)` : `보낼 수 있는 메일 ${mailsIn(approvable)}${unit} 승인 (업무 ${approvable.length}건)`,
      note: !single && approvable.length < items.length ? reasonNote() : items.some(isSent) ? '승인하면 남은 초안이 그대로 나갑니다' : '승인하면 위 내용이 그대로 나갑니다',
      done: '승인했습니다. 내용 그대로 나갑니다.',
    });
  const revisionSteps = (): Step[] => revisable.map((i) => ({ ...plainStep('reject', 'task', i.id, i.shown, stepLabel(i)) }));
  const rejectLabel = single ? '거절' : revisable.length === items.length ? `메일 ${mailsIn(revisable)}${unit} 모두 거절` : `메일 ${mailsIn(revisable)}${unit} 거절 (이미 나간 업무는 제외)`;
  const changesLabel = single ? '다시 쓰게' : revisable.length === items.length ? `메일 ${mailsIn(revisable)}${unit} 모두 다시 쓰게` : `메일 ${mailsIn(revisable)}${unit} 다시 쓰게 (이미 나간 업무는 제외)`;
  const actions = actionsOf(undefined,
    approve,
    revisable.length === 0 ? blockedPart('거절', SENT_HINT) : rejectPart(revisionSteps(), { label: rejectLabel }),
    revisable.length === 0 ? blockedPart('다시 쓰게', SENT_HINT) : changesPart(revisable.map((i) => changesStep(i.id, i.shown, stepLabel(i))), changesLabel));
  const waiting = waitingText(items, now);
  const handedBack = single ? handedBackReason(ctx, first.id, false) : null;
  const mailsOnly = allDrafts(items).filter((d) => d.preview !== null).length;
  return {
    key: single ? `task:${first.id}` : `batch:${gid}`, category: 'outside', first: true,
    href: single ? `/approvals/task/${encodeURIComponent(first.id)}` : `/batch/${gid}`,
    question: approvable.length === 0 && revisable.length > 0 && items.some(isMasked) ? `'${clip(draftNoun(items), 24)}'에 가려진 값이 있어요. 다시 쓰게 할까요?`
      : approvable.length === 0 && revisable.length > 0 && items.some(isExpired) ? `기한이 지난 메일 ${mailsIn(items.filter(isExpired))}${unit} — 다시 쓰게 할까요?` : draftQuestion(items),
    facts: [['무엇', items.some(hasUnsure) || (items.some(isSent) && allDrafts(items).every((d) => !isPending(d))) ? sentSummary(allDrafts(items), countWord(items)) : draftSummary(items.some(isSent) ? allDrafts(items).filter(isPending) : allDrafts(items))], handedBack === null ? ['확인할 것', DRAFT_CHECK] : ['AI가 넘긴 이유', handedBack], ['위험·기한', draftRisk(items, now)]],
    ...(first.denied && single ? { badge: { label: '승인 불가 — 정책 거부', tone: 'bad' as const } } : {}),
    badges: draftBadges(items),
    body: single ? draftBody(first, now) : batchBody(items, now),
    history: single ? taskHistory(ctx, first.id) : [],
    urgency: Date.parse(allDrafts(items).map((d) => d.expiresAt).sort()[0]!), actions,
    details: single
      ? h`${kv([['목표', first.objective], ['대기', waiting], ['엔진 원문(전이 사유)', first.reason], ['업무 id', first.id]])}${draftDetails(items)}${specDetails(items)}
      <h2>정책 판정 (원문)</h2>${table(['작업', '자원', '범위', '영향', '판정', '이유'], arr(first.shown?.['decisions']).map(rec).map((d) => [d['action'], d['resource'], d['scope'], d['impact'], d['decision'], d['reason']]))}`
      : h`${kv([['묶인 업무', `${items.length}건 (메일 ${mailsOnly}통)`], ['대기', waiting], ['엔진 원문(전이 사유)', first.reason]])}<h2>건별 내용</h2>${items.map((i) => h`<h3>${clip(i.objective, 50)}</h3>${link(['approvals', 'task', i.id], '이 업무의 메일 내용을 보고 따로 결정하기')}${i.denied ? h`<p class="mute">정책이 거부해 승인할 수 없습니다.</p>` : isMasked(i) ? h`<p class="mute">${MASKED_HINT}</p>` : isExpired(i) ? h`<p class="mute">${EXPIRED_HINT}</p>` : ''}${isSent(i) ? h`<p class="mute">${SENT_HINT}</p>` : ''}`)}${draftDetails(items)}${specDetails(items)}`,
  };
}

export function taskDecision(ctx: ReviewContext, info: TaskInfo): Decision {
  const now = ctx.clock.nowMs();
  if (info.drafts.length > 0) return draftDecision(ctx, [info], now);
  const label = clip(info.objective, 30);
  const actions = info.denied
    ? actionsOf(undefined, blockedPart('승인', '현재 정책이 거부하는 작업이라 승인해도 실행되지 않습니다.'), rejectPart([plainStep('reject', 'task', info.id, info.shown, label)]))
    : actionsOf(undefined, approvePart([approveStep('task', info.id, info.shown, label)]), rejectPart([plainStep('reject', 'task', info.id, info.shown, label)]));
  const where = info.targets.length === 0 ? '' : ` → ${info.targets.join(', ')}`;
  return {
    key: `task:${info.id}`, category: OUTSIDE(info.kind) ? 'outside' : 'other', first: OUTSIDE(info.kind) || waitDays([info], now) >= 1,
    href: `/approvals/task/${encodeURIComponent(info.id)}`,
    question: `'${clip(info.objective, 30)}' — ${OUTSIDE(info.kind) ? '실행해도 될까요?' : '진행해도 될까요?'}`,
    facts: [
      ['무엇', OUTSIDE(info.kind) ? `'${clip(info.objective, 40)}'${where}${info.kind === 'customer' ? ' (고객에게 전달)' : ''}` : `'${clip(info.objective, 40)}' 업무를 실행합니다`],
      ['확인할 것', `${TASK_CHECK[info.kind]} — 내용 미리보기 없음, 자세히에서 원문 확인`],
      ['위험·기한', `${TASK_RISK[info.kind]} · ${waitingText([info], now)}`],
    ],
    ...(info.denied ? { badge: { label: '승인 불가 — 정책 거부', tone: 'bad' as const } } : {}),
    urgency: now, actions, history: taskHistory(ctx, info.id),
    details: h`${kv([['목표', info.objective], ['엔진 원문(전이 사유)', info.reason], ['업무 id', info.id]])}${specDetails([info])}
      <h2>정책 판정 (원문)</h2>${table(['작업', '자원', '범위', '영향', '판정', '이유'], arr(info.shown?.['decisions']).map(rec).map((d) => [d['action'], d['resource'], d['scope'], d['impact'], d['decision'], d['reason']]))}`,
  };
}

/** 묶음 이름: 업무 목표의 공통 앞·뒤("고객 안내 메일 초안 3건 발송"), 없으면 첫 목표 + "외 N건" */
function batchName(items: readonly TaskInfo[]): string {
  const { prefix, suffix } = commonAffixes(items.map((i) => i.objective));
  if (prefix === '') return `'${clip(items[0]!.objective, 24)}' 외 ${items.length - 1}건`;
  return `${clip(prefix, 24)} ${items.length}건${suffix === '' ? '' : ` ${clip(suffix, 10)}`}`;
}
const batchTitle = (items: readonly TaskInfo[]): string => `${eulReul(batchName(items))} 승인할까요?`;

export function batchDecision(ctx: ReviewContext, items: TaskInfo[]): Decision {
  const now = ctx.clock.nowMs();
  const first = items[0]!;
  if (first.drafts.length > 0) return draftDecision(ctx, items, now);
  const gid = groupId(first);
  const allowed = items.filter((i) => !i.denied);
  const stepLabel = (i: TaskInfo): string => clip(i.objective, 30);
  const targets = [...new Set(items.flatMap((i) => i.targets))];
  return {
    key: `batch:${gid}`, category: OUTSIDE(first.kind) ? 'outside' : 'other', first: OUTSIDE(first.kind) || waitDays(items, now) >= 1, href: `/batch/${gid}`,
    question: batchTitle(items),
    lead: `같은 사유로 멈춘 업무 ${items.length}건입니다. 한 번에 처리하거나 자세히에서 건별로 처리합니다.`,
    facts: [
      ['무엇', `${batchName(items)}${targets.length === 0 ? '' : ` → ${targets.join(', ')}`}${first.kind === 'customer' ? ' (고객에게 전달)' : ''}`],
      ['확인할 것', `${TASK_CHECK[first.kind]} — 내용 미리보기 없음, 자세히에서 원문 확인`],
      ['위험·기한', `${TASK_RISK[first.kind]} · ${waitingText(items, now)}`],
    ],
    urgency: now,
    actions: actionsOf(undefined,
      allowed.length === 0 ? blockedPart('승인', '현재 정책이 모두 거부합니다.') : approvePart(allowed.map((i) => approveStep('task', i.id, i.shown, stepLabel(i))), { label: `${allowed.length}건 모두 승인` }),
      rejectPart(items.map((i) => plainStep('reject', 'task', i.id, i.shown, stepLabel(i))), { label: `${items.length}건 모두 거절` })),
    details: h`${kv([['엔진 원문(전이 사유)', first.reason]])}<h2>건별 내용</h2>${items.map((i) => h`<h3>${clip(i.objective, 50)}</h3>${link(['approvals', 'task', i.id], '이 업무만 따로 결정하기')}${i.denied ? h`<p class="mute">정책이 거부해 승인할 수 없습니다.</p>` : ''}`)}${specDetails(items)}`,
  };
}

// ----- 게시 · 정책 · 전략 -----
const AUDIENCE = { public: '누구나 볼 수 있게', customer: '고객에게', internal: '내부에서만' } as const;

export function publicationDecision(ctx: ReviewContext, id: string): Decision | null {
  const row = ctx.db.get<{ channel: string; audience: string; content_ref: string }>('SELECT channel, audience, content_ref FROM publication WHERE id = ?', [id]);
  if (row === undefined) return null;
  const shown = shownOf(ctx, 'publication', id);
  const who = AUDIENCE[row.audience as keyof typeof AUDIENCE] ?? '바깥에';
  // 내용 미리보기: 호스트 근거 저장소의 본문이면 앞 두 줄, 아니면 참조 글자 그대로
  const view = row.content_ref.startsWith('blob:') ? readEvidence({ ref: row.content_ref, content_hash: null }, { evidenceDir: ctx.evidenceDir, roots: ctx.roots }) : null;
  const lines = view?.kind === 'text' ? view.text.split('\n').map((l) => l.trim()).filter((l) => l !== '') : [];
  const title = lines[0]?.replace(/^제목\s*[:：]\s*/, '') ?? '';
  const preview = lines.slice(1, 3).join(' / ');
  const outside = row.audience !== 'internal';
  return {
    key: `publication:${id}`, category: 'outside', first: outside, href: `/approvals/publication/${encodeURIComponent(id)}`,
    question: title === '' ? `게시물을 ${who} 공개할까요?` : `'${clip(title, 24)}' 게시물을 ${who} 공개할까요?`,
    facts: [
      ['무엇', title === '' ? '내용 미리보기 없음 — 자세히에서 원문 확인' : `${clip(title, 40)}${preview === '' ? '' : ` — ${clip(preview, 70)}`}`],
      ['확인할 것', outside ? '공개해도 되는 내용인지' : '게시할 내용이 맞는지'],
      ['위험·기한', outside ? `${who} 공개되면 되돌리기 어렵습니다` : '내부용이라 영향이 작습니다'],
    ],
    urgency: ctx.clock.nowMs(), history: subjectHistory(ctx, 'publication', id),
    actions: actionsOf(undefined, approvePart([approveStep('publication', id, shown, '게시물')], { done: '승인했습니다. 게시됩니다.' }), rejectPart([plainStep('reject', 'publication', id, shown, '게시물')])),
    details: h`${view?.kind === 'text' ? h`<h2>본문 (원문)</h2><pre>${view.text}</pre>` : ''}${kv([['채널', row.channel], ['대상', row.audience], ['내용 위치', row.content_ref], ['게시 id', id]])}`,
  };
}

const DECISION_LABEL: Readonly<Record<string, string>> = { allow: '허용', deny: '거부', require_approval: '사람 승인 필요' };
const LIMIT_LABEL: Readonly<Record<string, string>> = { max_usd_per_task: '업무 하나당 비용 한도(USD)', max_tokens_per_task: '업무 하나당 토큰 한도' };

/** 현재 정책과 제안된 정책의 차이를 사람 말로 (최대 몇 줄이든 반환, 첫 화면은 3줄까지) */
function policyChanges(ctx: ReviewContext, id: string): string[] | null {
  const hash = ctx.db.get<{ subject_hash: string | null }>("SELECT subject_hash FROM approval WHERE subject_kind = 'policy_version' AND subject_id = ? AND decision = 'approved' ORDER BY at DESC, rowid DESC LIMIT 1", [id])?.subject_hash;
  const next = hash === undefined || hash === null ? null : ctx.store.byHash(hash);
  const current = ctx.store.active(ctx.db)?.policy ?? null;
  if (next === null || current === null) return null;
  const out: string[] = [];
  const a = current.document;
  const b = next.document;
  for (const key of new Set([...Object.keys(a.limits), ...Object.keys(b.limits)])) {
    const before = (a.limits as unknown as Record<string, unknown>)[key];
    const after = (b.limits as unknown as Record<string, unknown>)[key];
    if (before !== after) out.push(`${LIMIT_LABEL[key] ?? key}: ${before === undefined ? '없음' : num(before)} → ${after === undefined ? '없음' : num(after)}`);
  }
  const rulesA = new Map(a.rules.map((r) => [r.id, r]));
  const rulesB = new Map(b.rules.map((r) => [r.id, r]));
  for (const [ruleId, rule] of rulesB) {
    const old = rulesA.get(ruleId);
    if (old === undefined) out.push(`새 규칙 '${ruleId}': ${DECISION_LABEL[rule.decision] ?? rule.decision}`);
    else if (JSON.stringify(old) !== JSON.stringify(rule)) out.push(`규칙 '${ruleId}' 변경: ${DECISION_LABEL[old.decision] ?? old.decision} → ${DECISION_LABEL[rule.decision] ?? rule.decision}`);
  }
  for (const ruleId of rulesA.keys()) if (!rulesB.has(ruleId)) out.push(`규칙 '${ruleId}' 삭제`);
  if (JSON.stringify(a.risky_change) !== JSON.stringify(b.risky_change)) out.push('위험 변경 승인 절차(승인 인원·대기 시간)가 바뀝니다');
  return out;
}

export function policyDecision(ctx: ReviewContext, id: string): Decision | null {
  const shown = shownOf(ctx, 'policy_version', id);
  if (shown === null) return null;
  const risky = shown['change_class'] === 'risky';
  const state = stateOf(shown);
  const changes = policyChanges(ctx, id);
  const cancelStep = plainStep('cancel', 'policy_version', id, shown, '정책 변경');
  const actions = state === 'cooldown'
    ? actionsOf(undefined, blockedPart('OTP 확인', '이미 승인했고 대기 시간 중입니다.'), cancelPart([cancelStep]))
    : actionsOf(undefined, otpPart([plainStep('release', 'policy_version', id, shown, '정책 변경')], `대기가 끝난 위험 변경만 ${OTP_AGAIN}하면 배포됩니다`), cancelPart([cancelStep]));
  const summary = changes === null ? '바뀌는 내용을 읽을 수 없음 — 자세히에서 원문 확인' : changes.length === 0 ? '현재 정책과 같은 내용' : changes.slice(0, 3).join(' · ');
  return {
    key: `policy:${id}`, category: 'other', first: false, href: `/approvals/policy_version/${encodeURIComponent(id)}`,
    question: '정책 변경을 배포할까요?', ...(changes === null || changes.length === 0 ? {} : { lead: `정책이 이렇게 바뀝니다: ${changes.slice(0, 2).join(', ')}${changes.length > 2 ? ` 외 ${changes.length - 2}건` : ''}.` }),
    facts: [['무엇', summary], ['확인할 것', '바뀌는 규칙이 의도한 것인지'], ['위험·기한', risky ? `위험 변경 — 대기 시간 뒤 ${OTP_AGAIN}해야 합니다` : '일반 변경']],
    urgency: ctx.clock.nowMs() + 20 * DAY, actions, history: subjectHistory(ctx, 'policy_version', id),
    details: h`${changes === null ? '' : h`<h2>바뀌는 내용</h2>${list(changes)}`}${kv([['변경 등급(원문)', str(shown['change_class'])], ['사유(원문)', arr(shown['reasons']).map(str).join(' / ')], ['승인 단계(원문)', str(obj(shown['approval'])['reason'])], ['제안 id', id]])}`,
  };
}

export function strategyDecision(ctx: ReviewContext, id: string): Decision | null {
  const row = ctx.db.get<{ title: string; body: string; experiment_scope: string | null }>('SELECT title, body, experiment_scope FROM strategy_version WHERE id = ?', [id]);
  if (row === undefined) return null;
  const shown = shownOf(ctx, 'strategy_version', id);
  const running = arr(shown?.['experiments_in_progress']).map(str);
  const scope = row.experiment_scope === null ? null : json(row.experiment_scope);
  return {
    key: `strategy:${id}`, category: 'experiment', first: false, href: `/approvals/strategy_version/${encodeURIComponent(id)}`,
    question: `'${clip(row.title, 30)}' 실험을 시작할까요?`, lead: clip(row.body, 120),
    facts: [
      ['무엇', `'${clip(row.title, 40)}' 실험을 시작하고 실험 범위 안에서 주간 루틴을 켭니다`],
      ['확인할 것', '가설과 실험 범위가 맞는지'],
      ['위험·기한', '실험 범위를 벗어나는 일은 하지 않습니다. 한 번에 하나만 진행됩니다'],
    ],
    ...(running.length > 0 ? { badge: { label: '승인 불가 — 진행 중인 실험 있음', tone: 'bad' as const } } : {}),
    urgency: ctx.clock.nowMs() + 20 * DAY,
    history: subjectHistory(ctx, 'strategy_version', id),
    actions: actionsOf(undefined,
      running.length > 0 ? blockedPart('승인', '이미 진행 중인 실험이 있어 한 번에 하나만 승인할 수 있습니다.') : approvePart([approveStep('strategy_version', id, shown, `'${clip(row.title, 24)}' 실험`)], { done: '승인했습니다. 실험이 시작됩니다.' }),
      rejectPart([plainStep('reject', 'strategy_version', id, shown, `'${clip(row.title, 24)}' 실험`)])),
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
    key: `product:${slug}`, category: 'product', first: false, href: `/products/${encodeURIComponent(slug)}`,
    question: `상품 '${clip(product.name, 24)}'을 등록할까요?`,
    facts: [
      ['무엇', `'${clip(product.name, 30)}'을 정식 상품으로 등록합니다`],
      ['확인할 것', `${SHADOW_LABEL[verdict] ?? (evaluation === null ? '독립 평가가 아직 없습니다' : passed ? '독립 평가 통과' : '독립 평가 미통과')} · 증거 ${view.evidence.length}건 중 ${confirmed}건 확인됨${external > 0 ? `, 외부 입력 ${external}건 포함` : ''}`],
      ['위험·기한', '등록하면 이 상품을 대상으로 한 업무를 만들 수 있습니다'],
    ],
    badge: blocked !== null || !passed ? { label: '검증 실패 — 승인 불가', tone: 'bad' } : { label: '검증 통과', tone: 'ok' },
    urgency: ctx.clock.nowMs(),
    history: subjectHistory(ctx, 'product', product.id, productLinks(ctx, product.id)),
    actions: actionsOf(undefined,
      blocked !== null ? blockedPart('승인', `${BLOCK[blocked.code] ?? '승인할 수 없는 상태입니다'}. 반려하거나 다시 검증해 주세요.`)
        : view.review_hash === null ? blockedPart('승인', NO_HASH)
          : approvePart([{ label: `상품 '${clip(product.name, 24)}'`, request: { cmd: 'product', op: 'decide', slug, decision: 'approve', hash: view.review_hash }, hash: view.review_hash }], { note: '아래 증거를 읽은 뒤', done: '상품 등록을 승인했습니다.' }),
      rejectPart([{ label: `상품 '${clip(product.name, 24)}'`, request: { cmd: 'product', op: 'decide', slug, decision: 'reject' }, hash: null }], { label: '반려', reason: 'required', reasonLabel: '반려 이유 (필수)', done: '반려했습니다.' }),
      { buttons: [{ verb: 'restart', label: '다시 검증', tone: 'ch', steps: [{ label: `상품 '${clip(product.name, 24)}'`, request: { cmd: 'product', op: 'restart', slug }, hash: null }], reason: 'required', reasonLabel: '다시 검증하는 이유 (필수)', collapse: true, note: '수정한 코드로 다시 검증하려면', done: '다시 검증을 시작했습니다.' }] }),
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
  const objectiveOf = (taskId: string): string => ctx.db.get<{ objective: string }>('SELECT objective FROM task WHERE id = ?', [taskId])?.objective ?? '작업';
  const objectives = [...new Set(effects.map((e) => objectiveOf(e.taskId)))];
  const name = objectives.length === 1 ? `'${clip(objectives[0]!, 28)}'` : `'${clip(objectives[0]!, 22)}' 외 ${objectives.length - 1}개 작업`;
  const targets = [...new Set(effects.map((e) => e.target))];
  const usable = effects.filter((e) => !e.runActive && !e.resolvedBefore);
  const effectStep = (e: (typeof effects)[number], outcome: 'confirmed' | 'failed'): Step => ({ label: `${clip(e.target, 40)}`, request: { cmd: 'resolve-effect', effect_id: e.effectId, outcome }, hash: null, textField: 'note' });
  return {
    key: 'effects', category: 'outside', first: true, href: '/effects',
    question: `${name} 전송 여부 ${effects.length}건 — 실제로 나갔나요?`,
    facts: [
      ['무엇', `${name} 작업의 ${effects.length}건이 ${targets.join(', ')} 에 도착했는지 시스템이 모릅니다`],
      ['확인할 것', '받는 쪽(수신함 등)에서 실제로 도착했는지'],
      ['위험·기한', `잘못 답하면 같은 내용이 두 번 나가거나 아예 안 나갑니다 · ${ago(oldest, now)}부터 대기`],
    ],
    urgency: now,
    actions: usable.length === 0 ? actionsOf(undefined, blockedPart('확인', '지금은 확인할 수 없습니다 (실행 중이거나 이미 한 번 확인됨).')) : actionsOf(undefined,
      { buttons: [{ verb: 'confirmed', label: usable.length > 1 ? `${usable.length}건 모두 나갔다고 확인` : '나갔다고 확인', tone: 'yes', steps: usable.map((e) => effectStep(e, 'confirmed')), reason: 'required', reasonLabel: '확인한 내용 (필수)', note: '받는 쪽을 직접 확인한 뒤', done: '나갔다고 기록했습니다.' }] },
      usable.length > 1 ? blockedPart('나가지 않았다고 확인', '"나가지 않았다"는 OTP 코드가 필요해 한 건씩 처리합니다. 하나씩 보려면 자세히를 여세요.')
        : { buttons: [{ verb: 'failed', label: '나가지 않았다고 확인', tone: 'no', steps: [effectStep(usable[0]!, 'failed')], reason: 'required', reasonLabel: '확인한 내용 (필수)', otp: true, note: '이후 재전송은 정책 판정을 거칩니다', done: '나가지 않았다고 기록했습니다.' }] }),
    details: h`<h2>건별 상태</h2>${effects.map((e) => h`<h3>${e.tool} · ${e.action} → ${clip(e.target, 50)}</h3>${e.runActive || e.resolvedBefore ? h`<p class="mute">${e.runActive ? '실행 중인 작업이 있어 지금은 확인할 수 없습니다.' : '이미 한 번 확인된 건이라 다시 확인할 수 없습니다.'}</p>` : h`<p class="mute">확인할 수 있습니다.</p>`}`)}
      <h2>효과 목록 (원문)</h2>${table(['효과', '도구', '대상', '업무 상태', '재전송 허가'], effects.map((e) => [e.effectId, `${e.tool} ${e.action}`, e.target, e.taskStatus, e.supportsIdempotency ? (e.resendWindowOpen ? '가능' : '불가(보존 기간 지남)') : '지원 안 함']))}`,
  };
}

// ----- 실험 결과 -----
export function experimentDecisions(ctx: ReviewContext): Decision[] {
  const reviews = listExperimentReviews(ctx.db);
  const title = (id: string): string => ctx.db.get<{ title: string }>('SELECT title FROM strategy_version WHERE id = ?', [id])?.title ?? id;
  // 엔진이 낡은 화면을 막도록 지금 해시를 싣는다 (실험 승격·거절도 expected_hash 를 대조한다)
  const hashFor = (id: string): string | null => hashOf(shownOf(ctx, 'strategy_version', id));
  const out: Decision[] = [];
  for (const e of reviews.awaitingPromotion) {
    out.push({
      key: `promote:${e.strategyVersionId}`, category: 'experiment', first: false, href: `/experiments/${encodeURIComponent(e.strategyVersionId)}`,
      question: `'${clip(title(e.strategyVersionId))}' 실험이 목표를 넘겼습니다. 정식 전략으로 올릴까요?`,
      facts: [['무엇', '이 실험을 정식 전략으로 올립니다 (이전 정식 전략은 보관 처리)'], ['확인할 것', '실험 결과가 목표를 넘겼는지'], ['위험·기한', `실험 비용 $${num(e.totalCostUsd)} · 승격 뒤에도 되돌릴 수 있습니다`]],
      badge: { label: '검증 통과', tone: 'ok' }, urgency: ctx.clock.nowMs(),
      actions: actionsOf(undefined,
        { buttons: [{ verb: 'promote', label: '정식 전략으로 올리기', tone: 'yes', steps: [{ label: `'${clip(title(e.strategyVersionId), 24)}'`, request: { cmd: 'promote', kind: 'strategy_version', id: e.strategyVersionId }, hash: hashFor(e.strategyVersionId) }], reason: 'required', reasonLabel: '올리는 이유 (필수)', done: '정식 전략으로 올렸습니다.' }] },
        rejectPart([{ label: `'${clip(title(e.strategyVersionId), 24)}'`, request: { cmd: 'reject', kind: 'strategy_version', id: e.strategyVersionId }, hash: hashFor(e.strategyVersionId) }], { label: '올리지 않기', reason: 'required', reasonLabel: '올리지 않는 이유 (필수)', done: '정식 전략으로 올리지 않았습니다.' })),
      history: subjectHistory(ctx, 'strategy_version', e.strategyVersionId),
      details: kv([['실험 비용(USD)', num(e.totalCostUsd)], ['평가 id', e.evaluationId], ['전략 id', e.strategyVersionId]]),
    });
  }
  for (const e of reviews.needsHuman) {
    out.push({
      key: `needs:${e.strategyVersionId}`, category: 'experiment', first: false, href: `/experiments/${encodeURIComponent(e.strategyVersionId)}`,
      question: `'${clip(title(e.strategyVersionId))}' 실험 결과를 판정하지 못했습니다. 이 실험을 끝낼까요?`,
      facts: [['무엇', '이 실험을 끝냅니다 (결과 기록은 남기지 않음)'], ['확인할 것', '증거가 부족해 결과를 가릴 수 없다는 판단에 동의하는지'], ['위험·기한', '끝내면 같은 실험을 다시 승인받아야 합니다']],
      badge: { label: '판정 보류', tone: 'warn' }, urgency: ctx.clock.nowMs() + DAY,
      actions: actionsOf(undefined, rejectPart([{ label: `'${clip(title(e.strategyVersionId), 24)}'`, request: { cmd: 'reject', kind: 'strategy_version', id: e.strategyVersionId }, hash: hashFor(e.strategyVersionId) }], { label: '실험 끝내기', reason: 'required', reasonLabel: '끝내는 이유 (필수)', note: '그대로 두면 계속 대기합니다', done: '실험을 끝냈습니다.' })),
      history: subjectHistory(ctx, 'strategy_version', e.strategyVersionId),
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
    row, roleSlugs: rolesOf(row).map(roleLabel), verdict, reason, metrics,
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
  const common = { category: 'org' as const, first: false, urgency: ctx.clock.nowMs() + 2 * DAY, href: `/trials/${encodeURIComponent(row.id)}` };
  const detail = trialDetails(ctx, t);
  if (row.status === 'trial' && t.latest === 'pass') {
    return {
      ...common, key: `confirm:${row.id}`, question: `${slugs} 시험이 통과했습니다. 정식 확정할까요?`, lead: trialLine(t),
      facts: [['무엇', '시험 중인 역할을 정식 조직으로 확정합니다'], ['확인할 것', '시험 결과(통과율·관측 수)가 충분한지'], ['위험·기한', '확정하면 시험 범위 제한이 풀립니다 (이후 되돌리기 가능)']],
      badge: { label: '검증 통과', tone: 'ok' },
      history: subjectHistory(ctx, 'org_proposal', row.id),
      actions: actionsOf(h`<p class="mute">확정하지 않으면 시험 상태로 남습니다.</p>`,
        { buttons: [{ verb: 'confirm', label: '정식 확정', tone: 'yes', steps: [{ label: slugs, request: { cmd: 'org', op: 'confirm', id: row.id }, hash: null }], reason: 'required', reasonLabel: '확정하는 이유 (필수)', done: '정식 조직으로 확정했습니다.' }] }), details: detail,
    };
  }
  if (row.status === 'inconclusive') {
    return {
      ...common, key: `retrial:${row.id}`, question: `${slugs} 시험은 관측이 부족했습니다. 한 번 더 시험할까요?`, lead: trialLine(t),
      facts: [['무엇', '새 평가 계획으로 시험을 한 번 더 진행합니다'], ['확인할 것', '업무가 더 쌓일 때까지 기다릴 만한지'], ['위험·기한', `재시험은 제안당 1회까지입니다 (지금까지 ${row.trial_extensions}회)`]],
      badge: { label: '판정 보류', tone: 'warn' },
      history: subjectHistory(ctx, 'org_proposal', row.id),
      actions: actionsOf(h`${NOT_HERE('재시험에는 새 평가 계획 파일이 필요합니다.')}<p class="mute">재시험하지 않으면 판정 불충분 상태로 남습니다.</p>`), details: detail,
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
    body: h`${t.endsAt === null ? '' : h`<p class="mute">${until(t.endsAt, ctx.clock.nowMs(), '판정')} (${monthDay(t.endsAt)})</p>`}${chart}${decision === null ? h`<p class="mute">지금은 할 일이 없습니다. 판정이 나면 결정할 일에 올라옵니다.</p>` : h`${historyList(decision.history)}${renderActions(ctx, decision.key, decision.actions)}`}<details><summary>자세히</summary>${decision?.details ?? trialDetails(ctx, t)}</details>`,
  };
}

// ----- 조직 신호 -----
export function signalDecisions(ctx: ReviewContext): Decision[] {
  const signals = orgSignals(ctx.db, ctx.clock) as { window_days: number; unassigned: { task_type: string; count: number; candidate: boolean }[] };
  const covered = new Set(ctx.db.all<{ trial_scope: string }>("SELECT trial_scope FROM org_proposal WHERE status IN ('proposed', 'approved', 'trial', 'inconclusive')")
    .flatMap((r) => arr(rec(json(r.trial_scope))['task_types']).map(str)));
  return signals.unassigned.filter((s) => s.candidate && !covered.has(s.task_type)).map((s) => ({
    key: `signal:${s.task_type}`, href: `/signals/${encodeURIComponent(s.task_type)}`,
    category: 'org' as const, first: false,
    question: `'${s.task_type}' 업무 ${s.count}건이 맡을 역할이 없어 멈췄습니다 — 새 역할 제안서를 만들까요?`,
    facts: [['무엇', `이 업무를 맡을 새 역할의 제안서 초안을 만듭니다 (최근 ${signals.window_days}일 ${s.count}건)`], ['확인할 것', '이 업무를 새 역할에 맡길 필요가 있는지'], ['위험·기한', '제안서만 만들어지고 아무것도 바뀌지 않습니다. 승인은 따로 합니다']],
    urgency: ctx.clock.nowMs() + 25 * DAY,
    actions: actionsOf(h`${NOT_HERE('새 역할의 이름(slug)을 직접 정해야 합니다.')}<p class="mute">그대로 두면 이 업무는 계속 멈춰 있습니다.</p>`),
    details: h`<p>맡을 역할이 없어 멈춘 업무 유형 '${s.task_type}' (최근 ${signals.window_days}일 ${s.count}건). 기준은 3건 이상입니다.</p>`,
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
      lines.push({ text: `${rolesOf(row).map((r) => `'${roleLabel(r)}'`).join(', ')} 승인됨 — 시험 시작 대기` });
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
  for (const r of problems) {
    const desc = ctx.db.get<{ description: string }>('SELECT description FROM role WHERE slug = ?', [r.role])?.description ?? r.role;
    lines.push({ text: `'${clip(desc, 24)}'${desc.endsWith('역할') ? '' : ' 역할'} — 최근 사람 확인 필요 ${r.needs_review}건·실패 ${r.failed}건이 반복됩니다` });
  }
  return lines;
}

/** 결정 키(`task:<id>`·`batch:<묶음>`·`org:<id>` …)로 지금의 결정을 DB 에서 다시 만든다. 폼 전송 때 서버가 "무엇을 보낼지"를 정하는 유일한 길이다 */
export function resolveDecision(ctx: ReviewContext, key: string): Pick<Decision, 'actions' | 'href'> | undefined {
  if (key.startsWith(DELEGATED_KEY)) return { actions: delegatedActions(ctx, key.slice(DELEGATED_KEY.length)), href: '/delegated' };
  if (key === CONTROL_KEY) return { actions: controlActions(ctx), href: '/delegated' };
  if (key.startsWith('task:')) {
    const id = key.slice('task:'.length);
    const group = taskGroups(ctx).flat().find((i) => i.id === id);
    return group === undefined ? undefined : taskDecision(ctx, group);
  }
  if (key.startsWith('batch:')) {
    const group = taskGroups(ctx).find((items) => items.length > 1 && batchDecision(ctx, items).key === key);
    return group === undefined ? undefined : batchDecision(ctx, group);
  }
  return buildInbox(ctx).decisions.find((d) => d.key === key);
}
