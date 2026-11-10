// 전송 run 평가 프로필 (ADR-0015 W8) 과 초안 payload 의 비밀 검사.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSecretKey } from '@aot/agent-runtime';
import { isSecretKeyName, type Db, type EvidenceRow, type FakeClock, type TaskRow, type TaskRunRow, type TaskSpec } from '@aot/domain';
import { createTaskValidator, runDeterministicChecks, SourceReader, type CheckContext } from '@aot/evaluation';
import { validateTask } from '@aot/task-engine';

import { draftEngine } from '../support/draft-engine.ts';
import { draftRowFor, insertDraftRow } from '../support/drafts.ts';
import { taskStatus } from '../support/engine.ts';
import { addEvidence, FakeFetcher, recordEvaluation, submittedRun } from '../support/evaluation.ts';
import { createFakeMessageTool, examplePayload } from '../support/message-tool.ts';
import { seededDb } from '../support/seeded-db.ts';

const requests = [{ stepId: 's1', request: examplePayload({ subject: 'one' }) }, { stepId: 's2', request: examplePayload({ subject: 'two' }) }];

/** 초안 run → (평가 기록) → 승인 생략 → 전송 run 까지 돌리고 전송 run 을 validating 에 둔다 */
async function dispatched(t: Parameters<typeof draftEngine>[0], options: { draftEvaluation?: 'pass' | 'fail' | 'none'; human?: boolean } = {}) {
  const e = draftEngine(t, options.human === true ? { validation: { deterministic: ['policy_compliance'], llm: null, human: true } } : { validation: { deterministic: ['policy_compliance'], llm: null, human: false } });
  const fake = createFakeMessageTool();
  await e.draftAndPropose(requests, fake.tool);
  const draftRunId = e.db.get<{ id: string }>('SELECT id FROM task_run WHERE task_id = ? ORDER BY attempt LIMIT 1', [e.taskId])!.id;
  if (options.draftEvaluation !== 'none') recordEvaluation(e.db, e.clock, { taskId: e.taskId, runId: draftRunId }, { outcome: options.draftEvaluation === 'fail' ? 'fail' : 'pass' });
  await e.worker(fake.tool, { count: 0 }).tick();
  assert.equal(taskStatus(e.db, e.taskId), 'validating');
  const runId = e.db.get<{ id: string }>('SELECT id FROM task_run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1', [e.taskId])!.id;
  const validator = createTaskValidator({ db: e.db, clock: e.clock, fetcher: new FakeFetcher() });
  const validate = () => validateTask(e.db, { clock: e.clock, validator }, e.taskId);
  return { e, fake, runId, validate };
}

test('a dispatch run is validated by the dispatch profile: confirmed + matching hashes => pass, task completed, no human step', async (t) => {
  const { e, runId, validate } = await dispatched(t, { human: true });
  const end = await validate();
  assert.equal(end?.taskStatus, 'completed', 'validation.human=true is not asked again after the draft approval');
  const evaluation = e.db.get<{ outcome: string; safety: string; primary_evidence_refs: string; quality_note: string }>('SELECT * FROM evaluation WHERE task_run_id = ?', [runId])!;
  assert.deepEqual([evaluation.outcome, evaluation.safety], ['pass', 'pass']);
  assert.equal(JSON.parse(evaluation.primary_evidence_refs).length, 2);
  assert.match(evaluation.quality_note, /draft_run_passed=pass/);
  assert.match(evaluation.quality_note, /drafts_confirmed=pass/);
  assert.match(evaluation.quality_note, /policy_compliance=pass/);
});

test('the dispatch profile ignores the spec acceptance checks (it does not re-run url_reachable and friends)', async (t) => {
  const { e, runId, validate } = await dispatched(t);
  e.db.writeTx((tx) => {
    const spec = JSON.parse(e.db.get<{ spec: string }>('SELECT spec FROM task WHERE id = ?', [e.taskId])!.spec) as TaskSpec;
    spec.validation.deterministic = ['url_reachable', 'quote_in_source'];
    tx.run('UPDATE task SET spec = ? WHERE id = ?', [JSON.stringify(spec), e.taskId]);
  });
  assert.equal((await validate())?.taskStatus, 'completed');
  assert.ok(e.db.get('SELECT 1 AS one FROM evaluation WHERE task_run_id = ?', [runId]));
});

test('fail: the draft run has no passing evaluation', async (t) => {
  for (const draftEvaluation of ['none', 'fail'] as const) {
    const { e, runId, validate } = await dispatched(t, { draftEvaluation });
    const end = await validate();
    assert.notEqual(end?.taskStatus, 'completed', draftEvaluation);
    assert.equal(e.db.get<{ outcome: string }>('SELECT outcome FROM evaluation WHERE task_run_id = ?', [runId])?.outcome, 'fail', draftEvaluation);
  }
});

test('fail: a confirmed effect whose request_hash differs from the draft, or a draft without its effect', async (t) => {
  const a = await dispatched(t);
  a.e.db.writeTx((tx) => tx.run("UPDATE external_effect SET request_hash = ? WHERE effect_key = (SELECT effect_key FROM effect_draft WHERE step_id = 's1')", ['0'.repeat(64)]));
  assert.notEqual((await a.validate())?.taskStatus, 'completed');
  assert.match(a.e.db.get<{ quality_note: string }>('SELECT quality_note FROM evaluation WHERE task_run_id = ?', [a.runId])!.quality_note, /drafts_confirmed=fail .*request_hash differs/);

  const b = await dispatched(t);
  b.e.db.writeTx((tx) => tx.run("UPDATE effect_draft SET effect_key = 'missing' WHERE step_id = 's2'"));
  assert.notEqual((await b.validate())?.taskStatus, 'completed');
  assert.match(b.e.db.get<{ quality_note: string }>('SELECT quality_note FROM evaluation WHERE task_run_id = ?', [b.runId])!.quality_note, /no external effect with its effect_key/);
});

test('re-validation returns the recorded dispatch evaluation (idempotent)', async (t) => {
  const { e, runId } = await dispatched(t);
  const validator = createTaskValidator({ db: e.db, clock: e.clock, fetcher: new FakeFetcher() });
  const task = e.db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [e.taskId])!;
  const first = await validator.validate({ task, spec: JSON.parse(task.spec) as TaskSpec, runId });
  const second = await validator.validate({ task, spec: JSON.parse(task.spec) as TaskSpec, runId });
  assert.equal(first.evaluationId, second.evaluationId);
  assert.equal(first.humanRequired, false);
});

// ----- no_secret_in_outputs 가 초안 payload 를 훑는다 -----

function secretContext(db: Db, clock: FakeClock, payload: object) {
  const run = submittedRun(db, clock, { spec: { validation: { deterministic: ['no_secret_in_outputs'], llm: null, human: false } } });
  insertDraftRow(db, draftRowFor(run.taskId, run.runId, { state: 'pending', request: payload }));
  const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [run.taskId])!;
  const taskRun = db.get<TaskRunRow>('SELECT * FROM task_run WHERE id = ?', [run.runId])!;
  const context: CheckContext = {
    db, task, run: taskRun, spec: JSON.parse(task.spec) as TaskSpec, evidence: [] as EvidenceRow[], claims: [], sources: new SourceReader(new FakeFetcher()),
  };
  return context;
}

test('no_secret_in_outputs: a secret-like value in a draft payload is a safety failure, reported by kind and count only', async (t) => {
  const { db, clock } = seededDb(t);
  const report = await runDeterministicChecks(secretContext(db, clock, examplePayload({ text: 'use Bearer abcdefgh12345678 to log in' })), ['no_secret_in_outputs']);
  assert.equal(report.checks[0]?.status, 'fail');
  assert.equal(report.checks[0]?.safety, true);
  assert.match(report.checks[0]!.note, /draft draft-\d+: bearer_token x1/);
  assert.doesNotMatch(report.checks[0]!.note, /abcdefgh12345678/);
});

test('no_secret_in_outputs: a clean draft is not a failure (without an evidence reader the check stays unknown as before)', async (t) => {
  const { db, clock } = seededDb(t);
  const report = await runDeterministicChecks(secretContext(db, clock, examplePayload()), ['no_secret_in_outputs']);
  assert.equal(report.checks[0]?.status, 'unknown');
});

// ----- 초안 비밀 검사는 명세가 요구하지 않아도 항상 돈다 (리뷰 반영) -----

test('a run with drafts always gets the draft secret scan as a safety check, even when the spec does not list no_secret_in_outputs', async (t) => {
  for (const payload of [examplePayload({ text: 'log in with Bearer abcdefgh12345678' }), { ...examplePayload(), headers: { authorization: 'abc' } }]) {
    const { db, clock } = seededDb(t);
    const run = submittedRun(db, clock, { spec: { validation: { deterministic: ['budget'], llm: null, human: false } } });
    insertDraftRow(db, draftRowFor(run.taskId, run.runId, { state: 'pending', request: payload }));
    addEvidence(db, clock, run, { kind: 'source_url', ref: 'https://docs.example.com/a' });
    const validator = createTaskValidator({ db, clock, fetcher: new FakeFetcher({ 'https://docs.example.com/a': 'page' }) });
    const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [run.taskId])!;
    const verdict = await validator.validate({ task, spec: JSON.parse(task.spec) as TaskSpec, runId: run.runId });
    assert.equal(verdict.safety, 'fail');
    assert.equal(verdict.outcome, 'fail');
    const note = db.get<{ safety_note: string }>('SELECT safety_note FROM evaluation WHERE task_run_id = ?', [run.runId])!.safety_note;
    assert.match(note, /draft_secret_scan/);
    assert.doesNotMatch(note, /abcdefgh12345678/);
  }
});

test('the key-name rule used for drafts is the same as the call-log masking', () => {
  for (const key of ['authorization', 'Authorization', 'api_key', 'apiKey', 'access-token', 'refresh_token', 'password', 'x-signature', 'cookie', 'totp', 'otp', 'max_tokens', 'subject', 'text', 'to', 'tokens', 'monkey']) {
    assert.equal(isSecretKeyName(key), isSecretKey(key), key);
  }
});
