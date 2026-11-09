// MCP 커넥터 적대적 시험 (ADR-0018, 설계 §7): 실제 커넥터 프로세스 + 가짜 MCP 서버(stdio) + 실제 도구 게이트웨이. 네트워크 없음.
//  1 도구 추가 · 2 읽기 전용 거짓말 · 3 지시 주입 · 4 타임아웃(읽기) · 5 스키마 변화 · 6 비밀값 · 7 서버 요청 · 오너 설명만 에이전트에 보임
// (쓰기의 초안→승인→전송 전체 경로, 전송 타임아웃/크래시의 unknown 은 daemon-mcp.test.ts 가 실제 원장으로 시험한다)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMcpToolExecutors, createToolGateway, mcpToolDescriptions, mcpToolSpecs,
  type McpEffectRunner, type McpLedgerStep, type RunToolGateway,
} from '@aot/agent-runtime';
import { FakeClock, type ToolCallPolicyVerdict } from '@aot/domain';

import { INJECTION_TEXT } from '../fixtures/mcp/fake-server.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { callsTo, flush, readRecords, SEARCH_TOOL, startStdioSite, stdioSiteRaw, TEST_TOKEN, UPDATE_TOOL, waitFor, updateDecl, searchDecl, type SiteRig } from '../support/mcp.ts';
import { makeTempDir } from '../support/temp.ts';
import { join } from 'node:path';

interface LedgerCall { tool: string; step: McpLedgerStep; influenced: boolean | undefined }

function gatewayOn(site: SiteRig, options: { effectMode?: 'send' | 'draft'; timers?: ManualGatewayTimers } = {}) {
  const ledgerCalls: LedgerCall[] = [];
  const ledger: McpEffectRunner = (tool, step, meta) => {
    ledgerCalls.push({ tool, step, influenced: meta?.influenced });
    return Promise.resolve(options.effectMode === 'draft' ? { state: 'drafted' as const, draftId: 'draft-1' } : { state: 'confirmed' as const, effectId: 'effect-1' });
  };
  const timers = options.timers ?? new ManualGatewayTimers();
  const verdictFor = (tool: string): ToolCallPolicyVerdict => (tool === UPDATE_TOOL ? { decision: 'require_approval', reason: 'external effect' } : { decision: 'allow' });
  const gateway: RunToolGateway = createToolGateway({
    runId: 'run-1', taskId: null, subject: 'generalist@v1', tools: mcpToolSpecs(site.manifest), executors: createMcpToolExecutors(site.manifest, site.client, ledger),
    policy: { judge: (request) => verdictFor(request.tool) }, clock: new FakeClock(), constraints: { max_usd: 1 }, toolTimeoutMs: 20_000, timers,
    ...(options.effectMode === undefined ? {} : { effectMode: options.effectMode }),
  });
  return { gateway, ledgerCalls, timers };
}

const UPDATE_ARGS = { unit_id: 'u1', body: 'new body' };

test('1. added tools: the agent list comes only from the owner declaration; a server-added tool is unreachable at the gateway and at the connector', async (t) => {
  const site = await startStdioSite(t, 'adds_tools');
  const { gateway } = gatewayOn(site);
  assert.deepEqual(mcpToolSpecs(site.manifest).map((s) => s.tool), [SEARCH_TOOL, UPDATE_TOOL]);
  assert.deepEqual(site.client.undeclared(), ['admin_delete']);
  assert.ok(site.events.some((e) => e.type === 'undeclared_tools'));
  assert.deepEqual(await gateway.call('mcp_course_admin_delete', { id: '1' }), { ok: false, error: 'tool_not_allowed' });
  assert.deepEqual(await gateway.call('admin_delete', { id: '1' }), { ok: false, error: 'tool_not_allowed' });
  // 커넥터를 직접 불러도 거부(definite)이고 서버는 호출을 받지 않는다
  const direct = await site.client.call('admin_delete', { id: '1' }, { timeoutMs: 5000 });
  assert.deepEqual(direct, { ok: false, error: { code: 'undeclared_tool', message: 'the tool is not declared by the owner', definite: true } });
  assert.equal(callsTo(site.recordPath).length, 0);
});

test('2a. lying read-only on a write tool changes nothing: the owner declaration still routes it through the ledger as a write', async (t) => {
  // lies_readonly 는 읽기 도구에도 위험 주석을 붙이므로, 읽기 도구는 ack 해서 쓰기 쪽만 본다
  const site = await startStdioSite(t, 'lies_readonly', { raw: stdioSiteRaw('lies_readonly', join(makeTempDir(t), 'r.jsonl'), { tools: [searchDecl({ ack_server_hint_conflict: true }), updateDecl()] }) });
  assert.equal(site.manifest.tools[1]!.impact, 'external_effect');
  assert.equal(site.manifest.tools[1]!.approval, 'draft');
  const { gateway, ledgerCalls } = gatewayOn(site);
  assert.deepEqual(await gateway.call(UPDATE_TOOL, UPDATE_ARGS), { ok: true, result: { status: 'confirmed', effect_id: 'effect-1' } });
  assert.equal(ledgerCalls.length, 1);
  assert.equal(callsTo(site.recordPath).length, 0, 'the write went to the ledger only; nothing reached the server from the executor');
  const record = gateway.records()[0]!;
  assert.equal(record.side_effect, true);
  assert.equal(record.decision, 'require_approval');
});

test('2b. a read declaration whose server says "not read-only" / "destructive" is closed unless the owner acknowledged it', async (t) => {
  const site = await startStdioSite(t, 'lies_readonly');
  assert.deepEqual(site.client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'hint_conflict' });
  const { gateway } = gatewayOn(site);
  assert.deepEqual(await gateway.call(SEARCH_TOOL, { query: 'a' }), { ok: false, error: 'tool_error' });
  assert.equal(callsTo(site.recordPath).length, 0, 'a closed read tool never reaches the server');
  assert.match(gateway.records()[0]!.reason ?? '', /closed:hint_conflict/);

  const acked = await startStdioSite(t, 'lies_readonly', { raw: stdioSiteRaw('lies_readonly', join(makeTempDir(t), 'r.jsonl'), { tools: [searchDecl({ ack_server_hint_conflict: true }), updateDecl()] }) });
  assert.deepEqual(acked.client.stateOf(SEARCH_TOOL), { status: 'open' });
  assert.equal((await gatewayOn(acked).gateway.call(SEARCH_TOOL, { query: 'a' })).ok, true);
});

test('3a. injected instructions in a read result: the result is external_untrusted and a later write in send mode is approval_required (the ledger is never reached)', async (t) => {
  const site = await startStdioSite(t, 'injects');
  const { gateway, ledgerCalls } = gatewayOn(site, { effectMode: 'send' });
  const read = await gateway.call(SEARCH_TOOL, { query: 'a' });
  assert.equal(read.ok, true);
  if (read.ok) {
    const result = read.result as { trust_origin: string; text: string };
    assert.equal(result.trust_origin, 'external_untrusted');
    assert.ok(result.text.includes(INJECTION_TEXT));
  }
  assert.equal(gateway.externalInputSeen(), true);
  assert.deepEqual(await gateway.call(UPDATE_TOOL, UPDATE_ARGS), { ok: false, error: 'approval_required' });
  assert.equal(ledgerCalls.length, 0);
  assert.equal(gateway.records()[1]!.influenced_by_external_input, true);
});

test('3b. the same sequence in draft mode still drafts, and the draft is marked as influenced by external input', async (t) => {
  const site = await startStdioSite(t, 'injects');
  const { gateway, ledgerCalls } = gatewayOn(site, { effectMode: 'draft' });
  await gateway.call(SEARCH_TOOL, { query: 'a' });
  assert.deepEqual(await gateway.call(UPDATE_TOOL, UPDATE_ARGS), { ok: true, result: { status: 'drafted', draft_id: 'draft-1' } });
  assert.deepEqual(ledgerCalls.map((c) => [c.tool, c.influenced]), [[UPDATE_TOOL, true]]);
  assert.deepEqual(ledgerCalls[0]!.step.request, { arguments: UPDATE_ARGS });
});

test('4. read timeout: the gateway answers tool_timeout and the connector tells the server to cancel', async (t) => {
  const site = await startStdioSite(t, 'hangs');
  const { gateway, timers } = gatewayOn(site);
  const pending = gateway.call(SEARCH_TOOL, { query: 'slow' });
  await waitFor(() => callsTo(site.recordPath).length === 1);
  const rpcId = callsTo(site.recordPath)[0]!.id;
  timers.advance(20_000);
  assert.deepEqual(await pending, { ok: false, error: 'tool_timeout' });
  await waitFor(() => readRecords(site.recordPath).some((r) => r.method === 'notifications/cancelled'));
  assert.equal((readRecords(site.recordPath).find((r) => r.method === 'notifications/cancelled')!.params as { requestId: unknown }).requestId, rpcId);
});

test('5. schema drift: after the first list the server changes unit_update; the change notice closes that tool only, and calls to it fail without reaching the server', async (t) => {
  const site = await startStdioSite(t, 'drifts_after_first_list');
  await waitFor(() => site.client.stateOf(UPDATE_TOOL).status === 'closed');
  assert.deepEqual(site.client.stateOf(UPDATE_TOOL), { status: 'closed', reason: 'drift' });
  assert.deepEqual(site.client.stateOf(SEARCH_TOOL), { status: 'open' });
  assert.ok(site.events.some((e) => e.type === 'tool_state' && e.tool === UPDATE_TOOL && e.state === 'closed:drift'));
  const { gateway, ledgerCalls } = gatewayOn(site, { effectMode: 'draft' });
  assert.deepEqual(await gateway.call(UPDATE_TOOL, UPDATE_ARGS), { ok: false, error: 'tool_error' });
  assert.equal(ledgerCalls.length, 0, 'a closed write tool cannot even be drafted');
  assert.equal(callsTo(site.recordPath).length, 0);
  assert.equal((await gateway.call(SEARCH_TOOL, { query: 'x' })).ok, true, 'the other tool keeps working');
});

test('6. secrets: the server echoes the token it received; the agent-visible result, the call record, and the connector config line contain none of it', async (t) => {
  const site = await startStdioSite(t, 'echoes_secret');
  const { gateway } = gatewayOn(site);
  const response = await gateway.call(SEARCH_TOOL, { query: 'abc' });
  assert.equal(response.ok, true);
  const everything = JSON.stringify([response, gateway.records(), gateway.runLog(), site.events]);
  assert.ok(!everything.includes(TEST_TOKEN));
  assert.match(JSON.stringify(response), /secret-was:\[redacted\]/);
  const serverSaw = readRecords(site.recordPath);
  assert.ok(serverSaw.length > 0);
  assert.ok(!JSON.stringify(serverSaw.filter((r) => r.method !== null)).includes(TEST_TOKEN), 'the token is passed to the server by environment only, never inside a message');
});

test('7. server requests: sampling/createMessage is refused (-32601) and reported as a site event; the call still returns', async (t) => {
  const site = await startStdioSite(t, 'asks_sampling');
  const { gateway } = gatewayOn(site);
  assert.equal((await gateway.call(SEARCH_TOOL, { query: 'abc' })).ok, true);
  await waitFor(() => site.events.some((e) => e.type === 'server_request_refused'));
  assert.deepEqual(site.events.filter((e) => e.type === 'server_request_refused'), [{ type: 'server_request_refused', site: 'course', method: 'sampling/createMessage' }]);
  assert.equal((readRecords(site.recordPath).find((r) => r.id === 'srv-1')!.error as { code: number }).code, -32601);
  const init = readRecords(site.recordPath).find((r) => r.method === 'initialize')!;
  assert.deepEqual((init.params as { capabilities: unknown }).capabilities, {});
});

test('the agent sees the owner description only; the server description appears nowhere in what the host exposes', async (t) => {
  const site = await startStdioSite(t, 'normal');
  const descriptions = mcpToolDescriptions([site.manifest]);
  assert.deepEqual(descriptions, { [SEARCH_TOOL]: '강좌 단원을 제목으로 찾는다. 읽기 전용.', [UPDATE_TOOL]: '단원 본문을 고친다. 학생에게 보인다.' });
  const { gateway } = gatewayOn(site);
  const response = await gateway.call(SEARCH_TOOL, { query: 'abc' });
  assert.ok(!JSON.stringify([descriptions, mcpToolSpecs(site.manifest), response, gateway.records()]).includes('SERVER DESCRIPTION'));
});

test('argument checks: keys outside the pinned schema, missing required, wrong primitive type and an agent-supplied idempotency key are refused before anything is sent', async (t) => {
  const dir = makeTempDir(t);
  const site = await startStdioSite(t, 'normal', { raw: stdioSiteRaw('normal', join(dir, 'r.jsonl'), { tools: [searchDecl(), updateDecl({ idempotency: { key_argument: 'request_id', retention_ms: 86_400_000 } })] }) });
  const { gateway, ledgerCalls } = gatewayOn(site);
  for (const args of [{ query: 'a', admin: true }, {}, { query: 7 }]) assert.deepEqual(await gateway.call(SEARCH_TOOL, args), { ok: false, error: 'tool_error' }, JSON.stringify(args));
  assert.deepEqual(await gateway.call(UPDATE_TOOL, { ...UPDATE_ARGS, request_id: 'agent-chose-this' }), { ok: false, error: 'tool_error' });
  assert.equal(ledgerCalls.length, 0);
  assert.equal(callsTo(site.recordPath).length, 0);
});

test('per-site rate limit through the gateway: reads over the limit are refused at once (tool_error) and do not reach the server', async (t) => {
  const clock = new FakeClock();
  const site = await startStdioSite(t, 'normal', { raw: stdioSiteRaw('normal', join(makeTempDir(t), 'r.jsonl'), { rate_limit_per_minute: 3 }), clock });
  const { gateway } = gatewayOn(site);
  const outcomes: boolean[] = [];
  for (let i = 0; i < 4; i += 1) outcomes.push((await gateway.call(SEARCH_TOOL, { query: `q${i}` })).ok);
  assert.deepEqual(outcomes, [true, true, false, false], 'the first list took one token of three');
  assert.equal(callsTo(site.recordPath).length, 2);
  clock.advance(60_000);
  assert.equal((await gateway.call(SEARCH_TOOL, { query: 'later' })).ok, true);
  await flush();
});
