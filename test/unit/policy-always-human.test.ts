// 항상 사람이 정하는 결정 (ADR-0016 Decision 5): ALWAYS_HUMAN 은 상수 목록이 아니라 위임의 모든 진입점이 조회하는 분류다.
// 위임 행(mandate_id 가 있는 에이전트 승인)이 DB 에 있어도 항상 사람인 대상에서는 세지 않고, 분류할 수 없는 대상은 사람 전용으로 본다 (fail closed).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALWAYS_HUMAN, approvalStatus, delegationAuthority, humanOnlyKind, taskHumanOnly, UNCLASSIFIED, type ApprovalQuery } from '@aot/policy';

import { approvalsOf, decide, DELEGATE, delegationEnv, draftedFor, hashOf, MANDATE } from '../support/delegation.ts';
import { HOUR, OWNER, type PolicyEnv } from '../support/policy.ts';

const riskyParams = { min_approvers: 1, cooldown: 3600, reauth_before_effect: true, self_approval: true };
const documentOf = (env: PolicyEnv) => env.store.active(env.db)!.policy!.document;
const statusOf = (env: PolicyEnv, kind: ApprovalQuery['kind'], id: string, hash: string) =>
  approvalStatus(env.db, { kind, id, hash, requesterId: null, params: riskyParams, now: env.clock.nowIso(), authority: delegationAuthority(env.db, documentOf(env), env.clock.nowIso()) });

// ===== 분류 =====

test('humanOnlyKind: every always-human name and decision kind is human-only, a task is delegable, everything else is unclassified (fail closed)', () => {
  for (const name of ALWAYS_HUMAN) assert.equal(humanOnlyKind(name), name, name);
  assert.equal(humanOnlyKind('task'), null);
  const expected: Record<string, string> = {
    policy_version: 'policy_deploy', org_proposal: 'org_proposal', strategy_version: 'strategy_version', publication: 'publication', product: 'product_decision',
    effect: 'effect_resolution', delegation: 'delegation_resume',
  };
  for (const [kind, name] of Object.entries(expected)) assert.equal(humanOnlyKind(kind), name, kind);
  for (const unknown of ['tool_call', 'something-new', '', 'TASK', 'constructor', '__proto__', 'toString', undefined, null, 7, {}, ['task']]) {
    assert.equal(humanOnlyKind(unknown), UNCLASSIFIED, JSON.stringify(unknown));
  }
});

// ===== 승인 계산: 위임 행이 있어도 세지 않는다 =====

test('a delegate approval row for a policy deploy, an org change, a strategy or a publication is never counted by the gate, while the same row on a task is', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  const hash = hashOf(env, taskId);
  assert.equal(decide(env, taskId, 'approve').ok, true);
  assert.equal(statusOf(env, 'task', taskId, hash).state, 'cooldown', 'baseline: the delegate row counts on a task');

  for (const kind of ['policy_version', 'org_proposal', 'strategy_version', 'publication'] as const) {
    const id = `${kind}-1`;
    env.db.writeTx((tx) => tx.run(
      'INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at, mandate_id, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [`approval-${kind}`, kind, id, 'approved', hash, DELEGATE, 'forged', env.clock.nowIso(), MANDATE, 'delegate'],
    ));
    const status = statusOf(env, kind, id, hash);
    assert.equal(status.quorumApprovalId, null, `${kind}: the delegate row was not counted`);
    assert.equal(status.mandateId ?? null, null, kind);
    assert.notEqual(status.state, 'cooldown', kind);
    assert.equal(status.ok, false, kind);
  }
});

test('even with a delegate approval row present, a task that became always-human is not counted and not released: delete impact, public scope, external input, a person who decided', async (t) => {
  const mutations: Array<[string, (env: PolicyEnv, taskId: string) => void, string]> = [
    ['delete impact', (env, id) => env.db.writeTx((tx) => tx.run("UPDATE task SET spec = json_insert(spec, '$.allowed_tools[#]', json('{\"tool\":\"cleanup\",\"operations\":[\"remove\"],\"scope\":\"internal\",\"impact\":\"delete\",\"target\":\"files:task-own\"}')) WHERE id = ?", [id])), 'delete_impact'],
    ['public scope', (env, id) => env.db.writeTx((tx) => tx.run("UPDATE task SET spec = json_insert(spec, '$.allowed_tools[#]', json('{\"tool\":\"site\",\"operations\":[\"post\"],\"scope\":\"public\",\"impact\":\"external_effect\"}')) WHERE id = ?", [id])), 'publication'],
    ['external input', (env, id) => env.db.writeTx((tx) => tx.run('UPDATE effect_draft SET influenced_by_external_input = 1 WHERE task_id = ?', [id])), 'external_input_draft'],
    ['a person decided', (env, id) => env.db.writeTx((tx) => tx.run(
      "INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at, mandate_id, via) VALUES ('approval-human', 'task', ?, 'approved', ?, ?, NULL, ?, NULL, 'web')", [id, 'f'.repeat(64), OWNER, env.clock.nowIso()],
    )), 'human_decided_task'],
  ];
  for (const [label, mutate, expectedClass] of mutations) {
    await t.test(label, async (sub) => {
      const env = delegationEnv(sub);
      const { taskId } = await draftedFor(env);
      const hash = hashOf(env, taskId);
      assert.equal(decide(env, taskId, 'approve').ok, true);
      assert.equal(taskHumanOnly(env.db, documentOf(env), taskId), null, 'baseline: delegable');
      mutate(env, taskId);
      assert.equal(taskHumanOnly(env.db, documentOf(env), taskId), expectedClass);
      // 해시를 위임 행의 것으로 맞춰 "낡은 해시라서" 안 세는 길을 막는다: 안 세는 이유는 분류뿐이다
      const status = statusOf(env, 'task', taskId, hash);
      assert.equal(status.mandateId ?? null, null, 'no delegated quorum');
      assert.notEqual(status.state, 'cooldown');
      env.db.writeTx((tx) => tx.run("UPDATE task SET approved_hash = ? WHERE id = ?", [hash, taskId]));
      env.clock.advance(2 * HOUR);
      assert.deepEqual(env.engine.releaseDelegated(), [], 'the daemon cycle does not open it');
      assert.equal(env.db.get<{ status: string }>('SELECT status FROM task WHERE id = ?', [taskId])?.status, 'needs_review');
    });
  }
});

test('taskHumanOnly fails closed: a missing task or an unreadable spec is unclassified', async (t) => {
  const env = delegationEnv(t);
  assert.equal(taskHumanOnly(env.db, documentOf(env), 'no-such-task'), UNCLASSIFIED);
  const { taskId } = await draftedFor(env);
  env.db.writeTx((tx) => tx.run("UPDATE task SET spec = 'not json' WHERE id = ?", [taskId]));
  assert.equal(taskHumanOnly(env.db, documentOf(env), taskId), UNCLASSIFIED);
  env.db.writeTx((tx) => tx.run("UPDATE task SET spec = '{}' WHERE id = ?", [taskId]));
  assert.equal(taskHumanOnly(env.db, documentOf(env), taskId), UNCLASSIFIED);
});

test('delegateDecide refuses a task that turned always-human even if eligibility were to pass (defense in depth), and the person-decided case keeps its own code', async (t) => {
  const env = delegationEnv(t);
  const { taskId } = await draftedFor(env);
  env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash: hashOf(env, taskId) });
  const result = decide(env, taskId, 'approve');
  assert.equal(result.ok, false);
  assert.equal(approvalsOf(env.db, taskId).filter((row) => row.mandate_id !== null).length, 0, 'no delegate row was written');
});
