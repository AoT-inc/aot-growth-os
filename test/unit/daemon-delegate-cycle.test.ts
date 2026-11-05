// 위임 주기 (ADR-0016, 제안)의 순수 부분: 검토자 출력 검사와 데몬 설정. 엔진과 이어 도는 흐름은 test/integration/daemon-delegation.test.ts 가 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createStubDelegateReviewer, delegateReviewerFromConfig, parseDelegateReviewerConfig, parseReviewOutput } from '../../apps/daemon/src/delegate-cycle.ts';

const HASH = 'a'.repeat(64);

test('the reviewer output is checked: shape, the current hash, a known verdict and a reason; anything else is a format error', () => {
  assert.deepEqual(parseReviewOutput({ verdict: 'approve', hash: HASH, reason: ' routine ' }, HASH), { ok: true, verdict: 'approve', reason: 'routine' });
  assert.deepEqual(parseReviewOutput(JSON.stringify({ verdict: 'request_changes', hash: HASH, reason: 'shorter' }), HASH), { ok: true, verdict: 'request_changes', reason: 'shorter' });
  assert.equal(parseReviewOutput({ verdict: 'escalate', hash: HASH, reason: 'unsure' }, HASH).ok, true);
  const bad: unknown[] = [
    null, undefined, 42, [], 'not json', '{"verdict": ', {}, { verdict: 'reject', hash: HASH, reason: 'x' }, { verdict: 'approve', hash: HASH }, { verdict: 'approve', hash: HASH, reason: '  ' },
    { verdict: 'approve', hash: 'b'.repeat(64), reason: 'x' }, { verdict: 'approve', reason: 'x' }, { verdict: ['approve'], hash: HASH, reason: 'x' },
  ];
  for (const output of bad) {
    const parsed = parseReviewOutput(output, HASH);
    assert.equal(parsed.ok, false, JSON.stringify(output));
    assert.match(parsed.ok ? '' : parsed.reason, /AI 응답 형식 오류/);
  }
});

const TEST = { allowStub: true };

test('the stub reviewer is test-only: the daemon config cannot load it (it could approve everything eligible), and production assembly never passes the flag', () => {
  for (const value of [{ kind: 'stub' }, { kind: 'stub', verdict: 'approve' }, { kind: 'stub', verdict: 'escalate', cost_usd: 0 }]) {
    assert.throws(() => parseDelegateReviewerConfig(value), /test-only/, JSON.stringify(value));
  }
  assert.equal(parseDelegateReviewerConfig(undefined), undefined, 'no reviewer configured is fine');
  assert.doesNotMatch(readFileSync(new URL('../../apps/daemon/src/main.ts', import.meta.url), 'utf8'), /allowStub/);
});

test('the daemon config delegate_reviewer: only a stub is accepted; unknown kinds, keys and values are rejected; absent means no reviewer', async () => {
  assert.equal(parseDelegateReviewerConfig(undefined), undefined);
  assert.equal(parseDelegateReviewerConfig(null), undefined);
  assert.equal(delegateReviewerFromConfig(undefined), undefined);
  assert.deepEqual(parseDelegateReviewerConfig({ kind: 'stub' }, TEST), { kind: 'stub' });
  assert.deepEqual(parseDelegateReviewerConfig({ kind: 'stub', verdict: 'approve', cost_usd: 0.1 }, TEST), { kind: 'stub', verdict: 'approve', cost_usd: 0.1 });
  for (const value of ['stub', [], { kind: 'claude' }, { kind: 'stub', extra: 1 }, { kind: 'stub', verdict: 'reject' }, { kind: 'stub', cost_usd: -1 }, { kind: 'stub', cost_usd: 'x' }]) {
    assert.throws(() => parseDelegateReviewerConfig(value, TEST), /delegate_reviewer/, JSON.stringify(value));
  }
  const reviewer = delegateReviewerFromConfig({ kind: 'stub', verdict: 'approve', cost_usd: 0.5 })!;
  const result = await reviewer.review({ taskId: 't', hash: HASH, material: { objective: 'o', mandate: { id: 'm', guidance: 'g', limits: {} as never }, drafts: [], history: [] } });
  assert.deepEqual(result, { output: { verdict: 'approve', hash: HASH, reason: 'stub reviewer' }, costUsd: 0.5 });
  const defaulted = await createStubDelegateReviewer().review({ taskId: 't', hash: HASH, material: {} as never });
  assert.equal((defaulted.output as { verdict: string }).verdict, 'escalate', 'the default stub passes everything to a person');
});
