// 전화 업무의 평가 (ADR-0014 §7): 완료는 에이전트의 자기 보고가 아니라 통화 기록·발화 기록·구조화 결과라는 원본 증거로 정해진다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPhoneEvent, createOutboundCall, recordCallOutcome, validateTaskSpec } from '@aot/domain';
import { evaluateRun, type EvaluationReport } from '@aot/evaluation';

import { FakeFetcher, submittedRun } from '../support/evaluation.ts';
import { COMPLETED_ANALYSIS, ev, FROM, phoneSpecOverrides, PROVIDER, TO, TRANSCRIPT } from '../support/phone.ts';
import { minimalDraft } from '../support/spec-fixtures.ts';
import { seededDb } from '../support/seeded-db.ts';

const SELF_REPORT = { summary: '고객과 통화했고 관심이 있다고 했습니다. qualified = true', claims: [] };

function phoneRun(t: Parameters<typeof seededDb>[0], result: unknown = SELF_REPORT) {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: phoneSpecOverrides(), result });
  const call = createOutboundCall(db, clock, {
    provider: PROVIDER, to: TO, from: FROM, taskId: run.taskId, taskRunId: run.runId, actorId: null, orgUnitId: null, objective: 'qualify_lead',
    effectKey: 'e'.repeat(40), maxDurationSeconds: 600, allowTransfer: false, recording: false,
  }).call;
  const at = (s: number) => new Date(Date.parse(clock.nowIso()) + s * 1000).toISOString();
  return { db, clock, run, call, at, evaluate: () => evaluateRun({ db, clock, fetcher: new FakeFetcher() }, { taskId: run.taskId, taskRunId: run.runId }) };
}

const connect = (env: ReturnType<typeof phoneRun>, p = 'p-1') => {
  applyPhoneEvent(env.db, env.clock, ev('phone.call.initiated', p, env.at(0), { callId: env.call.id }));
  applyPhoneEvent(env.db, env.clock, ev('phone.call.connected', p, env.at(5)));
};
const complete = (env: ReturnType<typeof phoneRun>, extra: Record<string, unknown> = { transcript: TRANSCRIPT, analysis: COMPLETED_ANALYSIS }, p = 'p-1') =>
  applyPhoneEvent(env.db, env.clock, ev('phone.call.completed', p, env.at(90), extra as never));

const note = (report: EvaluationReport): string => report.evaluation.quality_note ?? '';

test('a completed call with transcript and outcome passes, and the call evidence is the original evidence', async (t) => {
  const env = phoneRun(t);
  connect(env);
  complete(env);
  const { evaluation } = await env.evaluate();
  assert.equal(evaluation.outcome, 'pass', evaluation.quality_note ?? '');
  assert.equal(evaluation.safety, 'pass');
  const primary = JSON.parse(evaluation.primary_evidence_refs) as string[];
  assert.ok(primary.length >= 3, `call, transcript and outcome evidence are original evidence: ${primary.join(', ')}`);
  const rows = env.db.all<{ ref: string; verified: number }>('SELECT ref, verified FROM evidence WHERE task_id = ? ORDER BY ref', [env.run.taskId]);
  assert.ok(rows.length === 3 && rows.every((row) => Number(row.verified) === 1));
});

test('the agent saying "I talked to the customer" without a call fails: a self-report is not evidence', async (t) => {
  const env = phoneRun(t);
  // 통화를 일으키지 않은 업무: 통화 행을 지운다
  env.db.writeTx((tx) => { tx.run('DELETE FROM event WHERE source = ?', ['phone']); tx.run('DELETE FROM call'); });
  const { evaluation } = await env.evaluate();
  assert.equal(evaluation.outcome, 'fail');
  assert.notEqual(evaluation.outcome, 'pass');
  assert.equal(evaluation.agent_report_used, 0);
});

test('a call that is still queued or ringing cannot be judged: inconclusive, not pass and not fail', async (t) => {
  const env = phoneRun(t);
  applyPhoneEvent(env.db, env.clock, ev('phone.call.initiated', 'p-2', env.at(0), { callId: env.call.id }));
  applyPhoneEvent(env.db, env.clock, ev('phone.call.ringing', 'p-2', env.at(2)));
  const report = await env.evaluate();
  assert.equal(report.evaluation.outcome, 'inconclusive', note(report));
  assert.match(note(report), /have not ended yet/);
});

test('a call nobody answered fails (the work was not done)', async (t) => {
  const env = phoneRun(t);
  applyPhoneEvent(env.db, env.clock, ev('phone.call.initiated', 'p-3', env.at(0), { callId: env.call.id }));
  applyPhoneEvent(env.db, env.clock, ev('phone.call.failed', 'p-3', env.at(30), { code: 'no_answer' }));
  const report = await env.evaluate();
  assert.equal(report.evaluation.outcome, 'fail');
  assert.match(note(report), /no call connected and completed/);
});

test('a connected call without any transcript fails the transcript check', async (t) => {
  const env = phoneRun(t);
  connect(env);
  complete(env, { analysis: COMPLETED_ANALYSIS });
  const report = await env.evaluate();
  assert.equal(report.evaluation.outcome, 'fail');
  assert.match(note(report), /call_transcript_present=fail/);
});

test('free text without a structured outcome is not an outcome: inconclusive, so the customer is not called again to fill a gap', async (t) => {
  const env = phoneRun(t);
  connect(env);
  complete(env, { transcript: TRANSCRIPT, analysis: { summary: '좋은 통화였다' } });
  const report = await env.evaluate();
  assert.equal(report.evaluation.outcome, 'inconclusive');
  assert.match(note(report), /call_outcome_recorded=unknown/);
});

test('the outcome must satisfy the task: disposition vocabulary and required fields', async (t) => {
  const wrongDisposition = phoneRun(t);
  connect(wrongDisposition);
  complete(wrongDisposition, { transcript: TRANSCRIPT, analysis: { ...COMPLETED_ANALYSIS, disposition: 'hot_lead' } });
  const a = await wrongDisposition.evaluate();
  assert.equal(a.evaluation.outcome, 'inconclusive');
  assert.match(note(a), /disposition 'hot_lead' is not one of/);

  const missingField = phoneRun(t);
  connect(missingField);
  complete(missingField, { transcript: TRANSCRIPT, analysis: { ...COMPLETED_ANALYSIS, structuredData: { timeline: 'later' } } });
  const b = await missingField.evaluate();
  assert.equal(b.evaluation.outcome, 'inconclusive');
  assert.match(note(b), /required field\(s\) missing: budgetKnown/);
});

test('a person can record the missing outcome afterwards, and a fresh evaluation of a new run then passes', async (t) => {
  const env = phoneRun(t);
  connect(env);
  complete(env, { transcript: TRANSCRIPT });
  assert.equal((await env.evaluate()).evaluation.outcome, 'inconclusive');
  recordCallOutcome(env.db, env.clock, {
    callId: env.call.id, source: 'human', by: 'human', allowedDispositions: ['qualified', 'not_interested'],
    outcome: { disposition: 'not_interested', summary: '관심 없다고 함', structuredData: { budgetKnown: false } },
  });
  // 같은 run 의 평가는 이미 기록되어 있다(재검증 흡수). 새 평가는 새 run 에서 한다.
  const second = submittedRun(env.db, env.clock, { spec: phoneSpecOverrides({ trigger: { kind: 'manual', ref: 'actor:second' } }), result: SELF_REPORT });
  env.db.writeTx((tx) => tx.run('UPDATE call SET task_id = ?, task_run_id = ? WHERE id = ?', [second.taskId, second.runId, env.call.id]));
  env.db.writeTx((tx) => tx.run('UPDATE evidence SET task_id = ? WHERE task_id = ?', [second.taskId, env.run.taskId]));
  const report = await evaluateRun({ db: env.db, clock: env.clock, fetcher: new FakeFetcher() }, { taskId: second.taskId, taskRunId: second.runId });
  assert.equal(report.evaluation.outcome, 'pass', note(report));
});

test('task_spec: expected_call_outcome is validated and needs the check that verifies it', () => {
  const base = { ...minimalDraft(), ...phoneSpecOverrides() };
  assert.ok(validateTaskSpec(base, 'draft').ok);
  const unchecked = validateTaskSpec({ ...base, validation: { deterministic: ['call_completed'], llm: null, human: false } }, 'draft');
  assert.ok(!unchecked.ok && unchecked.errors.some((e) => e.code === 'check_required'));
  for (const bad of [{ dispositions: [] }, { dispositions: ['Qualified'] }, { dispositions: ['a', 'a'] }, { dispositions: ['a'], required_fields: ['bad field'] }, { dispositions: ['a'], extra: 1 }, 'text']) {
    assert.ok(!validateTaskSpec({ ...base, expected_call_outcome: bad }, 'draft').ok, JSON.stringify(bad));
  }
});

