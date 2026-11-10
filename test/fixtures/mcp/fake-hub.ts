// 가짜 허브(aot-auth) — 로그인 위임 시험용. 루프백 http 서버 하나이고 실제 auth.aotinc.co.kr 에는 요청하지 않는다.
// 인가 코드 + PKCE(S256) 검증, 동적 등록, 접근 토큰(수명 조절)·갱신 토큰 교체와 옛 갱신 토큰 재사용 시 연결 폐지(DESIGN §3-3)를 흉내 낸다.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HubRecord { path: string; form: Record<string, string>; json: unknown }

export interface FakeHub {
  readonly url: string;
  /** 받은 요청 기록 */
  readonly records: HubRecord[];
  /** 지금 유효한 접근 토큰들 */
  validAccessTokens(): string[];
  /** 접근 토큰 수명(초). 기본 3600 */
  accessLifetimeS: number;
  /** 다음 token 요청을 이렇게 망친다: reject(400 invalid_grant) | error500 | drop(응답 없이 연결 끊기) */
  failNext: 'reject' | 'error500' | 'drop' | null;
  /** 메타데이터 문서에 덮어쓰는 값(null 이면 지운다) */
  metadata: Record<string, unknown>;
  /** 토큰 응답의 scope 를 이 값으로 바꾼다 */
  grantScope: string | null;
  /** 인가 응답 되돌림에 iss 를 실을 값(null 이면 싣지 않는다) */
  authorizeIss: string | null;
  /** 연결(gid) 폐지 여부 — 옛 갱신 토큰 재사용으로 true 가 된다 */
  readonly revoked: boolean;
  /** 마지막으로 인가 요청이 받은 쿼리 */
  lastAuthorize: Record<string, string> | null;
  /** 교환·갱신 횟수 */
  readonly counts: { code: number; refresh: number };
  close(): Promise<void>;
}

const body = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startFakeHub(): Promise<FakeHub> {
  const records: HubRecord[] = [];
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource: string }>();
  const clients = new Map<string, { redirectUris: string[] }>();
  let currentRefresh: string | null = null;
  const usedRefresh = new Set<string>();
  const access = new Set<string>();
  const counts = { code: 0, refresh: 0 };
  let origin = '';
  const state: { revoked: boolean } = { revoked: false };
  const hub: FakeHub = {
    get url() { return origin; }, records, accessLifetimeS: 3600, metadata: {}, grantScope: null, authorizeIss: null, failNext: null, lastAuthorize: null, counts,
    get revoked() { return state.revoked; },
    validAccessTokens: () => [...access],
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  const json = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
  };
  const issue = (): { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string } => {
    const accessToken = `at-${randomBytes(12).toString('hex')}`;
    access.add(accessToken);
    if (currentRefresh !== null) usedRefresh.add(currentRefresh);
    currentRefresh = `rt-${randomBytes(12).toString('hex')}`;
    return { access_token: accessToken, refresh_token: currentRefresh, expires_in: hub.accessLifetimeS, token_type: 'Bearer', scope: hub.grantScope ?? 'course.read units.write' };
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin);
      const raw = req.method === 'POST' ? await body(req) : '';
      const type = req.headers['content-type'] ?? '';
      const form = type.includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : {};
      const parsed: unknown = type.includes('json') && raw !== '' ? JSON.parse(raw) : null;
      records.push({ path: url.pathname, form, json: parsed });
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        const doc: Record<string, unknown> = {
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'], ...hub.metadata,
        };
        for (const [key, value] of Object.entries(doc)) if (value === null) delete doc[key];
        json(res, 200, doc);
      } else if (url.pathname === '/register') {
        const value = parsed as { redirect_uris?: string[] };
        const clientId = `client-${randomBytes(6).toString('hex')}`;
        clients.set(clientId, { redirectUris: value.redirect_uris ?? [] });
        json(res, 201, { client_id: clientId, redirect_uris: value.redirect_uris });
      } else if (url.pathname === '/authorize') {
        const q = Object.fromEntries(url.searchParams);
        hub.lastAuthorize = q;
        const client = clients.get(q['client_id'] ?? '');
        const okRedirect = client !== undefined && q['redirect_uri'] !== undefined && client.redirectUris.includes(q['redirect_uri']);
        if (!okRedirect || q['response_type'] !== 'code' || q['code_challenge_method'] !== 'S256' || q['resource'] === undefined) { res.writeHead(400).end('bad authorize'); return; }
        const code = `code-${randomBytes(8).toString('hex')}`;
        codes.set(code, { clientId: q['client_id']!, challenge: q['code_challenge']!, redirectUri: q['redirect_uri']!, resource: q['resource']! });
        const back = new URL(q['redirect_uri']!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', q['state'] ?? '');
        if (hub.authorizeIss !== null) back.searchParams.set('iss', hub.authorizeIss);
        res.writeHead(302, { location: back.toString() }).end();
      } else if (url.pathname === '/token') {
        if (hub.failNext !== null) {
          const mode = hub.failNext;
          hub.failNext = null;
          if (mode === 'drop') { req.socket.destroy(); return; }
          if (mode === 'error500') { json(res, 500, { error: 'server_error' }); return; }
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        if (form['grant_type'] === 'authorization_code') {
          counts.code += 1;
          const entry = codes.get(form['code'] ?? '');
          codes.delete(form['code'] ?? '');
          const challenge = createHash('sha256').update(form['code_verifier'] ?? '').digest('base64url');
          if (entry === undefined || entry.clientId !== form['client_id'] || entry.redirectUri !== form['redirect_uri'] || entry.challenge !== challenge || entry.resource !== form['resource']) { json(res, 400, { error: 'invalid_grant' }); return; }
          json(res, 200, issue());
        } else if (form['grant_type'] === 'refresh_token') {
          counts.refresh += 1;
          const token = form['refresh_token'] ?? '';
          if (state.revoked || usedRefresh.has(token)) { // 옛 갱신 토큰 재사용: 연결 전체를 끊는다
            if (usedRefresh.has(token)) { state.revoked = true; access.clear(); currentRefresh = null; }
            json(res, 400, { error: 'invalid_grant' });
            return;
          }
          if (token !== currentRefresh) { json(res, 400, { error: 'invalid_grant' }); return; }
          json(res, 200, issue());
        } else json(res, 400, { error: 'unsupported_grant_type' });
      } else res.writeHead(404).end();
    })().catch(() => { res.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return hub;
}
