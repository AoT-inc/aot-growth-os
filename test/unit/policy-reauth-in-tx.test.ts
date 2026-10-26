// ApprovalEngine.reauthenticateInTx: 호출자의 write 트랜잭션 안에서 하는 TOTP 재인증 (효과 해소 failed 가 쓴다).
// release 와 같은 연속 실패 잠금(#failures)을 공유하고, 성공하면 human_reauth 행을 정확히 하나 쓴다.
// 트랜잭션 밖 호출·'release:' 목적은 아무것도 세기 전에 plain Error 로 거부된다(잠금 우회·소진 방지).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Db } from '@aot/domain';
import {
  ApprovalRefusedError, ReauthError, ReauthRefusedError, TOTP_LOCKOUT_MS, TOTP_MAX_FAILURES, TotpSecretError, totpStep,
  type ReauthRefusalCode,
} from '@aot/policy';
import { claimNextTask } from '@aot/task-engine';

import { taskStatus } from '../support/engine.ts';
import { AGENT, approve, createWithGate, effectDraft, HOUR, OWNER, policyEnv, REVIEWER, type PolicyEnv } from '../support/policy.ts';

const PURPOSE = 'effect-resolve:effect-1:failed';
const count = (db: Db, table = 'human_reauth'): number => Number(db.get(`SELECT count(*) AS n FROM ${table}`)?.['n']);

/** 호출자의 write 트랜잭션 안에서 재인증 */
const reauth = (env: PolicyEnv, actor: string, code: string | undefined, purpose = PURPOSE): void =>
  env.db.writeTx((tx) => env.engine.reauthenticateInTx(tx, actor, code, purpose));

const wrong = (env: PolicyEnv, actor = OWNER): string => String((Number(env.code(actor)) + 1) % 1_000_000).padStart(6, '0');

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** 거부 코드까지 확인 */
function refusedWith(fn: () => unknown, code: ReauthRefusalCode, pattern: RegExp): void {
  const error = caught(fn);
  assert.ok(error instanceof ReauthRefusedError, `expected ReauthRefusedError(${code}), got ${String(error)}`);
  assert.ok(error instanceof ApprovalRefusedError, 'it is an ApprovalRefusedError too');
  assert.equal(error.code, code);
  assert.match(error.message, pattern);
}

/** 승인이 필요한 업무를 needs_review 로 보내 승인하고 cooldown 이 끝나게 한다 (release 시험용) */
function releasable(env: PolicyEnv): string {
  const id = createWithGate(env, effectDraft());
  assert.equal(claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', leaseMs: 90_000, taskId: id }).claimed, null);
  assert.equal(taskStatus(env.db, id), 'needs_review');
  assert.equal(approve(env, id).ok, true);
  env.clock.advance(HOUR);
  return id;
}

const release = (env: PolicyEnv, id: string, code: string) => env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: code });

test('success writes exactly one human_reauth row (actor, totp, time step, purpose, now) and nothing else', (t) => {
  const env = policyEnv(t);
  env.clock.advance(12_345);
  const before = { approval: count(env.db, 'approval'), event: count(env.db, 'event'), transition: count(env.db, 'task_transition'), decision: count(env.db, 'policy_decision') };
  assert.equal(reauth(env, OWNER, env.code()), undefined);
  const rows = env.db.all<{ actor_id: string; method: string; time_step: number; purpose: string; at: string }>('SELECT actor_id, method, time_step, purpose, at FROM human_reauth');
  assert.deepEqual(rows.map((r) => ({ ...r, time_step: Number(r.time_step) })), [
    { actor_id: OWNER, method: 'totp', time_step: totpStep(env.clock.nowMs()), purpose: PURPOSE, at: env.clock.nowIso() },
  ]);
  assert.deepEqual(before, { approval: count(env.db, 'approval'), event: count(env.db, 'event'), transition: count(env.db, 'task_transition'), decision: count(env.db, 'policy_decision') });
  // 비밀과 코드는 남지 않는다
  const dump = JSON.stringify(env.db.all('SELECT * FROM human_reauth'));
  assert.ok(!dump.includes(env.secrets.get(OWNER)!));
});

test('the row belongs to the caller\'s transaction: if the caller throws afterwards, it is rolled back', (t) => {
  const env = policyEnv(t);
  const code = env.code();
  assert.throws(() => env.db.writeTx((tx) => {
    env.engine.reauthenticateInTx(tx, OWNER, code, PURPOSE);
    assert.equal(count(tx), 1);
    throw new Error('later step failed');
  }), /later step failed/);
  assert.equal(count(env.db), 0);
  // 롤백됐으니 같은 코드가 소진되지 않았다
  assert.equal(reauth(env, OWNER, code), undefined);
  assert.equal(count(env.db), 1);
});

test('outside a write transaction it throws a plain Error and counts no failure', (t) => {
  const env = policyEnv(t);
  for (let i = 0; i < TOTP_MAX_FAILURES + 2; i += 1) {
    const error = caught(() => env.engine.reauthenticateInTx(env.db, OWNER, wrong(env), PURPOSE));
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof ApprovalRefusedError), 'a caller bug, not a refusal');
    assert.ok(!(error instanceof ReauthRefusedError));
  }
  assert.equal(count(env.db), 0);
  // 틀린 코드가 세어졌다면 잠겨 있을 것이다
  assert.equal(reauth(env, OWNER, env.code()), undefined);
  // 올바른 코드도 트랜잭션 밖에서는 쓰지 않는다
  env.clock.advance(30_000);
  assert.throws(() => env.engine.reauthenticateInTx(env.db, OWNER, env.code(), PURPOSE), Error);
  assert.equal(count(env.db), 1);
});

test('a release: purpose is refused before anything is counted or written', (t) => {
  const env = policyEnv(t);
  for (const purpose of ['release:task:x:abc', 'release:']) {
    for (let i = 0; i < TOTP_MAX_FAILURES + 2; i += 1) {
      const error = caught(() => reauth(env, OWNER, wrong(env), purpose));
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof ApprovalRefusedError));
    }
    const withRightCode = caught(() => reauth(env, OWNER, env.code(), purpose));
    assert.ok(withRightCode instanceof Error && !(withRightCode instanceof ApprovalRefusedError));
  }
  assert.equal(count(env.db), 0, 'no row, so the code is not spent either');
  assert.equal(reauth(env, OWNER, env.code()), undefined, 'and the actor is not locked');
});

test('an agent actor is refused with ApprovalRefusedError; nothing is written', (t) => {
  const env = policyEnv(t);
  const error = caught(() => reauth(env, AGENT, env.code()));
  assert.ok(error instanceof ApprovalRefusedError);
  assert.match(error.message, /human/);
  assert.equal(count(env.db), 0);
});

test('refusal codes: reauth_required (no code), reauth_failed (wrong), reauth_locked (after 5 wrong); messages as in release', (t) => {
  const env = policyEnv(t);
  refusedWith(() => reauth(env, OWNER, undefined), 'reauth_required', /TOTP code is required/);
  refusedWith(() => reauth(env, OWNER, ''), 'reauth_required', /TOTP code is required/);
  for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) refusedWith(() => reauth(env, OWNER, wrong(env)), 'reauth_failed', /not valid/);
  refusedWith(() => reauth(env, OWNER, env.code()), 'reauth_locked', /too many wrong TOTP codes/);
  assert.equal(count(env.db), 0);
  env.clock.advance(TOTP_LOCKOUT_MS);
  assert.equal(reauth(env, OWNER, env.code()), undefined);
  assert.equal(count(env.db), 1);
});

test('a successful re-authentication resets the failure count; lockouts are per actor', (t) => {
  const env = policyEnv(t);
  for (let i = 0; i < TOTP_MAX_FAILURES - 1; i += 1) refusedWith(() => reauth(env, OWNER, wrong(env)), 'reauth_failed', /not valid/);
  assert.equal(reauth(env, OWNER, env.code()), undefined);
  env.clock.advance(30_000);
  for (let i = 0; i < TOTP_MAX_FAILURES - 1; i += 1) refusedWith(() => reauth(env, OWNER, wrong(env)), 'reauth_failed', /not valid/);

  // 성공 뒤에 다시 세기 시작했으니 4번 틀린 상태: 한 번 더 틀리면 5회, 그 다음은 잠긴다. 다른 사람은 영향이 없다
  refusedWith(() => reauth(env, OWNER, wrong(env)), 'reauth_failed', /not valid/);
  refusedWith(() => reauth(env, OWNER, env.code()), 'reauth_locked', /too many/);
  assert.equal(reauth(env, REVIEWER, env.code(REVIEWER), 'effect-resolve:effect-2:failed'), undefined);
});

test('a code from the same (or an earlier) time step is ReauthError; a missing secret is TotpSecretError', (t) => {
  const env = policyEnv(t);
  const code = env.code();
  reauth(env, OWNER, code);
  const reused = caught(() => reauth(env, OWNER, code, 'effect-resolve:effect-2:failed'));
  assert.ok(reused instanceof ReauthError, String(reused));
  assert.ok(!(reused instanceof ApprovalRefusedError));
  assert.equal(count(env.db), 1);
  env.clock.advance(30_000);
  assert.equal(reauth(env, OWNER, env.code(), 'effect-resolve:effect-2:failed'), undefined);

  env.db.writeTx((tx) => tx.run('INSERT INTO actor (id, kind, name, adapter, created_at) VALUES (?, ?, ?, NULL, ?)', ['actor-nosecret', 'human', 'example-nosecret', env.clock.nowIso()]));
  assert.ok(caught(() => reauth(env, 'actor-nosecret', env.code())) instanceof TotpSecretError);
  assert.equal(count(env.db), 2);
});

test('replaying a spent (valid) code is ReauthError and does not reset the failure count', (t) => {
  const env = policyEnv(t);
  const spent = env.code();
  reauth(env, OWNER, spent);
  for (let i = 0; i < TOTP_MAX_FAILURES - 1; i += 1) refusedWith(() => reauth(env, OWNER, wrong(env), 'effect-resolve:effect-2:failed'), 'reauth_failed', /not valid/);
  assert.ok(caught(() => reauth(env, OWNER, spent, 'effect-resolve:effect-2:failed')) instanceof ReauthError);
  // 재생이 횟수를 지웠다면 여기서 5번째가 아니라 1번째 실패가 된다
  refusedWith(() => reauth(env, OWNER, wrong(env), 'effect-resolve:effect-2:failed'), 'reauth_failed', /not valid/);
  refusedWith(() => reauth(env, OWNER, wrong(env), 'effect-resolve:effect-2:failed'), 'reauth_locked', /too many/);
  env.clock.advance(30_000);
  refusedWith(() => reauth(env, OWNER, env.code(), 'effect-resolve:effect-2:failed'), 'reauth_locked', /too many/);
  assert.equal(count(env.db), 1);
});

test('the missing-code message of reauthenticateInTx names the effect resolution, not a release', (t) => {
  const env = policyEnv(t);
  refusedWith(() => reauth(env, OWNER, undefined), 'reauth_required', /resolve an effect as failed/);
});

test('the lockout is shared with release: wrong codes on reauthenticateInTx lock a later release', (t) => {
  const env = policyEnv(t);
  const id = releasable(env);
  for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) refusedWith(() => reauth(env, OWNER, wrong(env)), 'reauth_failed', /not valid/);
  const refused = release(env, id, env.code());
  assert.equal(refused.ok, false);
  assert.match(String(refused['error']), /too many wrong TOTP codes/);
  assert.equal(taskStatus(env.db, id), 'needs_review');
  env.clock.advance(TOTP_LOCKOUT_MS);
  assert.deepEqual(release(env, id, env.code()), { ok: true, state: 'queued' });
});

test('the lockout is shared with release in the other direction: wrong codes on release lock reauthenticateInTx', (t) => {
  const env = policyEnv(t);
  const id = releasable(env);
  for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) assert.match(String(release(env, id, wrong(env))['error']), /not valid/);
  refusedWith(() => reauth(env, OWNER, env.code()), 'reauth_locked', /too many wrong TOTP codes/);
  assert.equal(count(env.db), 0);
});

test('a successful release and a successful reauthenticateInTx spend the same code stream: the second use of a step is refused', (t) => {
  const env = policyEnv(t);
  const id = releasable(env);
  const code = env.code();
  assert.deepEqual(release(env, id, code), { ok: true, state: 'queued' });
  const error = caught(() => reauth(env, OWNER, code));
  assert.ok(error instanceof ReauthError, String(error));
  assert.equal(count(env.db), 1);
});
