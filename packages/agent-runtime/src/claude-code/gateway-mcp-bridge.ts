// 게이트웨이 MCP 브리지 (CC1). `claude` 가 `--mcp-config` 로 이 파일을 자식 프로세스(MCP stdio 서버)로 띄운다: `node gateway-mcp-bridge.ts <소켓 경로> <도구 목록 json 경로>`,
// 토큰은 환경 변수 `AOT_GATEWAY_TOKEN`. MCP 요청(`tools/list`, `tools/call`)을 호스트의 게이트웨이 소켓(gateway-socket.ts)으로 옮기고 답을 돌려준다.
// 이 파일은 CLI 의 자식으로 *따로* 돈다. 그래서 의존성이 없다(node 내장 모듈만, 패키지 import 없음 — 에이전트 쪽 코드가 호스트 코드를 끌고 들어오지 않게).
// 정책 판단·허용 목록 판정은 하지 않는다(호스트의 게이트웨이가 한다). MCP stdio 전송은 줄 단위 JSON-RPC 다.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CALL_TIMEOUT_MS = 10 * 60_000;

interface ToolEntry { name: string; description: string }
type Pending = { resolve: (value: { ok: true; result: unknown } | { ok: false; error: string }) => void; timer: ReturnType<typeof setTimeout> };

const [socketPath, toolsPath] = process.argv.slice(2);
const token = process.env['AOT_GATEWAY_TOKEN'] ?? '';
if (socketPath === undefined || toolsPath === undefined || token === '') {
  process.stderr.write('usage: gateway-mcp-bridge <socket> <tools.json> (AOT_GATEWAY_TOKEN required)\n');
  process.exit(2);
}

const tools: ToolEntry[] = JSON.parse(readFileSync(toolsPath, 'utf8')) as ToolEntry[];
const pending = new Map<number, Pending>();
let nextId = 1;
let socketUp = false;

const socket = connect(socketPath);
let socketBuffer = '';
socket.on('connect', () => {
  socketUp = true;
  socket.write(`${JSON.stringify({ hello: token })}\n`);
});
socket.on('data', (chunk: Buffer) => {
  socketBuffer += chunk.toString('utf8');
  let newline = socketBuffer.indexOf('\n');
  while (newline !== -1) {
    const line = socketBuffer.slice(0, newline);
    socketBuffer = socketBuffer.slice(newline + 1);
    newline = socketBuffer.indexOf('\n');
    let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue;
    }
    const entry = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (entry === undefined || typeof message.id !== 'number') continue;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message.ok === true ? { ok: true, result: message.result } : { ok: false, error: typeof message.error === 'string' ? message.error : 'gateway_error' });
  }
});
const failAll = (error: string): void => {
  socketUp = false;
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error });
    pending.delete(id);
  }
};
socket.on('error', () => failAll('gateway_unavailable'));
socket.on('close', () => failAll('gateway_unavailable'));

function callGateway(tool: string, args: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (!socketUp) return Promise.resolve({ ok: false, error: 'gateway_unavailable' });
  const id = nextId;
  nextId += 1;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'tool_timeout' });
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    socket.write(`${JSON.stringify({ id, tool, args })}\n`);
  });
}

const send = (message: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

async function handle(request: { id?: number | string | null; method?: string; params?: Record<string, unknown> }): Promise<void> {
  const { id, method, params } = request;
  if (id === undefined || id === null) return; // 알림(notifications/initialized 등)에는 답하지 않는다
  switch (method) {
    case 'initialize': {
      const asked = typeof params?.['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      return send({ id, result: { protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'aot-gateway', version: '0.0.0' } } });
    }
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: { type: 'object', additionalProperties: true } })) } });
    case 'tools/call': {
      const name = params?.['name'];
      const args = params?.['arguments'] ?? {};
      if (typeof name !== 'string' || typeof args !== 'object' || args === null || Array.isArray(args)) {
        return send({ id, error: { code: -32602, message: 'invalid tools/call parameters' } });
      }
      const response = await callGateway(name, args);
      if (response.ok) return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(response.result) }] } });
      return send({ id, result: { isError: true, content: [{ type: 'text', text: response.error }] } });
    }
    default:
      return send({ id, error: { code: -32601, message: `method not found: ${String(method)}` } });
  }
}

let inputBuffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  inputBuffer += chunk.toString('utf8');
  let newline = inputBuffer.indexOf('\n');
  while (newline !== -1) {
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    newline = inputBuffer.indexOf('\n');
    if (line === '') continue;
    try {
      void handle(JSON.parse(line) as Parameters<typeof handle>[0]);
    } catch {
      send({ id: null, error: { code: -32700, message: 'parse error' } });
    }
  }
});
process.stdin.on('end', () => {
  socket.destroy();
  process.exit(0);
});
