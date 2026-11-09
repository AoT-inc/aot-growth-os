// MCP 전송 공통 모양. 요청은 같은 id 의 응답을 돌려주고, 서버가 먼저 보낸 메시지(요청·알림)는 handler 로 간다.
import { ConnectorFailure } from './wire.ts';

export interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
export interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
export interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }
/** 서버가 보낸 메시지 하나 (요청이면 id+method, 알림이면 method 만, 응답이면 result/error) */
export interface JsonRpcInbound { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }

export interface Transport {
  request(message: JsonRpcRequest, options?: RequestOptions): Promise<JsonRpcResponse>;
  notify(message: JsonRpcNotification): Promise<void>;
  /** 서버가 보낸 요청에 대한 응답을 돌려보낸다 */
  reply(message: JsonRpcResponse): Promise<void>;
  /** 서버가 먼저 보낸 요청·알림 */
  onMessage(handler: (message: JsonRpcInbound) => void): void;
  /** 연결이 끊겨 다시 초기화해야 할 때 (stdio 서버 종료 등) */
  onClosed(handler: () => void): void;
  /** 초기화 협상이 끝난 프로토콜 버전 (HTTP 의 MCP-Protocol-Version 헤더) */
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function abortError(signal: AbortSignal | undefined): ConnectorFailure {
  return new ConnectorFailure('aborted', signal?.reason instanceof Error ? signal.reason.message : 'request aborted', false);
}
