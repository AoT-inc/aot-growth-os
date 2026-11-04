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

const NAV: readonly (readonly [string, string])[] = [['/', '결정할 일'], ['/watch', '지켜보는 중'], ['/evidence', '증거']];

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d2330;--mute:#5f6878;--card:#fff;--line:#dcdfe5;--accent:#1f4fc4;--ok:#17703a;--warn:#8a5300;--bad:#b3261e;--code:#eef0f4}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--fg:#e8eaf0;--mute:#a0a8b8;--card:#1c2129;--line:#323a48;--accent:#8fb0ff;--ok:#6cd696;--warn:#f2b660;--bad:#ff9a90;--code:#10131a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px}
nav{max-width:720px;margin:0 auto;display:flex;gap:22px}nav a{color:var(--mute);text-decoration:none;padding:2px 0}nav a:hover{color:var(--accent)}
main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:24px;line-height:1.4;margin:12px 0 10px;color:var(--accent)}h2{font-size:18px;margin:34px 0 10px}h3{font-size:16px;margin:16px 0 6px}
.lead{font-size:17px;margin:0 0 14px}.mute{color:var(--mute)}.empty{color:var(--mute)}
.facts{list-style:none;margin:10px 0 14px;padding:0}.facts li{padding:5px 0 5px 4px;border-bottom:1px solid var(--line)}.facts b{display:inline-block;min-width:4.5em;color:var(--mute);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:14px 0}
.card h3{font-size:18px;margin:0 0 6px;color:var(--accent);line-height:1.45}.card .go{display:inline-block;margin-top:6px;font-weight:600;color:var(--accent)}
a{color:var(--accent)}
.badge{display:inline-block;border-radius:999px;padding:1px 11px;font-size:14px;border:1px solid var(--line);white-space:nowrap}.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.warn{color:var(--warn);border-color:var(--warn)}.badge.bad{color:var(--bad);border-color:var(--bad)}.badge.info{color:var(--accent);border-color:var(--accent)}
.choice{border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:12px 0;background:var(--card)}.choice h3{margin:0 0 6px;font-size:16px}.choice.no h3{color:var(--bad)}.choice.yes h3{color:var(--ok)}.choice.na h3{color:var(--mute)}
.cmd{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:6px 0;overflow-x:auto}.cmd code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;user-select:all}.cmd .note{display:block;color:var(--mute);font-size:13px;margin-top:2px}
details{margin:26px 0;border-top:1px solid var(--line);padding-top:10px}summary{cursor:pointer;font-weight:600;color:var(--mute)}details h2{font-size:16px;margin:20px 0 6px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--mute);font-weight:600;white-space:nowrap}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:6px 0;font-size:14px}dt{color:var(--mute)}dd{margin:0;word-break:break-word}
.untrusted{border-left:4px solid var(--warn);padding-left:12px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:420px;font-size:13px}
img.evidence{max-width:100%;max-height:420px;border:1px solid var(--line);border-radius:8px;background:#fff}img.thumb{width:140px;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff;display:block;margin:6px 0}
svg.chart{max-width:100%;height:auto}svg.chart text{fill:var(--fg);font-size:12px}svg.chart .axis{stroke:var(--line)}svg.chart .b1{fill:var(--accent)}svg.chart .b2{fill:var(--mute)}svg.chart .line{stroke:var(--accent);fill:none;stroke-width:2}svg.chart .ref{stroke:var(--bad);stroke-dasharray:4 3}
.banner{color:var(--mute);font-size:13px;margin-top:40px}
@media (max-width:520px){h1{font-size:21px}main{padding:14px 12px 40px}.card{padding:14px}}
`;

export function page(title: string, body: Raw): string {
  return h`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 검토 화면</title><style>${raw(STYLE)}</style></head>
<body><header><nav>${NAV.map(([href, label]) => h`<a href="${href}">${label}</a>`)}</nav></header>
<main><h1>${title}</h1>${body}
<p class="banner">읽기 전용 화면입니다. 결정은 위의 명령을 승인 CLI 로 직접 실행합니다. 행위자는 <code>--actor</code> 또는 <code>AOT_ACTOR</code> 로 줍니다.</p></main></body></html>`.html;
}

export const back = (href: string, label: string): Raw => h`<p><a href="${href}">← ${label}</a></p>`;

/** 첫 화면의 핵심 사실 줄 (최대 3). [이름, 내용] */
export function facts(items: readonly (readonly [string, unknown])[]): Raw {
  return items.length === 0 ? h`` : h`<ul class="facts">${items.map(([name, body]) => h`<li><b>${name}</b> ${body}</li>`)}</ul>`;
}

/** 접힌 "자세히" 구역 */
export const details = (body: Raw, label = '자세히'): Raw => h`<details><summary>${label}</summary>${body}</details>`;

export interface Choices {
  /** 승인 선택. 명령이 없으면 못 하는 이유(`blocked`)를 보인다 */
  approve?: { label?: string; command: string; note?: string } | { blocked: string } | undefined;
  reject?: { label?: string; command: string; note?: string } | { blocked: string } | undefined;
  /** 그 밖의 안내 (예: 대기 중 취소) */
  extra?: Raw | undefined;
}

/** 승인·거절 두 선택. 명령은 복사하기 쉬운 상자 안에만 둔다 */
export function choices(c: Choices): Raw {
  const one = (kind: 'yes' | 'no', fallback: string, entry: Choices['approve']): Raw => {
    if (entry === undefined) return h``;
    if ('blocked' in entry) return h`<div class="choice na"><h3>${fallback}할 수 없습니다</h3><p>${entry.blocked}</p></div>`;
    return h`<div class="choice ${kind}"><h3>${entry.label ?? fallback}</h3>${command(entry.command, entry.note)}</div>`;
  };
  return h`${one('yes', '승인', c.approve)}${one('no', '거절', c.reject)}${c.extra ?? ''}`;
}


/** 내부 이동 링크. 경로 조각은 인코딩하고 값은 이스케이프한다 */
export const link = (path: readonly string[], label: unknown, query = ''): Raw => h`<a href="/${path.map(encodeURIComponent).join('/')}${query}">${label}</a>`;
