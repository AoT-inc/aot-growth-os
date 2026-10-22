// 읽기 전용 조사 에이전트의 판단 코드 (단계 A5 U5). 컨테이너 안에서 돌고, 모델 호출이 없는 결정론적 코드다(모델 호출은 Q26 남은 위험 5, Phase A 범위 밖).
//  - 입력: `start` 프레임의 task_spec. 조사 대상은 `inputs[]` 의 기존 필드만 읽는다(새 스키마 필드 없음):
//      · `{kind:'source_url', name, ref:<URL>}`     읽을 출처 페이지 (http/https)
//      · `{kind:'quote', name:<출처 name>, ref:<인용문>}`  그 출처에 이 인용문이 있는지 확인 (관례. task_spec 스키마에 인용문 전용 필드가 없다 — 보고 대상)
//  - 동작: 허용 도구 `fetch_url` 로 출처마다 한 번 페이지를 가져와(같은 URL 은 한 번) 상태 코드·해시·발췌·인용 포함 여부를 구조화 결과로 낸다.
//  - 외부 페이지 텍스트는 **데이터로만** 쓴다. 이 파일에서 페이지 텍스트가 가는 곳은 (1) 발췌·인용 주변 문맥 문자열, (2) 인용 포함 여부 불리언 — 둘 다 출력일 뿐이다.
//    도구 이름·인자·호출 횟수·다음 행동은 task_spec 의 출처 목록과 허용 도구 목록으로만 정해진다. 링크를 따라가지 않고 지시문을 해석하지 않는다.
//  - 게이트웨이로 나가는 길은 주입된 `fetchUrl` 하나뿐이다. 다른 도구를 부르는 코드 경로가 없다(허용 목록에 `fetch_url` 이 없으면 아무것도 부르지 않고 오류로 끝난다).
// 이 파일은 컨테이너 이미지에 그대로 들어가므로(Dockerfile) `../../src/wire.ts` 외에는 import 하지 않는다. 프레임 입출력은 agent.ts 가 한다.
import { MAX_FRAME_BYTES } from '../../src/wire.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const FETCH_TOOL = 'fetch_url';
export const FETCH_OPERATION = 'fetch';
export const MAX_SOURCES = 20;
export const MAX_QUOTES_PER_SOURCE = 10;
export const MAX_QUOTE_CHARS = 500;
export const MAX_NAME_CHARS = 100;
export const EXCERPT_CHARS = 300;
export const CONTEXT_CHARS = 80;

export interface StartInfo {
  run_id: string;
  task_spec: JsonObject;
  allowed_tools: { tool: string; operations: string[] }[];
}

export type ToolReply = { ok: true; result: Json } | { ok: false; error: string };

export interface ResearchDeps {
  start: StartInfo;
  /** 게이트웨이의 `fetch_url` 호출. 이 에이전트가 게이트웨이로 나가는 유일한 길이다 */
  fetchUrl(url: string): Promise<ToolReply>;
  /** 시각 (UTC ISO 8601, 밀리초). 컨테이너 진입점이 주입한다 */
  now(): string;
  /** 누적 모델 비용(USD) 진행 보고. 모델을 쓰지 않으므로 값은 0 이다 */
  reportCost(cumulativeUsd: number): void;
  /** stderr 로 가는 진행 로그 (페이지 텍스트를 싣지 않는다) */
  log(message: string): void;
}

export interface ResearchOutput {
  status: 'submitted' | 'error';
  result: JsonObject | null;
  evidence: { kind: 'source_url'; ref: string; captured_at: string; content_hash?: string }[];
  run_log: { at: string; message: string }[];
  cost: { usd: number };
  error?: { code: string; message: string };
}

// ===== 조사 대상 =====

export interface ResearchSource { name: string; url: string }
export interface ResearchQuote { source: string; quote: string }
export interface ResearchTargets {
  sources: ResearchSource[];
  quotes: ResearchQuote[];
  /** 읽지 않고 건너뛴 입력과 사유 (코드만) */
  skipped: { name: string; reason: string }[];
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** task_spec 의 `inputs[]` 에서 조사 대상을 읽는다. 이 함수가 읽는 필드는 `inputs[].kind|name|ref` 뿐이다 */
export function researchTargetsOf(taskSpec: JsonObject): ResearchTargets {
  const sources: ResearchSource[] = [];
  const quotes: ResearchQuote[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const inputs = taskSpec['inputs'];
  if (!Array.isArray(inputs)) return { sources, quotes, skipped };
  for (const item of inputs) {
    if (!isObject(item)) continue;
    const kind = item['kind'];
    const name = typeof item['name'] === 'string' ? item['name'].trim().slice(0, MAX_NAME_CHARS) : '';
    const ref = item['ref'];
    if (kind === 'source_url') {
      if (name === '' || typeof ref !== 'string') {
        skipped.push({ name: name || '(unnamed)', reason: 'invalid_source_input' });
      } else if (!isHttpUrlWithoutUserInfo(ref)) {
        skipped.push({ name, reason: 'invalid_url' });
      } else if (sources.length >= MAX_SOURCES) {
        skipped.push({ name, reason: 'too_many_sources' });
      } else {
        sources.push({ name, url: ref.trim() });
      }
    } else if (kind === 'quote') {
      const quote = typeof ref === 'string' ? ref.trim() : '';
      if (name === '' || quote === '') skipped.push({ name: name || '(unnamed)', reason: 'invalid_quote_input' });
      else quotes.push({ source: name, quote: quote.slice(0, MAX_QUOTE_CHARS) });
    }
  }
  return { sources, quotes, skipped };
}

function isHttpUrlWithoutUserInfo(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** 로그에 남기는 URL: 사용자 정보·쿼리·조각을 뺀 출처와 경로 */
function logUrl(text: string): string {
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`.slice(0, 200);
  } catch {
    return '(unparseable)';
  }
}

// ===== 페이지 응답 읽기 =====

interface Page {
  finalUrl: string;
  status: number;
  contentType: string | null;
  truncated: boolean;
  bytes: number;
  sha256: string | null;
  text: string | null;
  bodySkipped: string | null;
}

/** 도구 결과를 믿지 않고 형태를 확인한다. 맞지 않으면 null */
function pageOf(result: Json): Page | null {
  if (!isObject(result)) return null;
  const { final_url: finalUrl, status, content_type: contentType, truncated, bytes, sha256, text, body_skipped: bodySkipped } = result;
  if (typeof finalUrl !== 'string' || typeof status !== 'number' || !Number.isInteger(status)) return null;
  if (typeof truncated !== 'boolean' || typeof bytes !== 'number') return null;
  if (!(contentType === null || typeof contentType === 'string')) return null;
  if (!(sha256 === null || (typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)))) return null;
  if (!(text === null || typeof text === 'string')) return null;
  if (!(bodySkipped === null || typeof bodySkipped === 'string')) return null;
  return {
    finalUrl: finalUrl.slice(0, 2048), status, contentType: contentType === null ? null : contentType.slice(0, 100), truncated, bytes,
    sha256, text, bodySkipped: bodySkipped === null ? null : bodySkipped.slice(0, 60),
  };
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** 오류 코드 모양(`policy_denied` 등)만 통과시킨다. 그 밖의 문자열은 'error' */
const errorCodeOf = (error: string): string => (/^[a-z][a-z0-9_]{0,59}$/.test(error) ? error : 'error');

interface QuoteReport extends JsonObject { quote: string; found: boolean; context: string | null }
interface SourceReport extends JsonObject { name: string; url: string; fetched: boolean; trust_origin: 'external_untrusted' }

function quoteReports(text: string | null, quotes: readonly ResearchQuote[]): QuoteReport[] {
  const haystack = text === null ? null : collapse(text);
  return quotes.slice(0, MAX_QUOTES_PER_SOURCE).map((entry): QuoteReport => {
    const needle = collapse(entry.quote);
    const at = haystack === null || needle === '' ? -1 : haystack.indexOf(needle);
    return {
      quote: entry.quote,
      found: at >= 0,
      context: at >= 0 && haystack !== null ? haystack.slice(Math.max(0, at - CONTEXT_CHARS), at + needle.length + CONTEXT_CHARS) : null,
    };
  });
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

// ===== 실행 =====

export async function runResearch(deps: ResearchDeps): Promise<ResearchOutput> {
  const runLog: { at: string; message: string }[] = [];
  const note = (message: string): void => {
    runLog.push({ at: deps.now(), message });
    deps.log(message);
  };
  const fail = (code: string, message: string): ResearchOutput => {
    note(`finished: error ${code}`);
    return { status: 'error', result: null, evidence: [], run_log: runLog, cost: { usd: 0 }, error: { code, message } };
  };

  const targets = researchTargetsOf(deps.start.task_spec);
  note(`started ${deps.start.run_id}: ${targets.sources.length} source(s), ${targets.quotes.length} quote(s), ${targets.skipped.length} skipped input(s)`);
  deps.reportCost(0); // 모델 비용은 없다(0). 도구 비용은 게이트웨이가 호출별로 계량한다

  const fetchAllowed = deps.start.allowed_tools.some((tool) => tool.tool === FETCH_TOOL && tool.operations.includes(FETCH_OPERATION));
  if (targets.sources.length > 0 && !fetchAllowed) {
    return fail('fetch_url_not_allowed', `the allowed tools do not include ${FETCH_TOOL}.${FETCH_OPERATION}; nothing was requested`);
  }

  const evidence: ResearchOutput['evidence'] = [];
  const sources: SourceReport[] = [];
  const claims: JsonObject[] = [];
  const cache = new Map<string, Promise<ToolReply>>();
  const evidenced = new Set<string>();
  let fetchedCount = 0;
  let quoteTotal = 0;
  let quoteFound = 0;

  for (const [index, source] of targets.sources.entries()) {
    const quotes = targets.quotes.filter((entry) => entry.source === source.name);
    let reply = cache.get(source.url);
    if (reply === undefined) {
      reply = deps.fetchUrl(source.url); // 출처마다(같은 URL 은 한 번) 호출한다. 호출 횟수는 task_spec 의 출처 목록이 정한다
      cache.set(source.url, reply);
    }
    const response = await reply;
    const page = response.ok ? pageOf(response.result) : null;
    if (!response.ok || page === null) {
      const code = response.ok ? 'invalid_tool_result' : errorCodeOf(response.error);
      sources.push({ name: source.name, url: source.url, fetched: false, fetch_error: code, trust_origin: 'external_untrusted' });
      note(`fetch_url #${index + 1} ${logUrl(source.url)}: failed (${code})`);
      continue;
    }
    fetchedCount += 1;
    const checks = quoteReports(page.text, quotes);
    quoteTotal += checks.length;
    const found = checks.filter((check) => check.found).length;
    quoteFound += found;
    const text = page.text === null ? null : collapse(page.text);
    sources.push({
      name: source.name,
      url: source.url,
      fetched: true,
      final_url: page.finalUrl,
      http_status: page.status,
      reachable: page.status >= 200 && page.status < 400,
      content_type: page.contentType,
      body_skipped: page.bodySkipped,
      truncated: page.truncated,
      bytes: page.bytes,
      content_hash: page.sha256,
      excerpt: text === null ? null : text.slice(0, EXCERPT_CHARS),
      excerpt_truncated: text !== null && text.length > EXCERPT_CHARS,
      quotes: checks,
      trust_origin: 'external_untrusted',
    });
    if (!evidenced.has(source.url)) {
      evidenced.add(source.url);
      evidence.push({ kind: 'source_url', ref: source.url, captured_at: deps.now(), ...(page.sha256 === null ? {} : { content_hash: page.sha256 }) });
    }
    // 인용문이 실제로 있었던 것만 "주장"으로 보고한다. 검증기(A4)가 같은 출처를 원본에서 다시 읽어 확인한다
    checks.forEach((check, qi) => {
      if (check.found) claims.push({ id: `${source.name}#q${qi + 1}`, statement: `The source "${source.name}" contains the quotation.`, source_url: source.url, quote: check.quote });
    });
    note(`fetch_url #${index + 1} ${logUrl(source.url)}: status ${page.status}, ${page.bytes} bytes${page.truncated ? ' (truncated)' : ''}, quotes found ${found}/${checks.length}`);
  }

  const unmatched = targets.quotes.filter((entry) => !targets.sources.some((source) => source.name === entry.source)).length;
  const result: JsonObject = {
    summary: `${fetchedCount} of ${targets.sources.length} source(s) fetched; ${quoteFound} of ${quoteTotal} quotation(s) found`,
    trust_origin: 'external_untrusted',
    counts: {
      sources: targets.sources.length, fetched: fetchedCount, failed: targets.sources.length - fetchedCount,
      quotes_checked: quoteTotal, quotes_found: quoteFound, quotes_without_source: unmatched, skipped_inputs: targets.skipped.length,
    },
    sources,
    claims,
    skipped_inputs: targets.skipped.map((item) => ({ name: item.name, reason: item.reason })),
  };

  // 결과 프레임이 상한을 넘지 않게 한다: 문맥 → 발췌 순으로 줄인다
  const limit = MAX_FRAME_BYTES - 16 * 1024;
  const frameSize = (): number => byteLength({ type: 'result', status: 'submitted', result, evidence, run_log: runLog, cost: { usd: 0 } });
  if (frameSize() > limit) for (const source of sources) if (Array.isArray(source['quotes'])) for (const check of source['quotes'] as QuoteReport[]) check.context = null;
  if (frameSize() > limit) for (const source of sources) if (source.fetched) source['excerpt'] = null;
  if (frameSize() > limit) return fail('result_too_large', 'the result does not fit one frame');

  note('finished: submitted');
  return { status: 'submitted', result, evidence, run_log: runLog, cost: { usd: 0 } };
}
