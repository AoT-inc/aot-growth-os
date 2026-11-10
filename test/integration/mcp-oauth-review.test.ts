// 1a 독립 검사 지적의 재현·회귀 시험: 저장 실패 뒤 옛 갱신 토큰 재사용, 로그인-갱신 경합, bearer 의 401 불변, 재시작 이어 쓰기,
// 두 사이트 격리, 콜백 state·iss 거부, 허브 메타데이터 거부, 루프백 바인딩, 비밀 미노출(로그·DB·호출 기록), 낮음 항목.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createFakeAgentAdapter, createMcpSiteClient, parseMcpSite, spawnConnectorProcess, type AgentAdapter, type McpSiteEvent, type ToolCallRecord,
} from '@aot/agent-runtime';
import { FakeClock } from '@aot/domain';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { mcpOptionsFromConfig } from '../../apps/daemon/src/mcp-config.ts';
import { runMcpLogin } from '../../apps/daemon/src/mcp-login.ts';
import { runMcpPin } from '../../apps/daemon/src/mcp-pin.ts';
import { authDirOf, createTokenSource, readGrant, readNotice, writeGrant, type OauthManifest, type StoredGrant } from '../../apps/daemon/src/mcp-oauth.ts';
import { startFakeHub } from '../fixtures/mcp/fake-hub.ts';
import { startFakeHttpServer } from '../fixtures/mcp/fake-server.ts';
import { manualTimers } from '../support/engine.ts';
import { evaluationsOf, EXAMPLE_URL, FakeFetcher, validationSpec } from '../support/evaluation.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { httpSiteRaw, SEARCH_TOOL, SECRET_ENV, TOKEN_ENV, waitFor } from '../support/mcp.ts';
import { flushAll, login, loginWithFakeBrowser, manualClocks, oauthSiteRaw, oauthWorkdir, refreshCalls, rig, sourceOf } from '../support/mcp-oauth.ts';
import { AGENT, createWithGate, effectDraft, policyEnv } from '../support/policy.ts';

const MIN = 60_000;
const canBreakWrites = process.getuid?.() !== 0;

/** 다음 저장이 실패하게 한다: 임시 파일 자리에 디렉터리를 둔다 */
const breakWrites = (authDir: string): string => {
  const blocker = join(authDir, `course.json.${process.pid}.tmp`);
  mkdirSync(blocker, { recursive: true });
  return blocker;
};

test('H1: a failed save of the rotated refresh token never sends the already-used old token again; persistent failure closes only this site; recovery continues from the newer token', { skip: !canBreakWrites }, async (t) => {
  const r = await rig(t);
  await login(r);
  const source = sourceOf(r);
  t.after(() => source.close());
  source.start();
  const first = source.current()!;
  const oldRefresh = readGrant(r.authDir, 'course')!.refresh_token;
  const blocker = breakWrites(r.authDir);
  r.advance(56 * MIN);
  await waitFor(() => refreshCalls(r.hub) === 1);
  await waitFor(() => source.current() !== first && source.current() !== null);
  assert.equal(readGrant(r.authDir, 'course')!.refresh_token, oldRefresh, 'the disk still has the old (already used) token');
  assert.ok(r.events.some((e) => e.type === 'auth_retry' && e.reason === 'store_write_failed'));
  // 저장 재시도가 계속 실패해도 허브에는 옛 토큰이 다시 가지 않는다
  for (let i = 0; i < 3; i += 1) { r.advance(61_000); await flushAll(); }
  assert.equal(refreshCalls(r.hub), 1, 'no second refresh call with the old token');
  assert.equal(r.hub.revoked, false);
  assert.equal(source.current(), null, 'persistent failure closes this site');
  assert.equal(readNotice(r.authDir, 'course')!.reason, 'store_write_failed');
  // 저장이 되살아나면 메모리의 새 토큰으로 이어 간다(옛 토큰이 아니라)
  rmSync(blocker, { recursive: true, force: true });
  r.advance(61_000);
  await waitFor(() => source.current() !== null);
  assert.equal(r.hub.revoked, false);
  assert.notEqual(readGrant(r.authDir, 'course')!.refresh_token, oldRefresh);
  assert.equal(readNotice(r.authDir, 'course'), null);
  const calls = r.hub.records.filter((x) => x.path === '/token' && x.form['grant_type'] === 'refresh_token');
  assert.equal(new Set(calls.map((c) => c.form['refresh_token'])).size, calls.length, 'every refresh call used a different (never reused) token');
});

for (const outcome of ['success', 'reject'] as const) {
  test(`H2: a login that happens while a refresh is in flight is not overwritten or deleted (refresh ${outcome})`, async (t) => {
    const r = await rig(t);
    await login(r);
    const base = readGrant(r.authDir, 'course')!;
    let injected = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!injected && url.endsWith('/token') && String(init?.body ?? '').includes('refresh_token')) {
        injected = true;
        writeGrant(r.authDir, { ...base, refresh_token: 'rt-NEW-LOGIN', access_token: 'at-new-login', access_expires_at_ms: r.clock.nowMs() + 3_000_000 }); // 오너가 방금 다시 로그인했다
      }
      return fetch(input, init);
    };
    const source = createTokenSource({ manifest: r.manifest, authDir: r.authDir, clock: r.clock, timers: r.timers, emit: (e) => r.events.push(e), fetchImpl });
    t.after(() => source.close());
    source.start();
    if (outcome === 'reject') r.hub.failNext = 'reject';
    r.advance(56 * MIN);
    await waitFor(() => injected);
    await flushAll();
    assert.equal(readGrant(r.authDir, 'course')?.refresh_token, 'rt-NEW-LOGIN', 'the new login survives');
    assert.equal(source.current(), 'at-new-login');
    assert.equal(readNotice(r.authDir, 'course'), null);
  });
}

test('M3: a 401 on a bearer site keeps the old behavior (closed:unavailable, no auth_rejected event), after initialize and at initialize', async (t) => {
  let accept = true;
  const server = await startFakeHttpServer({ scenario: 'normal', expectBearer: () => (accept ? [SECRET_ENV[TOKEN_ENV]] : []) });
  t.after(() => server.close());
  const events: McpSiteEvent[] = [];
  const client = createMcpSiteClient({
    manifest: parseMcpSite(httpSiteRaw(server.url)), clock: new FakeClock(), spawn: () => spawnConnectorProcess(SECRET_ENV), onEvent: (e) => events.push(e),
  });
  t.after(() => client.close());
  await client.start();
  assert.deepEqual(client.stateOf(SEARCH_TOOL), { status: 'open' });
  accept = false;
  await client.refresh(); // 초기화는 끝났으니 목록 요청이 401 을 받는다
  assert.deepEqual(client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unavailable' });
  const fresh = createMcpSiteClient({ manifest: parseMcpSite(httpSiteRaw(server.url)), clock: new FakeClock(), spawn: () => spawnConnectorProcess(SECRET_ENV), onEvent: (e) => events.push(e) });
  t.after(() => fresh.close());
  await fresh.start(); // 초기화 단계의 401
  assert.deepEqual(fresh.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unavailable' });
  assert.ok(!events.some((e) => e.type === 'auth_rejected'));
});

test('M3b: an oauth_delegated site whose token is rejected already at initialize closes as unauthorized and asks the token source to refresh', async (t) => {
  const r = await rig(t);
  await login(r);
  r.accept.override = []; // 사이트가 처음부터 이 토큰을 거절한다
  const source = sourceOf(r);
  const client = createMcpSiteClient({ manifest: r.manifest, clock: r.clock, auth: source, onEvent: (e) => r.events.push(e), spawn: () => spawnConnectorProcess({}) });
  t.after(async () => { source.close(); await client.close(); });
  source.start();
  await client.start();
  assert.deepEqual(client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unauthorized' });
  assert.ok(r.events.some((e) => e.type === 'auth_rejected'));
  await waitFor(() => refreshCalls(r.hub) === 1);
  r.accept.override = null;
  await waitFor(() => client.stateOf(SEARCH_TOOL).status === 'open');
});

test('M4a: after a daemon restart a new token source continues from the stored login and keeps rotating without reuse', async (t) => {
  const r = await rig(t);
  await login(r);
  const one = sourceOf(r);
  one.start();
  r.advance(56 * MIN);
  await waitFor(() => refreshCalls(r.hub) === 1);
  await waitFor(() => readGrant(r.authDir, 'course')!.refresh_token !== undefined && one.current() === readGrant(r.authDir, 'course')!.access_token);
  one.close(); // 데몬 종료
  const timers2 = new ManualGatewayTimers();
  const two = createTokenSource({ manifest: r.manifest, authDir: r.authDir, clock: r.clock, timers: timers2, emit: (e) => r.events.push(e) });
  t.after(() => two.close());
  two.start();
  assert.equal(two.current(), readGrant(r.authDir, 'course')!.access_token, 'picked up the stored access token without a hub call');
  assert.equal(refreshCalls(r.hub), 1);
  r.clock.advance(56 * MIN);
  timers2.advance(56 * MIN);
  await waitFor(() => refreshCalls(r.hub) === 2);
  assert.equal(r.hub.revoked, false);
});

test('M4b: two sites are isolated: a refresh failure closes one site and the other keeps working', async (t) => {
  const hubA = await startFakeHub();
  const hubB = await startFakeHub();
  const mcpA = await startFakeHttpServer({ scenario: 'normal', expectBearer: () => hubA.validAccessTokens().slice(-1) });
  const mcpB = await startFakeHttpServer({ scenario: 'normal', expectBearer: () => hubB.validAccessTokens().slice(-1) });
  t.after(async () => { await hubA.close(); await hubB.close(); await mcpA.close(); await mcpB.close(); });
  const rawA = oauthSiteRaw(hubA.url, mcpA.url);
  const rawB = oauthSiteRaw(hubB.url, mcpB.url, { site: 'proj' });
  const dir = oauthWorkdir(t, rawA);
  const configPath = join(dir.instanceDir, 'both.json');
  writeFileSync(configPath, JSON.stringify({ instance_dir: dir.instanceDir, mcp_sites: [rawA, rawB] }));
  const { clock, timers, advance } = manualClocks();
  for (const site of ['course', 'proj']) assert.equal((await loginWithFakeBrowser(configPath, clock, site)).code, 0);
  const authDir = authDirOf(dir.instanceDir);
  const events: McpSiteEvent[] = [];
  const make = (raw: Record<string, unknown>) => {
    const manifest = parseMcpSite(raw) as OauthManifest;
    const source = createTokenSource({ manifest, authDir, clock, timers, emit: (e) => events.push(e) });
    const client = createMcpSiteClient({ manifest, clock, auth: source, onEvent: (e) => events.push(e), spawn: () => spawnConnectorProcess({}) });
    t.after(async () => { source.close(); await client.close(); });
    source.start();
    return { source, client, manifest };
  };
  const a = make(rawA);
  const b = make(rawB);
  await a.client.start();
  await b.client.start();
  hubA.failNext = 'reject';
  advance(56 * MIN);
  await waitFor(() => a.client.stateOf('mcp_course_search_units').status === 'closed');
  await waitFor(() => hubB.counts.refresh === 1);
  await flushAll();
  assert.deepEqual(a.client.stateOf('mcp_course_search_units'), { status: 'closed', reason: 'unauthorized' });
  assert.deepEqual(b.client.stateOf('mcp_proj_search_units'), { status: 'open' });
  assert.ok((await b.client.call('units_search', { query: 'x' }, { timeoutMs: 10_000 })).ok);
  assert.equal(readNotice(authDir, 'course')!.reason, 'refresh_rejected');
  assert.equal(readNotice(authDir, 'proj'), null);
});

/** 로그인 도중 인가 주소에서 되돌림 주소와 state 를 꺼낸다 */
const callbackOf = (url: string): { redirect: string; state: string } => {
  const q = new URL(url).searchParams;
  return { redirect: q.get('redirect_uri')!, state: q.get('state')! };
};

test('M4c: the loopback callback ignores a wrong or missing state and a missing code, fails on an error response, and listens on 127.0.0.1 only', async (t) => {
  const r = await rig(t);
  const attempts: number[] = [];
  const outsideIp = Object.values(networkInterfaces()).flat().find((i) => i !== undefined && i.family === 'IPv4' && !i.internal)?.address;
  const result = await runMcpLogin(['course', '--config', r.dir.configPath], {}, {
    clock: r.clock,
    showUrl: (url) => {
      const { redirect, state } = callbackOf(url);
      void (async () => {
        attempts.push((await fetch(`${redirect}?code=stolen&state=WRONG`)).status);
        attempts.push((await fetch(`${redirect}?code=stolen`)).status);
        attempts.push((await fetch(`${redirect}?state=${state}`)).status);
        attempts.push((await fetch(`${new URL(redirect).origin}/other`)).status);
        if (outsideIp !== undefined) { // 다른 인터페이스에서는 닿지 않는다
          const refused = await new Promise<boolean>((resolve) => { const s = connect({ host: outsideIp, port: Number(new URL(redirect).port) }); s.once('error', () => resolve(true)); s.once('connect', () => { s.destroy(); resolve(false); }); });
          attempts.push(refused ? 1 : 0);
        }
        await fetch(url).then((x) => x.body?.cancel());
      })();
    },
  });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(attempts.slice(0, 4), [400, 400, 400, 404]);
  if (outsideIp !== undefined) assert.equal(attempts[4], 1, 'not reachable through a non-loopback address');
  assert.equal(r.hub.counts.code, 1, 'only the genuine code was exchanged');

  const denied = await runMcpLogin(['course', '--config', r.dir.configPath], {}, {
    clock: r.clock, showUrl: (url) => { const { redirect, state } = callbackOf(url); void fetch(`${redirect}?error=access_denied&state=${state}`); },
  });
  assert.equal(denied.code, 1);
  assert.match(denied.output, /access_denied/);
});

test('M4d: hub metadata is refused on issuer mismatch or absence, missing S256, and foreign endpoints; nothing is stored', async (t) => {
  const cases: Record<string, Record<string, unknown>> = {
    'issuer differs': { issuer: 'https://evil.example.net' },
    'issuer absent': { issuer: null },
    'S256 unsupported': { code_challenge_methods_supported: ['plain'] },
    'token endpoint elsewhere': { token_endpoint: 'https://evil.example.net/token' },
  };
  for (const [name, metadata] of Object.entries(cases)) {
    const r = await rig(t);
    r.hub.metadata = metadata;
    const result = await runMcpLogin(['course', '--config', r.dir.configPath], {}, { clock: r.clock, showUrl: () => undefined, timeoutMs: 500 });
    assert.equal(result.code, 1, name);
    assert.match(result.output, /hub metadata/, name);
    assert.ok(!existsSync(join(r.authDir, 'course.json')), name);
    assert.ok(!r.hub.records.some((x) => x.path === '/register'), `${name}: no registration happened`);
  }
});

test('L6: login refuses broader-than-requested scopes and a wrong or required-but-missing iss', async (t) => {
  const runLogin = async (configure: (r: Awaited<ReturnType<typeof rig>>) => void) => {
    const r = await rig(t);
    configure(r);
    const result = await runMcpLogin(['course', '--config', r.dir.configPath], {}, {
      clock: r.clock, showUrl: (url) => { void fetch(url).then((x) => x.body?.cancel()).catch(() => undefined); }, timeoutMs: 3000,
    });
    return { result, r };
  };
  const broader = await runLogin((r) => { r.hub.grantScope = 'course.read units.write people.write'; });
  assert.equal(broader.result.code, 1);
  assert.match(broader.result.output, /not requested/);
  assert.ok(!existsSync(join(broader.r.authDir, 'course.json')));
  const wrongIss = await runLogin((r) => { r.hub.authorizeIss = 'https://evil.example.net'; });
  assert.match(wrongIss.result.output, /unexpected issuer/);
  const missingIss = await runLogin((r) => { r.hub.metadata = { authorization_response_iss_parameter_supported: true }; });
  assert.match(missingIss.result.output, /unexpected issuer/);
  const goodIss = await runLogin((r) => { r.hub.authorizeIss = r.hub.url; });
  assert.equal(goodIss.result.code, 0, goodIss.result.output);
});

test('L6: write failures leave no temp file; a world-readable grant file is refused; mcp-pin prints no file content for a corrupt login', async (t) => {
  const r = await rig(t);
  const dir = r.authDir;
  mkdirSync(join(dir, 'x.json', 'sub'), { recursive: true });
  const grant: StoredGrant = { version: 1, site: 'x', hub: 'h', resource: 'r', scopes: [], client_id: 'c', refresh_token: 'rt', access_token: null, access_expires_at_ms: null, scope: '' };
  assert.throws(() => writeGrant(dir, grant));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file is left behind');

  await login(r);
  chmodSync(join(dir, 'course.json'), 0o644);
  assert.throws(() => readGrant(dir, 'course'), /readable by others/);
  const pin = await runMcpPin([r.dir.configPath, 'course'], {});
  assert.equal(pin.code, 1);
  chmodSync(join(dir, 'course.json'), 0o600);
  writeFileSync(join(dir, 'course.json'), '{"refresh_token": "SECRET-IN-FILE" oops', { mode: 0o600 });
  const corrupt = await runMcpPin([r.dir.configPath, 'course'], {});
  assert.equal(corrupt.code, 1);
  assert.ok(!corrupt.output.includes('SECRET-IN-FILE'), 'the parse error text (which can quote the file) is not printed');
});

test('L6: repeated 401s widen the forced-refresh interval (1 min, 2 min, ...) and a scheduled refresh resets it', async (t) => {
  const r = await rig(t);
  await login(r);
  const source = sourceOf(r);
  t.after(() => source.close());
  source.start();
  r.advance(61_000);
  source.rejected();
  await waitFor(() => refreshCalls(r.hub) === 1);
  await flushAll();
  r.advance(61_000);
  source.rejected(); // 간격이 2분으로 늘었으므로 아직 안 된다
  await flushAll();
  assert.equal(refreshCalls(r.hub), 1);
  r.advance(61_000);
  source.rejected();
  await waitFor(() => refreshCalls(r.hub) === 2);
});

test('M5: the secret is nowhere in the stderr log, the DB, or the tool-call records after a real agent run through an oauth_delegated site', async (t) => {
  const hub = await startFakeHub();
  const mcp = await startFakeHttpServer({ scenario: 'echoes_secret', expectBearer: () => hub.validAccessTokens().slice(-1) });
  t.after(async () => { await hub.close(); await mcp.close(); });
  const env = policyEnv(t);
  const raw = oauthSiteRaw(hub.url, mcp.url);
  const dir = oauthWorkdir(t, raw);
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  t.mock.method(console, 'log', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const loginResult = await loginWithFakeBrowser(dir.configPath, env.clock);
  assert.equal(loginResult.code, 0);
  const grant = readGrant(authDirOf(dir.instanceDir), 'course')!;
  const options = mcpOptionsFromConfig({ mcp_sites: [raw] }, {}, { instanceDir: dir.instanceDir, clock: env.clock })!; // onEvent 없음: 실제 logMcpEvent(stderr)
  const manifest = options.sites[0]!.manifest;
  const records: ToolCallRecord[] = [];
  const adapter: AgentAdapter = {
    name: 'mcp-fake',
    run: (input, context) => createFakeAgentAdapter({
      clock: env.clock, scenario: 'tool_calls', name: 'mcp-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }], toolCalls: [{ tool: SEARCH_TOOL, args: { query: 'x' } }],
    }).run(input, context),
  };
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: 'page' }), evidenceReader: { read: () => Promise.resolve({ readable: false, reason: 'none' }) } },
    agent: { adapter, tools: [], timers: new ManualGatewayTimers(), recorder: { record: (record) => void records.push(record) } },
    mcp: options,
  });
  t.after(() => daemon.mcp?.close());
  await daemon.mcp!.start();
  await waitFor(() => daemon.mcp!.sites.get('course')!.stateOf(SEARCH_TOOL).status === 'open');
  const taskId = createWithGate(env, effectDraft({
    ...validationSpec(['url_reachable', 'no_secret_in_outputs', 'budget']),
    allowed_tools: [{ tool: SEARCH_TOOL, operations: ['call'], scope: 'internal', impact: 'read', target: 'site:course/units' }],
  }));
  const ran = await daemon.worker.tick();
  assert.equal(ran.executed?.taskId, taskId);
  assert.ok(records.some((rec) => rec.tool === SEARCH_TOOL && rec.outcome === 'ok'), 'the read call went through the site');
  void evaluationsOf; void manifest;
  const tables = env.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  const dump = tables.map((table) => JSON.stringify(env.db.all(`SELECT * FROM "${table.name}"`))).join('\n');
  const secrets = [grant.refresh_token, grant.access_token!, hub.records.find((x) => x.form['code_verifier'] !== undefined)!.form['code_verifier']!];
  for (const secret of secrets) {
    assert.ok(!dump.includes(secret), 'not in the DB');
    assert.ok(!JSON.stringify(records).includes(secret), 'not in the tool-call records');
    assert.ok(!logged.join('\n').includes(secret), 'not in the log output');
  }
  assert.ok(logged.some((line) => line.startsWith('mcp course:')), 'the real log path was exercised');
});
