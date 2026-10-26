// 호스트 쪽 `fetch_url` 도구 실행기 (단계 A5 U5). 컨테이너 안 조사 에이전트가 게이트웨이로 부르는 유일한 외부 접근이며(`--network none` 이라 에이전트는 직접 나갈 수 없다),
// 웹 페이지를 읽어 온다(읽기 전용 GET). 결과는 `external_untrusted` 데이터다(게이트웨이 도구 선언 `resultOrigin`): 페이지 텍스트는 지시가 아니다 (trust-boundaries §2-3).
// 같은 코어를 검증기의 출처 조회 포트(`SourceFetcher`, A4)로도 쓴다(`createSourceFetcher`) — 검증기도 이 SSRF 규칙 밖으로 나가지 않는다.
//
// 요청 하나의 규칙 (모두 리다이렉트 매 홉마다 다시 적용한다):
//   1. 스킴은 http/https 만. 사용자 정보(`user:pass@`)가 있으면 거부. 길이 상한 2048.
//   2. 호스트는 허용 목록 안이어야 한다: 운영 설정 `allowedHosts` 와 업무의 `constraints.network_allowlist`(게이트웨이가 실행기에 넘긴다) 둘 다에 있어야 하고,
//      어느 쪽이든 비어 있거나 없으면 모두 거부한다. 항목은 정확한 호스트이거나 `*.example.com`(하위 도메인만). `*` 전체 허용은 없다.
//   3. SSRF: 호스트를 해석한 *모든* 주소가 공인 주소(ip-address.ts)여야 한다. 하나라도 루프백·사설·링크로컬·메타데이터·예약이면 거부한다.
//      연결은 검사한 바로 그 주소로만 한다(연결 때 DNS 를 다시 풀지 않는다: `lookup` 을 검사한 주소로 고정) — 재해석 경합(DNS rebinding) 방지.
//   4. 리다이렉트는 자동으로 따르지 않고 최대 N회 수동으로 따른다. 각 홉이 1~3 을 다시 통과해야 한다. 항상 GET, 쿠키·인증 헤더 없음.
//   5. 응답 본문은 스트리밍으로 읽다가 상한(`maxBodyBytes`)을 넘으면 연결을 끊고 `truncated:true` 로 돌려준다. 전체 시간은 호출자의 AbortSignal 이 끊는다.
//   6. 본문은 허용 content-type(text/*, application/json, *+json, application/xml, *+xml, application/xhtml+xml)일 때만 읽는다. 압축된 응답(content-encoding)은 읽지 않는다.
//      읽지 않은 응답도 상태 코드는 돌려준다(`body_skipped` 에 사유). HTML 은 태그를 걷어 낸 텍스트로 돌려준다(해시는 받은 원본 바이트의 sha256).
// 던지는 오류는 `FetchUrlError`(code 로 구분)다. 게이트웨이가 에이전트에는 `tool_error` 만 알리고 사유는 호출 기록에만 남긴다.
// `node:http`·`node:https`·`node:dns` 만 쓴다(의존성 없음). 시험이 사설 주소 규칙을 풀 수 있는 길은 `createFetchUrlToolWithHooks` 의 `exemptAddresses` 뿐이며
// 이 함수는 index.ts 로 내보내지 않는다(운영 설정으로 노출하지 않는다). https 정상 경로 시험을 위한 `ca`(시험이 만든 인증서만 신뢰) 주입점도 같은 훅에 있다:
// 운영 코드는 항상 시스템 기본 신뢰 저장소로 인증서를 검증하며(만료·호스트 이름 불일치·미신뢰 발급자는 `network_error` 로 거부), 이를 끄거나 바꾸는 설정은 없다.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import type { FetchResult, SourceFetcher } from '@aot/evaluation';

import type { AdapterCost, JsonObject } from './contract.ts';
import type { GatewayTimers, GatewayToolSpec, ToolExecutionRequest, ToolExecutionResult, ToolExecutor } from './gateway.ts';
import { realGatewayTimers } from './gateway.ts';
import { addressFamily, isPublicAddress } from './ip-address.ts';

export const FETCH_URL_TOOL = 'fetch_url';
export const FETCH_URL_OPERATION = 'fetch';

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** 설정으로 올릴 수 있는 본문 상한의 한계 (도구 결과가 프레임 상한 1 MiB 안에 들어가게) */
export const MAX_BODY_BYTES_LIMIT = 512 * 1024;
export const DEFAULT_MAX_REDIRECTS = 3;
export const MAX_REDIRECTS_LIMIT = 10;
export const MAX_URL_CHARS = 2048;
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'text/*', 'application/json', 'application/*+json', 'application/xml', 'application/*+xml', 'application/xhtml+xml',
];
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'aot-research-fetch/1';

export type FetchUrlErrorCode =
  | 'invalid_args' | 'invalid_url' | 'scheme_not_allowed' | 'userinfo_not_allowed' | 'host_not_allowed' | 'dns_failed' | 'address_not_allowed'
  | 'too_many_redirects' | 'aborted' | 'network_error';

export class FetchUrlError extends Error {
  readonly code: FetchUrlErrorCode;
  constructor(code: FetchUrlErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FetchUrlError';
    this.code = code;
  }
}

// ===== 설정 =====

export interface FetchUrlToolOptions {
  /** 운영 설정의 허용 호스트. 비어 있으면 모두 거부한다. 항목: 정확한 호스트 또는 `*.example.com` (`*` 단독은 설정 오류) */
  allowedHosts: readonly string[];
  /** 본문 상한(바이트). 기본 256 KiB, 최대 512 KiB */
  maxBodyBytes?: number;
  /** 최대 리다이렉트 횟수. 기본 3, 최대 10 */
  maxRedirects?: number;
  /** 읽을 content-type. 기본은 DEFAULT_ALLOWED_CONTENT_TYPES. 항목: `type/subtype`, `type/*`, `type/*+suffix` */
  allowedContentTypes?: readonly string[];
  /** 게이트웨이 도구 선언에 넣는 호출당 단위 비용 */
  unitCost?: AdapterCost;
  /** 게이트웨이 도구 선언에 넣는 도구 타임아웃(밀리초). 생략하면 게이트웨이 기본값 */
  timeoutMs?: number;
}

/** 시험에서만 쓰는 주입점 (index.ts 로 내보내지 않는다) */
export interface FetchUrlHooks {
  /** 호스트 이름 해석. 기본은 `dns.promises.lookup(host, {all:true})` */
  lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  /** 공인 주소 규칙에서 제외할 정확한 주소 문자열들 (예: 시험 서버의 '127.0.0.1'). 목록에 없는 비공인 주소는 그대로 거부된다 */
  exemptAddresses?: readonly string[];
  /** https 에서 신뢰할 CA(PEM). 주면 시스템 기본 신뢰 저장소 *대신* 이것만 쓴다(검증은 그대로 켜져 있다). 시험이 만든 자체서명 인증서용 */
  ca?: string | Buffer | readonly (string | Buffer)[];
}

interface FetchConfig {
  operatorHosts: readonly string[];
  maxBodyBytes: number;
  maxRedirects: number;
  contentTypes: readonly string[];
}

function resolveConfig(options: FetchUrlToolOptions): FetchConfig {
  const problems: string[] = [];
  if (!Array.isArray(options.allowedHosts)) problems.push('allowedHosts must be an array');
  const hosts = (options.allowedHosts ?? []).map((entry) => normalizePattern(entry));
  hosts.forEach((entry, index) => {
    if (entry === null) problems.push(`allowedHosts[${index}] is not a host name or a '*.' pattern`);
  });
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_BYTES_LIMIT) problems.push(`maxBodyBytes must be an integer between 1 and ${MAX_BODY_BYTES_LIMIT}`);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS_LIMIT) problems.push(`maxRedirects must be an integer between 0 and ${MAX_REDIRECTS_LIMIT}`);
  const contentTypes = (options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES).map((entry) => entry.trim().toLowerCase());
  for (const entry of contentTypes) if (!/^[a-z0-9.+-]+\/(\*|[a-z0-9.+-]+|\*\+[a-z0-9.+-]+)$/.test(entry)) problems.push(`allowedContentTypes entry '${entry}' is not valid`);
  if (problems.length > 0) throw new Error(`invalid fetch_url configuration: ${problems.join('; ')}`);
  return { operatorHosts: hosts as string[], maxBodyBytes, maxRedirects, contentTypes };
}

// ===== 호스트 허용 목록 =====

/** 허용 목록 항목을 정규화한다. 정확한 호스트(소문자, 끝의 점 제거) 또는 `*.host`. 그 밖은 null (`*` 단독 포함) */
function normalizePattern(entry: unknown): string | null {
  if (typeof entry !== 'string') return null;
  const text = entry.trim().toLowerCase().replace(/\.$/, '');
  if (text === '' || text === '*' || /[\s/\\@?#]/.test(text)) return null;
  const wildcard = text.startsWith('*.');
  const base = wildcard ? text.slice(2) : text;
  if (base.includes('*') || base === '' || base.startsWith('.')) return null;
  return text;
}

/** `host` 가 목록의 항목과 맞는가. `*.example.com` 은 하위 도메인만(example.com 자체는 아니다). 목록이 비면 거부 */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  for (const raw of patterns) {
    const pattern = normalizePattern(raw);
    if (pattern === null) continue;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // '.example.com'
      if (name.length > suffix.length && name.endsWith(suffix)) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

// ===== URL 검사 =====

interface Target {
  url: URL;
  /** 대괄호를 뗀 호스트 */
  host: string;
}

function parseTarget(text: unknown, where: string): Target {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_URL_CHARS) throw new FetchUrlError('invalid_url', `${where}: url must be a string of 1-${MAX_URL_CHARS} characters`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new FetchUrlError('invalid_url', `${where}: not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchUrlError('scheme_not_allowed', `${where}: only http and https are allowed (got ${url.protocol})`);
  if (url.username !== '' || url.password !== '') throw new FetchUrlError('userinfo_not_allowed', `${where}: URLs with user information are not allowed`);
  const host = (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname).toLowerCase().replace(/\.$/, '');
  if (host === '') throw new FetchUrlError('invalid_url', `${where}: the URL has no host`);
  return { url, host };
}

interface ResolvedAddress { address: string; family: number }

async function resolveAddresses(host: string, hooks: FetchUrlHooks, signal: AbortSignal, where: string): Promise<ResolvedAddress[]> {
  const exempt = new Set(hooks.exemptAddresses ?? []);
  const literal = addressFamily(host);
  let found: readonly ResolvedAddress[];
  if (literal !== 0) {
    found = [{ address: host, family: literal }];
  } else {
    try {
      const pending: Promise<readonly ResolvedAddress[]> = hooks.lookup ? hooks.lookup(host) : dnsLookup(host, { all: true, verbatim: true });
      found = await raceAbort(pending, signal);
    } catch (error) {
      if (error instanceof FetchUrlError) throw error;
      throw new FetchUrlError('dns_failed', `${where}: ${host} could not be resolved`);
    }
  }
  if (found.length === 0) throw new FetchUrlError('dns_failed', `${where}: ${host} has no address`);
  for (const entry of found) {
    if (!exempt.has(entry.address) && !isPublicAddress(entry.address)) {
      throw new FetchUrlError('address_not_allowed', `${where}: ${host} resolves to a non-public address (${entry.address})`);
    }
  }
  return found.map((entry) => ({ address: entry.address, family: addressFamily(entry.address) || entry.family }));
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new FetchUrlError('aborted', abortText(signal)));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new FetchUrlError('aborted', abortText(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error instanceof Error ? error : new Error('lookup failed')); },
    );
  });
}

const abortText = (signal: AbortSignal): string => (signal.reason instanceof Error ? signal.reason.message : 'aborted').slice(0, 100);

// ===== 요청 하나 =====

type RawResponse =
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'response'; status: number; contentType: string | null; charset: string | null; body: Buffer; truncated: boolean; skipped: string | null };

const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function contentTypeAllowed(type: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === type) return true;
    const [pt, ps] = pattern.split('/') as [string, string];
    const [tt, ts] = type.split('/') as [string, string | undefined];
    if (ts === undefined || pt !== tt) return false;
    if (ps === '*') return true;
    if (ps.startsWith('*+')) return ts.endsWith(ps.slice(1));
    return false;
  });
}

function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = options.family === 4 || options.family === 6 ? addresses.filter((entry) => entry.family === options.family) : addresses;
    const list = wanted.length > 0 ? wanted : addresses;
    if (options.all) (callback as unknown as (error: null, all: ResolvedAddress[]) => void)(null, list.map((entry) => ({ ...entry })));
    else callback(null, list[0]!.address, list[0]!.family);
  };
}

function requestOnce(target: Target, addresses: readonly ResolvedAddress[], signal: AbortSignal, config: FetchConfig, hooks: FetchUrlHooks): Promise<RawResponse> {
  const { url, host } = target;
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const done = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    const fail = (error: unknown): void => done(() => reject(mapNetworkError(error, signal)));
    const options = {
      hostname: host,
      ...(url.port === '' ? {} : { port: Number(url.port) }),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/*, application/json;q=0.9, application/xml;q=0.9',
        'accept-encoding': 'identity',
        connection: 'close',
      },
      lookup: pinnedLookup(addresses),
      signal,
    } as const;
    // https 는 인증서 검증을 Node 기본값(켜짐)으로 둔다. `ca` 훅이 있을 때만 신뢰 목록을 바꾼다(시험 전용)
    const req = url.protocol === 'https:'
      ? httpsRequest({ ...options, ...(hooks.ca === undefined ? {} : { ca: hooks.ca as string | Buffer | (string | Buffer)[] }) })
      : httpRequest(options);
    req.on('error', fail);
    req.on('response', (res: IncomingMessage) => {
      res.on('error', fail);
      const status = res.statusCode ?? 0;
      const location = headerValue(res.headers.location);
      if (REDIRECT_STATUSES.has(status) && location !== undefined) {
        done(() => resolve({ kind: 'redirect', status, location }));
        res.destroy();
        return;
      }
      const typeHeader = headerValue(res.headers['content-type']) ?? '';
      const type = (typeHeader.split(';')[0] ?? '').trim().toLowerCase();
      const charset = /;\s*charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i.exec(typeHeader)?.[1]?.toLowerCase() ?? null;
      const encoding = (headerValue(res.headers['content-encoding']) ?? 'identity').trim().toLowerCase();
      let skipped: string | null = null;
      if (type === '') skipped = 'no_content_type';
      else if (!contentTypeAllowed(type, config.contentTypes)) skipped = 'content_type_not_allowed';
      else if (encoding !== 'identity' && encoding !== '') skipped = 'content_encoding_not_supported';
      if (skipped !== null) {
        done(() => resolve({ kind: 'response', status, contentType: type === '' ? null : type, charset, body: Buffer.alloc(0), truncated: false, skipped }));
        res.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      const finish = (truncated: boolean): void => done(() => resolve({ kind: 'response', status, contentType: type, charset, body: Buffer.concat(chunks), truncated, skipped: null }));
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = config.maxBodyBytes - bytes;
        if (chunk.length > room) {
          // 상한을 넘었다: 받은 만큼만 남기고 연결을 끊는다(나머지를 읽지 않는다)
          if (room > 0) chunks.push(chunk.subarray(0, room));
          bytes += Math.max(0, room);
          finish(true);
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      });
      res.on('end', () => finish(false));
      res.on('close', () => fail(new Error('connection closed before the response ended')));
    });
    req.end();
  });
}

function mapNetworkError(error: unknown, signal: AbortSignal): FetchUrlError {
  if (error instanceof FetchUrlError) return error;
  if (signal.aborted) return new FetchUrlError('aborted', abortText(signal));
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'error';
  return new FetchUrlError('network_error', code.slice(0, 40));
}

// ===== 텍스트 변환 =====

const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'template']);
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML 에서 태그·주석·script/style 을 걷어 낸 텍스트(공백 한 칸으로 접음). 정규식 대신 한 번 훑는 방식이라 입력 크기에 선형이다(적대적 페이지에 오래 걸리지 않는다).
 * 완전한 HTML 파서가 아니다: 인용 포함 확인을 위한 근사이며 결과는 여전히 신뢰할 수 없는 데이터다.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const n = html.length;
  const parts: string[] = [];
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    const next = html[lt + 1] ?? '';
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      parts.push(' ');
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (!/[a-zA-Z/!?]/.test(next)) {
      parts.push('<');
      i = lt + 1;
      continue;
    }
    const name = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, lt + 24))?.[1]?.toLowerCase();
    if (name !== undefined && SKIPPED_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, lt);
      parts.push(' ');
      if (close < 0) break;
      const gt = html.indexOf('>', close);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    parts.push(' ');
    if (gt < 0) break;
    i = gt + 1;
  }
  return decodeEntities(parts.join('')).replace(/\s+/g, ' ').trim();
}

function decodeBody(body: Buffer, charset: string | null): string {
  if (charset !== null) {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // 모르는 charset: UTF-8 로 읽는다
    }
  }
  return new TextDecoder('utf-8').decode(body);
}

// ===== 코어 =====

export type FetchedRedirect = { status: number; to: string };

/** 도구 결과이자 JSON 객체. 에이전트가 받는 것은 이것뿐이다 */
export interface FetchedPage extends JsonObject {
  url: string;
  final_url: string;
  status: number;
  content_type: string | null;
  redirects: { status: number; to: string }[];
  /** 읽은 본문 바이트 수 (상한에서 끊었으면 상한) */
  bytes: number;
  /** 본문이 상한에서 잘렸는가 */
  truncated: boolean;
  /** 받은 원본 바이트의 sha256 (hex). 본문을 읽지 않았으면 null */
  sha256: string | null;
  /** 본문 텍스트 (HTML 은 태그를 걷어 낸 것). 읽지 않았으면 null */
  text: string | null;
  /** 본문을 읽지 않은 사유 (`content_type_not_allowed` | `no_content_type` | `content_encoding_not_supported`), 읽었으면 null */
  body_skipped: string | null;
}

interface FetchJob {
  url: string;
  signal: AbortSignal;
  isHostAllowed(host: string): boolean;
}

async function fetchPage(job: FetchJob, config: FetchConfig, hooks: FetchUrlHooks): Promise<FetchedPage> {
  const redirects: FetchedRedirect[] = [];
  let next: unknown = job.url;
  for (let hop = 0; ; hop += 1) {
    const where = hop === 0 ? 'url' : `redirect ${hop}`;
    const target = parseTarget(next, where); // 매 홉이 스킴·사용자 정보·호스트 허용·주소 검사를 처음부터 다시 통과한다
    if (!job.isHostAllowed(target.host)) throw new FetchUrlError('host_not_allowed', `${where}: host ${target.host} is not on the allow list`);
    const addresses = await resolveAddresses(target.host, hooks, job.signal, where);
    const response = await requestOnce(target, addresses, job.signal, config, hooks);
    if (response.kind === 'redirect') {
      if (hop >= config.maxRedirects) throw new FetchUrlError('too_many_redirects', `more than ${config.maxRedirects} redirects`);
      let location: URL;
      try {
        location = new URL(response.location, target.url);
      } catch {
        throw new FetchUrlError('invalid_url', `redirect ${hop + 1}: the Location header is not a URL`);
      }
      redirects.push({ status: response.status, to: location.href.slice(0, MAX_URL_CHARS) });
      next = location.href;
      continue;
    }
    const readable = response.skipped === null;
    const isHtml = response.contentType === 'text/html' || response.contentType === 'application/xhtml+xml';
    const decoded = readable ? decodeBody(response.body, response.charset) : null;
    return {
      url: job.url,
      final_url: target.url.href,
      status: response.status,
      content_type: response.contentType,
      redirects,
      bytes: response.body.length,
      truncated: response.truncated,
      sha256: readable ? createHash('sha256').update(response.body).digest('hex') : null,
      text: decoded === null ? null : isHtml ? htmlToText(decoded) : decoded,
      body_skipped: response.skipped,
    };
  }
}

// ===== 도구 =====

export interface FetchUrlTool {
  /** 게이트웨이 도구 선언: 읽기 전용(부작용 없음), 결과 출처 external_untrusted */
  spec: GatewayToolSpec;
  executor: ToolExecutor;
}

/** 게이트웨이의 도구 선언. 부작용 없는 읽기(내부 범위 `read`)이며 결과는 외부 입력이다 */
export function fetchUrlToolSpec(options: Pick<FetchUrlToolOptions, 'unitCost' | 'timeoutMs'> = {}): GatewayToolSpec {
  return {
    tool: FETCH_URL_TOOL,
    operation: FETCH_URL_OPERATION,
    scope: 'internal',
    impact: 'read',
    sideEffect: false,
    resultOrigin: 'external_untrusted',
    ...(options.unitCost === undefined ? {} : { unitCost: options.unitCost }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

/** 시험용 주입점이 있는 생성기. 운영 코드는 `createFetchUrlTool` 만 쓴다 (index.ts 는 이 함수를 내보내지 않는다) */
export function createFetchUrlToolWithHooks(options: FetchUrlToolOptions, hooks: FetchUrlHooks): FetchUrlTool {
  const config = resolveConfig(options);
  const executor: ToolExecutor = async (request: ToolExecutionRequest): Promise<ToolExecutionResult> => {
    const args = request.args;
    for (const key of Object.keys(args)) {
      if (key !== 'url') throw new FetchUrlError('invalid_args', `unexpected argument '${key.slice(0, 40)}' (fetch_url takes only 'url')`);
    }
    // 업무의 network_allowlist 도 만족해야 한다. 없거나 비면 네트워크 없음이다
    const taskHosts = request.constraints.network_allowlist ?? [];
    const page = await fetchPage({
      url: args['url'] as unknown as string,
      signal: request.signal,
      isHostAllowed: (host) => hostMatches(host, config.operatorHosts) && hostMatches(host, taskHosts),
    }, config, hooks);
    return { result: page };
  };
  return { spec: fetchUrlToolSpec(options), executor };
}

/** 운영용 `fetch_url` 도구 (도구 선언 + 실행기). 데몬이 `tools`/`executors` 에 그대로 넣는다 */
export function createFetchUrlTool(options: FetchUrlToolOptions): FetchUrlTool {
  return createFetchUrlToolWithHooks(options, {});
}

// ===== 검증기의 출처 조회 포트 =====

export interface SourceFetcherOptions extends FetchUrlToolOptions {
  /** 한 URL 을 읽는 전체 시간(밀리초). 기본 20초 */
  fetchTimeoutMs?: number;
  /** 시간 제한 타이머. 시험은 손으로 돌리는 타이머를 넣는다 */
  timers?: GatewayTimers;
}

export const DEFAULT_SOURCE_FETCH_TIMEOUT_MS = 20_000;

/** 시험용 주입점이 있는 생성기 (index.ts 로 내보내지 않는다) */
export function createSourceFetcherWithHooks(options: SourceFetcherOptions, hooks: FetchUrlHooks): SourceFetcher {
  const config = resolveConfig(options);
  const timers = options.timers ?? realGatewayTimers;
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_SOURCE_FETCH_TIMEOUT_MS;
  return {
    async fetch(url: string): Promise<FetchResult> {
      const controller = new AbortController();
      const handle = timers.setTimeout(() => controller.abort(new Error('fetch_timeout')), timeoutMs);
      try {
        // 같은 허용 목록과 SSRF 규칙. 업무 단위 목록이 없으므로 운영 설정의 허용 호스트만 적용한다
        const page = await fetchPage({ url, signal: controller.signal, isHostAllowed: (host) => hostMatches(host, config.operatorHosts) }, config, hooks);
        if (page.status >= 400) return { reachable: false, reason: `http_${page.status}` };
        return { reachable: true, status: page.status, text: page.text ?? '' };
      } catch (error) {
        return { reachable: false, reason: error instanceof FetchUrlError ? error.code : 'fetch_failed' };
      } finally {
        timers.clearTimeout(handle);
      }
    },
  };
}

/**
 * 검증기(`@aot/evaluation` 의 `SourceFetcher` 포트)용 출처 조회기. `fetch_url` 과 같은 SSRF·허용 호스트·리다이렉트·크기 규칙을 쓴다.
 * 접근 가능 = 최종 응답이 4xx/5xx 가 아님. 어떤 거부·오류도 예외가 아니라 `{reachable:false, reason}` 이다(reason 은 오류 코드만).
 */
export function createSourceFetcher(options: SourceFetcherOptions): SourceFetcher {
  return createSourceFetcherWithHooks(options, {});
}
