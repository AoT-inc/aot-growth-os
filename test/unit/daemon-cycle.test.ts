// A6-U14: 데몬의 주간 사이클 4·5단계 부품. 설정 키 `experiment_cycle`, 정책으로 만드는 위험 판정(riskOf 주입), 통과 평가가 없는 기획 업무의 처리,
// 폴링 루프의 `afterTick`(worker tick 뒤에 cycle.advance 를 부르는 자리). 전체 흐름은 통합 시험 daemon-experiment-cycle.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { candidatesFromResult, type ExperimentCandidate } from '@aot/evaluation';
import { PolicyStore } from '@aot/policy';
import { runPolling, transitionTask, type TaskWorker, type TickReport } from '@aot/task-engine';

import { DEFAULT_POLICY_TEMPLATE } from '../../apps/daemon/src/assemble.ts';
import { createExperimentCycle, createPolicyRiskJudge, cycleOptionsFromConfig } from '../../apps/daemon/src/cycle.ts';
import type { PackTemplate } from '../../apps/daemon/src/pack-loader.ts';
import { queuedTask } from '../support/engine.ts';
import { PACK_SIGNAL } from '../support/measurement.ts';
import { customerReadDraft, effectDraft, readOnlyDraft } from '../support/policy.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

test('cycleOptionsFromConfig: no key or null = no cycle (previous behaviour); values are checked at start', () => {
  assert.equal(cycleOptionsFromConfig({}), undefined);
  assert.equal(cycleOptionsFromConfig({ experiment_cycle: null }), undefined);
  assert.deepEqual(cycleOptionsFromConfig({ experiment_cycle: { budget_usd: 5 } }), { budgetUsd: 5 });
  assert.deepEqual(cycleOptionsFromConfig({ experiment_cycle: { budget_usd: 5, min_relative_lift: 0.2, min_absolute_lift: 3 } }), { budgetUsd: 5, minRelativeLift: 0.2, minAbsoluteLift: 3 });
  const bad = (value: unknown, message: RegExp) => assert.throws(() => cycleOptionsFromConfig({ experiment_cycle: value as never }), message);
  bad({}, /budget_usd must be a finite number/);
  bad({ budget_usd: -1 }, /budget_usd must be a finite number >= 0/);
  bad({ budget_usd: '5' }, /budget_usd must be a finite number/);
  bad({ budget_usd: 5, min_relative_lift: Number.NaN }, /min_relative_lift/);
  bad({ budget_usd: 5, enabled: true }, /unknown key\(s\): enabled/);
  bad([], /must be an object/);
});

const asCandidate = (entry: Record<string, unknown>): ExperimentCandidate => {
  const found = candidatesFromResult(JSON.stringify({ candidates: [entry] }));
  if (!found.ok) throw new Error(found.reason);
  return found.items[0]!;
};
const specOf = (draft: Record<string, unknown>) => {
  const copy = { ...draft };
  delete copy['trigger'];
  return copy;
};
const base = { id: 'a', hypothesis: 'h', expected_effect: 20, est_cost_usd: 1, measurement: { signal_id: PACK_SIGNAL.id, period: 'iso_week' } };

test('the policy risk judge: the strictest decision over the candidate task requests, using the deployed policy; unknown template and no policy content are deny', (t) => {
  const { db } = seededDb(t);
  const dir = makeTempDir(t);
  const store = new PolicyStore({ dir: join(dir, 'policies'), templates: [DEFAULT_POLICY_TEMPLATE] });
  const template: PackTemplate = { id: 'landing-copy', version: 1, description: null, tasks: [{ name: 'copy', dependsOn: [], spec: specOf(customerReadDraft()) }] };
  const riskOf = createPolicyRiskJudge({ db, store, templates: [template] });
  const decide = (entry: Record<string, unknown>) => riskOf(asCandidate({ ...base, ...entry }));

  assert.equal(decide({ task_spec: specOf(readOnlyDraft()) }).decision, 'allow');
  assert.match(decide({ task_spec: specOf(readOnlyDraft()) }).reasons.join(' '), /allow by rule internal-read .*\(policy policy-v1\)/);
  assert.equal(decide({ task_spec: specOf(customerReadDraft()) }).decision, 'require_approval');
  assert.equal(decide({ task_spec: specOf(effectDraft()) }).decision, 'require_approval');
  const deleting = decide({ task_spec: specOf(readOnlyDraft({ allowed_tools: [{ tool: 'cms', operations: ['remove'], scope: 'internal', impact: 'delete' }] })) });
  assert.equal(deleting.decision, 'deny');
  assert.match(deleting.reasons.join(' '), /default deny/);
  assert.equal(decide({ task_spec: specOf(readOnlyDraft({ cost_budget: { max_usd: 50 } })) }).decision, 'deny', 'a budget over the policy limit is denied');
  assert.equal(decide({ task_spec: specOf(readOnlyDraft({ allowed_tools: [], cost_budget: { max_usd: 50 } })) }).decision, 'deny', 'also without any tool request');
  assert.equal(decide({ task_template_ref: 'landing-copy@1' }).decision, 'require_approval');
  assert.match(decide({ task_template_ref: 'landing-copy@2' }).reasons.join(' '), /not a template of the loaded pack/);
  assert.equal(decide({ task_template_ref: 'landing-copy@2' }).decision, 'deny');

  const noContent = createPolicyRiskJudge({ db, store: new PolicyStore({ dir: join(dir, 'empty') }), templates: [] });
  assert.deepEqual(noContent(asCandidate({ ...base, task_spec: specOf(readOnlyDraft()) })).decision, 'deny');
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM policy_decision')!.n, 0, 'the judge records no policy decision');
});

test('a planning task completed without a passing evaluation: the comparison is inconclusive, nothing is proposed, a person reviews it', async (t) => {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  const planId = queuedTask(db, clock, { validation: { deterministic: ['experiment_candidates'], llm: null, human: false } });
  const ignored = queuedTask(db, clock, { objective: 'not a planning task', trigger: { kind: 'manual', ref: 'actor:example-other' } });
  db.writeTx((tx) => {
    const now = clock.nowIso();
    for (const id of [planId, ignored]) {
      tx.run(
        `INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, outcome, result)
         VALUES (?, ?, 1, ?, 'fake', ?, ?, 'w0', ?, ?, 'submitted', ?)`,
        [`run-${id}`, id, agent, now, now, now, now, JSON.stringify({ candidates: [] })],
      );
      transitionTask(tx, { taskId: id, from: 'queued', to: 'running', by: 'scheduler', reason: 'test', now });
      transitionTask(tx, { taskId: id, from: 'running', to: 'validating', by: 'scheduler', reason: 'test', now });
      transitionTask(tx, { taskId: id, from: 'validating', to: 'completed', by: 'validator', reason: 'test: finished without an evaluation', now });
    }
  });
  const cycle = createExperimentCycle({ db, clock, options: { budgetUsd: 5 }, signals: [PACK_SIGNAL], riskOf: () => ({ decision: 'allow', reasons: [] }) });
  const report = await cycle.advance();
  assert.deepEqual(report.compared.map((c) => [c.planningTaskId, c.outcome, c.strategyVersionId]), [[planId, 'inconclusive', null]]);
  const [review] = cycle.pendingReviews();
  assert.equal(review?.planningTaskId, planId);
  assert.match(review!.reasons.join(' '), /upstream_not_evaluated/);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM strategy_version')!.n, 0);
  assert.deepEqual(await cycle.advance(), { compared: [], failed: [] });
});

test('runPolling: afterTick runs after every tick; its failure goes to onError and the loop goes on; without it nothing extra runs', async () => {
  const order: string[] = [];
  const errors: unknown[] = [];
  const stop = new AbortController();
  let ticks = 0;
  const worker = {
    tick: () => {
      ticks += 1;
      order.push(`tick${ticks}`);
      return Promise.resolve({ executed: null } as unknown as TickReport);
    },
  } as unknown as TaskWorker;
  await runPolling(worker, {
    pollMs: 1,
    signal: stop.signal,
    sleep: () => {
      if (ticks >= 2) stop.abort();
      return Promise.resolve();
    },
    afterTick: () => {
      order.push(`after${ticks}`);
      return ticks === 1 ? Promise.reject(new Error('cycle failed')) : Promise.resolve();
    },
    onError: (error) => void errors.push(error),
  });
  assert.deepEqual(order, ['tick1', 'after1', 'tick2', 'after2']);
  assert.equal(errors.length, 1);

  const plain: string[] = [];
  const stopPlain = new AbortController();
  await runPolling({ tick: () => { plain.push('tick'); stopPlain.abort(); return Promise.resolve({ executed: null } as unknown as TickReport); } } as unknown as TaskWorker, {
    pollMs: 1, signal: stopPlain.signal, sleep: () => Promise.resolve(),
  });
  assert.deepEqual(plain, ['tick']);
});
