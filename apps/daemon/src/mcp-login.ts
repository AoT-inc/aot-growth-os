// 로그인 위임 명령 (ADR-0018 개정 1, docs/operations/mcp-sites.md §10):
//   npm run mcp-login -- <site> [--config 경로]      허브(aot-auth)에 로그인해 이 사이트의 위임 토큰을 instance/mcp-auth 에 저장한다
//   npm run mcp-login -- --status [--config 경로]    사이트별 로그인 상태와 오너 알림
//   npm run mcp-login -- --logout <site> [--config 경로]   이 기기에 저장된 로그인을 지운다(허브의 연결 끊기는 허브 화면에서)
// 인가 코드 + PKCE(S256) + 동적 클라이언트 등록, 되돌림 주소는 127.0.0.1 임의 포트. 이 명령은 갱신하지 않는다(갱신은 데몬 한 곳).
// 토큰·코드·검증값은 화면과 로그에 찍지 않는다. 인가 주소(state·challenge 뿐)만 보여 준다.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseMcpSites } from '@aot/agent-runtime';
import { systemClock, type Clock } from '@aot/domain';

import {
  authDirOf, authorizeUrl, clearNotice, deleteGrant, discoverHub, exchangeCode, grantMatches, isOauthManifest, newPkce, readGrant, readNotice, registerClient, writeGrant,
  type FetchLike, type OauthManifest, type StoredGrant,
} from './mcp-oauth.ts';

export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface LoginDeps {
  fetchImpl?: FetchLike;
  clock?: Clock;
  /** 인가 주소를 사람에게 보여 준다. 기본은 표준 출력. 시험은 여기서 브라우저를 흉내 낸다 */
  showUrl?: (url: string) => void;
  timeoutMs?: number;
}

function callbackServer(expectedState: string): { server: Server; code: Promise<string>; redirectUri: Promise<string> } {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    const reply = (status: number, text: string): void => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
    };
    if (url.searchParams.get('state') !== expectedState) { reply(400, 'state mismatch'); return; } // 다른 곳에서 온 요청은 무시한다(기다림은 계속)
    const error = url.searchParams.get('error');
    const value = url.searchParams.get('code');
    if (error !== null) { reply(200, 'Login was not completed. You can close this tab.'); rejectCode(new Error(`the hub returned an error (${/^[a-z_]{1,40}$/.test(error) ? error : 'error'})`)); return; }
    if (value === null || value === '') { reply(400, 'missing code'); return; }
    reply(200, 'Login complete. You can close this tab and return to the terminal.');
    resolveCode(value);
  });
  const redirectUri = new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`));
  });
  return { server, code, redirectUri };
}

/** 한 사이트에 로그인한다. 성공하면 저장 파일을 쓰고 오너 알림을 지운다 */
export async function loginSite(manifest: OauthManifest, instanceDir: string, deps: LoginDeps = {}): Promise<string> {
  const clock = deps.clock ?? systemClock;
  const endpoints = await discoverHub(manifest.auth.hub, deps.fetchImpl);
  const state = randomBytes(24).toString('base64url');
  const pkce = newPkce();
  const callback = callbackServer(state);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const redirectUri = await callback.redirectUri;
    const clientId = await registerClient(endpoints, redirectUri, deps.fetchImpl);
    const url = authorizeUrl(endpoints, { clientId, redirectUri, challenge: pkce.challenge, state, resource: manifest.auth.resource, scopes: manifest.auth.scopes });
    (deps.showUrl ?? ((u) => console.log(`Open this address in a browser and sign in to the hub (password + TOTP):\n${u}\n(waiting for the browser to return to ${redirectUri} — 5 minutes)`)))(url);
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('login timed out')), deps.timeoutMs ?? LOGIN_TIMEOUT_MS); });
    const code = await Promise.race([callback.code, timeout]);
    const result = await exchangeCode(endpoints, { clientId, code, redirectUri, verifier: pkce.verifier, resource: manifest.auth.resource }, deps.fetchImpl);
    if (!result.ok) throw new Error(result.detail);
    if (result.tokens.refreshToken === null) throw new Error('the hub did not issue a refresh token; the daemon could not keep the connection');
    const grant: StoredGrant = {
      version: 1, site: manifest.site, hub: manifest.auth.hub, resource: manifest.auth.resource, scopes: [...manifest.auth.scopes], client_id: clientId,
      refresh_token: result.tokens.refreshToken, access_token: result.tokens.accessToken,
      access_expires_at_ms: clock.nowMs() + Math.floor(result.tokens.expiresInS * 1000), scope: result.tokens.scope,
    };
    const dir = authDirOf(instanceDir);
    writeGrant(dir, grant);
    clearNotice(dir, manifest.site);
    return grant.scope === '' ? manifest.auth.scopes.join(' ') : grant.scope;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callback.server.close();
    callback.server.closeAllConnections();
  }
}

function parseArgs(argv: readonly string[]): { positional: string[]; config: string | null; flags: Set<string> } {
  const positional: string[] = [];
  const flags = new Set<string>();
  let config: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--config') { config = argv[i + 1] ?? null; i += 1; } else if (arg.startsWith('--')) flags.add(arg); else positional.push(arg);
  }
  return { positional, config, flags };
}

export async function runMcpLogin(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, deps: LoginDeps = {}): Promise<{ code: number; output: string }> {
  const { positional, config: configArg, flags } = parseArgs(argv);
  const instanceEnv = env['AOT_INSTANCE_DIR'] ?? 'instance';
  const configPath = configArg ?? env['AOT_DAEMON_CONFIG'] ?? join(instanceEnv, 'daemon.config.json');
  const usage = 'usage: npm run mcp-login -- <site> [--config PATH] | --status [--config PATH] | --logout <site> [--config PATH]';
  let raw: { mcp_sites?: unknown; instance_dir?: string };
  try { raw = JSON.parse(readFileSync(configPath, 'utf8')) as typeof raw; } catch { return { code: 2, output: `could not read the daemon config ${configPath}` }; }
  const instanceDir = raw.instance_dir ?? instanceEnv;
  const manifests = parseMcpSites(raw.mcp_sites).filter(isOauthManifest);
  const dir = authDirOf(instanceDir);

  if (flags.has('--status')) {
    if (manifests.length === 0) return { code: 0, output: 'no mcp_sites use oauth_delegated' };
    const lines = manifests.map((manifest) => {
      let line: string;
      try {
        const grant = readGrant(dir, manifest.site);
        if (grant === null) line = 'not logged in';
        else if (!grantMatches(grant, manifest)) line = 'logged in, but the declaration changed (hub, resource or scopes): log in again';
        else line = `logged in (scope: ${grant.scope === '' ? '-' : grant.scope})`;
      } catch { line = 'login file unreadable'; }
      const notice = readNotice(dir, manifest.site);
      return `${manifest.site}: ${line}${notice === null ? '' : `  [NOTICE ${notice.at}: ${notice.reason} — run: npm run mcp-login -- ${manifest.site}]`}`;
    });
    return { code: 0, output: lines.join('\n') };
  }

  const site = positional[0];
  if (site === undefined) return { code: 2, output: usage };
  const manifest = manifests.find((entry) => entry.site === site);
  if (manifest === undefined) return { code: 2, output: `site '${site}' is not an oauth_delegated site in mcp_sites of ${configPath}` };

  if (flags.has('--logout')) {
    deleteGrant(dir, site);
    clearNotice(dir, site);
    return { code: 0, output: `removed the stored login of '${site}' on this machine. Revoke the connection on the hub screen too if the token may have leaked. A running daemon closes the site's tools at its next refresh check.` };
  }
  try {
    const scope = await loginSite(manifest, instanceDir, deps);
    return { code: 0, output: `logged in to '${site}' (scope: ${scope}). The running daemon picks the login up within about 30 seconds; no restart is needed.` };
  } catch (error) {
    return { code: 1, output: `login failed: ${error instanceof Error ? error.message : 'error'}` };
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMcpLogin(process.argv.slice(2));
  (result.code === 0 ? console.log : console.error)(result.output);
  process.exit(result.code);
}
