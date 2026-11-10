// 선언 형식 oauth_delegated (ADR-0018 개정 1): 허브·resource·범위 검증, http 전송 전용, 토큰이 다른 호스트로 나가는 선언 거부. 기존 bearer/header/none 은 그대로.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { McpManifestError, parseMcpSite, secretEnvNames } from '@aot/agent-runtime';

import { discoverHub } from '../../apps/daemon/src/mcp-oauth.ts';
import { httpSiteRaw } from '../support/mcp.ts';
import { oauthSiteRaw } from '../support/mcp-oauth.ts';

const HUB = 'https://auth.example.com';
const MCP = 'https://mcp.course.example.com/mcp';
const problemsOf = (raw: Record<string, unknown>): string => { try { parseMcpSite(raw); return ''; } catch (e) { return (e as McpManifestError).problems.join('\n'); } };

test('a valid oauth_delegated declaration parses; it needs no environment variable', () => {
  const m = parseMcpSite(oauthSiteRaw(HUB, MCP));
  assert.deepEqual(m.auth, { kind: 'oauth_delegated', hub: HUB, resource: MCP, scopes: ['course.read', 'units.write'] });
  assert.deepEqual(secretEnvNames(m), []);
});

test('hub must be an https origin; loopback http is allowed (tests only need it)', () => {
  assert.match(problemsOf(oauthSiteRaw('http://auth.example.com', MCP)), /auth\.hub must be https/);
  assert.match(problemsOf(oauthSiteRaw(`${HUB}/path`, MCP)), /origin only/);
  assert.equal(problemsOf(oauthSiteRaw('http://127.0.0.1:9999', 'http://127.0.0.1:8888/mcp')), '');
});

test('resource must stay on the transport origin: the token must not be sent to another host', () => {
  assert.match(problemsOf(oauthSiteRaw(HUB, MCP, { transport: { kind: 'http', url: 'https://other.example.com/mcp' } })), /same origin as transport\.url/);
});

test('stdio transport, empty or malformed scopes, unknown keys and missing fields are rejected', () => {
  assert.match(problemsOf(oauthSiteRaw(HUB, MCP, { transport: { kind: 'stdio', command: '/usr/bin/x' } })), /needs an http transport/);
  assert.match(problemsOf({ ...oauthSiteRaw(HUB, MCP), auth: { kind: 'oauth_delegated', hub: HUB, resource: MCP, scopes: [] } }), /scopes must be 1-20/);
  assert.match(problemsOf({ ...oauthSiteRaw(HUB, MCP), auth: { kind: 'oauth_delegated', hub: HUB, resource: MCP, scopes: ['a b'] } }), /scopes must be 1-20/);
  assert.match(problemsOf({ ...oauthSiteRaw(HUB, MCP), auth: { kind: 'oauth_delegated', hub: HUB, resource: MCP, scopes: ['a'], token: 'x' } }), /unknown key 'token'/);
  assert.match(problemsOf({ ...oauthSiteRaw(HUB, MCP), auth: { kind: 'oauth_delegated', scopes: ['a'] } }), /auth\.hub must be a string/);
});

test('bearer, header and none declarations are unchanged', () => {
  assert.equal(parseMcpSite(httpSiteRaw(MCP)).auth.kind, 'bearer');
  assert.equal(parseMcpSite(httpSiteRaw(MCP, { auth: { kind: 'none' } })).auth.kind, 'none');
  assert.equal(parseMcpSite(httpSiteRaw(MCP, { auth: { kind: 'header', header: 'X-Key', value_env: 'AOT_KEY' } })).auth.kind, 'header');
  assert.match(problemsOf(httpSiteRaw(MCP, { auth: { kind: 'basic' } })), /oauth_delegated/);
});

test('hub metadata whose endpoints are on another origin is refused', async () => {
  const meta = (token: string) => async () => new Response(JSON.stringify({ issuer: HUB, authorization_endpoint: `${HUB}/authorize`, token_endpoint: token, registration_endpoint: `${HUB}/register`, code_challenge_methods_supported: ['S256'] }), { status: 200 });
  await assert.rejects(discoverHub(HUB, meta('https://evil.example.net/token') as typeof fetch), /not on the hub origin/);
  await assert.rejects(discoverHub(HUB, meta('http://auth.example.com/token') as typeof fetch), /must be https/);
  assert.equal((await discoverHub(HUB, meta(`${HUB}/token`) as typeof fetch)).token, `${HUB}/token`);
});
