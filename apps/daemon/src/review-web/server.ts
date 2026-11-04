// 읽기 전용 검토 화면의 HTTP 서버. 보안 규칙(docs/operations/review-web.md "보안 모델"):
//   - 127.0.0.1 에만 묶는다(다른 주소는 거부). Host 헤더가 `127.0.0.1:<포트>` 또는 `localhost:<포트>` 가 아니면 421 (DNS 리바인딩 방어).
//   - GET·HEAD 만 받는다. 그 밖은 405. 쓰기 길이 없다(DB 는 읽기 전용으로 열려 있고 이 코드는 쓰기 메서드를 부르지 않는다).
//   - 모든 응답에 CSP(`default-src 'none'`…)·nosniff·no-referrer·no-store·CORP 헤더. 인라인 스크립트·외부 자원 없음.
//   - 요청의 경로·질의는 SQL 에 바인딩 파라미터로만 간다. 파일은 경로가 아니라 증거 행 id 로만 찾는다.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ReviewContext } from './context.ts';
import { readEvidence } from './evidence-file.ts';
import { h, page, type Raw } from './html.ts';
import { APPROVAL_KINDS, approvalDetailPage, approvalsPage, KIND_LABEL, type ApprovalKind } from './pages-approvals.ts';
import { effectsPage, evidenceDetail, evidenceListPage, experimentsPage, homePage, productDetailPage, productsPage } from './pages-more.ts';
import { signalsPage, trialsPage } from './pages-org.ts';

export const LOOPBACK_HOST = '127.0.0.1';
const MAX_URL_CHARS = 2048;
const MAX_SEGMENT_CHARS = 200;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

export interface ReviewServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

const htmlReply = (title: string, body: Raw, status = 200): Reply => ({ status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: page(title, body) });
const notFound = (): Reply => htmlReply('찾을 수 없음', h`<p class="card">그런 화면이 없다. <a href="/">홈으로</a></p>`, 404);

function route(ctx: ReviewContext, segments: string[], query: URLSearchParams): Reply {
  const [first, second, third, fourth] = segments;
  if (first === undefined) return htmlReply('홈', homePage(ctx));
  if (first === 'approvals') {
    if (second === undefined && segments.length === 1) return htmlReply('승인 대기', approvalsPage(ctx));
    if (segments.length === 3 && APPROVAL_KINDS.includes(second as ApprovalKind)) {
      const kind = second as ApprovalKind;
      const detail = approvalDetailPage(ctx, kind, third!);
      return htmlReply(`${KIND_LABEL[kind]} 상세`, detail.body, detail.status);
    }
    return notFound();
  }
  if (first === 'trials' && segments.length === 1) return htmlReply('시험 현황', trialsPage(ctx));
  if (first === 'signals' && segments.length === 1) return htmlReply('조직 신호', signalsPage(ctx));
  if (first === 'effects' && segments.length === 1) return htmlReply('외부 효과 확인 필요', effectsPage(ctx));
  if (first === 'experiments' && segments.length === 1) return htmlReply('실험 결과 검토', experimentsPage(ctx));
  if (first === 'products') {
    if (segments.length === 1) return htmlReply('상품 등록 검토', productsPage(ctx));
    if (segments.length === 2) {
      const detail = productDetailPage(ctx, second!);
      return htmlReply(detail.title, detail.body, detail.status);
    }
    return notFound();
  }
  if (first === 'evidence') {
    if (segments.length === 1) return htmlReply('증거 보기', evidenceListPage(ctx, query.get('task')));
    if (segments.length === 2) {
      const detail = evidenceDetail(ctx, second!);
      return htmlReply(detail.title, detail.body, detail.status);
    }
    if (segments.length === 3 && third === 'file' && fourth === undefined) return imageReply(ctx, second!);
  }
  return notFound();
}

/** 그림 파일: 증거 행이 있고, 로컬 파일 참조이고, 허용 폴더 안이고, 해시가 맞고, 그림 형식(앞부분 바이트)일 때만. 형식은 판정한 것 그대로 내보낸다 */
function imageReply(ctx: ReviewContext, id: string): Reply {
  const row = ctx.db.get<{ ref: string; content_hash: string | null }>('SELECT ref, content_hash FROM evidence WHERE id = ?', [id]);
  if (row === undefined || !row.ref.startsWith('file:')) return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'not found' };
  const view = readEvidence(row, { evidenceDir: ctx.evidenceDir, roots: ctx.roots });
  if (view.kind !== 'image') return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'not an image that can be shown' };
  return { status: 200, headers: { 'Content-Type': view.mime, 'Content-Length': String(view.bytes.length), 'Content-Disposition': 'inline; filename="evidence"' }, body: view.bytes };
}

/** `127.0.0.1:<포트>` 또는 `localhost:<포트>` 만 허용 (대소문자 무시) */
export function hostAllowed(header: string | undefined, port: number): boolean {
  if (header === undefined) return false;
  const value = header.toLowerCase();
  return value === `${LOOPBACK_HOST}:${port}` || value === `localhost:${port}`;
}

export function handle(ctx: ReviewContext, port: number, req: IncomingMessage): Reply {
  if (!hostAllowed(req.headers.host, port)) return { status: 421, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'misdirected request: unexpected Host header' };
  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }, body: 'method not allowed (read-only screen)' };
  const rawUrl = req.url ?? '/';
  if (rawUrl.length > MAX_URL_CHARS || !rawUrl.startsWith('/')) return { status: 414, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'bad request target' };
  let segments: string[];
  let query: URLSearchParams;
  try {
    const url = new URL(rawUrl, `http://${LOOPBACK_HOST}:${port}`);
    query = url.searchParams;
    segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  } catch {
    return { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'bad request' };
  }
  if (segments.some((part) => part.length > MAX_SEGMENT_CHARS || /[\0\r\n]/.test(part))) return { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'bad request' };
  try {
    return route(ctx, segments, query);
  } catch (error) {
    // 내부 오류의 자세한 내용은 화면에 내지 않는다 (DB 값이 섞일 수 있다)
    process.stderr.write(`review-web: ${error instanceof Error ? error.message : String(error)}\n`);
    return htmlReply('오류', h`<p class="card">화면을 만드는 중 오류가 났다. 서버 로그를 본다.</p>`, 500);
  }
}

function send(req: IncomingMessage, res: ServerResponse, reply: Reply): void {
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  res.writeHead(reply.status, { ...SECURITY_HEADERS, ...reply.headers, 'Content-Length': String(body.length) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export async function startReviewServer(ctx: ReviewContext, options: { port?: number; host?: string } = {}): Promise<ReviewServer> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) throw new Error(`review-web listens only on ${LOOPBACK_HOST} (got '${host}')`);
  const requested = options.port ?? 0;
  if (!Number.isInteger(requested) || requested < 0 || requested > 65_535) throw new RangeError('port must be an integer from 0 to 65535');
  let port = requested;
  const server = createServer((req, res) => send(req, res, handle(ctx, port, req)));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requested, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    server, port, url: `http://${LOOPBACK_HOST}:${port}/`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
