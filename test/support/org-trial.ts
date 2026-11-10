// Phase B 시험 보조: 시드 DB 에 조직 제안을 만들고 승인 → 시험(trial)까지 올린다. 시험 업무·평가·비용 행을 직접 심는다.
import { createOrgProposal, getOrgProposal, SEED_IDS, transitionOrgProposal, type Db, type FakeClock, type OrgProposalRow } from '@aot/domain';
import { createTask } from '@aot/task-engine';

import { ALLOW_ALL_GATE } from './engine.ts';
import { minimalDraft } from './spec-fixtures.ts';
import { addAgent, seededDb } from './seeded-db.ts';

export const DAY = 86_400_000;
export const TYPE = 'weekly-market-research';
export const PLAN = { min_pass_rate: 0.6, min_observations: 3, max_cost_usd: 5, baseline_window_days: 30, evaluation_days: 14 };

export interface TrialEnv {
  db: Db;
  clock: FakeClock;
  agent: string;
  proposalId: string;
  proposal(): OrgProposalRow;
  /** 시험 역할(example-researcher)에 업무를 만든다. status 를 바꾸고 평가·비용을 심는다 */
  task(options?: { status?: 'queued' | 'completed' | 'failed' | 'cancelled'; outcome?: 'pass' | 'fail' | 'inconclusive'; safety?: 'pass' | 'fail'; cost?: number; type?: string; role?: string }): string;
}

let counter = 0;

export function proposeAndStartTrial(t: { after(fn: () => void): void }, options: { plan?: Record<string, unknown>; before?: (env: { db: Db; clock: FakeClock; agent: string }) => void } = {}): TrialEnv {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  options.before?.({ db, clock, agent });
  const { proposalId } = db.writeTx((tx) => createOrgProposal(tx, clock, {
    proposedBy: agent,
    diff: { ops: [{ op: 'add_role', role: { slug: 'example-researcher', description: '조사 전담', allowed_tools: [{ tool: 'web_search', operations: ['search'] }], unit: 'core' } }] },
    rationale: 'r', evidenceRefs: ['task:x'], expectedEffect: 'e',
    riskAssessment: { risks: ['a'], mitigations: ['b'] },
    evaluationPlan: { ...PLAN, ...options.plan },
    rollbackPlan: { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: 'generalist' }, running_tasks: 'finish', external_effects: 'human' },
    trialScope: { task_types: [TYPE] },
  }));
  db.writeTx((tx) => {
    tx.run("INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES (?, 'org_proposal', ?, 'approved', NULL, ?, NULL, ?)", [`approval-${proposalId}`, proposalId, SEED_IDS.owner, clock.nowIso()]);
    transitionOrgProposal(tx, clock, { proposalId, to: 'approved', by: 'human', actorId: SEED_IDS.owner, approvalId: `approval-${proposalId}` });
    transitionOrgProposal(tx, clock, { proposalId, to: 'trial', by: 'system' });
  });
  return {
    db, clock, agent, proposalId, proposal: () => getOrgProposal(db, proposalId)!,
    task: (o = {}) => seedTask(db, clock, { role: 'example-researcher', ...o }),
  };
}

export function seedTask(db: Db, clock: FakeClock, o: { status?: string; outcome?: string; safety?: string; cost?: number; type?: string; role?: string } = {}): string {
  counter += 1;
  const created = createTask(db, { clock, gate: ALLOW_ALL_GATE }, {
    spec: { ...minimalDraft(), trigger: { kind: 'routine', ref: `${o.type ?? TYPE}@2026-W${counter}` }, ...(o.role === undefined ? {} : { role: o.role }) },
  });
  const status = o.status ?? 'queued';
  db.writeTx((tx) => {
    if (status !== 'queued') tx.run('UPDATE task SET status = ? WHERE id = ?', [status, created.taskId]);
    if (o.outcome !== undefined) {
      tx.run(
        `INSERT INTO evaluation (id, task_id, task_run_id, evaluator, validation_passed, outcome, primary_evidence_refs, agent_report_used, safety, evidence_refs, at)
         VALUES (?, ?, NULL, 'test-evaluator@1', 1, ?, '[]', 0, ?, '[]', ?)`,
        [`evaluation-${created.taskId}`, created.taskId, o.outcome, o.safety ?? 'pass', clock.nowIso()],
      );
    }
    if (o.cost !== undefined) tx.run("INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES (?, ?, NULL, NULL, 'llm', ?, NULL, ?)", [`cost-${created.taskId}`, created.taskId, o.cost, clock.nowIso()]);
  });
  return created.taskId;
}
