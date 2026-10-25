// submitRun 의 업무 범위 unknown 관문 (docs/operations/recovery.md §3 열린 항목).
// 이 run 이 아니라 업무에 unknown 이 남아 있으면(재전송 가능이든 불가든) validating 으로 넘기지 않고 needs_review 로 보낸다.
// 시각은 FakeClock 만 쓴다. 같은 lease(60초) 안에서 시각을 움직이는 시험은 보존 기간을 그에 맞춰 잡는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExternalEffectRow } from '@aot/domain';
import {
  claimNextTask, findExpiredRuns, performEffect, submitRun, takeOverExpiredRun, type EffectTool, type Lease,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, asEffectTool, effectsOf, queuedTask, taskStatus } from '../support/engine.ts';
import { createIdempotentFakeTool, createNonIdempotentFakeTool, type FakeTool } from '../support/fake-tool.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const LEASE_MS = 60_000;
/** 같은 lease 안에서 창을 넘기는 시험용 (창 = 10초) */
const SHORT = 20_000;
/** 인수 시점(60초)엔 창이 열려 있고(300초), 2차 lease 안에서 닫히게 하는 보존 기간 (창 = 65초) */
const MID = 130_000;
const LONG = 600_000;
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
  const expireAndTakeOver = () => {
    clock.advance(LEASE_MS);
    const run = findExpiredRuns(db, clock.nowIso())[0]!;
    return takeOverExpiredRun(db, run, { clock, workerId: 'w2', lookups: new Map() });
  };
  const rows = (): ExternalEffectRow[] => db.all<ExternalEffectRow>('SELECT * FROM external_effect WHERE task_id = ? ORDER BY planned_at, id', [taskId]);
  const row = (): ExternalEffectRow => rows()[0]!;
  /** 업무의 가장 최근 running → needs_review 전이 이유 */
  const reviewReason = (id = taskId): string => String(db.get(
    "SELECT reason FROM task_transition WHERE task_id = ? AND from_status = 'running' AND to_status = 'needs_review' ORDER BY id DESC LIMIT 1", [id],
  )?.['reason']);
  return { db, clock, actorId, taskId, claim, expireAndTakeOver, rows, row, reviewReason };
}

/** 응답을 잃고 `unknown` 이 된 효과 하나를 만든다 */
async function loseResponse(env: ReturnType<typeof setup>, tool: EffectTool, fake: FakeTool, lease: Lease, step = STEP) {
  fake.loseNextResponses(1);
  assert.equal((await performEffect(env.db, env.clock, lease, tool, step, ALLOW_ALL_GATE)).state, 'unknown');
}

const RESENDABLE = /resendable/;
const UNRESENDABLE = /may not be resent/;

/** 1차 run 이 창 안의 멱등 unknown 을 남기고 인수되어 queued 로 돌아간 뒤, 2차 run 이 그 단계를 다시 계획하지 않는 상황 */
async function leftByPreviousRun(t: Parameters<typeof seededDb>[0], retentionMs: number) {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs });
  const tool = asEffectTool(fake);
  const lease1 = env.claim();
  await loseResponse(env, tool, fake, lease1);
  const before = env.row();
  assert.equal(env.expireAndTakeOver()?.taskStatus, 'queued');
  const lease2 = env.claim('w2');
  assert.notEqual(lease2.runId, lease1.runId);
  return { ...env, fake, tool, lease1, lease2, before };
}

test('(1) an in-window idempotent unknown of this run blocks submit: effect_unknown/needs_review with the resendable reason, row untouched', async (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const lease = env.claim();
  await loseResponse(env, asEffectTool(fake), fake, lease);
  env.clock.advance(SHORT / 2); // 정확히 50%: 아직 창 안

  assert.deepEqual(submitRun(env.db, env.clock, lease, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');
  assert.match(env.reviewReason(), RESENDABLE);
  assert.doesNotMatch(env.reviewReason(), UNRESENDABLE);
  assert.equal(env.row().state, 'unknown');
  assert.equal(Number(env.row().supports_idempotency), 1, '재전송 가능 행은 굳히지 않는다');
  assert.equal(Number(env.row().idempotency_retention_ms), SHORT);
  assert.equal(fake.deliveries.length, 1);
});

test('(2) an in-window unknown left by a previous run blocks the new run\'s submit; the row stays with the previous run', async (t) => {
  const env = await leftByPreviousRun(t, LONG);
  assert.equal(env.row().state, 'unknown');

  assert.deepEqual(submitRun(env.db, env.clock, env.lease2, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');
  assert.match(env.reviewReason(), RESENDABLE);
  assert.doesNotMatch(env.reviewReason(), UNRESENDABLE);
  assert.equal(env.row().task_run_id, env.lease1.runId, '다른 run 의 행을 이 run 이 바꾸지 않는다');
  assert.deepEqual(env.row(), env.before, '행은 통째로 그대로');
});

test('(3) a closed-window unknown left by a previous run blocks submit, is tightened to (0, NULL), planned_at untouched', async (t) => {
  const env = await leftByPreviousRun(t, MID);
  assert.equal(Number(env.row().supports_idempotency), 1);
  env.clock.advance(LEASE_MS / 2); // 계획 후 90초 > 창 65초, lease 는 아직 유효

  assert.deepEqual(submitRun(env.db, env.clock, env.lease2, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');
  assert.match(env.reviewReason(), UNRESENDABLE);
  assert.equal(env.row().state, 'unknown');
  assert.equal(Number(env.row().supports_idempotency), 0);
  assert.equal(env.row().idempotency_retention_ms, null);
  assert.equal(env.row().planned_at, env.before.planned_at);
  assert.equal(env.row().task_run_id, env.lease1.runId);
});

test('(4) once every unknown is confirmed (resend or lookup) submit still goes to validating; a task without effects too', async (t) => {
  // 같은 키 재전송으로 확인
  const env0 = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: LONG });
  const noLookup: EffectTool = { name: fake.name, actions: { send: { idempotency: { supported: true, retention_ms: LONG } } }, send: asEffectTool(fake).send };
  const lease0 = env0.claim();
  await loseResponse(env0, noLookup, fake, lease0);
  assert.equal(env0.expireAndTakeOver()?.taskStatus, 'queued');
  const resend = { ...env0, lease2: env0.claim('w2') };
  assert.equal((await performEffect(resend.db, resend.clock, resend.lease2, noLookup, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  assert.deepEqual(effectsOf(resend.db, resend.taskId).map((e) => e.state), ['confirmed']);
  assert.deepEqual(submitRun(resend.db, resend.clock, resend.lease2, {}), { outcome: 'submitted', taskStatus: 'validating' });

  // 조회로 확인
  const env = setup(t);
  const fake2 = createIdempotentFakeTool({ retentionMs: LONG });
  const tool = asEffectTool(fake2);
  const lease = env.claim();
  await loseResponse(env, tool, fake2, lease);
  env.clock.advance(SHORT);
  const outcome = await performEffect(env.db, env.clock, lease, tool, STEP, ALLOW_ALL_GATE);
  assert.ok(outcome.state === 'confirmed' && outcome.reused);
  assert.deepEqual(submitRun(env.db, env.clock, lease, {}), { outcome: 'submitted', taskStatus: 'validating' });

  // 부작용 없음
  const plain = setup(t);
  assert.deepEqual(submitRun(plain.db, plain.clock, plain.claim(), {}), { outcome: 'submitted', taskStatus: 'validating' });
});

test('(5) unknown effects of another task (in-window and closed) do not affect this task\'s submit and stay unchanged', async (t) => {
  const env = setup(t);
  const leaseA = env.claim();
  const other = queuedTask(env.db, env.clock, { inputs: [{ name: 'n', ref: 'r:other', kind: 'k' }] }, 'task-other');
  const leaseB = claimNextTask(env.db, { clock: env.clock, gate: ALLOW_ALL_GATE, workerId: 'w9', actorId: env.actorId, adapter: 'fake-adapter', leaseMs: LEASE_MS }).claimed!.lease;
  assert.equal(leaseB.taskId, other);

  const fakeClosed = createIdempotentFakeTool({ retentionMs: SHORT, name: 'tool-closed' });
  const fakeOpen = createIdempotentFakeTool({ retentionMs: LONG, name: 'tool-open' });
  await loseResponse(env, asEffectTool(fakeClosed), fakeClosed, leaseB, { ...STEP, stepId: 'step-closed' });
  await loseResponse(env, asEffectTool(fakeOpen), fakeOpen, leaseB, { ...STEP, stepId: 'step-open' });
  env.clock.advance(SHORT / 2 + 1); // 앞의 것만 창이 닫힌 상태
  const snapshot = () => env.db.all<ExternalEffectRow>('SELECT * FROM external_effect WHERE task_id = ? ORDER BY id', [other]);
  const before = snapshot();
  assert.equal(before.length, 2);

  assert.deepEqual(submitRun(env.db, env.clock, leaseA, {}), { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(taskStatus(env.db, env.taskId), 'validating');
  assert.deepEqual(snapshot(), before, '다른 업무 행은 그대로');
  assert.equal(taskStatus(env.db, other), 'running');
});

test('(6) abnormal: a dispatched row left on another (closed) run blocks submit fail-closed and is not touched', async (t) => {
  const env = setup(t);
  const lease1 = env.claim();
  assert.equal(env.expireAndTakeOver()?.taskStatus, 'queued'); // 부작용 없이 run 1 이 닫힌다
  const lease2 = env.claim('w2');
  const at = env.clock.nowIso();
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, idempotency_retention_ms, planned_at, at)
     VALUES ('stray-1', 'key-stray-1', ?, ?, 'example-tool', 'send', 'mailbox:example', 'h', 'dispatched', 1, ?, ?, ?)`,
    [env.taskId, lease1.runId, LONG, at, at],
  ));
  const before = env.db.get<ExternalEffectRow>("SELECT * FROM external_effect WHERE id = 'stray-1'")!;

  assert.deepEqual(submitRun(env.db, env.clock, lease2, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');
  assert.match(env.reviewReason(), UNRESENDABLE);
  assert.deepEqual(env.db.get<ExternalEffectRow>("SELECT * FROM external_effect WHERE id = 'stray-1'"), before, '다른 run 의 행은 바꾸지 않는다');
  assert.equal(before.state, 'dispatched');
});

test('(5b) a plain (non-idempotent) tool of another task also leaves this task alone', async (t) => {
  const env = setup(t);
  const leaseA = env.claim();
  queuedTask(env.db, env.clock, { inputs: [{ name: 'n', ref: 'r:other', kind: 'k' }] }, 'task-other');
  const leaseB = claimNextTask(env.db, { clock: env.clock, gate: ALLOW_ALL_GATE, workerId: 'w9', actorId: env.actorId, adapter: 'fake-adapter', leaseMs: LEASE_MS }).claimed!.lease;
  const fake = createNonIdempotentFakeTool();
  await loseResponse(env, asEffectTool(fake), fake, leaseB);
  assert.deepEqual(submitRun(env.db, env.clock, leaseA, {}), { outcome: 'submitted', taskStatus: 'validating' });
});
