// 결정론적 검증기 (ADR-0007 §1-1, task-spec.md acceptance_criteria·validation). 외부 접근은 가짜 SourceFetcher 로만 한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Db, EvidenceRow, FakeClock, TaskRow, TaskRunRow, TaskSpec } from '@aot/domain';
import {
  applyEvidenceVerification, claimsFromResult, recordCost, runDeterministicChecks, SourceReader, type CheckContext, type DeterministicCheck,
} from '@aot/evaluation';

import { addEvidence, evidenceRow, EXAMPLE_URL, FakeFetcher, OTHER_URL, researchReport, submittedRun, validationSpec, type SubmittedRun } from '../support/evaluation.ts';
import { seededDb } from '../support/seeded-db.ts';

const QUOTE = 'The quarterly price is fixed';
const PAGE = `Pricing notes.\n  The quarterly   price is fixed\nfor all plans.`;

function setup(t: Parameters<typeof seededDb>[0], report: Record<string, unknown>, deterministic: string[], fetcher = new FakeFetcher({ [EXAMPLE_URL]: PAGE, [OTHER_URL]: 'another page' })) {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: validationSpec(deterministic), result: report });
  const context = (): CheckContext => {
    const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [run.taskId])!;
    const taskRun = db.get<TaskRunRow>('SELECT * FROM task_run WHERE id = ?', [run.runId])!;
    return {
      db, task, run: taskRun, spec: JSON.parse(task.spec) as TaskSpec,
      evidence: db.all<EvidenceRow>('SELECT * FROM evidence WHERE task_id = ? ORDER BY id', [run.taskId]),
      claims: claimsFromResult(taskRun.result), sources: new SourceReader(fetcher),
    };
  };
  return { db, clock, run, fetcher, context };
}

const statusOf = async (context: CheckContext, ids: string[]) =>
  Object.fromEntries((await runDeterministicChecks(context, ids)).checks.map((c) => [c.id, c.status]));

test('url_reachable: every source URL (evidence and cited by claims) must be reachable; the evidence row is marked per URL', async (t) => {
  const { db, clock, run, context } = setup(t, researchReport([{ statement: 'a', source_url: EXAMPLE_URL }]), ['url_reachable']);
  const good = addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL });
  const bad = addEvidence(db, clock, run, { kind: 'source_url', ref: 'https://gone.example.com/x' });
  const report = await runDeterministicChecks(context(), ['url_reachable']);
  assert.equal(report.checks[0]?.status, 'fail');
  assert.match(report.checks[0]?.note ?? '', /gone\.example\.com\/x: HTTP 404/);
  assert.equal(report.evidence.get(good)?.verified, true);
  assert.equal(report.evidence.get(bad)?.verified, false);

  const fine = setup(t, researchReport([{ statement: 'a', source_url: EXAMPLE_URL }]), ['url_reachable']);
  addEvidence(fine.db, fine.clock, fine.run, { kind: 'source_url', ref: EXAMPLE_URL });
  assert.equal((await runDeterministicChecks(fine.context(), ['url_reachable'])).checks[0]?.status, 'pass');
});

test('a fetcher that throws counts as unreachable, and each URL is fetched once per verification', async (t) => {
  const throwing = { calls: 0, fetch(): Promise<never> { this.calls += 1; return Promise.reject(new Error('socket hang up')); } };
  const { db, clock, run, context } = setup(t, researchReport([{ statement: 'a', source_url: EXAMPLE_URL, quote: 'x' }]), ['budget']);
  addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL });
  const ctx = { ...context(), sources: new SourceReader(throwing) };
  const report = await runDeterministicChecks(ctx, ['url_reachable', 'quote_in_source']);
  assert.deepEqual(report.checks.map((c) => c.status), ['fail', 'fail']);
  assert.match(report.checks[0]?.note ?? '', /socket hang up/);
  assert.equal(throwing.calls, 1);
});

test('quote_in_source: the quotation must be in the original text (whitespace differences are ignored); a missing quotation fails and unverifies the source evidence', async (t) => {
  const { db, clock, run, context } = setup(t, researchReport([
    { id: 'c1', statement: 'prices are fixed', source_url: EXAMPLE_URL, quote: QUOTE },
    { id: 'c2', statement: 'prices are free', source_url: OTHER_URL, quote: 'prices are free' },
  ]), ['quote_in_source']);
  const ev1 = addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL });
  const ev2 = addEvidence(db, clock, run, { kind: 'source_url', ref: OTHER_URL });
  const report = await runDeterministicChecks(context(), ['quote_in_source']);
  assert.equal(report.checks[0]?.status, 'fail');
  assert.match(report.checks[0]?.note ?? '', /c2: quotation not found/);
  assert.doesNotMatch(report.checks[0]?.note ?? '', /c1/);
  assert.equal(report.evidence.get(ev1)?.verified, true);
  assert.equal(report.evidence.get(ev2)?.verified, false);
});

test('dedupe: repeated claims and repeated source evidence fail', async (t) => {
  const { db, clock, run, context } = setup(t, researchReport([
    { id: 'c1', statement: 'Prices are fixed.', source_url: EXAMPLE_URL },
    { id: 'c2', statement: '  prices   are FIXED. ', source_url: OTHER_URL },
  ]), ['dedupe']);
  addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL });
  const dup = addEvidence(db, clock, run, { kind: 'source_url', ref: `${EXAMPLE_URL}/#top` });
  const report = await runDeterministicChecks(context(), ['dedupe']);
  assert.equal(report.checks[0]?.status, 'fail');
  assert.match(report.checks[0]?.note ?? '', /claim c2 repeats c1/);
  assert.match(report.checks[0]?.note ?? '', /repeats evidence/);
  assert.equal(report.evidence.get(dup)?.verified, false);

  const distinct = setup(t, researchReport([{ statement: 'one', source_url: EXAMPLE_URL }, { statement: 'two', source_url: OTHER_URL }]), ['dedupe']);
  assert.equal((await runDeterministicChecks(distinct.context(), ['dedupe'])).checks[0]?.status, 'pass');
});

test('budget: judged from the cost ledger of the task, never from what the report says', async (t) => {
  const { db, clock, run, context } = setup(t, { claims: [], reported_cost_usd: 0 }, ['budget']);
  assert.equal((await runDeterministicChecks(context(), ['budget'])).checks[0]?.status, 'pass', 'no spending is within the budget');
  db.writeTx((tx) => recordCost(tx, clock, { taskId: run.taskId, taskRunId: run.runId, category: 'llm', amountUsd: 2.5 }));
  const report = await runDeterministicChecks(context(), ['budget']);
  assert.equal(report.checks[0]?.status, 'fail');
  assert.match(report.checks[0]?.note ?? '', /2\.5 USD exceeds the budget 2 USD/);
});

test('policy_compliance (safety): a sent external effect needs a recorded non-deny policy decision', async (t) => {
  const { db, clock, run, context } = setup(t, researchReport([]), ['policy_compliance']);
  assert.equal((await runDeterministicChecks(context(), ['policy_compliance'])).checks[0]?.status, 'pass', 'no external effect');
  insertEffect(db, clock, run, 'eff-1', 'confirmed');
  insertEffect(db, clock, run, 'eff-planned', 'planned');
  const report = await runDeterministicChecks(context(), ['policy_compliance']);
  assert.equal(report.checks[0]?.status, 'fail');
  assert.equal(report.checks[0]?.safety, true);
  assert.match(report.checks[0]?.note ?? '', /eff-1 \(notify-tool\.send, confirmed\)/);
  assert.doesNotMatch(report.checks[0]?.note ?? '', /eff-planned/, 'a planned effect was never sent');

  db.writeTx((tx) => tx.run(
    `INSERT INTO policy_decision (task_id, task_run_id, subject, action, resource, scope, impact, decision, reason, policy_version_id, at)
     VALUES (?, ?, 'generalist@v1', 'notify-tool.send', 'mailbox:example', 'customer', 'external_effect', 'deny', 'denied', 'policy-v1', ?)`,
    [run.taskId, run.runId, clock.nowIso()],
  ));
  assert.equal((await runDeterministicChecks(context(), ['policy_compliance'])).checks[0]?.status, 'fail', 'a deny is not an allowing decision');
  db.writeTx((tx) => tx.run(
    `INSERT INTO policy_decision (task_id, task_run_id, subject, action, resource, scope, impact, decision, reason, policy_version_id, at)
     VALUES (?, ?, 'generalist@v1', 'notify-tool.send', 'mailbox:example', 'customer', 'external_effect', 'require_approval', 'approved', 'policy-v1', ?)`,
    [run.taskId, run.runId, clock.nowIso()],
  ));
  assert.equal((await runDeterministicChecks(context(), ['policy_compliance'])).checks[0]?.status, 'pass');
});

function insertEffect(db: Db, clock: FakeClock, run: SubmittedRun, id: string, state: string): void {
  db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, at)
     VALUES (?, ?, ?, ?, 'notify-tool', 'send', 'mailbox:example', 'h', ?, 1, ?)`,
    [id, `key-${id}`, run.taskId, run.runId, state, clock.nowIso()],
  ));
}

test('schema_valid / schema: the stored spec is valid and the run left a JSON result', async (t) => {
  const { context } = setup(t, researchReport([]), ['schema_valid']);
  assert.deepEqual(await statusOf(context(), ['schema_valid', 'schema']), { schema_valid: 'pass', schema: 'pass' });
  const broken = setup(t, researchReport([]), ['schema_valid']);
  broken.db.writeTx((tx) => tx.run('UPDATE task_run SET result = NULL WHERE id = ?', [broken.run.runId]));
  assert.equal((await runDeterministicChecks(broken.context(), ['schema_valid'])).checks[0]?.status, 'fail');
});

test('checks with nothing to verify are "unknown", not a pass; unregistered check ids are "unknown" too', async (t) => {
  const { context } = setup(t, { summary: 'only prose, no claims' }, ['budget']);
  assert.deepEqual(
    await statusOf(context(), ['url_reachable', 'quote_in_source', 'dedupe', 'required_tests']),
    { url_reachable: 'unknown', quote_in_source: 'unknown', dedupe: 'unknown', required_tests: 'unknown' },
  );
});

test('extra checks can be injected; a check that throws is recorded as a failure instead of crashing the validation', async (t) => {
  const { context } = setup(t, researchReport([]), ['budget']);
  const extra: DeterministicCheck[] = [
    { id: 'required_tests', safety: false, run: () => Promise.resolve({ status: 'pass', note: 'all required tests passed' }) },
    { id: 'explodes', safety: false, run: () => Promise.reject(new Error('bug')) },
  ];
  const report = await runDeterministicChecks(context(), ['required_tests', 'explodes'], extra);
  assert.deepEqual(report.checks.map((c) => [c.id, c.status]), [['required_tests', 'pass'], ['explodes', 'fail']]);
});

test('evidence.verified and verification_note are updated only inside Db.writeTx; a row is verified only if every check that touched it passed', async (t) => {
  const { db, clock, run, context } = setup(t, researchReport([
    { id: 'c1', statement: 'x', source_url: EXAMPLE_URL, quote: 'not in the page' },
  ]), ['url_reachable', 'quote_in_source']);
  const ev = addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL });
  const report = await runDeterministicChecks(context(), ['url_reachable', 'quote_in_source']);
  // url_reachable 는 통과, quote_in_source 는 실패 → 한 줄 안에서는 실패가 이긴다
  assert.equal(report.evidence.get(ev)?.verified, false);
  assert.match(report.evidence.get(ev)?.note ?? '', /url_reachable: reachable \(200\); quote_in_source: a quotation is not in the source/);

  assert.throws(() => applyEvidenceVerification(db, report.evidence), /write transaction/i);
  assert.equal(db.get('SELECT verified FROM evidence WHERE id = ?', [ev])?.['verified'], 0);
  db.writeTx((tx) => applyEvidenceVerification(tx, new Map([[ev, { verified: true, note: 'manually re-checked' }]])));
  const stored = evidenceRow(db, ev);
  assert.deepEqual({ ...stored }, { verified: 1, verification_note: 'manually re-checked' });
});
