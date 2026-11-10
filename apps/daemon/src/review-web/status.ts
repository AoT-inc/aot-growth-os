// 읽기 전용 현황 화면: /now(지금), /org(조직·역할), /sites(사이트 연결), /cost(비용·구독). 설계: plans/2026-11-10_aot-integration_design_interaction.md §4.
// 규칙: DB 는 읽기만 한다(SELECT 만). 초안 본문(effect_draft)·증거 본문·이메일 주소·금액(USD)은 읽지도 보이지도 않는다.
// 업무 목표·역할 설명처럼 사람/에이전트가 쓴 글은 `safe()` 로 이메일 주소를 가린 뒤 h`` 가 비밀 모양을 가리고 이스케이프한다.
// id·해시·상태 코드는 접힌 "자세히" 안에만 둔다. 상태는 색이 아니라 글자로 쓴다.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseMcpSites, type McpSiteManifest } from '@aot/agent-runtime';

import { buildInbox } from './decisions.ts';
import type { ReviewContext } from './context.ts';
import { ago, clip } from './format.ts';
import { badge, details, h, kv, num, table, type Raw } from './html.ts';
import type { Rendered } from './pages.ts';

const KST = 9 * 3_600_000;
const WEEK_MS = 7 * 86_400_000;
/** 자동 새로고침 간격(초). /now 와 /cost 에만 쓴다 */
export const REFRESH_SECONDS = 30;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 사람이 쓴 글을 화면용으로: 이메일 주소를 가리고 한 줄로 줄인다 */
const safe = (value: unknown, max = 60): string => clip(String(value ?? '').replace(EMAIL, '(메일 주소 가림)'), max);

/** "14:03:12" (한국 시간) */
export const clockText = (ms: number): string => new Date(ms + KST).toISOString().slice(11, 19);

function elapsed(fromIso: string, nowMs: number): string {
  const ms = Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms > nowMs) return '-';
  const minutes = Math.floor((nowMs - ms) / 60_000);
  if (minutes < 1) return '1분 미만';
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}시간 ${minutes % 60}분` : `${Math.floor(hours / 24)}일`;
}

const when = (iso: string, nowMs: number): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  return `${ago(iso, nowMs)} ${clockText(ms).slice(0, 5)}`;
};

const refreshNote = (nowMs: number): Raw => h`<p class="mute stamp">갱신 ${clockText(nowMs)} · ${REFRESH_SECONDS}초마다 저절로 새로 고칩니다</p>`;

const STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: '대기 중', running: '실행 중', validating: '검증 중', retry_wait: '다시 시도 대기', needs_review: '사람 검토 필요', unassigned: '맡을 역할 없음', completed: '완료',
};

/** 큰 숫자 한 칸. 링크가 있으면 칸 전체가 링크 */
const stat = (value: number, label: string, note: string, href?: string): Raw => {
  const inner = h`<b class="n">${num(value)}</b><span class="l">${label}</span><span class="d">${note}</span>`;
  return href === undefined ? h`<div class="stat">${inner}</div>` : h`<a class="stat" href="${href}">${inner}</a>`;
};

// ----- 한도·미룸 집계 (task_transition 이유 문구로만 센다: 스키마에 따로 기록한 곳이 없다) -----
const LIMIT_REASON = /usage_limit|server_limited/;

interface LimitFacts {
  /** 한도 도달로 사람 검토에 멈춰 있는 업무 수 */
  stopped: number;
  /** 이번 주 사람 우선 게이트로 미뤄진 run 수 */
  deferredThisWeek: number;
}

function limitFacts(ctx: ReviewContext, sinceIso: string): LimitFacts {
  const rows = ctx.db.all<{ reason: string }>(
    `SELECT (SELECT reason FROM task_transition x WHERE x.task_id = t.id ORDER BY x.id DESC LIMIT 1) AS reason FROM task t WHERE t.status = 'needs_review'`,
  );
  const deferred = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task_transition WHERE at >= ? AND reason LIKE '%killed: deferred:%'", [sinceIso]);
  return { stopped: rows.filter((r) => LIMIT_REASON.test(r.reason ?? '')).length, deferredThisWeek: Number(deferred?.n ?? 0) };
}

type TaskLine = { id: string; objective: string; status: string; role: string | null; started_at: string | null; updated_at: string; reason: string | null };

const taskSelect = `SELECT t.id, t.objective, t.status, r.slug AS role, t.updated_at,
  (SELECT started_at FROM task_run u WHERE u.task_id = t.id AND u.outcome IS NULL LIMIT 1) AS started_at,
  (SELECT reason FROM task_transition x WHERE x.task_id = t.id ORDER BY x.id DESC LIMIT 1) AS reason
  FROM task t LEFT JOIN role r ON r.id = t.role_id`;

// ----- /now -----
export function nowPage(ctx: ReviewContext): Rendered {
  const nowMs = ctx.clock.nowMs();
  const { decisions, problem } = buildInbox(ctx);
  const running = ctx.db.all<TaskLine>(`${taskSelect} WHERE t.status IN ('queued','running','validating','retry_wait') ORDER BY t.updated_at DESC, t.id LIMIT 30`);
  const blocked = ctx.db.all<TaskLine>(`${taskSelect} WHERE t.status IN ('needs_review','unassigned') ORDER BY t.updated_at DESC, t.id LIMIT 30`);
  const done = ctx.db.all<TaskLine>(`${taskSelect} WHERE t.status = 'completed' ORDER BY t.updated_at DESC, t.id LIMIT 10`);
  const counts = ctx.db.get<{ running: number; blocked: number }>(
    `SELECT SUM(status IN ('queued','running','validating','retry_wait')) AS running, SUM(status IN ('needs_review','unassigned')) AS blocked FROM task`,
  );
  const limits = limitFacts(ctx, new Date(nowMs - WEEK_MS).toISOString());
  const limitLine = limits.stopped > 0
    ? `한도에 닿아 멈춘 업무가 ${limits.stopped}건 있습니다. 한도가 풀리는 시각은 알 수 없고, 저절로 다시 시작되지 않습니다.`
    : limits.deferredThisWeek > 0 ? `한도에 닿아 멈춘 업무는 없습니다. 이번 주 ${limits.deferredThisWeek}번은 사람이 쓰는 몫을 남기려고 실행을 미뤘습니다.` : '한도에 닿아 멈춘 업무는 없습니다.';
  const decisionTitle = decisions.length === 0 ? '지금 결정할 일이 없습니다.' : `결정할 일이 ${decisions.length}건 있습니다.`;
  const line = (task: TaskLine, extra: string): Raw => h`<li><b>${task.role ?? '역할 없음'}</b> — ${safe(task.objective)} <span class="mute">(${extra})</span></li>`;
  const section = (title: string, rows: readonly TaskLine[], extra: (task: TaskLine) => string, empty: string): Raw => h`<h2 class="grp">${title}</h2>${rows.length === 0 ? h`<p class="empty">${empty}</p>` : h`<ul class="facts">${rows.map((task) => line(task, extra(task)))}</ul>`}`;
  return {
    title: '지금', status: 200, refresh: REFRESH_SECONDS,
    body: h`<p class="lead">${decisionTitle}</p>${problem === null ? '' : h`<p class="card">${problem}</p>`}
      <div class="stats">${stat(decisions.length, '결정할 일', '사람이 정해야 하는 일', '/')}${stat(Number(counts?.running ?? 0), '진행 중', '실행·대기·검증 중인 업무')}${stat(Number(counts?.blocked ?? 0), '막힌 일', '사람 검토나 역할이 필요한 업무')}${stat(limits.stopped, '한도로 멈춤', '구독 한도에 닿아 멈춘 업무', '/cost')}</div>
      <p class="mute">${limitLine}</p>
      ${section('진행 중인 업무', running, (task) => `${STATUS_LABEL[task.status] ?? '진행 중'}${task.started_at === null ? '' : ` · 시작 후 ${elapsed(task.started_at, nowMs)}`}`, '지금 진행 중인 업무가 없습니다.')}
      ${section('막힌 일', blocked, (task) => `${STATUS_LABEL[task.status] ?? '멈춤'}${LIMIT_REASON.test(task.reason ?? '') ? ' · 한도로 멈춤' : ''} · ${ago(task.updated_at, nowMs)}부터`, '막힌 업무가 없습니다.')}
      ${section('최근 완료', done, (task) => `${when(task.updated_at, nowMs)} 완료`, '아직 완료된 업무가 없습니다.')}
      ${details(h`<p class="mute">화면에 나오는 업무와 같은 순서의 업무 번호입니다. 업무 번호로 증거 목록(<a href="/evidence">증거</a>)을 찾을 수 있습니다.</p>${table(['업무 번호', '상태 코드'], [...running, ...blocked, ...done].map((task) => [task.id, task.status]), '없음')}`)}
      ${refreshNote(nowMs)}`,
  };
}

// ----- /org -----
type UnitRow = { id: string; slug: string; name: string; lifecycle: string; responsibility: string; parent_name: string | null };
type RoleRow = { id: string; org_unit_id: string; slug: string; description: string; allowed_tools: string; lifecycle: string; version: number };

const LIFECYCLE_LABEL: Readonly<Record<string, string>> = { proposed: '제안됨', trial: '시험 중', active: '사용 중', retired: '종료됨' };
const lifecycleBadge = (value: string): Raw => badge(LIFECYCLE_LABEL[value] ?? '알 수 없음', value === 'active' ? 'ok' : value === 'trial' ? 'info' : value === 'retired' ? 'mute' : 'warn');

/** 역할이 요청할 수 있는 도구 수 (JSON 목록 길이. 읽을 수 없으면 null) */
function toolCount(json: string): number | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

export function orgPage(ctx: ReviewContext): Rendered {
  const nowIso = ctx.clock.nowIso();
  const units = ctx.db.all<UnitRow>('SELECT u.id, u.slug, u.name, u.lifecycle, u.responsibility, p.name AS parent_name FROM org_unit u LEFT JOIN org_unit p ON p.id = u.parent_id ORDER BY u.created_at, u.id');
  const roles = ctx.db.all<RoleRow>('SELECT id, org_unit_id, slug, description, allowed_tools, lifecycle, version FROM role ORDER BY created_at, id');
  const staffed = new Map(ctx.db.all<{ role_id: string; n: number }>('SELECT role_id, COUNT(*) AS n FROM role_assignment WHERE valid_from <= ? AND (valid_until IS NULL OR valid_until > ?) GROUP BY role_id', [nowIso, nowIso]).map((r) => [r.role_id, Number(r.n)]));
  if (units.length === 0) return { title: '조직·역할', status: 200, body: h`<p class="empty">아직 등록된 부서가 없습니다.</p>` };
  const live = roles.filter((r) => r.lifecycle !== 'retired').length;
  return {
    title: '조직·역할', status: 200,
    body: h`<p class="lead">부서 ${units.length}곳, 역할 ${live}개가 있습니다. 역할이 열 수 있는 도구 수는 그 역할이 요청할 수 있는 최대치이고, 실제로 쓸 수 있는지는 정책이 호출마다 정합니다.</p>
      ${units.map((unit) => {
        const mine = roles.filter((r) => r.org_unit_id === unit.id);
        return h`<section class="card"><h3>${safe(unit.name, 40)} ${lifecycleBadge(unit.lifecycle)}</h3><p class="mute">${safe(unit.responsibility, 120)}</p>
          ${mine.length === 0 ? h`<p class="empty">이 부서에는 아직 역할이 없습니다.</p>` : table(['역할', '단계', '열린 도구', '맡은 담당자'], mine.map((role) => {
            const tools = toolCount(role.allowed_tools);
            return [h`${role.slug}<br><span class="mute">${safe(role.description, 70)}</span>`, lifecycleBadge(role.lifecycle), tools === null ? '알 수 없음' : `${tools}개`, `${staffed.get(role.id) ?? 0}명`];
          }))}
          ${details(kv([['부서 이름표', unit.slug], ['상위 부서', unit.parent_name === null ? '없음' : safe(unit.parent_name, 40)], ['역할 버전', mine.map((r) => `${r.slug} v${r.version}`).join(', ') || '-']]))}</section>`;
      })}
      <p class="mute">조직을 바꾸자는 제안은 <a href="/">결정할 일</a>에서 결정합니다. 이 화면에서는 바꿀 수 없습니다.</p>`,
  };
}

// ----- /sites -----
function declaredSites(ctx: ReviewContext): { sites: readonly McpSiteManifest[]; problem: string | null; configured: boolean } {
  if (ctx.mcpSites === undefined || ctx.mcpSites === null) return { sites: [], problem: null, configured: false };
  try {
    return { sites: parseMcpSites(ctx.mcpSites), problem: null, configured: true };
  } catch {
    return { sites: [], problem: '데몬 설정의 사이트 선언을 읽지 못했습니다. 설정 파일을 확인해 주세요.', configured: true };
  }
}

const IMPACT_LABEL = (tool: McpSiteManifest['tools'][number]): string => (tool.impact === 'read' ? '읽기만 함' : tool.approval === 'draft' ? '바깥에 영향 · 초안 승인 필요' : '바깥에 영향');

export function sitesPage(ctx: ReviewContext): Rendered {
  const nowMs = ctx.clock.nowMs();
  const { sites, problem, configured } = declaredSites(ctx);
  const effects = new Map<string, { n: number; failed: number; last: string }>();
  for (const row of ctx.db.all<{ tool: string; n: number; failed: number; last: string }>(
    `SELECT tool, COUNT(*) AS n, SUM(state IN ('failed','unknown')) AS failed, MAX(at) AS last FROM external_effect WHERE tool LIKE 'mcp\\_%' ESCAPE '\\' GROUP BY tool`,
  )) effects.set(row.tool, { n: Number(row.n), failed: Number(row.failed ?? 0), last: row.last });
  const unknown = h`<p class="card">${badge('상태 확인 불가', 'warn')} 연결됨·끊김과 도구의 열림·닫힘은 데몬만 알고 DB 에 남지 않습니다. 이 화면은 지금 읽을 수 있는 선언 목록과 마지막으로 바깥에 영향을 준 호출 기록만 보입니다. 닫힌 도구와 닫힌 이유를 보려면 데몬이 읽기 응답을 내야 합니다.</p>`;
  if (!configured) return { title: '사이트 연결', status: 200, body: h`${unknown}<p class="empty">데몬 설정 파일을 찾지 못했거나 사이트 선언이 없습니다. 화면을 시작할 때 <code>--config</code> 로 데몬 설정을 알려 주세요.</p>` };
  if (problem !== null) return { title: '사이트 연결', status: 200, body: h`${unknown}<p class="card">${problem}</p>` };
  if (sites.length === 0) return { title: '사이트 연결', status: 200, body: h`${unknown}<p class="empty">연결하기로 선언한 사이트가 없습니다.</p>` };
  return {
    title: '사이트 연결', status: 200,
    body: h`<p class="lead">선언한 사이트 ${sites.length}곳, 도구 ${sites.reduce((sum, s) => sum + s.tools.length, 0)}개입니다.</p>${unknown}
      ${sites.map((site) => h`<section class="card"><h3>${site.site} ${badge('연결 상태 확인 불가', 'warn')}</h3>
        <p class="mute">선언한 도구 ${site.tools.length}개 · 열림/닫힘은 확인 불가</p>
        ${table(['도구', '하는 일', '바깥에 미친 호출', '마지막 호출'], site.tools.map((tool) => {
          const seen = effects.get(tool.gatewayName);
          return [h`${tool.as}<br><span class="mute">${IMPACT_LABEL(tool)}</span>`, safe(tool.description, 70),
            tool.impact === 'read' ? '기록하지 않음(읽기)' : seen === undefined ? '아직 없음' : `${seen.n}번${seen.failed > 0 ? ` · 실패·불명 ${seen.failed}번` : ''}`,
            seen === undefined ? '-' : when(seen.last, nowMs)];
        }))}
        ${details(table(['도구 이름표', '스키마 해시', '범위'], site.tools.map((tool) => [tool.gatewayName, tool.inputSchemaSha256, tool.scope])))}</section>`)}`,
  };
}

// ----- /cost -----
const TERMS_NOTICE = '구독 자동 실행이 약관에 맞는지는 아직 확인하지 못했습니다(Q4). 이 화면의 숫자는 토큰 수와 사용률뿐이고 금액은 계산하지 않습니다.';
const RUN_LOG_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_LOG_BYTES = 512 * 1024;

export interface LastUsage { percent: string | null; status: string | null; at: string }

/** 가장 최근 run 기록에서 마지막으로 남은 사용률을 찾는다. 어댑터는 임계값(기본 0.8)을 넘을 때만 사용률을 남기므로, 없다고 낮다는 뜻이 아니다 */
export function lastUsage(ctx: ReviewContext): LastUsage | null {
  if (ctx.runLogDir === null) return null;
  const runs = ctx.db.all<{ run_log_ref: string }>("SELECT run_log_ref FROM task_run WHERE run_log_ref LIKE 'run-log:%' ORDER BY started_at DESC, id DESC LIMIT 20");
  for (const run of runs) {
    const id = run.run_log_ref.slice('run-log:'.length);
    if (!RUN_LOG_ID.test(id)) continue;
    const file = join(ctx.runLogDir, `${id}.jsonl`);
    try {
      if (!existsSync(file) || statSync(file).size > MAX_LOG_BYTES) continue;
      let found = null as LastUsage | null;
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        if (!raw.includes('usage_warning')) continue;
        const entry = JSON.parse(raw) as { at?: unknown; message?: unknown };
        const message = String(entry.message ?? '');
        const reached = /utilization reached ([0-9.]+)/.exec(message);
        const status = /rate limit status was '([^']{1,30})'/.exec(message);
        if (reached === null && status === null) continue;
        const value = reached === null ? null : Number(reached[1]);
        found = { percent: value === null || !Number.isFinite(value) ? (found?.percent ?? null) : `${Math.round((value > 1 ? value : value * 100) * 10) / 10}%`, status: status?.[1] ?? found?.status ?? null, at: String(entry.at ?? '') };
      }
      if (found !== null) return found;
    } catch {
      continue;
    }
  }
  return null;
}

export function costPage(ctx: ReviewContext): Rendered {
  const nowMs = ctx.clock.nowMs();
  const sinceIso = new Date(nowMs - WEEK_MS).toISOString();
  const tokenExpr = "CASE WHEN json_valid(c.units) THEN COALESCE(json_extract(c.units, '$.tokens'), 0) ELSE 0 END";
  const byRole = ctx.db.all<{ role: string | null; tokens: number }>(`SELECT r.slug AS role, SUM(${tokenExpr}) AS tokens FROM cost_entry c LEFT JOIN task t ON t.id = c.task_id LEFT JOIN role r ON r.id = t.role_id WHERE c.at >= ? GROUP BY r.slug HAVING tokens > 0 ORDER BY tokens DESC LIMIT 20`, [sinceIso]);
  const byTask = ctx.db.all<{ id: string; objective: string | null; tokens: number }>(`SELECT t.id, t.objective, SUM(${tokenExpr}) AS tokens FROM cost_entry c LEFT JOIN task t ON t.id = c.task_id WHERE c.at >= ? GROUP BY c.task_id HAVING tokens > 0 ORDER BY tokens DESC LIMIT 10`, [sinceIso]);
  const total = byRole.reduce((sum, row) => sum + Number(row.tokens), 0);
  const limits = limitFacts(ctx, sinceIso);
  const usage = lastUsage(ctx);
  const tok = (value: unknown): string => `${new Intl.NumberFormat('ko-KR').format(Math.round(Number(value)))} 토큰`;
  const usageText = usage === null
    ? (ctx.runLogDir === null ? '확인 불가 — 실행 기록 폴더를 알 수 없습니다.' : '기록 없음 — 사용률은 경고 기준을 넘을 때만 남습니다.')
    : `${usage.percent ?? '사용률 기록 없음'}${usage.status === null ? '' : ` · 한도 상태 ${usage.status}`} (${usage.at === '' ? '시각 모름' : when(usage.at, nowMs)} 기록)`;
  return {
    title: '비용·구독', status: 200, refresh: REFRESH_SECONDS,
    body: h`<p class="lead">최근 7일 동안 ${tok(total)}을 썼습니다.</p>
      <div class="stats">${stat(limits.deferredThisWeek, '미뤄진 실행', '사람 몫을 남기려고 시작을 미룬 횟수(최근 7일)')}${stat(limits.stopped, '한도로 멈춘 업무', '지금 사람 검토에 멈춘 업무', '/now')}</div>
      <p class="card">${badge('약관 미확인', 'warn')} ${TERMS_NOTICE}</p>
      <p>마지막으로 본 구독 사용률: <b>${usageText}</b></p>
      <h2 class="grp">역할별 토큰 (최근 7일)</h2>${table(['역할', '토큰'], byRole.map((row) => [row.role ?? '역할 없음', tok(row.tokens)]), '최근 7일 동안 기록된 토큰이 없습니다.')}
      <h2 class="grp">업무별 토큰 (많이 쓴 순, 최대 10개)</h2>${table(['업무', '토큰'], byTask.map((row) => [row.objective === null ? '(업무 없음)' : safe(row.objective, 60), tok(row.tokens)]), '최근 7일 동안 기록된 토큰이 없습니다.')}
      ${details(h`${table(['업무 번호', '토큰'], byTask.map((row) => [row.id ?? '-', tok(row.tokens)]), '없음')}<p class="mute">“최근 7일”은 지금부터 7일 전까지입니다. 달력의 주와 다를 수 있습니다.</p>`)}
      ${refreshNote(nowMs)}`,
  };
}
