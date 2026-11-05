// 검토 화면의 HTTP 서버. 보안 규칙(docs/operations/review-web.md "보안 모델"):
//   - 127.0.0.1 에만 묶는다(다른 주소는 거부). Host 헤더가 `127.0.0.1:<포트>` 또는 `localhost:<포트>` 가 아니면 421 (DNS 리바인딩 방어).
//   - GET·HEAD 와, 결정을 켠 때(`--actor`)의 `POST /decide` 만 받는다. 그 밖은 405. DB 는 읽기 전용으로 열려 있고 이 코드는 쓰기 메서드를 부르지 않는다: 결정은 승인 엔진 소켓으로만 간다(decide.ts).
//   - POST 는 쿠키(SameSite=Strict) + Origin(필수, 같은 호스트) + Sec-Fetch-Site(있으면 same-origin) + Content-Type(폼) + 본문 16KB·읽기 시간 제한 + 세션에 묶인 1회용 nonce 를 모두 통과해야 한다. 결과는 PRG(303 /result/<무작위 id>).
//   - 접근 토큰: 시작할 때 무작위 토큰을 만들어 터미널에 한 번만 찍는다. 토큰이 맞는 요청은 HttpOnly·SameSite=Strict 쿠키를 받고 토큰 없는 주소로 303, 쿠키 없는 그 밖의 요청은 401 (같은 PC 의 다른 프로세스·사용자가 읽지 못하게).
//   - 모든 응답에 CSP(`default-src 'none'`, `form-action 'self'`…)·nosniff·same-origin(Referrer-Policy)·no-store·CORP 헤더. 인라인 스크립트·외부 자원 없음.
//   - 요청의 경로·질의는 SQL 에 바인딩 파라미터로만 간다. 파일은 경로가 아니라 증거 행 id 로만 찾는다.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ReviewContext } from './context.ts';
import { decide, resultPage } from './decide.ts';
import { readEvidence } from './evidence-file.ts';
import { h, page, type Raw } from './html.ts';
import { FormGuard } from './nonce.ts';
import {
  approvalDetail, batchDetail, delegatedPage, effectsDetail, evidenceDetail, evidenceList, experimentDetail, homePage, productDetail, signalDetail, trialDetail, watchPage, type Rendered,
} from './pages.ts';

export const LOOPBACK_HOST = '127.0.0.1';
export const COOKIE_NAME = 'aot_review';
const MAX_URL_CHARS = 2048;
const MAX_SEGMENT_CHARS = 200;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  // `no-referrer` 이면 브라우저가 같은 출처 POST 의 Origin 을 `null` 로 보내 출처 확인이 불가능해진다. `same-origin` 은 다른 사이트에는 아무 것도 보내지 않고 같은 출처에는 Origin 을 정상으로 보낸다
  'Referrer-Policy': 'same-origin',
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

const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 5_000;
const FORM_TYPE = 'application/x-www-form-urlencoded';

const htmlReply = (title: string, body: Raw, status = 200, ctx?: ReviewContext): Reply => ({
  status, headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: page(title, body, ctx === undefined ? {} : { mode: ctx.write === null ? 'readonly' : 'decide', notice: ctx.notice }),
});
const plain = (status: number, message: string, extra: Record<string, string> = {}): Reply => ({ status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra }, body: message });
const notFound = (ctx?: ReviewContext): Reply => htmlReply('찾을 수 없습니다', h`<p class="card">그런 화면이 없습니다. <a href="/">결정할 일로 가기</a></p>`, 404, ctx);

function route(ctx: ReviewContext, segments: string[], query: URLSearchParams): Reply {
  const [first, second, third] = segments;
  const out = (r: Rendered): Reply => htmlReply(r.title, r.body, r.status, ctx);
  if (first === undefined) return out(homePage(ctx));
  if (segments.length === 1) {
    if (first === 'watch') return out(watchPage(ctx));
    if (first === 'delegated') return out(delegatedPage(ctx));
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
  if (segments.length === 2 && first === 'result' && /^[0-9a-f]{32}$/.test(second!)) {
    const result = resultPage(ctx, second!);
    return result === null ? notFound(ctx) : htmlReply(result.title, result.body, 200, ctx);
  }
  return notFound(ctx);
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

/** POST 의 출처 확인: Origin 이 반드시 있고, 이 서버의 주소(127.0.0.1 또는 localhost, 같은 포트)이며, Host 와 같아야 한다 */
export function originAllowed(origin: string | undefined, host: string | undefined, port: number): boolean {
  if (origin === undefined || host === undefined) return false;
  const value = origin.toLowerCase();
  return (value === `http://${LOOPBACK_HOST}:${port}` || value === `http://localhost:${port}`) && value === `http://${host.toLowerCase()}`;
}

/** 폼 본문 읽기: 16KB 이하, 5초 안 */
function readBody(req: IncomingMessage): Promise<string | 'too_large' | 'timeout'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | 'too_large' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish('timeout'), BODY_TIMEOUT_MS);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish('too_large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish('timeout'));
  });
}

const CLOSE = { Connection: 'close' } as const;

async function post(ctx: ReviewContext, port: number, req: IncomingMessage): Promise<Reply> {
  if (!originAllowed(req.headers.origin, req.headers.host, port)) return plain(403, 'forbidden: bad Origin', CLOSE);
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return plain(403, 'forbidden: cross-site request', CLOSE);
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== FORM_TYPE) return plain(415, 'unsupported media type', CLOSE);
  const length = Number(req.headers['content-length'] ?? '0');
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return plain(413, 'request body too large', CLOSE);
  const body = await readBody(req);
  if (body === 'too_large') return plain(413, 'request body too large', CLOSE);
  if (body === 'timeout') return plain(408, 'request timeout', CLOSE);
  try {
    const reply = await decide(ctx, new URLSearchParams(body));
    if (reply.status === 303 && reply.location !== undefined) return { status: 303, body: '', headers: { Location: reply.location, 'Content-Type': 'text/plain; charset=utf-8' } };
    return plain(reply.status, reply.message ?? 'error');
  } catch (error) {
    // 보냈는지 모르는 상태가 될 수 있으니 자세한 내용은 서버 로그에만 남기고(요청 본문·OTP 는 싣지 않는다) 화면에는 알린다
    process.stderr.write(`review-web: decide failed: ${error instanceof Error ? error.name : 'error'}\n`);
    return htmlReply('오류', h`<p class="card">결정을 처리하는 중 오류가 났습니다. 결과를 확인하지 못했습니다. <a href="/">결정할 일로 가기</a></p>`, 500, ctx);
  }
}

export function handle(ctx: ReviewContext, port: number, req: IncomingMessage, token: string): Reply | Promise<Reply> {
  if (!hostAllowed(req.headers.host, port)) return plain(421, 'misdirected request: unexpected Host header');
  const isPost = req.method === 'POST';
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(isPost && ctx.write !== null && (req.url ?? '').split('?')[0] === '/decide')) {
    return plain(405, ctx.write === null ? 'method not allowed (read-only screen)' : 'method not allowed', { Allow: ctx.write === null ? 'GET, HEAD' : 'GET, HEAD, POST' });
  }
  const rawUrl = req.url ?? '/';
  if (rawUrl.length > MAX_URL_CHARS || !rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.includes('\\')) return plain(414, 'bad request target');
  if (isPost) return tokenEquals(cookieToken(req.headers.cookie), token) ? post(ctx, port, req) : unauthorized();
  if ((rawUrl.split('?')[0] === '/decide')) return plain(405, 'method not allowed', { Allow: ctx.write === null ? 'GET, HEAD' : 'POST' });
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
    return plain(400, 'bad request');
  }
  if (segments.some((part) => part.length > MAX_SEGMENT_CHARS || /[\0\r\n]/.test(part))) return plain(400, 'bad request');
  try {
    return route(ctx, segments, query);
  } catch (error) {
    // 내부 오류의 자세한 내용은 화면에 내지 않는다 (DB 값이 섞일 수 있다)
    process.stderr.write(`review-web: ${error instanceof Error ? error.message : String(error)}\n`);
    return htmlReply('오류', h`<p class="card">화면을 만드는 중 오류가 났습니다. 서버 로그를 확인하세요.</p>`, 500, ctx);
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
  // 폼 nonce 키는 시작 토큰에서 유도한다(메모리에만 있다): 다른 실행의 nonce 는 맞지 않는다
  ctx.forms = new FormGuard(createHmac('sha256', token).update('aot-review-web/form-nonce/v1').digest());
  const server = createServer((req, res) => {
    Promise.resolve(handle(ctx, port, req, token)).then((reply) => send(req, res, reply), () => send(req, res, plain(500, 'internal error')));
  });
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
