// A6-U11: 업무 간 결과 전달(inputs[kind=task_result])과 업무별 어댑터 선택의 엔진 쪽 규칙.
//  - 선행 결과는 *완료이고 통과 평가(pass, safety pass)가 있는* 업무의 것만 읽는다. 충족되지 않으면 업무는 실행되지 않고 needs_review(시도 소모 없음, run 없음).
//  - task_result 의 선행 업무는 dependencies 에도 있어야 한다(생성 단계가 거부).
//  - 템플릿 안의 task:<name> 은 업무가 만들어질 때 생성된 id 로 바뀌고 dependsOn 에 있어야 한다.
//  - 어댑터는 명세에서 고른 이름이 task_run.adapter 에 남는다. 고를 수 없으면 실행하지 않고 needs_review.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_TASK_RESULT_BYTES, MAX_TASK_RESULT_INPUTS, validateTaskSpec, type Db, type FakeClock } from '@aot/domain';
import {
  claimNextTask, createTask, fireRoutineTasks, resolveUpstream, TaskCreationError, transitionTask, type ClaimedTask, type ClaimOptions,
} from '@aot/task-engine';

import { ALLOW_ALL_GATE, queuedTask, runsOf, taskStatus } from '../support/engine.ts';
import { recordEvaluation, submittedRun, transitionsOf, type SubmittedRun } from '../support/evaluation.ts';
import { minimalDraft } from '../support/spec-fixtures.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const resultInput = (taskId: string, name = 'upstream') => ({ name, ref: `task:${taskId}`, kind: 'task_result' });

/** 선행 업무: 제출 → (평가) → completed. 평가를 주지 않으면 사람이 끝낸 업무처럼 평가 없이 completed */
function predecessor(
  db: Db, clock: FakeClock, id: string,
  options: { evaluation?: { outcome: 'pass' | 'fail' | 'inconclusive'; safety?: 'pass' | 'fail' } | null; result?: unknown; status?: 'completed' | 'validating' } = {},
): SubmittedRun {
  const run = submittedRun(db, clock, { taskId: id, result: options.result ?? { summary: 'upstream summary', claims: [] } });
  if (options.evaluation !== null) recordEvaluation(db, clock, run, options.evaluation ?? { outcome: 'pass' });
  if ((options.status ?? 'completed') === 'completed') {
    db.writeTx((tx) => transitionTask(tx, { taskId: id, from: 'validating', to: 'completed', by: 'validator', reason: 'test: completed', now: clock.nowIso() }));
  }
  return run;
}

/** 후속 업무(선행을 dependencies 와 task_result 입력으로 가진다)를 만들고 claim 한다 */
function claimFollower(db: Db, clock: FakeClock, upstreamIds: string[], extra: Partial<ClaimOptions> = {}, id = 'task-follower') {
  queuedTask(db, clock, { inputs: upstreamIds.map((upstreamId, i) => resultInput(upstreamId, `up-${i + 1}`)), dependencies: upstreamIds }, id);
  const actorId = db.get<{ id: string }>("SELECT id FROM actor WHERE kind = 'agent' LIMIT 1")!.id;
  return claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: 'w2', actorId, adapter: 'default-adapter', leaseMs: 60_000, taskId: id, ...extra });
}

/** 같은 트리거·입력의 활성 업무는 하나로 합쳐지므로(dedupe_key) 업무마다 입력을 다르게 한다 */
const distinct = (n: string): Record<string, unknown> => ({ inputs: [{ name: 'k', ref: `r:${n}`, kind: 'k' }] });

const lastReason = (db: Db, taskId: string): string => transitionsOf(db, taskId).at(-1)!.reason;

test('a completed predecessor with a passing evaluation hands its result to the follower, with the run and evaluation that vouch for it', (t) => {
  const { db, clock } = seededDb(t);
  const up = predecessor(db, clock, 'task-up', { result: { summary: 'quarterly findings', claims: [{ id: 'c1' }] } });
  const claim = claimFollower(db, clock, ['task-up']);
  assert.ok(claim.claimed);
  assert.deepEqual(claim.claimed.upstream, [{
    name: 'up-1', taskId: 'task-up', taskRef: 'task:task-up', runId: up.runId, evaluationId: `eval-${up.runId}`,
    result: { summary: 'quarterly findings', claims: [{ id: 'c1' }] },
  }]);
});

test('the result of the run that was evaluated is used, not a later or other run of the predecessor', (t) => {
  const { db, clock } = seededDb(t);
  const up = predecessor(db, clock, 'task-up', { result: { summary: 'the evaluated run' } });
  // 평가되지 않은 다른 run 이 나중에 더 있었다고 해도 평가가 가리키는 run 의 결과만 읽는다
  db.writeTx((tx) => tx.run(
    `INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, outcome, result)
     SELECT 'run-later', task_id, 2, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, 'submitted', '{"summary":"never evaluated"}' FROM task_run WHERE id = ?`, [up.runId],
  ));
  const claim = claimFollower(db, clock, ['task-up']);
  assert.deepEqual(claim.claimed?.upstream.map((u) => u.result), [{ summary: 'the evaluated run' }]);
});

test('a task without task_result inputs gets an empty upstream and costs nothing extra', (t) => {
  const { db, clock } = seededDb(t);
  addAgent(db, clock);
  queuedTask(db, clock, {}, 'task-plain');
  const claim = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: 'w1', actorId: 'actor-agent-1', adapter: 'a', leaseMs: 60_000, taskId: 'task-plain' });
  assert.deepEqual(claim.claimed?.upstream, []);
});

test('predecessor not completed: the follower is not claimed (dependencies), and resolveUpstream also names it as not completed', (t) => {
  const { db, clock } = seededDb(t);
  predecessor(db, clock, 'task-up', { status: 'validating' });
  const claim = claimFollower(db, clock, ['task-up']);
  assert.equal(claim.claimed, null);
  assert.deepEqual(claim.sentToReview, []);
  assert.equal(taskStatus(db, 'task-follower'), 'queued');
  assert.equal(runsOf(db, 'task-follower').length, 0);
  const resolved = resolveUpstream(db, { inputs: [resultInput('task-up')] });
  assert.equal(resolved.ok, false);
  assert.equal(!resolved.ok && resolved.code, 'upstream_not_completed');
});

const unmetCases: { name: string; code: string; setup: (db: Db, clock: FakeClock) => void }[] = [
  { name: 'completed without any evaluation (finished by a person)', code: 'upstream_not_evaluated', setup: (db, clock) => void predecessor(db, clock, 'task-up', { evaluation: null }) },
  { name: 'completed, but the evaluation was fail', code: 'upstream_not_passed', setup: (db, clock) => void predecessor(db, clock, 'task-up', { evaluation: { outcome: 'fail' } }) },
  { name: 'completed, but the evaluation was inconclusive', code: 'upstream_not_passed', setup: (db, clock) => void predecessor(db, clock, 'task-up', { evaluation: { outcome: 'inconclusive' } }) },
  { name: 'completed, but the evaluation passed with safety=fail', code: 'upstream_not_passed', setup: (db, clock) => void predecessor(db, clock, 'task-up', { evaluation: { outcome: 'pass', safety: 'fail' } }) },
  {
    name: 'a passing evaluation that names no run', code: 'upstream_result_missing',
    setup: (db, clock) => {
      predecessor(db, clock, 'task-up');
      db.writeTx((tx) => tx.run('UPDATE evaluation SET task_run_id = NULL WHERE task_id = ?', ['task-up']));
    },
  },
  { name: 'a result that is not a JSON object', code: 'upstream_result_not_object', setup: (db, clock) => void predecessor(db, clock, 'task-up', { result: ['a', 'list'] }) },
  { name: 'a result over the size limit (never truncated)', code: 'upstream_result_too_large', setup: (db, clock) => void predecessor(db, clock, 'task-up', { result: { text: 'x'.repeat(MAX_TASK_RESULT_BYTES) } }) },
];

for (const unmet of unmetCases) {
  test(`unmet upstream (${unmet.name}): the follower is not run — needs_review with ${unmet.code}, no run, no attempt consumed`, (t) => {
    const { db, clock } = seededDb(t);
    unmet.setup(db, clock);
    const claim = claimFollower(db, clock, ['task-up']);
    assert.equal(claim.claimed, null);
    assert.deepEqual(claim.sentToReview, ['task-follower']);
    assert.equal(taskStatus(db, 'task-follower'), 'needs_review');
    assert.equal(runsOf(db, 'task-follower').length, 0, 'no run was created');
    assert.equal(db.get('SELECT attempts FROM task WHERE id = ?', ['task-follower'])?.['attempts'], 0);
    const last = transitionsOf(db, 'task-follower').at(-1)!;
    assert.deepEqual([last.from_status, last.to_status, last.caused_by], ['queued', 'needs_review', 'system:scheduler']);
    assert.match(last.reason, new RegExp(`^upstream_unmet: ${unmet.code}: input 'up-1'`));
  });
}

test('the newest passing evaluation wins; an older fail does not hide it and a later fail does not revoke a pass', (t) => {
  const { db, clock } = seededDb(t);
  const up = predecessor(db, clock, 'task-up', { evaluation: { outcome: 'fail' } });
  clock.advance(1000);
  db.writeTx((tx) => tx.run(
    `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, safety, evidence_refs, at)
     VALUES ('eval-second', 'task-up', ?, 'task-evaluator@v2', 1, 'pass', '["evidence:x"]', 'pass', '[]', ?)`, [up.runId, clock.nowIso()],
  ));
  assert.equal(claimFollower(db, clock, ['task-up']).claimed?.upstream[0]?.evaluationId, 'eval-second');
});

test('all upstream inputs are needed: one unmet input stops the run and nothing is handed over partially', (t) => {
  const { db, clock } = seededDb(t);
  predecessor(db, clock, 'task-ok');
  predecessor(db, clock, 'task-bad', { evaluation: { outcome: 'fail' } });
  const claim = claimFollower(db, clock, ['task-ok', 'task-bad']);
  assert.equal(claim.claimed, null);
  assert.match(lastReason(db, 'task-follower'), /input 'up-2'.*task-bad/);
});

test('creation: a task_result predecessor must also be a dependency (rejected, not added silently)', (t) => {
  const { db, clock } = seededDb(t);
  predecessor(db, clock, 'task-up');
  const spec = { ...minimalDraft(), role: 'generalist', inputs: [resultInput('task-up')] };
  assert.throws(
    () => createTask(db, { clock, gate: ALLOW_ALL_GATE }, { spec }),
    (error: unknown) => error instanceof TaskCreationError && error.issues.some((i) => i.code === 'upstream_not_a_dependency' && i.path === 'inputs[0].ref'),
  );
  assert.equal(createTask(db, { clock, gate: ALLOW_ALL_GATE }, { spec: { ...spec, dependencies: ['task-up'] } }).created, true);
});

test('spec format: task:<id> refs, unique names and refs, at most 8 task_result inputs; other input kinds are untouched', () => {
  const base = { ...minimalDraft(), dependencies: [] };
  const issuesOf = (inputs: unknown[]) => {
    const checked = validateTaskSpec({ ...base, inputs }, 'draft');
    return checked.ok ? [] : checked.errors.map((e) => `${e.path}:${e.code}`);
  };
  assert.deepEqual(issuesOf([resultInput('task-a')]), []);
  assert.deepEqual(issuesOf([{ name: 'x', ref: 'https://docs.example.com/a', kind: 'task_result' }]), ['inputs[0].ref:format']);
  assert.deepEqual(issuesOf([{ name: 'x', ref: 'task:', kind: 'task_result' }]), ['inputs[0].ref:format']);
  assert.deepEqual(issuesOf([resultInput('task-a', 'one'), resultInput('task-b', 'one')]), ['inputs[1].name:duplicate']);
  assert.deepEqual(issuesOf([resultInput('task-a', 'one'), resultInput('task-a', 'two')]), ['inputs[1].ref:duplicate']);
  const many = Array.from({ length: MAX_TASK_RESULT_INPUTS + 1 }, (_, i) => resultInput(`task-${i}`, `n${i}`));
  assert.deepEqual(issuesOf(many), [`inputs[${MAX_TASK_RESULT_INPUTS}]:too_many`]);
  assert.deepEqual(issuesOf([{ name: 'k', ref: 'task:looks-like-one', kind: 'strategy' }]), [], 'only kind=task_result is interpreted');
});

test('routine template: task:<template task name> becomes the generated task id and needs depends_on; other names are left alone', (t) => {
  const { db, clock } = seededDb(t);
  const task = (name: string, extra: Record<string, unknown> = {}) => ({ ...minimalDraft(), role: 'generalist', objective: `objective ${name}`, ...extra });
  db.writeTx((tx) => tx.run(
    "INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled) VALUES ('r1', 'weekly', ?, '0 9 * * 1 UTC', 'tpl@1', 'skip', 1)",
    [db.get<{ id: string }>('SELECT id FROM org_unit LIMIT 1')!.id],
  ));
  const firing = { routineId: 'r1', scheduledFor: '2026-10-19T09:00:00.000Z' };
  const context = { clock, gate: ALLOW_ALL_GATE };

  const fired = fireRoutineTasks(db, context, firing, [
    { name: 'research', spec: task('research') },
    { name: 'plan', spec: task('plan', { inputs: [{ name: 'findings', ref: 'task:research', kind: 'task_result' }] }), dependsOn: ['research'] },
  ]);
  const [researchId, planId] = fired.taskIds;
  const planSpec = JSON.parse(db.get<{ spec: string }>('SELECT spec FROM task WHERE id = ?', [planId!])!.spec) as { inputs: { ref: string }[]; dependencies: string[] };
  assert.deepEqual(planSpec.inputs.map((i) => i.ref), [`task:${researchId}`]);
  assert.deepEqual(planSpec.dependencies, [researchId]);

  // dependsOn 에 없으면 거부하고 아무것도 만들지 않는다(발화 기록도 남지 않는다)
  assert.throws(
    () => fireRoutineTasks(db, context, { routineId: 'r1', scheduledFor: '2026-10-26T09:00:00.000Z' }, [
      { name: 'research', spec: task('research') },
      { name: 'plan', spec: task('plan', { inputs: [{ name: 'findings', ref: 'task:research', kind: 'task_result' }] }) },
    ]),
    (error: unknown) => error instanceof TaskCreationError && error.issues.some((i) => i.code === 'upstream_not_a_dependency'),
  );
  assert.equal(db.get('SELECT count(*) AS n FROM routine_firing')?.['n'], 1);
});

// ===== 업무별 어댑터 =====

test('adapterFor picks the adapter per task and task_run.adapter records it; null and no selector use the default', (t) => {
  const { db, clock } = seededDb(t);
  addAgent(db, clock);
  queuedTask(db, clock, { objective: 'research things', ...distinct('a') }, 'task-a');
  queuedTask(db, clock, { objective: 'plan things', ...distinct('b') }, 'task-b');
  queuedTask(db, clock, { objective: 'other things', ...distinct('c') }, 'task-c');
  const adapterFor = (spec: { objective: string }): string | null => (spec.objective.startsWith('research') ? 'research-agent' : spec.objective.startsWith('plan') ? 'planner' : null);
  const claim = (taskId: string, withSelector = true): ClaimedTask => {
    const result = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: 'w1', actorId: 'actor-agent-1', adapter: 'default-adapter', leaseMs: 60_000, taskId, ...(withSelector ? { adapterFor } : {}) });
    assert.ok(result.claimed);
    return result.claimed;
  };
  const adapterOf = (taskId: string) => db.get('SELECT adapter FROM task_run WHERE task_id = ?', [taskId])?.['adapter'];
  assert.equal(claim('task-a').adapter, 'research-agent');
  assert.equal(claim('task-b').adapter, 'planner');
  assert.equal(claim('task-c').adapter, 'default-adapter');
  assert.deepEqual(['task-a', 'task-b', 'task-c'].map(adapterOf), ['research-agent', 'planner', 'default-adapter']);

  queuedTask(db, clock, { objective: 'research again', ...distinct('d') }, 'task-d');
  assert.equal(claim('task-d', false).adapter, 'default-adapter', 'without a selector every task uses the default adapter (the previous behaviour)');
});

test('an adapter that cannot be resolved (selector throws or returns a bad name) is never replaced silently: needs_review, no run', (t) => {
  const { db, clock } = seededDb(t);
  addAgent(db, clock);
  const cases: [string, ClaimOptions['adapterFor'], RegExp][] = [
    ['task-throws', () => { throw new Error("adapter 'ghost' is not registered"); }, /^adapter_unresolved: adapter 'ghost' is not registered/],
    ['task-empty', () => '  ', /^adapter_unresolved: .*invalid adapter name/],
    ['task-number', (() => 7) as unknown as ClaimOptions['adapterFor'], /^adapter_unresolved: .*invalid adapter name/],
  ];
  for (const [taskId, adapterFor, reason] of cases) {
    queuedTask(db, clock, distinct(taskId), taskId);
    const claim = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: 'w1', actorId: 'actor-agent-1', adapter: 'default-adapter', leaseMs: 60_000, taskId, adapterFor: adapterFor! });
    assert.equal(claim.claimed, null);
    assert.deepEqual(claim.sentToReview, [taskId]);
    assert.equal(taskStatus(db, taskId), 'needs_review');
    assert.equal(runsOf(db, taskId).length, 0);
    assert.match(lastReason(db, taskId), reason);
  }
});
