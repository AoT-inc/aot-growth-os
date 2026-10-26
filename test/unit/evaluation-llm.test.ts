// 컨텍스트 분리 LLM 검증 인터페이스 (ADR-0007 §1-2, evaluation.md §1·§3-3). 포트와 가짜 구현만 있고 실제 모델 호출은 없다.
// "실행 에이전트의 프롬프트·세션·보고서 전문이 검증 입력에 섞이지 않는다"를 타입(tsc)과 실행 시험으로 고정한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildIsolatedInput, costForRun, evaluateRun, recordCost, ISOLATED_INPUT_KEYS, IsolationError, MAX_STATEMENT_CHARS, SHADOW_VERDICT_SOURCE, SHADOW_VERDICT_TYPE, VerifierUnavailableError,
  type ClaimStatement, type IsolatedVerificationInput, type LlmVerifier,
} from '@aot/evaluation';

import { addEvidence, EXAMPLE_URL, FakeFetcher, FakeLlm, researchReport, submittedRun } from '../support/evaluation.ts';
import { seededDb } from '../support/seeded-db.ts';

const MARKERS = {
  prompt: 'MARKER-SYSTEM-PROMPT-7f3a',
  session: 'MARKER-SESSION-ID-91bc',
  reasoning: 'MARKER-PRIVATE-REASONING-2d40',
  prose: 'MARKER-REPORT-PROSE-c8e1',
};
const PAGE = 'The quarterly price is fixed for all plans.';
const LLM_SPEC = {
  validation: {
    deterministic: ['url_reachable', 'quote_in_source'],
    llm: { check: 'claim_supported_by_source', isolated_context: true },
    human: false,
  },
};

/** 보고서에는 주장 말고도 프롬프트·세션·추론·서술이 가득 들어 있다 */
const noisyReport = () => ({
  ...researchReport([{ id: 'c1', statement: 'Prices are fixed for all plans.', source_url: EXAMPLE_URL, quote: 'price is fixed for all plans' }]),
  prompt: MARKERS.prompt,
  session_id: MARKERS.session,
  reasoning: MARKERS.reasoning,
  narrative: `${MARKERS.prose}: I read the page and concluded that everything is correct.`,
});

function setup(t: Parameters<typeof seededDb>[0], spec: Record<string, unknown> = LLM_SPEC) {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec, result: noisyReport() });
  addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL, contentHash: 'hash-a' });
  const fetcher = new FakeFetcher({ [EXAMPLE_URL]: PAGE });
  return { db, clock, run, fetcher };
}

test('the verifier receives the original evidence and isolated context only: no prompt, session or report text reaches it', async (t) => {
  const { db, clock, run, fetcher } = setup(t);
  const llm = new FakeLlm();
  await evaluateRun({ db, clock, fetcher, llm }, { taskId: run.taskId, taskRunId: run.runId });

  assert.equal(llm.inputs.length, 1);
  const input = llm.inputs[0]!;
  assert.deepEqual(Object.keys(input).sort(), [...ISOLATED_INPUT_KEYS]);
  const serialized = JSON.stringify(input);
  for (const [name, marker] of Object.entries(MARKERS)) assert.ok(!serialized.includes(marker), `${name} leaked into the verification input`);
  // 들어간 것: 완료 조건, 주장 문장, 원본 출처 본문과 내용 해시
  assert.deepEqual(input.criteria, ['각 주장에 출처 URL이 1개 이상 있다']);
  assert.deepEqual(input.claims, [{ id: 'c1', statement: 'Prices are fixed for all plans.', sourceRef: EXAMPLE_URL }]);
  assert.deepEqual(input.sources, [{ ref: EXAMPLE_URL, kind: 'source_url', text: PAGE, contentHash: 'hash-a', trustOrigin: 'external_untrusted' }]);
  assert.equal(input.check, 'claim_supported_by_source');
  assert.ok(Object.isFrozen(input) && Object.isFrozen(input.claims), 'the verifier cannot alter what it was given');
});

test('source text handed to the verifier is marked external_untrusted, whatever the agent wrote in the evidence row', async (t) => {
  const { db, clock, run, fetcher } = setup(t);
  db.writeTx((tx) => tx.run("UPDATE evidence SET trust_origin = 'internal' WHERE task_id = ?", [run.taskId]));
  const llm = new FakeLlm();
  await evaluateRun({ db, clock, fetcher, llm }, { taskId: run.taskId, taskRunId: run.runId });
  assert.deepEqual(llm.inputs[0]!.sources.map((s) => s.trustOrigin), ['external_untrusted'], 'the text was read from outside by the verifier itself');
});

test('type level: the input has no place for a prompt, a session or the report (tsc fails if one is added)', () => {
  const claims: ClaimStatement[] = [{ id: 'c1', statement: 's', sourceRef: 'u' }];
  const sources = [{ ref: 'u', kind: 'source_url' as const, text: 't', contentHash: null, trustOrigin: 'external_untrusted' as const }];
  // @ts-expect-error a report cannot be passed to the builder
  buildIsolatedInput({ check: 'c', criteria: [], claims, sources, report: '{}' });
  // @ts-expect-error a prompt cannot be passed to the builder
  buildIsolatedInput({ check: 'c', criteria: [], claims, sources, prompt: 'p' });
  // @ts-expect-error a session cannot be passed to the builder
  buildIsolatedInput({ check: 'c', criteria: [], claims, sources, session: 's' });
  const input: IsolatedVerificationInput = buildIsolatedInput({ check: 'c', criteria: [], claims, sources });
  // @ts-expect-error the verification input has no report field
  void input.report;
  // @ts-expect-error the verification input has no prompt field
  void input.prompt;
  // @ts-expect-error the verification input has no session field
  void input.session;
  // 검증기 인터페이스가 받는 것은 이 입력 하나다
  const verifier: LlmVerifier = { id: 'x@v1', verify: (given) => Promise.resolve({ verdict: 'supported', note: String(given.claims.length) }) };
  assert.equal(typeof verifier.verify, 'function');
});

test('runtime guard: properties smuggled into claims or sources by a cast are not copied; oversized statements and unknown sources are refused', () => {
  const smuggled = { id: 'c1', statement: 's', sourceRef: 'u', report: MARKERS.prose, prompt: MARKERS.prompt } as ClaimStatement;
  const source = { ref: 'u', kind: 'source_url' as const, text: 't', contentHash: null, trustOrigin: 'external_untrusted' as const, session: MARKERS.session };
  const input = buildIsolatedInput({ check: 'c', criteria: ['x'], claims: [smuggled], sources: [source] });
  assert.deepEqual(Object.keys(input.claims[0]!).sort(), ['id', 'sourceRef', 'statement']);
  assert.deepEqual(Object.keys(input.sources[0]!).sort(), ['contentHash', 'kind', 'ref', 'text', 'trustOrigin']);
  assert.ok(!JSON.stringify(input).includes(MARKERS.session));

  const whole = { id: 'c1', statement: 'x'.repeat(MAX_STATEMENT_CHARS + 1), sourceRef: 'u' };
  assert.throws(() => buildIsolatedInput({ check: 'c', criteria: [], claims: [whole], sources: [source] }), IsolationError);
  assert.throws(() => buildIsolatedInput({ check: 'c', criteria: [], claims: [{ id: 'c1', statement: 's', sourceRef: 'elsewhere' }], sources: [source] }), IsolationError);
  assert.throws(() => buildIsolatedInput({ check: ' ', criteria: [], claims: [], sources: [] }), IsolationError);
});

test('LLM verification runs only after every deterministic check passed (a failed first layer never reaches the model)', async (t) => {
  const { db, clock, run } = setup(t);
  const llm = new FakeLlm();
  const fetcher = new FakeFetcher({ [EXAMPLE_URL]: 'a page without the quotation' });
  const { evaluation } = await evaluateRun({ db, clock, fetcher, llm }, { taskId: run.taskId, taskRunId: run.runId });
  assert.equal(llm.inputs.length, 0);
  assert.equal(evaluation.outcome, 'fail');
  assert.match(evaluation.quality_note ?? '', /llm: skipped/);
});

test('verdicts: unsupported -> fail, unclear -> inconclusive, supported -> pass; the verification cost is a separate ledger entry of the run', async (t) => {
  const outcomes: Record<string, string> = {};
  for (const verdict of ['supported', 'unsupported', 'unclear'] as const) {
    const { db, clock, run, fetcher } = setup(t);
    const llm = new FakeLlm({ verdict, note: `fake says ${verdict}`, costUsd: 0.04 });
    const { evaluation } = await evaluateRun({ db, clock, fetcher, llm }, { taskId: run.taskId, taskRunId: run.runId });
    outcomes[verdict] = evaluation.outcome;
    assert.match(evaluation.quality_note ?? '', new RegExp(`fake-verifier@v1: ${verdict}`));
    assert.equal(evaluation.total_cost_usd, 0.04);
    const entry = db.get<{ category: string; units: string; task_run_id: string }>("SELECT category, units, task_run_id FROM cost_entry WHERE task_id = ?", [run.taskId])!;
    assert.deepEqual({ category: entry.category, run: entry.task_run_id, source: JSON.parse(entry.units).source }, { category: 'llm', run: run.runId, source: 'validation' });
  }
  assert.deepEqual(outcomes, { supported: 'pass', unsupported: 'fail', unclear: 'inconclusive' });
});

test('no verifier configured, a verifier that throws, or isolated_context=false: the result is inconclusive, never a silent pass', async (t) => {
  const missing = setup(t);
  const a = await evaluateRun({ db: missing.db, clock: missing.clock, fetcher: missing.fetcher }, { taskId: missing.run.taskId, taskRunId: missing.run.runId });
  assert.equal(a.evaluation.outcome, 'inconclusive');
  assert.match(a.evaluation.quality_note ?? '', /no LLM verifier is configured/);

  const broken = setup(t);
  const throwing: LlmVerifier = { id: 'broken@v1', verify: () => Promise.reject(new Error('model unavailable')) };
  const b = await evaluateRun({ db: broken.db, clock: broken.clock, fetcher: broken.fetcher, llm: throwing }, { taskId: broken.run.taskId, taskRunId: broken.run.runId });
  assert.equal(b.evaluation.outcome, 'inconclusive');
  assert.match(b.evaluation.quality_note ?? '', /model unavailable/);

  const shared = setup(t, { validation: { deterministic: ['url_reachable'], llm: { check: 'claim_supported_by_source', isolated_context: false }, human: false } });
  const llm = new FakeLlm();
  const c = await evaluateRun({ db: shared.db, clock: shared.clock, fetcher: shared.fetcher, llm }, { taskId: shared.run.taskId, taskRunId: shared.run.runId });
  assert.equal(c.evaluation.outcome, 'inconclusive');
  assert.equal(llm.inputs.length, 0, 'a verifier that would share the executor context is never called');
});

test('a subscription verifier reports tokens, not USD: the ledger gets a token-only validation entry and the note shows the ratio to the run tokens', async (t) => {
  const { db, clock, run, fetcher } = setup(t);
  db.writeTx((tx) => recordCost(tx, clock, { taskId: run.taskId, taskRunId: run.runId, category: 'llm', amountUsd: 0, units: { source: 'adapter', tokens: 10_000 } }));
  const llm = new FakeLlm({ verdict: 'supported', note: 'all claims are supported', tokens: 1500 });
  const { evaluation } = await evaluateRun({ db, clock, fetcher, llm }, { taskId: run.taskId, taskRunId: run.runId });
  assert.equal(evaluation.outcome, 'pass');
  assert.match(evaluation.quality_note ?? '', /\[verifier tokens: 1500, 15% of the run's 10000\]/);
  assert.equal(evaluation.total_cost_usd, 0);
  const validation = db.all<{ amount_usd: number; units: string }>("SELECT amount_usd, units FROM cost_entry WHERE task_run_id = ? ORDER BY at, id", [run.runId]).filter((row) => JSON.parse(row.units).source === 'validation');
  assert.equal(validation.length, 1);
  assert.deepEqual([Number(validation[0]!.amount_usd), JSON.parse(validation[0]!.units).tokens, JSON.parse(validation[0]!.units).verifier], [0, 1500, 'fake-verifier@v1']);
  assert.equal(costForRun(db, run.runId).tokens, 11_500);
});

test('a verifier that reports no usable token count adds no ledger entry', async (t) => {
  for (const tokens of [0, -5, Number.NaN]) {
    const { db, clock, run, fetcher } = setup(t);
    await evaluateRun({ db, clock, fetcher, llm: new FakeLlm({ verdict: 'supported', note: 'ok', tokens }) }, { taskId: run.taskId, taskRunId: run.runId });
    assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM cost_entry WHERE task_run_id = ?', [run.runId])!.n, 0);
  }
});

test('shadow mode: the verifier is called and its verdict recorded, but an unsupported verdict does not change the outcome (a person decides)', async (t) => {
  for (const verdict of ['supported', 'unsupported', 'unclear'] as const) {
    const { db, clock, run, fetcher } = setup(t);
    db.writeTx((tx) => recordCost(tx, clock, { taskId: run.taskId, taskRunId: run.runId, category: 'llm', amountUsd: 0, units: { source: 'adapter', tokens: 8000 } }));
    const llm = new FakeLlm({ verdict, note: `fake says ${verdict}`, tokens: 800 });
    const { evaluation } = await evaluateRun({ db, clock, fetcher, llm, llmShadow: true }, { taskId: run.taskId, taskRunId: run.runId });
    assert.equal(llm.inputs.length, 1, 'the verifier was called');
    assert.equal(evaluation.outcome, 'pass', `the ${verdict} verdict did not decide`);
    assert.match(evaluation.quality_note ?? '', new RegExp(`shadow fake-verifier@v1: ${verdict}.*recorded only`));
    const events = db.all<{ source: string; type: string; external_id: string; payload: string }>('SELECT source, type, external_id, payload FROM event WHERE source = ?', [SHADOW_VERDICT_SOURCE]);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0]!.type, events[0]!.external_id], [SHADOW_VERDICT_TYPE, run.runId]);
    assert.deepEqual(JSON.parse(events[0]!.payload), {
      task_id: run.taskId, task_run_id: run.runId, verifier: 'fake-verifier@v1', verdict, note: `fake says ${verdict}`, claim_count: 1, tokens: 800, run_tokens: 8000,
    });
    // 토큰은 평소처럼 원장에 남는다
    assert.equal(costForRun(db, run.runId).tokens, 8800);
  }
});

test('shadow mode: evaluating the same run again records the verdict once, and an unavailable verifier still keeps the task waiting', async (t) => {
  const { db, clock, run, fetcher } = setup(t);
  const llm = new FakeLlm({ verdict: 'unsupported', note: 'x' });
  const deps = { db, clock, fetcher, llm, llmShadow: true };
  const first = await evaluateRun(deps, { taskId: run.taskId, taskRunId: run.runId });
  const again = await evaluateRun(deps, { taskId: run.taskId, taskRunId: run.runId });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM event WHERE source = ?', [SHADOW_VERDICT_SOURCE])!.n, 1);

  const waiting = setup(t);
  const unavailable: LlmVerifier = { id: 'down@v1', verify: () => Promise.reject(new VerifierUnavailableError('usage_limit', 'later')) };
  await assert.rejects(evaluateRun({ db: waiting.db, clock: waiting.clock, fetcher: waiting.fetcher, llm: unavailable, llmShadow: true }, { taskId: waiting.run.taskId, taskRunId: waiting.run.runId }), VerifierUnavailableError);
  assert.equal(waiting.db.get<{ n: number }>('SELECT count(*) AS n FROM evaluation')!.n, 0);
});
