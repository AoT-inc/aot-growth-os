// 오너 MCP 선언 검증 (ADR-0018 §2, 설계 §2): 조합 규칙, 이름 충돌, approval 누락, https 규칙, 알 수 없는 키
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { McpManifestError, parseMcpSite, parseMcpSites, secretEnvNames } from '@aot/agent-runtime';

import { httpSiteRaw, searchDecl, stdioSiteRaw, updateDecl } from '../support/mcp.ts';

const problems = (raw: unknown): string => {
  try {
    parseMcpSite(raw);
  } catch (error) {
    assert.ok(error instanceof McpManifestError);
    return error.problems.join(' | ');
  }
  return '';
};

test('a valid http declaration becomes a frozen manifest with agent names mcp_<site>_<as> and defaults', () => {
  const m = parseMcpSite(httpSiteRaw('https://mcp.course.example.com/mcp'));
  assert.equal(m.site, 'course');
  assert.deepEqual(m.tools.map((t) => t.gatewayName), ['mcp_course_search_units', 'mcp_course_update_unit']);
  assert.equal(m.rateLimitPerMinute, 30);
  assert.equal(m.timeoutMs, 20_000);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.tools));
  assert.equal(m.tools[1]!.approval, 'draft');
  assert.equal(m.tools[0]!.approval, null);
  assert.deepEqual(secretEnvNames(m), ['AOT_MCP_COURSE_TOKEN']);
});

test('tools: [] is valid (before the first mcp-pin) and exposes nothing', () => {
  assert.deepEqual(parseMcpSite(httpSiteRaw('https://mcp.course.example.com/mcp', { tools: [] })).tools, []);
});

test('a missing description or a server-only name without an agent name is rejected', () => {
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { tools: [searchDecl({ description: '' })] })), /description is required/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { tools: [searchDecl({ as: undefined, name: 'units-search' })] })), /\.as \(or name/);
  assert.equal(problems(httpSiteRaw('https://a.example.com/m', { tools: [searchDecl({ name: 'units-search' })] })), '', 'a dashed server name is fine when the owner gives an agent name');
});

test('read/write combination rules are enforced', () => {
  const bad = (tool: Record<string, unknown>) => problems(httpSiteRaw('https://a.example.com/m', { tools: [tool] }));
  assert.match(bad(searchDecl({ side_effect: true })), /contradicts side_effect/);
  assert.match(bad(searchDecl({ approval: 'draft' })), /must not declare approval/);
  assert.match(bad(updateDecl({ approval: undefined })), /approval .* is required for a write tool/);
  assert.match(bad(updateDecl({ approval: 'auto' })), /approval .* is required/);
  assert.match(bad(updateDecl({ side_effect: false })), /contradicts side_effect/);
  assert.match(bad(searchDecl({ idempotency: { key_argument: 'request_id', retention_ms: 1000 } })), /idempotency is only for write tools/);
  assert.match(bad(updateDecl({ ack_server_hint_conflict: true })), /only for read tools/);
  assert.match(bad(searchDecl({ input_schema_sha256: 'abc' })), /input_schema_sha256 is required/);
  assert.match(bad(searchDecl({ target: '' })), /target is required/);
  assert.match(bad(searchDecl({ scope: 'world' })), /scope must be one of/);
  assert.match(bad(searchDecl({ extra: 1 })), /unknown key 'extra'/);
  assert.match(bad(updateDecl({ idempotency: { key_argument: 'request_id' } })), /retention_ms/);
});

test('duplicate agent names and duplicate server tools are rejected', () => {
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { tools: [searchDecl(), searchDecl({ name: 'other' })] })), /agent tool name 'mcp_course_search_units' is used twice/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { tools: [searchDecl(), searchDecl({ as: 'search2' })] })), /server tool 'units_search' is declared twice/);
  assert.throws(() => parseMcpSites([httpSiteRaw('https://a.example.com/m'), httpSiteRaw('https://b.example.com/m')]), /declared twice/);
});

test('transport rules: https only (http only for loopback), no credentials in the url, no redirects configured', () => {
  assert.match(problems(httpSiteRaw('http://mcp.course.example.com/mcp')), /must be https/);
  assert.match(problems(httpSiteRaw('http://192.168.0.5/mcp')), /must be https/);
  assert.equal(problems(httpSiteRaw('http://127.0.0.1:8080/mcp')), '');
  assert.equal(problems(httpSiteRaw('http://localhost:8080/mcp')), '');
  assert.equal(problems(httpSiteRaw('http://[::1]:8080/mcp')), '');
  assert.match(problems(httpSiteRaw('https://user:pw@mcp.course.example.com/mcp')), /must not carry credentials/);
  assert.match(problems(httpSiteRaw('not a url')), /not a valid URL/);
  assert.match(problems(stdioSiteRaw('normal', undefined, { transport: { kind: 'stdio', command: 'node', args: [] } })), /absolute path/);
  assert.match(problems(stdioSiteRaw('normal', undefined, { auth: { kind: 'bearer', token_env: 'X_TOKEN' } })), /env_from, not auth/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { env_from: { A: 'B' } })), /only for stdio/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { transport: { kind: 'ws', url: 'wss://x' } })), /kind must be/);
});

test('auth rules: only environment variable names, reserved headers refused', () => {
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { auth: { kind: 'bearer', token: 'literal-secret' } })), /unknown key 'token'/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { auth: { kind: 'bearer', token_env: 'not a name' } })), /token_env must name/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { auth: { kind: 'header', header: 'Host', value_env: 'X_KEY' } })), /not be reserved|plain header/);
  const m = parseMcpSite(httpSiteRaw('https://a.example.com/m', { auth: { kind: 'header', header: 'X-Api-Key', value_env: 'X_KEY' } }));
  assert.deepEqual(secretEnvNames(m), ['X_KEY']);
});

test('numeric limits: rate 1-600, timeout 1000-120000', () => {
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { rate_limit_per_minute: 0 })), /rate_limit_per_minute/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { rate_limit_per_minute: 601 })), /rate_limit_per_minute/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { timeout_ms: 999 })), /timeout_ms/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { timeout_ms: 120_001 })), /timeout_ms/);
  assert.equal(parseMcpSite(httpSiteRaw('https://a.example.com/m', { rate_limit_per_minute: 600, timeout_ms: 1000 })).timeoutMs, 1000);
});

test('site name and unknown top-level keys', () => {
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { site: 'Course' })), /site must match/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { site: 'a_b' })), /site must match/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { surprise: true })), /unknown key 'surprise'/);
  assert.match(problems(httpSiteRaw('https://a.example.com/m', { tools: 'all' })), /tools must be an array/);
});

test('an idempotency declaration is kept on a write tool', () => {
  const m = parseMcpSite(httpSiteRaw('https://a.example.com/m', { tools: [updateDecl({ idempotency: { key_argument: 'request_id', retention_ms: 86_400_000 } })] }));
  assert.deepEqual(m.tools[0]!.idempotency, { keyArgument: 'request_id', retentionMs: 86_400_000 });
});
