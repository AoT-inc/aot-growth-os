// 가짜 LLM 검증기 `createStubLlmVerifier` (A6-U12): 모델 호출이 없는 결정적 구현. 판정 규칙, 격리 입력만 받는 것, 평가기와 연결했을 때의 판정·비용 기록.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildIsolatedInput, createStubLlmVerifier, evaluateRun, ISOLATED_INPUT_KEYS, IsolationError, STUB_LLM_VERIFIER_ID,
  type IsolatedVerificationInput, type SourceText,
} from '@aot/evaluation';

import { addEvidence, EXAMPLE_URL, FakeFetcher, OTHER_URL, researchReport, submittedRun } from '../support/evaluation.ts';
import { seededDb } from '../support/seeded-db.ts';

const PAGE = 'The quarterly price is fixed for all plans.  Seats are\n counted per team.';
const source = (ref: string, text: string | null): SourceText => ({ ref, kind: 'source_url', text, contentHash: null, trustOrigin: 'external_untrusted' });
const inputOf = (claims: { id: string; statement: string; sourceRef?: string }[], sources: SourceText[] = [source(EXAMPLE_URL, PAGE), source(OTHER_URL, null)]): IsolatedVerificationInput =>
  buildIsolatedInput({
    check: 'claim_supported_by_source', criteria: ['every claim is supported'],
    claims: claims.map((claim) => ({ id: claim.id, statement: claim.statement, sourceRef: claim.sourceRef ?? EXAMPLE_URL })), sources,
  });

test('default rule: a claim sentence that appears in its source (whitespace ignored, case kept) is supported; otherwise unsupported; an unread source is unclear', async () => {
  const stub = createStubLlmVerifier();
  assert.equal(stub.id, STUB_LLM_VERIFIER_ID);
  assert.match(stub.id, /stub/, 'the name says it is not a real verifier');
  const verdictOf = async (claims: { id: string; statement: string; sourceRef?: string }[]) => (await stub.verify(inputOf(claims))).verdict;

  assert.equal(await verdictOf([{ id: 'c1', statement: 'The quarterly price is fixed' }]), 'supported');
  assert.equal(await verdictOf([{ id: 'c1', statement: 'Seats are counted   per team.' }]), 'supported', 'whitespace differences are ignored');
  assert.equal(await verdictOf([{ id: 'c1', statement: 'the quarterly price is fixed' }]), 'unsupported', 'case differences are not');
  assert.equal(await verdictOf([{ id: 'c1', statement: 'Prices doubled last week.' }]), 'unsupported');
  assert.equal(await verdictOf([{ id: 'c1', statement: 'The quarterly price is fixed', sourceRef: OTHER_URL }]), 'unclear', 'a source that could not be read decides nothing');
  assert.equal(await verdictOf([]), 'unclear', 'no claim to verify');
  // 하나라도 뒷받침되지 않으면 unsupported, unsupported 가 없고 unclear 가 있으면 unclear
  assert.equal(await verdictOf([{ id: 'a', statement: 'The quarterly price is fixed' }, { id: 'b', statement: 'Prices doubled.' }]), 'unsupported');
  assert.equal(await verdictOf([{ id: 'a', statement: 'The quarterly price is fixed' }, { id: 'b', statement: 'x', sourceRef: OTHER_URL }]), 'unclear');
  assert.equal(await verdictOf([{ id: 'a', statement: 'Prices doubled.' }, { id: 'b', statement: 'x', sourceRef: OTHER_URL }]), 'unsupported');
  const unsupported = await stub.verify(inputOf([{ id: 'c9', statement: 'Prices doubled.' }]));
  assert.match(unsupported.note, /unsupported claim\(s\): c9/);
  assert.match(unsupported.note, /no model call/);
});

test('an injected verdict table wins over the rule, and an injected rule replaces the default; same input -> same verdict (deterministic)', async () => {
  const claims = [{ id: 'a', statement: 'The quarterly price is fixed' }, { id: 'b', statement: 'Prices doubled.' }];
  const table = createStubLlmVerifier({ verdicts: { a: 'unsupported' } });
  assert.equal((await table.verify(inputOf(claims))).verdict, 'unsupported');
  const tableOnly = createStubLlmVerifier({ verdicts: { a: 'supported', b: 'supported' } });
  assert.equal((await tableOnly.verify(inputOf(claims))).verdict, 'supported');
  const rule = createStubLlmVerifier({ rule: (claim) => (claim.id === 'a' ? 'supported' : 'unclear') });
  assert.equal((await rule.verify(inputOf(claims))).verdict, 'unclear');
  const again = createStubLlmVerifier();
  assert.deepEqual(await again.verify(inputOf(claims)), await again.verify(inputOf(claims)));
  assert.throws(() => createStubLlmVerifier({ costUsd: -1 }), RangeError);
  assert.throws(() => createStubLlmVerifier({ costUsd: Number.NaN }), RangeError);
});

test('isolation: it takes exactly the isolated input shape; any extra key (a report, a prompt, a session) is refused and never read', async () => {
  const stub = createStubLlmVerifier();
  const good = inputOf([{ id: 'c1', statement: 'The quarterly price is fixed' }]);
  assert.deepEqual(Object.keys(good).sort(), [...ISOLATED_INPUT_KEYS]);
  for (const extra of ['report', 'prompt', 'session', 'reasoning']) {
    const tainted = { ...good, [extra]: 'The quarterly price is fixed for all plans.' } as unknown as IsolatedVerificationInput;
    await assert.rejects(() => stub.verify(tainted), IsolationError, extra);
  }
  const missing = { check: good.check, claims: good.claims, criteria: good.criteria } as unknown as IsolatedVerificationInput;
  await assert.rejects(() => stub.verify(missing), IsolationError);
});

const LLM_SPEC = { validation: { deterministic: ['url_reachable'], llm: { check: 'claim_supported_by_source', isolated_context: true }, human: false } };

async function evaluateWith(t: Parameters<typeof seededDb>[0], statement: string, stub = createStubLlmVerifier()) {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: LLM_SPEC, result: researchReport([{ id: 'c1', statement, source_url: EXAMPLE_URL }]) });
  addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL });
  const { evaluation } = await evaluateRun({ db, clock, fetcher: new FakeFetcher({ [EXAMPLE_URL]: PAGE }), llm: stub }, { taskId: run.taskId, taskRunId: run.runId });
  return { db, run, evaluation };
}

test('through the evaluator: supported -> pass, unsupported -> fail; the report text never reaches the stub (only the claim sentence and the original source)', async (t) => {
  const passed = await evaluateWith(t, 'The quarterly price is fixed for all plans.');
  assert.equal(passed.evaluation.outcome, 'pass');
  assert.match(passed.evaluation.quality_note ?? '', new RegExp(`${STUB_LLM_VERIFIER_ID}: supported`));
  assert.equal(passed.evaluation.total_cost_usd, 0, 'the stub costs nothing by default');
  assert.equal(passed.db.get('SELECT 1 AS one FROM cost_entry WHERE task_id = ?', [passed.run.taskId]), undefined, 'no cost entry for a zero cost');

  const failed = await evaluateWith(t, 'Prices doubled last week.');
  assert.equal(failed.evaluation.outcome, 'fail');
  assert.match(failed.evaluation.quality_note ?? '', /LLM verification found unsupported claim/);
});

test('a configured stub cost is recorded as a validation cost entry (units.source = validation) on the run', async (t) => {
  const { db, run, evaluation } = await evaluateWith(t, 'The quarterly price is fixed', createStubLlmVerifier({ costUsd: 0.003 }));
  assert.equal(evaluation.outcome, 'pass');
  assert.equal(evaluation.total_cost_usd, 0.003);
  const entry = db.get<{ category: string; units: string; task_run_id: string; amount_usd: number }>('SELECT category, units, task_run_id, amount_usd FROM cost_entry WHERE task_id = ?', [run.taskId])!;
  assert.deepEqual({ category: entry.category, run: entry.task_run_id, amount: entry.amount_usd, units: JSON.parse(entry.units) }, {
    category: 'llm', run: run.runId, amount: 0.003, units: { source: 'validation', verifier: STUB_LLM_VERIFIER_ID },
  });
});
