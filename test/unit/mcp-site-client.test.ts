// 사이트 연결 (설계 §5.3·§5.5·§5.6): 고정 확인 상태, 재확인 시점, 커넥터 재시작 지수 대기, 호스트 타이머·취소, 분당 상한. 가짜 커넥터 연결과 손으로 돌리는 타이머·Clock 을 쓴다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpSiteClient, McpTransportError, type McpSiteEvent } from '@aot/agent-runtime';
import { FakeClock } from '@aot/domain';

import { DRIFTED_UPDATE_SCHEMA, UPDATE_SCHEMA } from '../fixtures/mcp/fake-server.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { FakeConnectorLink, flush, manifestOf, SEARCH_TOOL, stdioSiteRaw, UPDATE_TOOL, searchDecl } from '../support/mcp.ts';

function rig(raw: Record<string, unknown> = stdioSiteRaw('normal', undefined)) {
  const clock = new FakeClock();
  const timers = new ManualGatewayTimers();
  const links: FakeConnectorLink[] = [];
  const events: McpSiteEvent[] = [];
  const manifest = manifestOf(raw);
  const client = createMcpSiteClient({
    manifest, clock, timers, onEvent: (e) => events.push(e), recheckIntervalMs: 600_000,
    spawn: () => { const link = new FakeConnectorLink(); links.push(link); return link; },
  });
  return { clock, timers, links, events, manifest, client };
}

test('start: the config line names the declared tools and environment variable names only; every declared tool opens when the pin matches', async () => {
  const r = rig();
  await r.client.start();
  const config = r.links[0]!.sent[0]!;
  assert.deepEqual(config['tools'], ['units_search', 'unit_update']);
  assert.deepEqual(config['env_from'], { MCP_TOKEN: 'AOT_MCP_COURSE_TOKEN' });
  assert.ok(!('inspect' in config));
  assert.deepEqual([r.client.stateOf(SEARCH_TOOL), r.client.stateOf(UPDATE_TOOL)], [{ status: 'open' }, { status: 'open' }]);
  assert.deepEqual(r.client.stateOf('mcp_course_nonexistent'), { status: 'closed', reason: 'missing' });
  assert.deepEqual(r.events.map((e) => e.type), ['connector_started', 'tool_state', 'tool_state']);
});

test('before the first successful list every tool is closed (unavailable)', () => {
  const r = rig();
  assert.deepEqual(r.client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unavailable' });
});

test('drift: a changed schema closes only that tool and emits an event; a list_changed notice from the connector triggers the re-check by itself', async () => {
  const r = rig();
  await r.client.start();
  const link = r.links[0]!;
  link.tools[1]!.input_schema = DRIFTED_UPDATE_SCHEMA;
  link.emit({ type: 'list_changed' });
  await flush();
  assert.deepEqual(r.client.stateOf(UPDATE_TOOL), { status: 'closed', reason: 'drift' });
  assert.deepEqual(r.client.stateOf(SEARCH_TOOL), { status: 'open' });
  assert.ok(r.events.some((e) => e.type === 'tool_state' && e.tool === UPDATE_TOOL && e.state === 'closed:drift' && e.previous === 'open'));
  // 원래대로 돌아오면 다시 열린다 (고정값은 오너 선언이 정한다)
  link.tools[1]!.input_schema = UPDATE_SCHEMA;
  await r.client.refresh();
  assert.deepEqual(r.client.stateOf(UPDATE_TOOL), { status: 'open' });
});

test('missing, hint_conflict (closed unless acknowledged) and undeclared tools (recorded, never exposed)', async () => {
  const r = rig();
  await r.client.start();
  const link = r.links[0]!;
  link.tools = [{ name: 'units_search', input_schema: link.tools[0]!.input_schema, annotations: { readOnlyHint: false } }];
  link.undeclared = ['admin_delete'];
  await r.client.refresh();
  assert.deepEqual(r.client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'hint_conflict' });
  assert.deepEqual(r.client.stateOf(UPDATE_TOOL), { status: 'closed', reason: 'missing' });
  assert.deepEqual(r.client.undeclared(), ['admin_delete']);
  assert.ok(r.events.some((e) => e.type === 'undeclared_tools' && e.names.includes('admin_delete')));
  const before = r.events.filter((e) => e.type === 'undeclared_tools').length;
  await r.client.refresh();
  assert.equal(r.events.filter((e) => e.type === 'undeclared_tools').length, before, 'an unchanged undeclared set is not reported again');

  const acked = rig(stdioSiteRaw('normal', undefined, { tools: [searchDecl({ ack_server_hint_conflict: true })] }));
  await acked.client.start();
  acked.links[0]!.tools[0]!.annotations = { destructiveHint: true };
  await acked.client.refresh();
  assert.deepEqual(acked.client.stateOf(SEARCH_TOOL), { status: 'open' });
});

test('a failing list closes everything (unavailable) and is retried with a growing delay, then recovers', async () => {
  const r = rig();
  const failing = createMcpSiteClient({
    manifest: r.manifest, clock: r.clock, timers: r.timers, onEvent: (e) => r.events.push(e),
    spawn: () => { const link = new FakeConnectorLink(); link.listError = { code: 'init_failed', message: 'server down', definite: true }; r.links.push(link); return link; },
  });
  await failing.start();
  assert.deepEqual(failing.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unavailable' });
  assert.ok(r.events.some((e) => e.type === 'list_failed'));
  const link = r.links[0]!;
  link.listError = null;
  r.timers.advance(1000);
  await flush();
  assert.deepEqual(failing.stateOf(SEARCH_TOOL), { status: 'open' }, 'the next check reopens the tool without any owner action');
});

test('periodic re-check: after the interval the connector is asked again', async () => {
  const r = rig();
  await r.client.start();
  const link = r.links[0]!;
  assert.equal(link.ops.filter((o) => o === 'list').length, 1);
  r.timers.advance(599_999);
  await flush();
  assert.equal(link.ops.filter((o) => o === 'list').length, 1);
  r.timers.advance(1);
  await flush();
  assert.equal(link.ops.filter((o) => o === 'list').length, 2);
});

test('refresh calls are serialized: a second refresh reads the list again after the first (never reuses an older read)', async () => {
  const r = rig();
  await r.client.start();
  const link = r.links[0]!;
  const a = r.client.refresh();
  link.tools[1]!.input_schema = DRIFTED_UPDATE_SCHEMA;
  const b = r.client.refresh();
  await Promise.all([a, b]);
  assert.equal(link.ops.filter((o) => o === 'list').length, 3);
  assert.deepEqual(r.client.stateOf(UPDATE_TOOL), { status: 'closed', reason: 'drift' });
});

test('connector exit: pending calls end as connector_exit (not definite), tools close, and it restarts with 1s, 2s, 4s ... waits; a good list resets the delay', async () => {
  const r = rig();
  await r.client.start();
  const link = r.links[0]!;
  link.onCall = () => undefined;
  const pending = r.client.call('unit_update', { unit_id: 'u', body: 'b' }, { timeoutMs: 20_000 });
  await flush();
  link.die();
  await assert.rejects(pending, (error: unknown) => error instanceof McpTransportError && error.code === 'connector_exit' && error.definite === false);
  assert.deepEqual(r.client.stateOf(UPDATE_TOOL), { status: 'closed', reason: 'unavailable' });
  assert.deepEqual(r.events.filter((e) => e.type === 'connector_exit').map((e) => (e as { restartInMs: number }).restartInMs), [1000]);

  r.timers.advance(999);
  await flush();
  assert.equal(r.links.length, 1, 'not yet');
  r.timers.advance(1);
  await flush();
  assert.equal(r.links.length, 2);
  assert.deepEqual(r.client.stateOf(UPDATE_TOOL), { status: 'open' }, 'the list after the restart decides the states again');

  // 다시 죽어도 성공한 확인 뒤라 대기는 1초로 돌아가 있다
  r.links[1]!.die();
  assert.deepEqual(r.events.filter((e) => e.type === 'connector_exit').map((e) => (e as { restartInMs: number }).restartInMs), [1000, 1000]);
});

test('crash loop backoff doubles up to 60 seconds', async () => {
  const clock = new FakeClock();
  const timers = new ManualGatewayTimers();
  const events: McpSiteEvent[] = [];
  const links: FakeConnectorLink[] = [];
  const client = createMcpSiteClient({
    manifest: manifestOf(stdioSiteRaw('normal', undefined)), clock, timers, onEvent: (e) => events.push(e),
    spawn: () => { const link = new FakeConnectorLink(); link.listError = { code: 'x', message: 'x', definite: true }; links.push(link); return link; },
  });
  await client.start();
  for (let i = 0; i < 9; i += 1) {
    links.at(-1)!.die();
    timers.advance(60_000);
    await flush();
  }
  const delays = events.filter((e) => e.type === 'connector_exit').map((e) => (e as { restartInMs: number }).restartInMs);
  assert.equal(Math.max(...delays), 60_000, 'capped at 60 seconds');
  assert.deepEqual([...delays].sort((a, b) => a - b), delays, 'the wait never shrinks while the failures continue');
  assert.ok(delays[0]! >= 1000 && delays[1]! > delays[0]!);
  await client.close();
});

test('call: a host timer ends a silent connector with timeout (non-definite) and tells the connector to cancel; an aborted signal does the same', async () => {
  const r = rig();
  await r.client.start();
  const link = r.links[0]!;
  link.onCall = () => undefined;
  const pending = r.client.call('units_search', { query: 'a' }, { timeoutMs: 5000 });
  await flush();
  const callId = link.sent.find((m) => m['op'] === 'call')!['id'];
  r.timers.advance(5000);
  await assert.rejects(pending, (error: unknown) => error instanceof McpTransportError && error.code === 'timeout' && error.definite === false);
  assert.deepEqual(link.sent.filter((m) => m['op'] === 'cancel').map((m) => m['target_id']), [callId]);

  const abort = new AbortController();
  const second = r.client.call('units_search', { query: 'b' }, { timeoutMs: 5000, signal: abort.signal });
  await flush();
  abort.abort();
  await assert.rejects(second, (error: unknown) => error instanceof McpTransportError && error.code === 'aborted');
  assert.equal(link.sent.filter((m) => m['op'] === 'cancel').length, 2);
});

test('call: connector-reported errors come back as values; a call while the connector is down is definite and never sent', async () => {
  const r = rig();
  await r.client.start();
  r.links[0]!.onCall = () => ({ ok: false, error: { code: 'undeclared_tool', message: 'no', definite: true } });
  assert.deepEqual(await r.client.call('x', {}, { timeoutMs: 1000 }), { ok: false, error: { code: 'undeclared_tool', message: 'no', definite: true } });
  r.links[0]!.die();
  await assert.rejects(r.client.call('units_search', { query: 'a' }, { timeoutMs: 1000 }), (error: unknown) => error instanceof McpTransportError && error.code === 'connector_unavailable' && error.definite === true);
});

test('rate limit: reads are refused at once over the limit; a send waits (bounded) and gives up when the wait would exceed the bound', async () => {
  const r = rig(stdioSiteRaw('normal', undefined, { rate_limit_per_minute: 2 }));
  await r.client.start(); // 목록 확인(list)은 토큰을 쓰지 않는다
  assert.equal(r.client.tryAcquire(), true);
  assert.equal(r.client.tryAcquire(), true);
  assert.equal(r.client.tryAcquire(), false);
  assert.equal(await r.client.acquireForSend(1000), false, 'the next token is 30s away: bounded wait gives up without waiting');

  const waiting = r.client.acquireForSend(60_000);
  let settled: boolean | null = null;
  void waiting.then((v) => { settled = v; });
  await flush();
  assert.equal(settled, null);
  r.clock.advance(30_000);
  r.timers.advance(30_000);
  await flush();
  assert.equal(settled, true);
  assert.equal(r.client.tryAcquire(), false, 'the token was taken by the send');
});

test('close kills the connector, ends pending calls and stops restarts', async () => {
  const r = rig();
  await r.client.start();
  r.links[0]!.onCall = () => undefined;
  const pending = r.client.call('units_search', { query: 'a' }, { timeoutMs: 5000 });
  await flush();
  await r.client.close();
  await assert.rejects(pending, McpTransportError);
  assert.equal(r.links[0]!.killed, true);
  r.timers.advance(10 * 60_000);
  await flush();
  assert.equal(r.links.length, 1);
});

test('connector stderr is passed on as an event (the daemon masks it before logging)', async () => {
  const r = rig();
  await r.client.start();
  r.links[0]!.stderr('boom');
  assert.ok(r.events.some((e) => e.type === 'connector_stderr' && e.text === 'boom'));
});
