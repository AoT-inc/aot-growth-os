// 읽기 전용 조사 에이전트의 판단 코드 (단계 A5 U5). 컨테이너 안에서 돌고, 모델 호출이 없는 결정론적 코드다(모델 호출은 Q26 남은 위험 5, Phase A 범위 밖).
//  - 입력: `start` 프레임의 task_spec. 조사 대상은 두 필드에서 읽는다:
//      · `inputs[]` 의 `{kind:'source_url', name, ref:<URL>}`   읽을 출처 페이지 (http/https)
//      · `expected_quotes[]` 의 `{source:<출처 name>, text:<인용문>}`  그 출처에 이 인용문이 있는지 확인 (docs/schema/task-spec.md)
//  - 동작: 허용 도구 `fetch_url` 로 출처마다 한 번 페이지를 가져와(같은 URL 은 한 번) 상태 코드·해시·발췌·인용 포함 여부를 구조화 결과로 낸다.
//    기대 인용문 *전부*에 대해 found/not found 를 낸다(`sources[].quotes[]`, 출처를 못 읽었거나 출처가 없는 인용문도 found:false 로 남는다).
//  - 결과의 `uncertainties: [{topic, note}]` 는 에이전트가 *스스로 아는* 불확실성만 담는다(A6-U12): 건너뛴 입력, 읽지 못한 출처(오류 코드·HTTP 상태), 본문을 읽지 않았거나 잘린 출처,
//    찾지 못했거나 확인하지 못한 기대 인용문. 전부 이미 있는 `skipped_inputs`·`sources[]`·인용문 `found:false` 에서 기계적으로 도출하며 문구는 코드에 고정되어 있다(페이지 텍스트·임의 서술 없음).
//    알려진 불확실성이 없으면 빈 배열이다(필드는 항상 있다). 검사 `uncertainty_listed` 가 호스트에서 이 필드를 확인한다.
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
// 인용문 상한은 task_spec 검증(@aot/domain 의 MAX_EXPECTED_QUOTES*)과 같다. 이 파일은 컨테이너 이미지에 그대로 들어가 domain 을 import 할 수 없으므로 값을 복사했고, 시험이 두 값을 대조한다.
export const MAX_QUOTES_PER_SOURCE = 10;
export const MAX_QUOTES_TOTAL = 200;
export const MAX_QUOTE_CHARS = 500;
export const MAX_NAME_CHARS = 100;
export const EXCERPT_CHARS = 300;
export const CONTEXT_CHARS = 80;
// 불확실성 목록 상한: @aot/evaluation 의 MAX_UNCERTAINTIES·MAX_UNCERTAINTY_TOPIC_CHARS·MAX_UNCERTAINTY_NOTE_CHARS 와 같다(이미지는 그 패키지를 import 할 수 없어 값을 복사했고, 시험이 두 값을 대조한다).
export const MAX_UNCERTAINTIES = 100;
export const MAX_UNCERTAINTY_TOPIC_CHARS = 100;
export const MAX_UNCERTAINTY_NOTE_CHARS = 300;

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
  evidence: { kind: 'source_url'; ref: string; trust_origin: 'external_untrusted'; captured_at: string; content_hash?: string }[];
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
  /** 읽지 않고 건너뛴 입력·인용문과 사유 (코드만) */
  skipped: { name: string; reason: string }[];
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** task_spec 에서 조사 대상을 읽는다. 읽는 필드는 `inputs[].kind|name|ref` 와 `expected_quotes[].source|text` 뿐이다 */
export function researchTargetsOf(taskSpec: JsonObject): ResearchTargets {
  const sources: ResearchSource[] = [];
  const quotes: ResearchQuote[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const inputs = taskSpec['inputs'];
  if (Array.isArray(inputs)) {
    for (const item of inputs) {
      if (!isObject(item) || item['kind'] !== 'source_url') continue;
      const name = typeof item['name'] === 'string' ? item['name'].trim().slice(0, MAX_NAME_CHARS) : '';
      const ref = item['ref'];
      if (name === '' || typeof ref !== 'string') {
        skipped.push({ name: name || '(unnamed)', reason: 'invalid_source_input' });
      } else if (!isHttpUrlWithoutUserInfo(ref)) {
        skipped.push({ name, reason: 'invalid_url' });
      } else if (sources.length >= MAX_SOURCES) {
        skipped.push({ name, reason: 'too_many_sources' });
      } else {
        sources.push({ name, url: ref.trim() });
      }
    }
  }
  const expected = taskSpec['expected_quotes'];
  if (Array.isArray(expected)) {
    const perSource = new Map<string, number>();
    for (const item of expected) {
      const source = isObject(item) && typeof item['source'] === 'string' ? item['source'].trim().slice(0, MAX_NAME_CHARS) : '';
      const text = isObject(item) && typeof item['text'] === 'string' ? item['text'].trim() : '';
      if (source === '' || text === '') {
        skipped.push({ name: source || '(unnamed)', reason: 'invalid_quote_input' });
      } else if (text.length > MAX_QUOTE_CHARS) {
        // 잘라서 확인하지 않는다: 앞부분만 맞는 문장이 "있다" 로 보고되는 일을 막는다
        skipped.push({ name: source, reason: 'quote_too_long' });
      } else if (quotes.length >= MAX_QUOTES_TOTAL || (perSource.get(source) ?? 0) >= MAX_QUOTES_PER_SOURCE) {
        skipped.push({ name: source, reason: 'too_many_quotes' });
      } else {
        perSource.set(source, (perSource.get(source) ?? 0) + 1);
        quotes.push({ source, quote: text });
      }
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
  return quotes.map((entry): QuoteReport => {
    const needle = collapse(entry.quote);
    const at = haystack === null || needle === '' ? -1 : haystack.indexOf(needle);
    return {
      quote: entry.quote,
      found: at >= 0,
      context: at >= 0 && haystack !== null ? haystack.slice(Math.max(0, at - CONTEXT_CHARS), at + needle.length + CONTEXT_CHARS) : null,
    };
  });
}

/** 페이지를 읽지 못했거나 출처가 없는 기대 인용문: 찾지 못한 것으로 보고한다 (조용히 빠지지 않는다) */
const notFoundReports = (quotes: readonly ResearchQuote[]): QuoteReport[] => quotes.map((entry): QuoteReport => ({ quote: entry.quote, found: false, context: null }));

// ===== 불확실성 =====

export interface UncertaintyItem extends JsonObject { topic: string; note: string }

/**
 * 에이전트가 이미 알고 있는 사실(건너뛴 입력, 출처 보고, 인용문 found 여부)에서 기계적으로 도출한다. 순서: 건너뛴 입력 → 출처 단위 → 짝 없는 인용문 → 인용문 단위.
 * 상한을 넘으면 앞의 `MAX_UNCERTAINTIES - 1` 개와 생략 개수를 알리는 항목 하나를 낸다.
 */
export function uncertaintiesOf(
  targets: ResearchTargets, sources: readonly SourceReport[], unmatchedQuotes: readonly ResearchQuote[],
): UncertaintyItem[] {
  const all: UncertaintyItem[] = [];
  const add = (topic: string, note: string): void => {
    all.push({ topic: topic.slice(0, MAX_UNCERTAINTY_TOPIC_CHARS), note: note.slice(0, MAX_UNCERTAINTY_NOTE_CHARS) });
  };
  for (const item of targets.skipped) add(item.name, `input skipped: ${item.reason}`);
  for (const source of sources) {
    if (source['fetched'] !== true) {
      add(source.name, `source could not be read: ${String(source['fetch_error'])}`);
      continue;
    }
    if (source['reachable'] === false) add(source.name, `source answered HTTP ${String(source['http_status'])}`);
    if (typeof source['body_skipped'] === 'string') add(source.name, `source body was not read: ${source['body_skipped']}`);
    if (source['truncated'] === true) add(source.name, 'source body was truncated; text beyond the limit was not checked');
  }
  unmatchedQuotes.forEach((entry, index) => add(entry.source, `expected quotation #${index + 1} has no matching source input`));
  for (const source of sources) {
    const quotes = Array.isArray(source['quotes']) ? source['quotes'] as QuoteReport[] : [];
    quotes.forEach((check, index) => {
      if (check.found) return;
      add(source.name, source['fetched'] === true
        ? `expected quotation #${index + 1} was not found in the page`
        : `expected quotation #${index + 1} could not be checked: the source was not read`);
    });
  }
  if (all.length <= MAX_UNCERTAINTIES) return all;
  const kept = all.slice(0, MAX_UNCERTAINTIES - 1);
  kept.push({ topic: '(more)', note: `${all.length - kept.length} further uncertainty item(s) omitted` });
  return kept;
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
  const quoteTotal = targets.quotes.length; // 기대 인용문 전부: 모두 found/not found 가 보고된다
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
      sources.push({ name: source.name, url: source.url, fetched: false, fetch_error: code, quotes: notFoundReports(quotes), trust_origin: 'external_untrusted' });
      note(`fetch_url #${index + 1} ${logUrl(source.url)}: failed (${code})`);
      continue;
    }
    fetchedCount += 1;
    const checks = quoteReports(page.text, quotes);
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
      // 외부 페이지에서 읽은 근거다: 신뢰 출처는 항상 external_untrusted (evidence.trust_origin)
      evidence.push({ kind: 'source_url', ref: source.url, trust_origin: 'external_untrusted', captured_at: deps.now(), ...(page.sha256 === null ? {} : { content_hash: page.sha256 }) });
    }
    // 인용문이 실제로 있었던 것만 "주장"으로 보고한다. 검증기(A4)가 같은 출처를 원본에서 다시 읽어 확인한다
    checks.forEach((check, qi) => {
      if (check.found) claims.push({ id: `${source.name}#q${qi + 1}`, statement: `The source "${source.name}" contains the quotation.`, source_url: source.url, quote: check.quote });
    });
    note(`fetch_url #${index + 1} ${logUrl(source.url)}: status ${page.status}, ${page.bytes} bytes${page.truncated ? ' (truncated)' : ''}, quotes found ${found}/${checks.length}`);
  }

  // 이름이 맞는 출처가 없는 기대 인용문(검증된 명세에서는 생기지 않는다): 확인하지 못했으므로 found:false 로 남긴다
  const unmatchedQuotes = targets.quotes.filter((entry) => !targets.sources.some((source) => source.name === entry.source));
  const unmatched = unmatchedQuotes.length;
  const result: JsonObject = {
    summary: `${fetchedCount} of ${targets.sources.length} source(s) fetched; ${quoteFound} of ${quoteTotal} quotation(s) found`,
    trust_origin: 'external_untrusted',
    counts: {
      sources: targets.sources.length, fetched: fetchedCount, failed: targets.sources.length - fetchedCount,
      quotes_checked: quoteTotal, quotes_found: quoteFound, quotes_without_source: unmatched, skipped_inputs: targets.skipped.length,
    },
    sources,
    unmatched_quotes: notFoundReports(unmatchedQuotes).map((report, index) => ({ source: unmatchedQuotes[index]!.source, quote: report.quote, found: false })),
    claims,
    skipped_inputs: targets.skipped.map((item) => ({ name: item.name, reason: item.reason })),
    uncertainties: uncertaintiesOf(targets, sources, unmatchedQuotes),
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
