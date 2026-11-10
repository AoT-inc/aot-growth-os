// 로그인 위임 토큰 (ADR-0018 개정 1): 로그인 흐름(PKCE·동적 등록·루프백), 만료 전 갱신, 갱신 실패 시 닫힘, 비밀값이 새지 않음.
// 허브는 가짜 서버(test/fixtures/mcp/fake-hub.ts)이고 실제 auth.aotinc.co.kr 에는 요청하지 않는다. MCP 서버도 루프백 가짜다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createMcpSiteClient, parseMcpSite, spawnConnectorProcess, type McpSiteEvent } from '@aot/agent-runtime';

import { mcpOptionsFromConfig } from '../../apps/daemon/src/mcp-config.ts';
import { runMcpLogin } from '../../apps/daemon/src/mcp-login.ts';
import { runMcpPin } from '../../apps/daemon/src/mcp-pin.ts';
import { authDirOf, createTokenSource, readGrant, readNotice, type OauthManifest } from '../../apps/daemon/src/mcp-oauth.ts';
import { startFakeHttpServer } from '../fixtures/mcp/fake-server.ts';
import { startFakeHub, type FakeHub } from '../fixtures/mcp/fake-hub.ts';
import { SEARCH_TOOL, UPDATE_TOOL, waitFor } from '../support/mcp.ts';
import { loginWithFakeBrowser, manualClocks, oauthSiteRaw, oauthWorkdir } from '../support/mcp-oauth.ts';

const MIN = 60_000;
const refreshCalls = (hub: FakeHub): number => hub.records.filter((x) => x.path === '/token' && x.form['grant_type'] === 'refresh_token').length;
const flushAll = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

async function rig(t: import('node:test').TestContext, options: { scenario?: 'normal' | 'echoes_secret'; lifetimeS?: number; mcpRequireLatest?: boolean } = {}) {
  const hub = await startFakeHub();
  hub.accessLifetimeS = options.lifetimeS ?? 3600;
  t.after(() => hub.close());
  const accept: { override: string[] | null } = { override: null };
  const mcp = await startFakeHttpServer({ scenario: options.scenario ?? 'normal', expectBearer: () => accept.override ?? (options.mcpRequireLatest === false ? hub.validAccessTokens() : hub.validAccessTokens().slice(-1)) });
  t.after(() => mcp.close());
  const raw = oauthSiteRaw(hub.url, mcp.url);
  const dir = oauthWorkdir(t, raw);
  const manifest = parseMcpSite(raw) as OauthManifest;
  const time = manualClocks();
  const events: McpSiteEvent[] = [];
  return { hub, mcp, accept, raw, dir, manifest, ...time, events, authDir: authDirOf(dir.instanceDir) };
}

type Rig = Awaited<ReturnType<typeof rig>>;
const sourceOf = (r: Rig) => createTokenSource({ manifest: r.manifest, authDir: r.authDir, clock: r.clock, timers: r.timers, emit: (e) => r.events.push(e) });
const login = async (r: Rig) => {
  const result = await loginWithFakeBrowser(r.dir.configPath, r.clock);
  assert.equal(result.code, 0, result.output);
  return result;
};

test('login: authorization code + PKCE (S256) + dynamic registration + loopback redirect; the grant is stored 0600 and nothing secret is printed', async (t) => {
  const r = await rig(t);
  const result = await login(r);
  // 동적 등록: 공개 클라이언트, 루프백 되돌림 주소, 범위는 보내지 않는다
  const registration = r.hub.records.find((x) => x.path === '/register')!.json as Record<string, unknown>;
  assert.equal(registration['token_endpoint_auth_method'], 'none');
  const [redirect] = registration['redirect_uris'] as string[];
  assert.match(redirect!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.ok(!('scope' in registration));
  // 인가 요청: resource(RFC 8707), 범위, S256
  const q = r.hub.lastAuthorize!;
  assert.equal(q['resource'], r.manifest.auth.resource);
  assert.equal(q['scope'], 'course.read units.write');
  assert.equal(q['code_challenge_method'], 'S256');
  // 코드 교환에서 검증값이 챌린지와 맞았고(가짜 허브가 검증한다) 같은 resource 를 보냈다
  const exchange = r.hub.records.find((x) => x.form['grant_type'] === 'authorization_code')!.form;
  assert.equal(createHash('sha256').update(exchange['code_verifier']!).digest('base64url'), q['code_challenge']);
  assert.equal(exchange['resource'], r.manifest.auth.resource);
  assert.equal(r.hub.counts.code, 1);
  // 저장 파일 권한
  assert.equal(statSync(r.authDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(r.authDir, 'course.json')).mode & 0o777, 0o600);
  const grant = readGrant(r.authDir, 'course')!;
  assert.match(grant.refresh_token, /^rt-/);
  // 화면 출력에는 토큰·코드·검증값이 없다
  const shown = `${result.output}\n${result.urls.join('\n')}`;
  for (const secret of [grant.refresh_token, grant.access_token!, exchange['code']!, exchange['code_verifier']!]) assert.ok(!shown.includes(secret));
});

test('login: a timeout stores nothing; --status and --logout report and remove the stored login', async (t) => {
  const r = await rig(t);
  const timedOut = await runMcpLogin(['course', '--config', r.dir.configPath], {}, { clock: r.clock, showUrl: () => undefined, timeoutMs: 150 });
  assert.equal(timedOut.code, 1);
  assert.match(timedOut.output, /timed out/);
  assert.ok(!existsSync(join(r.authDir, 'course.json')));
  assert.match((await runMcpLogin(['--status', '--config', r.dir.configPath])).output, /course: not logged in/);
  await login(r);
  assert.match((await runMcpLogin(['--status', '--config', r.dir.configPath])).output, /course: logged in \(scope: course\.read units\.write\)/);
  assert.equal((await runMcpLogin(['--logout', 'course', '--config', r.dir.configPath])).code, 0);
  assert.ok(!existsSync(join(r.authDir, 'course.json')));
  assert.equal((await runMcpLogin(['nope', '--config', r.dir.configPath])).code, 2);
});

test('refresh before expiry: the rotated refresh token is written to disk and the access token is replaced; one hub call', async (t) => {
  const r = await rig(t);
  await login(r);
  const before = readGrant(r.authDir, 'course')!;
  const source = sourceOf(r);
  t.after(() => source.close());
  let changes = 0;
  source.subscribe(() => { changes += 1; });
  source.start();
  assert.equal(source.current(), before.access_token);
  r.advance(54 * MIN); // 만료(60분) 5분 전은 아직 아니다
  await flushAll();
  assert.equal(r.hub.counts.refresh, 0);
  r.advance(1 * MIN + 1000);
  await waitFor(() => r.hub.counts.refresh === 1);
  await waitFor(() => source.current() !== before.access_token);
  const after = readGrant(r.authDir, 'course')!;
  assert.notEqual(after.refresh_token, before.refresh_token, 'the refresh token rotated and the new one is on disk');
  assert.equal(after.access_token, source.current());
  assert.equal(r.hub.counts.refresh, 1);
  assert.ok(changes >= 1);
  assert.ok(r.events.some((e) => e.type === 'auth_refreshed'));
  assert.equal(r.hub.revoked, false);
  // 한 번 더 돈다: 교체가 계속 이어진다(옛 토큰 재사용이 없다)
  r.advance(56 * MIN);
  await waitFor(() => r.hub.counts.refresh === 2);
  assert.equal(r.hub.revoked, false);
});

test('refresh is single-flight: repeated 401-driven requests do not make a second hub call', async (t) => {
  const r = await rig(t);
  await login(r);
  const source = sourceOf(r);
  t.after(() => source.close());
  source.start();
  r.advance(2 * MIN);
  source.rejected();
  source.rejected();
  source.rejected();
  await waitFor(() => r.hub.counts.refresh >= 1);
  await flushAll();
  assert.equal(r.hub.counts.refresh, 1);
  assert.equal(r.hub.revoked, false);
});

test('a rejected refresh closes the login: no token, grant file removed, owner notice left, event emitted', async (t) => {
  const r = await rig(t);
  await login(r);
  const source = sourceOf(r);
  t.after(() => source.close());
  source.start();
  let notified = 0;
  source.subscribe(() => { notified += 1; });
  r.hub.failNext = 'reject';
  r.advance(56 * MIN);
  await waitFor(() => source.current() === null);
  assert.equal(source.state(), 'logged_out');
  assert.ok(notified >= 1);
  assert.ok(!existsSync(join(r.authDir, 'course.json')), 'a dead refresh token is not kept');
  const notice = readNotice(r.authDir, 'course')!;
  assert.equal(notice.reason, 'refresh_rejected');
  assert.equal(notice.action, 'mcp-login course');
  assert.ok(r.events.some((e) => e.type === 'auth_failed' && e.reason === 'refresh_rejected' && e.action === 'mcp-login course'));
  assert.match((await runMcpLogin(['--status', '--config', r.dir.configPath])).output, /NOTICE .*refresh_rejected.*mcp-login -- course/);
  // 다시 로그인하면 약 30초 안에 원천이 이어받고 알림이 지워진다
  await login(r);
  r.advance(31_000);
  await waitFor(() => source.current() !== null);
  assert.equal(readNotice(r.authDir, 'course'), null);
});

test('a server error is retried with backoff using the same refresh token; the access token stays until it expires', async (t) => {
  const r = await rig(t);
  await login(r);
  const source = sourceOf(r);
  t.after(() => source.close());
  source.start();
  const first = source.current();
  r.hub.failNext = 'error500';
  r.advance(56 * MIN);
  await waitFor(() => r.events.some((e) => e.type === 'auth_retry'));
  assert.equal(source.current(), first, 'the old access token is still valid for a few minutes');
  assert.ok(existsSync(join(r.authDir, 'course.json')));
  r.advance(31_000);
  await waitFor(() => source.current() !== first);
  const calls = r.hub.records.filter((x) => x.path === '/token' && x.form['grant_type'] === 'refresh_token');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.form['refresh_token'], calls[1]!.form['refresh_token'], 'the retry used the same refresh token (the failed call changed nothing)');
  assert.equal(r.hub.revoked, false);
  assert.equal(readNotice(r.authDir, 'course'), null);
});

test('a lost answer is never retried (it could reuse an already rotated refresh token and get the whole connection revoked)', async (t) => {
  const r = await rig(t);
  await login(r);
  const source = sourceOf(r);
  t.after(() => source.close());
  source.start();
  r.hub.failNext = 'drop';
  r.advance(56 * MIN);
  await waitFor(() => readNotice(r.authDir, 'course') !== null);
  assert.equal(readNotice(r.authDir, 'course')!.reason, 'refresh_ambiguous');
  r.advance(3 * 60 * MIN);
  await flushAll();
  assert.equal(refreshCalls(r.hub), 1, 'no second attempt');
  assert.equal(r.hub.revoked, false);
  assert.equal(source.current(), null);
  assert.ok(!existsSync(join(r.authDir, 'course.json')), 'the possibly rotated refresh token is not kept');
});

test('end to end with the real connector process: tools open, the connector uses the refreshed token, a refresh failure closes this site only and leaves a notice', async (t) => {
  const r = await rig(t);
  await login(r);
  const source = sourceOf(r);
  const client = createMcpSiteClient({
    manifest: r.manifest, clock: r.clock, auth: source, onEvent: (e) => r.events.push(e), spawn: () => spawnConnectorProcess({}),
  });
  t.after(async () => { source.close(); await client.close(); });
  source.start();
  await client.start();
  assert.deepEqual([client.stateOf(SEARCH_TOOL), client.stateOf(UPDATE_TOOL)], [{ status: 'open' }, { status: 'open' }]);
  const first = source.current()!;
  const read = await client.call('units_search', { query: 'x' }, { timeoutMs: 10_000 });
  assert.ok(read.ok);
  // 만료 전 갱신: 가짜 MCP 서버는 가장 최근 토큰만 받으므로, 호출이 되면 커넥터가 새 토큰을 쓰고 있는 것이다
  r.advance(56 * MIN);
  await waitFor(() => source.current() !== first && source.current() !== null);
  await waitFor(() => r.hub.counts.refresh === 1);
  await flushAll();
  const second = await client.call('units_search', { query: 'y' }, { timeoutMs: 10_000 });
  assert.ok(second.ok, 'the connector sent the new access token');
  assert.deepEqual(client.stateOf(SEARCH_TOOL), { status: 'open' });
  // 갱신 거절: 이 사이트의 도구가 닫히고 알림이 남는다
  r.hub.failNext = 'reject';
  r.advance(56 * MIN);
  await waitFor(() => client.stateOf(SEARCH_TOOL).status === 'closed');
  assert.deepEqual(client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unauthorized' });
  assert.deepEqual(client.stateOf(UPDATE_TOOL), { status: 'closed', reason: 'unauthorized' });
  assert.equal(readNotice(r.authDir, 'course')!.reason, 'refresh_rejected');
  assert.ok(r.events.some((e) => e.type === 'tool_state' && e.state === 'closed:unauthorized'));
  // 오너가 다시 로그인하면 도구가 다시 열린다
  await login(r);
  r.advance(31_000);
  await waitFor(() => client.stateOf(SEARCH_TOOL).status === 'open');
});

test('a 401 from the site makes the token source refresh and the tools reopen with the new token', async (t) => {
  const r = await rig(t);
  await login(r);
  const source = sourceOf(r);
  const client = createMcpSiteClient({ manifest: r.manifest, clock: r.clock, auth: source, onEvent: (e) => r.events.push(e), spawn: () => spawnConnectorProcess({}) });
  t.after(async () => { source.close(); await client.close(); });
  source.start();
  await client.start();
  assert.deepEqual(client.stateOf(SEARCH_TOOL), { status: 'open' });
  // 사이트가 지금 토큰을 거절한다(폐지 목록 등): 다음 확인에서 401 → 닫힘 + 원천에 갱신 요청
  const stale = source.current()!;
  r.accept.override = [];
  await client.refresh();
  assert.ok(r.events.some((e) => e.type === 'auth_rejected'));
  assert.deepEqual(client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unauthorized' });
  await waitFor(() => refreshCalls(r.hub) === 1);
  await waitFor(() => source.current() !== stale);
  // 사이트가 새 토큰을 받아들이게 되면 변경 알림으로 도구가 다시 열린다
  r.accept.override = null;
  await waitFor(() => client.stateOf(SEARCH_TOOL).status === 'open');
  assert.equal(r.hub.revoked, false);
});

test('the echoed access token is redacted by the connector; no stored or emitted artifact leaks the refresh token', async (t) => {
  const r = await rig(t, { scenario: 'echoes_secret' });
  await login(r);
  const source = sourceOf(r);
  const client = createMcpSiteClient({ manifest: r.manifest, clock: r.clock, auth: source, onEvent: (e) => r.events.push(e), spawn: () => spawnConnectorProcess({}) });
  t.after(async () => { source.close(); await client.close(); });
  source.start();
  await client.start();
  const access = source.current()!;
  const result = await client.call('units_search', { query: 'x' }, { timeoutMs: 10_000 });
  assert.ok(result.ok);
  const wire = JSON.stringify(result);
  assert.ok(!wire.includes(access), 'the access token is redacted in what the connector hands back');
  assert.match(wire, /\[redacted\]/);
  // 갱신을 한 번 거쳐도 각 단계의 산출물에 갱신 토큰이 없다
  const refreshToken = readGrant(r.authDir, 'course')!.refresh_token;
  r.advance(56 * MIN);
  await waitFor(() => r.hub.counts.refresh === 1);
  await flushAll();
  const rotated = readGrant(r.authDir, 'course')!.refresh_token;
  const emitted = JSON.stringify(r.events);
  const notice = existsSync(join(r.authDir, 'course.notice.json')) ? readFileSync(join(r.authDir, 'course.notice.json'), 'utf8') : '';
  for (const secret of [refreshToken, rotated, access, source.current()!]) {
    assert.ok(!emitted.includes(secret), 'events carry no token');
    assert.ok(!notice.includes(secret));
    assert.ok(!JSON.stringify(r.raw).includes(secret), 'the declaration carries no token');
  }
  // 갱신 토큰을 담은 파일은 mcp-auth/<site>.json 하나뿐이다
  const holders = readdirSync(r.dir.instanceDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => statSync(join(r.dir.instanceDir, f)).isFile())
    .filter((f) => readFileSync(join(r.dir.instanceDir, f), 'utf8').includes(rotated));
  assert.deepEqual(holders, [join('mcp-auth', 'course.json')]);
});

test('daemon config: an oauth site needs no environment variable and gets a token source; a missing login does not stop the daemon', async (t) => {
  const r = await rig(t);
  const options = mcpOptionsFromConfig({ mcp_sites: [r.raw] }, {}, { instanceDir: r.dir.instanceDir, clock: r.clock })!;
  assert.deepEqual(options.sites[0]!.secretEnv, {});
  const events: McpSiteEvent[] = [];
  const source = options.sites[0]!.createAuth!({ emit: (e) => events.push(e) });
  source.start();
  t.after(() => source.close());
  assert.equal(source.current(), null);
  assert.equal(readNotice(r.authDir, 'course')!.reason, 'not_logged_in');
  assert.ok(events.some((e) => e.type === 'auth_failed' && e.reason === 'not_logged_in'));
});

test('a changed declaration (scopes) makes the stored login unusable until the owner logs in again', async (t) => {
  const r = await rig(t);
  await login(r);
  const changed = parseMcpSite({ ...r.raw, auth: { ...(r.raw['auth'] as object), scopes: ['course.read'] } }) as OauthManifest;
  const source = createTokenSource({ manifest: changed, authDir: r.authDir, clock: r.clock, timers: r.timers, emit: (e) => r.events.push(e) });
  t.after(() => source.close());
  source.start();
  assert.equal(source.current(), null);
  assert.equal(readNotice(r.authDir, 'course')!.reason, 'config_changed');
});

test('mcp-pin reads the stored access token but never refreshes; with an expired or missing login it says what to do', async (t) => {
  const r = await rig(t, { mcpRequireLatest: false });
  const missing = await runMcpPin([r.dir.configPath, 'course'], {});
  assert.equal(missing.code, 1);
  assert.match(missing.output, /not logged in/);
  await login(r);
  // 시계가 실제 시간이므로 가짜 시계로 로그인한 토큰은 이미 만료로 보인다 → 갱신하지 않고 안내한다
  const expired = await runMcpPin([r.dir.configPath, 'course'], {});
  assert.equal(expired.code, 1);
  assert.match(expired.output, /never refreshes/);
  assert.equal(r.hub.counts.refresh, 0);
});
