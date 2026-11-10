// API 전송 (ADR-0020): 선언 문법 검증, 요청 조립(순수), 주소 규칙, 실제 커넥터 프로세스 + 가짜 HTTP 서비스. 외부 네트워크 없음.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { addressAllowed, apiPinOf, buildApiRequest, McpManifestError, parseMcpSite } from '@aot/agent-runtime';

import { json, startFakeService } from '../fixtures/api/fake-service.ts';
import {
  API_SECRET_ENV, API_TOKEN, API_TOKEN_ENV, apiSiteRaw, callOf, draftPostDecl, getPostDecl, listPostsDecl, pinnedManifest, POST_ARGS, startApiSite, withPins,
} from '../support/api.ts';
import { connectorConfig, startConnector } from '../support/mcp.ts';

const base = 'http://127.0.0.1:9';
const problemsOf = (raw: Record<string, unknown>): string => {
  try { parseMcpSite(raw); } catch (error) { if (error instanceof McpManifestError) return error.problems.join('\n'); throw error; }
  return '';
};
const withTool = (decl: Record<string, unknown>) => apiSiteRaw(base, { tools: [decl] });
const draft = (over: Record<string, unknown>) => draftPostDecl(over);

// ===== 선언 검증 =====

test('declaration: the example site parses; ADR-0018 classification fields are validated with the same names; pin may be missing at first', () => {
  const manifest = parseMcpSite(apiSiteRaw(base));
  assert.equal(manifest.transport.kind, 'api');
  assert.deepEqual(manifest.tools.map((t) => [t.gatewayName, t.impact, t.approval]), [['mcp_web_list_posts', 'read', null], ['mcp_web_get_post', 'read', null], ['mcp_web_draft_post', 'external_effect', 'draft']]);
  assert.ok(manifest.tools.every((t) => t.api !== null && t.inputSchemaSha256 === `sha256:${'0'.repeat(64)}`));
  assert.equal(parseMcpSite(withPins(apiSiteRaw(base))).tools[2]!.inputSchemaSha256, apiPinOf(manifest.tools[2]!));
});

test('declaration: the closed grammar rejects what would make it a general HTTP caller', () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['unknown key on a tool', withTool(listPostsDecl({ url: 'http://x' })), /unknown key 'url'/],
    ['unknown key in request', withTool(listPostsDecl({ request: { method: 'GET', path: '/a', host: 'evil' } })), /unknown key 'host'/],
    ['$arg in a key position', withTool(draft({ request: { method: 'POST', path: '/a', body: { '$arg': 'slug', extra: 1 } } })), /not a value form/],
    ['key named by $ form', withTool(draft({ request: { method: 'POST', path: '/a', body: { '$evil': { $const: 1 } } } })), /not a value form/],
    ['bare string in a body', withTool(draft({ request: { method: 'POST', path: '/a', body: { a: 'literal' } } })), /must be \{"\$const"/],
    ['undefined placeholder', withTool(draft({ request: { method: 'POST', path: '/a', body: { a: { $template: '{nope}' } } } })), /'nope' is not declared/],
    ['unknown conversion', withTool(draft({ request: { method: 'POST', path: '/a', body: { a: { $template: '{slug|eval}' } } } })), /conversion/],
    ['path argument without a pattern', withTool(getPostDecl({ args: { file: { type: 'string', required: true } }, request: { method: 'GET', path: '/x/{file}' }, returns: ['/name'] })), /needs a pattern or enum/],
    ['path host injection via //', withTool(listPostsDecl({ request: { method: 'GET', path: '//evil.example/x' } })), /request.path/],
    ['query in path', withTool(listPostsDecl({ request: { method: 'GET', path: '/x?admin=1' } })), /request.path/],
    ['dot segment in path', withTool(listPostsDecl({ request: { method: 'GET', path: '/a/../b' } })), /'\.' and '\.\.'|literal/],
    ['write without approval', withTool(draft({ approval: undefined })), /approval/],
    ['write declared with GET', withTool(draft({ request: { method: 'GET', path: '/a' } })), /cannot use GET/],
    ['read with POST needs the acknowledgement', withTool(listPostsDecl({ request: { method: 'POST', path: '/a' } })), /ack_post_is_read/],
    ['returns on a write', withTool(draft({ returns: ['/x'] })), /returns is not allowed/],
    ['record on a read', withTool(listPostsDecl({ record: ['/x'] })), /record is only for write/],
    ['a read without returns', withTool(listPostsDecl({ returns: undefined })), /returns must be/],
    ['unused argument', withTool(listPostsDecl({ args: { orphan: { type: 'string' } } })), /never used/],
    ['reserved effect_key argument', withTool(draft({ args: { effect_key: { type: 'string', required: true } } })), /reserved/],
    ['effect key in the path', withTool(draft({ request: { method: 'POST', path: '/a/{effect_key}' } })), /effect key cannot go in the path/],
    ['effect key in a read', withTool(getPostDecl({ request: { method: 'GET', path: '/a', query: { k: { $arg: 'effect_key' } } } })), /only for write/],
    ['service-side idempotency', withTool(draft({ idempotency: { key_argument: 'x', retention_ms: 1 } })), /unknown key 'idempotency'/],
    ['an MCP-only field', withTool(draft({ input_schema_sha256: `sha256:${'a'.repeat(64)}` })), /unknown key 'input_schema_sha256'/],
    ['reserved request header', withTool(listPostsDecl({ request: { method: 'GET', path: '/a', headers: { Authorization: 'x' } } })), /non-reserved header/],
    ['optional argument in the body', withTool(draft({ args: { a: { type: 'string', pattern: '^x$' } }, request: { method: 'POST', path: '/a', body: { a: { $arg: 'a' } } } })), /must be required/],
    ['body size that could pass 1 MiB', withTool(draft({ args: { a: { type: 'string', max_length: 32768, required: true } }, request: { method: 'POST', path: '/a', body: { a: { $template: '{a|json_string}{a|json_string}{a|json_string}{a|json_string}{a|json_string}{a|json_string}' }, b: { $template: '{a|json_string}{a|json_string}{a|json_string}{a|json_string}{a|json_string}{a|json_string}' } } } })), /could exceed/],
    ['invalid pattern', withTool(getPostDecl({ args: { file: { type: 'string', pattern: '(', required: true } } })), /not a valid regular expression/],
    ['plain http beyond loopback', apiSiteRaw(base, { transport: { kind: 'api', base_url: 'http://example.com', network: 'public' } }), /must be https/],
    ['credentials in base_url', apiSiteRaw(base, { transport: { kind: 'api', base_url: 'https://u:p@example.com', network: 'public' } }), /credentials/],
    ['query in base_url', apiSiteRaw(base, { transport: { kind: 'api', base_url: 'https://example.com/?a=1', network: 'public' } }), /no query/],
    ['a loopback host with network public', apiSiteRaw(base, { transport: { kind: 'api', base_url: 'https://127.0.0.1', network: 'public' } }), /declare network 'loopback'/],
    ['network loopback with a real host', apiSiteRaw(base, { transport: { kind: 'api', base_url: 'https://example.com', network: 'loopback' } }), /needs a base_url host/],
    ['unknown network', apiSiteRaw(base, { transport: { kind: 'api', base_url: 'https://example.com', network: 'any' } }), /network must be/],
    ['secret written in place', apiSiteRaw(base, { auth: { kind: 'bearer', token: 'abc' } }), /unknown key 'token'/],
    ['oauth_delegated', apiSiteRaw(base, { auth: { kind: 'oauth_delegated', hub: 'https://h.example', resource: 'https://r.example', scopes: ['a'] } }), /not supported by the api transport/],
    ['env_from', apiSiteRaw(base, { env_from: { A: 'B' } }), /only for stdio/],
  ];
  for (const [name, raw, expected] of cases) {
    const problems = problemsOf(raw);
    assert.match(problems, expected, name);
  }
});

test('the pin follows the declaration: a request change, an approval change or a base_url change all change it; a description change does not', () => {
  const pinOf = (raw: Record<string, unknown>): string => apiPinOf(parseMcpSite(raw).tools.find((t) => t.name === 'create_post_branch')!)!;
  const original = pinOf(apiSiteRaw(base));
  assert.notEqual(pinOf(apiSiteRaw(base, { tools: [draftPostDecl({ request: { ...(draftPostDecl()['request'] as object), path: '/repos/aot/other/contents' } })] })), original);
  assert.notEqual(pinOf(apiSiteRaw(base, { tools: [draftPostDecl({ approval: 'scope' })] })), original);
  assert.notEqual(pinOf(apiSiteRaw(base, { tools: [draftPostDecl({ target: 'site:web/other' })] })), original);
  assert.notEqual(pinOf(apiSiteRaw('http://127.0.0.1:10')), original);
  assert.notEqual(pinOf(apiSiteRaw(base, { auth: { kind: 'bearer', token_env: API_TOKEN_ENV } })), original);
  assert.equal(pinOf(apiSiteRaw(base, { tools: [draftPostDecl({ description: '다른 설명' })] })), original);
});

// ===== 요청 조립 (순수) =====

test('assembly: the same declaration and arguments always give the same bytes; Korean and emoji survive base64; a title cannot break out of the front matter', () => {
  const manifest = parseMcpSite(apiSiteRaw(base));
  const op = manifest.tools[2]!.api!.op;
  const args = { ...POST_ARGS, effect_key: 'eff-0001' };
  const first = buildApiRequest(op, args, '/api/v1');
  const second = buildApiRequest(op, { ...args }, '/api/v1');
  assert.deepEqual(first, second);
  assert.equal(first.method, 'POST');
  assert.equal(first.target, '/api/v1/repos/aot/aot-web/contents');
  assert.equal(first.headers['content-type'], 'application/json');
  const body = JSON.parse(first.body!) as { branch: string; new_branch: string; message: string; files: { operation: string; path: string; content: string }[] };
  assert.equal(body.branch, 'main');
  assert.equal(body.new_branch, 'agent/post-hello-farm');
  assert.equal(body.message, '글 초안 hello-farm\n\neffect-key: eff-0001');
  assert.deepEqual(body.files.map((f) => [f.operation, f.path]), [['create', 'src/ko/posts/hello-farm.md'], ['create', 'src/en/posts/hello-farm.md']]);
  assert.equal(Buffer.from(body.files[0]!.content, 'base64').toString('utf8'), '---\ntitle: "스마트팜 \\"첫\\" 글: 🌱"\ndate: 2026-11-10\ncategory: "AoT blog"\nexcerpt: "요약"\npublished: false\n---\n\n본문 한국어\n둘째 줄\n');
  // 줄바꿈이 든 제목은 패턴이 거부한다(앞머리 주입)
  const injected = { ...args, ko_title: 'x\n---\npublished: true' };
  assert.throws(() => buildApiRequest(op, injected, ''), /does not match its pattern/);
});

test('assembly: path arguments cannot add segments or dots; query values are percent-encoded; optional query arguments may be left out; extra and host-only arguments are refused', () => {
  const manifest = parseMcpSite(apiSiteRaw(base));
  const get = manifest.tools[1]!.api!.op;
  assert.equal(buildApiRequest(get, { file: 'a-post.md', ref: 'a&b=c d' }, '').target, '/repos/aot/aot-web/contents/src/ko/posts/a-post.md?ref=a%26b%3Dc%20d');
  assert.equal(buildApiRequest(get, { file: 'a-post.md' }, '').target, '/repos/aot/aot-web/contents/src/ko/posts/a-post.md');
  for (const file of ['../etc.md', 'a/b.md', '..%2f.md', 'a.md\r\nX: 1', '.md', 'a b.md']) assert.throws(() => buildApiRequest(get, { file }, ''), /pattern/, file);
  assert.throws(() => buildApiRequest(get, { file: 'a-post.md', other: 1 }, ''), /not declared/);
  assert.throws(() => buildApiRequest(get, { file: 'a-post.md', effect_key: 'x' }, ''), /not declared/);
  // 패턴이 슬래시를 허용해도 조립 단계가 한 구간만 허용한다
  const loose = parseMcpSite(apiSiteRaw(base, { tools: [getPostDecl({ args: { file: { type: 'string', pattern: '^.+$', required: true } }, request: { method: 'GET', path: '/x/{file}' }, returns: ['/name'] })] })).tools[0]!.api!.op;
  for (const file of ['a/b', '..', '.', 'a\\b', 'a\u0000b', 'a\nb']) assert.throws(() => buildApiRequest(loose, { file }, ''), /path|NUL|pattern/, JSON.stringify(file));
  assert.equal(buildApiRequest(loose, { file: '%2e%2e' }, '').target, '/x/%252e%252e');
});

test('assembly: the write needs the host effect key; integers and booleans are range checked', () => {
  const op = parseMcpSite(apiSiteRaw(base)).tools[2]!.api!.op;
  assert.throws(() => buildApiRequest(op, { ...POST_ARGS }, ''), /effect key is missing/);
  assert.throws(() => buildApiRequest(op, { ...POST_ARGS, effect_key: 'has space' }, ''), /malformed/);
  const typed = parseMcpSite(apiSiteRaw(base, { tools: [getPostDecl({
    args: { n: { type: 'integer', min: 1, max: 5, required: true }, flag: { type: 'boolean', required: true } },
    request: { method: 'GET', path: '/x', query: { n: { $arg: 'n' }, flag: { $arg: 'flag' } } }, returns: ['/name'],
  })] })).tools[0]!.api!.op;
  assert.equal(buildApiRequest(typed, { n: 3, flag: false }, '').target, '/x?n=3&flag=false');
  for (const bad of [{ n: 0, flag: true }, { n: 6, flag: true }, { n: 1.5, flag: true }, { n: '3', flag: true }, { n: 3, flag: 'yes' }]) assert.throws(() => buildApiRequest(typed, bad, ''));
});

// ===== 주소 규칙 =====

test('address policy: public allows public only; tailnet adds 100.64.0.0/10 only; loopback allows loopback only; link-local and private ranges are never allowed', () => {
  const table: [string, string[], string[]][] = [
    ['public', ['8.8.8.8', '2606:4700:4700::1111'], ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '127.0.0.1', '::1', '100.64.0.1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0', 'not-an-ip']],
    ['tailnet', ['8.8.8.8', '100.64.0.1', '100.127.255.254', '100.128.0.1', '100.63.255.255'], ['10.0.0.1', '192.168.1.1', '169.254.169.254', '127.0.0.1', '::1']],
    ['loopback', ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1'], ['8.8.8.8', '10.0.0.1', '100.64.0.1', '169.254.169.254', '::2']],
  ];
  for (const [network, allowed, denied] of table) {
    for (const address of allowed) assert.equal(addressAllowed(network as 'public', address), true, `${network} allows ${address}`);
    for (const address of denied) assert.equal(addressAllowed(network as 'public', address), false, `${network} denies ${address}`);
  }
});

test('the connector folder keeps a verbatim copy of ip-address.ts (it may not import other folders)', () => {
  const original = readFileSync(new URL('../../packages/agent-runtime/src/ip-address.ts', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../../packages/agent-runtime/src/mcp/connector/ip-address.ts', import.meta.url), 'utf8');
  const code = (text: string): string => text.slice(text.indexOf('/** [기준 주소'));
  assert.ok(code(copy).startsWith(code(original).trimEnd()), 'the code portion of the copy starts with the original code');
});

// ===== 실제 커넥터 프로세스 + 가짜 서비스 =====

test('read: the declared request goes out; only allow-listed fields come back; the token is sent as declared and never returned', async (t) => {
  const service = await startFakeService(t);
  const rig = await startApiSite(t, apiSiteRaw(service.baseUrl));
  assert.deepEqual(rig.manifest.tools.map((tool) => rig.client.stateOf(tool.gatewayName).status), ['open', 'open', 'open']);
  const out = await callOf(rig, 'list_posts', {});
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.result.structured, [{ name: 'a-post.md' }, { name: 'b-post.md' }]);
  assert.ok(!out.result.text.includes('secret-a') && !out.result.text.includes('f00dfeed'), 'fields outside the allow list are dropped');
  assert.equal(service.seen.length, 1);
  const [seen] = service.seen as [(typeof service.seen)[number]];
  assert.deepEqual([seen.method, seen.url], ['GET', '/repos/aot/aot-web/contents/src/ko/posts?ref=main']);
  assert.equal(seen.headers['authorization'], API_TOKEN);
  assert.equal(seen.headers['accept-encoding'], 'identity');
  assert.ok(String(seen.headers['host']).startsWith('127.0.0.1:'));
});

test('anything outside the declaration never leaves the connector: unknown operation, extra argument, wrong type, pattern failure', async (t) => {
  const service = await startFakeService(t);
  const rig = await startApiSite(t, apiSiteRaw(service.baseUrl));
  const refused = async (name: string, args: Record<string, unknown>, code: string): Promise<void> => {
    const out = await callOf(rig, name, args);
    assert.equal(out.ok, false, name);
    if (out.ok) return;
    assert.deepEqual([out.error.code, out.error.definite], [code, true], `${name} ${JSON.stringify(args).slice(0, 60)}`);
  };
  await refused('delete_repo', {}, 'undeclared_tool');
  await refused('__proto__', {}, 'undeclared_tool');
  await refused('list_posts', { path: '/admin' }, 'invalid_arguments');
  await refused('get_post', { file: 'x.md', method: 'DELETE' }, 'invalid_arguments');
  await refused('get_post', { file: '../../admin.md' }, 'invalid_arguments');
  await refused('get_post', { file: 'ok-file.md', ref: 'x'.repeat(101) }, 'invalid_arguments');
  await refused('get_post', { file: 7 }, 'invalid_arguments');
  await refused('create_post_branch', { ...POST_ARGS }, 'invalid_arguments'); // 효과 키가 없다
  assert.equal(service.seen.length, 0, 'not one request reached the service');
});

test('injection attempts in path, query, header and body positions do not change the shape of the request', async (t) => {
  const service = await startFakeService(t);
  const rig = await startApiSite(t, apiSiteRaw(service.baseUrl));
  const hostile = 'main&access_token=stolen#frag\r\nX-Injected: 1';
  assert.equal((await callOf(rig, 'get_post', { file: 'ok-file.md', ref: hostile })).ok, true);
  const [seen] = service.seen as [(typeof service.seen)[number]];
  assert.equal(seen.url, `/repos/aot/aot-web/contents/src/ko/posts/ok-file.md?ref=${encodeURIComponent(hostile)}`);
  assert.equal(seen.headers['x-injected'], undefined);
  assert.ok(!seen.url.includes('access_token=stolen'));
  // 본문: 구조를 바꾸려는 값은 문자열 안에 머문다
  const out = await callOf(rig, 'create_post_branch', { ...POST_ARGS, ko_body: '"}, "branch": "main", "x": {"', effect_key: 'eff-1234' });
  assert.equal(out.ok, true);
  const body = JSON.parse(service.seen[1]!.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['branch', 'files', 'message', 'new_branch']);
});

test('redirects are never followed: a 302 to another host or a private address is a failure and the second server sees nothing', async (t) => {
  const other = await startFakeService(t);
  const service = await startFakeService(t, '', (_seen, res) => { res.writeHead(302, { location: `${other.baseUrl}/steal` }); res.end(); });
  const rig = await startApiSite(t, apiSiteRaw(service.baseUrl));
  const read = await callOf(rig, 'list_posts', {});
  assert.deepEqual(read.ok && [read.result.is_error, read.result.text], [true, 'http 302 (redirects are not followed)']);
  const write = await callOf(rig, 'create_post_branch', { ...POST_ARGS, effect_key: 'eff-redirect' });
  assert.deepEqual(write.ok && write.result.is_error, true, 'a redirected write is a failure, not a success');
  assert.equal(service.seen.length, 2);
  assert.equal(other.seen.length, 0);
  // 같은 출처 리다이렉트도 따르지 않는다
  service.handle((_seen, res) => { res.writeHead(307, { location: '/elsewhere' }); res.end(); });
  assert.equal((await callOf(rig, 'list_posts', {})).ok && true, true);
  assert.equal(service.seen.length, 3, 'one request per call, no follow-up');
});

test('address policy in the connector process: public refuses a loopback host before connecting; tailnet still refuses it', async (t) => {
  const service = await startFakeService(t);
  const manifest = pinnedManifest(apiSiteRaw(service.baseUrl));
  const operations = Object.fromEntries(manifest.tools.map((tool) => [tool.name, { op: tool.api!.op, decl_hash: tool.api!.declHash }]));
  const config = (network: string, baseUrl: string) => connectorConfig({
    site: 'web', transport: { kind: 'api', base_url: baseUrl, network, timeout_ms: 3000, operations }, tools: manifest.tools.map((tool) => tool.name),
    auth: { kind: 'header', header: 'Authorization', value_env: API_TOKEN_ENV },
  });
  for (const [network, url] of [['public', `https://127.0.0.1:${service.port}`], ['tailnet', `https://localhost:${service.port}`], ['public', `https://[::1]:${service.port}`]] as const) {
    const c = startConnector(t, config(network, url), API_SECRET_ENV);
    const out = await c.ask({ op: 'call', tool: 'list_posts', arguments: {} });
    assert.deepEqual([out['ok'], out['error'].code, out['error'].definite], [false, 'address_not_allowed', true], `${network} ${url}`);
  }
  assert.equal(service.seen.length, 0);
  // 같은 연결로 loopback 선언은 닿는다
  const c = startConnector(t, config('loopback', service.baseUrl), API_SECRET_ENV);
  assert.equal((await c.ask({ op: 'call', tool: 'list_posts', arguments: {} }))['ok'], true);
});

test('size and time limits: an oversized response is cut and is a tool error; a silent service ends with a timeout that is not definite', async (t) => {
  const service = await startFakeService(t, '', (_seen, res) => json(res, 200, [{ name: 'x'.repeat(300_000) }]));
  const rig = await startApiSite(t, apiSiteRaw(service.baseUrl, { timeout_ms: 1500 }));
  const big = await callOf(rig, 'list_posts', {});
  assert.deepEqual(big.ok && [big.result.is_error, big.result.truncated], [true, true]);
  service.handle(() => undefined); // 응답하지 않는다
  const slow = await callOf(rig, 'list_posts', {});
  assert.deepEqual(!slow.ok && [slow.error.code, slow.error.definite], ['timeout', false]);
});

test('responses that are compressed, not JSON, have the wrong shape or carry a secret are handled without leaking', async (t) => {
  const service = await startFakeService(t);
  const rig = await startApiSite(t, apiSiteRaw(service.baseUrl));
  service.handle((_s, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end('xx'); });
  const compressed = await callOf(rig, 'list_posts', {});
  assert.deepEqual(compressed.ok && [compressed.result.is_error, compressed.result.text], [true, 'the response is compressed and is not read']);
  service.handle((_s, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<b>x</b>'); });
  const html = await callOf(rig, 'list_posts', {});
  assert.deepEqual(html.ok && html.result.text, 'the response is not JSON');
  service.handle((_s, res) => json(res, 200, [{ title: 'no name field' }]));
  const shape = await callOf(rig, 'list_posts', {});
  assert.ok(shape.ok && shape.result.is_error && shape.result.text.startsWith('the response does not have the declared shape'));
  service.handle((_s, res) => json(res, 200, [{ name: `echo ${API_TOKEN} echo` }]));
  const echoed = await callOf(rig, 'list_posts', {});
  assert.ok(echoed.ok && !JSON.stringify(echoed.result).includes(API_TOKEN) && JSON.stringify(echoed.result).includes('[redacted]'));
});

test('status mapping: 4xx is a tool error that was definitely not applied; 5xx is not definite; a refused connection is definite', async (t) => {
  const service = await startFakeService(t);
  const rig = await startApiSite(t, apiSiteRaw(service.baseUrl));
  service.handle((_s, res) => json(res, 422, { message: 'secret detail from the service' }));
  const rejected = await callOf(rig, 'create_post_branch', { ...POST_ARGS, effect_key: 'eff-422' });
  assert.deepEqual(rejected.ok && [rejected.result.is_error, rejected.result.text], [true, 'http 422']);
  service.handle((_s, res) => json(res, 503, {}));
  const broken = await callOf(rig, 'create_post_branch', { ...POST_ARGS, effect_key: 'eff-503' });
  assert.deepEqual(!broken.ok && [broken.error.code, broken.error.definite], ['http_5xx', false]);
  await service.close();
  const refusedConnection = await callOf(rig, 'list_posts', {});
  assert.deepEqual(!refusedConnection.ok && [refusedConnection.error.code, refusedConnection.error.definite], ['connect_failed', true]);
});

test('write: the request body is exactly the assembled bytes; the write result carries only the record fields', async (t) => {
  const service = await startFakeService(t);
  const rig = await startApiSite(t, apiSiteRaw(service.baseUrl));
  const args = { ...POST_ARGS, effect_key: 'eff-write-1' };
  const out = await callOf(rig, 'create_post_branch', args);
  assert.ok(out.ok);
  assert.deepEqual(out.result.structured, { commit: { sha: 'c0ffee1234', html_url: 'http://gitea.invalid/aot/aot-web/commit/c0ffee1234' } }, 'record fields only; the author e-mail is dropped');
  const expected = buildApiRequest(rig.manifest.tools[2]!.api!.op, args, '');
  const [seen] = service.seen as [(typeof service.seen)[number]];
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, expected.body);
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.headers['authorization'], API_TOKEN);
});

// ===== 선언 고정 =====

test('pin: matching pins open every tool; a missing pin, a wrong pin and a changed request all close only that tool as drift', async (t) => {
  const service = await startFakeService(t);
  const raw = apiSiteRaw(service.baseUrl);
  const pinned = withPins(raw);
  const missing = await startApiSite(t, raw, { pinned: false });
  assert.deepEqual(missing.manifest.tools.map((tool) => missing.client.stateOf(tool.gatewayName)), Array(3).fill({ status: 'closed', reason: 'drift' }));

  const tools = pinned['tools'] as Record<string, unknown>[];
  const changed = { ...pinned, tools: [tools[0], tools[1], { ...tools[2], request: { ...(tools[2]!['request'] as object), path: '/repos/aot/other/contents' } }] };
  const rig = await startApiSite(t, changed, { pinned: false });
  assert.deepEqual(rig.manifest.tools.map((tool) => rig.client.stateOf(tool.gatewayName).status), ['open', 'open', 'closed']);
  assert.deepEqual(rig.client.stateOf('mcp_web_draft_post'), { status: 'closed', reason: 'drift' });
  assert.ok(rig.events.some((e) => e.type === 'tool_state' && e.state === 'closed:drift'));
});
