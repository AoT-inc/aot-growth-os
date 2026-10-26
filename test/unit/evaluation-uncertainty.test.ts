// 결정론적 검사 `uncertainty_listed` (A6-U12, task-spec.md "불확실성 항목이 명시되어 있다"): 결과에 `uncertainties` 필드가 있고 형식이 유효해야 통과한다.
// 빈 목록은 "알려진 불확실성이 없다"는 명시로 유효하고, 필드 누락·형식 오류는 fail 이다. 명세가 이 id 를 요구할 때만 적용된다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defaultChecks, evaluateRun, MAX_UNCERTAINTIES, MAX_UNCERTAINTY_NOTE_CHARS, MAX_UNCERTAINTY_TOPIC_CHARS, runDeterministicChecks, uncertaintiesFromResult,
} from '@aot/evaluation';
import type { EvidenceRow, TaskRow, TaskRunRow, TaskSpec } from '@aot/domain';

import { addEvidence, EXAMPLE_URL, FakeFetcher, researchReport, submittedRun, validationSpec } from '../support/evaluation.ts';
import { seededDb } from '../support/seeded-db.ts';

const item = (topic = 'source-a', note = 'source could not be read: http_500') => ({ topic, note });
const json = (value: unknown): string => JSON.stringify(value);

const TABLE: { name: string; result: string | null; ok: boolean; reason?: RegExp; count?: number }[] = [
  { name: 'one well-formed item', result: json({ uncertainties: [item()] }), ok: true, count: 1 },
  { name: 'an empty list is a valid statement of "no known uncertainty"', result: json({ uncertainties: [] }), ok: true, count: 0 },
  { name: 'other result fields do not matter', result: json({ summary: 'x', claims: [], uncertainties: [item(), item('b', 'n')] }), ok: true, count: 2 },
  { name: 'the maximum number of items', result: json({ uncertainties: Array.from({ length: MAX_UNCERTAINTIES }, (_, i) => item(`t${i}`)) }), ok: true, count: MAX_UNCERTAINTIES },
  { name: 'topic and note at their limits', result: json({ uncertainties: [item('t'.repeat(MAX_UNCERTAINTY_TOPIC_CHARS), 'n'.repeat(MAX_UNCERTAINTY_NOTE_CHARS))] }), ok: true, count: 1 },
  { name: 'no result at all', result: null, ok: false, reason: /no result/ },
  { name: 'not JSON', result: 'uncertainties: none', ok: false, reason: /not valid JSON/ },
  { name: 'a JSON array, not an object', result: json([item()]), ok: false, reason: /not a JSON object/ },
  { name: 'the field is missing', result: json({ summary: 'x', claims: [] }), ok: false, reason: /no 'uncertainties' field/ },
  { name: 'the field is null', result: json({ uncertainties: null }), ok: false, reason: /not an array/ },
  { name: 'the field is a string', result: json({ uncertainties: 'none' }), ok: false, reason: /not an array/ },
  { name: 'the field is an object', result: json({ uncertainties: item() }), ok: false, reason: /not an array/ },
  { name: 'too many items', result: json({ uncertainties: Array.from({ length: MAX_UNCERTAINTIES + 1 }, () => item()) }), ok: false, reason: /at most 100/ },
  { name: 'an item is a string', result: json({ uncertainties: ['source unreadable'] }), ok: false, reason: /uncertainties\[0\] is not an object/ },
  { name: 'an item is an array', result: json({ uncertainties: [[]] }), ok: false, reason: /uncertainties\[0\] is not an object/ },
  { name: 'an item is null', result: json({ uncertainties: [null] }), ok: false, reason: /uncertainties\[0\] is not an object/ },
  { name: 'topic is missing', result: json({ uncertainties: [{ note: 'n' }] }), ok: false, reason: /topic must be a non-empty string/ },
  { name: 'note is missing', result: json({ uncertainties: [{ topic: 't' }] }), ok: false, reason: /note must be a non-empty string/ },
  { name: 'topic is blank', result: json({ uncertainties: [item('   ')] }), ok: false, reason: /topic must be a non-empty string/ },
  { name: 'note is a number', result: json({ uncertainties: [{ topic: 't', note: 3 }] }), ok: false, reason: /note must be a non-empty string/ },
  { name: 'topic is too long', result: json({ uncertainties: [item('t'.repeat(MAX_UNCERTAINTY_TOPIC_CHARS + 1))] }), ok: false, reason: /topic is longer than 100/ },
  { name: 'note is too long', result: json({ uncertainties: [item('t', 'n'.repeat(MAX_UNCERTAINTY_NOTE_CHARS + 1))] }), ok: false, reason: /note is longer than 300/ },
  { name: 'an unknown key on an item', result: json({ uncertainties: [{ topic: 't', note: 'n', severity: 'high' }] }), ok: false, reason: /unknown key\(s\): severity/ },
  { name: 'one bad item among good ones is named by its index', result: json({ uncertainties: [item(), item(), { topic: 't' }] }), ok: false, reason: /uncertainties\[2\]\.note/ },
];

test('uncertaintiesFromResult: the format table', () => {
  for (const row of TABLE) {
    const found = uncertaintiesFromResult(row.result);
    assert.equal(found.ok, row.ok, row.name);
    if (found.ok) assert.equal(found.items.length, row.count, row.name);
    else assert.match(found.reason, row.reason!, row.name);
  }
});

test('a long list of problems is cut short in the reason', () => {
  const found = uncertaintiesFromResult(json({ uncertainties: Array.from({ length: 12 }, () => 'bad') }));
  assert.equal(found.ok, false);
  if (!found.ok) {
    assert.match(found.reason, /and 7 more/);
    assert.ok(found.reason.length < 600);
  }
});

function setup(t: Parameters<typeof seededDb>[0], result: unknown, deterministic: string[] = ['uncertainty_listed']) {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: validationSpec(deterministic), result });
  const context = () => {
    const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [run.taskId])!;
    const taskRun = db.get<TaskRunRow>('SELECT * FROM task_run WHERE id = ?', [run.runId])!;
    return {
      db, task, run: taskRun, spec: JSON.parse(task.spec) as TaskSpec, claims: [],
      evidence: db.all<EvidenceRow>('SELECT * FROM evidence WHERE task_id = ?', [run.taskId]), sources: undefined as never,
    };
  };
  return { db, clock, run, context };
}

test('uncertainty_listed is a registered, non-safety check; present and valid -> pass (also when empty), missing or malformed -> fail with a reason', async (t) => {
  assert.equal(defaultChecks().get('uncertainty_listed')?.safety, false);
  const expectations: [unknown, string, RegExp][] = [
    [{ ...researchReport([]), uncertainties: [item()] }, 'pass', /1 uncertainty item\(s\) listed/],
    [{ ...researchReport([]), uncertainties: [] }, 'pass', /no known uncertainty/],
    [researchReport([]), 'fail', /no 'uncertainties' field/],
    [{ ...researchReport([]), uncertainties: [{ topic: 'only a topic' }] }, 'fail', /uncertainties\[0\]\.note/],
    [{ ...researchReport([]), uncertainties: 'none' }, 'fail', /not an array/],
  ];
  for (const [result, status, note] of expectations) {
    const { context } = setup(t, result);
    const report = await runDeterministicChecks(context(), ['uncertainty_listed']);
    assert.deepEqual([report.checks[0]?.id, report.checks[0]?.status, report.checks[0]?.safety], ['uncertainty_listed', status, false]);
    assert.match(report.checks[0]?.note ?? '', note);
  }
});

test('evaluation: a missing uncertainties field fails the evaluation (never pass); it only applies when the specification lists the check', async (t) => {
  const withCheck = setup(t, researchReport([{ statement: 'a', source_url: EXAMPLE_URL }]), ['url_reachable', 'uncertainty_listed']);
  addEvidence(withCheck.db, withCheck.clock, withCheck.run, { kind: 'source_url', ref: EXAMPLE_URL });
  const fetcher = new FakeFetcher({ [EXAMPLE_URL]: 'page' });
  const missing = await evaluateRun({ db: withCheck.db, clock: withCheck.clock, fetcher }, { taskId: withCheck.run.taskId, taskRunId: withCheck.run.runId });
  assert.equal(missing.evaluation.outcome, 'fail');
  assert.match(missing.evaluation.quality_note ?? '', /uncertainty_listed=fail \(the result has no 'uncertainties' field/);
  assert.match(missing.evaluation.quality_note ?? '', /deterministic check\(s\) failed: uncertainty_listed/);

  const listed = setup(t, { ...researchReport([{ statement: 'a', source_url: EXAMPLE_URL }]), uncertainties: [] }, ['url_reachable', 'uncertainty_listed']);
  addEvidence(listed.db, listed.clock, listed.run, { kind: 'source_url', ref: EXAMPLE_URL });
  const passed = await evaluateRun({ db: listed.db, clock: listed.clock, fetcher }, { taskId: listed.run.taskId, taskRunId: listed.run.runId });
  assert.equal(passed.evaluation.outcome, 'pass');

  const notRequested = setup(t, researchReport([{ statement: 'a', source_url: EXAMPLE_URL }]), ['url_reachable']);
  addEvidence(notRequested.db, notRequested.clock, notRequested.run, { kind: 'source_url', ref: EXAMPLE_URL });
  const unaffected = await evaluateRun({ db: notRequested.db, clock: notRequested.clock, fetcher }, { taskId: notRequested.run.taskId, taskRunId: notRequested.run.runId });
  assert.equal(unaffected.evaluation.outcome, 'pass', 'the field is not required unless the specification lists uncertainty_listed');
});

test('an unregistered check id is still "cannot verify" (inconclusive), unchanged by this check', async (t) => {
  const { db, clock, run } = setup(t, { ...researchReport([{ statement: 'a', source_url: EXAMPLE_URL }]), uncertainties: [] }, ['url_reachable', 'uncertainty_listing']);
  addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL });
  const { evaluation } = await evaluateRun({ db, clock, fetcher: new FakeFetcher({ [EXAMPLE_URL]: 'page' }) }, { taskId: run.taskId, taskRunId: run.runId });
  assert.equal(evaluation.outcome, 'inconclusive');
  assert.match(evaluation.quality_note ?? '', /no deterministic check 'uncertainty_listing' is registered/);
});
