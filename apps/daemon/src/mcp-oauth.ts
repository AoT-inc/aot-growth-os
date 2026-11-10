// 로그인 위임 토큰 (ADR-0018 개정 1): 허브(aot-auth) OAuth2 프로토콜, 갱신 토큰 저장소(instance/mcp-auth), 토큰 원천.
//  - 갱신 토큰은 이 파일(데몬 호스트의 instance/)에만 있다. 커넥터에는 접근 토큰만 간다. 토큰 값은 로그·이벤트·오류 문구에 싣지 않는다.
//  - 갱신은 사이트마다 토큰 원천 하나가 한 번에 하나만 한다(갱신 토큰 재사용 시 연결 전체가 끊기는 허브 규칙).
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { GatewayTimers, McpAuthPort, McpSiteEvent, McpSiteManifest } from '@aot/agent-runtime';
import { realGatewayTimers } from '@aot/agent-runtime';
import type { Clock } from '@aot/domain';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HUB_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 256 * 1024;
export const REFRESH_MARGIN_MS = 5 * 60_000;
const MIN_FORCED_REFRESH_GAP_MS = 60_000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 10 * 60_000;
const LOGIN_POLL_MS = 30_000;

export type OauthManifest = McpSiteManifest & { auth: Extract<McpSiteManifest['auth'], { kind: 'oauth_delegated' }> };
export const isOauthManifest = (manifest: McpSiteManifest): manifest is OauthManifest => manifest.auth.kind === 'oauth_delegated';

// ───────────────────────── 허브 프로토콜 ─────────────────────────

export interface HubEndpoints { authorization: string; token: string; registration: string; issuer: string; issParameterSupported: boolean }
export type FetchLike = typeof fetch;

const sameOrigin = (a: string, b: string): boolean => new URL(a).origin === new URL(b).origin;

function allowedUrl(raw: unknown, hub: string, label: string): string {
  if (typeof raw !== 'string') throw new Error(`hub metadata: ${label} is missing`);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`hub metadata: ${label} is not a URL`); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error(`hub metadata: ${label} must be https`);
  if (!sameOrigin(raw, hub)) throw new Error(`hub metadata: ${label} is not on the hub origin`);
  return raw;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => undefined); throw new Error('hub response is too large'); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { return null; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 허브 메타데이터를 읽는다. 엔드포인트가 허브와 다른 출처이면 거부한다 */
export async function discoverHub(hub: string, fetchImpl: FetchLike = fetch): Promise<HubEndpoints> {
  const response = await fetchImpl(new URL('/.well-known/oauth-authorization-server', hub), { redirect: 'manual', signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`hub metadata: HTTP ${response.status}`);
  const body = await readJson(response);
  if (!isRecord(body)) throw new Error('hub metadata is not a JSON object');
  // issuer 가 없거나 설정한 허브와 다르면 거부한다(다른 허브의 메타데이터를 받아들이지 않는다)
  if (typeof body['issuer'] !== 'string') throw new Error('hub metadata: issuer is missing');
  let issuerOrigin: string;
  try { issuerOrigin = new URL(body['issuer']).origin; } catch { throw new Error('hub metadata: issuer is not a URL'); }
  if (issuerOrigin !== new URL(hub).origin) throw new Error('hub metadata: issuer differs from the configured hub');
  const methods = body['code_challenge_methods_supported'];
  if (!Array.isArray(methods) || !methods.includes('S256')) throw new Error('hub metadata: S256 PKCE is not supported');
  return {
    issuer: issuerOrigin, issParameterSupported: body['authorization_response_iss_parameter_supported'] === true,
    authorization: allowedUrl(body['authorization_endpoint'], hub, 'authorization_endpoint'),
    token: allowedUrl(body['token_endpoint'], hub, 'token_endpoint'),
    registration: allowedUrl(body['registration_endpoint'], hub, 'registration_endpoint'),
  };
}

/** 동적 클라이언트 등록 (RFC 7591, 공개 클라이언트). 등록 때 범위는 보내지 않는다(허브 설계 §5-3) */
export async function registerClient(endpoints: HubEndpoints, redirectUri: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(endpoints.registration, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    body: JSON.stringify({
      client_name: 'AoT Growth OS', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  });
  const body = await readJson(response);
  if (!response.ok || !isRecord(body) || typeof body['client_id'] !== 'string' || body['client_id'] === '') throw new Error(`client registration failed (HTTP ${response.status})`);
  return body['client_id'];
}

export interface Pkce { verifier: string; challenge: string }
export function newPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(endpoints: HubEndpoints, params: { clientId: string; redirectUri: string; challenge: string; state: string; resource: string; scopes: readonly string[] }): string {
  const url = new URL(endpoints.authorization);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  url.searchParams.set('resource', params.resource);
  url.searchParams.set('scope', params.scopes.join(' '));
  return url.toString();
}

export interface TokenSet { accessToken: string; refreshToken: string | null; expiresInS: number; scope: string }

export type TokenResult =
  | { ok: true; tokens: TokenSet }
  /** rejected: 허브가 거절(확정). transient: 요청이 확정되지 않았다(재시도 안전). ambiguous: 응답을 잃었다(재시도하면 옛 갱신 토큰 재사용이 될 수 있다) */
  | { ok: false; kind: 'rejected' | 'transient' | 'ambiguous'; detail: string };

const SAFE_ERROR = /^[a-z_]{1,40}$/;
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const causeCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/** 토큰 엔드포인트 호출. 오류 문구에는 허브의 오류 코드(영문 소문자)만 싣고 본문은 싣지 않는다 */
export async function postToken(endpoints: HubEndpoints, form: Record<string, string>, fetchImpl: FetchLike = fetch): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoints.token, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    const code = causeCode(error);
    if (code !== undefined && NOT_SENT_CODES.has(code)) return { ok: false, kind: 'transient', detail: `could not reach the hub (${code})` };
    return { ok: false, kind: 'ambiguous', detail: 'the hub did not answer in time or the connection dropped' };
  }
  let body: unknown;
  try { body = await readJson(response); } catch { return { ok: false, kind: 'ambiguous', detail: 'the hub response could not be read' }; }
  if (response.status === 429 || response.status >= 500) return { ok: false, kind: 'transient', detail: `the hub answered HTTP ${response.status}` };
  if (!response.ok) {
    const error = isRecord(body) && typeof body['error'] === 'string' && SAFE_ERROR.test(body['error']) ? body['error'] : 'error';
    return { ok: false, kind: 'rejected', detail: `the hub rejected the request (HTTP ${response.status}, ${error})` };
  }
  if (!isRecord(body) || typeof body['access_token'] !== 'string' || body['access_token'] === '' || typeof body['expires_in'] !== 'number' || !(body['expires_in'] > 0)) {
    return { ok: false, kind: 'ambiguous', detail: 'the hub answered success with an unusable body' };
  }
  if (typeof body['token_type'] === 'string' && body['token_type'].toLowerCase() !== 'bearer') return { ok: false, kind: 'ambiguous', detail: 'the hub issued a token of an unsupported type' };
  const refresh = body['refresh_token'];
  return {
    ok: true,
    tokens: {
      accessToken: body['access_token'], refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : null,
      expiresInS: body['expires_in'], scope: typeof body['scope'] === 'string' ? body['scope'] : '',
    },
  };
}

export const exchangeCode = (endpoints: HubEndpoints, p: { clientId: string; code: string; redirectUri: string; verifier: string; resource: string }, fetchImpl?: FetchLike): Promise<TokenResult> =>
  postToken(endpoints, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.resource }, fetchImpl);

export const refreshGrant = (endpoints: HubEndpoints, p: { clientId: string; refreshToken: string; resource: string }, fetchImpl?: FetchLike): Promise<TokenResult> =>
  postToken(endpoints, { grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId, resource: p.resource }, fetchImpl);

// ───────────────────────── 저장소 (instance/mcp-auth) ─────────────────────────

export interface StoredGrant {
  version: 1;
  site: string;
  hub: string;
  resource: string;
  scopes: string[];
  client_id: string;
  /** 갱신 토큰: 이 파일을 쓰는 것은 로그인 명령과 데몬의 토큰 원천뿐이다 */
  refresh_token: string;
  access_token: string | null;
  access_expires_at_ms: number | null;
  /** 허브가 실제로 내준 범위(공백 구분) */
  scope: string;
}

export const authDirOf = (instanceDir: string): string => join(instanceDir, 'mcp-auth');
const grantPath = (dir: string, site: string): string => join(dir, `${site}.json`);
const noticePath = (dir: string, site: string): string => join(dir, `${site}.notice.json`);

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** 0600 파일을 원자적으로 쓴다(임시 파일 → fsync → rename). 실패하면 임시 파일을 지운다 */
function writePrivate(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 지우지 못해도 원래 오류를 올린다 */ }
    throw error;
  }
}

export function readGrant(dir: string, site: string): StoredGrant | null {
  const path = grantPath(dir, site);
  if (!existsSync(path)) return null;
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path}: the grant file is readable by others (expected mode 0600)`);
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value) || value['version'] !== 1 || value['site'] !== site) throw new Error(`${path}: not a grant file for site '${site}'`);
  const str = (key: string): string => { const v = value[key]; if (typeof v !== 'string') throw new Error(`${path}: ${key} is missing`); return v; };
  const scopes = value['scopes'];
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) throw new Error(`${path}: scopes is invalid`);
  const access = value['access_token'];
  const expires = value['access_expires_at_ms'];
  return {
    version: 1, site, hub: str('hub'), resource: str('resource'), scopes: scopes as string[], client_id: str('client_id'), refresh_token: str('refresh_token'),
    access_token: typeof access === 'string' && access !== '' ? access : null, access_expires_at_ms: typeof expires === 'number' ? expires : null,
    scope: typeof value['scope'] === 'string' ? value['scope'] : '',
  };
}

export function writeGrant(dir: string, grant: StoredGrant): void {
  ensureDir(dir);
  writePrivate(grantPath(dir, grant.site), grant);
}

export function deleteGrant(dir: string, site: string): void {
  rmSync(grantPath(dir, site), { force: true });
}

export interface OwnerNotice { site: string; at: string; reason: string; action: string }

export function writeNotice(dir: string, notice: OwnerNotice): void {
  ensureDir(dir);
  writePrivate(noticePath(dir, notice.site), notice);
}
export function clearNotice(dir: string, site: string): void {
  rmSync(noticePath(dir, site), { force: true });
}
export function readNotice(dir: string, site: string): OwnerNotice | null {
  const path = noticePath(dir, site);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isRecord(value) && typeof value['reason'] === 'string' && typeof value['at'] === 'string') return { site, at: value['at'], reason: value['reason'], action: typeof value['action'] === 'string' ? value['action'] : `mcp-login ${site}` };
  } catch { /* 깨진 알림은 없는 것으로 */ }
  return null;
}

/** 저장된 로그인이 지금 선언과 맞는가(허브·resource·범위가 바뀌었으면 다시 로그인해야 한다) */
export const grantMatches = (grant: StoredGrant, manifest: OauthManifest): boolean =>
  grant.hub === manifest.auth.hub && grant.resource === manifest.auth.resource
  && grant.scopes.length === manifest.auth.scopes.length && manifest.auth.scopes.every((scope) => grant.scopes.includes(scope));

// ───────────────────────── 토큰 원천 ─────────────────────────

export interface McpTokenSource extends McpAuthPort {
  /** 저장된 로그인을 읽고 필요하면 갱신을 시작한다(네트워크는 기다리지 않는다) */
  start(): void;
  close(): void;
  /** 시험·상태 표시용 */
  state(): 'ok' | 'logged_out';
}

export interface TokenSourceDeps {
  manifest: OauthManifest;
  authDir: string;
  clock: Clock;
  emit: (event: McpSiteEvent) => void;
  timers?: GatewayTimers;
  fetchImpl?: FetchLike;
}

export function createTokenSource(deps: TokenSourceDeps): McpTokenSource {
  const { manifest, authDir, clock, emit } = deps;
  const site = manifest.site;
  const timers = deps.timers ?? realGatewayTimers;
  const listeners = new Set<() => void>();
  let grant: StoredGrant | null = null;
  /** 교체된 갱신 토큰을 디스크에 못 적었다: 메모리의 새 토큰이 더 새롭고, consumed(디스크의 옛 토큰)는 이미 쓰였으므로 다시 보내면 안 된다 */
  let unsaved: { grant: StoredGrant; consumed: string } | null = null;
  let saveFailures = 0;
  let access: string | null = null;
  let accessExpiresAt = 0;
  let inflight: Promise<void> | null = null;
  let refreshTimer: unknown = null;
  let expiryTimer: unknown = null;
  let pollTimer: unknown = null;
  let retryMs = FIRST_RETRY_MS;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let forcedCount = 0;
  let closed = false;

  const unref = (handle: unknown): void => { (handle as { unref?: () => void } | null)?.unref?.(); };
  const clear = (handle: unknown): null => { if (handle !== null) timers.clearTimeout(handle); return null; };
  const notify = (): void => { for (const listener of [...listeners]) { try { listener(); } catch { /* 듣는 쪽 오류가 갱신을 깨뜨리지 않게 */ } } };
  const setAccess = (token: string | null, expiresAt: number): void => {
    const changed = token !== access;
    access = token;
    accessExpiresAt = expiresAt;
    expiryTimer = clear(expiryTimer);
    if (token !== null) {
      expiryTimer = timers.setTimeout(() => { if (access === token && clock.nowMs() >= accessExpiresAt) { setAccess(null, 0); notice('access_token_expired'); notify(); } }, Math.max(0, expiresAt - clock.nowMs()) + 1000);
      unref(expiryTimer);
    }
    if (changed) notify();
  };
  const notice = (reason: string): void => {
    try { writeNotice(authDir, { site, at: clock.nowIso(), reason, action: `mcp-login ${site}` }); } catch { /* 알림 파일을 못 써도 이벤트는 남는다 */ }
    emit({ type: 'auth_failed', site, reason, action: `mcp-login ${site}` });
  };
  /**
   * 비교 후 교환: 디스크의 갱신 토큰이 `base`(내가 읽고 쓴 토큰)일 때만 쓰거나 지운다.
   * 그 사이 오너가 새로 로그인했으면(다른 토큰) 건드리지 않는다 → 'superseded'. 두 프로세스 사이의 완전한 잠금은 아니지만 창은 읽기-쓰기 사이로 좁다.
   */
  const commit = (base: string, next: StoredGrant | null): 'written' | 'superseded' | 'failed' => {
    try {
      const disk = readGrant(authDir, site);
      if (disk === null) return next === null ? 'written' : 'superseded'; // 갱신 중 로그아웃
      if (disk.refresh_token !== base) return 'superseded';
      if (next === null) deleteGrant(authDir, site); else writeGrant(authDir, next);
      return 'written';
    } catch { return 'failed'; }
  };
  const scheduleRefresh = (): void => {
    refreshTimer = clear(refreshTimer);
    if (closed || grant === null || access === null) return;
    const lifetime = accessExpiresAt - clock.nowMs();
    const wait = lifetime > 2 * REFRESH_MARGIN_MS ? lifetime - REFRESH_MARGIN_MS : lifetime / 2;
    refreshTimer = timers.setTimeout(() => { forcedCount = 0; void refreshNow(); }, Math.max(0, wait));
    unref(refreshTimer);
  };
  const startPolling = (): void => {
    pollTimer = clear(pollTimer);
    if (closed || grant !== null) return;
    pollTimer = timers.setTimeout(() => { loadFromDisk(); if (grant === null) startPolling(); }, LOGIN_POLL_MS);
    unref(pollTimer);
  };
  const retryAfter = (ms: number): void => {
    refreshTimer = clear(refreshTimer);
    refreshTimer = timers.setTimeout(() => { void refreshNow(); }, ms);
    unref(refreshTimer);
  };

  /** 디스크의 로그인을 읽어 메모리에 반영한다. 저장 못 한 더 새로운 토큰이 있으면 디스크의 옛 값으로 덮어쓰지 않는다 */
  function loadFromDisk(): void {
    let disk: StoredGrant | null;
    try { disk = readGrant(authDir, site); } catch (error) {
      if (unsaved !== null) return; // 메모리의 토큰이 정본이다. 디스크를 못 읽어도 그것을 버리지 않는다
      grant = null;
      if (access !== null) setAccess(null, 0);
      notice(`store_unreadable:${error instanceof Error ? error.name : 'error'}`);
      return;
    }
    if (unsaved !== null) {
      if (disk !== null && disk.refresh_token === unsaved.consumed) return; // 디스크는 이미 쓴 옛 토큰: 덮어쓰지 않는다
      unsaved = null; // 오너가 새로 로그인했거나 로그아웃했다: 그쪽이 정본이다
      saveFailures = 0;
    }
    if (disk === null) { grant = null; if (access !== null) setAccess(null, 0); return; } // 로그아웃(파일 삭제)이면 접근 토큰도 거둔다
    if (!grantMatches(disk, manifest)) {
      grant = null;
      if (access !== null) setAccess(null, 0);
      notice('config_changed');
      return;
    }
    const known = grant;
    grant = disk;
    if (known === null || known.refresh_token !== disk.refresh_token) {
      clearNotice(authDir, site); // 새 로그인
      retryMs = FIRST_RETRY_MS;
    }
    if (disk.access_token !== null && disk.access_expires_at_ms !== null && disk.access_expires_at_ms - clock.nowMs() > 30_000) {
      if (access !== disk.access_token) setAccess(disk.access_token, disk.access_expires_at_ms);
      scheduleRefresh();
    } else if (known === null || known.refresh_token !== disk.refresh_token) {
      void refreshNow();
    }
  }

  /** 저장 못 한 토큰을 다시 적는다. true 면 이제 디스크와 메모리가 같다 */
  function flushUnsaved(): boolean {
    if (unsaved === null) return true;
    const result = commit(unsaved.consumed, unsaved.grant);
    if (result === 'failed') {
      saveFailures += 1;
      if (saveFailures >= 3 && access !== null) { // 계속 못 적는다: 재시작하면 옛 토큰을 다시 보내게 되므로 이 사이트를 닫는다
        setAccess(null, 0);
        notice('store_write_failed');
      }
      emit({ type: 'auth_retry', site, reason: 'store_write_failed', inMs: saveFailures >= 3 ? 60_000 : FIRST_RETRY_MS });
      retryAfter(saveFailures >= 3 ? 60_000 : FIRST_RETRY_MS);
      return false;
    }
    if (result === 'superseded') { unsaved = null; saveFailures = 0; loadFromDisk(); return false; }
    unsaved = null;
    saveFailures = 0;
    clearNotice(authDir, site);
    return true;
  }

  async function doRefresh(): Promise<void> {
    loadFromDisk(); // 새 로그인이 있으면 그 갱신 토큰으로 이어 간다
    if (!flushUnsaved()) return;
    if (grant === null) { startPolling(); return; }
    const current = grant;
    lastAttemptAt = clock.nowMs();
    let endpoints: HubEndpoints;
    try { endpoints = await discoverHub(manifest.auth.hub, deps.fetchImpl); } catch {
      await onFailure({ ok: false, kind: 'transient', detail: 'could not read the hub metadata' }, current.refresh_token); // 메타데이터 읽기는 갱신 토큰을 쓰기 전이라 다시 해도 안전하다
      return;
    }
    const result = await refreshGrant(endpoints, { clientId: current.client_id, refreshToken: current.refresh_token, resource: current.resource }, deps.fetchImpl);
    if (!result.ok) { await onFailure(result, current.refresh_token); return; }
    const expiresAt = clock.nowMs() + Math.floor(result.tokens.expiresInS * 1000);
    const next: StoredGrant = {
      ...current, refresh_token: result.tokens.refreshToken ?? current.refresh_token, access_token: result.tokens.accessToken, access_expires_at_ms: expiresAt,
      scope: result.tokens.scope === '' ? current.scope : result.tokens.scope,
    };
    const saved = commit(current.refresh_token, next); // 교체된 갱신 토큰을 먼저 적는다
    if (saved === 'superseded') { loadFromDisk(); return; } // 갱신하는 동안 오너가 새로 로그인했다: 새 로그인을 지키고 이 결과는 버린다
    grant = next;
    retryMs = FIRST_RETRY_MS;
    setAccess(result.tokens.accessToken, expiresAt);
    if (saved === 'failed') {
      unsaved = { grant: next, consumed: current.refresh_token }; // 새 토큰은 메모리에 두고 저장을 다시 시도한다(디스크의 옛 토큰은 이미 쓰였다)
      saveFailures = 0;
      flushUnsavedAfterFailure();
      return;
    }
    clearNotice(authDir, site);
    scheduleRefresh();
    emit({ type: 'auth_refreshed', site, expiresInS: Math.floor(result.tokens.expiresInS) });
  }
  function flushUnsavedAfterFailure(): void {
    saveFailures = 1;
    emit({ type: 'auth_retry', site, reason: 'store_write_failed', inMs: FIRST_RETRY_MS });
    retryAfter(FIRST_RETRY_MS);
  }

  async function onFailure(result: Extract<TokenResult, { ok: false }>, base: string): Promise<void> {
    if (result.kind === 'transient') {
      const wait = retryMs;
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      emit({ type: 'auth_retry', site, reason: result.detail, inMs: wait });
      retryAfter(wait);
      return;
    }
    // rejected / ambiguous: 갱신 토큰은 더 쓸 수 없다(옛 토큰을 다시 보내면 허브가 연결 전체를 끊을 수 있다)
    if (commit(base, null) === 'superseded') { loadFromDisk(); return; } // 그 사이 새 로그인이 있었다: 지우지 않고 이어받는다
    const reason = result.kind === 'rejected' ? 'refresh_rejected' : 'refresh_ambiguous';
    grant = null;
    refreshTimer = clear(refreshTimer);
    setAccess(null, 0);
    notice(reason);
    startPolling();
  }

  function refreshNow(): Promise<void> {
    if (closed) return Promise.resolve();
    if (inflight === null) {
      const run = doRefresh().catch((error: unknown) => {
        emit({ type: 'auth_retry', site, reason: `unexpected:${error instanceof Error ? error.name : 'error'}`, inMs: retryMs });
      }).finally(() => { if (inflight === run) inflight = null; });
      inflight = run;
    }
    return inflight;
  }

  return {
    current: () => (access !== null && clock.nowMs() < accessExpiresAt ? access : null),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    rejected() {
      // 사이트가 계속 401 을 주면(aud·범위 문제) 갱신 간격을 두 배씩 늘린다(1분 → 최대 30분). 정기 갱신이 돌면 처음으로 돌아간다
      const gap = Math.min(MIN_FORCED_REFRESH_GAP_MS * 2 ** forcedCount, 30 * 60_000);
      if (closed || grant === null || clock.nowMs() - lastAttemptAt < gap) return;
      forcedCount += 1;
      void refreshNow();
    },
    start() {
      loadFromDisk();
      if (grant === null) {
        if (readNotice(authDir, site) === null && !existsSync(grantPath(authDir, site))) notice('not_logged_in');
        startPolling();
      } else if (access === null) void refreshNow();
    },
    close() {
      closed = true;
      refreshTimer = clear(refreshTimer);
      expiryTimer = clear(expiryTimer);
      pollTimer = clear(pollTimer);
      listeners.clear();
    },
    state: () => (access !== null ? 'ok' : 'logged_out'),
  };
}

/** 읽기 전용 원천(mcp-pin): 파일의 접근 토큰이 유효할 때만 쓰고 절대 갱신하지 않는다(갱신 주체는 데몬 하나) */
export function createReadOnlyTokenSource(manifest: OauthManifest, authDir: string, clock: Clock): { port: McpAuthPort; problem: string | null } {
  let token: string | null = null;
  let problem: string | null = null;
  try {
    const grant = readGrant(authDir, manifest.site);
    if (grant === null) problem = `site '${manifest.site}' is not logged in (run: npm run mcp-login -- ${manifest.site})`;
    else if (!grantMatches(grant, manifest)) problem = `the stored login for '${manifest.site}' does not match mcp_sites (hub, resource or scopes changed); log in again`;
    else if (grant.access_token === null || grant.access_expires_at_ms === null || grant.access_expires_at_ms - clock.nowMs() < 30_000) {
      problem = `the stored access token for '${manifest.site}' has expired and mcp-pin never refreshes it (the daemon does); start the daemon, or log in again`;
    } else token = grant.access_token;
  } catch (error) { problem = `could not read the stored login (${error instanceof Error ? error.name : 'error'}); check the file under ${authDir}`; }
  return { port: { current: () => token, subscribe: () => () => undefined, rejected: () => undefined }, problem };
}
