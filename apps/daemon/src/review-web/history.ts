// 이력 요약 (설계 §2.2): 결정 하나에 최대 3줄 — 어떻게 왔나 · 앞선 결정 · 링크. 읽기 전용 질의로만 만든다.
// 첫 화면에 id·해시·상태 코드·ISO 시각·엔진 영어 문장을 내지 않는다(링크 주소는 내부 경로라 보이지 않는 속성이다).
// 외부 URL 은 사람이 입력한 값(상품 저장소·환경 주소)만 링크로 만든다. 에이전트·외부 입력에서 온 URL(증거 `source_url` 등)은 링크가 아니다(D-A3).
import type { ReviewContext } from './context.ts';
import { ago, clip } from './format.ts';
import { h, link, type Raw } from './html.ts';

type TaskRow = {
  trigger_kind: string; trigger_ref: string; created_at: string; strategy_version_id: string | null; product_id: string | null;
};

/** http/https 주소만. 계정 정보가 든 주소·너무 긴 주소·그 밖의 형식은 링크로 만들지 않는다 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300 || /[\s<>"'\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

const ENV_LABEL: Readonly<Record<string, string>> = { local: '내 컴퓨터 환경', staging: '시험 환경', production: '운영 환경' };

/** 상품에 사람이 입력해 둔 주소 (저장소·환경). 외부 사이트로 나가는 링크라 새 창에서 열고 출처를 보내지 않는다 */
export function productLinks(ctx: ReviewContext, productId: string | null): Raw[] {
  if (productId === null) return [];
  const out: Raw[] = [];
  const external = (url: string, label: string): Raw => h`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  for (const repo of ctx.db.all<{ remote_url: string | null }>('SELECT remote_url FROM product_repo WHERE product_id = ? ORDER BY name, id', [productId])) {
    const url = safeHttpUrl(repo.remote_url);
    if (url !== null) out.push(external(url, '저장소 열기'));
  }
  for (const env of ctx.db.all<{ name: string; url: string | null }>('SELECT name, url FROM product_environment WHERE product_id = ? ORDER BY name, id', [productId])) {
    const url = safeHttpUrl(env.url);
    if (url !== null) out.push(external(url, `${ENV_LABEL[env.name] ?? '환경'} 열기`));
  }
  return out;
}

const count = (ctx: ReviewContext, sql: string, params: unknown[]): number => Number(ctx.db.get<{ n: number }>(sql, params as never)?.n ?? 0);

/** 이 대상에 사람이 남긴 결정의 흐름 한 줄. 없으면 null */
export function decisionTrail(ctx: ReviewContext, kind: string, id: string): string | null {
  const rows = ctx.db.all<{ decision: string; comment: string | null }>('SELECT decision, comment FROM approval WHERE subject_kind = ? AND subject_id = ? ORDER BY at, rowid', [kind, id]);
  const changes = rows.filter((r) => r.decision === 'changes_requested');
  const rejects = rows.filter((r) => r.decision === 'rejected').length;
  const parts: string[] = [];
  if (changes.length > 0) {
    const last = changes.at(-1)!.comment;
    const revisions = kind === 'task' ? count(ctx, "SELECT COUNT(DISTINCT task_run_id) AS n FROM effect_draft WHERE task_id = ? AND state = 'superseded'", [id]) : 0;
    parts.push(`다시 쓰게 ${changes.length}번${last === null || last.trim() === '' ? '' : `('${clip(last, 24)}')`}${kind === 'task' ? `, 지금 초안이 ${Math.max(revisions, changes.length) + 1}번째` : ''}`);
  }
  if (rejects > 0) parts.push(rejects === 1 ? '한 번 거절된 뒤 다시 제안됨' : `${rejects}번 거절된 뒤 다시 제안됨`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** 결정을 부른 업무 하나의 이력 (최대 3줄). 링크 줄에는 이 화면 안의 이동과 사람이 입력한 외부 주소만 있다 */
export function taskHistory(ctx: ReviewContext, taskId: string): Raw[] {
  const task = ctx.db.get<TaskRow>('SELECT trigger_kind, trigger_ref, created_at, strategy_version_id, product_id FROM task WHERE id = ?', [taskId]);
  if (task === undefined) return [];
  const now = ctx.clock.nowMs();
  const when = ago(task.created_at, now);
  const origin = task.trigger_kind === 'routine' ? `${when} 정기 루틴이 만듦`
    : task.trigger_kind === 'manual' ? `${when} 오너가 직접 만듦`
      : task.trigger_kind === 'task' ? `${when} 앞 업무 결과로 만듦`
        : `${when} 들어온 일(이벤트)로 만듦`;
  const experiment = task.strategy_version_id === null ? null : ctx.db.get<{ title: string }>('SELECT title FROM strategy_version WHERE id = ?', [task.strategy_version_id])?.title ?? null;
  const lines: Raw[] = [h`${origin}${experiment === null ? '' : ` · 실험 '${clip(experiment, 24)}'의 업무`}`];

  const trail = decisionTrail(ctx, 'task', taskId);
  const runs = count(ctx, 'SELECT COUNT(*) AS n FROM task_run WHERE task_id = ? AND ended_at IS NOT NULL', [taskId]);
  const failed = count(ctx, "SELECT COUNT(*) AS n FROM task_run WHERE task_id = ? AND ended_at IS NOT NULL AND (outcome IS NULL OR outcome <> 'submitted')", [taskId]);
  const runText = failed > 0 ? `실행 ${runs}번 중 ${failed}번 실패` : null;
  const prior = [trail, runText].filter((p): p is string => p !== null);
  if (prior.length > 0) lines.push(h`${prior.join(' · ')}`);

  const links: Raw[] = [];
  const evidence = count(ctx, 'SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?', [taskId]);
  if (evidence > 0) links.push(link(['evidence'], `증거 ${evidence}건`, `?task=${encodeURIComponent(taskId)}`));
  if (count(ctx, "SELECT COUNT(*) AS n FROM external_effect WHERE task_id = ? AND state = 'unknown'", [taskId]) > 0) links.push(link(['effects'], '전송 여부 확인'));
  if (task.trigger_kind === 'task' && ctx.db.get("SELECT 1 AS one FROM task WHERE id = ? AND status = 'needs_review'", [task.trigger_ref]) !== undefined) links.push(link(['approvals', 'task', task.trigger_ref], '앞 업무 보기'));
  if (task.product_id !== null) {
    const slug = ctx.db.get<{ slug: string }>('SELECT slug FROM product WHERE id = ?', [task.product_id])?.slug;
    if (slug !== undefined) links.push(link(['products', slug], '관련 상품'));
    links.push(...productLinks(ctx, task.product_id));
  }
  if (links.length > 0) lines.push(h`${links.map((l, index) => h`${index === 0 ? '' : ' · '}${l}`)}`);
  return lines.slice(0, 3);
}

/** 이력 요약을 그린다: 최대 3줄 */
export const historyList = (lines: readonly Raw[] | undefined): Raw => (lines === undefined || lines.length === 0 ? h`` : h`<ul class="hist">${lines.slice(0, 3).map((l) => h`<li>${l}</li>`)}</ul>`);

/** 업무가 아닌 결정의 이력: 앞선 결정 한 줄(있을 때만) */
export function subjectHistory(ctx: ReviewContext, kind: string, id: string, extraLinks: Raw[] = []): Raw[] {
  const trail = decisionTrail(ctx, kind, id);
  const lines: Raw[] = [];
  if (trail !== null) lines.push(h`${trail}`);
  if (extraLinks.length > 0) lines.push(h`${extraLinks.map((l, index) => h`${index === 0 ? '' : ' · '}${l}`)}`);
  return lines;
}
