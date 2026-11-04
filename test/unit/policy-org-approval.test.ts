// Phase B / B2: 조직 변경 제안(org_proposal) 승인 — policy 승인 엔진.
//  - 일반 변경: 사람 1인 승인이 같은 트랜잭션에서 proposed → approved. 해시 불일치·에이전트·자기 승인(min_approvers 규칙) 거부
//  - 위험 변경(권한 확대): 대기(cooldown) → 해제 때 TOTP 재인증 → approved. 대기 중 취소 가능
//  - 기준 버전 충돌·만료는 거부가 아니라 superseded/expired 전이로 남는다
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOrgProposal, getOrgProposal, SEED_IDS, type Db, type OrgProposalInput } from '@aot/domain';

import { AGENT, HOUR, OWNER, REVIEWER, policyEnv, type PolicyEnv } from '../support/policy.ts';

function proposalInput(proposedBy: string, tools: Array<{ tool: string; operations: string[] }>, slug: string): OrgProposalInput {
  return {
    proposedBy,
    diff: { ops: [{ op: 'add_role', role: { slug, description: '조사 전담', allowed_tools: tools, unit: 'core' } }] },
    rationale: 'unassigned 업무가 반복됨',
    evidenceRefs: ['task:example'],
    expectedEffect: '처리 시간 단축',
    riskAssessment: { risks: ['품질'], mitigations: ['시험 범위 제한'] },
    evaluationPlan: { min_pass_rate: 0.8, min_observations: 3, max_cost_usd: 5, baseline_window_days: 30, evaluation_days: 14 },
    rollbackPlan: { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: 'generalist' }, running_tasks: 'finish', external_effects: 'human' },
    trialScope: { task_types: ['weekly-market-research'] },
  };
}

const NORMAL_TOOLS = [{ tool: 'web_search', operations: ['search'] }];
const RISKY_TOOLS = [{ tool: 'email_send', operations: ['send'] }];

function propose(env: PolicyEnv, kind: 'normal' | 'risky', by = AGENT, slug = `example-${kind}`): string {
  return env.db.writeTx((tx) => createOrgProposal(tx, env.clock, proposalInput(by, kind === 'normal' ? NORMAL_TOOLS : RISKY_TOOLS, slug))).proposalId;
}
const show = (env: PolicyEnv, id: string, actor = OWNER) => env.send({ cmd: 'show', actor, kind: 'org_proposal', id });
const approve = (env: PolicyEnv, id: string, hash: unknown, actor = OWNER) => env.send({ cmd: 'approve', actor, kind: 'org_proposal', id, hash });
const statusOf = (db: Db, id: string): string => getOrgProposal(db, id)!.status;

test('normal change: one human approval moves proposed → approved in the same transaction (trial is the system\'s next step)', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'normal');
  const shown = show(env, id);
  assert.equal(shown.ok, true);
  assert.equal(shown['change_class'], 'normal');
  assert.match(String(shown['hash']), /^[0-9a-f]{64}$/);
  assert.equal(statusOf(env.db, id), 'proposed');
  const approved = approve(env, id, shown['hash']);
  assert.equal(approved['state'], 'approved');
  assert.equal(statusOf(env.db, id), 'approved');
  assert.equal(env.db.get<{ subject_hash: string }>("SELECT subject_hash FROM approval WHERE subject_kind = 'org_proposal' AND subject_id = ?", [id])!.subject_hash, shown['hash']);
  assert.match(String(approve(env, id, shown['hash'])['error']), /only a proposed change/);
});

test('agents and unknown actors are refused by the approval channel; a stale hash is refused', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'normal');
  const shown = show(env, id);
  assert.match(String(approve(env, id, shown['hash'], AGENT)['error']), /only human actors/);
  assert.match(String(approve(env, id, shown['hash'], 'actor-nobody')['error']), /unknown actor/);
  assert.match(String(approve(env, id, 'f'.repeat(64))['error']), /subject hash mismatch/);
  assert.equal(statusOf(env.db, id), 'proposed');
  assert.equal(env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approval WHERE subject_kind = 'org_proposal'")!.n, 0);
});

test('self-approval follows risky_change.min_approvers (allowed at 1): a human proposer may approve their own proposal only then', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'normal', OWNER);
  assert.equal(approve(env, id, show(env, id)['hash'])['state'], 'approved', 'min_approvers is 1 in the default policy');
});

test('risky change: approval starts a cooldown; release needs the TOTP code after it; cancel during the wait voids the approval', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'risky');
  const shown = show(env, id);
  assert.equal(shown['change_class'], 'risky');
  const approved = approve(env, id, shown['hash']);
  assert.equal(approved['state'], 'cooldown');
  assert.equal(statusOf(env.db, id), 'proposed', 'a risky change waits');
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'org_proposal', id, totp: env.code() })['error']), /cooldown until/);

  env.clock.advance(HOUR);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'org_proposal', id })['error']), /TOTP code is required/);
  assert.equal(statusOf(env.db, id), 'proposed');
  const released = env.send({ cmd: 'release', actor: OWNER, kind: 'org_proposal', id, totp: env.code() });
  assert.equal(released['state'], 'approved');
  assert.equal(statusOf(env.db, id), 'approved');
  const reauth = env.db.all<{ purpose: string }>('SELECT purpose FROM human_reauth').map((row) => ({ ...row }));
  assert.deepEqual(reauth, [{ purpose: `release:org_proposal:${id}:${String(shown['hash'])}` }]);

  const other = propose(env, 'risky', AGENT, 'example-second');
  approve(env, other, show(env, other)['hash']);
  assert.equal(env.send({ cmd: 'cancel', actor: REVIEWER, kind: 'org_proposal', id: other })['state'], 'cancelled');
  env.clock.advance(HOUR);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'org_proposal', id: other, totp: env.code(OWNER, env.clock.nowMs() + 30_000) })['error']), /rejected or cancelled|approval required/);
  assert.equal(statusOf(env.db, other), 'proposed');
});

test('a normal change needs no release', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'normal');
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'org_proposal', id, totp: env.code() })['error']), /only a risky proposal needs a release/);
});

test('reject records the decision and moves the proposal to rejected', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'normal');
  assert.equal(env.send({ cmd: 'reject', actor: OWNER, kind: 'org_proposal', id, comment: 'not now' })['state'], 'rejected');
  assert.equal(statusOf(env.db, id), 'rejected');
  assert.match(String(approve(env, id, show(env, id)['hash'])['error']), /only a proposed change/);
});

test('a base org_version conflict is recorded as superseded (not lost to a rolled-back error), approval is not recorded', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'normal');
  const hash = show(env, id)['hash'];
  env.db.writeTx((tx) => tx.run("UPDATE org_version SET status = 'retired' WHERE id = ?", [SEED_IDS.orgVersion]));
  env.db.writeTx((tx) => tx.run(
    "INSERT INTO org_version (id, parent_id, proposal_id, snapshot, status, created_at) VALUES ('org-version-next', ?, NULL, '{}', 'active', ?)", [SEED_IDS.orgVersion, env.clock.nowIso()],
  ));
  const result = approve(env, id, hash);
  assert.equal(result['state'], 'superseded');
  assert.equal(statusOf(env.db, id), 'superseded');
  assert.equal(env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approval WHERE subject_kind = 'org_proposal'")!.n, 0);
});

test('an expired proposal is recorded as expired when someone tries to approve it', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'normal');
  const hash = show(env, id)['hash'];
  env.clock.advance(15 * 24 * HOUR);
  assert.equal(approve(env, id, hash)['state'], 'expired');
  assert.equal(statusOf(env.db, id), 'expired');
});

test('list shows proposals waiting for a decision', (t) => {
  const env = policyEnv(t);
  const id = propose(env, 'risky');
  const listed = env.send({ cmd: 'list', actor: OWNER });
  assert.deepEqual((listed['org_proposals'] as Array<{ id: string; change_class: string }>).map((row) => ({ id: row.id, change_class: row.change_class })), [{ id, change_class: 'risky' }]);
});
