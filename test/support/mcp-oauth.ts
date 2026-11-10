// 로그인 위임 시험 공용: oauth_delegated 사이트 선언, 가짜 브라우저로 로그인, 손으로 돌리는 시계·타이머 한 쌍.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import assert from 'node:assert/strict';

import { parseMcpSite, type McpSiteEvent } from '@aot/agent-runtime';
import { FakeClock } from '@aot/domain';

import { authDirOf, createTokenSource, type OauthManifest } from '../../apps/daemon/src/mcp-oauth.ts';
import { startFakeHub, type FakeHub } from '../fixtures/mcp/fake-hub.ts';
import { startFakeHttpServer } from '../fixtures/mcp/fake-server.ts';

import { runMcpLogin } from '../../apps/daemon/src/mcp-login.ts';
import { ManualGatewayTimers } from './gateway-contract.ts';
import { searchDecl, updateDecl } from './mcp.ts';
import { makeTempDir } from './temp.ts';

export const SCOPES = ['course.read', 'units.write'];

export function oauthSiteRaw(hubUrl: string, mcpUrl: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site: 'course', transport: { kind: 'http', url: mcpUrl }, auth: { kind: 'oauth_delegated', hub: hubUrl, resource: mcpUrl, scopes: SCOPES },
    tools: [searchDecl(), updateDecl()], ...over,
  };
}

export interface OauthDir { instanceDir: string; configPath: string }

/** 임시 instance 디렉터리와 데몬 설정 파일 */
export function oauthWorkdir(t: TestContext, raw: Record<string, unknown>): OauthDir {
  const instanceDir = makeTempDir(t, 'aot-oauth-');
  mkdirSync(instanceDir, { recursive: true });
  const configPath = join(instanceDir, 'daemon.config.json');
  writeFileSync(configPath, JSON.stringify({ instance_dir: instanceDir, mcp_sites: [raw] }));
  return { instanceDir, configPath };
}

/** 가짜 브라우저: 인가 주소를 열면 가짜 허브가 되돌림 주소(루프백)로 302 한다 */
export async function loginWithFakeBrowser(configPath: string, clock: FakeClock, site = 'course'): Promise<{ code: number; output: string; urls: string[] }> {
  const urls: string[] = [];
  const result = await runMcpLogin([site, '--config', configPath], {}, {
    clock,
    showUrl: (url) => { urls.push(url); void fetch(url).then((r) => r.body?.cancel()); },
  });
  return { ...result, urls };
}

export function manualClocks(): { clock: FakeClock; timers: ManualGatewayTimers; advance(ms: number): void } {
  const clock = new FakeClock('2026-11-10T00:00:00.000Z');
  const timers = new ManualGatewayTimers();
  return { clock, timers, advance: (ms) => { clock.advance(ms); timers.advance(ms); } };
}

export const refreshCalls = (hub: FakeHub): number => hub.records.filter((x) => x.path === '/token' && x.form['grant_type'] === 'refresh_token').length;
export const flushAll = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

export async function rig(t: import('node:test').TestContext, options: { scenario?: 'normal' | 'echoes_secret'; lifetimeS?: number; mcpRequireLatest?: boolean } = {}) {
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

export type Rig = Awaited<ReturnType<typeof rig>>;
export const sourceOf = (r: Rig) => createTokenSource({ manifest: r.manifest, authDir: r.authDir, clock: r.clock, timers: r.timers, emit: (e) => r.events.push(e) });
export const login = async (r: Rig) => {
  const result = await loginWithFakeBrowser(r.dir.configPath, r.clock);
  assert.equal(result.code, 0, result.output);
  return result;
};

