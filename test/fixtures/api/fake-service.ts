// API 전송 시험용 가짜 HTTP 서비스: 127.0.0.1 임시 포트. 받은 요청을 모두 기록하고, 응답은 시험이 정하는 핸들러가 만든다. 외부 네트워크 없음.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

export interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
export type Handler = (seen: Seen, res: ServerResponse) => void;

export interface FakeService {
  port: number;
  baseUrl: string;
  seen: Seen[];
  /** 이후 요청의 응답을 바꾼다 */
  handle(handler: Handler): void;
  close(): Promise<void>;
}

export const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
};

export const POSTS = [
  { name: 'a-post.md', type: 'file', sha: 'f00dfeed', download_url: 'http://internal.invalid/secret-a' },
  { name: 'b-post.md', type: 'file', sha: 'beadbeef', download_url: 'http://internal.invalid/secret-b' },
];

const defaultHandler: Handler = (seen, res) => {
  if (seen.method === 'GET') return json(res, 200, POSTS);
  json(res, 201, { commit: { sha: 'c0ffee1234', html_url: 'http://gitea.invalid/aot/aot-web/commit/c0ffee1234', author: { email: 'bot@example.invalid' } }, files: [] });
};

export async function startFakeService(t: TestContext, prefix = '', initial: Handler = defaultHandler): Promise<FakeService> {
  const seen: Seen[] = [];
  let handler = initial;
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      handler(entry, res);
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const service: FakeService = {
    port, baseUrl: `http://127.0.0.1:${port}${prefix}`, seen,
    handle: (next) => { handler = next; },
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
  t.after(() => service.close());
  return service;
}
