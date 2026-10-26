// 데몬의 효과 해소 채널 (effects / resolve-effect): 승인 소켓 처리기 조합(handleChannelRequest)이 이 두 명령을 가장 먼저 새 처리기로 보낸다.
// confirmed 는 사람 1인 + 메모, failed 는 거기에 TOTP 재인증(승인 엔진과 같은 연속 실패 잠금을 공유)이 더 붙는다.
// 거부는 {ok:false, code, error}, 거부된 요청은 아무것도 쓰지 않는다. TOTP 코드와 요청 본문 표식은 어떤 응답에도 나오지 않는다.
// (소켓·CLI 프로세스 경로는 통합 시험 daemon-effect-resolution)
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import type { Db, ExternalEffectRow } from '@aot/domain';
import {
  ApprovalRefusedError, base32Decode, generateTotpSecret, ReauthError, TOTP_MAX_FAILURES, totpCode, TotpSecretError, TotpSecretStore,
} from '@aot/policy';
import { claimNextTask, createTask, effectResolutionEventId, performEffect, submitRun, type EffectTool, type TaskExecutor } from '@aot/task-engine';

import { assembleDaemon, type AssembleOptions } from '../../apps/daemon/src/assemble.ts';
import {
  createEffectResolutionHandler, EFFECT_COMMANDS, effectResolvePurpose, isEffectResolutionCommand,
} from '../../apps/daemon/src/effect-resolve.ts';
import { ALLOW_ALL_GATE, asEffectTool, manualTimers, queuedTask, taskStatus } from '../support/engine.ts';
import { createNonIdempotentFakeTool } from '../support/fake-tool.ts';
import { PACK_SIGNAL } from '../support/measurement.ts';
import { effectDraft, HOUR } from '../support/policy.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const OWNER = 'actor-owner';
const SECOND = 'actor-second'; // 사람이지만 TOTP 비밀이 없다
const NOTE = 'seen in the example.com outbox';
const BODY_MARKER = 'BODY-MARKER-9be03d51';
const completes: TaskExecutor = { execute: async () => ({ result: { summary: 'example plan' } }) };

type Response = Record<string, unknown> & { ok: boolean; code?: string; error?: string };

function rig(t: TestContext, extra: Partial<AssembleOptions> = {}) {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  db.writeTx((tx) => tx.run('INSERT INTO actor (id, kind, name, adapter, created_at) VALUES (?, ?, ?, NULL, ?)', [SECOND, 'human', 'example-second', clock.nowIso()]));
  const dir = makeTempDir(t);
  const totpDir = join(dir, 'totp');
  const secret = new TotpSecretStore(totpDir).enroll(OWNER, generateTotpSecret());
  const daemon = assembleDaemon({
    db, clock, workerId: 'w1', actorId: agent, executor: completes, timers: manualTimers(),
    paths: { policyStoreDir: join(dir, 'policies'), totpDir, approvalSocket: join(dir, 'run', 'approval.sock') },
    ...extra,
  });
  const send = (request: unknown): Response => daemon.handleChannelRequest(request) as Response;
  const code = (atMs = clock.nowMs()): string => totpCode(base32Decode(secret), atMs);
  const wrong = (): string => String((Number(code()) + 1) % 1_000_000).padStart(6, '0');
  let made = 0;
  /** 응답을 잃어 unknown 이 되고 needs_review 로 간 효과 하나 (새 업무마다). 정책 업무를 만들기 전에 만든다 */
  const unknown = async (): Promise<{ effectId: string; taskId: string }> => {
    made += 1;
    const taskId = queuedTask(db, clock, { inputs: [{ name: 'n', ref: `r:unknown-${made}`, kind: 'k' }] }, `task-unknown-${made}`);
    const claimed = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: 'w9', actorId: agent, adapter: 'fake-adapter', leaseMs: 60_000, taskId }).claimed;
    assert.ok(claimed);
    const fake = createNonIdempotentFakeTool({ name: 'example-tool' });
    const tool: EffectTool = asEffectTool(fake);
    fake.loseNextResponses(1);
    const lost = await performEffect(db, clock, claimed.lease, tool, {
      stepId: 'send-report', action: 'send', target: 'mailbox:example', request: { subject: 'weekly', body: BODY_MARKER },
    }, ALLOW_ALL_GATE);
    assert.equal(lost.state, 'unknown');
    assert.equal(submitRun(db, clock, claimed.lease, {}).taskStatus, 'needs_review');
    return { effectId: lost.effectId, taskId };
  };
  const resolve = (effectId: string, fields: Record<string, unknown> = {}, actor: unknown = OWNER): Response =>
    send({ cmd: 'resolve-effect', actor, effect_id: effectId, outcome: 'confirmed', note: NOTE, ...fields });
  return { db, clock, agent, daemon, send, code, wrong, secret, unknown, resolve };
}
type Rig = ReturnType<typeof rig>;

const count = (db: Db, table: string): number => Number(db.get(`SELECT count(*) AS n FROM ${table}`)?.['n']);
const stateOf = (db: Db, id: string): string => String(db.get('SELECT state FROM external_effect WHERE id = ?', [id])?.['state']);
/** 쓰기 여부를 가리는 요약 */
const written = (db: Db) => ({ event: count(db, 'event'), reauth: count(db, 'human_reauth'), transition: count(db, 'task_transition'), approval: count(db, 'approval'), unknown: count(db, "external_effect WHERE state = 'unknown'") });

function assertRefused(response: Response, code: string, pattern?: RegExp): void {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.code, code, JSON.stringify(response));
  assert.equal(typeof response.error, 'string');
  if (pattern) assert.match(String(response.error), pattern);
}

/** 승인이 필요한 업무를 만들어 needs_review 로 보내고, 승인(cooldown 시작)한다. unknown 효과는 먼저 만들어 둘 것 */
function approvedTask(env: Rig): string {
  const taskId = createTask(env.db, { clock: env.clock, gate: env.daemon.gate }, { spec: effectDraft({ inputs: [{ name: 'n', ref: 'r:approval', kind: 'k' }] }) }).taskId;
  const claimed = claimNextTask(env.db, { clock: env.clock, gate: env.daemon.gate, workerId: 'w1', actorId: env.agent, adapter: 'fake-adapter', leaseMs: 90_000, taskId });
  assert.equal(claimed.claimed, null);
  assert.equal(taskStatus(env.db, taskId), 'needs_review');
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  assert.equal(shown.ok, true);
  assert.equal(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash: shown['hash'] })['state'], 'cooldown');
  env.clock.advance(HOUR);
  return taskId;
}

describe('routing on the approval socket handler', () => {
  it('exports the command list, the detector and the purpose format', () => {
    assert.deepEqual([...EFFECT_COMMANDS], ['effects', 'resolve-effect']);
    assert.equal(isEffectResolutionCommand({ cmd: 'effects', actor: OWNER }), true);
    assert.equal(isEffectResolutionCommand({ cmd: 'resolve-effect' }), true);
    for (const other of [{ cmd: 'whoami' }, { cmd: 'measure' }, {}, { cmd: 7 }, null, undefined, 'effects', ['effects'], 7]) assert.equal(isEffectResolutionCommand(other), false);
    assert.equal(effectResolvePurpose('effect-1'), 'effect-resolve:effect-1:failed');
  });

  it('effects and resolve-effect reach the new handler (with and without a measurement channel); whoami and list behave as before', async (t) => {
    for (const extra of [{}, { measurementSignals: [PACK_SIGNAL] }]) {
      const env = rig(t, extra);
      const { effectId } = await env.unknown();
      const listed = env.send({ cmd: 'effects', actor: OWNER });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      assert.deepEqual((listed['effects'] as { effect_id: string }[]).map((e) => e.effect_id), [effectId]);
      assert.equal(listed['now'], env.clock.nowIso());
      const resolved = env.resolve(effectId);
      assert.equal(resolved['ok'], true, JSON.stringify(resolved));
      assert.equal(resolved['applied'], true);
      assert.deepEqual(env.send({ cmd: 'whoami', actor: OWNER }), { ok: true, actor: OWNER, kind: 'human' });
      const tasks = env.send({ cmd: 'list', actor: OWNER });
      assert.equal(tasks.ok, true);
      assert.ok(Array.isArray(tasks['tasks']));
      assert.deepEqual(env.send({ cmd: 'effects', actor: OWNER })['effects'], [], 'resolved rows leave the list');
    }
  });

  it('an unknown command is still left to the approval engine', (t) => {
    const env = rig(t);
    const response = env.send({ cmd: 'no-such-command', actor: OWNER });
    assert.equal(response.ok, false);
    assert.equal(response.code, undefined);
  });
});

describe('the authentication step and the request shape', () => {
  it('refuses an agent actor with not_human ("only human actors") for both commands, and writes nothing', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    const before = written(env.db);
    for (const request of [{ cmd: 'effects', actor: env.agent }, { cmd: 'resolve-effect', actor: env.agent, effect_id: effectId, outcome: 'confirmed', note: NOTE }]) {
      assertRefused(env.send(request), 'not_human', /only human actors/);
    }
    assert.deepEqual(written(env.db), before);
    assert.equal(stateOf(env.db, effectId), 'unknown');
  });

  it('refuses an unknown or missing actor: unknown_actor for an id that does not exist, ok:false for none', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    assertRefused(env.send({ cmd: 'effects', actor: 'actor-ghost' }), 'unknown_actor');
    assertRefused(env.resolve(effectId, {}, 'actor-ghost'), 'unknown_actor');
    assert.equal(env.send({ cmd: 'effects' }).ok, false);
    assert.equal(env.send({ cmd: 'resolve-effect', effect_id: effectId, outcome: 'confirmed', note: NOTE }).ok, false);
    assert.equal(stateOf(env.db, effectId), 'unknown');
  });

  it('refuses any key outside {cmd, actor, effect_id, outcome, note, totp} with invalid_request', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    for (const key of ['reason', 'effect_key', 'task_id', 'state', 'force']) {
      assertRefused(env.resolve(effectId, { [key]: 'x' }), 'invalid_request');
    }
    assertRefused(env.send({ cmd: 'effects', actor: OWNER, filter: 'all' }), 'invalid_request');
    assertRefused(env.send({ cmd: 'effects', actor: OWNER, effect_id: effectId }), 'invalid_request');
    assert.equal(stateOf(env.db, effectId), 'unknown');
    assert.equal(count(env.db, 'event'), 0);
  });

  it('a non-string totp (a number) is invalid_request and writes nothing, even for confirmed', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    const before = written(env.db);
    assertRefused(env.resolve(effectId, { outcome: 'failed', totp: 123456 }), 'invalid_request');
    assertRefused(env.resolve(effectId, { totp: 123456 }), 'invalid_request');
    assert.deepEqual(written(env.db), before);
    assert.equal(stateOf(env.db, effectId), 'unknown');
  });

  it('engine validation codes pass through: invalid_request (no/blank effect_id), invalid_outcome, note_required, note_too_long, not_found', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    const without = (key: string): Record<string, unknown> => ({ cmd: 'resolve-effect', actor: OWNER, effect_id: effectId, outcome: 'confirmed', note: NOTE, [key]: undefined });
    assertRefused(env.send(without('effect_id')), 'invalid_request');
    assertRefused(env.resolve('  '), 'invalid_request');
    assertRefused(env.send(without('outcome')), 'invalid_outcome');
    assertRefused(env.resolve(effectId, { outcome: 'compensated' }), 'invalid_outcome');
    assertRefused(env.send(without('note')), 'note_required');
    assertRefused(env.resolve(effectId, { note: ' \n ' }), 'note_required');
    assertRefused(env.resolve(effectId, { note: 'x'.repeat(1001) }), 'note_too_long');
    assertRefused(env.resolve('effect-nope'), 'not_found');
    assert.deepEqual(written(env.db).event, 0);
  });
});

describe('confirmed: one human and a note, no TOTP', () => {
  it('is applied; first application, then the identical repeat, then a different outcome', async (t) => {
    const env = rig(t);
    const { effectId, taskId } = await env.unknown();
    env.clock.advance(1_000);
    const eventId = effectResolutionEventId(effectId);

    const first = env.resolve(effectId);
    assert.deepEqual(first, {
      ok: true, applied: true, effect_id: effectId, task_id: taskId, task_status: 'needs_review', previous_state: 'unknown', state: 'confirmed',
      event_id: eventId, key: `effect-resolve:${effectId}`, response_ref: `human:${eventId}`,
    });
    assert.equal(stateOf(env.db, effectId), 'confirmed');
    assert.equal(count(env.db, 'human_reauth'), 0);
    assert.equal(count(env.db, 'event'), 1);

    env.clock.advance(1_000);
    const repeat = env.resolve(effectId, { note: 'another note' }, SECOND);
    assert.deepEqual(repeat, {
      ok: true, applied: false, effect_id: effectId, task_id: taskId, state: 'confirmed', outcome: 'confirmed', event_id: eventId, key: `effect-resolve:${effectId}`,
      resolved_by: OWNER, resolved_at: '2026-10-19T00:00:01.000Z', note: NOTE,
    });
    assert.equal(count(env.db, 'event'), 1);

    const conflict = env.resolve(effectId, { outcome: 'failed', totp: env.code() });
    assertRefused(conflict, 'outcome_conflict');
    assert.equal(count(env.db, 'human_reauth'), 0, 'a conflicting request does not spend a TOTP code');
    assert.equal(stateOf(env.db, effectId), 'confirmed');
  });

  it('ignores a totp field: applied, no human_reauth row, even with a garbage or valid code; the code is not echoed anywhere', async (t) => {
    const env = rig(t);
    const first = await env.unknown();
    const second = await env.unknown();
    const code = env.code();
    const responses = [env.resolve(first.effectId, { totp: code }), env.resolve(second.effectId, { totp: 'not-a-code' })];
    for (const response of responses) assert.equal(response['applied'], true, JSON.stringify(response));
    assert.equal(count(env.db, 'human_reauth'), 0);
    const everything = JSON.stringify([responses, env.db.all('SELECT * FROM event'), env.db.all('SELECT * FROM human_reauth')]);
    assert.ok(!everything.includes(code));
    assert.ok(!everything.includes('not-a-code'));
    assert.ok(!everything.includes(env.secret));
    assert.ok(!everything.includes(BODY_MARKER));
  });

  it('is not blocked by wrong TOTP attempts elsewhere (no lockout for confirmed)', async (t) => {
    const env = rig(t);
    const target = await env.unknown();
    const other = await env.unknown();
    for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) assertRefused(env.resolve(other.effectId, { outcome: 'failed', totp: env.wrong() }), 'reauth_failed');
    assertRefused(env.resolve(other.effectId, { outcome: 'failed', totp: env.code() }), 'reauth_locked');
    assert.equal(env.resolve(target.effectId).applied, true);
  });
});

describe('failed: TOTP re-authentication inside the transaction', () => {
  it('without a code → reauth_required; with a wrong code → reauth_failed; nothing is written either time', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    const before = written(env.db);
    assertRefused(env.resolve(effectId, { outcome: 'failed' }), 'reauth_required', /resolve/);
    assertRefused(env.resolve(effectId, { outcome: 'failed', totp: '' }), 'reauth_required');
    assertRefused(env.resolve(effectId, { outcome: 'failed', totp: env.wrong() }), 'reauth_failed');
    assert.deepEqual(written(env.db), before);
    assert.equal(stateOf(env.db, effectId), 'unknown');
  });

  it('a human without an enrolled secret → reauth_unavailable; nothing written', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    const before = written(env.db);
    assertRefused(env.resolve(effectId, { outcome: 'failed', totp: env.code() }, SECOND), 'reauth_unavailable');
    assert.deepEqual(written(env.db), before);
    assert.equal(stateOf(env.db, effectId), 'unknown');
  });

  it('success: exactly one human_reauth row (purpose effect-resolve:<id>:failed, at = now), the effect failed, one event; the code appears nowhere', async (t) => {
    const env = rig(t);
    const { effectId, taskId } = await env.unknown();
    env.clock.advance(5_000);
    const code = env.code();
    const response = env.resolve(effectId, { outcome: 'failed', totp: code });
    const eventId = effectResolutionEventId(effectId);
    assert.deepEqual(response, {
      ok: true, applied: true, effect_id: effectId, task_id: taskId, task_status: 'needs_review', previous_state: 'unknown', state: 'failed',
      event_id: eventId, key: `effect-resolve:${effectId}`, response_ref: null,
    });
    const reauth = env.db.all<{ actor_id: string; method: string; purpose: string; at: string }>('SELECT actor_id, method, purpose, at FROM human_reauth').map((r) => ({ ...r }));
    assert.deepEqual(reauth, [{ actor_id: OWNER, method: 'totp', purpose: `effect-resolve:${effectId}:failed`, at: env.clock.nowIso() }]);
    assert.equal(stateOf(env.db, effectId), 'failed');
    assert.equal(count(env.db, 'event'), 1);
    const everything = JSON.stringify([response, env.db.all('SELECT * FROM event'), env.db.all('SELECT * FROM human_reauth'), env.db.all('SELECT * FROM task_transition')]);
    assert.ok(!everything.includes(code));
    assert.ok(!everything.includes(env.secret));

    // 같은 결정을 되풀이하면 코드를 다시 쓰지 않는다 (재인증 전에 재생 판정)
    const again = env.resolve(effectId, { outcome: 'failed' });
    assert.equal(again['applied'], false);
    assert.equal(count(env.db, 'human_reauth'), 1);
  });

  it('a code already used in the same time step → reauth_reused; nothing written; the next step works', async (t) => {
    const env = rig(t);
    const a = await env.unknown();
    const b = await env.unknown();
    const code = env.code();
    assert.equal(env.resolve(a.effectId, { outcome: 'failed', totp: code })['applied'], true);
    const before = written(env.db);
    assertRefused(env.resolve(b.effectId, { outcome: 'failed', totp: code }), 'reauth_reused');
    assert.deepEqual(written(env.db), before);
    assert.equal(stateOf(env.db, b.effectId), 'unknown');
    env.clock.advance(30_000);
    assert.equal(env.resolve(b.effectId, { outcome: 'failed', totp: env.code() })['applied'], true);
    assert.equal(count(env.db, 'human_reauth'), 2);
  });

  it('5 consecutive wrong codes → the next request is reauth_locked even with the right code; 5 minutes later it works', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    const before = written(env.db);
    for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) assertRefused(env.resolve(effectId, { outcome: 'failed', totp: env.wrong() }), 'reauth_failed');
    assertRefused(env.resolve(effectId, { outcome: 'failed', totp: env.code() }), 'reauth_locked');
    assert.deepEqual(written(env.db), before);
    env.clock.advance(5 * 60_000);
    assert.equal(env.resolve(effectId, { outcome: 'failed', totp: env.code() })['applied'], true);
  });

  it('the lockout is shared with release: 5 wrong codes on resolve-effect → release of an approved task is refused with "too many wrong TOTP codes"', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    const taskId = approvedTask(env);
    for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) assertRefused(env.resolve(effectId, { outcome: 'failed', totp: env.wrong() }), 'reauth_failed');

    const release = env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: env.code() });
    assert.equal(release.ok, false);
    assert.match(String(release.error), /too many wrong TOTP codes/);
    assert.equal(taskStatus(env.db, taskId), 'needs_review');
    assert.equal(count(env.db, 'human_reauth'), 0);

    env.clock.advance(5 * 60_000);
    assert.deepEqual(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: env.code() }), { ok: true, state: 'queued' });
  });

  it('the lockout is shared with release in the other direction: 5 wrong codes on release → resolve-effect failed is reauth_locked', async (t) => {
    const env = rig(t);
    const { effectId } = await env.unknown();
    const taskId = approvedTask(env);
    for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) {
      const release = env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: env.wrong() });
      assert.match(String(release.error), /not valid/);
    }
    const before = written(env.db);
    assertRefused(env.resolve(effectId, { outcome: 'failed', totp: env.code() }), 'reauth_locked');
    assert.deepEqual(written(env.db), before);
    assert.equal(stateOf(env.db, effectId), 'unknown');
    // confirmed 에는 TOTP 가 필요 없으니 잠금과 무관하다
    assert.equal(env.resolve(effectId)['applied'], true);
  });
});

describe('the effects list response', () => {
  it('lists only unknown rows with snake_case fields and never exposes the effect key, the request body, references or notes', async (t) => {
    const env = rig(t);
    const a = await env.unknown();
    const b = await env.unknown();
    env.resolve(b.effectId);
    const row = env.db.get<ExternalEffectRow>('SELECT * FROM external_effect WHERE id = ?', [a.effectId])!;
    const response = env.send({ cmd: 'effects', actor: OWNER });
    assert.deepEqual(Object.keys(response).sort(), ['effects', 'now', 'ok']);
    const effects = response['effects'] as Record<string, unknown>[];
    assert.deepEqual(effects, [{
      effect_id: a.effectId, task_id: a.taskId, task_status: 'needs_review', task_run_id: row.task_run_id, tool: 'example-tool', action: 'send', target: 'mailbox:example',
      request_hash: row.request_hash, planned_at: row.planned_at, last_transition_at: row.at, supports_idempotency: false,
      resend_window_open: false, run_active: false, resolved_before: false,
    }]);
    const text = JSON.stringify(response);
    for (const forbidden of [row.effect_key, BODY_MARKER, 'effect_key', 'response_ref', 'compensation_ref', 'totp', NOTE]) {
      assert.ok(!text.includes(forbidden), `the list does not contain ${forbidden}`);
    }
    assert.deepEqual(env.send({ cmd: 'effects', actor: OWNER })['effects'], effects, 'listing is repeatable and writes nothing');
  });
});

describe('createEffectResolutionHandler with an injected re-authentication', () => {
  function handlerRig(t: TestContext, reauth: (tx: Db, actorId: string, code: string | undefined, purpose: string) => void) {
    const env = rig(t);
    const handler = createEffectResolutionHandler({ db: env.db, clock: env.clock, reauth });
    return { env, handler };
  }

  it('calls reauth once, inside the write tx, with the actor, the code and the purpose, for failed only', async (t) => {
    const calls: { inWriteTx: boolean; actor: string; code: string | undefined; purpose: string }[] = [];
    const { env, handler } = handlerRig(t, (tx, actor, code, purpose) => {
      calls.push({ inWriteTx: tx.inWriteTx, actor, code, purpose });
    });
    const a = await env.unknown();
    const b = await env.unknown();
    const request = (effectId: string, outcome: string, totp?: string) => ({ cmd: 'resolve-effect', actor: OWNER, effect_id: effectId, outcome, note: NOTE, ...(totp === undefined ? {} : { totp }) });
    assert.equal(handler(request(a.effectId, 'confirmed', '123456'))['applied'], true);
    assert.deepEqual(calls, []);
    assert.equal(handler(request(b.effectId, 'failed', '654321'))['applied'], true);
    assert.deepEqual(calls, [{ inWriteTx: true, actor: OWNER, code: '654321', purpose: `effect-resolve:${b.effectId}:failed` }]);
  });

  it('maps errors: ReauthError → reauth_reused, TotpSecretError → reauth_unavailable, ApprovalRefusedError → not_human; anything else is rethrown', async (t) => {
    let thrown: unknown = new Error('unset');
    const { env, handler } = handlerRig(t, () => {
      throw thrown;
    });
    const { effectId } = await env.unknown();
    const request = { cmd: 'resolve-effect', actor: OWNER, effect_id: effectId, outcome: 'failed', note: NOTE, totp: '123456' };
    const before = written(env.db);

    thrown = new ReauthError('this TOTP code was already used');
    assertRefused(handler(request) as Response, 'reauth_reused');
    thrown = new TotpSecretError('no TOTP secret is enrolled');
    assertRefused(handler(request) as Response, 'reauth_unavailable');
    thrown = new ApprovalRefusedError('only human actors can do this');
    assertRefused(handler(request) as Response, 'not_human');
    const boom = new Error('database is on fire');
    thrown = boom;
    assert.throws(() => handler(request), (error: unknown) => error === boom);
    assert.deepEqual(written(env.db), before);
    assert.equal(stateOf(env.db, effectId), 'unknown');
  });
});
