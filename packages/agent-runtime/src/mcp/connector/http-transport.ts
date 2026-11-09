// Streamable HTTP 전송 (MCP 2025-06-18). POST 본문이 JSON-RPC 메시지이고 응답은 JSON 하나 또는 SSE 스트림이다.
//  - `Accept: application/json, text/event-stream`, `Mcp-Session-Id`(받으면 이후 요청에 싣는다), `MCP-Protocol-Version`(초기화 뒤)
//  - 리다이렉트는 따르지 않는다(3xx 는 오류). 응답 크기 상한 4 MiB. https 만(루프백 호스트는 http 허용 — 호스트 쪽 선언 검증이 이미 막지만 여기서도 확인한다)
//  - 서버가 SSE 로 보낸 요청·알림은 handler 로 넘기고, 요청에 대한 응답은 같은 POST 가 끝나기 전에 찾는다
// 서버→클라이언트 GET 스트림은 열지 않는다(설계 구현 기록): 목록 변경 알림은 POST 응답 스트림으로 온 것만 받고, 나머지는 주기 확인·전송 직전 확인이 막는다.
import { abortError, isRecord, type JsonRpcInbound, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse, type RequestOptions, type Transport } from './transport.ts';
import { ConnectorFailure } from './wire.ts';

export const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface HttpTransportOptions {
  url: string;
  /** 인증 헤더 등 (이미 값이 채워진 것) */
  headers: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** 연결 자체가 안 된 오류 코드: 요청이 서버에 닿지 않았음이 확실하다 */
const DEFINITE_NETWORK = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']);

export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorFailure('bad_url', 'the MCP server url is not valid', true);
  }
  if (url.username !== '' || url.password !== '') throw new ConnectorFailure('bad_url', 'the MCP server url must not carry credentials', true);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new ConnectorFailure('bad_url', 'the MCP server url must be https (http only for loopback hosts)', true);
  }
  return url;
}

const networkCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/** 응답 본문을 상한까지 모두 읽는다 */
async function readAll(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ConnectorFailure('response_too_large', 'the MCP server response exceeds the size limit', false);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** SSE 이벤트 하나의 data 를 모은다 */
function sseData(eventText: string): string | null {
  const lines: string[] = [];
  for (const line of eventText.split('\n')) {
    if (line.startsWith('data:')) lines.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
  }
  return lines.length === 0 ? null : lines.join('\n');
}

export function createHttpTransport(options: HttpTransportOptions): Transport {
  const url = assertAllowedUrl(options.url);
  const doFetch = options.fetchImpl ?? fetch;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let messageHandler: (message: JsonRpcInbound) => void = () => undefined;
  let closedHandler: () => void = () => undefined;

  const headers = (): Record<string, string> => ({
    ...options.headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId === null ? {} : { 'mcp-session-id': sessionId }),
    ...(protocolVersion === null ? {} : { 'mcp-protocol-version': protocolVersion }),
  });

  const post = async (body: unknown, signal: AbortSignal | undefined): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body), redirect: 'manual', ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const code = networkCode(error);
      throw new ConnectorFailure('network', `could not reach the MCP server${code === undefined ? '' : ` (${code})`}`, code !== undefined && DEFINITE_NETWORK.has(code));
    }
    const session = response.headers.get('mcp-session-id');
    if (session !== null && session !== '') sessionId = session;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorFailure('redirect', `the MCP server answered with a redirect (${response.status}); redirects are not followed`, true);
    }
    if (response.status === 404 && sessionId !== null) {
      await response.body?.cancel().catch(() => undefined);
      sessionId = null;
      closedHandler(); // 세션이 만료됐다: 다시 초기화해야 한다
      throw new ConnectorFailure('session_expired', 'the MCP session expired', false);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorFailure('http_status', `the MCP server answered HTTP ${response.status}`, response.status === 401 || response.status === 403);
    }
    return response;
  };

  /** 응답에서 `id` 의 JSON-RPC 응답을 찾는다. 다른 메시지는 handler 로 보낸다 */
  const findResponse = async (response: Response, id: number): Promise<JsonRpcResponse> => {
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    const take = (message: unknown): JsonRpcResponse | null => {
      if (!isRecord(message)) return null;
      const inbound = message as JsonRpcInbound;
      if (typeof inbound.method === 'string') {
        messageHandler(inbound);
        return null;
      }
      return inbound.id === id ? (inbound as JsonRpcResponse) : null;
    };
    if (type.includes('text/event-stream')) {
      if (response.body === null) throw new ConnectorFailure('no_response', 'the MCP server sent an empty stream', false);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_HTTP_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ConnectorFailure('response_too_large', 'the MCP server response exceeds the size limit', false);
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        for (let split = buffer.indexOf('\n\n'); split !== -1; split = buffer.indexOf('\n\n')) {
          const data = sseData(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          if (data === null) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
            const found = take(message);
            if (found !== null) {
              await reader.cancel().catch(() => undefined);
              return found;
            }
          }
        }
      }
      throw new ConnectorFailure('no_response', 'the stream ended without a response to the request', false);
    }
    const text = await readAll(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ConnectorFailure('bad_response', 'the MCP server answered with something that is not JSON', false);
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const found = take(message);
      if (found !== null) return found;
    }
    throw new ConnectorFailure('no_response', 'the response did not contain an answer to the request', false);
  };

  const signalOf = (requestOptions: RequestOptions): AbortSignal | undefined => {
    const signals: AbortSignal[] = [];
    if (requestOptions.signal !== undefined) signals.push(requestOptions.signal);
    if (requestOptions.timeoutMs !== undefined) signals.push(AbortSignal.timeout(requestOptions.timeoutMs));
    return signals.length === 0 ? undefined : AbortSignal.any(signals);
  };

  return {
    async request(message: JsonRpcRequest, requestOptions: RequestOptions = {}): Promise<JsonRpcResponse> {
      const signal = signalOf(requestOptions);
      try {
        const response = await post(message, signal);
        return await findResponse(response, message.id);
      } catch (error) {
        if (error instanceof ConnectorFailure && error.code === 'aborted' && requestOptions.signal?.aborted !== true && requestOptions.timeoutMs !== undefined) {
          throw new ConnectorFailure('timeout', `no response within ${requestOptions.timeoutMs} ms`, false);
        }
        if (error instanceof ConnectorFailure) throw error;
        if (signal?.aborted) {
          if (requestOptions.signal?.aborted === true) throw abortError(requestOptions.signal);
          throw new ConnectorFailure('timeout', `no response within ${requestOptions.timeoutMs ?? 0} ms`, false);
        }
        throw error;
      }
    },
    async notify(message: JsonRpcNotification): Promise<void> {
      const response = await post(message, AbortSignal.timeout(15_000));
      await response.body?.cancel().catch(() => undefined);
    },
    async reply(message: JsonRpcResponse): Promise<void> {
      try {
        const response = await post(message, AbortSignal.timeout(15_000));
        await response.body?.cancel().catch(() => undefined);
      } catch { /* 서버 요청에 대한 응답은 최선 노력이다 */ }
    },
    onMessage: (handler) => { messageHandler = handler; },
    onClosed: (handler) => { closedHandler = handler; },
    setProtocolVersion: (version) => { protocolVersion = version; },
    async close(): Promise<void> {
      if (sessionId === null) return;
      try {
        const response = await doFetch(url, { method: 'DELETE', headers: headers(), redirect: 'manual', signal: AbortSignal.timeout(2000) });
        await response.body?.cancel().catch(() => undefined);
      } catch { /* 서버가 세션 종료를 받지 않아도 된다 */ }
      sessionId = null;
    },
  };
}
