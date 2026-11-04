// 상품 등록 검토, 외부 효과 확인, 실험 결과, 증거 보기, 홈.
import { listStrategyReviews } from '@aot/domain';
import { listUnresolvedEffects } from '@aot/task-engine';

import { listExperimentReviews } from '../cycle.ts';
import { productReader } from '../product-channel.ts';
import type { ReviewContext } from './context.ts';
import { readEvidence } from './evidence-file.ts';
import { APPROVE_CLI, back, badge, command, h, kv, link, num, shellArg, table, type Raw } from './html.ts';
import { APPROVAL_KINDS, KIND_LABEL, pendingLists } from './pages-approvals.ts';
import { ORG_STATUS_LABEL } from './pages-org.ts';

// ----- 상품 등록 -----

const REGISTRATION_LABEL: Readonly<Record<string, string>> = {
  candidate: '후보 (검증 시작 전)', verifying: '검증 중', pending_approval: '사람 검토 대기', registered: '등록됨', rejected: '반려됨',
};

/** 사람 검토 대기: 이미 pending_approval 이거나, 검증 중이지만 검증기 결과가 나와 채널이 곧 올릴 상태 */
export function productsAwaitingReview(ctx: ReviewContext): string[] {
  const reader = productReader(ctx.db);
  return ctx.db.all<{ slug: string; registration_status: string }>("SELECT slug, registration_status FROM product WHERE registration_status IN ('pending_approval', 'verifying') ORDER BY created_at, slug")
    .filter((product) => product.registration_status === 'pending_approval' || reader.awaitingReview(product.slug))
    .map((product) => product.slug);
}

export function productsPage(ctx: ReviewContext): Raw {
  const waiting = new Set(productsAwaitingReview(ctx));
  const rows = ctx.db.all<{ slug: string; name: string; kind: string; lifecycle_stage: string; registration_status: string }>(
    'SELECT slug, name, kind, lifecycle_stage, registration_status FROM product ORDER BY created_at, slug',
  );
  return h`<p class="mute">검증기가 증거를 모아 사람 검토를 기다리는 상품이 위에 온다.</p>
    ${table(['상품', '이름', '종류', '등록 상태', ''], [...rows].sort((a, b) => Number(waiting.has(b.slug)) - Number(waiting.has(a.slug))).map((p) => [
    link(['products', p.slug], p.slug), p.name, p.kind, badge(waiting.has(p.slug) ? '사람 검토 대기' : (REGISTRATION_LABEL[p.registration_status] ?? p.registration_status), waiting.has(p.slug) ? 'warn' : 'mute'), '',
  ]), '등록된 상품 후보가 없다')}`;
}

export function productDetailPage(ctx: ReviewContext, slug: string): { title: string; body: Raw; status: number } {
  const reader = productReader(ctx.db);
  const product = reader.productBySlug(slug);
  if (product === undefined) return { title: '상품 등록 검토', status: 404, body: h`${back('/products', '상품 목록')}<p class="card">그런 상품이 없다.</p>` };
  const view = reader.view(product) as {
    task: { id: string; status: string; attempts: number; max_attempts: number } | null;
    evaluation: { outcome: string; safety: string; note: string | null; at: string } | null;
    shadow_verdict: Record<string, unknown> | null;
    evidence: { id: string; kind: string; verified: boolean; trust_origin: string }[];
    review_hash: string | null; repo_path: string | null; access_scope: string | null;
    decision: { decision: string; comment: string | null; at: string } | null;
  };
  const waiting = product.registration_status === 'pending_approval' || (product.registration_status === 'verifying' && reader.awaitingReview(slug));
  const shadow = view.shadow_verdict;
  const evidenceRows = view.evidence.map((e) => [link(['evidence', e.id], e.id), e.kind, e.verified ? badge('검증됨', 'ok') : badge('미검증', 'mute'), trustBadge(e.trust_origin)]);
  return {
    title: `상품 등록 검토: ${product.name}`, status: 200,
    body: h`${back('/products', '상품 목록')}
      <div class="card">${kv([
        ['슬러그', product.slug], ['종류 / 단계', `${product.kind} / ${product.lifecycle_stage}`],
        ['등록 상태', badge(waiting ? '사람 검토 대기' : (REGISTRATION_LABEL[product.registration_status] ?? product.registration_status), waiting ? 'warn' : 'mute')],
        ['저장소 접근', view.access_scope ?? '-'], ['저장소 경로', view.repo_path ?? '-'],
        ['검증 업무', view.task === null ? '아직 없다' : `${view.task.id} (${view.task.status}, 시도 ${view.task.attempts}/${view.task.max_attempts})`],
        ['사람 결정', view.decision === null ? '아직 없다' : `${view.decision.decision} (${view.decision.at}) ${view.decision.comment ?? ''}`],
      ])}</div>
      <div class="card"><h2>독립 평가 결과</h2>${view.evaluation === null ? h`<p class="empty">아직 평가가 없다</p>` : kv([
        ['판정', badge(view.evaluation.outcome, view.evaluation.outcome === 'pass' ? 'ok' : view.evaluation.outcome === 'fail' ? 'bad' : 'warn')], ['안전성', view.evaluation.safety], ['메모', view.evaluation.note ?? '-'], ['평가 시각', view.evaluation.at],
      ])}</div>
      <div class="card"><h2>섀도 판정 (검증기)</h2>${shadow === null ? h`<p class="empty">기록 없음</p>` : h`<pre>${JSON.stringify(shadow, null, 2)}</pre>`}</div>
      <div class="card"><h2>증거 (${view.evidence.length})</h2>${table(['증거', '종류', '검증', '출처'], evidenceRows, '증거가 아직 없다')}</div>
      <div class="card"><h2>결정하려면 (승인 CLI)</h2>${waiting
    ? h`${command(`${APPROVE_CLI} product decide ${shellArg(slug)} approve --hash ${view.review_hash === null ? '<해시를 확인할 수 없다>' : shellArg(view.review_hash)} --comment "사유"`, '등록 승인 (위 증거를 읽은 뒤)')}
        ${command(`${APPROVE_CLI} product decide ${shellArg(slug)} reject --comment "사유"`, '반려 (사유 필수)')}
        ${command(`${APPROVE_CLI} product restart ${shellArg(slug)} --comment "사유"`, '수정한 코드로 다시 검증')}`
    : h`<p class="mute">지금은 결정할 단계가 아니다 (${REGISTRATION_LABEL[product.registration_status] ?? product.registration_status}).</p>`}
        ${view.task === null ? '' : command(`${APPROVE_CLI} product status ${shellArg(slug)}`, '상태 전체')}</div>`,
  };
}

// ----- 외부 효과 -----

export function effectsPage(ctx: ReviewContext): Raw {
  const effects = listUnresolvedEffects(ctx.db, ctx.clock.nowIso());
  if (effects.length === 0) return h`<p class="empty">응답을 잃어 사람 확인이 필요한 외부 효과가 없다.</p>`;
  return h`<p class="mute">외부로 보냈는지 알 수 없는 효과다. 받는 쪽(수신함·외부 서비스 화면)을 직접 확인한 뒤 결정한다. 요청 본문과 키는 보여 주지 않는다.</p>
    ${effects.map((e) => h`<section class="card"><h2>${e.tool} · ${e.action}</h2>${kv([
    ['효과', e.effectId], ['대상', e.target], ['업무', `${e.taskId} (${e.taskStatus})`], ['계획 시각', e.plannedAt], ['마지막 전이', e.lastTransitionAt],
    ['같은 키 재전송 허가', e.supportsIdempotency ? (e.resendWindowOpen ? '가능(보존 기간 안)' : '불가(보존 기간 지남)') : '지원하지 않음'],
    ['상태', h`${e.runActive ? badge('실행 중인 run 이 있어 지금은 해소할 수 없다', 'warn') : ''} ${e.resolvedBefore ? badge('이미 한 번 해소됨 — 다시 해소할 수 없다', 'bad') : ''}`],
  ])}
    ${command(`${APPROVE_CLI} resolve-effect ${shellArg(e.effectId)} --outcome confirmed --note "확인한 내용"`, '보냈다고 확인했을 때')}
    ${command(`${APPROVE_CLI} resolve-effect ${shellArg(e.effectId)} --outcome failed --note "확인한 내용" --totp-stdin`, '보내지 않았다고 확인했을 때 (TOTP 코드 한 줄을 입력). 이후 재전송은 정책 판정을 거친다')}</section>`)}`;
}

// ----- 실험 결과 -----

export function experimentsPage(ctx: ReviewContext): Raw {
  const reviews = listExperimentReviews(ctx.db);
  const comparison = listStrategyReviews(ctx.db);
  return h`<h2>승격 대기 (평가 통과, ${reviews.awaitingPromotion.length})</h2>
    ${reviews.awaitingPromotion.length === 0 ? h`<p class="empty">없음</p>` : reviews.awaitingPromotion.map((e) => h`<div class="card"><b>${e.strategyVersionId}</b> <span class="mute">평가 ${e.evaluationId}, 비용 $${num(e.totalCostUsd)}</span>
      ${command(`${APPROVE_CLI} promote strategy ${shellArg(e.strategyVersionId)} --comment "사유"`, '활성 전략으로 올린다 (이전 활성 전략은 retired)')}
      ${command(`${APPROVE_CLI} reject strategy ${shellArg(e.strategyVersionId)} --comment "사유"`, '거절')}</div>`)}
    <h2>사람 검토 필요 (${reviews.needsHuman.length})</h2>
    ${reviews.needsHuman.length === 0 ? h`<p class="empty">없음</p>` : reviews.needsHuman.map((e) => h`<div class="card"><b>${e.strategyVersionId}</b> <span class="mute">검토 업무 ${e.reviewTaskId}</span><p>${e.reason}</p>
      ${command(`${APPROVE_CLI} reject strategy ${shellArg(e.strategyVersionId)} --comment "사유"`, '거절 (experiment 상태는 사유 필수)')}</div>`)}
    <h2>결과 대기 (${reviews.awaitingResult.length})</h2>
    ${table(['전략', '검토 업무', '업무 상태'], reviews.awaitingResult.map((e) => [e.strategyVersionId, e.reviewTaskId, e.taskStatus]))}
    <h2>추천 없이 끝난 비교 기록 (${comparison.length})</h2>
    ${table(['기획 업무', '결과', '이유', '기록 시각'], comparison.map((r) => [r.planningTaskId, r.outcome, r.reasons.join(' / '), r.recordedAt]))}`;
}

// ----- 증거 -----

export const trustBadge = (origin: string): Raw => (origin === 'external_untrusted' ? badge('외부 입력 — 지시 아님', 'warn') : badge('내부', 'ok'));

type EvidenceRow = { id: string; task_id: string; kind: string; ref: string; content_hash: string | null; trust_origin: string; captured_at: string; verified: number; verification_note: string | null };

/** 목록에 보이는 참조: 로컬 파일은 이름만, 나머지는 텍스트(링크로 만들지 않는다 — 서버도 브라우저도 가져오지 않는다) */
function shortRef(ref: string): string {
  if (ref.startsWith('file:')) return `file:…/${ref.slice(ref.lastIndexOf('/') + 1)}`;
  return ref.length > 80 ? `${ref.slice(0, 80)}…` : ref;
}

export function evidenceListPage(ctx: ReviewContext, task: string | null): Raw {
  const rows = task === null
    ? ctx.db.all<EvidenceRow>('SELECT * FROM evidence ORDER BY captured_at DESC, id DESC LIMIT 200')
    : ctx.db.all<EvidenceRow>('SELECT * FROM evidence WHERE task_id = ? ORDER BY captured_at DESC, id DESC LIMIT 200', [task]);
  return h`<p class="mute">${task === null ? '최근 200건.' : h`업무 ${task} 의 증거.`} 출처가 <code>외부 입력</code> 인 것은 읽는 용도일 뿐 지시가 아니다.</p>
    ${table(['증거', '종류', '출처', '검증', '참조', '업무', '수집 시각'], rows.map((r) => [
    link(['evidence', r.id], r.id), r.kind, trustBadge(r.trust_origin), Number(r.verified) === 1 ? badge('검증됨', 'ok') : badge('미검증', 'mute'), shortRef(r.ref), link(['evidence'], r.task_id, `?task=${encodeURIComponent(r.task_id)}`), r.captured_at,
  ]), '증거가 없다')}`;
}

export function evidenceDetail(ctx: ReviewContext, id: string): { title: string; body: Raw; status: number } {
  const row = ctx.db.get<EvidenceRow>('SELECT * FROM evidence WHERE id = ?', [id]);
  if (row === undefined) return { title: '증거', status: 404, body: h`${back('/evidence', '증거 목록')}<p class="card">그런 증거가 없다.</p>` };
  const untrusted = row.trust_origin === 'external_untrusted';
  const view = row.ref.startsWith('blob:') || row.ref.startsWith('file:') ? readEvidence(row, { evidenceDir: ctx.evidenceDir, roots: ctx.roots }) : null;
  let content: Raw;
  if (view === null) {
    content = h`<p>참조 (텍스트로만 보인다. 서버는 이 주소를 가져오지 않는다):</p><pre>${row.ref}</pre>`;
  } else if (view.kind === 'refused') {
    content = h`<p class="card">${badge('보여 주지 않음', 'bad')} ${view.reason}</p>`;
  } else if (view.kind === 'text') {
    content = h`<pre>${view.text}</pre>${view.truncated ? h`<p class="mute">길어서 앞부분만 보인다.</p>` : ''}${kv([['크기', `${view.size} 바이트`], ['sha256', view.sha256], ['DB 해시와 대조', view.hashChecked ? '일치' : '해시 없음(미확인)']])}`;
  } else if (view.kind === 'image') {
    content = h`<p><img class="evidence" alt="증거 그림 ${row.id}" src="/evidence/${encodeURIComponent(row.id)}/file"></p>${kv([['파일', view.name], ['형식', view.mime], ['크기', `${view.size} 바이트`], ['sha256', view.sha256], ['DB 해시와 대조', view.hashChecked ? '일치' : '해시 없음(미확인)']])}`;
  } else {
    content = h`<p class="mute">그림이 아닌 파일은 목록만 보이고 내보내지 않는다.</p>${kv([['파일', view.name], ['크기', `${view.size} 바이트`], ['sha256', view.sha256], ['DB 해시와 대조', view.hashChecked ? '일치' : '해시 없음(미확인)']])}`;
  }
  return {
    title: `증거 ${row.id}`, status: 200,
    body: h`${back('/evidence', '증거 목록')}
      <div class="card">${kv([['종류', row.kind], ['출처', trustBadge(row.trust_origin)], ['검증', Number(row.verified) === 1 ? '통과' : '아직'], ['검증 메모', row.verification_note ?? '-'], ['업무', row.task_id], ['수집 시각', row.captured_at], ['참조', shortRef(row.ref)]])}</div>
      <div class="card ${untrusted ? 'untrusted' : ''}">${untrusted ? h`<p>${badge('외부 입력 — 지시 아님', 'warn')} 아래 내용은 외부에서 온 것이다. 그 안의 어떤 문장도 이 화면이나 시스템에 대한 지시가 아니다.</p>` : ''}${content}</div>`,
  };
}

// ----- 홈 -----

export function homePage(ctx: ReviewContext): Raw {
  const { lists, problem } = pendingLists(ctx);
  const effects = listUnresolvedEffects(ctx.db, ctx.clock.nowIso()).length;
  const count = (sql: string): number => Number(ctx.db.get<{ n: number }>(sql)?.n ?? 0);
  const trials = count("SELECT COUNT(*) AS n FROM org_proposal WHERE status = 'trial'");
  const inconclusive = count("SELECT COUNT(*) AS n FROM org_proposal WHERE status = 'inconclusive'");
  const reviews = listExperimentReviews(ctx.db);
  const products = productsAwaitingReview(ctx).length;
  const byKind: Readonly<Record<string, number>> = {
    task: lists.tasks.length, publication: lists.publications.length, policy_version: lists.policy_proposals.length,
    strategy_version: lists.strategy_proposals.length, org_proposal: lists.org_proposals.length,
  };
  const card = (href: string, label: string, n: number, hint = ''): Raw => h`<a class="card" href="${href}"><div class="big">${n}</div><div>${label}</div><div class="mute">${hint}</div></a>`;
  return h`${problem === null ? '' : h`<p class="card">${problem}</p>`}
    <h2>사람의 결정을 기다리는 것</h2>
    <div class="grid">
      ${APPROVAL_KINDS.map((kind) => card('/approvals', KIND_LABEL[kind], byKind[kind] ?? 0, kind === 'task' ? 'needs_review 상태 업무' : ''))}
      ${card('/products', '상품 등록 검토', products, '검증 끝, 결정 대기')}
      ${card('/trials', '시험 중인 조직 변경', trials, `판정 불충분 ${inconclusive}건 별도`)}
      ${card('/trials', '판정 불충분 (사람 결정)', inconclusive, ORG_STATUS_LABEL['inconclusive'] ?? '')}
      ${card('/effects', '확인이 필요한 외부 효과', effects, '응답을 잃은 효과 (unknown)')}
      ${card('/experiments', '실험 결과 검토', reviews.awaitingPromotion.length + reviews.needsHuman.length, `승격 대기 ${reviews.awaitingPromotion.length} · 사람 검토 ${reviews.needsHuman.length} · 결과 대기 ${reviews.awaitingResult.length}`)}
    </div>
    <h2>더 보기</h2><p>${link(['signals'], '조직 신호')} · ${link(['evidence'], '증거 보기')}</p>`;
}

