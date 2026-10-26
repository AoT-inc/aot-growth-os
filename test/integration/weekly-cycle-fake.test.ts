// A6-U17 통합: 주간 사이클 1~7단계를 하나의 시나리오로 끝까지 — 데몬 조립(실제 정책 게이트·승인 엔진·업무 엔진·평가기·측정 채널·사이클·팩) + 가짜 어댑터.
//   ① 켜진 주간 기획 루틴(팩 `weekly-experiment-planning`, 한 슬롯에서 조사 → 기획 업무)의 슬롯 발화
//   ② 조사 업무(게이트웨이 fetch_url, 비용 보고) ③ 검증(결정론적 검사 + 설정 `llm_verifier: {kind:"stub"}` 의 가짜 LLM 검증기)
//   ④ 기획 업무(조사 결과를 U11 로 받고 지난주 기준선 측정을 기다림 → 사람이 입력) ⑤ 후보 비교(U14: 정책 deny 후보 제외) → strategy_version 제안
//   ⑥ 사람 승인(U15, 실제 승인 CLI 프로세스: 오래된 해시·에이전트 거부) → 실험 활성화(마케팅 업무; 공개 게시 호출은 게이트웨이가 막는다)
//   ⑦ (가짜 시계 전진) 실험 주 종료 → 결과 검토 업무 → 사람이 측정 값 입력(U13) → 평가 → 결과 기록(U16, 기억·실험 총비용 = 원장) → 사람 승격
//      → 다음 주 슬롯의 기획 업무에 active `strategy_version_id` 와 직전 `strategy_record` 가 붙고, 그 기록이 만료된 뒤의 주에는 빠진다
// 단계 사이마다 업무 상태·evidence·policy_decision·cost_entry·approval·strategy_version·memory_item 을 단언한다.
// 시험 전용 차이는 팩 사본의 조사 업무 `validation.llm` 하나다(test/support/weekly-cycle.ts 의 `cyclePackCopy`). 외부 접근은 없다. 시각은 가짜 시계.
// 같은 경로의 다중 프로세스 시험(두 데몬 같은 슬롯 → 발화 1건, 조사 업무 실행 중 SIGKILL → 새 attempt)은 아래 describe 블록이다.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, test, type TestContext } from 'node:test';

import type { ToolCallRecord } from '@aot/agent-runtime';
import { applyMigrations, currentFacts, findExperimentResult, openDb, seedPhaseA, FakeClock, type Db, type TaskRow } from '@aot/domain';
import { costForTask } from '@aot/evaluation';
import { listMeasurementWaits } from '@aot/task-engine';

import { loadPack, syncPackRoutines } from '../../apps/daemon/src/pack-loader.ts';
import { runApproveCli } from '../support/approve-cli.ts';
import { taskStatus } from '../support/engine.ts';
import { AGENT, deployDirect, OWNER, policyEnv, policyText, type PolicyEnv } from '../support/policy.ts';
import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';
import { addAgent } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';
import {
  assembleCycleDaemon, COST, cyclePackCopy, enablePlanningRoutine, PACK_VALUES, PLANNING_ROUTINE, SIGNAL_ID, type CycleRigDaemon,
} from '../support/weekly-cycle.ts';

// ----- 시각 (Asia/Seoul 월요일 09:00 = 00:00Z) -----
const FIRST_SEEN = '2026-10-25T16:00:00.000Z'; // 월 01:00 KST: 데몬이 켜진 루틴을 처음 본다(그 전 슬롯은 발화하지 않는다)
const SLOT_1 = '2026-10-26T00:00:00.000Z'; // W44 월요일 슬롯 → 지난주 = W43
const W45_END = '2026-11-08T15:00:00.000Z'; // 활성화(W44 월 09:00 이후) 뒤 처음 시작하는 주 = W45
const SLOT_2 = '2026-11-09T00:00:00.000Z'; // W46 월요일 → 지난주 = W45
const SLOT_3 = '2026-11-23T00:00:00.000Z'; // W48 월요일 (W47 슬롯은 건너뛴다: catch_up skip)
const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs).toISOString();
const SHA = 'c'.repeat(64);

const count = (db: Db, sql: string, params: unknown[] = []): number => Number(db.get<{ n: number }>(sql, params as string[])!.n);
const sum = (db: Db, sql: string, params: unknown[] = []): number => Math.round(Number(db.get<{ s: number | null }>(sql, params as string[])!.s ?? 0) * 1e9) / 1e9;
const round = (n: number) => Math.round(n * 1e9) / 1e9;
const taskRow = (db: Db, id: string) => db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [id])!;
const specOf = (db: Db, id: string) => JSON.parse(taskRow(db, id).spec) as { inputs: { name: string; ref: string; kind: string }[]; dependencies: string[] };
const decisions = (db: Db, taskId: string) => db.all<{ action: string; decision: string; scope: string; run: number }>(
  'SELECT action, decision, scope, task_run_id IS NOT NULL AS run FROM policy_decision WHERE task_id = ? ORDER BY id', [taskId],
).map((row) => [row.action, row.decision, row.scope, Number(row.run)]);
const costs = (db: Db, taskId: string) => db.all<{ category: string; amount_usd: number; source: string | null; run: number }>(
  "SELECT category, amount_usd, json_extract(units, '$.source') AS source, task_run_id IS NOT NULL AS run FROM cost_entry WHERE task_id = ? ORDER BY at, rowid", [taskId],
).map((row) => [row.category, round(row.amount_usd), row.source, Number(row.run)]);
const evidenceOf = (db: Db, taskId: string) => db.all<{ kind: string; trust_origin: string; verified: number; run: number }>(
  'SELECT kind, trust_origin, verified, task_run_id IS NOT NULL AS run FROM evidence WHERE task_id = ? ORDER BY captured_at, rowid', [taskId],
).map((row) => [row.kind, row.trust_origin, row.verified, Number(row.run)]);
const strategyStatus = (db: Db, id: string) => String(db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [id])!.status);
/** 업무 이름 → id: 루틴이 낸 업무는 trigger_ref(<slug>@<slot>)와 목적 문장으로 고른다 */
function firedPair(db: Db, slot: string): { research: string; plan: string } {
  const rows = db.all<{ id: string; objective: string }>("SELECT id, objective FROM task WHERE trigger_kind = 'routine' AND trigger_ref = ? ORDER BY created_at, rowid", [`weekly-experiment-planning@${slot}`]);
  assert.equal(rows.length, 2, `the slot ${slot} produced the two tasks of the template`);
  return { research: rows.find((row) => row.objective.includes('지난 7일'))!.id, plan: rows.find((row) => row.objective.includes('실험 후보'))!.id };
}

interface Rig { env: PolicyEnv; daemon: CycleRigDaemon; records: ToolCallRecord[]; published: string[] }

function makeRig(t: TestContext): Rig {
  const env = policyEnv(t);
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES ('product-example-product', 'example-product', 'example-product', 'software', 'live', 'registered', ?, ?)",
    [env.clock.nowIso(), env.clock.nowIso()],
  ));
  const records: ToolCallRecord[] = [];
  const published: string[] = [];
  const daemon = assembleCycleDaemon({
    db: env.db, clock: env.clock, dir: env.dir, packDir: cyclePackCopy(env.dir), records, published,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
  });
  return { env, daemon, records, published };
}

function measure(daemon: CycleRigDaemon, week: string, value: number, minutes: number): { ok: boolean; error?: string } {
  return daemon.handleChannelRequest({
    cmd: 'measure', actor: OWNER, signal: SIGNAL_ID, week, value, observations: 3, quality: 'good', attachments: [{ ref: `file:/example/${week}.png`, sha256: SHA }], minutes,
  }) as { ok: boolean; error?: string };
}

test('the weekly cycle from the routine slot to the next week, steps 1-7 with fake adapters, with the database checked between the steps', async (t) => {
  const { env, daemon, records, published } = makeRig(t);
  const { db, clock } = env;
  assert.deepEqual(daemon.packSync?.created, ['weekly-experiment-planning', 'weekly-market-research'], 'the pack routines reach the database disabled');
  enablePlanningRoutine(db);
  assert.deepEqual(db.all('SELECT slug, enabled FROM routine ORDER BY slug').map((row) => ({ ...row })), [
    { slug: 'weekly-experiment-planning', enabled: 1 }, { slug: 'weekly-market-research', enabled: 0 },
  ]);

  // ===== ① 슬롯 발화 =====
  clock.set(FIRST_SEEN);
  assert.deepEqual((await daemon.worker.tick()).routines, { fired: [], failed: [] }, 'first sight: no slot before it fires');
  clock.set(at(SLOT_1, 5_000));
  const fired = await daemon.worker.tick();
  assert.deepEqual(fired.routines.failed, []);
  assert.deepEqual(fired.routines.fired.map((f) => [f.routineId, f.scheduledFor, f.created, f.taskIds.length]), [[PLANNING_ROUTINE, SLOT_1, true, 2]]);
  const week1 = firedPair(db, SLOT_1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM routine_firing'), 1);
  // 기획 업무: 조사에 의존하고, 조사 결과(task_result)와 지난주(W43) 기준선 측정을 받는다. 직전 strategy_record 가 아직 없으므로 기억 입력은 빠졌다
  assert.deepEqual(specOf(db, week1.plan).inputs.map((i) => [i.name, i.kind, i.ref]), [
    ['findings', 'task_result', `task:${week1.research}`], ['baseline', 'measurement', `measurement:${SIGNAL_ID}@2026-W43`],
  ]);
  assert.deepEqual(specOf(db, week1.plan).dependencies, [week1.research]);
  for (const id of [week1.research, week1.plan]) assert.equal(taskRow(db, id).strategy_version_id, null, 'no active strategy yet');

  // ===== ② 조사 업무 실행 (같은 tick: 발화 뒤 선택) =====
  assert.equal(fired.executed?.taskId, week1.research);
  assert.deepEqual(fired.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(taskStatus(db, week1.plan), 'queued');
  // 정책 판정: 생성(업무 단위) → 실행 직전 재판정 → 게이트웨이 호출마다 (run 에 묶임)
  assert.deepEqual(decisions(db, week1.research), [['fetch_url.fetch', 'allow', 'internal', 0], ['fetch_url.fetch', 'allow', 'internal', 0], ['fetch_url.fetch', 'allow', 'internal', 1]]);
  assert.deepEqual(records.map((r) => [r.tool, r.outcome]), [['fetch_url', 'ok']]);
  assert.deepEqual(costs(db, week1.research), [['tool', COST.fetch, 'adapter', 1], ['llm', COST.researchLlm, 'adapter', 1]]);
  assert.deepEqual(evidenceOf(db, week1.research), [['source_url', 'external_untrusted', 0, 1]], 'agent evidence is stored as external_untrusted (A5-U8)');

  // ===== ③ 검증: 결정론적 검사 + 가짜 LLM 검증기 (설정 kind:"stub") =====
  clock.set(at(SLOT_1, 10_000));
  const validated = await daemon.worker.tick();
  assert.deepEqual(validated.validated.map((v) => [v.taskId, v.taskStatus]), [[week1.research, 'completed']]);
  assert.equal(validated.executed, null, 'the planning task waits for the baseline measurement');
  const researchEval = db.get<{ outcome: string; safety: string; quality_note: string }>('SELECT outcome, safety, quality_note FROM evaluation WHERE task_id = ?', [week1.research])!;
  assert.deepEqual([researchEval.outcome, researchEval.safety], ['pass', 'pass']);
  for (const check of ['url_reachable=pass', 'quote_in_source=pass', 'dedupe=pass', 'uncertainty_listed=pass', 'stub-llm-verifier@v1: supported']) assert.match(researchEval.quality_note, new RegExp(check.replace(/[.@]/g, '\\$&')));
  assert.deepEqual(evidenceOf(db, week1.research), [['source_url', 'external_untrusted', 1, 1]], 'verified, but still external_untrusted');
  assert.deepEqual(costs(db, week1.research).at(-1), ['llm', COST.validation, 'validation', 1], 'the verification cost is a separate ledger line of the same run');
  assert.deepEqual(listMeasurementWaits(db).map((w) => [w.taskId, w.ref]), [[week1.plan, `measurement:${SIGNAL_ID}@2026-W43`]]);

  // ===== ④ 사람이 기준선(W43) 값을 입력 → 기획 업무가 조사 결과를 받아 후보를 낸다 =====
  const baseline = measure(daemon, '2026-W43', 10, 10);
  assert.equal(baseline.ok, true, JSON.stringify(baseline));
  assert.deepEqual(evidenceOf(db, week1.plan), [['measurement', 'internal', 0, 0], ['document', 'internal', 0, 0]], 'the measurement and its attachment are attached to the waiting task');
  assert.deepEqual(costs(db, week1.plan), [['human_time', 0, 'measurement', 0]]);
  clock.set(at(SLOT_1, 20_000));
  assert.equal((await daemon.worker.tick()).executed?.taskId, week1.plan);
  clock.set(at(SLOT_1, 30_000));
  assert.deepEqual((await daemon.worker.tick()).validated.map((v) => [v.taskId, v.taskStatus]), [[week1.plan, 'completed']]);
  assert.equal(db.get<{ adapter: string }>('SELECT adapter FROM task_run WHERE task_id = ?', [week1.plan])!.adapter, 'planner-fake');
  assert.deepEqual(costs(db, week1.plan).map((row) => row[0]), ['human_time', 'llm'], 'the planning run reports its model cost (no verification cost: no llm check)');

  // ===== ⑤ 후보 비교 → strategy_version 제안 (정책이 거부하는 후보는 효과 주장이 커도 빠진다) =====
  const decisionsBefore = count(db, 'SELECT count(*) AS n FROM policy_decision');
  const compared = await daemon.cycle!.advance();
  assert.deepEqual(compared.failed, []);
  assert.deepEqual(compared.compared.map((c) => [c.planningTaskId, c.outcome, c.proposalCreated]), [[week1.plan, 'recommended', true]]);
  const strategyId = compared.compared[0]!.strategyVersionId!;
  assert.equal(count(db, 'SELECT count(*) AS n FROM policy_decision'), decisionsBefore, 'the comparison judges risks in advance and records no policy_decision');
  const comparison = JSON.parse(db.get<{ payload: string }>("SELECT payload FROM event WHERE idempotency_key = ?", [`experiment-comparison:${week1.plan}`])!.payload) as { recommended: string; candidates: { id: string; risk: { decision: string }; excluded?: unknown; rank: number | null }[] };
  assert.equal(comparison.recommended, 'copy-publish');
  const risky = comparison.candidates.find((c) => c.id === 'risky-delete')!;
  assert.equal(risky.risk.decision, 'deny');
  assert.equal(risky.rank, null, 'the denied candidate is not ranked');
  const strategy = db.get<{ status: string; created_by: string; experiment_scope: string }>('SELECT * FROM strategy_version WHERE id = ?', [strategyId])!;
  assert.deepEqual([strategy.status, strategy.created_by], ['proposed', AGENT]);
  const scope = JSON.parse(strategy.experiment_scope) as { measurement: { baseline_week: string; baseline_value: number; pass_at_least: number }; trust_origin: string };
  assert.deepEqual([scope.measurement.baseline_week, scope.measurement.baseline_value, scope.measurement.pass_at_least, scope.trust_origin], ['2026-W43', 10, 11, 'external_untrusted']);
  assert.equal(count(db, 'SELECT count(*) AS n FROM approval'), 0);

  // ===== ⑥ 사람 승인 (승인 CLI 프로세스) =====
  const server = await daemon.startApprovalChannel();
  t.after(() => server.close());
  const cli = (args: string[], actor = OWNER) => runApproveCli(args, { socket: join(env.dir, 'run', 'approval.sock'), actor });
  const shown = await cli(['show', 'strategy', strategyId]);
  assert.equal(shown.code, 0, shown.stderr);
  const staleHash = String(shown.json!['hash']);
  // 보여 준 뒤 정책이 새로 배포되면(여기서는 strategy_record 기본 만료 14일) 그 해시는 오래된 것이다: 승인 거부, 아무것도 기록되지 않는다
  deployDirect(env, policyText((yaml) => yaml.replace('default_validity: {}', 'default_validity: {strategy_record: 14d}')));
  const stale = await cli(['approve', 'strategy', strategyId, '--hash', staleHash, '--comment', 'looks good']);
  assert.equal(stale.code, 1);
  assert.match(String(stale.json!['error']), /hash/);
  // 에이전트 actor 는 채널 인증 단계에서 거부된다
  const byAgent = await cli(['approve', 'strategy', strategyId, '--hash', staleHash], AGENT);
  assert.equal(byAgent.code, 1);
  assert.match(String(byAgent.json!['error']), /only human actors/);
  assert.deepEqual([count(db, 'SELECT count(*) AS n FROM approval'), strategyStatus(db, strategyId)], [0, 'proposed']);
  const fresh = await cli(['show', 'strategy', strategyId]);
  assert.notEqual(String(fresh.json!['hash']), staleHash);
  const approved = await cli(['approve', 'strategy', strategyId, '--hash', String(fresh.json!['hash']), '--comment', 'run it for one week']);
  assert.equal(approved.code, 0, approved.stdout + approved.stderr);
  assert.equal(approved.json!['state'], 'experiment');
  assert.deepEqual(db.all('SELECT subject_kind, subject_id, decision, decided_by FROM approval').map((row) => ({ ...row })), [
    { subject_kind: 'strategy_version', subject_id: strategyId, decision: 'approved', decided_by: OWNER },
  ]);
  assert.equal(count(db, "SELECT count(*) AS n FROM event WHERE type = 'experiment.activated'"), 0, 'the approval does not activate by itself');

  // 활성화: 일회성 마케팅 업무 (생성 게이트 allow: 명세는 internal/write 로 적었다)
  const activated = await daemon.cycle!.advance();
  assert.deepEqual(activated.activationFailed, []);
  const [marketing] = activated.activated[0]!.taskIds as [string];
  assert.equal(taskRow(db, marketing).strategy_version_id, strategyId);
  assert.deepEqual(decisions(db, marketing), [['publication.publish', 'allow', 'internal', 0]]);
  for (let i = 0; i < 2; i += 1) assert.deepEqual((await daemon.cycle!.advance()).activated, [], 'activated once');
  clock.set(at(SLOT_1, 3_700_000));
  assert.equal((await daemon.worker.tick()).executed?.taskId, marketing);
  // 공개 게시 호출: 게이트웨이는 호스트 선언(public, 외부 부작용)으로 재판정해 막고 policy_decision 을 남긴다. 실행기는 불리지 않았다
  assert.deepEqual(decisions(db, marketing).slice(1), [['publication.publish', 'allow', 'internal', 0], ['publication.publish', 'require_approval', 'public', 1]]);
  assert.deepEqual(records.slice(-1).map((r) => [r.tool, r.outcome]), [['publication', 'approval_required']]);
  assert.deepEqual(published, []);
  clock.set(at(SLOT_1, 3_710_000));
  assert.deepEqual((await daemon.worker.tick()).validated.map((v) => [v.taskId, v.taskStatus]), [[marketing, 'completed']], 'the refused call is recorded; the run itself finishes');
  assert.deepEqual(costs(db, marketing), [['llm', COST.marketingLlm, 'adapter', 1]], 'a refused call costs nothing');

  // ===== ⑦ 실험 주(W45) 종료 → 결과 검토 업무 → 사람이 값을 입력 → 평가 → 결과 기록 =====
  clock.set(at(W45_END, -1_000));
  assert.deepEqual((await daemon.cycle!.advance()).reviewsCreated, [], 'not before the experiment week ends');
  clock.set(W45_END);
  const reviewReport = await daemon.cycle!.advance();
  assert.deepEqual(reviewReport.reviewFailed, []);
  assert.deepEqual(reviewReport.reviewsCreated.map((r) => [r.strategyVersionId, r.experimentWeek]), [[strategyId, '2026-W45']]);
  const reviewTask = reviewReport.reviewsCreated[0]!.reviewTaskId;
  assert.equal(taskRow(db, reviewTask).strategy_version_id, strategyId);
  clock.set(at(W45_END, 5_000));
  const waiting = await daemon.worker.tick();
  assert.deepEqual(waiting.routines.fired, [], 'the W45 slot was missed while the clock jumped: catch_up skip fires nothing');
  assert.equal(waiting.executed, null, 'the review task waits for the W45 value');
  assert.equal(taskStatus(db, reviewTask), 'queued');
  const result = measure(daemon, '2026-W45', 20, 15);
  assert.equal(result.ok, true, JSON.stringify(result));
  clock.set(at(W45_END, 10_000));
  assert.equal((await daemon.worker.tick()).executed?.taskId, reviewTask);
  clock.set(at(W45_END, 20_000));
  assert.deepEqual((await daemon.worker.tick()).validated.map((v) => [v.taskId, v.taskStatus]), [[reviewTask, 'completed']]);
  const reviewEval = db.get<{ id: string; outcome: string; effect: number }>('SELECT id, outcome, effect FROM evaluation WHERE task_id = ?', [reviewTask])!;
  assert.deepEqual([reviewEval.outcome, reviewEval.effect], ['pass', 20]);

  const recorded = await daemon.cycle!.advance();
  assert.deepEqual(recorded.resultFailed, []);
  assert.deepEqual(recorded.resultsRecorded.map((r) => [r.strategyVersionId, r.conclusion, r.recorded, r.rejected]), [[strategyId, 'pass', true, false]]);
  const memory = db.all<{ id: string; kind: string; trust_origin: string; verification_status: string; valid_until: string | null; source_ref: string }>(
    'SELECT * FROM memory_item WHERE strategy_version_id = ? ORDER BY kind', [strategyId],
  );
  assert.deepEqual(memory.map((m) => [m.kind, m.trust_origin, m.verification_status]), [['measurement', 'internal', 'verified'], ['strategy_record', 'internal', 'verified']]);
  const record = memory.find((m) => m.kind === 'strategy_record')!;
  assert.equal(record.source_ref, `evaluation:${reviewEval.id}`);
  assert.equal(record.valid_until, '2026-11-22T15:00:00.000Z', 'the expiry follows memory.default_validity of the policy deployed during step 6');
  // 실험 총비용 = 원장: 실험에 묶인 업무(마케팅 + 검토)의 모든 줄. W45 측정의 사람 시간은 검토 업무에 붙었다
  const experiment = findExperimentResult(db, strategyId)!;
  const ledger = sum(db, 'SELECT sum(amount_usd) AS s FROM cost_entry WHERE task_id IN (SELECT id FROM task WHERE strategy_version_id = ?)', [strategyId]);
  assert.equal(experiment.totalCostUsd, ledger);
  assert.equal(experiment.totalCostUsd, round(costForTask(db, marketing).totalUsd + costForTask(db, reviewTask).totalUsd));
  assert.equal(experiment.humanMinutes, 15);
  assert.equal(strategyStatus(db, strategyId), 'experiment', 'no automatic promotion');

  // 승격: 사람만
  const agentPromote = await cli(['promote', 'strategy', strategyId, '--comment', 'promote'], AGENT);
  assert.equal(agentPromote.code, 1);
  const promoted = await cli(['promote', 'strategy', strategyId, '--comment', 'the week beat the pass line']);
  assert.equal(promoted.code, 0, promoted.stdout + promoted.stderr);
  assert.equal(strategyStatus(db, strategyId), 'active');

  // ===== 다음 주: 슬롯의 기획 업무에 active 전략과 직전 strategy_record 가 붙는다 =====
  clock.set(at(SLOT_2, 5_000));
  const next = await daemon.worker.tick();
  assert.deepEqual(next.routines.fired.map((f) => [f.scheduledFor, f.created]), [[SLOT_2, true]]);
  const week2 = firedPair(db, SLOT_2);
  for (const id of [week2.research, week2.plan]) assert.equal(taskRow(db, id).strategy_version_id, strategyId, 'the active strategy is attached');
  assert.deepEqual(specOf(db, week2.plan).inputs.map((i) => [i.name, i.kind, i.ref]), [
    ['findings', 'task_result', `task:${week2.research}`], ['baseline', 'measurement', `measurement:${SIGNAL_ID}@2026-W45`], ['previous-experiment', 'memory', `memory:${record.id}`],
  ]);
  assert.equal(next.executed?.taskId, week2.research);
  assert.deepEqual(listMeasurementWaits(db).map((w) => w.taskId), [], 'the W45 value is already recorded: the next planning task does not wait');

  // 기록이 만료된 뒤의 주: 기억 입력이 빠진다
  clock.set(at(SLOT_3, 5_000));
  const later = await daemon.worker.tick();
  assert.deepEqual(later.routines.fired.map((f) => f.scheduledFor), [SLOT_3]);
  assert.deepEqual(currentFacts(db, { clock, kind: 'strategy_record' }), []);
  const week3 = firedPair(db, SLOT_3);
  assert.deepEqual(specOf(db, week3.plan).inputs.map((i) => i.name), ['findings', 'baseline'], 'the expired strategy_record is left out of the next input');

  // ===== 비용: 원장 전체 = 업무별 합계 (업무 없는 줄 없음), run 별 합계 = 업무 합계 =====
  const total = sum(db, 'SELECT sum(amount_usd) AS s FROM cost_entry');
  const byTask = db.all<{ id: string }>('SELECT id FROM task').reduce((acc, row) => acc + costForTask(db, row.id).totalUsd, 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM cost_entry WHERE task_id IS NULL'), 0);
  assert.equal(total, round(byTask));
  assert.equal(sum(db, 'SELECT sum(amount_usd) AS s FROM cost_entry WHERE task_run_id IS NOT NULL'), total, 'every dollar of this cycle belongs to a run (human time has no dollar amount)');
  assert.deepEqual(
    db.all<{ category: string }>('SELECT DISTINCT category FROM cost_entry ORDER BY category').map((row) => row.category), ['human_time', 'llm', 'tool'],
  );
});

// ===== 다중 프로세스 (같은 DB 파일): §3 "중복 방지"·"데몬 복구" 를 주간 사이클 맥락에서 =====
type Message = { type: string; [key: string]: unknown };
type TickReport = { routines: { fired: { created: boolean }[] }; recovered: { taskId: string; outcome: string; taskStatus: string }[]; validated: { taskId: string; taskStatus: string }[]; executed: { taskId: string; attempt: number; end: { outcome: string } } | null };

class CycleProcess {
  readonly child: ChildProcess;
  readonly #inbox: Message[] = [];
  readonly #waiters: { type: string; resolve: (m: Message) => void }[] = [];
  readonly #exited: Promise<unknown>;
  readonly id: string;

  constructor(t: TestContext, dbPath: string, dir: string, packDir: string, id: string, mode: 'hang' | 'normal') {
    this.id = id;
    this.child = fork(new URL('./workers/weekly-cycle-daemon.ts', import.meta.url), [dbPath, join(dir, `i-${id}`), packDir, id, mode]);
    this.#exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.on('message', (raw) => {
      const message = raw as Message;
      if (message.type === 'error') throw new Error(`${id}: ${String(message['message'])}`);
      const waiter = this.#waiters.findIndex((w) => w.type === message.type);
      if (waiter >= 0) this.#waiters.splice(waiter, 1)[0]!.resolve(message);
      else this.#inbox.push(message);
    });
    t.after(() => this.kill());
  }

  next(type: string): Promise<Message> {
    const index = this.#inbox.findIndex((m) => m.type === type);
    if (index >= 0) return Promise.resolve(this.#inbox.splice(index, 1)[0]!);
    return new Promise((resolve) => this.#waiters.push({ type, resolve }));
  }

  async tick(now: string): Promise<TickReport> {
    this.child.send({ cmd: 'tick', now: Date.parse(now) });
    return (await this.next('tick'))['report'] as TickReport;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.#exited;
  }
}

async function until(condition: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the weekly cycle across daemon processes sharing one database file', () => {
  it('two daemons tick the same planning slot: one firing (one research and one planning task); the daemon running the research is SIGKILLed and a fresh daemon continues it as a new attempt, once', async (t) => {
    const dir = makeTempDir(t);
    const dbPath = join(dir, 'aot.db');
    const db = openDb({ path: dbPath });
    t.after(() => db.close());
    const clock = new FakeClock(Date.parse(FIRST_SEEN));
    applyMigrations(db, { dir: MIGRATIONS_DIR, clock });
    seedPhaseA(db, { clock });
    addAgent(db, clock, AGENT);
    db.writeTx((tx) => tx.run(
      "INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES ('product-example-product', 'example-product', 'example-product', 'software', 'live', 'registered', ?, ?)",
      [clock.nowIso(), clock.nowIso()],
    ));
    const packDir = cyclePackCopy(dir);
    syncPackRoutines(db, loadPack({ dir: packDir, values: PACK_VALUES }));
    enablePlanningRoutine(db);

    // 두 데몬은 조사 어댑터가 끝나지 않는다(어느 쪽이 집든 그 프로세스를 죽인다). 세 번째 데몬은 정상 어댑터로 이어받는다
    const a = new CycleProcess(t, dbPath, dir, packDir, 'daemon-a', 'hang');
    const b = new CycleProcess(t, dbPath, dir, packDir, 'daemon-b', 'hang');
    const c = new CycleProcess(t, dbPath, dir, packDir, 'daemon-c', 'normal');
    await Promise.all([a.next('ready'), b.next('ready'), c.next('ready')]);
    await Promise.all([a.tick(FIRST_SEEN), b.tick(FIRST_SEEN)]);

    // 같은 슬롯을 동시에 tick
    const slotTick = at(SLOT_1, 5_000);
    const pending = new Map<string, Promise<TickReport>>([[a.id, a.tick(slotTick)], [b.id, b.tick(slotTick)]]);
    const runningRun = () => db.get<{ id: string; lease_owner: string; task_id: string }>('SELECT id, lease_owner, task_id FROM task_run WHERE outcome IS NULL');
    await until(() => runningRun() !== undefined, 'one daemon to claim the research task');
    const first = runningRun()!;
    const [holder, other] = first.lease_owner === a.id ? [a, b] : [b, a];
    const otherReport = await pending.get(other.id)!;
    assert.equal(otherReport.executed, null, 'the other daemon finds nothing to run (research is leased, planning depends on it)');
    assert.equal(count(db, 'SELECT count(*) AS n FROM routine_firing'), 1, 'one firing for the slot');
    assert.equal(count(db, 'SELECT count(*) AS n FROM task'), 2, 'one template run: the research and the planning task, once');
    const week1 = firedPair(db, SLOT_1);
    assert.equal(first.task_id, week1.research);
    assert.equal(taskStatus(db, week1.research), 'running');

    // 실행 중인 데몬을 강제 종료 → lease 만료(90초) 뒤 새 데몬이 인수해 새 attempt 로 실행
    await holder.kill();
    const takeover = await c.tick(at(SLOT_1, 5_000 + 100_000));
    assert.deepEqual(takeover.recovered.map((r) => [r.taskId, r.outcome, r.taskStatus]), [[week1.research, 'lease_expired', 'queued']]);
    assert.equal(takeover.executed?.taskId, week1.research);
    assert.equal(takeover.executed?.end.outcome, 'submitted');
    const runs = db.all<{ id: string; outcome: string; lease_owner: string }>('SELECT id, outcome, lease_owner FROM task_run WHERE task_id = ? ORDER BY started_at, rowid', [week1.research]);
    assert.deepEqual(runs.map((r) => [r.outcome, r.lease_owner]), [['lease_expired', holder.id], ['submitted', c.id]]);
    // 죽은 run 은 결과·근거·비용을 남기지 않았다: 근거와 원장 줄은 새 run 의 것뿐이다
    assert.deepEqual(db.all<{ task_run_id: string }>('SELECT DISTINCT task_run_id FROM evidence WHERE task_id = ?', [week1.research]).map((r) => r.task_run_id), [runs[1]!.id]);
    assert.deepEqual(db.all<{ task_run_id: string }>('SELECT DISTINCT task_run_id FROM cost_entry WHERE task_id = ?', [week1.research]).map((r) => r.task_run_id), [runs[1]!.id]);

    const validated = await c.tick(at(SLOT_1, 5_000 + 110_000));
    assert.deepEqual(validated.validated.map((v) => [v.taskId, v.taskStatus]), [[week1.research, 'completed']]);
    // 살아 있는 다른 데몬도 다시 tick 하지만 같은 슬롯을 다시 발화하지 않는다
    const again = await other.tick(at(SLOT_1, 5_000 + 120_000));
    assert.deepEqual([again.routines.fired, again.executed], [[], null]);
    assert.deepEqual([count(db, 'SELECT count(*) AS n FROM routine_firing'), count(db, 'SELECT count(*) AS n FROM task'), count(db, 'SELECT count(*) AS n FROM task_run')], [1, 2, 2]);
  });
});
