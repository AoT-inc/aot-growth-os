// A6-U16 통합: 주간 사이클 7단계(결과 검토 → 결과 기록 → 승격·거절 → 다음 주 반영)를 데몬 조립(실제 정책 게이트·승인 엔진·업무 엔진·평가기·사이클·팩)에서 가짜 어댑터로 돌린다.
//   조사 → 기획 → 제안 → 사람 승인 → 활성화(U15) → 실험 주(활성화 뒤 첫 ISO 주)가 끝남 → 결과 검토 업무 생성 → 사람이 그 주 값 입력 → 기존 평가기로 평가
//   - pass: measurement·strategy_record 기억(비용 = 원장 합계), 자동 승격 없음, 사람만 승격(에이전트 거부), 이전 active 는 retired
//   - fail: 기억 기록 + 시스템이 rejected 로 → 다음 실험 승인 가능
//   - inconclusive: 기억·lesson 없음, 사람 검토 대기, 승격 불가, 사람이 사유와 함께 거절
//   - 같은 평가로 두 번 기록하지 않음, 다음 주 기획 업무에 active 전략과 직전 strategy_record 가 붙음(refuted·만료·외부 유래는 빠짐)
// 외부 접근은 없다(가짜 어댑터, 가짜 출처 조회기). 시각은 가짜 시계.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  createMemoryItem, currentFacts, experimentResultKey, findExperimentDecision, findExperimentResult, findExperimentReview, listMemoryItems, promoteExperiment, refuteMemoryItem,
  type Db, type MemoryItemRow, type TaskRow,
} from '@aot/domain';
import { costForTask, recordCost, recordExperimentResult } from '@aot/evaluation';
import { TaskCreationError } from '@aot/task-engine';

import { runApproveCli } from '../support/approve-cli.ts';
import { taskStatus } from '../support/engine.ts';
import { candidate, marketingSpec, rig, runCycle, type CycleDaemon } from '../support/experiment-cycle.ts';
import { PACK_SIGNAL } from '../support/measurement.ts';
import { AGENT, createWithGate, deployDirect, OWNER, policyEnv, policyText, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';
import { REPO_ROOT } from '../support/schema-snapshot.ts';

const PACK_DIR = join(REPO_ROOT, 'packs', 'example-marketing');
const VALUES = { org_unit: 'core', product: 'example-product', research_source_url: 'https://docs.example.com/market-news', research_host: 'docs.example.com' };
/** 활성화 시각(2026-10-26 10:00 KST, W44 월요일)보다 뒤에 *시작*하는 첫 주 = W45 (11-02 ~ 11-08 KST). 그 주는 2026-11-08T15:00Z 에 끝난다 */
const W45_END = '2026-11-08T15:00:00.000Z';
const W45_KEY = 'measurement:weekly-landing-conversions@2026-W45';
const SHA = 'a'.repeat(64);
const MEASURE_FILE = 'file:/example/week-45.png';

function reviewRig(env: PolicyEnv, candidates: unknown[] = [candidate('copy-test', marketingSpec())]): CycleDaemon {
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES ('product-example-product', 'example-product', 'example-product', 'software', 'live', 'registered', ?, ?)",
    [env.clock.nowIso(), env.clock.nowIso()],
  ));
  return rig(env, candidates, { cycle: { budgetUsd: 5 }, pack: { dir: PACK_DIR, values: VALUES } });
}

function approveStrategy(daemon: CycleDaemon, id: string): { ok: boolean; state?: string; error?: string } {
  const shown = daemon.handleChannelRequest({ cmd: 'show', actor: OWNER, kind: 'strategy_version', id }) as { ok: boolean; hash?: string };
  return daemon.handleChannelRequest({ cmd: 'approve', actor: OWNER, kind: 'strategy_version', id, hash: shown.hash }) as { ok: boolean; state?: string; error?: string };
}

async function propose(env: PolicyEnv, daemon: CycleDaemon, key = 'r:1'): Promise<string> {
  await runCycle(env, daemon, key);
  const id = (await daemon.cycle!.advance()).compared[0]?.strategyVersionId;
  assert.ok(id);
  return id;
}

/** 제안 → 승인 → 활성화(+ 마케팅 업무 실행, 비용 원장 줄) → 실험 주가 끝나는 시각까지 시계를 보낸다. 아직 검토 업무는 없다 */
async function activated(env: PolicyEnv, daemon: CycleDaemon, key = 'r:1', withNext = false): Promise<{ id: string; marketingTaskId: string; next: string | null }> {
  const id = await propose(env, daemon, key);
  // 다음 실험 제안을 미리 만들어 둔다 (제안의 기준선 입력은 시계가 W43 직후일 때만 받는다)
  const next = withNext ? await propose(env, daemon, 'r:next') : null;
  assert.equal(approveStrategy(daemon, id).state, 'experiment');
  const [marketingTaskId] = (await daemon.cycle!.advance()).activated[0]!.taskIds as [string];
  assert.equal((await daemon.worker.tick()).executed?.taskId, marketingTaskId);
  // 실험 업무의 비용: 도구·모델 (원장에 직접 — 가짜 어댑터는 비용을 내지 않는다)
  env.db.writeTx((tx) => {
    recordCost(tx, env.clock, { taskId: marketingTaskId, taskRunId: null, category: 'tool', amountUsd: 0.4 });
    recordCost(tx, env.clock, { taskId: marketingTaskId, taskRunId: null, category: 'llm', amountUsd: 0.25, units: { tokens: 1200 } });
  });
  return { id, marketingTaskId, next };
}

function measure(daemon: CycleDaemon, value: number, extra: Record<string, unknown> = {}): { ok: boolean; error?: string } {
  return daemon.handleChannelRequest({
    cmd: 'measure', actor: OWNER, signal: PACK_SIGNAL.id, value, observations: 3, quality: 'good', attachments: [{ ref: MEASURE_FILE, sha256: SHA }], minutes: 15, ...extra,
  }) as { ok: boolean; error?: string };
}

/** 실험 주가 끝난 직후로 시계를 보내고 검토 업무를 만든다 */
async function toReview(env: PolicyEnv, daemon: CycleDaemon, id: string) {
  env.clock.set(W45_END);
  const report = await daemon.cycle!.advance();
  assert.deepEqual(report.reviewFailed, []);
  const created = report.reviewsCreated.find((r) => r.strategyVersionId === id);
  assert.ok(created, JSON.stringify(report));
  return created;
}

/** 검토 업무가 더 움직이지 않을 때까지 tick 을 돌린다 (재시도 대기는 시계를 보내 푼다) */
async function drain(env: PolicyEnv, daemon: CycleDaemon, taskId: string): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    await daemon.worker.tick();
    const status = taskStatus(env.db, taskId);
    if (status === 'completed' || status === 'needs_review' || status === 'failed') return status;
    env.clock.advance(11_000);
  }
  assert.fail(`task ${taskId} did not settle: ${taskStatus(env.db, taskId)}`);
}

const memoryOf = (db: Db, id: string): MemoryItemRow[] => db.all<MemoryItemRow>('SELECT * FROM memory_item WHERE strategy_version_id = ? ORDER BY kind', [id]);
const statusOf = (db: Db, id: string) => String(db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [id])!.status);
const count = (db: Db, sql: string, params: string[] = []) => Number(db.get<{ n: number }>(sql, params)!.n);
const ledgerSum = (db: Db, id: string): { usd: number; minutes: number; rows: number } => {
  const rows = db.all<{ category: string; amount_usd: number; units: string | null }>(
    `SELECT category, amount_usd, units FROM cost_entry WHERE task_id IN (SELECT id FROM task WHERE strategy_version_id = ?)
        OR (task_id IS NULL AND json_extract(units, '$.measurement') = ?)`, [id, W45_KEY],
  );
  return {
    usd: Math.round(rows.reduce((sum, row) => sum + Number(row.amount_usd), 0) * 1e9) / 1e9,
    minutes: rows.filter((row) => row.category === 'human_time').reduce((sum, row) => sum + Number((JSON.parse(row.units!) as { minutes: number }).minutes), 0),
    rows: rows.length,
  };
};

test('the review task is created once, only after the experiment week ended (the first week that starts after activation), and it waits for the human value', async (t) => {
  const env = policyEnv(t);
  const daemon = reviewRig(env);
  const { id } = await activated(env, daemon);

  // 활성화 뒤 첫 주 W44 는 이미 시작했으므로 실험 주는 W45 다: 그 주가 끝나기 전에는 만들지 않는다
  env.clock.set('2026-11-08T14:59:59.000Z');
  assert.deepEqual((await daemon.cycle!.advance()).reviewsCreated, []);
  assert.equal(findExperimentReview(env.db, id), null);

  env.clock.set(W45_END);
  const first = await daemon.cycle!.advance();
  assert.deepEqual(first.reviewsCreated.map((r) => [r.strategyVersionId, r.experimentWeek]), [[id, '2026-W45']]);
  const review = findExperimentReview(env.db, id)!;
  assert.deepEqual([review.experimentWeek, review.signalId, review.baseline, review.passAtLeast], ['2026-W45', PACK_SIGNAL.id, { week: '2026-W43', value: 10 }, 11]);
  const task = env.db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [review.reviewTaskId])!;
  assert.equal(task.strategy_version_id, id);
  assert.equal(task.max_attempts, 3);
  const spec = JSON.parse(task.spec) as { inputs: { name: string; ref: string; kind: string }[]; dependencies: string[]; trigger: { kind: string } };
  assert.deepEqual(spec.inputs.map((input) => [input.name, input.kind]), [['research', 'task_result'], ['plan', 'task_result'], ['result', 'measurement']]);
  assert.equal(spec.inputs[2]!.ref, W45_KEY);
  assert.equal(spec.dependencies.length, 2);
  assert.equal(spec.trigger.kind, 'event');
  // 반복해도 한 번 (여러 번 advance, 다른 프로세스처럼 새로 조립한 사이클)
  for (const cycle of [daemon.cycle!, reviewRig2(env).cycle!, daemon.cycle!]) assert.deepEqual((await cycle.advance()).reviewsCreated, []);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM task WHERE strategy_version_id = ? AND objective LIKE '%실험 주%'", [id]), 1);

  // 값이 입력되기 전에는 집히지 않는다 (U13 대기 조건)
  const tick = await daemon.worker.tick();
  assert.equal(tick.executed, null);
  assert.equal(taskStatus(env.db, review.reviewTaskId), 'queued');
  const entered = measure(daemon, 20);
  assert.equal(entered.ok, true, JSON.stringify(entered));
  const run = await daemon.worker.tick();
  assert.equal(run.executed?.taskId, review.reviewTaskId, JSON.stringify([run, taskStatus(env.db, review.reviewTaskId), env.db.all('SELECT reason FROM task_transition WHERE task_id = ?', [review.reviewTaskId])]));
});

/** 같은 DB 에 두 번째로 조립한 데몬 (다른 프로세스 흉내). 제품은 이미 있다 */
function reviewRig2(env: PolicyEnv): CycleDaemon {
  const now = env.clock.nowIso();
  const daemon = rig(env, [candidate('copy-test', marketingSpec())], { cycle: { budgetUsd: 5 }, pack: { dir: PACK_DIR, values: VALUES } });
  env.clock.set(now); // rig 는 시계를 W43 직후로 맞춘다
  return daemon;
}

test('pass: measurement and strategy_record are recorded with the cost of the ledger; nothing is promoted automatically; only a person promotes and the previous active strategy is retired', async (t) => {
  const env = policyEnv(t);
  const daemon = reviewRig(env);
  // 이전 active 전략 (롤백 지점이 될 것)
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at) VALUES ('strategy-previous', NULL, 'previous', 'previous body', '[]', 'active', NULL, ?, ?)",
    [OWNER, env.clock.nowIso()],
  ));
  const { id } = await activated(env, daemon);
  const { reviewTaskId } = await toReview(env, daemon, id);
  assert.equal(measure(daemon, 20).ok, true); // 기준선 10 → 합격선 11, 값 20, 사람 시간 15분
  assert.equal(await drain(env, daemon, reviewTaskId), 'completed');

  const evaluation = env.db.get<{ id: string; outcome: string; safety: string; effect: number }>('SELECT * FROM evaluation WHERE task_id = ?', [reviewTaskId])!;
  assert.deepEqual([evaluation.outcome, evaluation.safety, evaluation.effect], ['pass', 'pass', 20]);

  const report = await daemon.cycle!.advance();
  assert.deepEqual(report.resultsRecorded.map((r) => [r.strategyVersionId, r.conclusion, r.recorded, r.rejected]), [[id, 'pass', true, false]]);
  const result = findExperimentResult(env.db, id)!;
  assert.equal(result.evaluationId, evaluation.id);

  // 비용: 원장 합계와 같다 (도구 0.4 + 모델 0.25 + 사람 시간 15분, 같은 줄을 두 번 세지 않음)
  const ledger = ledgerSum(env.db, id);
  assert.deepEqual([result.totalCostUsd, result.humanMinutes], [ledger.usd, ledger.minutes]);
  assert.deepEqual([ledger.usd, ledger.minutes], [0.65, 15]);

  const items = memoryOf(env.db, id);
  assert.deepEqual(items.map((item) => item.kind), ['measurement', 'strategy_record']);
  const [measurement, record] = items as [MemoryItemRow, MemoryItemRow];
  for (const item of items) assert.deepEqual([item.trust_origin, item.verification_status, item.validity, item.created_by, item.product_id], ['internal', 'verified', 'valid', OWNER, 'product-example-product']);
  assert.match(measurement.source_ref, /^evidence:/);
  const evidence = env.db.get<{ kind: string; ref: string; task_id: string; trust_origin: string }>('SELECT * FROM evidence WHERE id = ?', [measurement.source_ref.slice('evidence:'.length)])!;
  assert.deepEqual([evidence.kind, evidence.ref, evidence.task_id, evidence.trust_origin], ['measurement', W45_KEY, reviewTaskId, 'internal']);
  assert.deepEqual(JSON.parse(measurement.body), {
    kind: 'experiment_measurement', strategy_version_id: id, signal_id: PACK_SIGNAL.id, week: '2026-W45',
    period: { start: '2026-11-01T15:00:00.000Z', end: W45_END, tz: 'Asia/Seoul' }, value: 20, observations: 3, data_quality: 'good',
    baseline: { week: '2026-W43', value: 10 }, pass_at_least: 11, effect: { lift_over_baseline: 10, met_pass_line: true }, measured_by: OWNER,
  });
  assert.equal(record.source_ref, `evaluation:${evaluation.id}`);
  const body = JSON.parse(record.body) as Record<string, unknown> & { cost: { total_usd: number; human_minutes: number; by_category: Record<string, number>; task_ids: string[] } };
  assert.deepEqual([body['conclusion'], body['evaluation_id'], body['measured_value'], body['baseline_value'], body['pass_at_least']], ['pass', evaluation.id, 20, 10, 11]);
  assert.deepEqual([body.cost.total_usd, body.cost.human_minutes, body.cost.by_category['tool'], body.cost.by_category['llm']], [ledger.usd, 15, 0.4, 0.25]);
  assert.equal(body.cost.task_ids.length, 2, 'the experiment task and the review task');
  assert.equal(body.cost.total_usd, costForTask(env.db, body.cost.task_ids[0]!).totalUsd + costForTask(env.db, body.cost.task_ids[1]!).totalUsd + 0, 'the task ledgers add up (the human time has no dollar amount)');
  // 기획 에이전트의 문장은 기억에 복사되지 않는다
  assert.doesNotMatch(record.body + measurement.body, /hypothesis copy-test/);
  // 현재 사실로 조회된다 (기본 만료 없음: 정책 memory.default_validity 가 비어 있다)
  assert.equal(record.valid_until, null);
  assert.deepEqual(currentFacts(env.db, { clock: env.clock, kind: 'strategy_record' }).map((item) => item.id), [record.id]);

  // 자동 승격은 없다: 상태는 experiment 그대로, 승격 대기에 보인다
  assert.equal(statusOf(env.db, id), 'experiment');
  assert.equal(statusOf(env.db, 'strategy-previous'), 'active');
  const reviews = daemon.handleChannelRequest({ cmd: 'reviews', actor: OWNER }) as { ok: boolean; awaitingPromotion: { strategyVersionId: string }[]; needsHuman: unknown[] };
  assert.deepEqual([reviews.ok, reviews.awaitingPromotion.map((p) => p.strategyVersionId), reviews.needsHuman], [true, [id], []]);

  // 에이전트: 채널 인증 단계에서 거부, 도메인 함수도 거부
  const byAgent = daemon.handleChannelRequest({ cmd: 'promote', actor: AGENT, kind: 'strategy_version', id, comment: 'looks good' }) as { ok: boolean; error: string };
  assert.equal(byAgent.ok, false);
  assert.match(byAgent.error, /only human actors/);
  assert.throws(() => env.db.writeTx((tx) => promoteExperiment(tx, env.clock, { strategyVersionId: id, actorId: AGENT, reason: 'x' })), /not a human|agent/);
  assert.equal(statusOf(env.db, id), 'experiment');
  // 사유 없는 승격은 거부
  const noReason = daemon.handleChannelRequest({ cmd: 'promote', actor: OWNER, kind: 'strategy_version', id }) as { ok: boolean; error: string };
  assert.equal(noReason.ok, false);
  assert.match(noReason.error, /reason/);

  const promoted = daemon.handleChannelRequest({ cmd: 'promote', actor: OWNER, kind: 'strategy_version', id, comment: 'the week beat the pass line' }) as { ok: boolean; status: string; retired: string[] };
  assert.deepEqual([promoted.ok, promoted.status, promoted.retired], [true, 'active', ['strategy-previous']]);
  assert.deepEqual([statusOf(env.db, id), statusOf(env.db, 'strategy-previous')], ['active', 'retired']);
  const decision = findExperimentDecision(env.db, id)!;
  assert.deepEqual([decision.decision, decision.by, decision.actorId, decision.reason, decision.retired], ['promoted', 'human', OWNER, 'the week beat the pass line', ['strategy-previous']]);
  // 두 번째 승격은 거부 (이미 active)
  assert.equal((daemon.handleChannelRequest({ cmd: 'promote', actor: OWNER, kind: 'strategy_version', id, comment: 'again' }) as { ok: boolean }).ok, false);

  // 멱등: 몇 번을 더 돌려도 기억·결과 기록은 늘지 않는다 (같은 평가로 두 번 기록하지 않음)
  for (let i = 0; i < 3; i += 1) assert.deepEqual((await daemon.cycle!.advance()).resultsRecorded, []);
  const again = env.db.writeTx((tx) => recordExperimentResult(tx, env.clock, { strategyVersionId: id, evaluationId: evaluation.id, by: 'evaluator' }));
  assert.equal(again.created, false);
  assert.equal(memoryOf(env.db, id).length, 2);
  assert.equal(count(env.db, 'SELECT count(*) AS n FROM event WHERE idempotency_key = ?', [experimentResultKey(id)]), 1);

  await t.test('next week: the planning task carries the active strategy and the last strategy_record; refuted, expired and externally derived items are left out', async () => {
    const plan = (n: number, memoryRef = 'memory:latest#strategy_record'): TaskRow => {
      const taskId = createWithGate(env, readOnlyDraft({
        product: 'example-product', objective: `plan week ${n}`, trigger: { kind: 'manual', ref: `actor:plan-${n}` },
        inputs: [{ name: 'previous-experiment', ref: memoryRef, kind: 'memory' }],
      }));
      return env.db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [taskId])!;
    };
    const refsOf = (task: TaskRow) => (JSON.parse(task.spec) as { inputs: { ref: string }[] }).inputs.map((input) => input.ref);

    const week1 = plan(1);
    assert.equal(week1.strategy_version_id, id, 'the active strategy is attached');
    assert.equal((JSON.parse(week1.spec) as { versions: { strategy_version: string } }).versions.strategy_version, id);
    assert.deepEqual(refsOf(week1), [`memory:${record.id}`], 'the selector became the concrete record');

    // 만료된 항목
    env.db.writeTx((tx) => tx.run('UPDATE memory_item SET valid_until = ? WHERE id = ?', ['2026-11-01T00:00:00.000Z', record.id]));
    assert.deepEqual(refsOf(plan(2)), []);
    assert.throws(() => plan(3, `memory:${record.id}`), (e: unknown) => e instanceof TaskCreationError && e.issues.some((i) => i.code === 'memory_not_current'));
    env.db.writeTx((tx) => tx.run('UPDATE memory_item SET valid_until = NULL WHERE id = ?', [record.id]));
    assert.deepEqual(refsOf(plan(4)), [`memory:${record.id}`]);

    // 반증된 항목
    env.db.writeTx((tx) => refuteMemoryItem(tx, record.id, OWNER));
    assert.deepEqual(refsOf(plan(5)), []);
    assert.throws(() => plan(6, `memory:${record.id}`), (e: unknown) => e instanceof TaskCreationError && e.issues.some((i) => i.code === 'memory_not_current'));

    // 외부 유래 가설은 현재 사실이 아니므로 입력으로 들어오지 않는다
    const hypothesis = env.db.writeTx((tx) => createMemoryItem(tx, {
      kind: 'hypothesis', body: 'a claim from an external page', source_ref: 'https://docs.example.com/a', observed_at: env.clock.nowIso(), trust_origin: 'external_untrusted',
      product_id: 'product-example-product', created_by: AGENT,
    }, { clock: env.clock }));
    assert.deepEqual(refsOf(plan(7)), []);
    assert.throws(() => plan(8, `memory:${hypothesis.id}`), (e: unknown) => e instanceof TaskCreationError && e.issues.some((i) => i.code === 'memory_not_current'));
    assert.throws(() => plan(9, 'memory:no-such-item'), (e: unknown) => e instanceof TaskCreationError && e.issues.some((i) => i.code === 'not_found'));
    // 다른 상품의 기억은 섞이지 않는다: 상품 없는 업무는 상품 없는 기억만 본다
    const listed = listMemoryItems(env.db, { kind: 'strategy_record' });
    assert.equal(listed.length, 1);
  });
});

test('the expiry of the recorded items follows the policy parameter memory.default_validity of the current policy; empty (Q17 is open) means no expiry', async (t) => {
  const env = policyEnv(t);
  const daemon = reviewRig(env);
  deployDirect(env, policyText((yaml) => yaml.replace('default_validity: {}', 'default_validity: {measurement: 30d, strategy_record: 14d}')));
  const { id } = await activated(env, daemon);
  const { reviewTaskId } = await toReview(env, daemon, id);
  assert.equal(measure(daemon, 20).ok, true);
  assert.equal(await drain(env, daemon, reviewTaskId), 'completed');
  await daemon.cycle!.advance();
  assert.deepEqual(memoryOf(env.db, id).map((item) => [item.kind, item.valid_until]), [['measurement', '2026-12-08T15:00:00.000Z'], ['strategy_record', '2026-11-22T15:00:00.000Z']]);
  // 만료가 지나면 현재 사실이 아니고, 다음 주 기획 입력에서도 빠진다
  env.clock.set('2026-11-23T00:00:00.000Z');
  assert.deepEqual(currentFacts(env.db, { clock: env.clock, kind: 'strategy_record' }), []);
});

test('fail: the result is recorded and the system rejects the experiment; the next experiment can be approved', async (t) => {
  const env = policyEnv(t);
  const daemon = reviewRig(env);
  const { id, next } = await activated(env, daemon, 'r:1', true);
  assert.equal(approveStrategy(daemon, next!).ok, false, 'one experiment at a time while this one is in progress');
  const { reviewTaskId } = await toReview(env, daemon, id);
  assert.equal(measure(daemon, 5).ok, true); // 합격선 11 에 못 미친다
  // 평가가 fail 이어도 재시도가 남아 있으면 아직 정해진 것이 아니다: 시도를 다 쓸 때까지는 기록하지 않는다
  await daemon.worker.tick(); // execute
  await daemon.worker.tick(); // validate -> retry_wait
  assert.equal(taskStatus(env.db, reviewTaskId), 'retry_wait');
  assert.deepEqual((await daemon.cycle!.advance()).resultsRecorded, []);
  assert.equal(findExperimentResult(env.db, id), null);
  assert.equal(await drain(env, daemon, reviewTaskId), 'needs_review');

  const report = await daemon.cycle!.advance();
  assert.deepEqual(report.resultsRecorded.map((r) => [r.conclusion, r.recorded, r.rejected]), [['fail', true, true]]);
  assert.equal(statusOf(env.db, id), 'rejected');
  const decision = findExperimentDecision(env.db, id)!;
  assert.deepEqual([decision.decision, decision.by, decision.actorId], ['rejected', 'evaluator', null]);
  assert.match(decision.reason, /failed/);
  const result = findExperimentResult(env.db, id)!;
  assert.equal(result.conclusion, 'fail');
  const record = memoryOf(env.db, id).find((item) => item.kind === 'strategy_record')!;
  assert.equal((JSON.parse(record.body) as { conclusion: string }).conclusion, 'fail');
  assert.equal(result.totalCostUsd, ledgerSum(env.db, id).usd);
  // 종료 기록이 있다 (루틴이 있었다면 꺼졌을 것이다)
  assert.equal(count(env.db, "SELECT count(*) AS n FROM event WHERE idempotency_key = ?", [`experiment-end:${id}`]), 1);

  // 다음 실험을 승인할 수 있다 (rejected 는 진행 중이 아니다)
  assert.equal(approveStrategy(daemon, next!).state, 'experiment');
  // fail 은 승격할 수 없다
  assert.equal((daemon.handleChannelRequest({ cmd: 'promote', actor: OWNER, kind: 'strategy_version', id, comment: 'try' }) as { ok: boolean }).ok, false);
});

test('inconclusive: no strategy_record or lesson is created, the experiment waits for a person, it cannot be promoted, and a person rejects it with a reason', async (t) => {
  const env = policyEnv(t);
  const daemon = reviewRig(env);
  const { id, next } = await activated(env, daemon, 'r:1', true);
  const { reviewTaskId } = await toReview(env, daemon, id);
  assert.equal(measure(daemon, 20, { observations: 0 }).ok, true); // 관측 수 부족 (min_observations 1)
  assert.equal(await drain(env, daemon, reviewTaskId), 'needs_review');
  const evaluation = env.db.get<{ id: string; outcome: string }>('SELECT id, outcome FROM evaluation WHERE task_id = ?', [reviewTaskId])!;
  assert.equal(evaluation.outcome, 'inconclusive');

  const report = await daemon.cycle!.advance();
  assert.deepEqual([report.resultsRecorded, report.resultFailed], [[], []]);
  assert.equal(memoryOf(env.db, id).length, 0);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM memory_item WHERE kind IN ('lesson', 'strategy_record', 'measurement')"), 0);
  assert.equal(findExperimentResult(env.db, id), null);
  // 직접 기록하려 해도 거부되고 아무것도 쓰지 않는다
  assert.throws(() => env.db.writeTx((tx) => recordExperimentResult(tx, env.clock, { strategyVersionId: id, evaluationId: evaluation.id, by: 'evaluator' })), /inconclusive_not_learnable|inconclusive/);
  assert.equal(count(env.db, 'SELECT count(*) AS n FROM memory_item'), 0);

  const reviews = daemon.handleChannelRequest({ cmd: 'reviews', actor: OWNER }) as { needsHuman: { strategyVersionId: string; reason: string }[]; awaitingPromotion: unknown[] };
  assert.deepEqual(reviews.needsHuman.map((r) => r.strategyVersionId), [id]);
  assert.match(reviews.needsHuman[0]!.reason, /inconclusive/);
  assert.deepEqual(reviews.awaitingPromotion, []);
  assert.equal(statusOf(env.db, id), 'experiment');

  // 승격 불가 (결과 없음), 사유 없는 거절 불가, 에이전트 거절 불가
  const promote = daemon.handleChannelRequest({ cmd: 'promote', actor: OWNER, kind: 'strategy_version', id, comment: 'try' }) as { ok: boolean; code: string };
  assert.deepEqual([promote.ok, promote.code], [false, 'no_result']);
  const noReason = daemon.handleChannelRequest({ cmd: 'reject', actor: OWNER, kind: 'strategy_version', id }) as { ok: boolean; error: string };
  assert.deepEqual([noReason.ok, /reason/.test(noReason.error)], [false, true]);
  const byAgent = daemon.handleChannelRequest({ cmd: 'reject', actor: AGENT, kind: 'strategy_version', id, comment: 'x' }) as { ok: boolean; error: string };
  assert.deepEqual([byAgent.ok, /only human actors/.test(byAgent.error)], [false, true]);
  assert.equal(statusOf(env.db, id), 'experiment');

  const rejected = daemon.handleChannelRequest({ cmd: 'reject', actor: OWNER, kind: 'strategy_version', id, comment: 'not enough observations to judge' }) as { ok: boolean; status: string };
  assert.deepEqual([rejected.ok, rejected.status], [true, 'rejected']);
  const decision = findExperimentDecision(env.db, id)!;
  assert.deepEqual([decision.decision, decision.by, decision.actorId, decision.reason], ['rejected', 'human', OWNER, 'not enough observations to judge']);
  assert.deepEqual((daemon.handleChannelRequest({ cmd: 'reviews', actor: OWNER }) as { needsHuman: unknown[] }).needsHuman, [], 'a decided experiment is no longer waiting for a person');
  // 다음 실험 승인 가능
  assert.equal(approveStrategy(daemon, next!).state, 'experiment');
  assert.equal(memoryOf(env.db, id).length, 0);
});

test('an experiment that stays in experiment because its activation was refused can be rejected by a person, and the next experiment can then be approved', async (t) => {
  const env = policyEnv(t);
  const daemon = reviewRig(env);
  const first = await propose(env, daemon, 'r:1');
  assert.equal(approveStrategy(daemon, first).state, 'experiment');
  // 활성화 전에 내용이 바뀌어 활성화가 거부된다 (U15 열린 항목)
  env.db.writeTx((tx) => tx.run("UPDATE strategy_version SET body = 'changed after approval' WHERE id = ?", [first]));
  assert.deepEqual((await daemon.cycle!.advance()).activationFailed.map((f) => f.code), ['approval_invalid']);
  const second = await propose(env, daemon, 'r:2');
  assert.match(String(approveStrategy(daemon, second).error), /already in progress/);

  const rejected = daemon.handleChannelRequest({ cmd: 'reject', actor: OWNER, kind: 'strategy_version', id: first, comment: 'activation was refused' }) as { ok: boolean; status: string };
  assert.deepEqual([rejected.ok, rejected.status], [true, 'rejected']);
  assert.equal(approveStrategy(daemon, second).state, 'experiment');
  // proposed 전략의 reject 는 이전처럼 승인 엔진이 처리한다
  const third = await propose(env, daemon, 'r:3');
  const viaEngine = daemon.handleChannelRequest({ cmd: 'reject', actor: OWNER, kind: 'strategy_version', id: third }) as { ok: boolean; state: string };
  assert.deepEqual([viaEngine.ok, viaEngine.state], [true, 'rejected']);
});

test('a template experiment: the review turns the experiment routine off when the week ends', async (t) => {
  const env = policyEnv(t);
  const daemon = reviewRig(env, [{
    id: 'research-more', hypothesis: 'more research helps', expected_effect: 20, est_cost_usd: 1, task_template_ref: 'weekly-market-research@1',
    measurement: { signal_id: PACK_SIGNAL.id, period: 'iso_week' },
  }]);
  const id = await propose(env, daemon);
  assert.equal(approveStrategy(daemon, id).state, 'experiment');
  const activation = (await daemon.cycle!.advance()).activated[0]!;
  assert.deepEqual(activation.routineIds, ['routine-weekly-market-research']);
  const enabled = () => Number(env.db.get<{ enabled: number }>("SELECT enabled FROM routine WHERE id = 'routine-weekly-market-research'")!.enabled);
  assert.equal(enabled(), 1);
  const created = await toReview(env, daemon, id);
  assert.deepEqual(created.routineIds, ['routine-weekly-market-research']);
  assert.equal(enabled(), 0);
});

test('the approval CLI: promote needs a reason, reject works for an experiment, reviews lists the status (real socket and CLI process)', async (t: TestContext) => {
  const env = policyEnv(t);
  const daemon = reviewRig(env);
  const { id } = await activated(env, daemon);
  const { reviewTaskId } = await toReview(env, daemon, id);
  assert.equal(measure(daemon, 20).ok, true);
  assert.equal(await drain(env, daemon, reviewTaskId), 'completed');
  await daemon.cycle!.advance();

  const server = await daemon.startApprovalChannel();
  t.after(() => server.close());
  const cli = (args: string[], actor = OWNER) => runApproveCli(args, { socket: join(env.dir, 'run', 'approval.sock'), actor });

  const reviews = await cli(['reviews']);
  assert.equal(reviews.code, 0, reviews.stderr);
  assert.deepEqual((reviews.json!['awaitingPromotion'] as { strategyVersionId: string }[]).map((p) => p.strategyVersionId), [id]);
  const noReason = await cli(['promote', 'strategy', id]);
  assert.notEqual(noReason.code, 0);
  assert.match(noReason.stderr, /--comment/);
  const agent = await cli(['promote', 'strategy', id, '--comment', 'x'], AGENT);
  assert.equal(agent.code, 1);
  assert.match(String(agent.json!['error']), /only human actors/);
  assert.equal(statusOf(env.db, id), 'experiment');
  const promoted = await cli(['promote', 'strategy', id, '--comment', 'beat the pass line']);
  assert.equal(promoted.code, 0, promoted.stdout + promoted.stderr);
  assert.deepEqual([promoted.json!['ok'], promoted.json!['status']], [true, 'active']);
  assert.equal(statusOf(env.db, id), 'active');
});
