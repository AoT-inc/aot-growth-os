// 위임 주기 (ADR-0016, 제안)의 순수 부분: 검토자 출력 검사와 데몬 설정. 엔진과 이어 도는 흐름은 test/integration/daemon-delegation.test.ts 가 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { ApprovalEngine, DelegateDecision, DelegationScanEntry } from '@aot/policy';

import { createDelegateCycle, createStubDelegateReviewer, delegateReviewerFromConfig, parseDelegateReviewerConfig, parseReviewOutput } from '../../apps/daemon/src/delegate-cycle.ts';

const HASH = 'a'.repeat(64);

const REASON = '정해 둔 기준 안의 안내 메일이라 보내도 됩니다';

test('the reviewer output is checked strictly: exactly verdict, hash and reason; a Korean reason within 200 characters; the current hash', () => {
  assert.deepEqual(parseReviewOutput({ verdict: 'approve', hash: HASH, reason: ` ${REASON} ` }, HASH), { ok: true, verdict: 'approve', reason: REASON });
  assert.deepEqual(parseReviewOutput(JSON.stringify({ verdict: 'request_changes', hash: HASH, reason: '더 짧게 써야 합니다' }), HASH), { ok: true, verdict: 'request_changes', reason: '더 짧게 써야 합니다' });
  assert.equal(parseReviewOutput({ verdict: 'escalate', hash: HASH, reason: '확실하지 않습니다' }, HASH).ok, true);
  assert.equal(parseReviewOutput({ verdict: 'approve', hash: HASH, reason: `가${'a'.repeat(199)}` }, HASH).ok, true, '200 characters is allowed');
  const bad: unknown[] = [
    null, undefined, 42, [], 'not json', '{"verdict": ', {}, { verdict: 'reject', hash: HASH, reason: REASON }, { verdict: 'Approve', hash: HASH, reason: REASON }, { verdict: 'approve', hash: HASH },
    { verdict: 'approve', hash: HASH, reason: '  ' }, { verdict: 'approve', reason: REASON }, { verdict: ['approve'], hash: HASH, reason: REASON },
    { verdict: 'approve', hash: HASH, reason: REASON, extra: 1 },
    { verdict: 'approve', hash: HASH, reason: 'looks routine, fine to send' },
    { verdict: 'approve', hash: HASH, reason: `가${'a'.repeat(200)}` },
    { verdict: 'approve', hash: HASH, reason: 42 },
    '```json\n{"verdict":"approve","hash":"' + HASH + '","reason":"' + REASON + '"}\n```',
    'Sure! {"verdict":"approve","hash":"' + HASH + '","reason":"' + REASON + '"}',
  ];
  for (const output of bad) {
    const parsed = parseReviewOutput(output, HASH);
    assert.equal(parsed.ok, false, JSON.stringify(output));
    assert.match(parsed.ok ? '' : parsed.reason, /AI 응답 형식 오류/);
  }
  const mismatch = parseReviewOutput({ verdict: 'approve', hash: 'b'.repeat(64), reason: REASON }, HASH);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.ok ? '' : mismatch.reason, /해시가 다릅니다/);
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
  const result = await reviewer.review({ taskId: 't', hash: HASH, material: { objective: 'o', mandate: { id: 'm', guidance: 'g', limits: {} as never }, drafts: [], history: [], facts: {} as never } });
  assert.deepEqual(result, { output: { verdict: 'approve', hash: HASH, reason: '시험용 가짜 검토자의 판정입니다' }, costUsd: 0.5 });
  const defaulted = await createStubDelegateReviewer().review({ taskId: 't', hash: HASH, material: {} as never });
  assert.equal((defaulted.output as { verdict: string }).verdict, 'escalate', 'the default stub passes everything to a person');
});

test('request_changes once per task: when the AI already used its rewrite the cycle converts it into an escalate with a Korean reason', async () => {
  const decisions: DelegateDecision[] = [];
  const entry = (used: number): DelegationScanEntry => ({
    taskId: 't1', hash: HASH, eligibility: { eligible: true, mandate: {} as never },
    review: { objective: 'o', mandate: { id: 'm', guidance: 'g', limits: {} as never }, drafts: [], history: [], facts: { draft_count: 1, recipient_rule: 'known_contacts', payload_bytes: 10, rewrites_used: used, rewrites_allowed: 1 } },
  });
  const run = async (used: number) => {
    decisions.length = 0;
    let scans = 0;
    const engine = {
      releaseDelegated: () => [],
      delegationScan: () => (scans++ === 0 ? [entry(used)] : []),
      delegateDecide: (input: DelegateDecision) => { decisions.push(input); return { ok: true, recorded: 'escalated', mandate_id: 'm' }; },
    } as unknown as ApprovalEngine;
    const reviewer = createStubDelegateReviewer({ verdict: 'request_changes', reason: '제목을 더 분명하게 다시 써 주세요' });
    return createDelegateCycle({ engine, reviewer }).advance();
  };
  await run(0);
  assert.deepEqual(decisions.map((d) => [d.verdict, d.reason]), [['request_changes', '제목을 더 분명하게 다시 써 주세요']], 'the first rewrite goes through to the engine');
  const second = await run(1);
  assert.deepEqual(decisions.map((d) => [d.verdict, d.reason]), [['escalate', 'AI가 다시 쓰게 할 수 있는 횟수를 이미 썼습니다']]);
  assert.equal(second.decided[0]!.verdict, 'escalate');
});
