// MCP 클라이언트 (필요한 부분만 직접 구현: 초기화, tools/list, tools/call, 취소, 목록 변경 알림. ADR-0018 §Consequences, 설계 §4).
//  - 클라이언트 기능을 하나도 알리지 않는다(`capabilities: {}`): sampling·elicitation·roots 없음. 서버가 보낸 요청은 `ping` 만 빈 결과로 답하고 나머지는 -32601 로 거절하며 알린다.
//  - 결과는 text 내용만 이어 붙인다. 이미지·오디오·리소스는 버리고 종류별 개수만 센다. 비밀값 가리기는 크기 자르기보다 먼저 한다.
import { Buffer } from 'node:buffer';

import type { Redactor } from './redact.ts';
import { isRecord, type JsonRpcInbound, type RequestOptions, type Transport } from './transport.ts';
import { CLIENT_VERSION, ConnectorFailure, SUPPORTED_PROTOCOL_VERSIONS, type ConnectorCallResult, type ConnectorNotice, type ConnectorServerInfo } from './wire.ts';

export interface ServerTool { name: string; inputSchema: unknown; annotations: Record<string, unknown> | null }

export interface McpClientOptions {
  transport: Transport;
  redactor: Redactor;
  maxResultBytes: number;
  onNotice(notice: ConnectorNotice): void;
  /** 초기화·목록 요청의 시간 제한 (ms) */
  setupTimeoutMs?: number;
}

export const MAX_LIST_PAGES = 20;
export const MAX_LIST_TOOLS = 1000;

export interface McpClient {
  /** 초기화를 (아직이면) 하고 서버 정보를 돌려준다. 실패하면 `init_failed`(definite) */
  ready(): Promise<ConnectorServerInfo>;
  listTools(): Promise<ServerTool[]>;
  callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; retrySafe?: boolean; onRequestId?: (id: number) => void }): Promise<ConnectorCallResult>;
  /** 진행 중인 요청을 서버에서 취소한다(`notifications/cancelled`) */
  cancel(requestId: number, reason: string): Promise<void>;
  close(): Promise<void>;
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const { transport, redactor } = options;
  const setupTimeout = options.setupTimeoutMs ?? 30_000;
  let nextId = 1;
  let initialized: Promise<ConnectorServerInfo> | null = null;

  transport.onClosed(() => { initialized = null; });
  transport.onMessage((message: JsonRpcInbound) => {
    if (typeof message.method !== 'string') return;
    if (message.id !== undefined && message.id !== null) {
      // 서버가 보낸 요청: ping 외에는 모두 거절한다 (클라이언트 기능이 없다)
      if (message.method === 'ping') {
        void transport.reply({ jsonrpc: '2.0', id: message.id, result: {} });
        return;
      }
      void transport.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      options.onNotice({ type: 'server_request_refused', method: redactor.text(message.method).slice(0, 200) });
      return;
    }
    if (message.method === 'notifications/tools/list_changed') options.onNotice({ type: 'list_changed' });
  });

  const rpc = async (method: string, params: unknown, requestOptions: RequestOptions, onId?: (id: number) => void): Promise<unknown> => {
    const id = nextId++;
    onId?.(id);
    const response = await transport.request({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, requestOptions);
    if (response.error !== undefined) {
      const code = typeof response.error.code === 'number' ? response.error.code : 0;
      throw new ConnectorFailure(`rpc_${code}`, redactor.text(String(response.error.message ?? 'error')).slice(0, 500), false);
    }
    return response.result;
  };

  const initialize = async (): Promise<ConnectorServerInfo> => {
    try {
      const result = await rpc('initialize', {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'aot-mcp-connector', version: CLIENT_VERSION },
      }, { timeoutMs: setupTimeout });
      if (!isRecord(result) || typeof result['protocolVersion'] !== 'string') throw new ConnectorFailure('protocol', 'the initialize result is malformed', false);
      const version = result['protocolVersion'];
      if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        throw new ConnectorFailure('protocol_version', `the server chose an unsupported protocol version '${redactor.text(version).slice(0, 40)}'`, false);
      }
      transport.setProtocolVersion(version);
      await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const info = isRecord(result['serverInfo']) ? result['serverInfo'] : {};
      return {
        name: redactor.text(typeof info['name'] === 'string' ? info['name'] : '').slice(0, 100),
        version: redactor.text(typeof info['version'] === 'string' ? info['version'] : '').slice(0, 50),
        protocol_version: version,
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (error instanceof ConnectorFailure) throw new ConnectorFailure('init_failed', `${error.code}: ${error.message}`, true);
      throw new ConnectorFailure('init_failed', error instanceof Error ? error.message : 'initialize failed', true);
    }
  };

  const ready = (): Promise<ConnectorServerInfo> => {
    if (initialized === null) {
      const attempt = initialize();
      initialized = attempt;
      attempt.catch(() => { if (initialized === attempt) initialized = null; });
    }
    return initialized;
  };

  /** 세션 만료 같은 연결 오류에서 한 번 다시 초기화한 뒤 재시도할 수 있는 요청 */
  const withRetry = async <T>(run: () => Promise<T>, retrySafe: boolean): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (retrySafe && error instanceof ConnectorFailure && error.code === 'session_expired') {
        await ready();
        return await run();
      }
      throw error;
    }
  };

  const textOf = (result: Record<string, unknown>): { text: string; dropped: Record<string, number> } => {
    const dropped: Record<string, number> = {};
    const parts: string[] = [];
    const content = Array.isArray(result['content']) ? result['content'] : [];
    for (const item of content) {
      if (isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text']);
      else {
        const type = isRecord(item) && typeof item['type'] === 'string' ? item['type'].slice(0, 32) : 'unknown';
        dropped[type] = (dropped[type] ?? 0) + 1;
      }
    }
    return { text: parts.join('\n'), dropped };
  };

  const truncateBytes = (text: string, max: number): { text: string; truncated: boolean } => {
    if (Buffer.byteLength(text, 'utf8') <= max) return { text, truncated: false };
    return { text: Buffer.from(text, 'utf8').subarray(0, max).toString('utf8').replace(/�$/, ''), truncated: true };
  };

  return {
    ready,
    async listTools(): Promise<ServerTool[]> {
      await ready();
      const tools: ServerTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await withRetry(() => rpc('tools/list', cursor === undefined ? undefined : { cursor }, { timeoutMs: setupTimeout }), true);
        if (!isRecord(result) || !Array.isArray(result['tools'])) throw new ConnectorFailure('protocol', 'the tools/list result is malformed', false);
        for (const entry of result['tools']) {
          if (!isRecord(entry) || typeof entry['name'] !== 'string') continue;
          tools.push({ name: entry['name'], inputSchema: entry['inputSchema'] ?? null, annotations: isRecord(entry['annotations']) ? entry['annotations'] : null });
          if (tools.length > MAX_LIST_TOOLS) throw new ConnectorFailure('list_too_large', 'the server lists too many tools', false);
        }
        const next = result['nextCursor'];
        if (typeof next !== 'string' || next === '' || seen.has(next)) return tools;
        seen.add(next);
        cursor = next;
      }
      throw new ConnectorFailure('list_too_large', 'the server list has too many pages', false);
    },
    async callTool(name, args, callOptions): Promise<ConnectorCallResult> {
      await ready();
      const result = await withRetry(
        () => rpc('tools/call', { name, arguments: args }, callOptions.signal === undefined ? {} : { signal: callOptions.signal }, (id) => { callOptions.onRequestId?.(id); }),
        callOptions.retrySafe === true,
      );
      if (!isRecord(result)) throw new ConnectorFailure('protocol', 'the tools/call result is malformed', false);
      const redacted = redactor.deep(result);
      const { text, dropped } = textOf(redacted);
      const cut = truncateBytes(text, options.maxResultBytes);
      let truncated = cut.truncated;
      let structured: unknown;
      if (redacted['structuredContent'] !== undefined && redacted['structuredContent'] !== null) {
        const size = Buffer.byteLength(JSON.stringify(redacted['structuredContent']), 'utf8');
        if (size <= options.maxResultBytes) structured = redacted['structuredContent'];
        else truncated = true;
      }
      return {
        is_error: redacted['isError'] === true, text: cut.text, ...(structured === undefined ? {} : { structured }),
        ...(truncated ? { truncated: true } : {}), dropped,
      };
    },
    async cancel(requestId, reason): Promise<void> {
      await transport.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: redactor.text(reason).slice(0, 200) } }).catch(() => undefined);
    },
    close: () => transport.close(),
  };
}
