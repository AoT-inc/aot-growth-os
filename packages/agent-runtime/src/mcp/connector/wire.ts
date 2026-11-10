// 데몬 ↔ 커넥터 줄 단위 JSON 프로토콜의 타입 (docs/plans/mcp-connector.md §3). 호스트(site-client.ts)와 커넥터가 같이 쓴다.
// 이 폴더의 파일은 node: 내장 모듈과 같은 폴더의 파일만 import 한다 (.dependency-cruiser.cjs 의 mcp-connector-isolated).

export const CLIENT_VERSION = '1.0.0';
/** 커넥터가 아는 MCP 프로토콜 버전 (최신이 먼저) */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;
/** 줄 하나의 최대 바이트 (넘으면 호스트가 커넥터를 죽이고 다시 띄운다) */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

export type ConnectorTransportConfig =
  | { kind: 'http'; url: string }
  | { kind: 'stdio'; command: string; args: string[] };

/** 비밀값 자체가 아니라 *환경 변수 이름*만 싣는다. 커넥터가 자기 환경에서 읽는다 */
export type ConnectorAuthConfig =
  | { kind: 'none' }
  | { kind: 'bearer'; token_env: string }
  | { kind: 'header'; header: string; value_env: string }
  /** 접근 토큰은 설정이 아니라 호스트가 보내는 `token` 줄로 온다 (ADR-0018 개정 1) */
  | { kind: 'oauth_delegated' };

export interface ConnectorConfig {
  type: 'config';
  site: string;
  transport: ConnectorTransportConfig;
  auth: ConnectorAuthConfig;
  /** stdio 서버가 받을 환경: 서버가 받을 이름 → 커넥터(=데몬이 넘긴) 환경 변수 이름 */
  env_from: Record<string, string>;
  /** 오너가 선언한 서버 도구 이름. 이 밖의 도구는 부르지 않는다 */
  tools: string[];
  max_result_bytes: number;
  client_version: string;
  /** 확인 명령(mcp-pin) 전용: 선언 밖 도구의 스키마도 `list` 로 내주고 `call` 은 모두 거부한다 */
  inspect?: boolean;
}

export interface ConnectorToolInfo {
  name: string;
  input_schema_sha256: string;
  input_schema: unknown;
  annotations: Record<string, unknown> | null;
}

export interface ConnectorServerInfo { name: string; version: string; protocol_version: string }

export type ConnectorRequest =
  | { id: number; op: 'list' }
  | { id: number; op: 'call'; tool: string; arguments: Record<string, unknown>; retry_safe?: boolean }
  | { id: number; op: 'cancel'; target_id: number };

export interface ConnectorCallResult {
  is_error: boolean;
  text: string;
  structured?: unknown;
  truncated?: boolean;
  dropped: Record<string, number>;
}

export interface ConnectorError { code: string; message: string; definite: boolean }

export type ConnectorResponse =
  | { id: number; ok: true; tools: ConnectorToolInfo[]; undeclared: string[]; server: ConnectorServerInfo }
  | { id: number; ok: true; result: ConnectorCallResult }
  | { id: number; ok: true }
  | { id: number; ok: false; error: ConnectorError };

/** 호스트 → 커넥터 (id 없음): 로그인 위임 사이트의 현재 접근 토큰. null 이면 토큰이 없다(요청은 서버에 닿기 전에 막힌다) */
export interface ConnectorTokenMessage { type: 'token'; access_token: string | null }

export type ConnectorNotice =
  | { type: 'list_changed' }
  | { type: 'server_request_refused'; method: string }
  /** 서버 요청이 분당 상한을 넘어 조용히 버려진 건수 (한 번에 합쳐 알린다) */
  | { type: 'server_requests_suppressed'; count: number };

/** 커넥터 안에서 쓰는 오류: `definite` 는 서버에 요청이 닿지 않았음이 확실한가 */
export class ConnectorFailure extends Error {
  readonly code: string;
  readonly definite: boolean;
  constructor(code: string, message: string, definite = false) {
    super(message);
    this.name = 'ConnectorFailure';
    this.code = code;
    this.definite = definite;
  }
}
