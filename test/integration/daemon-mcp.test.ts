// ADR-0018 통합: 데몬 조립(실제 정책 게이트 + 승인 엔진 + 업무 엔진 + 평가기 + 에이전트 실행 관리 + 부작용 원장) + 실제 커넥터 프로세스 + 가짜 MCP 서버.
//   초안 run(서버 호출 0회) → needs_review + 초안 → 사람 승인(해시, cooldown, TOTP) → 호스트 전송 run(LLM 0회) → 서버가 승인된 인자 바이트 그대로 받음
// 멱등 키 주입, 지시 주입 표시, 전송 직전 스키마 확인, 전송 중 서버 크래시·시간 초과의 unknown(재전송 없음), 비밀값이 DB·기록에 없음. 외부 네트워크 없음.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createFakeAgentAdapter, type AgentAdapter, type FakeToolCall, type ToolCallRecord } from '@aot/agent-runtime';
import { canonicalJson, HOST_DISPATCH_ADAPTER, type EffectDraftRow } from '@aot/domain';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { parseMcpSite } from '@aot/agent-runtime';
import type { Scenario } from '../fixtures/mcp/fake-server.ts';
import { draftsOf } from '../support/drafts.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { evaluationsOf, EXAMPLE_URL, FakeFetcher, validationSpec } from '../support/evaluation.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { callsTo, readRecords, SEARCH_TOOL, searchDecl, SECRET_ENV, stdioSiteRaw, TEST_TOKEN, UPDATE_TOOL, updateDecl, waitFor } from '../support/mcp.ts';
import { AGENT, createWithGate, effectDraft, HOUR, OWNER, policyEnv, type PolicyEnv } from '../support/policy.ts';
import { makeTempDir } from '../support/temp.ts';

const ARGS = { unit_id: 'u1', body: 'new body' } as const;

interface Rig {
  env: PolicyEnv;
  daemon: ReturnType<typeof assembleDaemon>;
  adapterRuns: { count: number };
  records: ToolCallRecord[];
  recordPath: string;
  siteTimers: ManualGatewayTimers;
}

async function rig(t: TestContext, options: { scenario?: Scenario; calls?: FakeToolCall[]; idempotent?: boolean; timeoutMs?: number } = {}): Promise<Rig> {
  const env = policyEnv(t);
  const recordPath = join(makeTempDir(t, 'aot-mcp-'), 'requests.jsonl');
  const scenario = options.scenario ?? 'normal';
  const calls = options.calls ?? [{ tool: UPDATE_TOOL, args: { ...ARGS } }];
  const manifest = parseMcpSite(stdioSiteRaw(scenario, recordPath, {
    ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
    tools: [searchDecl(), updateDecl(options.idempotent === true ? { idempotency: { key_argument: 'request_id', retention_ms: 86_400_000 } } : {})],
  }));
  const adapterRuns = { count: 0 };
  const records: ToolCallRecord[] = [];
  const adapter: AgentAdapter = {
    name: 'mcp-fake',
    run: (input, context) => {
      adapterRuns.count += 1;
      return createFakeAgentAdapter({ clock: env.clock, scenario: 'tool_calls', name: 'mcp-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }], toolCalls: calls }).run(input, context);
    },
  };
  const siteTimers = new ManualGatewayTimers();
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: 'page' }), evidenceReader: { read: () => Promise.resolve({ readable: false, reason: 'no stored content in this test' }) } },
    agent: { adapter, tools: [], timers: new ManualGatewayTimers(), recorder: { record: (record) => void records.push(record) } },
    mcp: { sites: [{ manifest, secretEnv: SECRET_ENV }], timers: siteTimers, onEvent: () => undefined },
  });
  assert.ok(daemon.mcp !== null);
  await daemon.mcp.start();
  t.after(() => daemon.mcp?.close());
  return { env, daemon, adapterRuns, records, recordPath, siteTimers };
}

const mcpTask = (r: Rig) => createWithGate(r.env, effectDraft({
  ...validationSpec(['url_reachable', 'no_secret_in_outputs', 'budget']),
  allowed_tools: [
    { tool: SEARCH_TOOL, operations: ['call'], scope: 'internal', impact: 'read', target: 'site:course/units' },
    { tool: UPDATE_TOOL, operations: ['call'], scope: 'customer', impact: 'external_effect', target: 'site:course/units' },
  ],
}));

async function draftUntilReview(r: Rig, taskId: string): Promise<void> {
  const drafted = await r.daemon.worker.tick();
  assert.equal(drafted.executed?.taskId, taskId);
  assert.equal(taskStatus(r.env.db, taskId), 'validating');
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['needs_review']);
}

const show = (r: Rig, taskId: string) => r.env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });

function approveAndRelease(r: Rig, taskId: string): void {
  const hash = String(show(r, taskId)['hash']);
  assert.equal(r.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash })['state'], 'cooldown');
  r.env.clock.advance(HOUR);
  assert.deepEqual(r.env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: r.env.code() }), { ok: true, state: 'queued' });
}

const effectOf = (r: Rig, taskId: string) => r.env.db.get<{ state: string; effect_key: string; request_hash: string; supports_idempotency: number }>('SELECT state, effect_key, request_hash, supports_idempotency FROM external_effect WHERE task_id = ?', [taskId])!;

/** DB 의 모든 표를 문자열로 모아 비밀값이 어디에도 없는지 본다 */
function dumpDatabase(env: PolicyEnv): string {
  const tables = env.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return tables.map((table) => JSON.stringify(env.db.all(`SELECT * FROM "${table.name}"`))).join('\n');
}

test('draft -> approve -> dispatch: the draft run sends nothing; the server receives exactly the approved argument bytes; no LLM in the dispatch run; the secret is nowhere in the DB or records', async (t) => {
  const r = await rig(t);
  const taskId = mcpTask(r);

  const drafted = await r.daemon.worker.tick();
  assert.equal(drafted.executed?.taskId, taskId);
  assert.equal(r.adapterRuns.count, 1);
  assert.equal(callsTo(r.recordPath).length, 0, 'the draft run sent nothing to the server');
  assert.equal(r.env.db.get('SELECT count(*) AS n FROM external_effect')?.['n'], 0);
  assert.deepEqual(r.records.map((rec) => [rec.tool, rec.outcome, rec.decision]), [[UPDATE_TOOL, 'ok', 'require_approval']]);
  assert.deepEqual(draftsOf(r.env.db, taskId).map((d) => d.state), ['pending']);

  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['needs_review']);
  const [draft] = draftsOf(r.env.db, taskId) as [EffectDraftRow];
  assert.equal(draft.tool, UPDATE_TOOL);
  assert.equal(draft.action, 'call');
  assert.equal(draft.target, 'site:course/units');
  assert.deepEqual(JSON.parse(draft.payload), { arguments: ARGS }, 'the draft holds the exact arguments (and nothing the host adds)');
  const shown = show(r, taskId);
  assert.deepEqual((shown['drafts'] as { payload: unknown }[])[0]!.payload, { arguments: ARGS });

  approveAndRelease(r, taskId);
  assert.equal(callsTo(r.recordPath).length, 0, 'approval alone sends nothing');

  const dispatched = await r.daemon.worker.tick();
  assert.equal(dispatched.executed?.taskId, taskId);
  assert.equal(r.adapterRuns.count, 1, 'no LLM in the dispatch run');
  const received = callsTo(r.recordPath, 'unit_update');
  assert.equal(received.length, 1);
  assert.deepEqual((received[0]!.params as { arguments: unknown }).arguments, ARGS);
  assert.ok(received[0]!.raw.includes(`"arguments":${JSON.stringify(JSON.parse(draft.payload).arguments)}`), 'byte for byte: the argument bytes on the wire are the approved bytes');
  assert.deepEqual(r.env.db.all<{ adapter: string }>('SELECT adapter FROM task_run WHERE task_id = ? ORDER BY attempt', [taskId]).map((run) => run.adapter), ['mcp-fake', HOST_DISPATCH_ADAPTER]);
  const effect = effectOf(r, taskId);
  assert.equal(effect.state, 'confirmed');
  assert.equal(effect.request_hash, draft.payload_hash);
  assert.equal(effect.supports_idempotency, 0);

  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['completed']);
  assert.deepEqual(evaluationsOf(r.env.db, taskId).map((e) => e.outcome), ['pass', 'pass']);

  // 비밀값은 어디에도 없다
  assert.ok(!dumpDatabase(r.env).includes(TEST_TOKEN));
  assert.ok(!JSON.stringify([r.records, received]).includes(TEST_TOKEN));
});

test('idempotency key: the host injects the effect key at send only; the draft never holds it; an agent-supplied key is refused and no draft exists', async (t) => {
  const r = await rig(t, { idempotent: true });
  const taskId = mcpTask(r);
  await draftUntilReview(r, taskId);
  const [draft] = draftsOf(r.env.db, taskId) as [EffectDraftRow];
  assert.ok(!draft.payload.includes('request_id'));
  approveAndRelease(r, taskId);
  await r.daemon.worker.tick();
  const [received] = callsTo(r.recordPath, 'unit_update');
  const args = (received!.params as { arguments: Record<string, unknown> }).arguments;
  assert.equal(args['request_id'], draft.effect_key);
  const withoutKey = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'request_id'));
  assert.equal(canonicalJson(withoutKey), canonicalJson(JSON.parse(draft.payload).arguments), 'approved arguments + one host-set key');
  const effect = effectOf(r, taskId);
  assert.deepEqual([effect.state, effect.supports_idempotency], ['confirmed', 1]);

  const bad = await rig(t, { idempotent: true, calls: [{ tool: UPDATE_TOOL, args: { ...ARGS, request_id: 'agent-chose-this' } }] });
  const badTask = mcpTask(bad);
  await bad.daemon.worker.tick();
  assert.deepEqual(bad.records.map((rec) => rec.outcome), ['tool_error']);
  assert.equal(draftsOf(bad.env.db, badTask).length, 0);
  assert.equal(callsTo(bad.recordPath).length, 0);
});

test('an injected instruction in a read result marks the later draft as influenced_by_external_input (still draftable; a person decides)', async (t) => {
  const r = await rig(t, { scenario: 'injects', calls: [{ tool: SEARCH_TOOL, args: { query: 'x' } }, { tool: UPDATE_TOOL, args: { ...ARGS } }] });
  const taskId = mcpTask(r);
  await draftUntilReview(r, taskId);
  assert.deepEqual(r.records.map((rec) => [rec.tool, rec.outcome, rec.influenced_by_external_input]), [[SEARCH_TOOL, 'ok', false], [UPDATE_TOOL, 'ok', true]]);
  const [draft] = draftsOf(r.env.db, taskId) as [EffectDraftRow];
  assert.equal(draft.influenced_by_external_input, 1);
  assert.equal((show(r, taskId)['drafts'] as { influenced_by_external_input: boolean }[])[0]!.influenced_by_external_input, true);
});

test('schema drift between approval and send: the pre-send re-check closes the tool, the effect fails, and the server gets zero calls', async (t) => {
  const r = await rig(t, { scenario: 'drifts_silently' });
  const taskId = mcpTask(r);
  await draftUntilReview(r, taskId);
  approveAndRelease(r, taskId);
  await r.daemon.worker.tick();
  assert.equal(callsTo(r.recordPath).length, 0, 'the server never received the write');
  assert.equal(effectOf(r, taskId).state, 'failed');
  assert.deepEqual(r.daemon.mcp!.sites.get('course')!.stateOf(UPDATE_TOOL), { status: 'closed', reason: 'drift' });
});

test('a server crash during the send is recorded as unknown and the write is never sent again', async (t) => {
  const r = await rig(t, { scenario: 'crash_on_call' });
  const taskId = mcpTask(r);
  await draftUntilReview(r, taskId);
  approveAndRelease(r, taskId);
  await r.daemon.worker.tick();
  assert.equal(callsTo(r.recordPath, 'unit_update').length, 1);
  assert.equal(effectOf(r, taskId).state, 'unknown');
  for (let i = 0; i < 3; i += 1) {
    r.env.clock.advance(HOUR);
    await r.daemon.worker.tick();
  }
  assert.equal(callsTo(r.recordPath, 'unit_update').length, 1, 'no automatic re-send (no idempotency key declared)');
  assert.equal(effectOf(r, taskId).state, 'unknown');
});

test('a send that gets no answer within timeout_ms is unknown, the server is told to cancel, and nothing is re-sent', async (t) => {
  const r = await rig(t, { scenario: 'hangs', timeoutMs: 5000 });
  const taskId = mcpTask(r);
  await draftUntilReview(r, taskId);
  approveAndRelease(r, taskId);
  const dispatching = r.daemon.worker.tick();
  await waitFor(() => callsTo(r.recordPath, 'unit_update').length === 1);
  r.siteTimers.advance(5000);
  await dispatching;
  assert.equal(effectOf(r, taskId).state, 'unknown');
  await waitFor(() => readRecords(r.recordPath).some((rec) => rec.method === 'notifications/cancelled'));
  assert.equal(callsTo(r.recordPath, 'unit_update').length, 1);
});

test('only declared tools exist: the worker tools contain the owner-declared write tool, and the agent run offers tools only when the spec asks for them', async (t) => {
  const r = await rig(t);
  assert.deepEqual(Object.keys(r.daemon.mcp!.effectTools), [UPDATE_TOOL]);
  assert.deepEqual(r.daemon.mcp!.toolSpecs.map((s) => s.tool), [SEARCH_TOOL, UPDATE_TOOL]);
  assert.ok(r.daemon.mcp!.toolSpecs.every((s) => s.resultOrigin === 'external_untrusted' && s.operation === 'call'));
  // 명세가 MCP 도구를 요청하지 않으면 에이전트에 하나도 열리지 않는다
  const taskId = createWithGate(r.env, effectDraft({ ...validationSpec(['url_reachable', 'no_secret_in_outputs', 'budget']), allowed_tools: [{ tool: 'web_search', operations: ['search'], scope: 'internal', impact: 'read' }] }));
  await r.daemon.worker.tick();
  assert.deepEqual(r.records.map((rec) => rec.outcome), ['tool_not_allowed']);
  assert.equal(draftsOf(r.env.db, taskId).length, 0);
});
