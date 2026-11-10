// API 전송의 HTTP 실행 (ADR-0020). node:http(s)·node:dns 만 쓴다.
//  - 호스트는 base_url 에서만 온다. 주소 해석 결과 *모두*가 network 규칙 안일 때만 연결하고, 연결은 검사한 바로 그 주소로 고정한다(DNS 재해석 방지).
//  - 리다이렉트는 따르지 않는다: 3xx 는 본문을 읽지 않고 상태만 돌려준다.
//  - 응답 본문은 상한까지만 읽고, 압축된(content-encoding) 응답은 읽지 않는다. 시간 제한은 요청 전체에 건다.
import { Buffer } from 'node:buffer';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { ApiNetwork } from './api-decl.ts';
import type { BuiltRequest } from './api-request.ts';
import { addressFamily, isLoopbackAddress, isPublicAddress, isTailnetAddress } from './ip-address.ts';
import { ConnectorFailure } from './wire.ts';

export const USER_AGENT = 'aot-api-connector/1';

/** 이 network 규칙에서 연결해도 되는 주소인가 (기본 거부) */
export function addressAllowed(network: ApiNetwork, address: string): boolean {
  if (network === 'loopback') return isLoopbackAddress(address);
  if (isPublicAddress(address)) return true;
  return network === 'tailnet' && isTailnetAddress(address);
}

export interface ApiHttpTarget {
  /** 검증을 마친 base_url (출처 + 선택적 경로 접두어) */
  baseUrl: URL;
  network: ApiNetwork;
  timeoutMs: number;
  maxBodyBytes: number;
  /** 인증 헤더(이름은 소문자) — 선언된 헤더보다 나중에 덮어쓰지 못하게 호출 쪽에서 합쳐 준다 */
  authHeaders: Record<string, string>;
}

export interface ApiHttpResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
  truncated: boolean;
  /** content-encoding 이 있어 본문을 읽지 않았다 */
  encoded: boolean;
}

interface Resolved { address: string; family: number }

export type LookupAll = (host: string) => Promise<readonly { address: string; family: number }[]>;
const systemLookup: LookupAll = (host) => dnsLookup(host, { all: true, verbatim: true });

async function resolveChecked(host: string, network: ApiNetwork, signal: AbortSignal, lookup: LookupAll): Promise<Resolved[]> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const literal = addressFamily(bare);
  let found: readonly Resolved[];
  if (literal !== 0) found = [{ address: bare, family: literal }];
  else {
    try {
      found = await Promise.race([
        lookup(bare),
        new Promise<never>((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }),
      ]);
    } catch {
      throw new ConnectorFailure('dns_failed', 'the host could not be resolved', true);
    }
  }
  if (found.length === 0) throw new ConnectorFailure('dns_failed', 'the host has no address', true);
  // 하나라도 규칙 밖이면 쓰지 않는다(섞인 답으로 사설 주소를 끼워 넣는 것을 막는다)
  for (const entry of found) if (!addressAllowed(network, entry.address)) throw new ConnectorFailure('address_not_allowed', `the host resolves to an address that network '${network}' does not allow`, true);
  return found.map((entry) => ({ address: entry.address, family: addressFamily(entry.address) || entry.family }));
}

function pinnedLookup(addresses: readonly Resolved[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = options.family === 4 || options.family === 6 ? addresses.filter((entry) => entry.family === options.family) : addresses;
    const list = wanted.length > 0 ? wanted : addresses;
    if (options.all) (callback as unknown as (error: null, all: Resolved[]) => void)(null, list.map((entry) => ({ ...entry })));
    else callback(null, list[0]!.address, list[0]!.family);
  };
}

const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** 요청 하나를 보낸다. 실패는 ConnectorFailure (definite: 서버에 요청이 닿지 않았음이 확실한가) */
/** @param lookup 시험이 주소 해석 결과를 정한다(DNS 재바인딩·혼합 응답 시험). 운영 코드는 주지 않는다 */
export async function executeApiRequest(target: ApiHttpTarget, built: BuiltRequest, outer: AbortSignal | undefined, lookup: LookupAll = systemLookup): Promise<ApiHttpResponse> {
  const control = new AbortController();
  const onOuter = (): void => control.abort(new Error('cancelled by the host'));
  if (outer?.aborted === true) throw new ConnectorFailure('aborted', 'cancelled before it was sent', true);
  outer?.addEventListener('abort', onOuter, { once: true });
  const timer = setTimeout(() => control.abort(new Error('timeout')), target.timeoutMs);
  timer.unref();
  const signal = control.signal;
  try {
    const url = target.baseUrl;
    const addresses = await resolveChecked(url.hostname, target.network, signal, lookup);
    if (signal.aborted) throw new ConnectorFailure('aborted', 'cancelled before it was sent', true);
    return await new Promise<ApiHttpResponse>((resolve, reject) => {
      let settled = false;
      let connected = false;
      const done = (action: () => void): void => { if (settled) return; settled = true; action(); };
      const fail = (error: unknown): void => done(() => {
        const reason = signal.reason instanceof Error ? signal.reason.message : '';
        if (signal.aborted) reject(new ConnectorFailure(reason === 'timeout' ? 'timeout' : 'aborted', reason === 'timeout' ? `no answer within ${target.timeoutMs} ms` : 'the request was cancelled', !connected));
        else {
          const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'error';
          reject(new ConnectorFailure(connected ? 'network_error' : 'connect_failed', code.slice(0, 40), !connected));
        }
      });
      const headers: Record<string, string> = { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', connection: 'close', ...built.headers, ...target.authHeaders };
      const bodyBytes = built.body === null ? null : Buffer.from(built.body, 'utf8');
      if (bodyBytes !== null) headers['content-length'] = String(bodyBytes.length);
      const options = {
        hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
        ...(url.port === '' ? {} : { port: Number(url.port) }),
        path: built.target, method: built.method, agent: false, headers, lookup: pinnedLookup(addresses), signal,
      } as const;
      const req = url.protocol === 'https:' ? httpsRequest(options) : httpRequest(options);
      req.on('socket', (socket) => {
        const mark = (): void => { connected = true; };
        if (!socket.connecting) mark();
        else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', mark);
      });
      req.on('error', fail);
      req.on('response', (res: IncomingMessage) => {
        res.on('error', fail);
        const status = res.statusCode ?? 0;
        const typeHeader = headerValue(res.headers['content-type']) ?? '';
        const type = (typeHeader.split(';')[0] ?? '').trim().toLowerCase();
        const encoding = (headerValue(res.headers['content-encoding']) ?? 'identity').trim().toLowerCase();
        if (status >= 300 && status < 400) { // 리다이렉트: 따르지 않고 본문도 읽지 않는다
          done(() => resolve({ status, contentType: type === '' ? null : type, body: Buffer.alloc(0), truncated: false, encoded: false }));
          res.destroy();
          return;
        }
        if (encoding !== 'identity' && encoding !== '') {
          done(() => resolve({ status, contentType: type === '' ? null : type, body: Buffer.alloc(0), truncated: false, encoded: true }));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        const finish = (truncated: boolean): void => done(() => resolve({ status, contentType: type === '' ? null : type, body: Buffer.concat(chunks), truncated, encoded: false }));
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = target.maxBodyBytes - bytes;
          if (chunk.length > room) {
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
      req.end(bodyBytes ?? undefined);
    });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}
