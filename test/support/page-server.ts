// 시험용 로컬 HTTP 서버 (127.0.0.1, 임시 포트). `fetch_url` 시험과 조사 에이전트 주입 시나리오가 "외부 웹 페이지" 로 쓴다.
// 받은 요청(메서드·경로·헤더)과 연결 수를 기록해 "서버에 아무것도 닿지 않았다" 를 확인할 수 있게 한다. 외부 네트워크는 쓰지 않는다.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { TestContext } from 'node:test';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export interface PageServer {
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  readonly requests: RecordedRequest[];
  /** 지금까지 열린 TCP 연결 수 */
  connections(): number;
  /** 지금 열려 있는 연결 수 */
  openConnections(): number;
  /** 경로별 핸들러를 바꾼다 (없는 경로는 404) */
  route(path: string, handler: PageHandler): void;
  close(): Promise<void>;
}

export type PageHandler = (req: IncomingMessage, res: ServerResponse) => void;

export const html = (body: string, status = 200): PageHandler => (_req, res) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

export const text = (body: string, type = 'text/plain; charset=utf-8', status = 200): PageHandler => (_req, res) => {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
};

export const redirect = (location: string, status = 302): PageHandler => (_req, res) => {
  res.writeHead(status, { location });
  res.end('moved');
};

export async function startPageServer(t: TestContext, routes: Record<string, PageHandler> = {}): Promise<PageServer> {
  const table = new Map<string, PageHandler>(Object.entries(routes));
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let total = 0;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requests.push({ method: req.method ?? '', path: req.url ?? '/', headers: req.headers });
    const handler = table.get(path);
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    handler(req, res);
  });
  server.on('connection', (socket) => {
    total += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    connections: () => total,
    openConnections: () => sockets.size,
    route: (path, handler) => void table.set(path, handler),
    close,
  };
}
