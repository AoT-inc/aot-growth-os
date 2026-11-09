// 커넥터 프로세스 프로토콜 (ADR-0018 §1·§5·§8, 설계 §3·§4): 실제 커넥터 프로세스를 줄 단위 JSON 으로 모고, 상대는 가짜 MCP 서버(stdio·127.0.0.1 http)다. 외부 네트워크 없음.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';

import { startFakeHttpServer, type Scenario } from '../fixtures/mcp/fake-server.ts';
import { connectorConfig, readRecords, SEARCH_HASH, startConnector, stdioTransport, TEST_TOKEN, TOKEN_ENV, UPDATE_HASH, waitFor, callsTo } from '../support/mcp.ts';
import { makeTempDir } from '../support/temp.ts';

const stdioConfig = (scenario: Scenario, record: string, over: Record<string, unknown> = {}) =>
  connectorConfig({ transport: stdioTransport(scenario, record), env_from: { MCP_TOKEN: TOKEN_ENV }, ...over });

test('list: initialize with no client capabilities and the newest known version; declared tools come with their schema hash; the server description is not passed on', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const c = startConnector(t, stdioConfig('normal', record));
  const listed = await c.ask({ op: 'list' });
  assert.equal(listed['ok'], true);
  assert.deepEqual(listed['tools'].map((x: { name: string; input_schema_sha256: string }) => [x.name, x.input_schema_sha256]), [['units_search', SEARCH_HASH], ['unit_update', UPDATE_HASH]]);
  assert.deepEqual(listed['undeclared'], []);
  assert.deepEqual(listed['server'], { name: 'fake-course-server', version: '9.9.9', protocol_version: '2025-06-18' });
  assert.ok(!JSON.stringify(listed).includes('SERVER DESCRIPTION'), 'the server-supplied description never leaves the connector');
  const init = readRecords(record).find((r) => r.method === 'initialize')!;
  assert.deepEqual(init.params, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aot-mcp-connector', version: '1.0.0' } });
  assert.ok(readRecords(record).some((r) => r.method === 'notifications/initialized'));
});

test('tools the owner did not declare are only counted by name: no schema is passed on', async (t) => {
  const c = startConnector(t, stdioConfig('adds_tools', join(makeTempDir(t), 'r.jsonl')));
  const listed = await c.ask({ op: 'list' });
  assert.deepEqual(listed['undeclared'], ['admin_delete']);
  assert.deepEqual(listed['tools'].map((x: { name: string }) => x.name), ['units_search', 'unit_update']);
});

test('tools/list follows nextCursor to the end', async (t) => {
  const c = startConnector(t, stdioConfig('paged', join(makeTempDir(t), 'r.jsonl')));
  assert.deepEqual((await c.ask({ op: 'list' }))['tools'].map((x: { name: string }) => x.name), ['units_search', 'unit_update']);
});

test('call: only text content passes; images are dropped and counted; structured content passes', async (t) => {
  const c = startConnector(t, stdioConfig('normal', join(makeTempDir(t), 'r.jsonl')));
  const searched = await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'abc' } });
  assert.deepEqual(searched, { id: searched['id'], ok: true, result: { is_error: false, text: 'found:abc', dropped: { image: 1 } } });
  const updated = await c.ask({ op: 'call', tool: 'unit_update', arguments: { unit_id: 'u1', body: 'x', request_id: 'r1' } });
  assert.deepEqual(updated['result'].structured, { unit_id: 'u1', request_id: 'r1' });
  const failed = await startConnector(t, stdioConfig('is_error', join(makeTempDir(t), 'r2.jsonl'))).ask({ op: 'call', tool: 'unit_update', arguments: { unit_id: 'u1', body: 'x' } });
  assert.equal(failed['result'].is_error, true);
});

test('the result size is capped: longer text is cut and marked truncated', async (t) => {
  const c = startConnector(t, stdioConfig('big', join(makeTempDir(t), 'r.jsonl'), { max_result_bytes: 1000 }));
  const big = await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'a' } });
  assert.equal(big['result'].truncated, true);
  assert.equal(Buffer.byteLength(big['result'].text, 'utf8'), 1000);
});

test('a call to a tool outside the declared list is refused as definite and never reaches the server', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const c = startConnector(t, stdioConfig('adds_tools', record));
  await c.ask({ op: 'list' });
  const refused = await c.ask({ op: 'call', tool: 'admin_delete', arguments: { id: '1' } });
  assert.deepEqual(refused['error'], { code: 'undeclared_tool', message: 'the tool is not declared by the owner', definite: true });
  assert.equal(callsTo(record).length, 0);
  const odd = await c.ask({ op: 'call', tool: '__proto__', arguments: {} });
  assert.equal(odd['error'].code, 'undeclared_tool');
  assert.equal(callsTo(record).length, 0);
});

test('inspect mode (mcp-pin): undeclared schemas are listed but every call is refused', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const c = startConnector(t, stdioConfig('adds_tools', record, { inspect: true, tools: [] }));
  assert.deepEqual((await c.ask({ op: 'list' }))['tools'].map((x: { name: string }) => x.name), ['units_search', 'unit_update', 'admin_delete']);
  assert.equal((await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'a' } }))['error'].code, 'undeclared_tool');
  assert.equal(callsTo(record).length, 0);
});

test('requests from the server are refused with -32601 (except ping) and reported; the call still completes', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const c = startConnector(t, stdioConfig('asks_sampling', record));
  const searched = await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'abc' } });
  assert.equal(searched['ok'], true);
  const reply = readRecords(record).find((r) => r.id === 'srv-1')!;
  assert.deepEqual((reply.error as { code: number }).code, -32601);
  assert.deepEqual(c.notices(), [{ type: 'server_request_refused', method: 'sampling/createMessage' }]);
});

test('an unsupported protocol version chosen by the server fails initialization as definite', async (t) => {
  const script = "process.stdin.on('data',d=>{for(const l of String(d).split('\\n')){if(!l)continue;const m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'1999-01-01',capabilities:{},serverInfo:{name:'x',version:'1'}}}))}})";
  const c = startConnector(t, connectorConfig({ transport: { kind: 'stdio', command: process.execPath, args: ['-e', script] } }));
  const listed = await c.ask({ op: 'list' });
  assert.equal(listed['ok'], false);
  assert.equal(listed['error'].code, 'init_failed');
  assert.equal(listed['error'].definite, true);
  assert.match(listed['error'].message, /unsupported protocol version/);
});

test('a server that dies during a call is a non-definite error (the host records unknown for a write)', async (t) => {
  const c = startConnector(t, stdioConfig('crash_on_call', join(makeTempDir(t), 'r.jsonl')));
  const crashed = await c.ask({ op: 'call', tool: 'unit_update', arguments: { unit_id: 'u', body: 'b' } });
  assert.equal(crashed['ok'], false);
  assert.equal(crashed['error'].code, 'server_exit');
  assert.equal(crashed['error'].definite, false);
});

test('cancel: the connector tells the server (notifications/cancelled) and stops waiting', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const c = startConnector(t, stdioConfig('hangs', record));
  await c.ask({ op: 'list' });
  const pending = c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'a' } });
  await waitFor(() => callsTo(record).length === 1);
  const rpcId = callsTo(record)[0]!.id;
  const hostId = c.lines.length; // 시험 하네스의 id 는 1부터 순서대로: list=1, call=2
  assert.equal(await c.ask({ op: 'cancel', target_id: 2 }).then((r) => r['ok']), true, `host ids ${hostId}`);
  const answer = await pending;
  assert.equal(answer['ok'], false);
  assert.equal(answer['error'].code, 'aborted');
  await waitFor(() => readRecords(record).some((r) => r.method === 'notifications/cancelled'));
  assert.equal((readRecords(record).find((r) => r.method === 'notifications/cancelled')!.params as { requestId: unknown }).requestId, rpcId);
});

test('secrets: the config line carries only variable names; a token echoed by the server is redacted in text and structured content', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const config = stdioConfig('echoes_secret', record);
  const c = startConnector(t, config);
  assert.ok(!JSON.stringify(config).includes(TEST_TOKEN));
  const echoed = await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'abc' } });
  assert.equal(echoed['result'].text, 'found:abc\nsecret-was:[redacted]');
  assert.deepEqual(echoed['result'].structured, { echoed: '[redacted]' });
  assert.ok(!JSON.stringify(c.lines).includes(TEST_TOKEN), 'nothing the connector wrote contains the token');
  assert.ok(JSON.stringify(readRecords(record)).includes('initialize'), 'the server did run');
});

test('a missing secret variable makes every request fail as definite config_invalid (nothing is sent)', async (t) => {
  const c = startConnector(t, stdioConfig('normal', join(makeTempDir(t), 'r.jsonl')), {});
  const listed = await c.ask({ op: 'list' });
  assert.equal(listed['error'].code, 'config_invalid');
  assert.equal(listed['error'].definite, true);
});

// ===== Streamable HTTP =====

const httpConfig = (url: string, over: Record<string, unknown> = {}) => connectorConfig({ transport: { kind: 'http', url }, auth: { kind: 'bearer', token_env: TOKEN_ENV }, ...over });

for (const mode of ['json', 'sse'] as const) {
  test(`http (${mode} responses): session id and protocol version headers are sent after initialize, bearer token is sent, tools/list and tools/call work`, async (t) => {
    const record = join(makeTempDir(t), 'r.jsonl');
    const server = await startFakeHttpServer({ scenario: 'normal', recordPath: record, responseMode: mode, expectBearer: TEST_TOKEN });
    t.after(() => server.close());
    const c = startConnector(t, httpConfig(server.url));
    assert.equal((await c.ask({ op: 'list' }))['ok'], true);
    const searched = await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'abc' } });
    assert.equal(searched['result'].text, 'found:abc');
    const records = readRecords(record);
    const init = records.find((r) => r.method === 'initialize')!;
    assert.equal(init.headers!['session'], null);
    assert.match(init.headers!['accept']!, /application\/json, text\/event-stream/);
    const list = records.find((r) => r.method === 'tools/list')!;
    assert.equal(list.headers!['session'], 'sess-1');
    assert.equal(list.headers!['protocol'], '2025-06-18');
    assert.equal(list.headers!['authorization'], `Bearer ${TEST_TOKEN}`);
  });
}

test('http over SSE: a server request inside the stream is refused through a POSTed reply and reported', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const server = await startFakeHttpServer({ scenario: 'asks_sampling', recordPath: record, responseMode: 'sse' });
  t.after(() => server.close());
  const c = startConnector(t, httpConfig(server.url));
  assert.equal((await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'abc' } }))['ok'], true);
  assert.equal((readRecords(record).find((r) => r.id === 'srv-1')!.error as { code: number }).code, -32601);
  assert.deepEqual(c.notices(), [{ type: 'server_request_refused', method: 'sampling/createMessage' }]);
});

test('http: a token echoed in the result is redacted', async (t) => {
  const server = await startFakeHttpServer({ scenario: 'echoes_secret' });
  t.after(() => server.close());
  const c = startConnector(t, httpConfig(server.url));
  const echoed = await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'abc' } });
  assert.ok(!JSON.stringify(echoed).includes(TEST_TOKEN));
  assert.match(echoed['result'].text, /secret-was:\[redacted\]/);
});

test('http: session expiry (404) re-initializes once for a retry-safe call, but a write is not re-sent', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const server = await startFakeHttpServer({ scenario: 'session_expires', recordPath: record });
  t.after(() => server.close());
  const c = startConnector(t, httpConfig(server.url));
  assert.equal((await c.ask({ op: 'list' }))['ok'], true); // 이 뒤 다음 요청이 404
  const retried = await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'a' }, retry_safe: true });
  assert.equal(retried['ok'], true);
  assert.equal(readRecords(record).filter((r) => r.method === 'initialize').length, 2);

  const record2 = join(makeTempDir(t), 'r2.jsonl');
  const server2 = await startFakeHttpServer({ scenario: 'session_expires', recordPath: record2 });
  t.after(() => server2.close());
  const c2 = startConnector(t, httpConfig(server2.url));
  await c2.ask({ op: 'list' });
  const write = await c2.ask({ op: 'call', tool: 'unit_update', arguments: { unit_id: 'u', body: 'b' } });
  assert.equal(write['ok'], false);
  assert.equal(write['error'].code, 'session_expired');
  assert.equal(write['error'].definite, false);
  assert.equal(callsTo(record2).length, 1, 'only the original (404-answered) request arrived: the write was not sent again');
});

test('http: redirects are not followed (3xx is an error), 401 is definite, a refused connection is definite', async (t) => {
  let hits = 0;
  const redirecting = createServer((_req, res) => { hits += 1; res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/elsewhere'); res.end(); });
  await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
  t.after(() => redirecting.close());
  const c = startConnector(t, httpConfig(`http://127.0.0.1:${(redirecting.address() as AddressInfo).port}/mcp`));
  const listed = await c.ask({ op: 'list' });
  assert.match(listed['error'].message, /redirect/);
  assert.equal(hits, 1, 'the redirect target was never contacted and the request was not repeated');

  const unauthorized = await startFakeHttpServer({ scenario: 'normal', expectBearer: 'another-token' });
  t.after(() => unauthorized.close());
  const c2 = startConnector(t, httpConfig(unauthorized.url));
  const denied = await c2.ask({ op: 'call', tool: 'units_search', arguments: { query: 'a' } });
  assert.equal(denied['error'].definite, true);

  const free = createServer();
  await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
  const port = (free.address() as AddressInfo).port;
  await new Promise<void>((resolve) => free.close(() => resolve()));
  const c3 = startConnector(t, httpConfig(`http://127.0.0.1:${port}/mcp`));
  const refused = await c3.ask({ op: 'call', tool: 'units_search', arguments: { query: 'a' } });
  assert.equal(refused['error'].code, 'init_failed');
  assert.equal(refused['error'].definite, true);
});

test('http: a non-https, non-loopback url is refused before any connection is made', async (t) => {
  const c = startConnector(t, httpConfig('http://mcp.course.example.com/mcp'));
  const listed = await c.ask({ op: 'list' });
  assert.equal(listed['error'].code, 'bad_url');
  assert.equal(listed['error'].definite, true);
});

test('http: a crash (connection cut) during a call is non-definite', async (t) => {
  const server = await startFakeHttpServer({ scenario: 'crash_on_call' });
  t.after(() => server.close());
  const c = startConnector(t, httpConfig(server.url));
  const cut = await c.ask({ op: 'call', tool: 'unit_update', arguments: { unit_id: 'u', body: 'b' } });
  assert.equal(cut['ok'], false);
  assert.equal(cut['error'].definite, false);
});
