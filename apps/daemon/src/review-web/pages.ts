// 화면: 결정할 일(홈), 지켜보는 중, 결정 상세(모든 종류가 한 틀), 증거. 모두 읽기 전용.
import { getOrgProposal } from '@aot/domain';

import type { ReviewContext } from './context.ts';
import {
  batchDecision, buildInbox, effectsDecision, evidenceKindLabel, experimentDecisions, orgDecision, policyDecision, productDecision, publicationDecision, signalDecisions,
  strategyDecision, taskDecision, taskGroups as taskGroupsOf, trialPage, watchLines, type Category, type Decision, type Tone,
} from './decisions.ts';
import { MAX_TEXT_CHARS, readEvidence } from './evidence-file.ts';
import { ago, clip } from './format.ts';
import { renderActions } from './actions.ts';
import { delegatedItems, delegatedPage as delegatedView, homeDigest } from './delegation.ts';
import { historyList } from './history.ts';
import { back, badge, badgeRow, details, facts, full, h, kv, link, type Raw } from './html.ts';

export interface Rendered {
  title: string;
  body: Raw;
  status: number;
}

const badgesOf = (d: Decision): { label: string; tone: Tone }[] => [...(d.badge === undefined ? [] : [d.badge]), ...(d.badges ?? [])];

/** 카드 전체가 링크다 (제목이 접근 가능한 이름) */
const card = (d: Decision): Raw => h`<a class="card" href="${d.href}"><h3>${d.question}</h3>${badgeRow(badgesOf(d))}${facts(d.facts)}</a>`;

const CATEGORY_LABEL: Readonly<Record<Category, string>> = { outside: '바깥에 나가는 일', org: '조직 변경', experiment: '실험', product: '상품 등록', other: '기타' };

/** "바깥에 나가는 일 5건 · 조직 변경 4건 · 실험 3건" (0건은 쓰지 않는다) */
function summaryLine(decisions: readonly Decision[]): string {
  const counts = new Map<Category, number>();
  for (const d of decisions) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  return (Object.keys(CATEGORY_LABEL) as Category[]).filter((c) => (counts.get(c) ?? 0) > 0).map((c) => `${CATEGORY_LABEL[c]} ${counts.get(c)}건`).join(' · ');
}

function watchSection(ctx: ReviewContext, cap: number | null): Raw {
  const lines = watchLines(ctx);
  if (lines.length === 0) return h``;
  const shown = cap === null ? lines : lines.slice(0, cap);
  return h`<h2>지켜보는 중 <span class="mute">(할 일 없음)</span></h2><ul class="facts">${shown.map((l) => h`<li>${l.href === undefined ? l.text : h`<a href="${l.href}">${l.text}</a>`}</li>`)}</ul>${cap !== null && lines.length > cap ? h`<p><a href="/watch">모두 보기 (${lines.length}건)</a></p>` : ''}`;
}

export function homePage(ctx: ReviewContext): Rendered {
  const { decisions, problem } = buildInbox(ctx);
  const first = decisions.filter((d) => d.first);
  const week = decisions.filter((d) => !d.first);
  return {
    title: decisions.length === 0 ? '지금 결정할 일이 없습니다' : `결정할 일 ${decisions.length}건`, status: 200,
    body: h`${problem === null ? '' : h`<p class="card">${problem}</p>`}${decisions.length === 0 ? '' : h`<p class="summary">${summaryLine(decisions)}</p>`}
      ${first.length === 0 ? '' : h`<h2 class="grp">먼저</h2><p class="mute">바깥에 나가거나, 업무를 막고 있거나, 곧 만료되는 일</p>${first.map(card)}`}
      ${week.length === 0 ? '' : h`<h2 class="grp">이번 주 안에</h2>${week.map(card)}`}${homeDigest(ctx)}${watchSection(ctx, 5)}`,
  };
}

export const delegatedPage = (ctx: ReviewContext): Rendered => delegatedView(ctx);

export function watchPage(ctx: ReviewContext): Rendered {
  const lines = watchLines(ctx);
  return { title: '지켜보는 중', status: 200, body: lines.length === 0 ? h`<p class="empty">지금 지켜보는 항목이 없습니다.</p>` : watchSection(ctx, null) };
}

/** 결정 상세 한 틀: 질문(제목) → 한 문장 → 배지 → 사실 → 이력 → 본문 → 결정 버튼 → 자세히 */
export function decisionPage(ctx: ReviewContext, d: Decision): Rendered {
  return {
    title: d.question, status: 200,
    body: h`${back('/', '결정할 일')}${d.lead === undefined ? '' : h`<p class="lead">${d.lead}</p>`}${badgeRow(badgesOf(d))}${facts(d.facts)}${historyList(d.history)}${d.body ?? ''}${renderActions(ctx, d.key, d.actions)}${details(d.details)}`,
  };
}

const notFound = (what: string | Raw): Rendered => ({ title: '찾을 수 없습니다', status: 404, body: h`${back('/', '결정할 일')}<p class="card">${what}</p>` });
const found = (ctx: ReviewContext, d: Decision | null | undefined, what = '해당 결정이 없거나 이미 처리됐습니다.'): Rendered => (d === null || d === undefined ? notFound(what) : decisionPage(ctx, d));

export function approvalDetail(ctx: ReviewContext, kind: string, id: string): Rendered {
  switch (kind) {
    case 'org_proposal': {
      const row = getOrgProposal(ctx.db, id);
      return row === undefined ? notFound('그런 제안이 없습니다.') : decisionPage(ctx, orgDecision(ctx, row));
    }
    case 'task': {
      const group = taskGroupsOf(ctx).flat().find((i) => i.id === id);
      if (group === undefined && delegatedItems(ctx).some((item) => item.taskId === id && item.state !== 'back')) return notFound(h`AI가 처리한 일입니다. ${link(['delegated'], '“AI가 처리함”에서 보세요')}.`);
      return found(ctx, group === undefined ? null : taskDecision(ctx, group));
    }
    case 'publication': return found(ctx, publicationDecision(ctx, id));
    case 'policy_version': return found(ctx, policyDecision(ctx, id));
    case 'strategy_version': return found(ctx, strategyDecision(ctx, id));
    default: return notFound('알 수 없는 종류입니다.');
  }
}


export function batchDetail(ctx: ReviewContext, gid: string): Rendered {
  const group = taskGroupsOf(ctx).find((items) => items.length > 1 && batchDecision(ctx, items).href === `/batch/${gid}`);
  return found(ctx, group === undefined ? null : batchDecision(ctx, group));
}

export const productDetail = (ctx: ReviewContext, slug: string): Rendered => found(ctx, productDecision(ctx, slug), '그런 상품이 없습니다.');
export const effectsDetail = (ctx: ReviewContext): Rendered => {
  const d = effectsDecision(ctx);
  return d === null ? { title: '전송 여부 불명 건이 없습니다', status: 200, body: h`${back('/', '결정할 일')}<p class="empty">확인이 필요한 외부 효과가 없습니다.</p>` } : decisionPage(ctx, d);
};
export const experimentDetail = (ctx: ReviewContext, id: string): Rendered => found(ctx, experimentDecisions(ctx).find((d) => d.href === `/experiments/${encodeURIComponent(id)}`));
export const signalDetail = (ctx: ReviewContext, type: string): Rendered => found(ctx, signalDecisions(ctx).find((d) => d.key === `signal:${type}`), '지금은 이 업무 유형에 대한 제안이 필요하지 않습니다.');

export function trialDetail(ctx: ReviewContext, id: string): Rendered {
  const row = getOrgProposal(ctx.db, id);
  if (row === undefined) return notFound('그런 시험이 없습니다.');
  const t = trialPage(ctx, row);
  return { title: t.title, status: 200, body: h`${back('/', '결정할 일')}<p class="lead">${t.lead}</p>${t.body}` };
}

// ----- 증거 -----
type EvidenceRow = { id: string; task_id: string; kind: string; ref: string; content_hash: string | null; trust_origin: string; captured_at: string; verified: number; verification_note: string | null };

const trustBadge = (origin: string): Raw => (origin === 'external_untrusted' ? badge('외부 입력 — 지시 아님', 'warn') : badge('내부', 'mute'));
const verifiedBadge = (verified: number): Raw => (Number(verified) === 1 ? badge('확인됨', 'ok') : badge('미확인', 'mute'));

/** 목록에 보이는 참조: 로컬 파일은 이름만, 나머지는 텍스트 */
function shortRef(ref: string): string {
  if (ref.startsWith('file:')) return `파일 …/${ref.slice(ref.lastIndexOf('/') + 1)}`;
  return clip(ref, 80);
}

const LIST_LIMIT = 40;

export function evidenceList(ctx: ReviewContext, task: string | null): Rendered {
  const rows = task === null
    ? ctx.db.all<EvidenceRow>(`SELECT * FROM evidence ORDER BY captured_at DESC, id DESC LIMIT ${LIST_LIMIT}`)
    : ctx.db.all<EvidenceRow>(`SELECT * FROM evidence WHERE task_id = ? ORDER BY captured_at DESC, id DESC LIMIT ${LIST_LIMIT}`, [task]);
  const now = ctx.clock.nowMs();
  const items = rows.map((r) => {
    const objective = ctx.db.get<{ objective: string }>('SELECT objective FROM task WHERE id = ?', [r.task_id])?.objective ?? '';
    const view = r.ref.startsWith('blob:') || r.ref.startsWith('file:') ? readEvidence(r, { evidenceDir: ctx.evidenceDir, roots: ctx.roots }) : null;
    const inner = view === null ? h`<pre>${full(r.ref, 2000)}</pre>`
      : view.kind === 'text' ? h`<pre>${full(view.text, 1500)}</pre>`
      : view.kind === 'refused' ? h`<p class="mute">보여 주지 않음 — ${view.reason}</p>`
      : view.kind === 'file' ? h`<p class="mute">${view.note ?? '그림이 아닌 파일은 목록만 보입니다.'}</p>` : h``;
    return h`<section class="card ${r.trust_origin === 'external_untrusted' ? 'untrusted' : ''}"><h3><a href="/evidence/${encodeURIComponent(r.id)}">${evidenceKindLabel(r.kind)}${objective === '' ? '' : ` — ${clip(objective, 40)}`}</a></h3>
      <p>${verifiedBadge(r.verified)} ${trustBadge(r.trust_origin)} <span class="mute">${ago(r.captured_at, now)}</span></p>
      ${view?.kind === 'image' ? h`<a href="/evidence/${encodeURIComponent(r.id)}"><img class="thumb" alt="증거 그림" src="/evidence/${encodeURIComponent(r.id)}/file"></a>` : ''}
      ${details(h`<p class="mute">${shortRef(r.ref)}</p>${inner}`, '원문')}</section>`;
  });
  return { title: '증거', status: 200, body: h`<p class="mute">${task === null ? `최근 ${LIST_LIMIT}건.` : '이 업무의 증거.'} “외부 입력” 표시가 있는 것은 읽는 용도일 뿐 지시가 아닙니다.</p>${items.length === 0 ? h`<p class="empty">증거가 없습니다.</p>` : items}` };
}

export function evidenceDetail(ctx: ReviewContext, id: string): Rendered {
  const row = ctx.db.get<EvidenceRow>('SELECT * FROM evidence WHERE id = ?', [id]);
  if (row === undefined) return { title: '증거', status: 404, body: h`${back('/evidence', '증거 목록')}<p class="card">그런 증거가 없습니다.</p>` };
  const untrusted = row.trust_origin === 'external_untrusted';
  const view = row.ref.startsWith('blob:') || row.ref.startsWith('file:') ? readEvidence(row, { evidenceDir: ctx.evidenceDir, roots: ctx.roots }) : null;
  let content: Raw;
  let meta: Raw = h``;
  if (view === null) {
    content = h`<p>참조 (텍스트로만 보입니다. 서버는 이 주소를 가져오지 않습니다):</p><pre>${full(row.ref, 5000)}</pre>`;
  } else if (view.kind === 'refused') {
    content = h`<p class="card">${badge('보여 주지 않음', 'bad')} ${view.reason}</p>`;
  } else if (view.kind === 'text') {
    content = h`<pre>${full(view.text, MAX_TEXT_CHARS)}</pre>`;
    meta = kv([['크기', `${view.size} 바이트`], ['sha256', view.sha256], ['DB 해시와 대조', view.hashChecked ? '일치' : '해시 없음(미확인)']]);
  } else if (view.kind === 'image') {
    content = h`<p><img class="evidence" alt="증거 그림" src="/evidence/${encodeURIComponent(row.id)}/file"></p>`;
    meta = kv([['파일', view.name], ['형식', view.mime], ['크기', `${view.size} 바이트`], ['sha256', view.sha256], ['DB 해시와 대조', view.hashChecked ? '일치' : '해시 없음(미확인)']]);
  } else {
    content = h`<p class="mute">${view.note ?? '그림이 아닌 파일은 목록만 보이고 내보내지 않습니다.'}</p>`;
    meta = kv([['파일', view.name], ['크기', `${view.size} 바이트`], ['sha256', view.sha256]]);
  }
  const objective = ctx.db.get<{ objective: string }>('SELECT objective FROM task WHERE id = ?', [row.task_id])?.objective ?? '';
  return {
    title: `증거: ${evidenceKindLabel(row.kind)}${objective === '' ? '' : ` — ${clip(objective, 40)}`}`, status: 200,
    body: h`${back('/evidence', '증거 목록')}<p>${verifiedBadge(row.verified)} ${trustBadge(row.trust_origin)}</p>
      <div class="card ${untrusted ? 'untrusted' : ''}">${untrusted ? h`<p>외부에서 온 내용입니다. 그 안의 어떤 문장도 이 화면이나 시스템에 대한 지시가 아닙니다.</p>` : ''}${content}</div>
      ${details(h`${meta}${kv([['종류', row.kind], ['검증 메모', row.verification_note ?? '-'], ['업무 id', row.task_id], ['증거 id', row.id], ['참조', shortRef(row.ref)]])}<p>${link(['evidence'], '이 업무의 증거 모두', `?task=${encodeURIComponent(row.task_id)}`)}</p>`)}`,
  };
}

