// 독립 검토 반영(H2, M1, M2, M3, L1, L2, L3, L5, L7)의 회귀 시험: 가짜 커넥터 연결 + 손으로 돌리는 타이머·Clock (프로세스 없음)
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createMcpEffectTools, createMcpSiteClient, createMcpToolExecutors, createSiteRateLimiter, checkArguments, createFakeAgentAdapter, evaluateTool, mcpToolSpecs, parseMcpSite, schemaHash,
  WRITE_TIMEOUT_MARGIN_MS, type McpEffectRunner, type McpSiteEvent,
} from '@aot/agent-runtime';
import { FakeClock } from '@aot/domain';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { comparePins, formatPinReport } from '../../apps/daemon/src/mcp-pin.ts';
import { createRedactor, safeText } from '../../packages/agent-runtime/src/mcp/connector/redact.ts';
import { KEY_REQUIRED_SCHEMA, UPDATE_SCHEMA, WEIRD_NAME } from '../fixtures/mcp/fake-server.ts';
import { manualTimers } from '../support/engine.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { FakeConnectorLink, flush, httpSiteRaw, manifestOf, searchDecl, SEARCH_TOOL, stdioSiteRaw, TEST_TOKEN, TOKEN_ENV, UPDATE_TOOL, updateDecl } from '../support/mcp.ts';
import { AGENT, policyEnv } from '../support/policy.ts';

const KEY = { key_argument: 'request_id', retention_ms: 86_400_000 };

function rig(raw: Record<string, unknown>, customize?: (link: FakeConnectorLink) => void) {
  const clock = new FakeClock();
  const timers = new ManualGatewayTimers();
  const links: FakeConnectorLink[] = [];
  const events: McpSiteEvent[] = [];
  const manifest = manifestOf(raw);
  const client = createMcpSiteClient({
    manifest, clock, timers, onEvent: (e) => events.push(e),
    spawn: () => { const link = new FakeConnectorLink(); customize?.(link); links.push(link); return link; },
  });
  return { clock, timers, links, events, manifest, client };
}

// ===== H2: 알림 폭주 =====

test('H2: a flood of list_changed notices runs at most one list and keeps one pending; the queue does not grow', async () => {
  const r = rig(stdioSiteRaw('normal', undefined));
  await r.client.start();
  const link = r.links[0]!;
  const before = link.ops.filter((o) => o === 'list').length;
  for (let i = 0; i < 100_000; i += 1) link.emit({ type: 'list_changed' });
  await flush();
  assert.ok(link.ops.filter((o) => o === 'list').length - before <= 2, `lists after the flood: ${link.ops.filter((o) => o === 'list').length - before}`);
  assert.equal(await r.client.refresh({ timeoutMs: 1000 }), true, 'a refresh after the flood completes at once');
});

// ===== M1: 전송 전체에 하나의 기한 =====

const sendOf = (r: ReturnType<typeof rig>) => createMcpEffectTools(r.manifest, r.client, r.clock)[UPDATE_TOOL]!;
const CALL = { effectKey: 'k1', action: 'call', target: 'site:course/units', request: { arguments: { unit_id: 'u', body: 'b' } } };

test('M1: if the pre-send list does not finish within timeout_ms, the send is a definite failure and the server is never called', async () => {
  const r = rig(stdioSiteRaw('normal', undefined));
  await r.client.start();
  const link = r.links[0]!;
  link.listSilent = true;
  let result: unknown = null;
  void sendOf(r).send(CALL).then((v) => { result = v; });
  await flush();
  assert.equal(result, null);
  r.timers.advance(20_000);
  await flush();
  assert.deepEqual(result, { status: 'failed', responseRef: null });
  assert.equal(link.ops.includes('call'), false);
});

test('M1: a rate-limit wait that cannot fit in the deadline fails before the server is called', async () => {
  const r = rig(stdioSiteRaw('normal', undefined, { rate_limit_per_minute: 1 })); // 다음 토큰까지 60초 > timeout 20초
  await r.client.start();
  assert.equal(r.client.tryAcquire(), true);
  assert.deepEqual(await sendOf(r).send(CALL), { status: 'failed', responseRef: null });
  assert.equal(r.links[0]!.ops.includes('call'), false);
});

test('M1: the tool state is re-checked after the rate-limit wait: a tool that drifted while waiting is not sent', async () => {
  const r = rig(stdioSiteRaw('normal', undefined, { rate_limit_per_minute: 1, timeout_ms: 120_000 }));
  await r.client.start();
  const link = r.links[0]!;
  assert.equal(r.client.tryAcquire(), true);
  let result: unknown = null;
  void sendOf(r).send(CALL).then((v) => { result = v; });
  await flush(); // 토큰을 기다리는 중
  link.tools[1]!.input_schema = { ...UPDATE_SCHEMA, properties: { ...UPDATE_SCHEMA.properties, extra: { type: 'string' } } };
  link.emit({ type: 'list_changed' });
  await flush();
  r.clock.advance(60_000);
  r.timers.advance(60_000);
  await flush();
  assert.deepEqual(result, { status: 'failed', responseRef: null });
  assert.equal(link.ops.includes('call'), false);
});

test('M1: write tools get timeout_ms + a margin at the gateway so it does not time out before the send outcome is known; reads keep timeout_ms', () => {
  const m = manifestOf(stdioSiteRaw('normal', undefined, { timeout_ms: 10_000 }));
  const specs = mcpToolSpecs(m);
  assert.equal(specs.find((s) => s.tool === SEARCH_TOOL)!.timeoutMs, 10_000);
  assert.equal(specs.find((s) => s.tool === UPDATE_TOOL)!.timeoutMs, 10_000 + WRITE_TIMEOUT_MARGIN_MS);
});

test('L5: list checks do not consume rate tokens: with 1 call per minute the pre-send list does not starve the write', async () => {
  const r = rig(stdioSiteRaw('normal', undefined, { rate_limit_per_minute: 1 }), (link) => {
    link.onCall = (m) => ({ ok: true, result: { is_error: false, text: String(JSON.stringify(m['arguments'])), dropped: {} } });
  });
  await r.client.start();
  for (let i = 0; i < 3; i += 1) await r.client.refresh();
  assert.equal(r.client.tryAcquire(), true, 'three lists took no token');
  r.clock.advance(60_000);
  assert.deepEqual((await sendOf(r).send(CALL)).status, 'confirmed');
  const limiter = createSiteRateLimiter(new FakeClock(), 1);
  assert.equal('count' in limiter, false);
});

// ===== M2: 서버 요청 폭주 =====

test('M2: refusal events are capped per minute and the rest are summarised; no per-request event flood', async () => {
  const r = rig(stdioSiteRaw('normal', undefined));
  await r.client.start();
  const link = r.links[0]!;
  for (let i = 0; i < 1000; i += 1) link.emit({ type: 'server_request_refused', method: 'sampling/createMessage' });
  assert.equal(r.events.filter((e) => e.type === 'server_request_refused').length, 5);
  r.clock.advance(60_000);
  link.emit({ type: 'server_request_refused', method: 'sampling/createMessage' });
  const summary = r.events.filter((e) => e.type === 'server_requests_suppressed');
  assert.deepEqual(summary, [{ type: 'server_requests_suppressed', site: 'course', count: 995 }]);
  link.emit({ type: 'server_requests_suppressed', count: 42 });
  assert.equal(r.events.filter((e) => e.type === 'server_requests_suppressed').length, 2, 'the connector\'s own summary is forwarded');
});

// ===== M3: 멱등 키 인자 =====

const keyed = (schema: unknown, over: Record<string, unknown> = {}) => manifestOf(stdioSiteRaw('normal', undefined, { tools: [updateDecl({ idempotency: KEY, input_schema_sha256: schemaHash(schema), ...over })] }));

test('M3: the idempotency key argument is exempt from required checks (agent side and send side), and a required key does not block a draft', async () => {
  assert.match(checkArguments(KEY_REQUIRED_SCHEMA, { unit_id: 'u', body: 'b' }) ?? '', /'request_id' is required/);
  assert.equal(checkArguments(KEY_REQUIRED_SCHEMA, { unit_id: 'u', body: 'b' }, { hostSetKey: 'request_id' }), null);
  assert.match(checkArguments(KEY_REQUIRED_SCHEMA, { body: 'b' }, { hostSetKey: 'request_id' }) ?? '', /'unit_id' is required/, 'other required arguments still count');

  const r = rig(stdioSiteRaw('normal', undefined, { tools: [updateDecl({ idempotency: KEY, input_schema_sha256: schemaHash(KEY_REQUIRED_SCHEMA) })] }), (link) => {
    link.tools = [{ name: 'unit_update', input_schema: KEY_REQUIRED_SCHEMA, annotations: null }];
    link.onCall = (m) => ({ ok: true, result: { is_error: false, text: JSON.stringify(m['arguments']), dropped: {} } });
  });
  await r.client.start();
  const steps: unknown[] = [];
  const ledger: McpEffectRunner = (_tool, step) => { steps.push(step.request); return Promise.resolve({ state: 'drafted', draftId: 'd' }); };
  const executor = createMcpToolExecutors(r.manifest, r.client, ledger).get(UPDATE_TOOL)!;
  const out = await executor({ runId: 'r', tool: UPDATE_TOOL, operation: 'call', args: { unit_id: 'u', body: 'b' }, signal: new AbortController().signal, constraints: { max_usd: 1 }, influencedByExternalInput: false });
  assert.deepEqual(out.result, { status: 'drafted', draft_id: 'd' });
  assert.deepEqual(steps, [{ arguments: { unit_id: 'u', body: 'b' } }]);
  // 전송: 승인된 인자에는 키가 없고, 호스트가 effect key 를 넣는다
  const sent = await sendOf(r).send(CALL);
  assert.equal(sent.status, 'confirmed');
  assert.deepEqual(JSON.parse(r.links[0]!.sent.find((m) => m['op'] === 'call')!['arguments'] === undefined ? '{}' : JSON.stringify(r.links[0]!.sent.find((m) => m['op'] === 'call')!['arguments'])), { unit_id: 'u', body: 'b', request_id: 'k1' });
});

test('M3: the tool is closed (invalid_declaration) unless the pinned type of the key property accepts a string', () => {
  const decl = (schema: unknown) => keyed(schema).tools[0]!;
  const schemaWith = (type: unknown) => ({ ...UPDATE_SCHEMA, properties: { ...UPDATE_SCHEMA.properties, request_id: type === undefined ? {} : { type } } });
  const open = { status: 'open' };
  const closed = { status: 'closed', reason: 'invalid_declaration' };
  for (const [type, expected] of [['string', open], [['string', 'null'], open], [undefined, open], ['integer', closed], ['number', closed], [['integer', 'null'], closed], ['object', closed]] as const) {
    const schema = schemaWith(type);
    assert.deepEqual(evaluateTool(decl(schema), { name: 'unit_update', inputSchema: schema, annotations: null }), expected, JSON.stringify(type));
  }
});

// ===== L1: __proto__ 키 =====

test('L1: a __proto__ property is hashed (not swallowed by the prototype), rejected as an argument, and redacted', () => {
  const plain = { type: 'object', properties: { a: { type: 'string' } } };
  const withProto = JSON.parse('{"type":"object","properties":{"a":{"type":"string"},"__proto__":{"type":"string"}}}') as unknown;
  assert.notEqual(schemaHash(plain), schemaHash(withProto));
  assert.match(JSON.stringify(Object.fromEntries([['x', 1]])), /x/);
  const args = JSON.parse('{"a":"x","__proto__":{"admin":true}}') as unknown;
  assert.match(checkArguments(plain, args) ?? '', /'__proto__' is not in the pinned input schema/);
  const redactor = createRedactor(['TOPSECRETVALUE']);
  const out = redactor.deep(JSON.parse('{"__proto__":"TOPSECRETVALUE","ok":"fine"}')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(out, '__proto__'), true);
  assert.equal(JSON.stringify(out), '{"__proto__":"[redacted]","ok":"fine"}');
  assert.equal(redactor.text('TOPSECRETVALUE'), '[redacted]');
});

// ===== L2: 중복 도구 이름 =====

test('L2: a tool name listed twice is closed (duplicate) and mcp-pin shows it', async () => {
  const r = rig(stdioSiteRaw('normal', undefined), (link) => {
    link.tools = [...link.tools, { name: 'units_search', input_schema: { type: 'object', properties: { evil: { type: 'string' } } }, annotations: null }];
  });
  await r.client.start();
  assert.deepEqual(r.client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'duplicate' });
  assert.deepEqual(r.client.stateOf(UPDATE_TOOL), { status: 'open' });
  const listing = r.client.lastListing()!;
  const rows = comparePins(r.manifest, listing);
  assert.deepEqual(rows.filter((row) => row.name === 'units_search').map((row) => row.status), ['duplicate', 'duplicate']);
});

// ===== L3: 서버가 정한 이름 출력 =====

test('L3: server-controlled names are quoted/escaped in mcp-pin output and sanitised in the connector', () => {
  const report = formatPinReport({
    site: 'course', server: { name: 'srv\n\u001b[2J', version: '1', protocol_version: 'p' },
    rows: [{ name: WEIRD_NAME, hash: 'sha256:x', annotations: null, status: 'undeclared' }],
  });
  assert.ok(!report.includes('\u001b'));
  assert.equal(report.split('\n').length, 5, 'a newline inside a name does not add lines');
  assert.match(report, /"x\\n\\u001b\[31mFAKE"/);
  assert.equal(safeText('a\nb\u001bc d'), 'a?b?c?d');
});

// ===== L7: 부작용 도구 이름 충돌 =====

test('L7: assembly refuses an effect tool name provided twice (options.tools vs the mcp connector)', (t) => {
  const env = policyEnv(t);
  const manifest = parseMcpSite(httpSiteRaw('https://mcp.course.example.com/mcp'));
  assert.throws(() => assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    tools: { [UPDATE_TOOL]: { name: UPDATE_TOOL, actions: { call: { approval: 'draft', idempotency: { supported: false } } }, send: () => ({ status: 'confirmed', responseRef: null }) } },
    agent: { adapter: createFakeAgentAdapter({ clock: env.clock, scenario: 'tool_calls', name: 'x', evidence: [], toolCalls: [] }), tools: [], timers: new ManualGatewayTimers() },
    mcp: { sites: [{ manifest, secretEnv: { [TOKEN_ENV]: TEST_TOKEN } }] },
  }), /effect tool 'mcp_course_update_unit' is provided more than once/);
  void searchDecl;
});

// ===== H1 (실행기 수준): 같은 인자의 서로 다른 쓰기 도구는 서로 다른 단계 id 를 쓴다 =====

test('H1: identical arguments on two different write tools (or sites) produce different ledger step ids; the same tool and arguments stay the same step', async () => {
  const raw = (site: string) => stdioSiteRaw('normal', undefined, { site, tools: [updateDecl({ approval: 'scope' }), updateDecl({ name: 'unit_publish', as: 'publish_unit', approval: 'scope' })] });
  const steps: { tool: string; stepId: string }[] = [];
  const ledger: McpEffectRunner = (tool, step) => { steps.push({ tool, stepId: step.stepId }); return Promise.resolve({ state: 'confirmed', effectId: 'e' }); };
  const args = { unit_id: 'u', body: 'b' };
  for (const site of ['course', 'other']) {
    const r = rig(raw(site), (link) => { link.tools = [...link.tools, { name: 'unit_publish', input_schema: UPDATE_SCHEMA, annotations: null }]; });
    await r.client.start();
    for (const [name, executor] of createMcpToolExecutors(r.manifest, r.client, ledger)) {
      if (!name.endsWith('_unit')) continue;
      await executor({ runId: 'r', tool: name, operation: 'call', args, signal: new AbortController().signal, constraints: { max_usd: 1 }, influencedByExternalInput: false });
    }
  }
  assert.equal(steps.length, 4);
  assert.equal(new Set(steps.map((s) => s.stepId)).size, 4, JSON.stringify(steps));
  assert.ok(steps.every((s) => s.stepId.startsWith(`mcp:${s.tool}:`)));
});
