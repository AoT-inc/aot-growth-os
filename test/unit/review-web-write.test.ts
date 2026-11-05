// 검토 화면 결정 보내기의 순수 부분: 폼 nonce, 속도 제한, 결과 보관, 출처 확인, 지문, 영어 문장 → 사유 코드 짐작.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fingerprint, type Button } from '../../apps/daemon/src/review-web/actions.ts';
import { failureOf } from '../../apps/daemon/src/review-web/decide.ts';
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

test('the failure text comes from the engine code only: every contract code has one Korean conclusion and a next step, and English engine text never becomes the headline', () => {
  const codes = ['hash_mismatch', 'wrong_state', 'send_started', 'masked', 'expired', 'policy_denied', 'self_approval', 'cooldown', 'reauth_required', 'reauth_failed', 'reauth_locked', 'not_human', 'bad_request'];
  for (const code of codes) {
    const failure = failureOf({ label: '업무', outcome: 'refused', code, error: 'the task changed since it was shown (expected_hash mismatch)' });
    assert.match(failure.headline, /[가-힣]/, code);
    assert.ok(!/[A-Za-z]{4,}/.test(failure.headline) || /OTP/.test(failure.headline), `${code}: ${failure.headline}`);
    assert.ok(failure.next.length >= 1, code);
  }
  // 코드가 없거나 모르는 코드: 한 줄 결론 + 다음 단계 (영어 문장을 짐작해 코드로 바꾸지 않는다)
  for (const code of [undefined, 'strategy_not_experiment']) {
    const failure = failureOf({ label: '업무', outcome: 'refused', code, error: 'the task changed since it was shown (subject hash mismatch)' });
    assert.equal(failure.headline, '처리하지 못했습니다.');
    assert.deepEqual(failure.next, ['fresh']);
  }
  assert.match(failureOf({ label: 'x', outcome: 'unreachable' }).headline, /데몬이 꺼져/);
  assert.match(failureOf({ label: 'x', outcome: 'unknown' }).headline, /확인하지 못했습니다/);
});
