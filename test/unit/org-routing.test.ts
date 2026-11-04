// Phase B / B3: 시험 역할의 업무 범위와 unassigned 업무 배정.
//  - trial 역할은 trial_scope.task_types 의 업무 유형만 받는다(생성 시 지정 거부), 시드 역할은 자동 배정 대상이 아니다
//  - routeUnassignedTasks: 범위 안 unassigned 업무만 queued 로 배정(역할·버전·부서 기록), 범위 밖은 그대로
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOrgProposal, SEED_IDS, transitionOrgProposal, type Db, type FakeClock } from '@aot/domain';
import { createTask, routeUnassignedTasks, TaskCreationError } from '@aot/task-engine';

import { ALLOW_ALL_GATE } from '../support/engine.ts';
import { minimalDraft } from '../support/spec-fixtures.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const ctx = (clock: FakeClock) => ({ clock, gate: ALLOW_ALL_GATE });
const routineDraft = (ref: string, extra: Record<string, unknown> = {}) => ({ ...minimalDraft(), trigger: { kind: 'routine', ref }, ...extra });

function trialRole(t: { after(fn: () => void): void }, taskTypes = ['weekly-market-research']) {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  const { proposalId } = db.writeTx((tx) => createOrgProposal(tx, clock, {
    proposedBy: agent,
    diff: { ops: [{ op: 'add_role', role: { slug: 'example-researcher', description: '조사', allowed_tools: [{ tool: 'web_search', operations: ['search'] }], unit: 'core' } }] },
    rationale: 'r', evidenceRefs: ['task:x'], expectedEffect: 'e',
    riskAssessment: { risks: ['a'], mitigations: ['b'] },
    evaluationPlan: { min_pass_rate: 0.8, min_observations: 3, max_cost_usd: 5, baseline_window_days: 30, evaluation_days: 14 },
    rollbackPlan: { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: 'generalist' }, running_tasks: 'finish', external_effects: 'human' },
    trialScope: { task_types: taskTypes },
  }));
  db.writeTx((tx) => {
    tx.run("INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES ('approval-1', 'org_proposal', ?, 'approved', NULL, ?, NULL, ?)", [proposalId, SEED_IDS.owner, clock.nowIso()]);
    transitionOrgProposal(tx, clock, { proposalId, to: 'approved', by: 'human', actorId: SEED_IDS.owner, approvalId: 'approval-1' });
    transitionOrgProposal(tx, clock, { proposalId, to: 'trial', by: 'system' });
  });
  return { db, clock };
}

test('a trial role receives only the task types of its trial scope (creation with an explicit role)', (t) => {
  const { db, clock } = trialRole(t);
  const inScope = createTask(db, ctx(clock), { spec: routineDraft('weekly-market-research@2026-W44', { role: 'example-researcher' }) });
  assert.equal(inScope.status, 'queued');
  assert.throws(
    () => createTask(db, ctx(clock), { spec: routineDraft('weekly-experiment-planning@2026-W44', { role: 'example-researcher' }) }),
    (error: unknown) => error instanceof TaskCreationError && error.issues.some((issue) => issue.code === 'out_of_trial_scope'),
  );
  assert.throws(
    () => createTask(db, ctx(clock), { spec: { ...minimalDraft(), role: 'example-researcher' } }),
    (error: unknown) => error instanceof TaskCreationError && error.issues.some((issue) => issue.code === 'out_of_trial_scope'),
    'a manual task is a different type',
  );
});

test('unassigned tasks of the trial scope are routed to the trial role; others stay unassigned (the reorganization signal)', (t) => {
  const { db, clock } = trialRole(t);
  const inScope = createTask(db, ctx(clock), { spec: routineDraft('weekly-market-research@2026-W44') });
  const other = createTask(db, ctx(clock), { spec: routineDraft('weekly-experiment-planning@2026-W44') });
  const manual = createTask(db, ctx(clock), { spec: minimalDraft() });
  assert.deepEqual([inScope.status, other.status, manual.status], ['unassigned', 'unassigned', 'unassigned']);

  const routed = db.writeTx((tx) => routeUnassignedTasks(tx, clock));
  assert.deepEqual(routed, [{ taskId: inScope.taskId, role: 'example-researcher', taskType: 'weekly-market-research' }]);
  const row = db.get<{ status: string; role_id: string; role_version: number; org_unit_id: string; spec: string }>('SELECT status, role_id, role_version, org_unit_id, spec FROM task WHERE id = ?', [inScope.taskId])!;
  assert.equal(row.status, 'queued');
  assert.equal(row.role_id, db.get<{ id: string }>("SELECT id FROM role WHERE slug = 'example-researcher'")!.id);
  assert.equal(row.role_version, 1);
  assert.equal(JSON.parse(row.spec).role, 'example-researcher');
  assert.equal(JSON.parse(row.spec).versions.role_version, 1);
  const statusOf = (id: string) => db.get<{ status: string }>('SELECT status FROM task WHERE id = ?', [id])!.status;
  assert.equal(statusOf(other.taskId), 'unassigned');
  assert.equal(statusOf(manual.taskId), 'unassigned');
  const transition = db.get<{ from_status: string; to_status: string; caused_by: string }>('SELECT from_status, to_status, caused_by FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [inScope.taskId])!;
  assert.deepEqual({ ...transition }, { from_status: 'unassigned', to_status: 'queued', caused_by: 'system:org-routing' });
  assert.deepEqual(db.writeTx((tx) => routeUnassignedTasks(tx, clock)), [], 'nothing left to route');
});

test('seed roles are never auto-assigned, and a retired role takes nothing', (t) => {
  const { db, clock } = trialRole(t, ['manual']);
  db.writeTx((tx) => tx.run("UPDATE role SET lifecycle = 'retired' WHERE slug = 'example-researcher'"));
  const manual = createTask(db, ctx(clock), { spec: minimalDraft() });
  assert.deepEqual(db.writeTx((tx) => routeUnassignedTasks(tx, clock)), []);
  assert.equal(db.get<{ status: string }>('SELECT status FROM task WHERE id = ?', [manual.taskId])!.status, 'unassigned');
  void (db as Db);
});
