// 읽기 전용 검토 화면의 HTML 조립 (docs/operations/review-web.md). 모든 동적 값은 태그드 템플릿 `h` 가 *기본으로* 비밀 가리기 → HTML 이스케이프를 거친다.
// DB 의 값(에이전트 출력·증거·외부 입력)은 모두 신뢰하지 않는다(trust-boundaries). HTML 로 넣으려면 `raw()` 를 명시해야 하고, `raw()` 는 이 디렉터리의 고정 마크업에만 쓴다.
import { maskSecrets, maskString, type JsonValue } from '@aot/agent-runtime';

/** 이미 안전한 마크업 (이 모듈의 조립 결과만). 문자열을 직접 `raw()` 로 감싸지 않는다 */
export class Raw {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
  toString(): string {
    return this.html;
  }
}

export const raw = (html: string): Raw => new Raw(html);

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);

/** 화면에 보이는 텍스트: 먼저 비밀 모양을 가리고(자르기 전에 — 잘린 비밀 앞부분이 남지 않게), 그다음 길이를 자르고, 이스케이프한다. 잘리면 보이게 표시한다 */
export function text(value: unknown, max = 4000, note = true): string {
  const masked = maskString(value === null || value === undefined ? '' : String(value));
  if (masked.length <= max) return escapeHtml(masked);
  return escapeHtml(masked.slice(0, max)) + (note ? escapeHtml(` …(이하 생략: 전체 ${masked.length}자 중 ${max}자만 보인다)`) : '…');
}

/** 긴 본문(증거 텍스트·JSON)용: 보여 주는 상한을 크게 잡는다. 그래도 넘으면 생략 표시가 붙는다 */
export const full = (value: unknown, max = 60_000): Raw => new Raw(text(value, max));

/** DB 에서 읽은 JSON 값을 화면용 문자열로: 키 이름 기반 비밀 가리기(maskSecrets)를 먼저 하고 들여쓴다 */
export function prettyJson(value: unknown): string {
  return JSON.stringify(maskSecrets(value as JsonValue), null, 2) ?? '';
}

function part(value: unknown): string {
  if (value instanceof Raw) return value.html;
  if (Array.isArray(value)) return value.map(part).join('');
  if (value === false || value === null || value === undefined) return '';
  return text(value);
}

/** 태그드 템플릿: 보간 값은 Raw 가 아니면 가리고 이스케이프한다 */
export function h(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += part(value) + (strings[index + 1] ?? '');
  });
  return new Raw(out);
}

/** 정수 카운트 등 숫자만 */
export const num = (value: unknown): string => {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 10_000) / 10_000) : '-';
};

export const badge = (label: string, tone: 'ok' | 'warn' | 'bad' | 'info' | 'mute' = 'mute'): Raw => h`<span class="badge ${tone}">${label}</span>`;

/** 배지 한 줄 (여러 개면 나란히). 없으면 빈 마크업 */
export const badgeRow = (items: readonly { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'mute' }[]): Raw => (items.length === 0 ? h`` : h`<p>${items.map((b) => h`${badge(b.label, b.tone)} `)}</p>`);

export function table(headers: readonly string[], rows: readonly (readonly unknown[])[], empty = '없음'): Raw {
  if (rows.length === 0) return h`<p class="empty">${empty}</p>`;
  return h`<div class="scroll"><table><thead><tr>${headers.map((header) => h`<th>${header}</th>`)}</tr></thead><tbody>${rows.map((row) => h`<tr>${row.map((cell) => h`<td>${cell}</td>`)}</tr>`)}</tbody></table></div>`;
}

export function kv(pairs: readonly (readonly [string, unknown])[]): Raw {
  return h`<dl>${pairs.map(([key, value]) => h`<dt>${key}</dt><dd>${value}</dd>`)}</dl>`;
}

export function list(items: readonly unknown[], empty = '없음'): Raw {
  return items.length === 0 ? h`<p class="empty">${empty}</p>` : h`<ul>${items.map((item) => h`<li>${item}</li>`)}</ul>`;
}

const NAV: readonly (readonly [string, string])[] = [['/', '결정할 일'], ['/now', '지금'], ['/org', '조직'], ['/sites', '사이트'], ['/cost', '비용'], ['/watch', '지켜보는 중'], ['/evidence', '증거']];

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d2330;--mute:#5f6878;--card:#fff;--line:#dcdfe5;--accent:#1f4fc4;--ok:#17703a;--warn:#8a5300;--bad:#b3261e;--code:#eef0f4}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--fg:#e8eaf0;--mute:#a0a8b8;--card:#1c2129;--line:#323a48;--accent:#8fb0ff;--ok:#6cd696;--warn:#f2b660;--bad:#ff9a90;--code:#10131a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px}
nav{max-width:720px;margin:0 auto;display:flex;gap:6px 18px;flex-wrap:wrap}nav a{color:var(--mute);text-decoration:none;padding:2px 0}nav a:hover{color:var(--accent)}
main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:24px;line-height:1.4;margin:12px 0 10px;color:var(--accent)}h2{font-size:18px;margin:34px 0 10px}h3{font-size:16px;margin:16px 0 6px}
.lead{font-size:17px;margin:0 0 14px}.mute{color:var(--mute)}.empty{color:var(--mute)}
.facts{list-style:none;margin:10px 0 14px;padding:0}.facts li{padding:5px 0 5px 4px;border-bottom:1px solid var(--line)}.facts b{display:inline-block;min-width:4.5em;color:var(--mute);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:14px 0}
.card h3{font-size:18px;margin:0 0 6px;color:var(--accent);line-height:1.45}a.card{display:block;color:inherit;text-decoration:none}a.card:hover,a.card:focus-visible{border-color:var(--accent)}
a{color:var(--accent)}
.badge{display:inline-block;border-radius:999px;padding:1px 11px;font-size:14px;border:1px solid var(--line);white-space:nowrap}.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.warn{color:var(--warn);border-color:var(--warn)}.badge.bad{color:var(--bad);border-color:var(--bad)}.badge.info{color:var(--accent);border-color:var(--accent)}
.decide{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 16px 12px;margin:18px 0}.decide h2{font-size:15px;margin:4px 0 8px;color:var(--mute)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0}.row>span:not(.btn){font-size:14px}.rnote{color:var(--mute);font-size:13px}
.btn{flex:none;min-width:5.2em;text-align:center;border-radius:8px;padding:6px 14px;font:inherit;font-weight:600;font-size:15px;border:1px solid var(--line);background:var(--card);color:var(--fg)}button.btn{cursor:pointer}button.btn:hover,button.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.btn.yes{background:var(--ok);color:#fff;border-color:var(--ok)}.btn.no{color:var(--bad);border-color:var(--bad)}.btn.na{color:var(--mute)}.btn.ch{color:var(--warn);border-color:var(--warn)}
form.act{margin:10px 0;padding-bottom:6px;border-bottom:1px solid var(--line)}form.act:last-of-type{border-bottom:0}.fld{display:block;font-size:14px;color:var(--mute);margin:6px 0}.fld textarea,.fld input,.why textarea{display:block;width:100%;margin-top:4px;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px}.why{margin:6px 0;border:0;padding:0}.why summary{font-weight:400;font-size:14px}.why textarea{margin:6px 0}
.hist{list-style:none;margin:8px 0 14px;padding:0;color:var(--mute);font-size:14px}.hist li{padding:2px 0}
h2.grp{font-size:17px;margin:28px 0 4px}.summary{color:var(--mute);margin:0 0 6px}
details{margin:26px 0;border-top:1px solid var(--line);padding-top:10px}summary{cursor:pointer;font-weight:600;color:var(--mute)}details h2{font-size:16px;margin:20px 0 6px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--mute);font-weight:600;white-space:nowrap}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:6px 0;font-size:14px}dt{color:var(--mute)}dd{margin:0;word-break:break-word}
.untrusted{border-left:4px solid var(--warn);padding-left:12px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:420px;font-size:13px}
img.evidence{max-width:100%;max-height:420px;border:1px solid var(--line);border-radius:8px;background:#fff}img.thumb{width:140px;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff;display:block;margin:6px 0}
svg.chart{max-width:100%;height:auto}svg.chart text{fill:var(--fg);font-size:12px}svg.chart .axis{stroke:var(--line)}svg.chart .b1{fill:var(--accent)}svg.chart .b2{fill:var(--mute)}svg.chart .line{stroke:var(--accent);fill:none;stroke-width:2}svg.chart .ref{stroke:var(--bad);stroke-dasharray:4 3}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0}.stat{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;color:inherit;text-decoration:none}a.stat:hover,a.stat:focus-visible{border-color:var(--accent)}.stat .n{display:block;font-size:40px;line-height:1.1;color:var(--accent)}.stat .l{display:block;font-weight:600}.stat .d{display:block;color:var(--mute);font-size:13px}.stamp{font-size:13px;margin-top:28px}
.banner{color:var(--mute);font-size:13px;margin-top:40px}
@media (max-width:520px){h1{font-size:21px}main{padding:14px 12px 40px}.card{padding:14px}}
`;

export function page(title: string, body: Raw, options: { mode?: 'decide' | 'readonly' | 'none'; notice?: string | null; refresh?: number } = {}): string {
  const mode = options.mode ?? 'none';
  const banner = mode === 'decide' ? h`<p class="banner">결정은 이 화면의 버튼으로 합니다. 결정한 내용은 승인 엔진이 확인하고 기록합니다.</p>`
    : mode === 'readonly' ? h`<p class="banner">이 화면은 보기 전용입니다.${options.notice === undefined || options.notice === null ? '' : h` ${options.notice}`}</p>` : h``;
  return h`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${options.refresh === undefined ? '' : h`<meta http-equiv="refresh" content="${String(Math.round(options.refresh))}">`}<title>${title} · 검토 화면</title><style>${raw(STYLE)}</style></head>
<body><header><nav>${NAV.map(([href, label]) => h`<a href="${href}">${label}</a>`)}</nav></header>
<main><h1>${title}</h1>${body}
${banner}</main></body></html>`.html;
}

export const back = (href: string, label: string): Raw => h`<p><a href="${href}">← ${label}</a></p>`;

/** 첫 화면의 핵심 사실 줄 (최대 3). [이름, 내용] */
export function facts(items: readonly (readonly [string, unknown])[]): Raw {
  return items.length === 0 ? h`` : h`<ul class="facts">${items.map(([name, body]) => h`<li><b>${name}</b> ${body}</li>`)}</ul>`;
}

/** 접힌 "자세히" 구역 */
export const details = (body: Raw, label = '자세히'): Raw => h`<details><summary>${label}</summary>${body}</details>`;

/** 내부 이동 링크. 경로 조각은 인코딩하고 값은 이스케이프한다 */
export const link = (path: readonly string[], label: unknown, query = ''): Raw => h`<a href="/${path.map(encodeURIComponent).join('/')}${query}">${label}</a>`;
