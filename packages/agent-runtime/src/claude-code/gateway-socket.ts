// 호스트 쪽 게이트웨이 소켓 (CC1). CLI 는 MCP 서버를 *자기 자식 프로세스*로 띄우므로(`--mcp-config` 의 stdio 서버), 도구 게이트웨이(`ToolGateway`, 이 프로세스 안)와는
// 소켓으로 잇는다: CLI → 브리지(gateway-mcp-bridge.ts, MCP stdio 서버) → 이 소켓 → `ToolGateway.call`.
//  - 소켓은 run 전용 디렉터리(0700)의 유닉스 소켓이다. 첫 줄이 run 별 무작위 토큰(`hello`)과 맞아야 한다. 틀리면 연결을 끊는다. 동시에 연결 하나만 받는다.
//  - 정책 판정·허용 목록·비용 계량은 전부 `ToolGateway` 의 일이다. 이 파일은 줄 단위 JSON 을 옮길 뿐이고, 허용 도구 이름 목록으로 한 번 더 거른다(이중 방어).
//  - 줄 크기는 MAX_FRAME_BYTES 로 막는다(개행 전 누적 포함). 동시 처리 호출 수에 상한이 있다. run 이 끝나면(`close`) 소켓 파일을 지운다.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import type { JsonObject, ToolGateway } from '../contract.ts';
import { MAX_FRAME_BYTES } from '../wire.ts';
import { createLineReader } from '../line-reader.ts';
import { isJsonObject } from '../validate.ts';

export const GATEWAY_SOCKET_FILE = 'gw.sock';
/** 유닉스 소켓 경로 상한(macOS 104, Linux 108)에서 여유를 둔 값 */
export const MAX_SOCKET_PATH_BYTES = 100;

export interface GatewaySocket {
  readonly path: string;
  readonly token: string;
  /** 처리를 시작한 도구 호출 수 */
  calls(): number;
  /** 소켓을 닫고 파일을 지운다. 진행 중이던 호출의 답은 버린다 */
  close(): Promise<void>;
}

export interface GatewaySocketOptions {
  /** run 전용 디렉터리 (0700 으로 이미 만들어져 있어야 한다) */
  dir: string;
  gateway: ToolGateway;
  /** 이 이름들만 게이트웨이로 넘긴다 */
  allowedTools: readonly string[];
  maxInFlight?: number;
}

interface Request { id: number; tool: string; args: JsonObject }

function parseRequest(line: string): Request | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isJsonObject(value)) return null;
  const { id, tool, args } = value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof tool !== 'string' || tool === '' || !isJsonObject(args)) return null;
  return { id, tool, args };
}

export async function serveGatewaySocket(options: GatewaySocketOptions): Promise<GatewaySocket> {
  const path = join(options.dir, GATEWAY_SOCKET_FILE);
  if (Buffer.byteLength(path, 'utf8') > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`the gateway socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes; use a shorter run root directory`);
  }
  const token = randomBytes(24).toString('hex');
  const tokenBytes = Buffer.from(token, 'utf8');
  const allowed = new Set(options.allowedTools);
  const maxInFlight = options.maxInFlight ?? 4;
  let calls = 0;
  let closed = false;
  let active: Socket | null = null;

  const server: Server = createServer((socket) => {
    if (closed || active !== null) {
      socket.destroy();
      return;
    }
    active = socket;
    socket.on('error', () => undefined);
    socket.on('close', () => { if (active === socket) active = null; });
    const reader = createLineReader(MAX_FRAME_BYTES);
    let authenticated = false;
    let inFlight = 0;
    const reply = (value: Record<string, unknown>): void => {
      if (closed || socket.destroyed) return;
      socket.write(`${JSON.stringify(value)}\n`);
    };
    socket.on('data', (chunk: Buffer) => {
      for (const event of reader.push(chunk)) {
        if (event.kind === 'too_long') return void socket.destroy();
        if (!authenticated) {
          let hello: unknown;
          try {
            hello = (JSON.parse(event.line) as { hello?: unknown }).hello;
          } catch {
            hello = null;
          }
          const given = typeof hello === 'string' ? Buffer.from(hello, 'utf8') : Buffer.alloc(0);
          if (given.length !== tokenBytes.length || !timingSafeEqual(given, tokenBytes)) return void socket.destroy();
          authenticated = true;
          continue;
        }
        const request = parseRequest(event.line);
        if (request === null) return void socket.destroy();
        if (!allowed.has(request.tool)) {
          reply({ id: request.id, ok: false, error: 'tool_not_allowed' });
          continue;
        }
        if (inFlight >= maxInFlight) {
          reply({ id: request.id, ok: false, error: 'too_many_calls' });
          continue;
        }
        inFlight += 1;
        calls += 1;
        void (async () => {
          try {
            const response = await options.gateway.call(request.tool, request.args);
            reply(response.ok ? { id: request.id, ok: true, result: response.result } : { id: request.id, ok: false, error: response.error });
          } catch {
            reply({ id: request.id, ok: false, error: 'gateway_error' });
          } finally {
            inFlight -= 1;
          }
        })();
      }
    });
  });

  await rm(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    path,
    token,
    calls: () => calls,
    async close() {
      if (closed) return;
      closed = true;
      active?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(path, { force: true });
    },
  };
}
