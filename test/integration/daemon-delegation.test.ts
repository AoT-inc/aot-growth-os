// ADR-0016 통합 (제안): 데몬 조립(실제 정책 게이트 + 승인 엔진 + 업무 엔진 + 평가기 + 에이전트 실행 관리 + 위임 주기)에서
//   초안 run → 검증기 → needs_review → 위임 검토자(AI)가 승인 → 위임 cooldown → 데몬이 풀어 줌(TOTP 없음) → 전송 run(host:dispatch, LLM 0회)이 *승인된 초안 그대로* 전송.
// "승인한 것 = 나간 것"(ADR-0015)이 위임 승인에서도 성립하는지, 정지·사람 취소·검토자 오류·적격 실패가 전송을 막는지 본다. 외부 접근은 없다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createFakeAgentAdapter, type AgentAdapter, type FakeToolCall, type JsonObject, type ToolExecutor } from '@aot/agent-runtime';
import { canonicalJson, ensureApprovalDelegate, HOST_DISPATCH_ADAPTER } from '@aot/domain';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { DelegateReviewerUnavailableError, type DelegateReviewer, type DelegateReviewRequest } from '../../apps/daemon/src/delegate-cycle.ts';
import { approvalsOf, controlsOf, DELEGATE, delegationPolicyText, MANDATE, reviewsOf } from '../support/delegation.ts';
import { draftsOf } from '../support/drafts.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { EXAMPLE_URL, FakeFetcher, validationSpec } from '../support/evaluation.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { createFakeMessageTool, examplePayload, MESSAGE_GATEWAY_SPEC, messageExecutorFor, MESSAGE_TOOL, type FakeMessageTool, type MessagePayload } from '../support/message-tool.ts';
import { AGENT, createWithGate, effectDraft, HOUR, OWNER, policyEnv, taskRow, type PolicyEnv } from '../support/policy.ts';

const SEARCH = { tool: 'web_search', operation: 'search', scope: 'internal', sideEffect: false, resultOrigin: 'external_untrusted' } as const;

type Script = (call: number, request: DelegateReviewRequest) => { verdict?: string; reason?: string; hash?: string; raw?: unknown; costUsd?: number } | 'unavailable' | 'throw';

interface Rig {
  env: PolicyEnv;
  fake: FakeMessageTool;
  daemon: ReturnType<typeof assembleDaemon>;
  adapterRuns: { count: number };
  reviewCalls: DelegateReviewRequest[];
}

function rig(t: TestContext, options: { script?: Script; searchFirst?: boolean; mandate?: Parameters<typeof delegationPolicyText>[0]; noReviewer?: boolean } = {}): Rig {
  const env = policyEnv(t);
  env.db.writeTx((tx) => ensureApprovalDelegate(tx, env.clock));
  const parsed = env.store.archive(delegationPolicyText(options.mandate ?? [{}]));
  env.db.writeTx((tx) => tx.run("INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at, rollback_of) VALUES (?, ?, 'risky', '[\"actor-owner\"]', ?, NULL)", [
    parsed.versionId, parsed.hash, env.clock.nowIso(),
  ]));
  const fake = createFakeMessageTool();
  const adapterRuns = { count: 0 };
  const reviewCalls: DelegateReviewRequest[] = [];
  const make = (): AgentAdapter => ({
    name: 'draft-fake',
    run: (input, context) => {
      adapterRuns.count += 1;
      const run = adapterRuns.count;
      return createFakeAgentAdapter({
        clock: env.clock, scenario: 'tool_calls', name: 'draft-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }],
        toolCalls: [
          ...(options.searchFirst === true ? [{ tool: 'web_search', args: { q: 'example' } } satisfies FakeToolCall] : []),
          { tool: MESSAGE_TOOL, args: examplePayload({ subject: `Hello ${run}` }) as unknown as JsonObject },
        ],
      }).run(input, context);
    },
  });
  const script: Script = options.script ?? ((_, request) => ({ verdict: 'approve', reason: 'routine notice', hash: request.hash }));
  const reviewer: DelegateReviewer = {
    id: 'scripted',
    review: (request) => {
      reviewCalls.push(request);
      const out = script(reviewCalls.length, request);
      if (out === 'unavailable') return Promise.reject(new DelegateReviewerUnavailableError('usage limit'));
      if (out === 'throw') return Promise.reject(new Error('boom'));
      if (out.raw !== undefined) return Promise.resolve({ output: out.raw });
      return Promise.resolve({ output: { verdict: out.verdict, hash: out.hash ?? request.hash, reason: out.reason }, ...(out.costUsd === undefined ? {} : { costUsd: out.costUsd }) });
    },
  };
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    tools: { [MESSAGE_TOOL]: fake.tool },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: 'page' }), evidenceReader: { read: () => Promise.resolve({ readable: false, reason: 'no stored content in this test' }) } },
    agent: {
      adapter: make(), tools: [SEARCH, MESSAGE_GATEWAY_SPEC], timers: new ManualGatewayTimers(), recorder: { record: () => undefined },
      executors: new Map<string, ToolExecutor>([['web_search', () => Promise.resolve({ result: { hits: 1 } })]]),
      runExecutors: (context) => new Map([[MESSAGE_TOOL, messageExecutorFor(context)]]),
    },
    ...(options.noReviewer === true ? {} : { delegate: { reviewer } }),
  });
  return { env, fake, daemon, adapterRuns, reviewCalls };
}

const newTask = (r: Rig, key = 'task') => createWithGate(r.env, effectDraft(validationSpec(['url_reachable', 'no_secret_in_outputs', 'budget'])), { dedupeKey: key });

async function draftUntilReview(r: Rig, taskId: string): Promise<void> {
  const drafted = await r.daemon.worker.tick();
  assert.equal(drafted.executed?.taskId, taskId);
  const validated = await r.daemon.worker.tick();
  assert.deepEqual(validated.validated.map((v) => v.taskStatus), ['needs_review']);
}

const showHash = (r: Rig, taskId: string): string => String(r.env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash']);

test('the full delegated path: AI approves the exact shown hash -> cooldown -> the daemon releases (no TOTP) -> host dispatch sends exactly the approved draft bytes -> completed', async (t) => {
  const r = rig(t);
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  const hash = showHash(r, taskId);
  const [draft] = draftsOf(r.env.db, taskId);
  assert.equal(r.fake.sent.length, 0);

  // 1) 위임 검토: 검토자는 적격 업무의 초안·기준을 받고, 출력의 해시는 지금 해시다
  const first = await r.daemon.delegation.advance();
  assert.deepEqual(first.decided.map((d) => [d.taskId, d.verdict, d.outcome]), [[taskId, 'approve', 'recorded']]);
  assert.equal(r.reviewCalls.length, 1);
  const material = r.reviewCalls[0]!.material;
  assert.equal(r.reviewCalls[0]!.hash, hash);
  assert.equal(material.mandate.id, MANDATE);
  assert.match(material.mandate.guidance, /routine notices only/);
  assert.deepEqual(material.drafts.map((d) => d.payload), [examplePayload({ subject: 'Hello 1' })]);
  assert.deepEqual(approvalsOf(r.env.db, taskId), [
    { decision: 'approved', decided_by: DELEGATE, subject_hash: hash, comment: 'routine notice', mandate_id: MANDATE, via: 'delegate' },
  ]);
  assert.equal(taskRow(r.env.db, taskId).approved_hash, hash, 'the approval is bound to the hash of the shown content including the draft');
  assert.deepEqual(reviewsOf(r.env.db, taskId).map((x) => [x.verdict, x.outcome]), [['approve', 'recorded']]);

  // 같은 해시는 다시 검토하지 않는다. cooldown 안에서는 풀리지 않고 아무것도 나가지 않는다
  const idle = await r.daemon.delegation.advance();
  assert.deepEqual([idle.released.length, idle.decided.length], [0, 0]);
  assert.equal(r.reviewCalls.length, 1);
  assert.equal((await r.daemon.worker.tick()).executed, null);
  assert.equal(r.fake.sent.length, 0);

  // 2) cooldown 뒤 데몬이 풀어 준다 (사람 TOTP 없음)
  r.env.clock.advance(HOUR);
  const released = await r.daemon.delegation.advance();
  assert.deepEqual(released.released.map((x) => [x.taskId, x.mandateId]), [[taskId, MANDATE]]);
  assert.equal(taskStatus(r.env.db, taskId), 'queued');
  assert.equal(r.env.db.get('SELECT count(*) AS n FROM human_reauth')?.['n'], 0);

  // 3) 전송 run: 에이전트·LLM 호출 0회, 가짜 도구가 승인된 초안을 바이트 그대로 한 번 받는다
  const dispatched = await r.daemon.worker.tick();
  assert.equal(dispatched.executed?.taskId, taskId);
  assert.equal(r.adapterRuns.count, 1, 'the agent adapter was not called again');
  assert.equal(r.fake.sent.length, 1);
  assert.equal(canonicalJson(r.fake.sent[0]!.request), draft!.payload, 'byte for byte the approved draft');
  assert.deepEqual(r.env.db.all<{ adapter: string }>('SELECT adapter FROM task_run WHERE task_id = ? ORDER BY attempt', [taskId]).map((run) => run.adapter), ['draft-fake', HOST_DISPATCH_ADAPTER]);
  assert.equal(r.reviewCalls.length, 1, 'no reviewer call after the approval');
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['completed']);
  const decisions = r.env.db.all<{ reason: string }>("SELECT reason FROM policy_decision WHERE task_id = ? AND reason LIKE '%re-check before external effect%'", [taskId]);
  assert.ok(decisions.some((d) => /approval: valid/.test(d.reason)), 'the effect-time re-check accepted the delegated approval');
});

test('request_changes: the AI asks for a rewrite once; the rewritten draft gets its own review and only the newly approved draft is sent', async (t) => {
  const r = rig(t, { script: (call, request) => call === 1 ? { verdict: 'request_changes', reason: 'shorten the greeting', hash: request.hash } : { verdict: 'approve', reason: 'fine now', hash: request.hash } });
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  const first = await r.daemon.delegation.advance();
  assert.deepEqual(first.decided.map((d) => d.verdict), ['request_changes']);
  assert.equal(taskStatus(r.env.db, taskId), 'queued');
  assert.deepEqual(draftsOf(r.env.db, taskId).map((d) => d.state), ['superseded']);

  await draftUntilReview(r, taskId);
  assert.equal(r.adapterRuns.count, 2, 'the agent rewrote the draft');
  const second = await r.daemon.delegation.advance();
  assert.deepEqual(second.decided.map((d) => d.verdict), ['approve']);
  r.env.clock.advance(HOUR);
  await r.daemon.delegation.advance();
  await r.daemon.worker.tick();
  assert.equal(r.fake.sent.length, 1);
  assert.equal((r.fake.sent[0]!.request as MessagePayload).subject, 'Hello 2', 'only the rewritten and approved draft left');
  assert.equal(r.adapterRuns.count, 2, 'the dispatch run called no agent');
  assert.deepEqual(approvalsOf(r.env.db, taskId).map((a) => [a.decision, a.decided_by, a.mandate_id]), [['changes_requested', DELEGATE, MANDATE], ['approved', DELEGATE, MANDATE]]);
});

test('kill switch: pausing delegation after the AI approved stops the release and nothing is sent, even past the cooldown', async (t) => {
  const r = rig(t);
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  await r.daemon.delegation.advance();
  assert.equal(r.env.send({ cmd: 'delegation', actor: OWNER, op: 'pause', comment: 'stop everything', via: 'web' })['state'], 'paused');
  r.env.clock.advance(2 * HOUR);
  const after = await r.daemon.delegation.advance();
  assert.equal(after.released.length, 0);
  assert.equal(taskStatus(r.env.db, taskId), 'needs_review');
  assert.equal((await r.daemon.worker.tick()).executed, null);
  assert.equal(r.fake.sent.length, 0);

  // 정지가 풀려도(TOTP) 정지 전의 승인은 되살아나지 않는다: 사람이 다시 결정해야 한다
  r.env.clock.advance(60_000);
  assert.equal(r.env.send({ cmd: 'delegation', actor: OWNER, op: 'resume', totp: r.env.code(OWNER) })['ok'], true);
  assert.equal((await r.daemon.delegation.advance()).released.length, 0);
  assert.equal(r.fake.sent.length, 0);
  const shown = r.env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  assert.equal((shown['approval'] as { state: string }).state, 'revoked');
  const hash = String(shown['hash']);
  assert.equal(r.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash })['state'], 'cooldown', 'the person decides: the usual cooldown applies');
});

test('a person cancelling during the cooldown: nothing is sent and the mandate is paused automatically', async (t) => {
  const r = rig(t);
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  await r.daemon.delegation.advance();
  const cancelled = r.env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id: taskId, comment: 'wrong customer', expected_hash: showHash(r, taskId), via: 'web' });
  assert.equal(cancelled['ok'], true);
  assert.equal(cancelled['delegation_paused'], MANDATE);
  assert.deepEqual(controlsOf(r.env.db), [{ action: 'pause', mandate_id: MANDATE, actor_id: OWNER, reason: '사람이 위임 결정을 취소함' }]);
  r.env.clock.advance(2 * HOUR);
  assert.equal((await r.daemon.delegation.advance()).released.length, 0);
  assert.equal((await r.daemon.worker.tick()).executed, null);
  assert.equal(r.fake.sent.length, 0);
  // 정지된 동안 새 업무는 위임 검토를 받지 않는다 (기록도 남기지 않는다)
  const next = newTask(r, 'next');
  await draftUntilReview(r, next);
  const blocked = await r.daemon.delegation.advance();
  assert.deepEqual(blocked.decided, []);
  assert.equal(r.reviewCalls.length, 1);
  assert.equal(reviewsOf(r.env.db, next).length, 0);
});

test('a revoke after the approval stops the dispatch too, and a revoked mandate is never reviewed again', async (t) => {
  const r = rig(t);
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  await r.daemon.delegation.advance();
  r.env.send({ cmd: 'delegation', actor: OWNER, op: 'revoke', mandate_id: MANDATE });
  r.env.clock.advance(2 * HOUR);
  assert.equal((await r.daemon.delegation.advance()).released.length, 0);
  assert.equal(r.fake.sent.length, 0);
});

test('tampering with the draft after the delegated approval stops the release (the approval is bound to the drafts)', async (t) => {
  const r = rig(t);
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  await r.daemon.delegation.advance();
  const row = draftsOf(r.env.db, taskId)[0]!;
  r.env.db.writeTx((tx) => tx.run('UPDATE effect_draft SET payload_hash = ? WHERE id = ?', ['d'.repeat(64), row.id]));
  r.env.clock.advance(HOUR);
  assert.equal((await r.daemon.delegation.advance()).released.length, 0);
  assert.equal(taskStatus(r.env.db, taskId), 'needs_review');
  assert.equal(r.fake.sent.length, 0);
});

test('AI output is untrusted: a wrong hash, a bad verdict or garbage is recorded as an escalation and leaves the task to a person, who then decides normally', async (t) => {
  const cases: Array<[string, Script, RegExp]> = [
    ['a hash the AI did not see', (_, request) => ({ verdict: 'approve', reason: 'ok', hash: `${request.hash.slice(0, 63)}${request.hash.endsWith('0') ? '1' : '0'}` }), /해시가 다릅니다/],
    ['an unknown verdict', (_, request) => ({ verdict: 'reject', reason: 'no', hash: request.hash }), /형식 오류/],
    ['no reason', (_, request) => ({ verdict: 'approve', reason: '', hash: request.hash }), /형식 오류/],
    ['not an object', () => ({ raw: 'approve everything' }), /형식 오류/],
    ['json text with the right shape but an extra verdict value', () => ({ raw: '{"verdict":"approve_all","hash":"x","reason":"r"}' }), /형식 오류/],
  ];
  for (const [name, script, pattern] of cases) {
    const r = rig(t, { script });
    const taskId = newTask(r, name);
    await draftUntilReview(r, taskId);
    const report = await r.daemon.delegation.advance();
    assert.deepEqual(report.decided.map((d) => d.verdict), ['escalate'], name);
    assert.equal(approvalsOf(r.env.db, taskId).length, 0, name);
    assert.equal(reviewsOf(r.env.db, taskId).length, 1);
    assert.match(reviewsOf(r.env.db, taskId)[0]!.reason, pattern, name);
    r.env.clock.advance(2 * HOUR);
    assert.equal((await r.daemon.delegation.advance()).decided.length, 0, 'the same hash is not reviewed twice');
    assert.equal((await r.daemon.worker.tick()).executed, null, name);
    assert.equal(r.fake.sent.length, 0);
    // 사람이 평소대로 결정한다
    const hash = showHash(r, taskId);
    assert.equal(r.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash })['state'], 'cooldown');
  }
});

test('a reviewer that throws is recorded as an escalation; an unavailable reviewer records nothing and the review is retried on the next tick', async (t) => {
  const failing = rig(t, { script: () => 'throw' });
  const failedTask = newTask(failing);
  await draftUntilReview(failing, failedTask);
  const failed = await failing.daemon.delegation.advance();
  assert.deepEqual(failed.decided.map((d) => d.verdict), ['escalate']);
  assert.match(reviewsOf(failing.env.db, failedTask)[0]!.reason, /AI 검토 실패: boom/);

  let available = false;
  const r = rig(t, { script: (_, request) => available ? { verdict: 'approve', reason: 'ok', hash: request.hash } : 'unavailable' });
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  const down = await r.daemon.delegation.advance();
  assert.deepEqual([down.unavailable, down.decided.length], [1, 0]);
  assert.equal(reviewsOf(r.env.db, taskId).length, 0, 'nothing is recorded while the reviewer is unavailable');
  available = true;
  assert.deepEqual((await r.daemon.delegation.advance()).decided.map((d) => d.verdict), ['approve']);
});

test('an ineligible task never reaches the AI: a draft written under external-input influence is recorded for a person with the reason', async (t) => {
  const r = rig(t, { searchFirst: true });
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  const report = await r.daemon.delegation.advance();
  assert.equal(r.reviewCalls.length, 0, 'the reviewer was not called');
  assert.deepEqual(report.decided.map((d) => [d.verdict, d.outcome]), [['escalate', 'external_input']]);
  assert.deepEqual(reviewsOf(r.env.db, taskId).map((x) => [x.verdict, x.outcome]), [['escalate', 'external_input']]);
  assert.match(reviewsOf(r.env.db, taskId)[0]!.reason, /외부 입력/);
  r.env.clock.advance(2 * HOUR);
  assert.equal((await r.daemon.delegation.advance()).released.length, 0);
  assert.equal(r.fake.sent.length, 0);
  // 사람은 평소대로 승인·release 한다 (TOTP 필요)
  const hash = showHash(r, taskId);
  r.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash });
  r.env.clock.advance(HOUR);
  assert.equal(r.env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId })['code'], 'reauth_required');
  assert.equal(r.env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: r.env.code(OWNER) })['state'], 'queued');
  await r.daemon.worker.tick();
  assert.equal(r.fake.sent.length, 1);
});

test('the daily approval limit sends the next task to a person; the review cost is recorded per review', async (t) => {
  const r = rig(t, { mandate: [{ limits: { max_per_day: 1, max_review_usd_per_day: 5 } }], script: (_, request) => ({ verdict: 'approve', reason: 'ok', hash: request.hash, costUsd: 0.25 }) });
  const a = newTask(r, 'a');
  const b = newTask(r, 'b');
  for (let i = 0; i < 8 && [a, b].some((id) => taskStatus(r.env.db, id) !== 'needs_review'); i += 1) await r.daemon.worker.tick();
  assert.deepEqual([a, b].map((id) => taskStatus(r.env.db, id)), ['needs_review', 'needs_review']);
  // 검토 순서는 (updated_at, id) 다. 두 업무가 같은 시각이면 uuid 순서로 떨어져 어느 쪽이 먼저인지 달라지므로, a 가 확실히 먼저가 되게 시각을 못 박는다
  r.env.db.writeTx((tx) => {
    tx.run('UPDATE task SET updated_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', a]);
    tx.run('UPDATE task SET updated_at = ? WHERE id = ?', ['2000-01-01T00:00:01.000Z', b]);
  });
  const report = await r.daemon.delegation.advance();
  assert.deepEqual(report.decided.map((d) => [d.taskId, d.verdict, d.outcome]), [[a, 'approve', 'recorded'], [b, 'escalate', 'daily_limit']]);
  assert.equal(r.reviewCalls.length, 1, 'the second task was not even sent to the AI');
  assert.equal(reviewsOf(r.env.db, a)[0]!.cost_usd, 0.25);
  assert.match(reviewsOf(r.env.db, b)[0]!.reason, /하루 한도 1건/);
});

test('with no reviewer configured, nothing new is reviewed but an already recorded delegated approval is still released after its cooldown', async (t) => {
  const withReviewer = rig(t);
  const taskId = newTask(withReviewer);
  await draftUntilReview(withReviewer, taskId);
  await withReviewer.daemon.delegation.advance();
  // 같은 DB 를 검토자 없는 데몬으로 다시 조립한다
  const quiet = assembleDaemon({
    db: withReviewer.env.db, clock: withReviewer.env.clock, workerId: 'w2', actorId: AGENT, timers: manualTimers(),
    paths: { policyStoreDir: join(withReviewer.env.dir, 'policies'), totpDir: join(withReviewer.env.dir, 'totp'), approvalSocket: join(withReviewer.env.dir, 'run', 'q.sock') },
    executor: { execute: () => Promise.reject(new Error('not used')) },
  });
  withReviewer.env.clock.advance(HOUR);
  assert.deepEqual((await quiet.delegation.advance()).released.map((x) => x.taskId), [taskId]);
  assert.equal(taskStatus(withReviewer.env.db, taskId), 'queued');
});

test('without a delegation section the cycle does nothing at all: no review calls, no rows, human flow unchanged', async (t) => {
  const r = rig(t, { mandate: [] });
  const taskId = newTask(r);
  await draftUntilReview(r, taskId);
  const report = await r.daemon.delegation.advance();
  assert.deepEqual([report.released.length, report.decided.length, r.reviewCalls.length], [0, 0, 0]);
  assert.equal(r.env.db.get('SELECT count(*) AS n FROM delegate_review')?.['n'], 0);
  const hash = showHash(r, taskId);
  assert.equal(r.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash })['state'], 'cooldown');
});
