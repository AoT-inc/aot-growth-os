// ADR-0020 통합: 데몬 조립(정책 게이트 + 승인 엔진 + 업무 엔진 + 평가기 + 에이전트 실행 관리 + 부작용 원장) + 실제 커넥터 프로세스(api 전송) + 가짜 HTTP 서비스.
//   초안 run(서비스 요청 0건) → 사람 승인 → 호스트 전송 run(LLM 0회) → 서비스가 승인된 인자에서 조립된 바이트 그대로 받음. 외부 네트워크 없음.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { buildApiRequest, createFakeAgentAdapter, parseMcpSite, type AgentAdapter, type FakeToolCall, type McpSiteManifest, type ToolCallRecord } from '@aot/agent-runtime';
import { HOST_DISPATCH_ADAPTER, type EffectDraftRow } from '@aot/domain';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { json, startFakeService, type FakeService } from '../fixtures/api/fake-service.ts';
import { API_SECRET_ENV, API_TOKEN, API_WRITE_TOOL, apiSiteRaw, draftPostDecl, POST_ARGS, withPins } from '../support/api.ts';
import { draftsOf } from '../support/drafts.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { evaluationsOf, EXAMPLE_URL, FakeFetcher, validationSpec } from '../support/evaluation.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { AGENT, createWithGate, effectDraft, HOUR, OWNER, policyEnv, type PolicyEnv } from '../support/policy.ts';
import { makeTempDir } from '../support/temp.ts';

interface Rig {
  env: PolicyEnv;
  daemon: ReturnType<typeof assembleDaemon>;
  adapterRuns: { count: number };
  records: ToolCallRecord[];
  manifest: McpSiteManifest;
}

async function rig(t: TestContext, service: FakeService, options: { env?: PolicyEnv; raw?: Record<string, unknown>; calls?: FakeToolCall[]; unpinned?: boolean } = {}): Promise<Rig> {
  const env = options.env ?? policyEnv(t);
  const declared = options.raw ?? apiSiteRaw(service.baseUrl);
  const manifest = parseMcpSite(options.unpinned === true ? declared : withPins(declared));
  const adapterRuns = { count: 0 };
  const records: ToolCallRecord[] = [];
  const calls = options.calls ?? [{ tool: API_WRITE_TOOL, args: { ...POST_ARGS } }];
  const adapter: AgentAdapter = {
    name: 'api-fake',
    run: (input, context) => {
      adapterRuns.count += 1;
      return createFakeAgentAdapter({ clock: env.clock, scenario: 'tool_calls', name: 'api-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }], toolCalls: calls }).run(input, context);
    },
  };
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(makeTempDir(t, 'aot-api-'), 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: 'page' }), evidenceReader: { read: () => Promise.resolve({ readable: false, reason: 'no stored content in this test' }) } },
    agent: { adapter, tools: [], timers: new ManualGatewayTimers(), recorder: { record: (record) => void records.push(record) } },
    mcp: { sites: [{ manifest, secretEnv: API_SECRET_ENV }], timers: new ManualGatewayTimers(), onEvent: () => undefined },
  });
  assert.ok(daemon.mcp !== null);
  await daemon.mcp.start();
  t.after(() => daemon.mcp?.close());
  return { env, daemon, adapterRuns, records, manifest };
}

const apiTask = (r: Rig) => createWithGate(r.env, effectDraft({
  ...validationSpec(['url_reachable', 'no_secret_in_outputs', 'budget']),
  allowed_tools: r.manifest.tools.map((tool) => ({ tool: tool.gatewayName, operations: ['call'], scope: tool.scope, impact: tool.impact, target: tool.target })),
}));

async function draftUntilReview(r: Rig, taskId: string): Promise<void> {
  assert.equal((await r.daemon.worker.tick()).executed?.taskId, taskId);
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

const effectOf = (r: Rig, taskId: string) => r.env.db.get<{ state: string; effect_key: string; response_ref: string | null; supports_idempotency: number }>('SELECT state, effect_key, response_ref, supports_idempotency FROM external_effect WHERE task_id = ?', [taskId])!;

function dumpDatabase(env: PolicyEnv): string {
  const tables = env.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return tables.map((table) => JSON.stringify(env.db.all(`SELECT * FROM "${table.name}"`))).join('\n');
}

test('draft -> approve -> dispatch: nothing is sent before approval; the service gets exactly the bytes assembled from the approved arguments plus the host effect key; the ledger keeps the record fields; no LLM at dispatch; the secret is nowhere', async (t) => {
  const service = await startFakeService(t);
  const r = await rig(t, service);
  const taskId = apiTask(r);

  assert.equal((await r.daemon.worker.tick()).executed?.taskId, taskId);
  assert.equal(service.seen.length, 0, 'the draft run sent nothing');
  assert.equal(r.env.db.get('SELECT count(*) AS n FROM external_effect')?.['n'], 0);
  assert.deepEqual(r.records.map((rec) => [rec.tool, rec.outcome, rec.decision]), [[API_WRITE_TOOL, 'ok', 'require_approval']]);
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['needs_review']);
  const [draft] = draftsOf(r.env.db, taskId) as [EffectDraftRow];
  const payload = JSON.parse(draft.payload) as { arguments: Record<string, unknown>; pin: string };
  assert.deepEqual(payload.arguments, POST_ARGS);
  assert.equal(payload.pin, r.manifest.tools[2]!.inputSchemaSha256, 'the draft carries the declaration pin');
  assert.ok(!draft.payload.includes('effect_key'), 'the draft never holds the host effect key');

  approveAndRelease(r, taskId);
  assert.equal(service.seen.length, 0, 'approval alone sends nothing');

  const dispatched = await r.daemon.worker.tick();
  assert.equal(dispatched.executed?.taskId, taskId);
  assert.equal(r.adapterRuns.count, 1, 'no LLM in the dispatch run');
  assert.deepEqual(r.env.db.all<{ adapter: string }>('SELECT adapter FROM task_run WHERE task_id = ? ORDER BY attempt', [taskId]).map((run) => run.adapter), ['api-fake', HOST_DISPATCH_ADAPTER]);
  assert.equal(service.seen.length, 1);
  const effect = effectOf(r, taskId);
  const expected = buildApiRequest(r.manifest.tools[2]!.api!.op, { ...payload.arguments, effect_key: effect.effect_key }, '');
  assert.equal(service.seen[0]!.body, expected.body, 'byte for byte');
  assert.equal(service.seen[0]!.url, '/repos/aot/aot-web/contents');
  assert.ok(JSON.parse(service.seen[0]!.body).message.endsWith(`effect-key: ${effect.effect_key}`));
  assert.equal(effect.state, 'confirmed');
  assert.match(effect.response_ref ?? '', /^api:web:[0-9a-f]{16} \{"commit":\{"sha":"c0ffee1234"/);
  assert.equal(effect.supports_idempotency, 0);
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['completed']);
  assert.deepEqual(evaluationsOf(r.env.db, taskId).map((e) => e.outcome), ['pass', 'pass']);
  for (let i = 0; i < 2; i += 1) { r.env.clock.advance(HOUR); await r.daemon.worker.tick(); }
  assert.equal(service.seen.length, 1, 'never sent twice');

  assert.ok(!dumpDatabase(r.env).includes(API_TOKEN) && !JSON.stringify(r.records).includes(API_TOKEN) && !JSON.stringify(service.seen[0]).includes('internal.invalid'));
});

test('an agent-supplied effect key, an out-of-pattern argument and a missing argument make no draft and no request', async (t) => {
  const service = await startFakeService(t);
  for (const bad of [{ ...POST_ARGS, effect_key: 'chosen-by-agent' }, { ...POST_ARGS, slug: '../x' }, { ...POST_ARGS, ko_title: 'a\n---\npublished: true' }, { slug: 'only-this' }]) {
    const r = await rig(t, service, { calls: [{ tool: API_WRITE_TOOL, args: bad }] });
    const taskId = apiTask(r);
    await r.daemon.worker.tick();
    assert.deepEqual(r.records.map((rec) => rec.outcome), ['tool_error']);
    assert.equal(draftsOf(r.env.db, taskId).length, 0);
  }
  assert.equal(service.seen.length, 0);
});

test('a declaration changed after approval (even re-pinned) is not sent: the draft pin no longer matches, the effect fails and the service sees nothing', async (t) => {
  const service = await startFakeService(t);
  const first = await rig(t, service);
  const taskId = apiTask(first);
  await draftUntilReview(first, taskId);
  approveAndRelease(first, taskId);
  await first.daemon.mcp!.close();

  const edited = apiSiteRaw(service.baseUrl, { tools: [(apiSiteRaw(service.baseUrl)['tools'] as Record<string, unknown>[])[0], (apiSiteRaw(service.baseUrl)['tools'] as Record<string, unknown>[])[1], draftPostDecl({
    request: { ...(draftPostDecl()['request'] as object), path: '/repos/aot/other/contents' },
  })] });
  const second = await rig(t, service, { env: first.env, raw: edited });
  assert.notEqual(second.manifest.tools[2]!.inputSchemaSha256, first.manifest.tools[2]!.inputSchemaSha256);
  await second.daemon.worker.tick();
  assert.equal(service.seen.length, 0);
  assert.equal(effectOf(second, taskId).state, 'failed');
});

test('a 5xx answer is unknown and never re-sent; a 4xx answer is failed', async (t) => {
  for (const [status, state] of [[503, 'unknown'], [409, 'failed']] as const) {
    const service = await startFakeService(t, '', (_s, res) => json(res, status, {}));
    const r = await rig(t, service);
    const taskId = apiTask(r);
    await draftUntilReview(r, taskId);
    approveAndRelease(r, taskId);
    await r.daemon.worker.tick();
    assert.equal(effectOf(r, taskId).state, state, String(status));
    for (let i = 0; i < 3; i += 1) { r.env.clock.advance(HOUR); await r.daemon.worker.tick(); }
    assert.equal(service.seen.length, 1, `${status}: one request in total`);
  }
});

test('closed by drift (no pin yet): the tool is closed, the agent cannot draft with it, and the service sees nothing', async (t) => {
  const service = await startFakeService(t);
  const r = await rig(t, service, { unpinned: true });
  assert.deepEqual(r.daemon.mcp!.sites.get('web')!.stateOf(API_WRITE_TOOL), { status: 'closed', reason: 'drift' });
  const taskId = apiTask(r);
  await r.daemon.worker.tick();
  assert.deepEqual(r.records.map((rec) => rec.outcome), ['tool_error']);
  assert.equal(draftsOf(r.env.db, taskId).length, 0);
  assert.equal(service.seen.length, 0);
});
