// 읽기 전용 검토 화면의 HTML 조립 (docs/operations/review-web.md). 모든 동적 값은 태그드 템플릿 `h` 가 *기본으로* 비밀 가리기 → HTML 이스케이프를 거친다.
// DB 의 값(에이전트 출력·증거·외부 입력)은 모두 신뢰하지 않는다(trust-boundaries). HTML 로 넣으려면 `raw()` 를 명시해야 하고, `raw()` 는 이 디렉터리의 고정 마크업에만 쓴다.
import { maskString } from '@aot/agent-runtime';

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

/** 화면에 보이는 텍스트: 비밀 모양을 가리고 이스케이프하고 길이를 자른다 */
export function text(value: unknown, max = 4000): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return escapeHtml(maskString(s));
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

/** 쉘에 그대로 붙여 넣어도 안전한 인자 (평범한 값은 그대로, 아니면 작은따옴표) */
export const shellArg = (value: string): string => (/^[A-Za-z0-9._:@/=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

export const APPROVE_CLI = 'node apps/daemon/src/approve.ts';

/** 복사해 쓰는 명령 상자. 명령 문자열은 이스케이프된다 */
export const command = (line: string, note?: string): Raw => h`<div class="cmd"><code>${line}</code>${note === undefined ? '' : h`<span class="note">${note}</span>`}</div>`;

export const badge = (label: string, tone: 'ok' | 'warn' | 'bad' | 'info' | 'mute' = 'mute'): Raw => h`<span class="badge ${tone}">${label}</span>`;

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

const NAV: readonly (readonly [string, string])[] = [
  ['/', '홈'], ['/approvals', '승인 대기'], ['/trials', '시험 현황'], ['/signals', '조직 신호'], ['/products', '상품 등록 검토'],
  ['/experiments', '실험 결과'], ['/effects', '외부 효과 확인'], ['/evidence', '증거 보기'],
];

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c2330;--mute:#5d6778;--card:#fff;--line:#d9dee6;--accent:#2457c5;--ok:#17783a;--warn:#9a5b00;--bad:#b3261e;--code:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#12161d;--fg:#e6e9ef;--mute:#9aa4b5;--card:#1b212b;--line:#2f3846;--accent:#7aa2ff;--ok:#5dd28a;--warn:#f0b050;--bad:#ff8a80;--code:#10141b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;position:sticky;top:0}
header strong{margin-right:12px}nav{display:flex;flex-wrap:wrap;gap:4px 14px}nav a{color:var(--accent);text-decoration:none}nav a:hover{text-decoration:underline}
main{max-width:1000px;margin:0 auto;padding:16px}h1{font-size:22px;margin:8px 0 14px}h2{font-size:17px;margin:22px 0 8px}h3{font-size:15px;margin:14px 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}.grid a.card{display:block;color:inherit;text-decoration:none}.grid a.card:hover{border-color:var(--accent)}
.big{font-size:28px;font-weight:700}.mute{color:var(--mute)}.empty{color:var(--mute)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--mute);font-weight:600;white-space:nowrap}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:6px 0}dt{color:var(--mute)}dd{margin:0;word-break:break-word}
.badge{display:inline-block;border-radius:999px;padding:0 9px;font-size:12px;border:1px solid var(--line);white-space:nowrap}.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.warn{color:var(--warn);border-color:var(--warn)}.badge.bad{color:var(--bad);border-color:var(--bad)}.badge.info{color:var(--accent);border-color:var(--accent)}
.untrusted{border-left:4px solid var(--warn);padding-left:10px}
.cmd{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:6px 0;overflow-x:auto}.cmd code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;user-select:all}.cmd .note{display:block;color:var(--mute);font-size:12px;margin-top:2px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:480px}
img.evidence{max-width:100%;max-height:480px;border:1px solid var(--line);border-radius:6px;background:#fff}
svg.chart{max-width:100%;height:auto}svg.chart text{fill:var(--fg);font-size:12px}svg.chart .axis{stroke:var(--line)}svg.chart .b1{fill:var(--accent)}svg.chart .b2{fill:var(--mute)}svg.chart .line{stroke:var(--accent);fill:none;stroke-width:2}svg.chart .ref{stroke:var(--bad);stroke-dasharray:4 3}
.banner{background:var(--code);border:1px dashed var(--line);border-radius:8px;padding:6px 12px;color:var(--mute);font-size:13px}
`;

export function page(title: string, body: Raw): string {
  return h`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 검토 화면</title><style>${raw(STYLE)}</style></head>
<body><header><strong>AoT 검토 화면 (읽기 전용)</strong><nav>${NAV.map(([href, label]) => h`<a href="${href}">${label}</a>`)}</nav></header>
<main><h1>${title}</h1>${body}
<p class="banner">이 화면은 아무것도 바꾸지 못한다. 결정은 위에 보인 명령을 승인 CLI 로 직접 실행한다. 행위자는 <code>--actor</code> 또는 <code>AOT_ACTOR</code> 로 준다.</p></main></body></html>`.html;
}

export const back = (href: string, label: string): Raw => h`<p><a href="${href}">← ${label}</a></p>`;

/** 내부 이동 링크. 경로 조각은 인코딩하고 값은 이스케이프한다 */
export const link = (path: readonly string[], label: unknown, query = ''): Raw => h`<a href="/${path.map(encodeURIComponent).join('/')}${query}">${label}</a>`;
