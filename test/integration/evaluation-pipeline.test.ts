// A4 통합: 데몬 조립(실제 정책 게이트 + 업무 엔진 + 평가기)으로 실행 → 제출 → 검증 → 전이를 끝까지 돈다.
// 외부 접근은 가짜 출처 조회기, 에이전트는 가짜 실행기(비용·증거는 A5 의 데몬이 할 일을 시험 코드가 흉내)다.
// 같은 SQLite 파일을 쓰는 평가와 전이가 tick 사이에서 끊겨도(평가만 기록된 상태) 다음 tick 이 이어받는지도 본다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { createMemoryItem, EVALUATION_SOURCE_PREFIX, MemoryRuleError, SEED_IDS } from '@aot/domain';
import { costForRun, costForTask, evaluateRun, reportCostProgress } from '@aot/evaluation';
import type { RunContext, TaskExecutor } from '@aot/task-engine';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { evaluationsOf, EXAMPLE_URL, FakeFetcher, researchReport, validationSpec } from '../support/evaluation.ts';
import { AGENT, createWithGate, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';

const PAGE = 'The quarterly price is fixed for all plans.';
const CHECKS = ['url_reachable', 'quote_in_source', 'dedupe', 'budget'];

function daemonFor(env: PolicyEnv, fetcher: FakeFetcher, script: (ctx: RunContext) => unknown) {
  const executor: TaskExecutor = { execute: (ctx) => Promise.resolve({ result: script(ctx) }) };
  return assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', executor, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher },
  });
}

/** 에이전트가 원본 증거(출처)와 비용을 남기고 보고서를 낸다 */
function honestRun(env: PolicyEnv, quote: string) {
  return (ctx: RunContext) => {
    env.db.writeTx((tx) => tx.run(
      'INSERT INTO evidence (id, task_id, task_run_id, kind, ref, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
      [`ev-${ctx.lease.runId}`, ctx.taskId, ctx.lease.runId, 'source_url', EXAMPLE_URL, env.clock.nowIso()],
    ));
    reportCostProgress(env.db, env.clock, { taskRunId: ctx.lease.runId, cumulativeUsd: 0.1 * ctx.attempt });
    return researchReport([{ id: 'c1', statement: 'Prices are fixed.', source_url: EXAMPLE_URL, quote }]);
  };
}

const draft = (n: number, extra: Record<string, unknown> = {}) =>
  readOnlyDraft({ ...validationSpec(CHECKS), inputs: [{ name: 'k', ref: `r:${n}`, kind: 'k' }], ...extra });

const statusPath = (env: PolicyEnv, taskId: string): string[] =>
  env.db.all<{ to_status: string }>('SELECT to_status FROM task_transition WHERE task_id = ? ORDER BY id', [taskId]).map((r) => r.to_status);

test('queued -> running -> validating -> completed: original evidence and a clean ledger pass independent evaluation', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(1));
  const daemon = daemonFor(env, new FakeFetcher({ [EXAMPLE_URL]: PAGE }), honestRun(env, 'quarterly price is fixed'));

  const run = await daemon.worker.tick();
  assert.equal(run.executed?.end !== 'lease_lost' && run.executed?.end.taskStatus, 'validating');
  const check = await daemon.worker.tick();
  assert.deepEqual(check.validated.map((v) => v.taskStatus), ['completed']);

  assert.equal(taskStatus(env.db, taskId), 'completed');
  assert.deepEqual(statusPath(env, taskId), ['queued', 'running', 'validating', 'completed']);
  const [evaluation] = env.db.all<{ outcome: string; safety: string; evaluator: string; primary_evidence_refs: string; agent_report_used: number }>('SELECT * FROM evaluation WHERE task_id = ?', [taskId]);
  assert.equal(evaluation?.outcome, 'pass');
  assert.equal(evaluation?.evaluator, 'task-evaluator@v1');
  assert.equal(evaluation?.agent_report_used, 1);
  assert.match(evaluation?.primary_evidence_refs ?? '', /evidence:ev-run-/);
  assert.equal(env.db.get('SELECT verified FROM evidence WHERE task_id = ?', [taskId])?.['verified'], 1);
  assert.equal(costForTask(env.db, taskId).totalUsd, 0.1);
});

test('a report with no original evidence ends in needs_review (inconclusive), and no lesson can be stored from it', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(2, validationSpec(['dedupe'])));
  const fetcher = new FakeFetcher({ [EXAMPLE_URL]: PAGE });
  const daemon = daemonFor(env, fetcher, () => researchReport([{ statement: 'Everything is wonderful.', source_url: EXAMPLE_URL }]));
  await daemon.worker.tick();
  const report = await daemon.worker.tick();

  assert.deepEqual(report.validated.map((v) => v.taskStatus), ['needs_review']);
  assert.equal(taskStatus(env.db, taskId), 'needs_review');
  const evaluation = evaluationsOf(env.db, taskId)[0]!;
  assert.equal(evaluation.outcome, 'inconclusive');
  const last = env.db.get<{ reason: string; caused_by: string }>('SELECT reason, caused_by FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!;
  assert.equal(last.caused_by, 'system:validator');
  assert.match(last.reason, /inconclusive/);
  assert.throws(
    () => env.db.writeTx((tx) => createMemoryItem(tx, {
      kind: 'lesson', body: 'worked well', source_ref: `${EVALUATION_SOURCE_PREFIX}${evaluation.id}`, observed_at: '2026-10-20T00:00:00Z', created_by: SEED_IDS.owner,
    }, { clock: env.clock })),
    (error: unknown) => error instanceof MemoryRuleError && error.code === 'inconclusive_not_learnable',
  );
});

test('criteria not met: retry_wait, then a second attempt (a new run) is evaluated on its own; costs add up per task and stay separate per run', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(3));
  const daemon = daemonFor(env, new FakeFetcher({ [EXAMPLE_URL]: PAGE }), (ctx) => honestRun(env, ctx.attempt === 1 ? 'a quotation that is not in the page' : 'quarterly price is fixed')(ctx));

  await daemon.worker.tick();
  const first = await daemon.worker.tick();
  assert.deepEqual(first.validated.map((v) => v.taskStatus), ['retry_wait']);
  assert.equal(env.db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts'], 1);

  env.clock.advance(10_000);
  await daemon.worker.tick(); // retry_wait -> queued -> running -> validating (attempt 2)
  const second = await daemon.worker.tick();
  assert.deepEqual(second.validated.map((v) => v.taskStatus), ['completed']);

  assert.deepEqual(statusPath(env, taskId), ['queued', 'running', 'validating', 'retry_wait', 'queued', 'running', 'validating', 'completed']);
  assert.deepEqual(evaluationsOf(env.db, taskId).map((e) => e.outcome), ['fail', 'pass']);
  const runs = env.db.all<{ id: string }>('SELECT id FROM task_run WHERE task_id = ? ORDER BY attempt', [taskId]);
  assert.deepEqual(runs.map((r) => costForRun(env.db, r.id).totalUsd), [0.1, 0.2]);
  assert.equal(costForTask(env.db, taskId).totalUsd, 0.3);
});

test('restart between recording the evaluation and the transition: the next tick takes the recorded evaluation and only moves the task', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(4));
  const fetcher = new FakeFetcher({ [EXAMPLE_URL]: PAGE });
  const daemon = daemonFor(env, fetcher, honestRun(env, 'quarterly price is fixed'));
  await daemon.worker.tick();

  // 평가만 기록하고 죽은 데몬을 흉내: 평가는 있고 업무는 아직 validating
  const runId = env.db.get<{ id: string }>('SELECT id FROM task_run WHERE task_id = ?', [taskId])!.id;
  await evaluateRun({ db: env.db, clock: env.clock, fetcher }, { taskId, taskRunId: runId });
  assert.equal(taskStatus(env.db, taskId), 'validating');
  const fetched = fetcher.calls.length;

  const report = await daemon.worker.tick();
  assert.deepEqual(report.validated.map((v) => v.taskStatus), ['completed']);
  assert.equal(evaluationsOf(env.db, taskId).length, 1, 'no duplicate evaluation');
  assert.equal(fetcher.calls.length, fetched, 'the recorded evaluation was reused without fetching again');
});

test('a daemon assembled without evaluation ports leaves validating tasks alone (nothing is auto-completed)', async (t) => {
  const env = policyEnv(t);
  const taskId = createWithGate(env, draft(5));
  const executor: TaskExecutor = { execute: () => Promise.resolve({ result: { claims: [] } }) };
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', executor, timers: manualTimers(),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
  });
  await daemon.worker.tick();
  const report = await daemon.worker.tick();
  assert.deepEqual(report.validated, []);
  assert.equal(taskStatus(env.db, taskId), 'validating');
});
