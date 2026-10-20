// 필수 테스트 "비용: 모델 호출·도구 사용 비용을 업무·실행별로 집계" (phase-a.md §3, A4)
//  - 가짜 어댑터가 보고한 비용이 task·task_run 단위로 합산된다.
//  - 실행 중 cost_progress 로 누적 비용을 기록하고, 예산을 넘으면 종료를 기다리지 않고 취소 신호를 판정한다 (실제 취소는 A5).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock, type Db } from '@aot/domain';
import {
  costForProduct, costForRun, costForTask, CostRecordError, evaluateBudget, recordCost, reportCostProgress, summarizeCosts,
} from '@aot/evaluation';
import { claimNextTask, failRun, promoteDueRetries } from '@aot/task-engine';

import { ALLOW_ALL_GATE, queuedTask } from '../support/engine.ts';
import { createFakeAdapter } from '../support/fake-adapter.ts';
import { addProduct } from '../support/evaluation.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const LEASE_MS = 60_000;

function setup(t: Parameters<typeof seededDb>[0]) {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  const claim = (taskId: string) => {
    const result = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: 'w1', actorId, adapter: 'fake-adapter', leaseMs: LEASE_MS, taskId });
    assert.ok(result.claimed);
    return result.claimed.lease;
  };
  return { db, clock, actorId, claim };
}

const entries = (db: Db, taskId: string) =>
  db.all<{ task_run_id: string; amount_usd: number; category: string }>('SELECT task_run_id, amount_usd, category FROM cost_entry WHERE task_id = ? ORDER BY at, id', [taskId]);

/** 가짜 어댑터를 돌려 보고한 진행 비용과 최종 비용을 원장에 기록한다 (A5 의 데몬이 할 일을 흉내) */
function runAdapter(db: Db, clock: FakeClock, runId: string, costSteps: number[]) {
  const adapter = createFakeAdapter(clock, { costSteps });
  const output = adapter.run({ taskSpec: {}, allowedTools: [], evidenceRefs: [], budgetUsd: 1 });
  const results = output.costProgress.map((cumulativeUsd) => reportCostProgress(db, clock, { taskRunId: runId, cumulativeUsd }));
  results.push(reportCostProgress(db, clock, { taskRunId: runId, cumulativeUsd: output.cost.amount }));
  return results;
}

test('cost: costs reported by the fake adapter are summed per task and per task_run', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, {}, 'task-cost');
  const first = claim(taskId);
  runAdapter(db, clock, first.runId, [0.01, 0.03]);
  // 첫 시도가 오류로 끝나고 재시도에서 두 번째 run 이 같은 업무에 비용을 더한다
  failRun(db, clock, first, { outcome: 'error', reason: 'boom', retryDelayMs: 1000 });
  clock.advance(1000);
  promoteDueRetries(db, clock);
  const second = claim(taskId);
  runAdapter(db, clock, second.runId, [0.2, 0.25]);

  assert.equal(costForRun(db, first.runId).totalUsd, 0.03);
  assert.equal(costForRun(db, second.runId).totalUsd, 0.25);
  const task = costForTask(db, taskId);
  assert.equal(task.totalUsd, 0.28);
  assert.equal(task.entries, 4); // 진행 보고의 차액만 쌓인다: 0.01, 0.02 / 0.2, 0.05 (최종 보고는 차액 0 이라 줄이 없다)
  assert.deepEqual(entries(db, taskId).map((e) => e.task_run_id), [first.runId, first.runId, second.runId, second.runId]);
  assert.equal(task.byCategory.llm, 0.28);
});

test('cost: reporting the same cumulative cost again does not count it twice; a lower cumulative cost is refused', (t) => {
  const { db, clock, claim } = setup(t);
  const lease = claim(queuedTask(db, clock));
  const a = reportCostProgress(db, clock, { taskRunId: lease.runId, cumulativeUsd: 0.1 });
  assert.equal(a.recorded?.amount_usd, 0.1);
  const again = reportCostProgress(db, clock, { taskRunId: lease.runId, cumulativeUsd: 0.1 });
  assert.equal(again.recorded, null);
  assert.equal(again.spent.totalUsd, 0.1);
  assert.throws(() => reportCostProgress(db, clock, { taskRunId: lease.runId, cumulativeUsd: 0.05 }), CostRecordError);
  assert.throws(() => reportCostProgress(db, clock, { taskRunId: 'run-missing', cumulativeUsd: 1 }), CostRecordError);
  assert.equal(costForRun(db, lease.runId).totalUsd, 0.1);
});

test('cost: tool, infra and human-time entries are summed by category with tokens and human minutes; product totals follow the task', (t) => {
  const { db, clock, claim } = setup(t);
  addProduct(db, clock);
  const taskId = queuedTask(db, clock, { product: 'example-product' }, 'task-product');
  const other = queuedTask(db, clock, { inputs: [{ name: 'x', ref: 'r:x', kind: 'k' }] }, 'task-no-product');
  const lease = claim(taskId);
  const at = clock.nowIso();
  db.writeTx((tx) => {
    recordCost(tx, clock, { taskId, taskRunId: lease.runId, category: 'llm', amountUsd: 0.5, units: { tokens: 1000, source: 'adapter' } });
    recordCost(tx, clock, { taskId, taskRunId: lease.runId, category: 'tool', amountUsd: 0.25 });
    recordCost(tx, clock, { taskId, taskRunId: null, category: 'human_time', amountUsd: 2, units: { minutes: 12 } });
    recordCost(tx, clock, { taskId: other, taskRunId: null, category: 'infra', amountUsd: 9 });
  });
  const summary = costForTask(db, taskId);
  assert.deepEqual(
    { total: summary.totalUsd, llm: summary.byCategory.llm, tool: summary.byCategory.tool, human: summary.byCategory.human_time, tokens: summary.tokens, minutes: summary.humanMinutes },
    { total: 2.75, llm: 0.5, tool: 0.25, human: 2, tokens: 1000, minutes: 12 },
  );
  assert.equal(costForRun(db, lease.runId).totalUsd, 0.75);
  assert.equal(costForProduct(db, 'p-example-product').totalUsd, 2.75, 'a product total only counts entries of its own tasks');
  assert.equal(costForProduct(db, 'p-example-product', { from: new Date(Date.parse(at) + 1).toISOString() }).totalUsd, 0, 'range filter');
  assert.equal(costForTask(db, other).totalUsd, 9);
});

test('cost: the ledger is append-only and rejects bad entries', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock);
  const lease = claim(taskId);
  const row = db.writeTx((tx) => recordCost(tx, clock, { taskId, taskRunId: lease.runId, category: 'llm', amountUsd: 1 }));
  assert.throws(() => db.writeTx((tx) => tx.run('UPDATE cost_entry SET amount_usd = 0 WHERE id = ?', [row.id])), /append-only/);
  assert.throws(() => db.writeTx((tx) => tx.run('DELETE FROM cost_entry WHERE id = ?', [row.id])), /append-only/);
  for (const amountUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => db.writeTx((tx) => recordCost(tx, clock, { taskId, taskRunId: null, category: 'llm', amountUsd })), CostRecordError);
  }
  assert.throws(() => db.writeTx((tx) => recordCost(tx, clock, { taskId: null, taskRunId: lease.runId, category: 'nope' as 'llm', amountUsd: 1 })), CostRecordError);
  const otherTask = queuedTask(db, clock, { inputs: [{ name: 'y', ref: 'r:y', kind: 'k' }] });
  assert.throws(() => db.writeTx((tx) => recordCost(tx, clock, { taskId: otherTask, taskRunId: lease.runId, category: 'llm', amountUsd: 1 })), /another task/);
  assert.throws(() => recordCost(db, clock, { taskId, taskRunId: null, category: 'llm', amountUsd: 1 }), /write transaction/i, 'writes only inside Db.writeTx');
});

test('cost_progress: exceeding the budget while running yields a cancel signal with a reason, without waiting for the run to end', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, { cost_budget: { max_usd: 0.1 } });
  const lease = claim(taskId);
  const within = reportCostProgress(db, clock, { taskRunId: lease.runId, cumulativeUsd: 0.1 });
  assert.equal(within.cancel, null, 'equal to the budget is not over it');
  const over = reportCostProgress(db, clock, { taskRunId: lease.runId, cumulativeUsd: 0.12 });
  assert.equal(over.cancel?.reason, 'budget_usd_exceeded');
  assert.match(over.cancel?.detail ?? '', /0\.12 USD exceeds the budget 0\.1 USD/);
  assert.equal(over.limits.maxUsd, 0.1);
  // run 은 아직 끝나지 않았다 (취소 실행은 A5): 판정만 돌려준다
  assert.equal(db.get('SELECT outcome FROM task_run WHERE id = ?', [lease.runId])?.['outcome'], null);
});

test('cost_progress: the budget is per task, so an earlier attempt\'s spending counts; a token limit cancels too', (t) => {
  const { db, clock, claim } = setup(t);
  const taskId = queuedTask(db, clock, { cost_budget: { max_usd: 1, max_tokens: 500 } });
  const first = claim(taskId);
  reportCostProgress(db, clock, { taskRunId: first.runId, cumulativeUsd: 0.9 });
  failRun(db, clock, first, { outcome: 'error', reason: 'boom', retryDelayMs: 1000 });
  clock.advance(1000);
  promoteDueRetries(db, clock);
  const second = claim(taskId);
  const cross = reportCostProgress(db, clock, { taskRunId: second.runId, cumulativeUsd: 0.2 });
  assert.equal(cross.spent.totalUsd, 1.1);
  assert.equal(cross.cancel?.reason, 'budget_usd_exceeded');

  const tokens = reportCostProgress(db, clock, { taskRunId: first.runId, cumulativeUsd: 0.9, cumulativeTokens: 600 });
  assert.equal(tokens.recorded?.amount_usd, 0, 'tokens only: a zero-dollar entry carries the units');
  assert.equal(tokens.spent.tokens, 600);
  assert.ok(tokens.cancel !== null);
});

test('evaluateBudget is pure: USD first, then tokens; no limit means no token cancel', () => {
  const spent = { totalUsd: 2, tokens: 10 };
  assert.equal(evaluateBudget(spent, { maxUsd: 2 }), null);
  assert.equal(evaluateBudget(spent, { maxUsd: 1.99 })?.reason, 'budget_usd_exceeded');
  assert.equal(evaluateBudget(spent, { maxUsd: 5, maxTokens: 9 })?.reason, 'budget_tokens_exceeded');
  assert.equal(evaluateBudget(spent, { maxUsd: 5, maxTokens: 10 }), null);
  assert.equal(evaluateBudget({ totalUsd: 9, tokens: 1e9 }, { maxUsd: 100, maxTokens: undefined }), null);
  assert.equal(summarizeCosts([]).totalUsd, 0);
});
