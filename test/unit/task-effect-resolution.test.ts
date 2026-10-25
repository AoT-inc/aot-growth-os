// 사람의 external_effect `unknown` 해소 (resolveUnknownEffect / listUnresolvedEffects) — task-engine 수준.
// 응답을 잃어 unknown 이 되고 업무가 needs_review 로 간 효과를 사람이 confirmed / failed 로 확정한다.
// 한 write 트랜잭션에서 (검사 → authorize → 효과 전이 → 이벤트 INSERT) 가 전부 되거나 전혀 안 된다. 업무·task_transition·task_run 은 건드리지 않는다.
// 시각은 FakeClock 만 쓴다. 요청 본문은 DB 에 해시로만 남으므로 구별되는 표식(BODY_MARKER)이 어디에도 나오지 않는지 본다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { Db, ExternalEffectRow, TaskPolicyGate } from '@aot/domain';
import {
  claimNextTask, EFFECT_RESOLUTION_EVENT, EFFECT_RESOLUTION_KEY_PREFIX, EFFECT_RESOLUTION_OUTCOMES, effectResolutionEventId, effectResolutionKey,
  EffectResolutionError, listUnresolvedEffects, MAX_RESOLUTION_NOTE_CHARS, performEffect, resolveUnknownEffect, submitRun, transitionEffect, transitionTask,
  type EffectTool, type Lease, type ResolveEffectInput, type ResolveEffectResult,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, asEffectTool, queuedTask, runsOf, taskStatus } from '../support/engine.ts';
import { createIdempotentFakeTool, createNonIdempotentFakeTool, type FakeTool } from '../support/fake-tool.ts';
import { addAgent, seededDb, START } from '../support/seeded-db.ts';

const OWNER = 'actor-owner';
const SECOND = 'actor-second';
const LEASE_MS = 60_000;
const SHORT = 20_000;
const NOTE = 'seen in the example.com outbox';
/** 요청 본문에만 있는 표식 — 응답·이벤트·목록 어디에도 나오면 안 된다 */
const BODY_MARKER = 'BODY-MARKER-4f2a91c7';
const STEP = { stepId: 'send-report', action: 'send', target: 'mailbox:example', request: { subject: 'weekly', body: BODY_MARKER } };

interface SetupOptions {
  /** 멱등 도구면 보존 기간(ms). 없으면 멱등 미지원 도구 */
  retentionMs?: number;
  /** false 면 submitRun 을 하지 않는다 (run 이 열려 있다) */
  submit?: boolean;
  gate?: TaskPolicyGate;
}

const count = (db: Db, table: string): number => Number(db.get(`SELECT count(*) AS n FROM ${table}`)?.['n']);

/** 쓰기 여부를 가리는 DB 전체 요약 */
function world(db: Db) {
  return {
    event: count(db, 'event'), reauth: count(db, 'human_reauth'), transition: count(db, 'task_transition'), approval: count(db, 'approval'),
    decision: count(db, 'policy_decision'), run: count(db, 'task_run'), cost: count(db, 'cost_entry'),
    effects: db.all('SELECT * FROM external_effect ORDER BY id').map((r) => ({ ...r })),
    tasks: db.all('SELECT * FROM task ORDER BY id').map((r) => ({ ...r })),
    runs: db.all('SELECT * FROM task_run ORDER BY id').map((r) => ({ ...r })),
  };
}

function addHuman(db: Db, clockIso: string, id = SECOND): string {
  db.writeTx((tx) => tx.run('INSERT INTO actor (id, kind, name, adapter, created_at) VALUES (?, ?, ?, NULL, ?)', [id, 'human', 'example-second-reviewer', clockIso]));
  return id;
}

/** authorize 대신 쓰는 호출 기록기. 호출될 때 write 트랜잭션 안인지, 어떤 행을 받았는지 남긴다 */
function spy(effect?: (tx: Db, row: ExternalEffectRow) => void) {
  const calls: { inWriteTx: boolean; id: string; state: string }[] = [];
  return {
    calls,
    authorize: (tx: Db, row: ExternalEffectRow): void => {
      calls.push({ inWriteTx: tx.inWriteTx, id: row.id, state: row.state });
      effect?.(tx, row);
    },
  };
}

/** 재인증 행 하나를 쓴다 (데몬의 authorize 가 하는 일의 흉내) */
const insertReauth = (tx: Db, at: string, step = 1, purpose = 'effect-resolve:test:failed'): void => {
  tx.run("INSERT INTO human_reauth (actor_id, method, time_step, purpose, at) VALUES (?, 'totp', ?, ?, ?)", [OWNER, step, purpose, at]);
};

async function setup(t: Parameters<typeof seededDb>[0], options: SetupOptions = {}) {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  const taskId = queuedTask(db, clock);
  const fake: FakeTool = options.retentionMs === undefined ? createNonIdempotentFakeTool() : createIdempotentFakeTool({ retentionMs: options.retentionMs });
  const tool: EffectTool = asEffectTool(fake);
  const gate = options.gate ?? ALLOW_ALL_GATE;
  const claim = (workerId = 'w1'): Lease => {
    const result = claimNextTask(db, { clock, gate, workerId, actorId: agent, adapter: 'fake-adapter', leaseMs: LEASE_MS });
    assert.ok(result.claimed, 'a task is claimed');
    return result.claimed.lease;
  };
  const lease = claim();
  fake.loseNextResponses(1);
  const lost = await performEffect(db, clock, lease, tool, STEP, gate);
  assert.equal(lost.state, 'unknown');
  const effectId = lost.effectId;
  if (options.submit !== false) assert.deepEqual(submitRun(db, clock, lease, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  const row = (id = effectId): ExternalEffectRow => db.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE id = ?', [id])!;
  const resolve = (overrides: Partial<ResolveEffectInput> = {}): ResolveEffectResult =>
    resolveUnknownEffect(db, { clock }, { effectId, actorId: OWNER, outcome: 'confirmed', note: NOTE, ...overrides });
  const eventOf = (id = effectId) => {
    const found = db.get<{ id: string; source: string; external_id: string | null; type: string; payload: string; product_id: string | null; idempotency_key: string; occurred_at: string; received_at: string }>(
      'SELECT * FROM event WHERE idempotency_key = ?', [effectResolutionKey(id)],
    );
    return found === undefined ? undefined : { ...found, parsed: JSON.parse(found.payload) as Record<string, unknown> };
  };
  /** 해소 뒤 행을 `unknown` 으로 되돌린다 (재전송이 또 응답을 잃은 상황) */
  const backToUnknown = (from: 'failed' | 'confirmed' = 'failed'): void =>
    db.writeTx((tx) => {
      transitionEffect(tx, { effectId, from, to: 'dispatched', by: 'system', now: clock.nowIso() });
      transitionEffect(tx, { effectId, from: 'dispatched', to: 'unknown', by: 'system', now: clock.nowIso() });
    });
  return { db, clock, agent, taskId, fake, tool, gate, claim, lease, effectId, row, resolve, eventOf, backToUnknown };
}
type Env = Awaited<ReturnType<typeof setup>>;

function refusal(fn: () => unknown, code: string, extra: Record<string, unknown> = {}): EffectResolutionError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof EffectResolutionError, `expected EffectResolutionError(${code}), got ${String(caught)}`);
  assert.equal(caught.code, code);
  assert.equal(caught.name, 'EffectResolutionError');
  assert.ok(caught.message.startsWith(`effect resolution refused (${code})`), caught.message);
  for (const [key, value] of Object.entries(extra)) assert.deepEqual(caught.extra[key], value, `extra.${key}`);
  return caught;
}

/** 직접 넣는 external_effect 행 (상태별 not_unknown 시험용) */
function insertEffect(env: Env, id: string, state: string): void {
  const at = env.clock.nowIso();
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, idempotency_retention_ms, planned_at, at)
     VALUES (?, ?, ?, ?, 'example-tool', 'send', 'mailbox:example', 'h', ?, 0, NULL, ?, ?)`,
    [id, `key-${id}`, env.taskId, env.lease.runId, state, at, at],
  ));
}

// ===== 이름과 상수 =====

test('(0) exported names: outcomes, event identity, deterministic key and event id', () => {
  assert.deepEqual([...EFFECT_RESOLUTION_OUTCOMES], ['confirmed', 'failed']);
  assert.deepEqual({ ...EFFECT_RESOLUTION_EVENT }, { source: 'effect-resolution', type: 'external_effect.resolved' });
  assert.equal(EFFECT_RESOLUTION_KEY_PREFIX, 'effect-resolve:');
  assert.equal(MAX_RESOLUTION_NOTE_CHARS, 1000);
  assert.equal(effectResolutionKey('effect-abc'), 'effect-resolve:effect-abc');
  assert.equal(effectResolutionEventId('effect-abc'), `event-${createHash('sha256').update('effect-resolve:effect-abc').digest('hex').slice(0, 32)}`);
  assert.notEqual(effectResolutionEventId('effect-abc'), effectResolutionEventId('effect-abd'));
});

// ===== 적용 =====

test('(1) confirmed: row confirmed with response_ref human:<event id>, one event, nothing else is written', async (t) => {
  const env = await setup(t);
  const before = env.row();
  assert.equal(before.state, 'unknown');
  const worldBefore = world(env.db);
  env.clock.advance(5 * 60_000);
  const now = env.clock.nowIso();

  const result = env.resolve({ note: '  seen in the example.com outbox \n' });

  const eventId = effectResolutionEventId(env.effectId);
  assert.deepEqual(result, {
    applied: true, effectId: env.effectId, taskId: env.taskId, taskStatus: 'needs_review', previousState: 'unknown', state: 'confirmed',
    eventId, key: `effect-resolve:${env.effectId}`, responseRef: `human:${eventId}`,
  });
  const after = env.row();
  assert.deepEqual({ ...after }, { ...before, state: 'confirmed', response_ref: `human:${eventId}`, at: now });
  for (const column of ['planned_at', 'task_run_id', 'supports_idempotency', 'idempotency_retention_ms', 'effect_key', 'request_hash'] as const) {
    assert.equal(after[column], before[column], column);
  }

  const events = env.db.all('SELECT * FROM event');
  assert.equal(events.length, 1);
  const event = env.eventOf()!;
  assert.deepEqual(
    { id: event.id, source: event.source, external_id: event.external_id, type: event.type, idempotency_key: event.idempotency_key, occurred_at: event.occurred_at, received_at: event.received_at },
    { id: eventId, source: 'effect-resolution', external_id: env.effectId, type: 'external_effect.resolved', idempotency_key: `effect-resolve:${env.effectId}`, occurred_at: now, received_at: now },
  );
  assert.equal(event.product_id, env.db.get('SELECT product_id FROM task WHERE id = ?', [env.taskId])?.['product_id'] ?? null);
  assert.deepEqual(event.parsed, {
    effect_id: env.effectId, task_id: env.taskId, task_run_id: before.task_run_id, tool: before.tool, action: before.action, target: before.target,
    request_hash: before.request_hash, previous_state: 'unknown', outcome: 'confirmed', previous_response_ref: before.response_ref,
    response_ref: `human:${eventId}`, actor_id: OWNER, note: 'seen in the example.com outbox', resolved_at: now, reauth: null,
  });

  // 업무·전이·run·승인·재인증·정책 판정·비용은 그대로
  const worldAfter = world(env.db);
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');
  assert.deepEqual({ ...worldAfter, event: 0, effects: [] }, { ...worldBefore, event: 0, effects: [] });
  assert.equal(worldAfter.event, 1);
  assert.equal(worldAfter.reauth, 0, 'confirmed needs no human_reauth');

  // 요청 본문은 어디에도 없다
  assert.ok(!JSON.stringify(result).includes(BODY_MARKER));
  assert.ok(!JSON.stringify(env.db.all('SELECT * FROM event')).includes(BODY_MARKER));
  assert.ok(!event.payload.includes(before.effect_key), 'the effect key is not exposed either');
});

test('(2) failed: the authorize callback runs once inside the write tx with the unknown row; response_ref stays as before', async (t) => {
  const env = await setup(t);
  const before = env.row();
  assert.equal(before.response_ref, null);
  env.clock.advance(60_000);
  const now = env.clock.nowIso();
  const { calls, authorize } = spy();

  const result = env.resolve({ outcome: 'failed', note: 'not in the outbox after checking', authorize });

  const eventId = effectResolutionEventId(env.effectId);
  assert.deepEqual(result, {
    applied: true, effectId: env.effectId, taskId: env.taskId, taskStatus: 'needs_review', previousState: 'unknown', state: 'failed',
    eventId, key: `effect-resolve:${env.effectId}`, responseRef: null,
  });
  assert.deepEqual(calls, [{ inWriteTx: true, id: env.effectId, state: 'unknown' }]);
  assert.deepEqual({ ...env.row() }, { ...before, state: 'failed', at: now });
  assert.deepEqual(env.eventOf()!.parsed, {
    effect_id: env.effectId, task_id: env.taskId, task_run_id: before.task_run_id, tool: before.tool, action: before.action, target: before.target,
    request_hash: before.request_hash, previous_state: 'unknown', outcome: 'failed', previous_response_ref: null, response_ref: null,
    actor_id: OWNER, note: 'not in the outbox after checking', resolved_at: now, reauth: 'totp',
  });
  assert.equal(count(env.db, 'task_transition'), world(env.db).transition);
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');
});

test('(2b) authorize given for confirmed is still called exactly once (the daemon just does not pass it)', async (t) => {
  const env = await setup(t);
  const { calls, authorize } = spy();
  assert.equal(env.resolve({ authorize }).applied, true);
  assert.equal(calls.length, 1);
  assert.equal(env.eventOf()!.parsed['reauth'], null);
});

test('(2c) the authorize callback runs after the checks and before any write: it sees the row still unknown and no event', async (t) => {
  const env = await setup(t);
  let seen: { state: string; events: number } | null = null;
  const { authorize } = spy((tx, row) => {
    seen = { state: tx.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE id = ?', [row.id])!.state, events: Number(tx.get('SELECT count(*) AS n FROM event')!['n']) };
  });
  env.resolve({ outcome: 'failed', authorize });
  assert.deepEqual(seen, { state: 'unknown', events: 0 });
});

test('(3) replay with the same outcome: applied:false with the original note and actor, nothing written, authorize not called', async (t) => {
  const env = await setup(t);
  addHuman(env.db, env.clock.nowIso());
  env.clock.advance(60_000);
  const firstAt = env.clock.nowIso();
  const first = env.resolve({ note: 'first note' });
  assert.equal(first.applied, true);
  const afterFirst = world(env.db);

  env.clock.advance(60_000);
  const { calls, authorize } = spy((tx) => insertReauth(tx, env.clock.nowIso()));
  const replay = env.resolve({ actorId: SECOND, note: 'a different note', authorize });

  assert.deepEqual(replay, {
    applied: false, effectId: env.effectId, taskId: env.taskId, state: 'confirmed', outcome: 'confirmed',
    eventId: effectResolutionEventId(env.effectId), key: `effect-resolve:${env.effectId}`, resolvedBy: OWNER, resolvedAt: firstAt, note: 'first note',
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(world(env.db), afterFirst);
});

test('(3b) replay of a failed resolution does not run authorize again (no second re-authentication)', async (t) => {
  const env = await setup(t);
  const first = spy((tx) => insertReauth(tx, env.clock.nowIso(), 11));
  env.resolve({ outcome: 'failed', authorize: first.authorize });
  assert.equal(count(env.db, 'human_reauth'), 1);
  const afterFirst = world(env.db);

  const second = spy((tx) => insertReauth(tx, env.clock.nowIso(), 12));
  const replay = env.resolve({ outcome: 'failed', authorize: second.authorize });
  assert.equal(replay.applied, false);
  assert.equal(replay.state, 'failed');
  assert.deepEqual(second.calls, []);
  assert.deepEqual(world(env.db), afterFirst);

  // authorize 가 없어도 같은 결과 (reauth_required 보다 재생 판정이 먼저다)
  const noAuthorize = env.resolve({ outcome: 'failed' });
  assert.equal(noAuthorize.applied, false);
  assert.deepEqual(world(env.db), afterFirst);
});

test('(4) a different outcome after a recorded one is outcome_conflict with the recorded resolution in extra; nothing written, authorize not called', async (t) => {
  for (const [first, second] of [['confirmed', 'failed'], ['failed', 'confirmed']] as const) {
    const env = await setup(t);
    const firstSpy = spy((tx) => insertReauth(tx, env.clock.nowIso(), 21));
    env.clock.advance(1_000);
    const firstAt = env.clock.nowIso();
    env.resolve({ outcome: first, ...(first === 'failed' ? { authorize: firstSpy.authorize } : {}) });
    const before = world(env.db);

    const second_ = spy((tx) => insertReauth(tx, env.clock.nowIso(), 22));
    env.clock.advance(1_000);
    refusal(() => env.resolve({ outcome: second, actorId: OWNER, authorize: second_.authorize }), 'outcome_conflict', { resolved: { outcome: first, by: OWNER, at: firstAt } });
    assert.deepEqual(second_.calls, []);
    assert.deepEqual(world(env.db), before);
  }
});

// ===== 거부 =====

test('(5) not_unknown for every other state, with the state in extra; nothing written, authorize not called', async (t) => {
  for (const state of ['planned', 'dispatched', 'confirmed', 'failed', 'compensated']) {
    const env = await setup(t, { submit: false }); // run 이 열려 있어도 상태 검사(5)가 run_active(6)보다 먼저다
    insertEffect(env, `effect-direct-${state}`, state);
    const before = world(env.db);
    const { calls, authorize } = spy();
    refusal(() => env.resolve({ effectId: `effect-direct-${state}`, outcome: 'failed', authorize }), 'not_unknown', { state });
    refusal(() => env.resolve({ effectId: `effect-direct-${state}` }), 'not_unknown', { state });
    assert.deepEqual(calls, []);
    assert.deepEqual(world(env.db), before);
  }
});

test('(6) not_found for an unknown effect id', async (t) => {
  const env = await setup(t);
  const before = world(env.db);
  const { calls, authorize } = spy();
  refusal(() => env.resolve({ effectId: 'effect-does-not-exist', outcome: 'failed', authorize }), 'not_found');
  assert.deepEqual(calls, []);
  assert.deepEqual(world(env.db), before);
});

test('(7) input validation: invalid_outcome, invalid_request, note_required, note_too_long; checked before the actor; authorize not called', async (t) => {
  const env = await setup(t);
  const before = world(env.db);
  const { calls, authorize } = spy();
  const attempt = (overrides: Partial<ResolveEffectInput>) => () => env.resolve({ authorize, ...overrides });

  for (const outcome of ['compensated', 'unknown', '', 'CONFIRMED', undefined, null, 1]) {
    refusal(attempt({ outcome: outcome as never }), 'invalid_outcome');
  }
  for (const effectId of ['', '   ', undefined, null, 7]) refusal(attempt({ effectId: effectId as never }), 'invalid_request');
  for (const note of ['', '  \n ', '\t', undefined, null, 5]) refusal(attempt({ note: note as never }), 'note_required');
  refusal(attempt({ note: 'x'.repeat(MAX_RESOLUTION_NOTE_CHARS + 1) }), 'note_too_long');
  refusal(attempt({ note: `  ${'x'.repeat(MAX_RESOLUTION_NOTE_CHARS)}x  ` }), 'note_too_long');
  assert.deepEqual(calls, []);
  assert.deepEqual(world(env.db), before);

  // 검사 순서: outcome → effectId → note → (그 뒤에야) 행위자
  refusal(attempt({ outcome: 'nope' as never, effectId: '', note: '', actorId: 'actor-ghost' }), 'invalid_outcome');
  refusal(attempt({ effectId: '', note: '', actorId: 'actor-ghost' }), 'invalid_request');
  refusal(attempt({ note: '', actorId: 'actor-ghost' }), 'note_required');
  refusal(attempt({ note: 'x'.repeat(1001), actorId: 'actor-ghost' }), 'note_too_long');
  refusal(attempt({ actorId: 'actor-ghost' }), 'unknown_actor');
});

test('(7b) a note of exactly 1000 characters (after trimming) is accepted and stored trimmed', async (t) => {
  const env = await setup(t);
  const note = 'x'.repeat(MAX_RESOLUTION_NOTE_CHARS);
  assert.equal(env.resolve({ note: `  ${note}\n` }).applied, true);
  assert.equal(env.eventOf()!.parsed['note'], note);
});

test('(8) actor checks: unknown_actor, not_human (agent); nothing written, authorize not called', async (t) => {
  const env = await setup(t);
  const before = world(env.db);
  const { calls, authorize } = spy();
  refusal(() => env.resolve({ actorId: 'actor-ghost', outcome: 'failed', authorize }), 'unknown_actor');
  refusal(() => env.resolve({ actorId: env.agent, outcome: 'failed', authorize }), 'not_human');
  refusal(() => env.resolve({ actorId: env.agent }), 'not_human');
  assert.deepEqual(calls, []);
  assert.deepEqual(world(env.db), before);
});

test('(9) key_in_use: an event with the resolution key from another source blocks it; nothing is written', async (t) => {
  const env = await setup(t);
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES ('event-foreign', 'someone-else', NULL, 'other.type', '{}', NULL, ?, ?, ?)",
    [effectResolutionKey(env.effectId), env.clock.nowIso(), env.clock.nowIso()],
  ));
  const before = world(env.db);
  const { calls, authorize } = spy();
  refusal(() => env.resolve({ outcome: 'failed', authorize }), 'key_in_use');
  refusal(() => env.resolve(), 'key_in_use');
  // 같은 source 이고 type 만 다른 경우도 마찬가지
  assert.deepEqual(calls, []);
  assert.deepEqual(world(env.db), before);
  assert.equal(env.row().state, 'unknown');
});

test('(9b) key_in_use also when only the type differs from the resolution event', async (t) => {
  const env = await setup(t);
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES ('event-foreign', 'effect-resolution', NULL, 'external_effect.other', '{}', NULL, ?, ?, ?)",
    [effectResolutionKey(env.effectId), env.clock.nowIso(), env.clock.nowIso()],
  ));
  refusal(() => env.resolve(), 'key_in_use');
});

test('(10) run_active while the run that produced the unknown is still open; resolvable once it has closed', async (t) => {
  const env = await setup(t, { submit: false });
  const before = world(env.db);
  const { calls, authorize } = spy();
  refusal(() => env.resolve({ outcome: 'failed', authorize }), 'run_active', { task_run_id: env.lease.runId });
  refusal(() => env.resolve(), 'run_active', { task_run_id: env.lease.runId });
  assert.deepEqual(calls, []);
  assert.deepEqual(world(env.db), before);
  assert.equal(runsOf(env.db, env.taskId)[0]!.outcome, null);

  assert.equal(submitRun(env.db, env.clock, env.lease, {}).outcome, 'effect_unknown');
  assert.equal(env.resolve().applied, true);
});

test('(11) failed without an authorize callback is reauth_required; nothing written', async (t) => {
  const env = await setup(t);
  const before = world(env.db);
  refusal(() => env.resolve({ outcome: 'failed' }), 'reauth_required');
  assert.deepEqual(world(env.db), before);
  assert.equal(env.row().state, 'unknown');
  // confirmed 는 authorize 없이 된다
  assert.equal(env.resolve({ outcome: 'confirmed' }).applied, true);
});

test('(12) resolved_before: a row that was resolved, then went back to unknown, is refused with the earlier resolution in extra', async (t) => {
  const env = await setup(t);
  const firstAt = env.clock.nowIso();
  env.resolve({ outcome: 'failed', authorize: spy((tx) => insertReauth(tx, firstAt, 31)).authorize });
  assert.equal(env.row().state, 'failed');
  env.clock.advance(1_000);
  env.backToUnknown('failed');
  assert.equal(env.row().state, 'unknown');
  const before = world(env.db);

  const { calls, authorize } = spy();
  for (const outcome of ['failed', 'confirmed'] as const) {
    refusal(() => env.resolve({ outcome, authorize }), 'resolved_before', { resolved: { outcome: 'failed', by: OWNER, at: firstAt } });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(world(env.db), before);
});

// ===== 원자성 =====

test('(13) atomicity: authorize inserts a human_reauth row and throws → the same error propagates and nothing persists', async (t) => {
  const env = await setup(t);
  const before = world(env.db);
  const boom = new Error('reauth refused: wrong code');
  const { calls, authorize } = spy((tx) => {
    insertReauth(tx, env.clock.nowIso(), 41);
    throw boom;
  });
  assert.throws(() => env.resolve({ outcome: 'failed', authorize }), (error: unknown) => error === boom);
  assert.equal(calls.length, 1);
  assert.deepEqual(world(env.db), before);
  assert.equal(env.row().state, 'unknown');
  assert.equal(env.eventOf(), undefined);

  // 다시 시도하면 정상 적용된다 (잠기거나 반쯤 쓰인 것이 없다)
  assert.equal(env.resolve({ outcome: 'failed', authorize: spy().authorize }).applied, true);
});

test('(13b) atomicity: a non-Error value thrown by authorize propagates unchanged', async (t) => {
  const env = await setup(t);
  const marker = { reason: 'plain object' };
  assert.throws(() => env.resolve({ outcome: 'failed', authorize: () => { throw marker; } }), (error: unknown) => error === marker);
  assert.equal(env.row().state, 'unknown');
});

test('(14) atomicity: authorize succeeds but the event INSERT hits the UNIQUE key → effect transition and authorize writes are rolled back', async (t) => {
  const env = await setup(t);
  const before = world(env.db);
  // authorize 가 같은 멱등 키의 이벤트를 다른 id 로 먼저 넣어 두면, 마지막 단계의 INSERT 가 UNIQUE 에 걸린다
  const { calls, authorize } = spy((tx) => {
    insertReauth(tx, env.clock.nowIso(), 51);
    tx.run(
      "INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES ('event-planted', 'effect-resolution', NULL, 'external_effect.resolved', '{}', NULL, ?, ?, ?)",
      [effectResolutionKey(env.effectId), env.clock.nowIso(), env.clock.nowIso()],
    );
  });
  assert.throws(() => env.resolve({ outcome: 'failed', authorize }));
  assert.equal(calls.length, 1);
  assert.equal(env.row().state, 'unknown', 'the transition was rolled back');
  assert.equal(env.row().response_ref, null);
  assert.deepEqual(world(env.db), before, 'no event, no human_reauth, no partial effect state');
  assert.equal(env.eventOf(), undefined);
});

// ===== 엔진 후속 동작 (spec §7) =====

/** 해소한 뒤 업무를 사람이 다시 queued 로 올리고 새 run 을 잡는다 (needs_review → queued 는 사람 + 승인 id) */
function requeueAndClaim(env: Env, workerId = 'w2'): Lease {
  env.clock.advance(LEASE_MS);
  env.db.writeTx((tx) => transitionTask(tx, {
    taskId: env.taskId, from: 'needs_review', to: 'queued', by: 'human', reason: 're-queued after effect resolution', now: env.clock.nowIso(),
    causedBy: OWNER, approvalId: 'approval-test-requeue',
  }));
  const lease = env.claim(workerId);
  assert.notEqual(lease.runId, env.lease.runId);
  return lease;
}

test('(15a) confirmed + re-plan: the step is reused with the human response_ref, nothing is sent, the run submits to validating', async (t) => {
  const env = await setup(t);
  assert.equal(env.fake.deliveries.length, 1, 'the lost send did happen');
  env.resolve();
  const lease2 = requeueAndClaim(env);

  const outcome = await performEffect(env.db, env.clock, lease2, env.tool, STEP, env.gate);
  assert.deepEqual(outcome, { state: 'confirmed', effectId: env.effectId, responseRef: `human:${effectResolutionEventId(env.effectId)}`, reused: true });
  assert.equal(env.fake.deliveries.length, 1, 'no second send');
  assert.equal(env.row().state, 'confirmed');
  assert.deepEqual(submitRun(env.db, env.clock, lease2, {}), { outcome: 'submitted', taskStatus: 'validating' });
});

test('(15b) confirmed, not re-planned: a new run that never touches the step goes to validating; control without resolution goes to needs_review', async (t) => {
  const resolved = await setup(t);
  resolved.resolve();
  const lease2 = requeueAndClaim(resolved);
  assert.deepEqual(submitRun(resolved.db, resolved.clock, lease2, {}), { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(resolved.fake.deliveries.length, 1);

  const control = await setup(t);
  const lease2c = requeueAndClaim(control);
  assert.deepEqual(submitRun(control.db, control.clock, lease2c, {}), { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(control.row().state, 'unknown');
});

test('(15c) failed + re-plan with an allowing gate: the step is sent again (deliveries + 1) and confirmed', async (t) => {
  const env = await setup(t);
  env.resolve({ outcome: 'failed', authorize: spy().authorize });
  const lease2 = requeueAndClaim(env);

  const outcome = await performEffect(env.db, env.clock, lease2, env.tool, STEP, ALLOW_ALL_GATE);
  assert.equal(outcome.state, 'confirmed');
  assert.equal(outcome.state === 'confirmed' && outcome.reused, false);
  assert.equal(env.fake.deliveries.length, 2, 'a real second delivery');
  assert.equal(env.row().state, 'confirmed');
  assert.equal(env.row().task_run_id, lease2.runId);
  assert.deepEqual(submitRun(env.db, env.clock, lease2, {}), { outcome: 'submitted', taskStatus: 'validating' });
});

test('(15d) failed + re-plan with a gate that refuses resend_failed: stays failed (reused), no delivery, run not stopped, submit goes to validating', async (t) => {
  const env = await setup(t);
  env.resolve({ outcome: 'failed', authorize: spy().authorize });
  const lease2 = requeueAndClaim(env);
  const dispatches: string[] = [];
  const refusing: TaskPolicyGate = {
    ...ALLOW_ALL_GATE,
    beforeEffect: (_tx, request) => {
      dispatches.push(request.dispatch);
      return request.dispatch === 'resend_failed' ? { decision: 'refuse', reason: 'resend_failed needs an explicit allow' } : { decision: 'allow' };
    },
  };

  const outcome = await performEffect(env.db, env.clock, lease2, env.tool, STEP, refusing);
  assert.deepEqual(outcome, { state: 'failed', effectId: env.effectId, reused: true });
  assert.deepEqual(dispatches, ['resend_failed']);
  assert.equal(env.fake.deliveries.length, 1);
  assert.equal(env.row().state, 'failed');
  assert.equal(taskStatus(env.db, env.taskId), 'running', 'the run is not stopped');
  assert.equal(runsOf(env.db, env.taskId).at(-1)!.outcome, null);
  assert.deepEqual(submitRun(env.db, env.clock, lease2, {}), { outcome: 'submitted', taskStatus: 'validating' });
});

// ===== listUnresolvedEffects =====

const isoAt = (ms: number): string => new Date(ms).toISOString();

test('(16) list: only unknown rows, ordered by planned_at then id, with the documented fields and no body', async (t) => {
  const env = await setup(t);
  for (const state of ['planned', 'dispatched', 'confirmed', 'failed', 'compensated']) insertEffect(env, `effect-other-${state}`, state);
  const now = env.clock.nowIso();

  const listed = listUnresolvedEffects(env.db, now);
  const row = env.row();
  assert.deepEqual(listed, [{
    effectId: env.effectId, taskId: env.taskId, taskStatus: 'needs_review', taskRunId: row.task_run_id, tool: row.tool, action: 'send', target: 'mailbox:example',
    requestHash: row.request_hash, plannedAt: row.planned_at, lastTransitionAt: row.at, supportsIdempotency: false,
    resendWindowOpen: false, runActive: false, resolvedBefore: false,
  }]);
  const text = JSON.stringify(listed);
  assert.ok(!text.includes(BODY_MARKER));
  assert.ok(!text.includes(row.effect_key), 'no effect key');
  assert.ok(!text.includes('effect_key'));

  // 해소하면 목록에서 빠진다
  env.resolve();
  assert.deepEqual(listUnresolvedEffects(env.db, now), []);
});

test('(16b) list: several unknown rows come back ordered by planned_at, then id', async (t) => {
  const env = await setup(t);
  env.clock.advance(1_000);
  const second = insertUnknown(env, 'effect-b', env.clock.nowIso());
  const third = insertUnknown(env, 'effect-a', env.clock.nowIso()); // 같은 planned_at → id 순
  const earlier = insertUnknown(env, 'effect-z', START);
  const ids = listUnresolvedEffects(env.db, env.clock.nowIso()).map((e) => e.effectId);
  assert.deepEqual(ids, [env.effectId, earlier, third, second].sort((a, b) => {
    const pa = env.row(a).planned_at;
    const pb = env.row(b).planned_at;
    return pa < pb ? -1 : pa > pb ? 1 : a < b ? -1 : 1;
  }));
  assert.equal(ids.length, 4);
});

function insertUnknown(env: Env, id: string, plannedAt: string): string {
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, idempotency_retention_ms, planned_at, at)
     VALUES (?, ?, ?, ?, 'example-tool', 'send', 'mailbox:example', 'h', 'unknown', 0, NULL, ?, ?)`,
    [id, `key-${id}`, env.taskId, env.lease.runId, plannedAt, plannedAt],
  ));
  return id;
}

test('(17) list: resendWindowOpen is true up to 50% of retention (inclusive) and false after; listing writes nothing and never closes the window', async (t) => {
  const env = await setup(t, { retentionMs: SHORT });
  const planned = Date.parse(env.row().planned_at);
  const before = world(env.db);
  const row = env.row();
  assert.equal(Number(row.supports_idempotency), 1);

  const readOnly = new Proxy(env.db, {
    get(target, property) {
      if (property === 'writeTx') return () => { throw new Error('listUnresolvedEffects must not write'); };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const open = listUnresolvedEffects(readOnly, isoAt(planned + SHORT / 2));
  assert.equal(open[0]!.supportsIdempotency, true);
  assert.equal(open[0]!.resendWindowOpen, true);
  assert.equal(listUnresolvedEffects(readOnly, isoAt(planned)).at(0)!.resendWindowOpen, true);

  const closed = listUnresolvedEffects(readOnly, isoAt(planned + SHORT / 2 + 1));
  assert.equal(closed[0]!.resendWindowOpen, false);
  assert.equal(closed[0]!.supportsIdempotency, true, 'the report does not tighten the snapshot');

  const after = env.row();
  assert.equal(Number(after.supports_idempotency), 1);
  assert.equal(after.idempotency_retention_ms, SHORT);
  assert.deepEqual({ ...after }, { ...row });
  assert.deepEqual(world(env.db), before);
  // 시계가 되돌아가도(창이 다시 열려 보여도) 목록은 행만 본다
  assert.equal(listUnresolvedEffects(readOnly, isoAt(planned + 1))[0]!.resendWindowOpen, true);
});

test('(18) list: runActive is true while the producing run is open; resolvedBefore only after an earlier resolution', async (t) => {
  const env = await setup(t, { submit: false });
  const now = env.clock.nowIso();
  assert.deepEqual(listUnresolvedEffects(env.db, now).map((e) => [e.runActive, e.resolvedBefore, e.taskStatus]), [[true, false, 'running']]);

  assert.equal(submitRun(env.db, env.clock, env.lease, {}).outcome, 'effect_unknown');
  assert.deepEqual(listUnresolvedEffects(env.db, now).map((e) => [e.runActive, e.resolvedBefore, e.taskStatus]), [[false, false, 'needs_review']]);

  env.resolve({ outcome: 'failed', authorize: spy().authorize });
  assert.deepEqual(listUnresolvedEffects(env.db, now), []);
  env.clock.advance(1_000);
  env.backToUnknown('failed');
  assert.deepEqual(listUnresolvedEffects(env.db, env.clock.nowIso()).map((e) => [e.effectId, e.runActive, e.resolvedBefore]), [[env.effectId, false, true]]);
});

test('(19) list of an empty ledger is empty', (t) => {
  const { db, clock } = seededDb(t);
  assert.deepEqual(listUnresolvedEffects(db, clock.nowIso()), []);
});
