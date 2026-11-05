// 검토 화면 결정 보내기의 순수 부분: 폼 nonce, 속도 제한, 결과 보관, 출처 확인, 지문, 영어 문장 → 사유 코드 짐작.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fingerprint, type Button } from '../../apps/daemon/src/review-web/actions.ts';
import { inferCode } from '../../apps/daemon/src/review-web/decide.ts';
import { FormGuard, NONCE_TTL_MS } from '../../apps/daemon/src/review-web/nonce.ts';
import { originAllowed } from '../../apps/daemon/src/review-web/server.ts';
import { RateLimiter, ResultStore, RESULT_TTL_MS } from '../../apps/daemon/src/review-web/write-state.ts';

const fields = (guard: FormGuard, now: number, over: Partial<{ verb: string; key: string; hash: string; issued: string; nonce: string }> = {}) => {
  const issued = guard.issue('approve', 'task:t1', 'h1', now);
  return { verb: 'approve', key: 'task:t1', hash: 'h1', ...issued, ...over };
};

test('FormGuard: valid once, then used; a different button, target, fingerprint, time or key is bad', () => {
  const guard = new FormGuard('key-one');
  const f = fields(guard, 1_000_000);
  assert.equal(guard.check(f, 1_000_000), 'ok');
  assert.equal(guard.check(f, 1_000_000), 'ok', 'checking does not consume');
  guard.consume(f.nonce, 1_000_000, 'result-1');
  assert.equal(guard.check(f, 1_000_001), 'used');
  assert.equal(guard.resultOf(f.nonce), 'result-1');
  for (const over of [{ verb: 'reject' }, { key: 'task:t2' }, { hash: 'h2' }, { issued: '1000001' }, { nonce: '0'.repeat(64) }, { nonce: 'zz' }, { nonce: '' }, { issued: 'abc' }]) {
    assert.equal(guard.check(fields(guard, 1_000_000, over), 1_000_000), 'bad', JSON.stringify(over));
  }
  assert.equal(new FormGuard('key-two').check(fields(guard, 5), 5), 'bad', 'another session key');
});

test('FormGuard: expires after thirty minutes, and not from the future', () => {
  const guard = new FormGuard(Buffer.from('k'));
  const f = fields(guard, 10_000_000);
  assert.equal(guard.check(f, 10_000_000 + NONCE_TTL_MS), 'ok');
  assert.equal(guard.check(f, 10_000_000 + NONCE_TTL_MS + 1), 'expired');
  assert.equal(guard.check(f, 10_000_000 - 120_000), 'expired', 'issued in the future');
});

test('RateLimiter allows `limit` takes per window and frees them as the window moves', () => {
  const limiter = new RateLimiter(3, 1_000);
  assert.deepEqual([0, 100, 200, 300].map((t) => limiter.take(t)), [true, true, true, false]);
  assert.equal(limiter.take(1_050), true, 'the first hit left the window');
  assert.equal(limiter.take(1_060), false);
});

test('ResultStore keeps a result for ten minutes under a random id', () => {
  const store = new ResultStore();
  const base = { at: 0, button: '승인', done: '승인했습니다.', href: '/', steps: [] };
  const id = store.put(base, 0);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(store.put(base, 0) === id, false);
  assert.equal(store.get(id, RESULT_TTL_MS)?.done, '승인했습니다.');
  assert.equal(store.get(id, RESULT_TTL_MS + 1), undefined);
  assert.equal(store.get('missing', 0), undefined);
});

test('originAllowed needs an Origin equal to this server and to the Host', () => {
  assert.equal(originAllowed('http://127.0.0.1:8787', '127.0.0.1:8787', 8787), true);
  assert.equal(originAllowed('http://localhost:8787', 'localhost:8787', 8787), true);
  assert.equal(originAllowed('HTTP://LOCALHOST:8787', 'LocalHost:8787', 8787), true);
  for (const [origin, host] of [[undefined, '127.0.0.1:8787'], ['null', '127.0.0.1:8787'], ['http://127.0.0.1:8787', undefined], ['http://localhost:8787', '127.0.0.1:8787'], ['https://127.0.0.1:8787', '127.0.0.1:8787'],
    ['http://127.0.0.1:8788', '127.0.0.1:8788'], ['http://127.0.0.1:8787/', '127.0.0.1:8787'], ['http://evil.example', 'evil.example']] as const) {
    assert.equal(originAllowed(origin, host, 8787), false, `${origin} / ${host}`);
  }
});

test('fingerprint changes with the button, the requests, the hashes and the OTP need', () => {
  const base: Button = { verb: 'approve', label: '승인', tone: 'yes', reason: 'none', done: '됨', steps: [{ label: 'a', request: { cmd: 'approve', kind: 'task', id: '1', hash: 'h' }, hash: 'h' }] };
  const same = fingerprint({ ...base, label: '다른 이름표', note: '다른 설명' });
  assert.equal(same, fingerprint(base), 'only what is sent counts');
  assert.notEqual(fingerprint({ ...base, verb: 'reject' }), fingerprint(base));
  assert.notEqual(fingerprint({ ...base, otp: true }), fingerprint(base));
  assert.notEqual(fingerprint({ ...base, steps: [{ ...base.steps[0]!, hash: 'h2' }] }), fingerprint(base));
  assert.notEqual(fingerprint({ ...base, steps: [...base.steps, { label: 'b', request: { cmd: 'approve', kind: 'task', id: '2', hash: 'h' }, hash: 'h' }] }), fingerprint(base));
  assert.match(fingerprint(base), /^[0-9a-f]{64}$/);
});

test('inferCode guesses a reason code from the engine sentence only as a fallback', () => {
  const cases: [string, string | undefined][] = [
    ['the task changed since it was shown (subject hash mismatch); show it again before approving', 'hash_mismatch'],
    ['the task or the policy changed since approval (approved_hash mismatch); re-approval required', 'hash_mismatch'],
    ['1 draft(s) already left the ledger (d: sent); rejecting would let a rewritten draft send the same content again.', 'send_started'],
    ["2 of 3 drafts would show masked values (d1: to)", 'masked'],
    ['draft expired (1 of 2 past expires_at)', 'expired'],
    ['the current policy denies this task (x)', 'policy_denied'],
    ['the requester cannot approve their own task (self-approval is allowed only when risky_change.min_approvers is 1)', 'self_approval'],
    ['a TOTP code is required to release this risky change', 'reauth_required'],
    ['the TOTP code is not valid', 'reauth_failed'],
    ['too many wrong TOTP codes; try again later', 'reauth_locked'],
    ["only human actors can use the approval channel; 'a' is 'agent'", 'not_human'],
    ["task 't' is 'completed'; approvals apply to tasks in needs_review", 'wrong_state'],
    ["task 't' does not exist", 'wrong_state'],
    ['something else entirely', undefined],
  ];
  for (const [sentence, code] of cases) assert.equal(inferCode(sentence), code, sentence);
  assert.equal(inferCode(undefined), undefined);
});
