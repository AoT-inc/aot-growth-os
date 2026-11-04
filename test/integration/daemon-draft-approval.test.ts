// ADR-0015 통합: 데몬 조립(실제 정책 게이트 + 승인 엔진 + 업무 엔진 + 평가기 + 에이전트 실행 관리)에서 초안 먼저 → 사람 승인 → 호스트 전송.
//   초안 run (도구 send 0회) → 검증기 → needs_review + proposed 초안 → show 로 초안 확인 → approve(show 의 해시) → (위험 변경: cooldown + TOTP release)
//   → 전송 run (adapter host:dispatch, 에이전트·LLM 호출 0회) → 가짜 도구가 초안의 payload 를 바이트 그대로 받음 → 전송 프로필 검증 → completed
// 거절, 변경 요청(새 초안 run), 만료, 승인 뒤 초안 변조, 외부 입력 영향 초안, 초안 없는 업무(범위 승인)의 기존 동작도 함께 본다. 외부 접근은 없다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createFakeAgentAdapter, type AgentAdapter, type FakeToolCall, type JsonObject, type ToolCallRecord, type ToolExecutor } from '@aot/agent-runtime';
import { canonicalJson, HOST_DISPATCH_ADAPTER, sha256Hex, type EffectDraftRow } from '@aot/domain';
import { effectKeyOf } from '@aot/task-engine';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { draftsOf } from '../support/drafts.ts';
import { manualTimers, runsOf, taskStatus } from '../support/engine.ts';
import { evaluationsOf, EXAMPLE_URL, FakeFetcher, validationSpec } from '../support/evaluation.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import {
  createFakeMessageTool, examplePayload, MESSAGE_GATEWAY_SPEC, messageExecutorFor, MESSAGE_TOOL, type FakeMessageTool, type MessagePayload,
} from '../support/message-tool.ts';
import { AGENT, createWithGate, deployDirect, effectDraft, HOUR, OWNER, policyEnv, policyText, readOnlyDraft, taskRow, type PolicyEnv } from '../support/policy.ts';

const SEARCH = { tool: 'web_search', operation: 'search', scope: 'internal', sideEffect: false, resultOrigin: 'external_untrusted' } as const;

interface Rig {
  env: PolicyEnv;
  fake: FakeMessageTool;
  daemon: ReturnType<typeof assembleDaemon>;
  /** 에이전트 어댑터가 시작된 횟수 (전송 run 에서는 늘지 않는다) */
  adapterRuns: { count: number };
  records: ToolCallRecord[];
}

/** `message(n)`: n 번째 어댑터 실행이 보내려는 메시지. `searchFirst`: 외부 출처 도구를 먼저 불러 이후 호출이 외부 입력 영향 호출이 되게 한다 */
function rig(t: TestContext, options: { message?: (run: number) => MessagePayload; searchFirst?: boolean; approval?: 'draft' | 'scope'; ttlMs?: number } = {}): Rig {
  const env = policyEnv(t);
  const fake = createFakeMessageTool({ ...(options.approval === undefined ? {} : { approval: options.approval }) });
  const adapterRuns = { count: 0 };
  const records: ToolCallRecord[] = [];
  const message = options.message ?? ((run: number) => examplePayload({ subject: `Hello ${run}` }));
  const make = (): AgentAdapter => {
    const base = (run: number) => createFakeAgentAdapter({
      clock: env.clock, scenario: 'tool_calls', name: 'draft-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }],
      toolCalls: [
        ...(options.searchFirst === true ? [{ tool: 'web_search', args: { q: 'example' } } satisfies FakeToolCall] : []),
        { tool: MESSAGE_TOOL, args: message(run) as unknown as JsonObject },
      ],
    });
    return { name: 'draft-fake', run: (input, context) => { adapterRuns.count += 1; return base(adapterRuns.count).run(input, context); } };
  };
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    ...(options.ttlMs === undefined ? {} : { draftTtlMs: options.ttlMs }),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    tools: { [MESSAGE_TOOL]: fake.tool },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: 'page' }), evidenceReader: { read: () => Promise.resolve({ readable: false, reason: 'no stored content in this test' }) } },
    agent: {
      adapter: make(), tools: [SEARCH, MESSAGE_GATEWAY_SPEC], timers: new ManualGatewayTimers(), recorder: { record: (record) => void records.push(record) },
      executors: new Map<string, ToolExecutor>([['web_search', () => Promise.resolve({ result: { hits: 1 } })]]),
      runExecutors: (context) => new Map([[MESSAGE_TOOL, messageExecutorFor(context)]]),
    },
  });
  return { env, fake, daemon, adapterRuns, records };
}

const draftTask = (r: Rig, extra: Record<string, unknown> = {}) =>
  createWithGate(r.env, effectDraft({ ...validationSpec(['url_reachable', 'no_secret_in_outputs', 'budget']), ...extra }));

/** 초안 run 과 검증까지: 업무는 needs_review 이고 초안이 proposed 다 */
async function draftUntilReview(r: Rig, taskId: string): Promise<void> {
  const drafted = await r.daemon.worker.tick();
  assert.equal(drafted.executed?.taskId, taskId);
  assert.equal(taskStatus(r.env.db, taskId), 'validating');
  const validated = await r.daemon.worker.tick();
  assert.deepEqual(validated.validated.map((v) => v.taskStatus), ['needs_review']);
}

const show = (r: Rig, taskId: string) => r.env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });

/** show 의 해시로 승인 → cooldown → TOTP release */
function approveAndRelease(r: Rig, taskId: string): string {
  const hash = String(show(r, taskId)['hash']);
  assert.equal(r.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash })['state'], 'cooldown');
  r.env.clock.advance(HOUR);
  assert.deepEqual(r.env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: r.env.code() }), { ok: true, state: 'queued' });
  return hash;
}

const adapterOfRuns = (r: Rig, taskId: string) => r.env.db.all<{ adapter: string; outcome: string | null }>('SELECT adapter, outcome FROM task_run WHERE task_id = ? ORDER BY attempt', [taskId]);

test('the full path: draft run sends nothing -> validator -> needs_review with proposed drafts -> show -> approve (show hash) -> cooldown + TOTP -> host dispatch (no LLM) -> exactly the drafted bytes -> completed', async (t) => {
  const r = rig(t);
  const taskId = draftTask(r);

  // 1) 초안 run: 에이전트가 한 번 돌고, 도구는 0번 불렸다
  const drafted = await r.daemon.worker.tick();
  assert.equal(drafted.executed?.taskId, taskId);
  assert.equal(r.adapterRuns.count, 1);
  assert.equal(r.fake.sent.length, 0, 'the draft run sent nothing (I1)');
  assert.equal(r.env.db.get('SELECT count(*) AS n FROM external_effect')?.['n'], 0);
  assert.deepEqual(draftsOf(r.env.db, taskId).map((d) => d.state), ['pending']);
  assert.deepEqual(r.records.map((rec) => [rec.tool, rec.outcome, rec.decision]), [[MESSAGE_TOOL, 'ok', 'require_approval']]);
  assert.match(r.records[0]!.reason ?? '', /draft mode: recorded as a draft, nothing is sent/);
  assert.equal(taskStatus(r.env.db, taskId), 'validating');

  // 2) 검증기 -> 사람의 한 번
  const validated = await r.daemon.worker.tick();
  assert.deepEqual(validated.validated.map((v) => v.taskStatus), ['needs_review']);
  assert.equal(evaluationsOf(r.env.db, taskId)[0]?.outcome, 'pass');
  assert.deepEqual(draftsOf(r.env.db, taskId).map((d) => d.state), ['proposed']);
  assert.match(r.env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!.reason, /^drafts_awaiting_approval: 1 drafts/);
  assert.equal(r.fake.sent.length, 0);
  const idle = await r.daemon.worker.tick();
  assert.equal(idle.executed, null, 'nothing runs while a person has not decided');

  // 3) show 가 초안을 보여 준다. 승인은 그 해시에 묶인다
  const shown = show(r, taskId);
  const shownDrafts = shown['drafts'] as { id: string; payload: unknown; payload_hash: string; influenced_by_external_input: boolean; expired: boolean }[];
  assert.equal(shownDrafts.length, 1);
  assert.deepEqual(shownDrafts[0]!.payload, examplePayload({ subject: 'Hello 1' }));
  assert.equal(shownDrafts[0]!.influenced_by_external_input, false);
  const approvedHash = approveAndRelease(r, taskId);
  assert.equal(approvedHash, shown['hash']);
  assert.equal(taskRow(r.env.db, taskId).approved_hash, approvedHash);
  assert.equal(r.fake.sent.length, 0, 'approval alone sends nothing');

  // 4) 전송 run: 에이전트·LLM 호출 0회, 가짜 도구가 초안의 payload 를 바이트 그대로 한 번 받는다
  const dispatched = await r.daemon.worker.tick();
  assert.equal(dispatched.executed?.taskId, taskId);
  assert.equal(r.adapterRuns.count, 1, 'the agent adapter was not called again: no LLM in the dispatch run (I2)');
  assert.equal(r.fake.sent.length, 1);
  const [draft] = draftsOf(r.env.db, taskId) as [EffectDraftRow];
  assert.equal(canonicalJson(r.fake.sent[0]!.request), draft.payload, 'byte for byte');
  assert.deepEqual(r.fake.sent[0]!.request, examplePayload({ subject: 'Hello 1' }));
  assert.equal(r.fake.sent[0]!.target, 'mailbox:example');
  const runs = adapterOfRuns(r, taskId);
  assert.deepEqual(runs.map((run) => run.adapter), ['draft-fake', HOST_DISPATCH_ADAPTER]);
  const effect = r.env.db.get<{ effect_key: string; request_hash: string; state: string }>('SELECT effect_key, request_hash, state FROM external_effect WHERE task_id = ?', [taskId])!;
  assert.deepEqual([effect.effect_key, effect.request_hash, effect.state], [draft.effect_key, draft.payload_hash, 'confirmed']);
  assert.equal(taskStatus(r.env.db, taskId), 'validating');
  // 효과 시점 판정이 남았다 (전송 직전 재확인)
  const effectDecisions = r.env.db.all<{ decision: string; reason: string }>("SELECT decision, reason FROM policy_decision WHERE task_id = ? AND task_run_id = ? AND action = 'notify-tool.send'", [taskId, runs.length === 2 ? runsOf(r.env.db, taskId)[1]!.id : '']);
  assert.ok(effectDecisions.length > 0 && effectDecisions.every((d) => d.decision !== 'deny'));
  assert.match(effectDecisions[0]!.reason, /approval: valid/);

  // 5) 전송 프로필 검증 -> completed
  const done = await r.daemon.worker.tick();
  assert.deepEqual(done.validated.map((v) => v.taskStatus), ['completed']);
  assert.equal(taskStatus(r.env.db, taskId), 'completed');
  const evaluations = evaluationsOf(r.env.db, taskId);
  assert.deepEqual(evaluations.map((e) => [e.outcome, e.safety]), [['pass', 'pass'], ['pass', 'pass']]);
  assert.equal(r.adapterRuns.count, 1);
  assert.equal(r.fake.sent.length, 1);
});

test('reject: the task fails, the drafts are rejected, and nothing is ever sent', async (t) => {
  const r = rig(t);
  const taskId = draftTask(r);
  await draftUntilReview(r, taskId);
  assert.equal(r.env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: taskId, comment: 'no' })['state'], 'failed');
  assert.deepEqual(draftsOf(r.env.db, taskId).map((d) => d.state), ['rejected']);
  assert.equal((await r.daemon.worker.tick()).executed, null);
  assert.equal(r.fake.sent.length, 0);
  assert.equal(r.adapterRuns.count, 1);
});

test('request-changes: the old drafts are superseded, a new draft run rewrites them, and only the newly approved drafts are sent', async (t) => {
  const r = rig(t);
  const taskId = draftTask(r);
  await draftUntilReview(r, taskId);
  const oldHash = String(show(r, taskId)['hash']);
  const response = r.env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id: taskId, comment: 'make it friendlier' });
  assert.equal(response['state'], 'queued');
  assert.deepEqual(draftsOf(r.env.db, taskId).map((d) => d.state), ['superseded']);

  await draftUntilReview(r, taskId);
  assert.equal(r.adapterRuns.count, 2, 'a new draft run (the agent ran again)');
  const rows = draftsOf(r.env.db, taskId);
  assert.deepEqual(rows.map((d) => d.state).sort(), ['proposed', 'superseded']);
  const newHash = String(show(r, taskId)['hash']);
  assert.notEqual(newHash, oldHash);
  // 옛 해시로는 승인할 수 없다
  const stale = r.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash: oldHash });
  assert.equal(stale['ok'], false);
  assert.match(String(stale['error']), /subject hash mismatch/);

  approveAndRelease(r, taskId);
  await r.daemon.worker.tick();
  assert.equal(r.adapterRuns.count, 2, 'the dispatch run called no agent');
  assert.equal(r.fake.sent.length, 1);
  assert.equal((r.fake.sent[0]!.request as MessagePayload).subject, 'Hello 2', 'only the rewritten draft was sent');
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['completed']);
});

test('expiry: an expired draft blocks approve and release, and a dispatch that waited past the deadline is stopped', async (t) => {
  // (a) 승인 전에 만료: approve 거부, show 가 expired 를 알린다
  const a = rig(t);
  const first = draftTask(a);
  await draftUntilReview(a, first);
  a.env.clock.advance(73 * HOUR);
  const hash = String(show(a, first)['hash']);
  const refused = a.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: first, hash });
  assert.equal(refused['ok'], false);
  assert.match(String(refused['error']), /draft expired/);
  assert.equal(((show(a, first)['drafts']) as { expired: boolean }[])[0]!.expired, true);
  assert.equal(a.fake.sent.length, 0);

  // (b) 승인 뒤 release 전에 만료: release 거부
  const b = rig(t);
  const second = draftTask(b);
  await draftUntilReview(b, second);
  const hashB = String(show(b, second)['hash']);
  assert.equal(b.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: second, hash: hashB })['state'], 'cooldown');
  b.env.clock.advance(73 * HOUR);
  const release = b.env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: second, totp: b.env.code() });
  assert.equal(release['ok'], false);
  assert.match(String(release['error']), /draft expired/);

  // (c) release 뒤 전송 전에 만료: 전송 run 이 시작되지 않고 needs_review
  const c = rig(t);
  const third = draftTask(c);
  await draftUntilReview(c, third);
  approveAndRelease(c, third);
  c.env.clock.advance(73 * HOUR);
  const tick = await c.daemon.worker.tick();
  assert.equal(tick.executed, null);
  assert.deepEqual(tick.sentToReview, [third]);
  assert.equal(taskStatus(c.env.db, third), 'needs_review');
  assert.match(c.env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [third])!.reason, /draft expired/);
  assert.equal(c.fake.sent.length, 0);
  assert.equal(c.adapterRuns.count, 1);
});

test('tampering a proposed draft after approval blocks the dispatch: a payload change fails the integrity check, a fully rewritten row fails the approval hash', async (t) => {
  // (a) payload 만 바꿈 (해시·키는 그대로): 승인은 유효하지만 전송기의 무결성 확인에서 막힌다
  const a = rig(t);
  const first = draftTask(a);
  await draftUntilReview(a, first);
  approveAndRelease(a, first);
  a.env.db.writeTx((tx) => tx.run('UPDATE effect_draft SET payload = ? WHERE task_id = ?', [canonicalJson(examplePayload({ to: ['attacker@example.com'] })), first]));
  const tickA = await a.daemon.worker.tick();
  assert.equal(tickA.executed?.end !== 'lease_lost' && tickA.executed?.end.outcome, 'error');
  assert.equal(a.fake.sent.length, 0);
  assert.equal(a.adapterRuns.count, 1);

  // (b) payload·payload_hash·effect_key 를 모두 일관되게 다시 씀: 승인 해시가 달라져 전송 run 이 시작되지 않는다
  const b = rig(t);
  const second = draftTask(b);
  await draftUntilReview(b, second);
  approveAndRelease(b, second);
  const forged = canonicalJson(examplePayload({ to: ['attacker@example.com'] }));
  const row = draftsOf(b.env.db, second)[0]!;
  b.env.db.writeTx((tx) => tx.run('UPDATE effect_draft SET payload = ?, payload_hash = ?, effect_key = ? WHERE id = ?', [forged, sha256Hex(forged), effectKeyOf(second, row.step_id, JSON.parse(forged)), row.id]));
  const tickB = await b.daemon.worker.tick();
  assert.equal(tickB.executed, null);
  assert.deepEqual(tickB.sentToReview, [second]);
  assert.match(b.env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [second])!.reason, /approved_hash mismatch/);
  assert.equal(b.fake.sent.length, 0);
});

test('a draft written under external-input influence is allowed but flagged, and it still needs the person\'s approval', async (t) => {
  const r = rig(t, { searchFirst: true });
  const taskId = draftTask(r);
  await draftUntilReview(r, taskId);
  assert.deepEqual(r.records.map((rec) => [rec.tool, rec.influenced_by_external_input]), [['web_search', false], [MESSAGE_TOOL, true]]);
  const shown = show(r, taskId);
  assert.equal((shown['drafts'] as { influenced_by_external_input: boolean }[])[0]!.influenced_by_external_input, true);
  assert.equal(r.fake.sent.length, 0);
  assert.equal((await r.daemon.worker.tick()).executed, null, 'not sent without the approval');
  approveAndRelease(r, taskId);
  await r.daemon.worker.tick();
  assert.equal(r.fake.sent.length, 1);
});

test('without draft actions nothing changes: a read-only task completes in one run, and a scope-approval tool keeps the approve-the-spec-first flow (no drafts, one run)', async (t) => {
  const r = rig(t, { approval: 'scope' });
  const readId = createWithGate(r.env, readOnlyDraft({ ...validationSpec(['url_reachable', 'budget']), inputs: [{ name: 'k', ref: 'r:read', kind: 'k' }] }));
  await r.daemon.worker.tick();
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['completed']);
  assert.equal(taskStatus(r.env.db, readId), 'completed');

  const scopeId = draftTask(r);
  const first = await r.daemon.worker.tick();
  assert.deepEqual(first.sentToReview, [scopeId], 'a scope task needs the spec approval before it runs');
  assert.equal(r.adapterRuns.count, 1, 'only the read-only task has run so far');
  approveAndRelease(r, scopeId);
  await r.daemon.worker.tick();
  assert.equal(r.adapterRuns.count, 2);
  assert.equal(r.fake.sent.length, 1, 'the agent run sent through the ledger once the spec was approved (today\'s behaviour)');
  assert.deepEqual(draftsOf(r.env.db, scopeId), []);
  assert.deepEqual(adapterOfRuns(r, scopeId).map((run) => run.adapter), ['draft-fake']);
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['completed']);
});

test('a policy change between the draft approval and the dispatch stops the dispatch; the same drafts are re-approved (not rewritten) and then sent', async (t) => {
  const r = rig(t);
  const taskId = draftTask(r);
  await draftUntilReview(r, taskId);
  const first = approveAndRelease(r, taskId);
  const before = draftsOf(r.env.db, taskId).map((d) => d.payload_hash);
  deployDirect(r.env, policyText((y) => y.replace('rules:\n', 'rules:\n  - {id: other, action: ["unrelated_tool.*"], decision: deny}\n')));
  const tick = await r.daemon.worker.tick();
  assert.equal(tick.executed, null);
  assert.deepEqual(tick.sentToReview, [taskId]);
  assert.match(r.env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!.reason, /policy changed since approval/);
  assert.equal(r.fake.sent.length, 0);
  r.env.clock.advance(31_000);
  const second = approveAndRelease(r, taskId);
  assert.notEqual(second, first);
  assert.deepEqual(draftsOf(r.env.db, taskId).map((d) => d.payload_hash), before, 'the same drafts, not rewritten');
  await r.daemon.worker.tick();
  assert.equal(r.fake.sent.length, 1);
  assert.equal(r.adapterRuns.count, 1);
});
