// AI가 대신 결정한 일의 요약 (설계 docs/plans/decision-delegation.md §3.6, 트랙 C). 결정이 아니라 *요약*이다: 위임된 일은 "결정할 일"에 올라오지 않고 여기에만 보인다.
// 읽기: `approval.mandate_id`(위임 승인 행), `delegate_review`(사람에게 넘긴 이유), 엔진 `show`(지금도 위임 승인이 유효한가·언제 나가나), 엔진 `delegation status`(정지 여부) — 모두 읽기 전용이다.
// 쓰기: 취소(`cancel`)와 위임 멈추기·다시 켜기(`delegation pause|resume`)는 다른 결정과 똑같이 화면 버튼 → 소켓 → 엔진이다(decide.ts). 이 파일은 버튼이 보낼 요청을 데이터로 만들어 둘 뿐이다.
// 첫 화면에는 id·해시·상태 코드·ISO 시각·엔진 영어 문장을 내지 않는다.
import { messagePreviewOf } from '@aot/domain';

import { buttonForm, type Actions, type Button } from './actions.ts';
import type { ReviewContext } from './context.ts';
import { ago, clip, maskAddress } from './format.ts';
import { h, link, type Raw } from './html.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 요약 보관: 7일 (설계 D-B9) */
export const DIGEST_DAYS = 7;
/** 홈에 바로 보이는 건수 */
const HOME_ITEMS = 3;
const WHY_CHARS = 80;

export type DelegatedState = 'waiting' | 'sending' | 'sent' | 'cancelled' | 'back' | 'failed';

/** 상태를 정하는 사실들. 순수 함수 `describeDelegated` 의 입력이다 */
export interface DelegatedFacts {
  taskStatus: string;
  /** 위임 승인 뒤 사람이 거절·취소했는가 */
  humanStopped: boolean;
  /** 엔진 `show` 가 지금도 위임 승인을 유효로 세는가 (정지·철회·만료·정책 변경이면 false) */
  stillValid: boolean;
  /** 위임 cooldown 이 끝나는 시각(ms). 모르면 null */
  sendAtMs: number | null;
  /** 마지막 일이 일어난 시각(ms): 나간·취소된 때 */
  lastAtMs: number | null;
  nowMs: number;
}

export interface Described {
  state: DelegatedState;
  /** "50분 뒤 나감" · "어제 나감" 같은 한 줄 */
  when: string;
  /** 지금 사람이 막을 수 있는가 (아직 나가기 전) */
  cancellable: boolean;
}

const whenAgo = (nowMs: number, atMs: number | null): string => (atMs === null ? '' : ago(new Date(atMs).toISOString(), nowMs));

/** "곧"·"50분 뒤"·"3시간 뒤" */
export function inTime(targetMs: number | null, nowMs: number): string {
  if (targetMs === null || targetMs - nowMs < 60_000) return '곧';
  const minutes = Math.round((targetMs - nowMs) / 60_000);
  return minutes < 60 ? `${minutes}분 뒤` : `${Math.round(minutes / 60)}시간 뒤`;
}

export function describeDelegated(f: DelegatedFacts): Described {
  if (f.humanStopped || f.taskStatus === 'cancelled') return { state: 'cancelled', when: `${whenAgo(f.nowMs, f.lastAtMs)} 사람이 취소함`.trim(), cancellable: false };
  if (f.taskStatus === 'completed') return { state: 'sent', when: `${whenAgo(f.nowMs, f.lastAtMs)} 나감`.trim(), cancellable: false };
  if (f.taskStatus === 'failed') return { state: 'failed', when: '보내지 못했습니다', cancellable: false };
  if (f.taskStatus === 'needs_review' || f.taskStatus === 'queued') {
    if (!f.stillValid) return { state: 'back', when: '위임이 멈추거나 바뀌어 사람이 다시 결정해야 합니다', cancellable: false };
    return { state: 'waiting', when: `${inTime(f.sendAtMs, f.nowMs)} 나감`, cancellable: true };
  }
  return { state: 'sending', when: '지금 나가는 중', cancellable: false };
}

const STATE_BADGE: Readonly<Record<DelegatedState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'mute' }>> = {
  waiting: { label: '나가기 전', tone: 'warn' }, sending: { label: '나가는 중', tone: 'info' }, sent: { label: '나감', tone: 'ok' },
  cancelled: { label: '취소됨', tone: 'mute' }, back: { label: '사람이 결정할 일로 돌아옴', tone: 'warn' }, failed: { label: '실패', tone: 'bad' },
};

export interface DelegatedItem extends Described {
  taskId: string;
  /** 무엇을 누구에게 */
  what: string;
  /** AI 사유 (한 줄) */
  why: string;
  atMs: number;
  /** 취소 때 엔진에 보여 줄 해시 (취소할 수 있을 때만) */
  hash: string | null;
  count: number;
}

type Shown = Record<string, unknown>;
const rec = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function shownTask(ctx: ReviewContext, taskId: string): Shown | null {
  if (ctx.actor === null) return null;
  const response = ctx.engine.handle({ cmd: 'show', actor: ctx.actor, kind: 'task', id: taskId });
  return response.ok ? (response as unknown as Shown) : null;
}

/** 무엇을 누구에게: "메일 1통 '제목' → a***@example.com". 메일 모양이 아니면 업무 제목 */
function whatOf(ctx: ReviewContext, taskId: string, objective: string): string {
  const rows = ctx.db.all<{ payload: string }>("SELECT payload FROM effect_draft WHERE task_id = ? AND state NOT IN ('superseded', 'rejected') ORDER BY seq", [taskId]);
  const previews = rows.map((row) => {
    try {
      return messagePreviewOf(JSON.parse(row.payload));
    } catch {
      return null;
    }
  }).filter((p) => p !== null);
  if (previews.length === 0) return `'${clip(objective, 30)}'`;
  const recipients = [...new Set(previews.flatMap((p) => p.recipients).map((r) => r.trim().toLowerCase()))];
  const to = recipients.length === 0 ? '' : ` → ${maskAddress(recipients[0]!)}${recipients.length > 1 ? ` 외 ${recipients.length - 1}명` : ''}`;
  return `메일 ${previews.length}통 '${clip(previews[0]!.subject ?? '(제목 없음)', 24)}'${to}`;
}

type ApprovalRow = { id: string; subject_id: string; comment: string | null; at: string; rowid: number };

/** 최근 `days` 일 안에 AI 가 승인한 일들 (업무마다 가장 최근 위임 승인 하나), 최신순 */
export function delegatedItems(ctx: ReviewContext, days = DIGEST_DAYS): DelegatedItem[] {
  const nowMs = ctx.clock.nowMs();
  const since = new Date(nowMs - days * DAY).toISOString();
  const rows = ctx.db.all<ApprovalRow>(
    "SELECT id, subject_id, comment, at, rowid FROM approval WHERE subject_kind = 'task' AND mandate_id IS NOT NULL AND decision = 'approved' AND at > ? ORDER BY at DESC, rowid DESC", [since],
  );
  const seen = new Set<string>();
  const out: DelegatedItem[] = [];
  for (const row of rows) {
    if (seen.has(row.subject_id)) continue;
    seen.add(row.subject_id);
    const task = ctx.db.get<{ objective: string; status: string }>('SELECT objective, status FROM task WHERE id = ?', [row.subject_id]);
    if (task === undefined) continue;
    // 이 승인 뒤에 사람이 남긴 거절·취소 행이 있나 (AI 의 다시 쓰게는 mandate_id 가 있어 제외)
    const stop = ctx.db.get<{ at: string }>(
      "SELECT at FROM approval WHERE subject_kind = 'task' AND subject_id = ? AND mandate_id IS NULL AND decision = 'rejected' AND (at > ? OR (at = ? AND rowid > ?)) ORDER BY at DESC, rowid DESC LIMIT 1",
      [row.subject_id, row.at, row.at, row.rowid],
    );
    const pending = task.status === 'needs_review' || task.status === 'queued';
    const shown = pending ? shownTask(ctx, row.subject_id) : null;
    const approval = rec(shown?.['approval']);
    const sendAt = typeof approval['cooldown_ends_at'] === 'string' ? Date.parse(approval['cooldown_ends_at']) : NaN;
    const last = ctx.db.get<{ at: string }>('SELECT at FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [row.subject_id]);
    const described = describeDelegated({
      taskStatus: task.status, humanStopped: stop !== undefined, stillValid: typeof approval['mandate_id'] === 'string',
      sendAtMs: Number.isFinite(sendAt) ? sendAt : null, lastAtMs: last === undefined ? Date.parse(row.at) : Date.parse(last.at), nowMs,
    });
    const hash = described.cancellable && typeof shown?.['hash'] === 'string' ? shown['hash'] : null;
    out.push({
      ...described, cancellable: described.cancellable && hash !== null, taskId: row.subject_id, what: whatOf(ctx, row.subject_id, task.objective),
      why: clip(row.comment === null || row.comment.trim() === '' ? 'AI가 정해 둔 기준 안이라고 판단했습니다' : row.comment, WHY_CHARS), atMs: Date.parse(row.at), hash, count: 1,
    });
  }
  return out;
}

// ----- 위임 상태 (정지 여부) -----
export interface DelegationState {
  enabled: boolean;
  pausedAll: boolean;
  /** 개별로 멈춘 위임 id (전체 정지가 아닐 때) */
  pausedIds: string[];
  /** 멈추지 않고 쓸 수 있는 위임이 있나 */
  anyActive: boolean;
}

export function delegationState(ctx: ReviewContext): DelegationState {
  const none: DelegationState = { enabled: false, pausedAll: false, pausedIds: [], anyActive: false };
  if (ctx.actor === null) return none;
  const response = ctx.engine.handle({ cmd: 'delegation', actor: ctx.actor, op: 'status' });
  if (!response.ok || response['enabled'] !== true) return none;
  const mandates = (Array.isArray(response['mandates']) ? response['mandates'] : []).map(rec);
  const pausedAll = response['paused_all'] === true;
  return {
    enabled: true, pausedAll, anyActive: mandates.some((m) => m['state'] === 'active'),
    pausedIds: pausedAll ? [] : mandates.filter((m) => m['state'] === 'paused').map((m) => String(m['id'])),
  };
}

// ----- 버튼 (키로 서버가 다시 만든다: decisions.ts resolveDecision) -----
export const DELEGATED_KEY = 'delegated:';
export const CONTROL_KEY = 'delegation:control';

const CANCELLED_DONE = '취소했습니다. 같은 종류의 AI 처리는 멈췄고, 다시 켜기 전까지 사람이 직접 결정합니다.';

function cancelButton(item: DelegatedItem): Button {
  return {
    verb: 'cancel', label: '취소', tone: 'no', reason: 'none', note: '취소하면 같은 종류의 AI 처리가 멈춥니다', done: CANCELLED_DONE,
    steps: [{ label: clip(item.what, 30), request: { cmd: 'cancel', kind: 'task', id: item.taskId }, hash: item.hash }],
  };
}

/** `delegated:<업무 id>` 의 버튼: 아직 막을 수 있을 때만 취소 */
export function delegatedActions(ctx: ReviewContext, taskId: string): Actions {
  const item = delegatedItems(ctx).find((i) => i.taskId === taskId);
  return { buttons: item !== undefined && item.cancellable ? [cancelButton(item)] : [], blocked: [] };
}

/** `delegation:control` 의 버튼: 멈추기, 멈춰 있으면 다시 켜기(OTP) */
export function controlActions(ctx: ReviewContext): Actions {
  const state = delegationState(ctx);
  const buttons: Button[] = [];
  if (state.enabled && state.anyActive && !state.pausedAll) {
    buttons.push({
      verb: 'pause', label: '위임 멈추기', tone: 'no', reason: 'none', note: '멈추면 아직 나가지 않은 AI 승인도 효력을 잃고, 사람이 다시 결정합니다',
      done: '위임을 멈췄습니다. 이제 모든 결정을 사람이 합니다.', steps: [{ label: '위임', request: { cmd: 'delegation', op: 'pause', comment: '화면에서 위임 멈추기' }, hash: null }],
    });
  }
  const resumes: { id: string | null; name: string }[] = state.pausedAll ? [{ id: null, name: '' }] : state.pausedIds.map((id, index) => ({ id, name: state.pausedIds.length > 1 ? ` (${index + 1})` : '' }));
  for (const [index, resume] of resumes.entries()) {
    buttons.push({
      verb: `resume${index}`, label: `위임 다시 켜기${resume.name}`, tone: 'yes', reason: 'none', otp: true, note: '멈추기 전에 받은 AI 승인은 되살아나지 않습니다',
      done: '위임을 다시 켰습니다.', steps: [{ label: '위임', request: { cmd: 'delegation', op: 'resume', ...(resume.id === null ? {} : { mandate_id: resume.id }), comment: '화면에서 위임 다시 켜기' }, hash: null }],
    });
  }
  return { buttons, blocked: [] };
}

// ----- 화면 -----
const buttonsOf = (ctx: ReviewContext, key: string, buttons: readonly Button[]): Raw => (ctx.write === null ? h`` : h`${buttons.map((b) => buttonForm(ctx, key, b))}`);

function itemCard(ctx: ReviewContext, item: DelegatedItem): Raw {
  const badge = STATE_BADGE[item.state];
  return h`<div class="card"><p><b>${item.what}</b> <span class="badge ${badge.tone}">${badge.label}</span></p>
    <p class="mute">${item.when}</p><p>AI의 판단: ${item.why}</p>
    ${item.state === 'back' ? h`<p>${link(['approvals', 'task', item.taskId], '결정하러 가기')}</p>` : ''}
    ${item.cancellable ? buttonsOf(ctx, `${DELEGATED_KEY}${item.taskId}`, [cancelButton(item)]) : ''}</div>`;
}

/** 지난 24시간에 AI 가 처리한 것(나갔거나 나갈 예정) 한 줄 요약 */
export function digestLine(items: readonly DelegatedItem[], nowMs: number): string | null {
  const recent = items.filter((i) => nowMs - i.atMs <= DAY && (i.state === 'waiting' || i.state === 'sending' || i.state === 'sent'));
  if (recent.length === 0) return null;
  const waiting = recent.filter((i) => i.state === 'waiting').length;
  return `AI가 지난 24시간에 ${recent.length}건 처리함${waiting === 0 ? '' : `. ${waiting}건은 아직 나가지 않았고 취소할 수 있습니다`}`;
}

function pausedNote(state: DelegationState): Raw {
  return state.enabled && (state.pausedAll || state.pausedIds.length > 0) ? h`<p class="card">위임이 멈춰 있어 AI는 지금 아무것도 처리하지 않습니다. 다시 켜면 새 건부터 처리합니다. ${link(['delegated'], '다시 켜기')}</p>` : h``;
}

/** 홈의 "AI가 처리함" 요약: 위임이 없고 처리한 것도 없으면 아무것도 그리지 않는다 */
export function homeDigest(ctx: ReviewContext): Raw {
  const state = delegationState(ctx);
  const items = delegatedItems(ctx);
  const nowMs = ctx.clock.nowMs();
  const line = digestLine(items, nowMs);
  const shown = [...items.filter((i) => i.cancellable), ...items.filter((i) => !i.cancellable && i.state !== 'back')].slice(0, HOME_ITEMS);
  const backCount = items.filter((i) => i.state === 'back').length;
  if (line === null && shown.length === 0 && !state.enabled) return h``;
  if (line === null && shown.length === 0 && backCount === 0 && !(state.pausedAll || state.pausedIds.length > 0)) return h``;
  return h`<h2>AI가 처리함</h2>${pausedNote(state)}${line === null ? '' : h`<p class="summary">${line}</p>`}${shown.map((i) => itemCard(ctx, i))}
    <p>${link(['delegated'], items.length > shown.length ? `모두 보기 (${items.length}건)` : '자세히 보기')}</p>`;
}

export function delegatedPage(ctx: ReviewContext): { title: string; body: Raw; status: number } {
  const state = delegationState(ctx);
  const items = delegatedItems(ctx);
  const nowMs = ctx.clock.nowMs();
  const line = digestLine(items, nowMs);
  const controls = controlActions(ctx).buttons;
  return {
    title: items.length === 0 ? 'AI가 처리한 일이 없습니다' : 'AI가 처리함', status: 200,
    body: h`<p><a href="/">← 결정할 일</a></p>${line === null ? '' : h`<p class="lead">${line}</p>`}
      ${state.enabled ? '' : h`<p class="empty">지금은 AI에게 맡긴 일이 없습니다. 모든 결정을 사람이 합니다.</p>`}
      ${pausedNote(state)}${items.length === 0 && state.enabled ? h`<p class="empty">최근 ${DIGEST_DAYS}일 동안 AI가 처리한 일이 없습니다.</p>` : ''}
      ${controls.length === 0 ? '' : h`<div class="decide"><h2>위임 관리</h2>${ctx.write === null ? h`<p class="mute">이 화면은 보기 전용이라 여기서 멈추거나 켤 수 없습니다.</p>` : buttonsOf(ctx, CONTROL_KEY, controls)}</div>`}
      ${items.map((i) => itemCard(ctx, i))}<p class="mute">처리 요약은 ${DIGEST_DAYS}일 동안 보입니다.</p>`,
  };
}

/** 사람에게 온 카드에 보일 "AI가 넘긴 이유". 위임이 없거나 이 업무가 AI를 거치지 않았으면 null */
export function handedBackReason(ctx: ReviewContext, taskId: string, delegatedNow: boolean): string | null {
  const last = ctx.db.get<{ verdict: string; reason: string; outcome: string }>('SELECT verdict, reason, outcome FROM delegate_review WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId]);
  if (last === undefined) return null;
  if (last.verdict === 'escalate') return clip(last.reason, 90);
  // 마지막 검토가 승인인데 지금은 위임 승인이 효력이 없으면 (정지·철회·정책 변경)
  if (last.verdict === 'approve' && !delegatedNow) return '위임이 멈추거나 바뀌어 사람이 다시 확인해야 합니다';
  return null;
}
