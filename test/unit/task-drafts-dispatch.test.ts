// 호스트 전송 run (ADR-0015 W7): 에이전트 실행기 호출 0회, 저장된 payload 를 바이트 그대로 한 번 보낸다 (I2). 원장 규칙(I4)은 그대로.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson, HOST_DISPATCH_ADAPTER, sha256Hex, type TaskRunRow } from '@aot/domain';
import { dispatchApprovedDrafts, effectKeyOf, type EffectTool } from '@aot/task-engine';

import { draftEngine, phaseGate } from '../support/draft-engine.ts';
import { draftsOf } from '../support/drafts.ts';
import { effectsOf, taskStatus } from '../support/engine.ts';
import { createFakeMessageTool, examplePayload } from '../support/message-tool.ts';

const A = examplePayload({ subject: 'first' });
const B = examplePayload({ subject: 'second', to: ['other@example.com'] });
const requests = [{ stepId: 's1', request: A }, { stepId: 's2', request: B }];

const runsOf = (e: ReturnType<typeof draftEngine>) => e.db.all<TaskRunRow>('SELECT * FROM task_run WHERE task_id = ? ORDER BY attempt', [e.taskId]);

test('a dispatch run never calls the agent executor and sends exactly the drafted payloads, in seq order', async (t) => {
  const e = draftEngine(t);
  const fake = createFakeMessageTool();
  await e.draftAndPropose(requests, fake.tool);
  assert.equal(fake.sent.length, 0, 'the draft run sent nothing');
  const drafts = draftsOf(e.db, e.taskId);
  assert.equal(drafts.length, 2);

  const executed = { count: 0 };
  const report = await e.worker(fake.tool, executed).tick();
  assert.equal(executed.count, 0, 'executor (LLM) calls: 0');
  assert.equal(report.executed?.end !== 'lease_lost' && report.executed?.end.taskStatus, 'validating');
  assert.equal(fake.sent.length, 2);
  assert.deepEqual(fake.sent.map((call) => call.request), [A, B], 'the request the tool received deep-equals the draft');
  assert.deepEqual(fake.sent.map((call) => canonicalJson(call.request)), drafts.map((d) => d.payload), 'byte for byte');
  const runs = runsOf(e);
  assert.equal(runs.at(-1)!.adapter, HOST_DISPATCH_ADAPTER);
  assert.equal(runs.at(-1)!.outcome, 'submitted');
  assert.deepEqual(JSON.parse(runs.at(-1)!.result!), {
    dispatched: drafts.map((d) => ({ draft_id: d.id, effect_id: e.db.get<{ id: string }>('SELECT id FROM external_effect WHERE effect_key = ?', [d.effect_key])!.id, state: 'confirmed' })),
  });
  const effects = new Map(e.db.all<{ effect_key: string; request_hash: string; state: string }>('SELECT effect_key, request_hash, state FROM external_effect').map((x) => [x.effect_key, x]));
  assert.deepEqual(drafts.map((d) => [effects.get(d.effect_key)?.request_hash, effects.get(d.effect_key)?.state]), drafts.map((d) => [d.payload_hash, 'confirmed']));
  assert.ok(effects.has(effectKeyOf(e.taskId, 's1', A)));
  assert.equal(drafts[0]!.payload_hash, sha256Hex(canonicalJson(A)));
  assert.equal(taskStatus(e.db, e.taskId), 'validating');
});

test('a tampered payload (row UPDATE) sends nothing: the run ends in error', async (t) => {
  const e = draftEngine(t);
  const fake = createFakeMessageTool();
  await e.draftAndPropose(requests, fake.tool);
  e.db.writeTx((tx) => tx.run("UPDATE effect_draft SET payload = ? WHERE step_id = 's2'", [canonicalJson(examplePayload({ to: ['attacker@example.com'] }))]));
  const executed = { count: 0 };
  const report = await e.worker(fake.tool, executed).tick();
  assert.equal(fake.sent.length, 0, 'not even the untouched first draft is sent');
  assert.equal(executed.count, 0);
  assert.equal(report.executed?.end !== 'lease_lost' && report.executed?.end.outcome, 'error');
  assert.equal(taskStatus(e.db, e.taskId), 'retry_wait');
  assert.equal(e.db.get('SELECT count(*) AS n FROM external_effect')?.['n'], 0);
  const run = runsOf(e).at(-1)!;
  assert.equal(run.outcome, 'error');
});

test('a tampered effect_key or payload_hash is also refused before anything is sent', async (t) => {
  for (const column of ['effect_key', 'payload_hash']) {
    const e = draftEngine(t);
    const fake = createFakeMessageTool();
    await e.draftAndPropose(requests, fake.tool);
    e.db.writeTx((tx) => tx.run(`UPDATE effect_draft SET ${column} = ? WHERE step_id = 's1'`, ['0'.repeat(64)]));
    await e.worker(fake.tool, { count: 0 }).tick();
    assert.equal(fake.sent.length, 0, column);
    assert.equal(taskStatus(e.db, e.taskId), 'retry_wait', column);
  }
});

test('an unknown result stops the run: later drafts are not sent, and the task goes to review', async (t) => {
  const e = draftEngine(t);
  const fake = createFakeMessageTool({ idempotent: false });
  await e.draftAndPropose(requests, fake.tool);
  fake.loseNextResponses(1);
  const report = await e.worker(fake.tool, { count: 0 }).tick();
  assert.equal(fake.sent.length, 1, 'the second draft was not sent');
  assert.equal(report.executed?.end !== 'lease_lost' && report.executed?.end.taskStatus, 'needs_review');
  assert.deepEqual(effectsOf(e.db, e.taskId).map((x) => x.state), ['unknown']);
});

test('a re-dispatch run reuses confirmed effects: zero sends', async (t) => {
  const e = draftEngine(t);
  const fake = createFakeMessageTool();
  await e.draftAndPropose(requests, fake.tool);
  await e.worker(fake.tool, { count: 0 }).tick();
  assert.equal(fake.sent.length, 2);
  // 업무를 다시 큐에 넣는다 (예: 전송 뒤 검증이 재시도를 요구)
  e.db.writeTx((tx) => tx.run("UPDATE task SET status = 'queued' WHERE id = ?", [e.taskId]));
  const executed = { count: 0 };
  await e.worker(fake.tool, executed).tick();
  assert.equal(fake.sent.length, 2, 'no second delivery');
  assert.equal(executed.count, 0);
  assert.equal(runsOf(e).length, 3);
  assert.equal(e.db.get('SELECT count(*) AS n FROM external_effect')?.['n'], 2);
});

test('a failed result ends the run in error and a failed resend needs an allow decision: the default behaviour keeps it failed', async (t) => {
  const e = draftEngine(t);
  let sends = 0;
  const failing: EffectTool = {
    name: 'notify-tool', actions: { send: { approval: 'draft', idempotency: { supported: true, retention_ms: 86_400_000 } } },
    send: () => { sends += 1; return { status: 'failed', responseRef: null }; },
  };
  await e.draftAndPropose(requests, failing);
  const worker = e.worker(failing, { count: 0 }, phaseGate({ refuseResend: true }));
  const first = await worker.tick();
  assert.equal(first.executed?.end !== 'lease_lost' && first.executed?.end.outcome, 'error');
  assert.equal(sends, 1, 'the second draft was not tried');
  assert.equal(taskStatus(e.db, e.taskId), 'retry_wait');
  e.clock.advance(120_000);
  await worker.tick();
  assert.equal(sends, 1, 'a failed effect is not resent without an allow decision');
  assert.deepEqual(effectsOf(e.db, e.taskId).map((x) => x.state), ['failed']);
});

test('a policy refusal at the effect gate sends nothing and stops the run for review', async (t) => {
  const e = draftEngine(t);
  const fake = createFakeMessageTool();
  await e.draftAndPropose(requests, fake.tool);
  const report = await e.worker(fake.tool, { count: 0 }, phaseGate({ refuseAll: 'draft expired' })).tick();
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(report.executed && report.executed.end !== 'lease_lost' ? [report.executed.end.outcome, report.executed.end.taskStatus] : null, ['killed', 'needs_review']);
});

test('the dispatcher refuses to run outside a dispatch lease or without proposed drafts', async (t) => {
  const e = draftEngine(t);
  const fake = createFakeMessageTool();
  const lease = { runId: 'r', taskId: e.taskId, owner: 'w', attempt: 1, leaseMs: 1 };
  await assert.rejects(() => dispatchApprovedDrafts(e.db, e.clock, { ...lease, phase: 'execute' }, { [fake.tool.name]: fake.tool }, phaseGate()), /not a dispatch-phase run/);
  await assert.rejects(() => dispatchApprovedDrafts(e.db, e.clock, { ...lease, phase: 'dispatch' }, { [fake.tool.name]: fake.tool }, phaseGate()), /no proposed drafts/);
});
