// (도구, action) 멱등 선언 · 키 보존 기간 · planned_at 의 엔진 동작 (docs/operations/recovery.md §3 "재전송 창").
// 시각은 FakeClock 만 쓴다. 같은 lease 안에서 시각을 움직이는 시험은 보존 기간을 lease(60초)보다 짧게 잡는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExternalEffectRow, TaskPolicyGate } from '@aot/domain';
import {
  beginDispatch, claimNextTask, EffectDeclarationError, failRun, findExpiredRuns, killRun, LeaseLostError, performEffect, planEffect, StaleStateError,
  submitRun, takeOverExpiredRun, TaskWorker, transitionEffect, type EffectTool, type Lease,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, asEffectTool, effectsOf, manualTimers, queuedTask, runsOf, taskStatus } from '../support/engine.ts';
import { createIdempotentFakeTool, createNonIdempotentFakeTool, type FakeTool } from '../support/fake-tool.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const LEASE_MS = 60_000;
/** 같은 lease 안에서 창을 넘기는 시험용 (창 = 10초) */
const SHORT = 20_000;
/** 인수 시험용: 창(300초)이 lease 보다 길다 */
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
  const expireAndTakeOver = (tools: Record<string, EffectTool> = {}, consumeAttempt = false) => {
    clock.advance(LEASE_MS);
    const run = findExpiredRuns(db, clock.nowIso())[0]!;
    const lookups = new Map<string, { found: true; responseRef: string | null } | { found: false }>();
    for (const effect of effectsOf(db, taskId)) {
      const row = db.get<{ tool: string; effect_key: string }>('SELECT tool, effect_key FROM external_effect WHERE id = ?', [effect.id])!;
      const lookup = tools[row.tool]?.lookup;
      if (lookup) lookups.set(effect.id, lookup(row.effect_key) as { found: true; responseRef: string | null } | { found: false });
    }
    return takeOverExpiredRun(db, run, { clock, workerId: 'w2', lookups, consumeAttempt });
  };
  const row = (): ExternalEffectRow => db.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE task_id = ?', [taskId])!;
  const attempts = (): number => Number(db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts']);
  return { db, clock, actorId, taskId, claim, expireAndTakeOver, row, attempts };
}

/** send 호출 키를 센다 (조회 함수는 그대로 둔다) */
function counting(tool: EffectTool): EffectTool & { readonly keys: string[] } {
  const keys: string[] = [];
  return { ...tool, keys, send: (call) => (keys.push(call.effectKey), tool.send(call)) };
}

/** lookup 이 없는 멱등 도구 */
function noLookup(fake: FakeTool, retentionMs: number): EffectTool & { readonly keys: string[] } {
  return counting({ name: fake.name, actions: { send: { idempotency: { supported: true, retention_ms: retentionMs } } }, send: asEffectTool(fake).send });
}

const spyGate = () => {
  const spy = { calls: 0 };
  const gate: TaskPolicyGate = { ...ALLOW_ALL_GATE, beforeEffect: () => (spy.calls += 1, { decision: 'allow' }) };
  return { spy, gate };
};

/** 응답을 잃고 `unknown` 이 된 효과 하나를 만든다 (같은 lease) */
async function loseResponse(env: ReturnType<typeof setup>, tool: EffectTool, fake: FakeTool, lease: Lease) {
  fake.loseNextResponses(1);
  const outcome = await performEffect(env.db, env.clock, lease, tool, STEP, ALLOW_ALL_GATE);
  assert.equal(outcome.state, 'unknown');
  return outcome;
}

test('planned_at is written once at INSERT; every transition moves `at` but never planned_at; transitionEffect cannot set the snapshot columns', async (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool = noLookup(fake, SHORT);
  const lease = env.claim();
  const plannedAt = env.clock.nowIso();

  const seen: { state: string; at: string; planned_at: string }[] = [];
  const snap = () => seen.push(env.db.get<{ state: string; at: string; planned_at: string }>('SELECT state, at, planned_at FROM external_effect WHERE task_id = ?', [env.taskId])!);
  planEffect(env.db, env.clock, lease, tool, STEP);
  snap();
  env.clock.advance(1000);
  await loseResponse(env, tool, fake, lease);
  snap();
  env.clock.advance(1000);
  assert.equal((await performEffect(env.db, env.clock, lease, tool, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  snap();

  assert.deepEqual(seen.map((s) => s.state), ['planned', 'unknown', 'confirmed']);
  assert.equal(new Set(seen.map((s) => s.at)).size, 3, '전이마다 at 이 바뀐다');
  assert.deepEqual(seen.map((s) => s.planned_at), [plannedAt, plannedAt, plannedAt]);

  const effectId = env.row().id;
  for (const column of ['planned_at', 'supports_idempotency', 'idempotency_retention_ms']) {
    assert.throws(
      () => env.db.writeTx((tx) => transitionEffect(tx, { effectId, from: 'confirmed', to: 'compensated', by: 'system', now: env.clock.nowIso(), set: { [column]: column === 'planned_at' ? '2030-01-01T00:00:00.000Z' : 7 } })),
      /cannot be set/, column,
    );
  }
  assert.equal(env.row().state, 'confirmed', '거부된 전이는 아무것도 바꾸지 않는다');
  assert.equal(env.row().planned_at, plannedAt);
});

test('INSERT snapshot: idempotent -> (1, retention), plain -> (0, NULL); the CHECK rejects inconsistent rows (no upper bound, D2)', async (t) => {
  const idem = setup(t);
  const idemTool = noLookup(createIdempotentFakeTool({ retentionMs: 123_456 }), 123_456);
  const lease = idem.claim();
  planEffect(idem.db, idem.clock, lease, idemTool, STEP);
  assert.equal(Number(idem.row().supports_idempotency), 1);
  assert.equal(Number(idem.row().idempotency_retention_ms), 123_456);
  assert.equal(idem.row().planned_at, idem.clock.nowIso());

  const plain = setup(t);
  planEffect(plain.db, plain.clock, plain.claim(), asEffectTool(createNonIdempotentFakeTool()), STEP);
  assert.equal(Number(plain.row().supports_idempotency), 0);
  assert.equal(plain.row().idempotency_retention_ms, null);

  const insert = (id: string, supports: number, retention: number | null) => idem.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, idempotency_retention_ms, planned_at, at)
     VALUES (?, ?, ?, ?, 'example-tool', 'send', 'mailbox:example', 'h', 'planned', ?, ?, ?, ?)`,
    [id, `key-${id}`, lease.taskId, lease.runId, supports, retention, idem.clock.nowIso(), idem.clock.nowIso()],
  ));
  insert('ok-1', 0, null);
  insert('ok-2', 1, 5);
  insert('ok-3', 1, 604_800_001);
  insert('ok-4', 1, Number.MAX_SAFE_INTEGER);
  for (const [supports, retention] of [[1, null], [0, 5], [1, 0], [1, -1], [2, null]] as const) {
    assert.throws(() => insert(`bad-${supports}-${retention}`, supports, retention), /CHECK|constraint/i, `(${supports}, ${retention})`);
  }
});

test('inside the window at exactly 50%: a tool without lookup is resent once with the same key and the run is submitted', async (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool = noLookup(fake, SHORT);
  const lease = env.claim();
  await loseResponse(env, tool, fake, lease);
  env.clock.advance(SHORT / 2);
  assert.equal((await performEffect(env.db, env.clock, lease, tool, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  assert.equal(tool.keys.length, 2);
  assert.equal(tool.keys[0], tool.keys[1], '같은 키로 재전송');
  assert.equal(fake.deliveries.length, 1);
  assert.deepEqual(submitRun(env.db, env.clock, lease, {}), { outcome: 'submitted', taskStatus: 'validating' });
});

test('beyond the window, no lookup: nothing is resent, beginDispatch refuses before the policy gate, and the run ends effect_unknown (settle gap)', async (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool = noLookup(fake, SHORT);
  const lease = env.claim();
  await loseResponse(env, tool, fake, lease);
  env.clock.advance(SHORT / 2 + 1);

  assert.equal((await performEffect(env.db, env.clock, lease, tool, STEP, ALLOW_ALL_GATE)).state, 'unknown');
  assert.equal(tool.keys.length, 1, '재전송 없음');
  assert.equal(env.row().state, 'unknown');

  const { spy, gate } = spyGate();
  const start = beginDispatch(env.db, env.clock, lease, planEffect(env.db, env.clock, lease, tool, STEP), gate);
  assert.equal(start.started, false);
  assert.ok(!start.started);
  assert.equal(start.code, 'not_resendable');
  assert.equal(start.runStopped, false);
  assert.equal(spy.calls, 0, '창이 닫혔으면 정책 게이트(= policy_decision 기록)에 가지 않는다');
  assert.equal(env.row().state, 'unknown');

  assert.deepEqual(submitRun(env.db, env.clock, lease, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');
  assert.equal(fake.deliveries.length, 1);
});

test('beyond the window, with lookup: found -> confirmed without sending; not found -> still unknown without sending', async (t) => {
  const found = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const withLookup = counting(asEffectTool(fake));
  const lease = found.claim();
  await loseResponse(found, withLookup, fake, lease);
  found.clock.advance(SHORT);
  const outcome = await performEffect(found.db, found.clock, lease, withLookup, STEP, ALLOW_ALL_GATE);
  assert.ok(outcome.state === 'confirmed' && outcome.reused);
  assert.equal(withLookup.keys.length, 1);

  // 조회가 못 찾는다 = 재전송 사유가 아니다. 지원 선언이 있든 없든 마찬가지.
  const notFound = { found: false } as const;
  const variants: [string, (f: FakeTool) => EffectTool][] = [
    ['idempotent', (f) => ({ ...asEffectTool(f), lookup: () => notFound })],
    ['unsupported + carrier none', (f) => ({
      name: f.name, actions: { send: { idempotency: { supported: false }, effect_key_carrier: 'none' } }, send: asEffectTool(f).send, lookup: () => notFound,
    })],
  ];
  for (const [label, make] of variants) {
    const env = setup(t);
    const f = createIdempotentFakeTool({ retentionMs: SHORT });
    const tool = counting(make(f));
    const l = env.claim();
    await loseResponse(env, tool, f, l);
    env.clock.advance(SHORT);
    assert.equal((await performEffect(env.db, env.clock, l, tool, STEP, ALLOW_ALL_GATE)).state, 'unknown', label);
    assert.equal(tool.keys.length, 1, `${label}: 재전송 없음`);
    assert.equal(env.row().state, 'unknown', label);
  }
});

test('the window closing during lookup: the in-transaction check is the authority (unknown, nothing sent)', async (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool = counting({
    ...asEffectTool(fake),
    lookup: () => {
      env.clock.advance(SHORT); // 조회 중에 창이 닫힌다
      return { found: false };
    },
  });
  const lease = env.claim();
  fake.loseNextResponses(1);
  assert.equal((await performEffect(env.db, env.clock, lease, tool, STEP, ALLOW_ALL_GATE)).state, 'unknown');
  const before = tool.keys.length;
  const { spy, gate } = spyGate();
  assert.equal((await performEffect(env.db, env.clock, lease, tool, STEP, gate)).state, 'unknown');
  assert.equal(tool.keys.length, before, '재전송 없음');
  assert.equal(spy.calls, 0);
  assert.equal(env.row().state, 'unknown');
});

test('beginDispatch re-reads the row inside the transaction: forged, stale and foreign caller objects are refused', async (t) => {
  const env = setup(t);
  const fake = createNonIdempotentFakeTool();
  const tool = counting(asEffectTool(fake));
  const lease = env.claim();
  await loseResponse(env, tool, fake, lease);
  const effect = env.row();
  assert.equal(Number(effect.supports_idempotency), 0);

  // 호출자가 지원 표시를 위조해도 행 기준으로 막힌다
  const forged = { id: effect.id, state: 'unknown', supports_idempotency: 1, tool: effect.tool, action: effect.action, target: effect.target };
  assert.throws(() => beginDispatch(env.db, env.clock, lease, forged as never, ALLOW_ALL_GATE), /forbidden/);
  // 호출자가 아는 상태가 낡았다
  assert.throws(() => beginDispatch(env.db, env.clock, lease, { ...forged, state: 'planned' } as never, ALLOW_ALL_GATE), StaleStateError);
  assert.equal(tool.keys.length, 1);
  assert.equal(env.row().state, 'unknown');

  // 다른 run 의 효과
  const other = queuedTask(env.db, env.clock, { inputs: [{ name: 'n', ref: 'r:other', kind: 'k' }] }, 'task-other');
  const otherLease = claimNextTask(env.db, { clock: env.clock, gate: ALLOW_ALL_GATE, workerId: 'w9', actorId: env.actorId, adapter: 'fake-adapter', leaseMs: LEASE_MS }).claimed!.lease;
  assert.equal(otherLease.taskId, other);
  assert.throws(() => beginDispatch(env.db, env.clock, otherLease, forged as never, ALLOW_ALL_GATE), StaleStateError);
});

test('failRun and killRun see an expired-window unknown effect: effect_unknown + needs_review (attempts still consumed by failRun)', async (t) => {
  const fail = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool = noLookup(fake, SHORT);
  const lease = fail.claim();
  await loseResponse(fail, tool, fake, lease);
  fail.clock.advance(SHORT / 2 + 1);
  assert.deepEqual(failRun(fail.db, fail.clock, lease, { outcome: 'error', reason: 'boom', retryDelayMs: 1000 }), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(fail.attempts(), 1);
  assert.deepEqual(runsOf(fail.db, fail.taskId).map((r) => r.outcome), ['effect_unknown']);

  const kill = setup(t);
  const fake2 = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool2 = noLookup(fake2, SHORT);
  const lease2 = kill.claim();
  await loseResponse(kill, tool2, fake2, lease2);
  kill.clock.advance(SHORT / 2 + 1);
  assert.deepEqual(killRun(kill.db, kill.clock, lease2, { reason: 'budget_exceeded', detail: 'over', retryDelayMs: 1000 }), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
});

test('failRun with an in-window unknown effect keeps the old behaviour (retry_wait): the window is what decides', async (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool = noLookup(fake, SHORT);
  const lease = env.claim();
  await loseResponse(env, tool, fake, lease);
  env.clock.advance(SHORT / 2);
  assert.deepEqual(failRun(env.db, env.clock, lease, { outcome: 'error', reason: 'boom', retryDelayMs: 1000 }), { outcome: 'error', taskStatus: 'retry_wait' });
});

test('takeover (b): a dispatched idempotent effect past its window goes straight to effect_unknown/needs_review, no new run, no attempt consumed', (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool = noLookup(fake, SHORT);
  const lease = env.claim();
  beginDispatch(env.db, env.clock, lease, planEffect(env.db, env.clock, lease, tool, STEP), ALLOW_ALL_GATE);
  fake.call({ effectKey: env.row().effect_key, payload: STEP.request });
  env.clock.advance(SHORT / 2 + 1);

  const result = env.expireAndTakeOver();
  assert.deepEqual(result && [result.outcome, result.taskStatus], ['effect_unknown', 'needs_review']);
  assert.deepEqual(effectsOf(env.db, env.taskId).map((e) => e.state), ['unknown']);
  assert.equal(env.attempts(), 0);
  assert.equal(claimNextTask(env.db, { clock: env.clock, gate: ALLOW_ALL_GATE, workerId: 'w2', actorId: env.actorId, adapter: 'fake-adapter', leaseMs: LEASE_MS }).claimed, null);
  assert.equal(fake.deliveries.length, 1);
});

test('takeover (b) with consumeAttempt on the last attempt: needs_review, not failed', (t) => {
  const env = setup(t);
  env.db.writeTx((tx) => tx.run('UPDATE task SET max_attempts = 1 WHERE id = ?', [env.taskId]));
  const fake = createIdempotentFakeTool({ retentionMs: SHORT });
  const tool = noLookup(fake, SHORT);
  const lease = env.claim();
  beginDispatch(env.db, env.clock, lease, planEffect(env.db, env.clock, lease, tool, STEP), ALLOW_ALL_GATE);
  env.clock.advance(SHORT / 2 + 1);
  const result = env.expireAndTakeOver({}, true);
  assert.deepEqual(result && [result.outcome, result.taskStatus], ['effect_unknown', 'needs_review']);
  assert.equal(env.attempts(), 0);
});

test('takeover decides at exactly 50% of retention: open -> queued, one millisecond less retention -> needs_review', (t) => {
  // 계획 시각에서 인수까지 정확히 LEASE_MS 가 흐른다 (claim 직후 plan)
  for (const [retention, status] of [[LEASE_MS * 2, 'queued'], [LEASE_MS * 2 - 1, 'needs_review']] as const) {
    const env = setup(t);
    const fake = createIdempotentFakeTool({ retentionMs: retention });
    const tool = noLookup(fake, retention);
    const lease = env.claim();
    beginDispatch(env.db, env.clock, lease, planEffect(env.db, env.clock, lease, tool, STEP), ALLOW_ALL_GATE);
    assert.equal(env.expireAndTakeOver()?.taskStatus, status, `retention ${retention}`);
  }
});

test('takeover without the tool registered decides from the row alone: inside the window -> queued, beyond -> needs_review', (t) => {
  for (const [retention, status] of [[LONG, 'queued'], [SHORT, 'needs_review']] as const) {
    const env = setup(t);
    const fake = createIdempotentFakeTool({ retentionMs: retention });
    const tool = noLookup(fake, retention);
    const lease = env.claim();
    beginDispatch(env.db, env.clock, lease, planEffect(env.db, env.clock, lease, tool, STEP), ALLOW_ALL_GATE);
    assert.equal(env.expireAndTakeOver({})?.taskStatus, status, `retention ${retention}`);
  }
});

/** 1차 lease 가 응답을 잃은 뒤 인수되고, 2차 lease 가 선언이 바뀐 도구(v2)로 이어받는 상황 */
async function adopted(t: Parameters<typeof seededDb>[0]) {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: LONG });
  const v1 = noLookup(fake, LONG);
  await loseResponse(env, v1, fake, env.claim());
  assert.equal(env.expireAndTakeOver({})?.taskStatus, 'queued');
  const lease2 = env.claim('w2');
  const withActions = (actions: EffectTool['actions']): EffectTool & { readonly keys: string[] } => counting({ name: fake.name, actions, send: asEffectTool(fake).send });
  return { ...env, fake, v1, lease2, withActions };
}

test('declaration change on adoption: shorter retention tightens the row and the window is computed with it', async (t) => {
  const closed = await adopted(t);
  const v2 = closed.withActions({ send: { idempotency: { supported: true, retention_ms: 100_000 } } }); // 창 50초 < 경과 60초
  assert.equal((await performEffect(closed.db, closed.clock, closed.lease2, v2, STEP, ALLOW_ALL_GATE)).state, 'unknown');
  assert.equal(v2.keys.length, 0);
  assert.equal(Number(closed.row().idempotency_retention_ms), 100_000);
  assert.equal(Number(closed.row().supports_idempotency), 1);
  assert.equal(closed.row().task_run_id, closed.lease2.runId);
  assert.deepEqual(submitRun(closed.db, closed.clock, closed.lease2, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });

  const open = await adopted(t);
  const v2open = open.withActions({ send: { idempotency: { supported: true, retention_ms: 200_000 } } }); // 창 100초 > 경과 60초
  assert.equal((await performEffect(open.db, open.clock, open.lease2, v2open, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  assert.equal(v2open.keys.length, 1);
  assert.equal(Number(open.row().idempotency_retention_ms), 200_000);
});

test('declaration change on adoption: v2 unsupported -> row (0, NULL), nothing sent, needs_review', async (t) => {
  const env = await adopted(t);
  const v2 = env.withActions({ send: { idempotency: { supported: false } } });
  assert.equal((await performEffect(env.db, env.clock, env.lease2, v2, STEP, ALLOW_ALL_GATE)).state, 'unknown');
  assert.equal(v2.keys.length, 0);
  assert.equal(Number(env.row().supports_idempotency), 0);
  assert.equal(env.row().idempotency_retention_ms, null);
  assert.deepEqual(submitRun(env.db, env.clock, env.lease2, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
});

test('declaration change on adoption: v2 with a longer retention never loosens the row', async (t) => {
  const env = await adopted(t);
  const v2 = env.withActions({ send: { idempotency: { supported: true, retention_ms: LONG * 2 } } });
  assert.equal((await performEffect(env.db, env.clock, env.lease2, v2, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  assert.equal(Number(env.row().idempotency_retention_ms), LONG);
});

test('declaration change on adoption: v2 without the action does not throw; the unknown effect is adopted and tightened to (0, NULL)', async (t) => {
  const env = await adopted(t);
  const v2 = env.withActions({ other: { idempotency: { supported: true, retention_ms: LONG } } });
  assert.equal((await performEffect(env.db, env.clock, env.lease2, v2, STEP, ALLOW_ALL_GATE)).state, 'unknown');
  assert.equal(v2.keys.length, 0);
  assert.equal(env.row().task_run_id, env.lease2.runId, '인수는 롤백되지 않는다');
  assert.equal(Number(env.row().supports_idempotency), 0);
  assert.equal(env.row().idempotency_retention_ms, null);
  assert.deepEqual(submitRun(env.db, env.clock, env.lease2, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
});

test('undeclared action on the first plan: EffectDeclarationError, no row, nothing sent; LeaseLostError wins when the lease is gone', async (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool();
  const tool = counting({ name: fake.name, actions: { other: { idempotency: { supported: false } } }, send: asEffectTool(fake).send });
  const lease = env.claim();
  assert.throws(() => planEffect(env.db, env.clock, lease, tool, STEP), (error: unknown) => {
    assert.ok(error instanceof EffectDeclarationError);
    assert.equal(error.tool, fake.name);
    assert.deepEqual(error.errors.map((e) => e.code), ['action_undeclared']);
    return true;
  });
  await assert.rejects(performEffect(env.db, env.clock, lease, tool, STEP, ALLOW_ALL_GATE), EffectDeclarationError);
  assert.equal(tool.keys.length, 0);
  assert.deepEqual(effectsOf(env.db, env.taskId), []);

  env.clock.advance(LEASE_MS); // lease 만료
  assert.throws(() => planEffect(env.db, env.clock, lease, tool, STEP), LeaseLostError);
});

test('undeclared action on an existing planned row: the throw rolls everything back; a confirmed row is reused without consulting the declaration', async (t) => {
  const env = setup(t);
  const fake = createIdempotentFakeTool({ retentionMs: LONG });
  const good = noLookup(fake, LONG);
  const bad: EffectTool = { name: fake.name, actions: { other: { idempotency: { supported: false } } }, send: good.send };
  const lease = env.claim();
  planEffect(env.db, env.clock, lease, good, STEP);
  assert.throws(() => planEffect(env.db, env.clock, lease, bad, STEP), EffectDeclarationError);
  assert.equal(env.row().state, 'planned');
  assert.equal(Number(env.row().supports_idempotency), 1, '강화도 함께 롤백된다');
  assert.equal(Number(env.row().idempotency_retention_ms), LONG);

  assert.equal((await performEffect(env.db, env.clock, lease, good, STEP, ALLOW_ALL_GATE)).state, 'confirmed');
  const again = await performEffect(env.db, env.clock, lease, bad, STEP, ALLOW_ALL_GATE);
  assert.ok(again.state === 'confirmed' && again.reused);
});

test('TaskWorker constructor: an invalid declaration or a tools-map key that differs from tool.name fails fast', (t) => {
  const env = setup(t);
  const build = (tools: Record<string, EffectTool>) => () => new TaskWorker({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: env.actorId, adapter: 'fake-adapter', gate: ALLOW_ALL_GATE, timers: manualTimers(), tools,
    executor: { async execute() { return { result: null }; } },
  });
  const send = () => ({ status: 'confirmed' as const, responseRef: null });
  const codesOf = (tools: Record<string, EffectTool>): string[] => {
    try {
      build(tools)();
    } catch (error) {
      assert.ok(error instanceof EffectDeclarationError, String(error));
      return error.errors.map((e) => e.code);
    }
    return [];
  };

  assert.deepEqual(codesOf({ 'notify-tool': { name: 'notify-tool', actions: { send: { idempotency: { supported: true, retention_ms: 1000 } } }, send } }), []);
  assert.deepEqual(codesOf({ 'notify-tool': { name: 'notify-tool', actions: { send: { idempotency: { supported: true } as never } }, send } }), ['retention_required']);
  assert.deepEqual(codesOf({ 'notify-tool': { name: 'notify-tool', actions: {}, send } }), ['actions_missing']);
  assert.deepEqual(codesOf({ 'other-key': { name: 'notify-tool', actions: { send: { idempotency: { supported: false } } }, send } }), ['name_mismatch']);
  assert.throws(build({ 'notify-tool': { name: 'notify-tool', actions: { send: { idempotency: { supported: false, retention_ms: 5 } as never } }, send } }), EffectDeclarationError);
});
