// provider webhook 수신 리스너 (ADR-0014 §10). 설정 `phone.webhook` 이 있을 때만 열린다. 기본 바인드는 127.0.0.1 이다: 외부 노출은 TLS 를 끝내는 역방향 프록시나
// 터널이 맡는다(이 리스너는 TLS 를 하지 않는다). 인증은 어댑터가 한다(`PhonePort.parseWebhook`) — 이 서버는 경로·메서드·크기만 제한하고 본문을 그대로 넘긴다.
//  - 정해진 경로의 POST 만 받는다 (그 밖은 404/405). 본문은 `maxBodyBytes`(기본 1 MiB) 를 넘으면 413.
//  - 처리 중 예상 밖 오류는 500 으로 답한다(본문 없음): provider 가 재전송하고 이벤트는 멱등이라 안전하다.
import { createServer, type Server } from 'node:http';

import type { PhoneRuntime } from './phone.ts';

export interface WebhookServerOptions {
  runtime: Pick<PhoneRuntime, 'ingest'>;
  host: string;
  port: number;
  path: string;
  maxBodyBytes?: number;
  onError?: (error: unknown) => void;
}

export interface WebhookServer {
  readonly port: number;
  close(): Promise<void>;
}

export function startPhoneWebhookServer(options: WebhookServerOptions): Promise<WebhookServer> {
  const limit = options.maxBodyBytes ?? 1024 * 1024;
  const server: Server = createServer((request, response) => {
    const reply = (status: number, body?: unknown): void => {
      response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if ((request.url ?? '').split('?')[0] !== options.path) return reply(404);
    if (request.method !== 'POST') return reply(405);
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      response.writeHead(413, { connection: 'close' });
      return void response.end(() => request.destroy());
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('error', (error) => options.onError?.(error)); // 연결이 중간에 끊겨도 처리기를 부르지 않는다
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        // 본문을 더 읽지 않고 413 을 먼저 보낸 뒤 연결을 닫는다
        tooLarge = true;
        response.writeHead(413, { connection: 'close' });
        response.end(() => request.destroy());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
      options.runtime.ingest({ headers, body: Buffer.concat(chunks).toString('utf8') }).then(
        (result) => reply(result.status, result.body),
        (error: unknown) => {
          options.onError?.(error);
          reply(500);
        },
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : options.port,
        close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}
