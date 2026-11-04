// 읽기 전용 검토 화면의 HTTP 서버. 보안 규칙(docs/operations/review-web.md "보안 모델"):
//   - 127.0.0.1 에만 묶는다(다른 주소는 거부). Host 헤더가 `127.0.0.1:<포트>` 또는 `localhost:<포트>` 가 아니면 421 (DNS 리바인딩 방어).
//   - GET·HEAD 만 받는다. 그 밖은 405. 쓰기 길이 없다(DB 는 읽기 전용으로 열려 있고 이 코드는 쓰기 메서드를 부르지 않는다).
//   - 접근 토큰: 시작할 때 무작위 토큰을 만들어 터미널에 한 번만 찍는다. 토큰이 맞는 요청은 HttpOnly·SameSite=Strict 쿠키를 받고 토큰 없는 주소로 303, 쿠키 없는 그 밖의 요청은 401 (같은 PC 의 다른 프로세스·사용자가 읽지 못하게).
//   - 모든 응답에 CSP(`default-src 'none'`…)·nosniff·no-referrer·no-store·CORP 헤더. 인라인 스크립트·외부 자원 없음.
//   - 요청의 경로·질의는 SQL 에 바인딩 파라미터로만 간다. 파일은 경로가 아니라 증거 행 id 로만 찾는다.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ReviewContext } from './context.ts';
import { readEvidence } from './evidence-file.ts';
import { h, page, type Raw } from './html.ts';
import {
  approvalDetail, batchDetail, effectsDetail, evidenceDetail, evidenceList, experimentDetail, homePage, productDetail, signalDetail, trialDetail, watchPage, type Rendered,
} from './pages.ts';

export const LOOPBACK_HOST = '127.0.0.1';
export const COOKIE_NAME = 'aot_review';
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
  /** 처음 한 번 알려 주는 토큰 주소. 이 주소로 들어오면 쿠키가 설정된다. 다른 곳에 기록하지 않는다 */
  readonly tokenUrl: string;
  readonly token: string;
  close(): Promise<void>;
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

const htmlReply = (title: string, body: Raw, status = 200): Reply => ({ status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: page(title, body) });
const notFound = (): Reply => htmlReply('찾을 수 없습니다', h`<p class="card">그런 화면이 없습니다. <a href="/">결정할 일로 가기</a></p>`, 404);

function route(ctx: ReviewContext, segments: string[], query: URLSearchParams): Reply {
  const [first, second, third] = segments;
  const out = (r: Rendered): Reply => htmlReply(r.title, r.body, r.status);
  if (first === undefined) return out(homePage(ctx));
  if (segments.length === 1) {
    if (first === 'watch') return out(watchPage(ctx));
    if (first === 'effects') return out(effectsDetail(ctx));
    if (first === 'evidence') return out(evidenceList(ctx, query.get('task')));
  }
  if (segments.length === 3 && first === 'approvals') return out(approvalDetail(ctx, second!, third!));
  if (segments.length === 2) {
    if (first === 'batch') return out(batchDetail(ctx, second!));
    if (first === 'products') return out(productDetail(ctx, second!));
    if (first === 'experiments') return out(experimentDetail(ctx, second!));
    if (first === 'trials') return out(trialDetail(ctx, second!));
    if (first === 'signals') return out(signalDetail(ctx, second!));
    if (first === 'evidence') return out(evidenceDetail(ctx, second!));
  }
  if (segments.length === 3 && first === 'evidence' && third === 'file') return imageReply(ctx, second!);
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

/** 상수 시간 비교 (길이가 달라도 해시로 맞춰 비교한다) */
function tokenEquals(given: string | null | undefined, token: string): boolean {
  if (typeof given !== 'string' || given === '') return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(token));
}

function cookieToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === COOKIE_NAME) return part.slice(index + 1).trim();
  }
  return null;
}

const unauthorized = (): Reply => htmlReply('인증이 필요합니다', h`<p class="card">이 화면은 서버를 시작한 사람만 볼 수 있습니다. 서버를 시작할 때 터미널에 찍힌 주소(<code>?token=…</code> 이 붙은 주소)로 처음 들어오세요. 한 번 들어오면 이 브라우저는 계속 볼 수 있습니다.</p>`, 401);

export function handle(ctx: ReviewContext, port: number, req: IncomingMessage, token: string): Reply {
  if (!hostAllowed(req.headers.host, port)) return { status: 421, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'misdirected request: unexpected Host header' };
  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }, body: 'method not allowed (read-only screen)' };
  const rawUrl = req.url ?? '/';
  if (rawUrl.length > MAX_URL_CHARS || !rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.includes('\\')) return { status: 414, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'bad request target' };
  let segments: string[];
  let query: URLSearchParams;
  try {
    const url = new URL(rawUrl, `http://${LOOPBACK_HOST}:${port}`);
    // 인증: 토큰이 맞으면 쿠키를 주고 토큰 없는 같은 주소로 보낸다. 쿠키가 맞지 않으면 401
    if (url.searchParams.has('token')) {
      if (!tokenEquals(url.searchParams.get('token'), token)) return unauthorized();
      url.searchParams.delete('token');
      return {
        status: 303, body: '',
        headers: { Location: `${url.pathname.replace(/^\/+/, '/')}${url.searchParams.size === 0 ? '' : `?${url.searchParams.toString()}`}`, 'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Content-Type': 'text/plain; charset=utf-8' },
      };
    }
    if (!tokenEquals(cookieToken(req.headers.cookie), token)) return unauthorized();
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
    return htmlReply('오류', h`<p class="card">화면을 만드는 중 오류가 났습니다. 서버 로그를 확인하세요.</p>`, 500);
  }
}

function send(req: IncomingMessage, res: ServerResponse, reply: Reply): void {
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  res.writeHead(reply.status, { ...SECURITY_HEADERS, ...reply.headers, 'Content-Length': String(body.length) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export async function startReviewServer(ctx: ReviewContext, options: { port?: number; host?: string; token?: string } = {}): Promise<ReviewServer> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) throw new Error(`review-web listens only on ${LOOPBACK_HOST} (got '${host}')`);
  const requested = options.port ?? 0;
  if (!Number.isInteger(requested) || requested < 0 || requested > 65_535) throw new RangeError('port must be an integer from 0 to 65535');
  let port = requested;
  const token = options.token ?? randomBytes(32).toString('hex');
  const server = createServer((req, res) => send(req, res, handle(ctx, port, req, token)));
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
    server, port, token, url: `http://${LOOPBACK_HOST}:${port}/`, tokenUrl: `http://${LOOPBACK_HOST}:${port}/?token=${token}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
