// A6-U13: 사람이 입력한 측정 값의 신호 조회기(createMeasurementSignalSource)와 평가기 연결.
//  - 업무의 inputs[kind=measurement] 가 가리키는 측정 이벤트·근거에서 EffectSignal(값, 관측 수, 최소 관측 수, 데이터 품질, 합격선)을 만든다
//  - met / below_target / insufficient / poor_quality(사람이 불량으로 표시, 첨부 근거 없음) / 측정 불가 — 판정은 기존 평가 규칙 그대로
//  - 측정 입력이 없는 업무는 null(효과 측정 없음). 조회는 읽기 전용이다
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { recordExperimentReview, type Db, type FakeClock, type MeasurementSignal } from '@aot/domain';
import { createMeasurementSignalSource, evaluateRun, MEASUREMENT_SOURCE_EVENT } from '@aot/evaluation';
import { MEASUREMENT_EVENT_SOURCE, MEASUREMENT_EVENT_TYPE, recordMeasurement, type RecordMeasurementInput } from '@aot/task-engine';

import { FakeFetcher, submittedRun } from '../support/evaluation.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';
import { AFTER_W43, PACK_SIGNAL, W43_KEY as KEY } from '../support/measurement.ts';

const SHA = 'c'.repeat(64);

const spec = (tag = 'x') => ({
  inputs: [{ name: 'conversions', ref: KEY, kind: 'measurement' }, { name: 'k', ref: `r:${tag}`, kind: 'k' }],
  validation: { deterministic: [], llm: null, human: true },
});

function rig(t: TestContext, signal: Partial<MeasurementSignal> = {}) {
  const { db, clock } = seededDb(t);
  clock.set(AFTER_W43);
  addAgent(db, clock);
  const signals = [{ ...PACK_SIGNAL, ...signal } as MeasurementSignal];
  return { db, clock, signals, source: createMeasurementSignalSource({ db, signals }) };
}

const record = (db: Db, clock: FakeClock, signal: MeasurementSignal, overrides: Partial<RecordMeasurementInput> = {}) => recordMeasurement(db, { clock }, {
  actorId: 'actor-owner', signal, value: 12, observations: 3, quality: 'good', attachments: [{ ref: 'file:/example/week-43.png', sha256: SHA }], ...overrides,
});

/** 값을 넣고, 그 값을 기다리던 업무를 집어 제출한다 */
function measuredRun(db: Db, clock: FakeClock, signal: MeasurementSignal, overrides: Partial<RecordMeasurementInput> = {}) {
  record(db, clock, signal, overrides);
  return request(submittedRun(db, clock, { spec: spec() }));
}

const request = (run: { taskId: string; runId: string }) => ({ taskId: run.taskId, taskRunId: run.runId });

const totalChanges = (db: Db): number => Number(db.get('SELECT total_changes() AS n')?.['n']);

describe('createMeasurementSignalSource', () => {
  it('uses the same event source and type as task-engine writes', () => {
    assert.deepEqual(MEASUREMENT_SOURCE_EVENT, { source: MEASUREMENT_EVENT_SOURCE, type: MEASUREMENT_EVENT_TYPE });
  });

  it('met: the value, the observation count and the thresholds of the definition', async (t) => {
    const { db, clock, signals, source } = rig(t, { min_observations: 3, pass_threshold: 10 });
    const run = measuredRun(db, clock, signals[0]!);
    assert.deepEqual(await source.read(run), {
      measurable: true,
      signal: { name: 'weekly-landing-conversions@2026-W43', values: [12], observations: 3, minObservations: 3, dataQualityOk: true, passAtLeast: 10 },
    });
    const report = await evaluateRun({ db, clock, fetcher: new FakeFetcher(), effect: source }, run);
    assert.equal(report.evaluation.outcome, 'pass');
    assert.equal(report.evaluation.effect, 12);
    assert.match(report.evaluation.effect_note!, /^met: mean 12 over 3 observation/);
    assert.ok((JSON.parse(report.evaluation.primary_evidence_refs) as string[]).includes('measurement:weekly-landing-conversions@2026-W43'));
  });

  it('below target: fail', async (t) => {
    const { db, clock, signals, source } = rig(t, { pass_threshold: 20 });
    const run = measuredRun(db, clock, signals[0]!);
    const report = await evaluateRun({ db, clock, fetcher: new FakeFetcher(), effect: source }, run);
    assert.equal(report.evaluation.outcome, 'fail');
    assert.match(report.evaluation.quality_note!, /effect below target \(mean 12 over 3 observations\)/);
  });

  it('insufficient observations: inconclusive', async (t) => {
    const { db, clock, signals, source } = rig(t, { min_observations: 5, pass_threshold: 1 });
    const run = measuredRun(db, clock, signals[0]!);
    const report = await evaluateRun({ db, clock, fetcher: new FakeFetcher(), effect: source }, run);
    assert.equal(report.evaluation.outcome, 'inconclusive');
    assert.match(report.evaluation.effect_note!, /3 observation\(s\), fewer than the required 5/);
    assert.ok(!(JSON.parse(report.evaluation.primary_evidence_refs) as string[]).some((ref) => ref.startsWith('measurement:')));
  });

  it('poor quality as marked by the person: inconclusive', async (t) => {
    const { db, clock, signals, source } = rig(t, { pass_threshold: 1 });
    const run = measuredRun(db, clock, signals[0]!, { quality: 'poor' });
    const report = await evaluateRun({ db, clock, fetcher: new FakeFetcher(), effect: source }, run);
    assert.equal(report.evaluation.outcome, 'inconclusive');
    assert.match(report.evaluation.effect_note!, /data quality condition not met \(the person who recorded the value marked its data quality as poor\)/);
  });

  it('no attachment evidence: an event without attachments is poor quality, inconclusive', async (t) => {
    const { db, clock, source } = rig(t, { pass_threshold: 1 });
    // recordMeasurement 는 첨부 없는 값을 받지 않으므로 그런 이벤트를 직접 넣는다 (다른 경로로 들어온 값을 흉내)
    db.writeTx((tx) => tx.run(
      `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
       VALUES ('event-raw', 'measurement', 'weekly-landing-conversions@2026-W43', 'measurement.recorded', ?, NULL, ?, ?, ?)`,
      [JSON.stringify({ signal_id: 'weekly-landing-conversions', week: '2026-W43', value: 12, observations: 3, data_quality: 'good', attachments: [] }), KEY, clock.nowIso(), clock.nowIso()],
    ));
    const run = request(submittedRun(db, clock, { spec: spec() }));
    const observation = await source.read(run);
    assert.ok(observation?.measurable === true && observation.signal.dataQualityOk === false);
    assert.match(observation.signal.qualityNote!, /no attachment/);
    assert.equal((await evaluateRun({ db, clock, fetcher: new FakeFetcher(), effect: source }, run)).evaluation.outcome, 'inconclusive');
  });

  it('an attachment of the event without an evidence row on the task is poor quality', async (t) => {
    const { db, clock, signals, source } = rig(t, { pass_threshold: 1 });
    const run = measuredRun(db, clock, signals[0]!);
    db.writeTx((tx) => tx.run("UPDATE evidence SET content_hash = 'sha256:0000' WHERE task_id = ? AND kind = 'document'", [run.taskId]));
    const observation = await source.read(run);
    assert.ok(observation?.measurable === true);
    assert.equal(observation.signal.dataQualityOk, false);
    assert.match(observation.signal.qualityNote!, /1 attachment\(s\) of the recorded value have no evidence row/);
  });

  it('unmeasurable: an undefined signal; null for a task without a measurement input; reading writes nothing', async (t) => {
    const { db, clock, signals } = rig(t);
    const run = measuredRun(db, clock, signals[0]!);
    const noSignals = createMeasurementSignalSource({ db, signals: [] });
    assert.deepEqual(await noSignals.read(run), { measurable: false, reason: "measurement signal 'weekly-landing-conversions' is not defined" });
    const plain = request(submittedRun(db, clock, { spec: { inputs: [{ name: 'k', ref: 'r:plain', kind: 'k' }] } }));
    const before = totalChanges(db);
    assert.equal(await createMeasurementSignalSource({ db, signals }).read(plain), null);
    await createMeasurementSignalSource({ db, signals }).read(run);
    assert.equal(totalChanges(db), before, 'the source only reads');
  });
});

describe('the pass line of a result review task (A6-U16)', () => {
  const reviewOf = (db: Db, clock: FakeClock, taskId: string, over: { week?: string; signalId?: string; passAtLeast?: number | null } = {}) => db.writeTx((tx) => recordExperimentReview(tx, clock, {
    strategyVersionId: 'strategy-x', reviewTaskId: taskId, experimentWeek: over.week ?? '2026-W43', signalId: over.signalId ?? PACK_SIGNAL.id,
    period: { start: '2026-10-18T15:00:00.000Z', end: '2026-10-25T15:00:00.000Z', tz: 'Asia/Seoul' }, activatedAt: '2026-10-12T00:00:00.000Z',
    baseline: { week: '2026-W42', value: 9 }, passAtLeast: over.passAtLeast === undefined ? 11 : over.passAtLeast, planningTaskId: null, by: 'evaluator',
  }));
  const strategyOf = (db: Db) => db.writeTx((tx) => tx.run(
    "INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at) VALUES ('strategy-x', NULL, 't', 'b', '[]', 'experiment', '{}', 'actor-owner', '2026-10-19T00:00:00.000Z')",
  ));

  it("uses the experiment's own pass line (baseline + lift from the comparison) over the static pass_threshold of the definition; the evaluator rules are unchanged", async (t) => {
    const { db, clock, signals, source } = rig(t, { pass_threshold: 1 });
    strategyOf(db);
    const run = measuredRun(db, clock, signals[0]!, { value: 10 });
    reviewOf(db, clock, run.taskId, { passAtLeast: 11 });
    const observation = await source.read(run);
    assert.ok(observation?.measurable === true);
    assert.equal(observation.signal.passAtLeast, 11);
    const report = await evaluateRun({ db, clock, fetcher: new FakeFetcher(), effect: source }, run);
    assert.equal(report.evaluation.outcome, 'fail', '10 is below the experiment pass line 11 although it is above the static threshold 1');
    assert.match(report.evaluation.effect_note!, /below_target: mean 10/);
  });

  it('a value at the pass line is a pass; too few observations is still inconclusive (the evaluator rules apply as before)', async (t) => {
    const { db, clock, signals, source } = rig(t, { min_observations: 3 });
    strategyOf(db);
    const run = measuredRun(db, clock, signals[0]!, { value: 11 });
    reviewOf(db, clock, run.taskId, { passAtLeast: 11 });
    assert.equal((await evaluateRun({ db, clock, fetcher: new FakeFetcher(), effect: source }, run)).evaluation.outcome, 'pass');
    const few = rig(t, { min_observations: 5 });
    strategyOf(few.db);
    const fewRun = measuredRun(few.db, few.clock, few.signals[0]!, { value: 50 });
    reviewOf(few.db, few.clock, fewRun.taskId, { passAtLeast: 11 });
    assert.equal((await evaluateRun({ db: few.db, clock: few.clock, fetcher: new FakeFetcher(), effect: few.source }, fewRun)).evaluation.outcome, 'inconclusive');
  });

  it('does not apply to a task that is not the review task, to another signal or another week, or when the review has no pass line', async (t) => {
    const { db, clock, signals, source } = rig(t, { pass_threshold: 5 });
    strategyOf(db);
    const run = measuredRun(db, clock, signals[0]!);
    const passLine = async () => {
      const observation = await source.read(run);
      return observation?.measurable === true ? observation.signal.passAtLeast : 'unmeasurable';
    };
    assert.equal(await passLine(), 5, 'not a review task: the definition');
    const other = submittedRun(db, clock, { spec: { objective: 'other', inputs: [{ name: 'k', ref: 'r:o', kind: 'k' }] } });
    reviewOf(db, clock, other.taskId, { passAtLeast: 99 });
    assert.equal(await passLine(), 5, 'the review belongs to another task');
    db.writeTx((tx) => tx.run("DELETE FROM event WHERE idempotency_key = 'experiment-review:strategy-x'"));
    reviewOf(db, clock, run.taskId, { week: '2026-W44', passAtLeast: 99 });
    assert.equal(await passLine(), 5, 'another week');
    db.writeTx((tx) => tx.run("DELETE FROM event WHERE idempotency_key = 'experiment-review:strategy-x'"));
    reviewOf(db, clock, run.taskId, { passAtLeast: null });
    assert.equal(await passLine(), 5, 'the comparison left no pass line');
  });
});
