// API 전송의 클라이언트 (ADR-0020): `McpClient` 와 같은 모양으로 main.ts 의 list/call/cancel 흐름에 끼어든다.
// `list` 는 오너 선언에서 합성한 도구 목록을 내고, `call` 은 선언된 동작 하나를 HTTP 요청으로 바꿔 보낸다. 선언에 없는 동작·인자는 보낼 수 없다.
// 응답은 읽기에서만 `returns` 허용 목록으로 걸러 돌려주고, 쓰기는 상태와 `record` 필드만 돌려준다. 비밀이 되돌아오면 가린다.
import { buildApiRequest, ApiBuildError, selectFields, ShapeError, tryRecordFields } from './api-request.ts';
import { checkApiArguments, synthInputSchema, type ApiNetwork, type ApiOperation } from './api-decl.ts';
import { executeApiRequest } from './api-http.ts';
import type { McpClient } from './client.ts';
import type { Redactor } from './redact.ts';
import { ConnectorFailure, type ConnectorCallResult } from './wire.ts';

export interface ApiTransportConfig {
  kind: 'api';
  base_url: string;
  network: ApiNetwork;
  timeout_ms: number;
  /** 서버 도구 이름(동작 이름) → 정규형 선언과 호스트가 계산한 선언 해시 */
  operations: Record<string, { op: ApiOperation; decl_hash: string }>;
}

export interface ApiClientOptions {
  transport: ApiTransportConfig;
  /** 인증 헤더(소문자 이름 → 값). 비밀 값이 들어 있다 */
  authHeaders: Record<string, string>;
  redactor: Redactor;
  maxResultBytes: number;
}

const isJsonType = (type: string | null): boolean => type !== null && (type === 'application/json' || type.endsWith('+json'));
const toolError = (text: string, truncated = false): ConnectorCallResult => ({ is_error: true, text, ...(truncated ? { truncated: true } : {}), dropped: {} });

export function createApiClient(options: ApiClientOptions): McpClient {
  const { transport, redactor } = options;
  const baseUrl = new URL(transport.base_url);
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  const operations = new Map(Object.entries(transport.operations));

  return {
    ready: () => Promise.resolve({ name: 'aot-api-connector', version: '1', protocol_version: 'api' }),
    listTools: () => Promise.resolve([...operations].map(([name, entry]) => ({ name, inputSchema: synthInputSchema(entry.op, entry.decl_hash), annotations: null }))),
    async callTool(name, args, callOptions): Promise<ConnectorCallResult> {
      const entry = Object.hasOwn(Object.fromEntries(operations), name) ? operations.get(name) : undefined;
      if (entry === undefined) throw new ConnectorFailure('undeclared_tool', 'the operation is not declared by the owner', true);
      const { op } = entry;
      const problem = checkApiArguments(op, args, { effectKeyPresent: true });
      if (problem !== null) throw new ConnectorFailure('invalid_arguments', problem, true);
      let built;
      try { built = buildApiRequest(op, args, basePath); } catch (error) {
        throw new ConnectorFailure('invalid_arguments', error instanceof ApiBuildError ? error.message : 'the request could not be assembled', true);
      }
      const isWrite = op.returns.length === 0; // 선언 검증: 읽기는 returns 가 1개 이상, 쓰기는 returns 가 없다
      const response = await executeApiRequest({
        baseUrl, network: transport.network, timeoutMs: transport.timeout_ms, maxBodyBytes: options.maxResultBytes, authHeaders: options.authHeaders,
      }, built, callOptions.signal);
      const { status } = response;
      if (status >= 500) throw new ConnectorFailure('http_5xx', `the service answered ${status}`, false);
      if (status >= 300 && status < 400) return toolError(`http ${status} (redirects are not followed)`);
      if (status < 200 || status >= 300) return toolError(`http ${status}`);
      // 2xx
      let json: unknown;
      let parsed = false;
      if (!response.encoded && !response.truncated && isJsonType(response.contentType)) {
        try { json = JSON.parse(response.body.toString('utf8')) as unknown; parsed = true; } catch { /* JSON 이 아니다 */ }
      }
      if (isWrite) {
        const fields = parsed ? tryRecordFields(json, op.record) : {};
        return { is_error: false, text: 'ok', structured: redactor.deep(fields), dropped: {} };
      }
      if (response.truncated) return toolError(`the response is larger than ${options.maxResultBytes} bytes`, true);
      if (response.encoded) return toolError('the response is compressed and is not read');
      if (!parsed) return toolError('the response is not JSON');
      let fields: unknown;
      try { fields = selectFields(json, op.returns); } catch (error) {
        return toolError(error instanceof ShapeError ? `the response does not have the declared shape: ${error.message}` : 'the response does not have the declared shape');
      }
      const clean = redactor.deep(fields);
      return { is_error: false, text: JSON.stringify(clean), structured: clean, dropped: {} };
    },
    cancel: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
