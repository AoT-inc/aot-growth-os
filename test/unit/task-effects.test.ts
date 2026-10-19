// external_effect 원장과 §3 재시도 규칙 (docs/operations/recovery.md). 멱등 키 지원/미지원 가짜 도구 두 종류로 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  beginDispatch, claimNextTask, effectKeyOf, findExpiredRuns, LeaseLostError, performEffect, planEffect, submitRun,
  takeOverExpiredRun, TaskWorker, type EffectTool, type Lease,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, asEffectTool, effectsOf, manualTimers, queuedTask, runsOf, taskStatus } from '../support/engine.ts';
import { createIdempotentFakeTool, createNonIdempotentFakeTool, type FakeTool } from '../support/fake-tool.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const LEASE_MS = 60_000;
const STEP = { stepId: 'send-report', action: 'send', target: 'mailbox:example', request: { subject: 'weekly', body: 'example' } };

function setup(t: Parameters<typeof seededDb>[0]) {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  const taskId = queuedTask(db, clock);
  const claim = (workerId = 'w1'): Lease => {
    const result = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId, actorId, adapter: 'fake-adapter', leaseMs: LEASE_MS });
    assert.ok(result.claimed);
    return result.claimed.lease;
  };
  const expireAndTakeOver = (tools: Record<string, EffectTool> = {}) => {
    clock.advance(LEASE_MS);
    const run = findExpiredRuns(db, clock.nowIso())[0]!;
    const lookups = new Map<string, { found: true; responseRef: string | null } | { found: false }>();
    for (const effect of effectsOf(db, taskId)) {
      const row = db.get<{ tool: string; effect_key: string }>('SELECT tool, effect_key FROM external_effect WHERE id = ?', [effect.id])!;
      const lookup = tools[row.tool]?.lookup;
      if (lookup) lookups.set(effect.id, lookup(row.effect_key) as { found: true; responseRef: string | null } | { found: false });
    }
    return takeOverExpiredRun(db, run, { clock, workerId: 'w2', lookups });
  };
  return { db, clock, actorId, taskId, claim, expireAndTakeOver };
}

const delivered = (fake: FakeTool) => fake.deliveries.length;

test('effect_key is deterministic: hash(task_id, step_id, canonical(request)), key order does not matter', () => {
  assert.equal(effectKeyOf('t', 's', { a: 1, b: [1, { c: 2, d: 3 }] }), effectKeyOf('t', 's', { b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(effectKeyOf('t', 's', { a: 1 }), effectKeyOf('t', 's2', { a: 1 }));
  assert.notEqual(effectKeyOf('t', 's', { a: 1 }), effectKeyOf('t2', 's', { a: 1 }));
});

test('planned -> dispatched -> confirmed; performing the same step again reuses the result (one delivery, one row)', async (t) => {
  const { db, clock, taskId, claim } = setup(t);
  const fake = createIdempotentFakeTool();
  const tool = asEffectTool(fake);
  const lease = claim();
  const first = await performEffect(db, clock, lease, tool, STEP, ALLOW_ALL_GATE);
  assert.equal(first.state, 'confirmed');
  assert.equal(first.state === 'confirmed' && first.reused, false);
  for (let i = 0; i < 4; i += 1) {
    const again = await performEffect(db, clock, lease, tool, STEP, ALLOW_ALL_GATE);
    assert.ok(again.state === 'confirmed' && again.reused);
  }
  assert.equal(delivered(fake), 1);
  assert.deepEqual(effectsOf(db, taskId).map((e) => e.state), ['confirmed']);
});

test('idempotent tool: a lost response leaves the effect unknown; the retry resends with the same key and the tool dedupes', async (t) => {
  const { db, clock, taskId, claim } = setup(t);
  const fake = createIdempotentFakeTool();
  const withoutLookup: EffectTool = { name: fake.name, supportsIdempotency: true, send: asEffectTool(fake).send };
  const lease = claim();
  fake.loseNextResponses(1);
  assert.equal((await performEffect(db, clock, lease, withoutLookup, STEP, ALLOW_ALL_GATE)).state, 'unknown');
  assert.equal((await performEffect(db, clock, lease, withoutLookup, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  assert.equal(delivered(fake), 1, 'the resend with the same key did not create a second side effect');
  assert.deepEqual(submitRun(db, clock, lease, {}), { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(taskStatus(db, taskId), 'validating');
});

test('idempotent tool with a status lookup: an unknown effect is confirmed by lookup, not resent', async (t) => {
  const { db, clock, claim } = setup(t);
  const fake = createIdempotentFakeTool();
  let sends = 0;
  const base = asEffectTool(fake);
  const tool: EffectTool = { ...base, send: (call) => (sends++, base.send(call)) };
  const lease = claim();
  fake.loseNextResponses(1);
  await performEffect(db, clock, lease, tool, STEP, ALLOW_ALL_GATE);
  const outcome = await performEffect(db, clock, lease, tool, STEP, ALLOW_ALL_GATE);
  assert.ok(outcome.state === 'confirmed' && outcome.reused);
  assert.equal(sends, 1);
  assert.equal(delivered(fake), 1);
});

test('tool without idempotency keys: unknown is never resent automatically; the run ends effect_unknown and the task needs_review', async (t) => {
  const { db, clock, taskId, claim } = setup(t);
  const fake = createNonIdempotentFakeTool();
  const tool = asEffectTool(fake);
  const lease = claim();
  fake.loseNextResponses(1);
  assert.equal((await performEffect(db, clock, lease, tool, STEP, ALLOW_ALL_GATE)).state, 'unknown');
  for (let i = 0; i < 3; i += 1) assert.equal((await performEffect(db, clock, lease, tool, STEP, ALLOW_ALL_GATE)).state, 'unknown');
  assert.equal(delivered(fake), 1, 'no resend');
  assert.throws(() => beginDispatch(db, clock, lease, planEffect(db, clock, lease, tool, STEP), ALLOW_ALL_GATE), /forbidden/);
  assert.deepEqual(submitRun(db, clock, lease, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(taskStatus(db, taskId), 'needs_review');
});

test('a worker that lost its lease sends nothing: planning and dispatching are both fenced', async (t) => {
  const { db, clock, taskId, claim, expireAndTakeOver } = setup(t);
  const fake = createNonIdempotentFakeTool();
  const tool = asEffectTool(fake);
  const lease = claim();
  const planned = planEffect(db, clock, lease, tool, STEP);
  clock.advance(LEASE_MS); // 만료 (아직 아무도 인수하지 않음)
  await assert.rejects(performEffect(db, clock, lease, tool, STEP, ALLOW_ALL_GATE), LeaseLostError);
  assert.throws(() => beginDispatch(db, clock, lease, planned, ALLOW_ALL_GATE), LeaseLostError);
  clock.set(clock.nowMs() - LEASE_MS);
  expireAndTakeOver();
  await assert.rejects(performEffect(db, clock, lease, tool, { ...STEP, stepId: 'other' }, ALLOW_ALL_GATE), LeaseLostError);
  assert.equal(delivered(fake), 0);
  assert.deepEqual(effectsOf(db, taskId).map((e) => e.state), ['planned'], 'planned only: considered not sent (recovery §4)');
});

test('takeover after a crash with a planned-only effect: the new attempt adopts it by effect_key and sends once', async (t) => {
  const { db, clock, taskId, claim, expireAndTakeOver } = setup(t);
  const fake = createNonIdempotentFakeTool();
  const tool = asEffectTool(fake);
  planEffect(db, clock, claim(), tool, STEP);
  assert.equal(expireAndTakeOver()?.taskStatus, 'queued');
  const next = claim('w2');
  assert.equal((await performEffect(db, clock, next, tool, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  assert.equal(delivered(fake), 1);
  const [effect] = effectsOf(db, taskId);
  assert.equal(effect?.task_run_id, next.runId);
});

test('takeover with a dispatched effect, idempotent tool: lookup confirms it, the task is requeued and the step is not resent', async (t) => {
  const { db, clock, taskId, claim, expireAndTakeOver } = setup(t);
  const fake = createIdempotentFakeTool();
  const tool = asEffectTool(fake);
  const lease = claim();
  const effect = planEffect(db, clock, lease, tool, STEP);
  beginDispatch(db, clock, lease, effect, ALLOW_ALL_GATE);
  fake.call({ effectKey: effect.effect_key, payload: STEP.request }); // 전달됐지만 기록 전에 프로세스가 죽었다
  assert.equal(expireAndTakeOver({ [tool.name]: tool })?.taskStatus, 'queued');
  assert.equal(taskStatus(db, taskId), 'queued');
  assert.deepEqual(effectsOf(db, taskId).map((e) => e.state), ['confirmed']);
  const outcome = await performEffect(db, clock, claim('w2'), tool, STEP, ALLOW_ALL_GATE);
  assert.ok(outcome.state === 'confirmed' && outcome.reused);
  assert.equal(delivered(fake), 1);
});

test('takeover with a dispatched effect, idempotent tool without lookup: unknown, requeued, resent once with the same key', async (t) => {
  const { db, clock, taskId, claim, expireAndTakeOver } = setup(t);
  const fake = createIdempotentFakeTool();
  const tool: EffectTool = { name: fake.name, supportsIdempotency: true, send: asEffectTool(fake).send };
  const lease = claim();
  const effect = planEffect(db, clock, lease, tool, STEP);
  beginDispatch(db, clock, lease, effect, ALLOW_ALL_GATE);
  fake.call({ effectKey: effect.effect_key, payload: STEP.request });
  const result = expireAndTakeOver();
  assert.deepEqual(result && [result.outcome, result.taskStatus], ['lease_expired', 'queued']);
  assert.deepEqual(effectsOf(db, taskId).map((e) => e.state), ['unknown']);
  assert.equal((await performEffect(db, clock, claim('w2'), tool, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  assert.equal(delivered(fake), 1);
});

test('takeover with a dispatched effect, tool without idempotency keys and no lookup: effect_unknown, needs_review, nothing resent', (t) => {
  const { db, clock, taskId, claim, expireAndTakeOver } = setup(t);
  const fake = createNonIdempotentFakeTool();
  const tool = asEffectTool(fake);
  const lease = claim();
  const effect = planEffect(db, clock, lease, tool, STEP);
  beginDispatch(db, clock, lease, effect, ALLOW_ALL_GATE);
  fake.call({ effectKey: effect.effect_key, payload: STEP.request });
  const result = expireAndTakeOver({ [tool.name]: tool });
  assert.deepEqual(result && [result.outcome, result.taskStatus], ['effect_unknown', 'needs_review']);
  assert.deepEqual(runsOf(db, taskId).map((r) => r.outcome), ['effect_unknown']);
  assert.deepEqual(effectsOf(db, taskId).map((e) => e.state), ['unknown']);
  assert.equal(delivered(fake), 1);
});

test('worker: performEffect through the run context uses the registered tool and the run fences', async (t) => {
  const { db, clock, actorId, taskId } = setup(t);
  const fake = createIdempotentFakeTool();
  const tool = asEffectTool(fake);
  const worker = new TaskWorker({
    db, clock, workerId: 'w1', actorId, adapter: 'fake-adapter', gate: ALLOW_ALL_GATE, timers: manualTimers(),
    tools: { [tool.name]: tool },
    executor: {
      async execute(context) {
        const outcome = await context.performEffect(tool.name, STEP);
        await assert.rejects(context.performEffect('not-registered', STEP), /not registered/);
        return { result: outcome };
      },
    },
  });
  assert.deepEqual((await worker.tick()).executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(delivered(fake), 1);
  assert.equal(taskStatus(db, taskId), 'validating');
});
