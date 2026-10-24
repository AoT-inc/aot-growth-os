// A6-U15 통합: 주간 사이클 6단계를 데몬 조립(실제 정책 게이트·승인 엔진·업무 엔진·평가기·사이클)에서 가짜 어댑터로 돌린다.
//   조사 → 기획 → 제안(proposed, U14) → 사람이 승인 채널로 승인(같은 트랜잭션에서 experiment) → 다음 advance 가 한 번만 활성화(일회성 마케팅 업무 생성)
//   - 에이전트의 승인 시도는 채널 인증 단계에서 거부
//   - 승인 직후 데몬을 새로 조립(재시작)해도 활성화는 정확히 1회
//   - 승인 뒤 정책이 강화되면 마케팅 업무는 실행 직전 새 정책으로 재판정되어 거부(활성화 전에 강화되면 생성 게이트가 거부)
//   - 마케팅 업무의 외부 부작용은 실험 승인이 대신하지 않는다(업무 승인의 위험 변경 절차)
//   - 진행 중 두 번째 승인 거부, 활성화 전 취소, 승인 뒤 내용 변경이면 활성화 거부
// 다중 프로세스(같은 DB 파일, 승인 직후 SIGKILL, 두 데몬 동시 advance)는 experiment-activation-multiprocess.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Db } from '@aot/domain';

import { taskStatus } from '../support/engine.ts';
import { candidate, marketingSpec, rig, runCycle, type CycleDaemon } from '../support/experiment-cycle.ts';
import { AGENT, deployDirect, OWNER, policyEnv, withExtraRule, type PolicyEnv } from '../support/policy.ts';

const activationEvents = (db: Db) => Number(db.get<{ n: number }>("SELECT count(*) AS n FROM event WHERE type = 'experiment.activated'")!.n);
const experimentTasks = (db: Db, id: string) => db.all<{ id: string; status: string }>('SELECT id, status FROM task WHERE strategy_version_id = ? ORDER BY created_at, rowid', [id]).map((row) => ({ ...row }));
const statusOf = (db: Db, id: string) => String(db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [id])!.status);
const lastReason = (db: Db, taskId: string) => String(db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!.reason);

/** 조사 → 기획 → advance 로 제안 1건. 전략 id */
async function propose(env: PolicyEnv, daemon: CycleDaemon, key = 'r:1'): Promise<string> {
  await runCycle(env, daemon, key);
  const report = await daemon.cycle!.advance();
  const id = report.compared[0]?.strategyVersionId;
  assert.ok(id, JSON.stringify(report));
  return id;
}

function approveStrategy(daemon: CycleDaemon, id: string, actor = OWNER): { ok: boolean; state?: string; error?: string } {
  const shown = daemon.handleChannelRequest({ cmd: 'show', actor, kind: 'strategy_version', id }) as { ok: boolean; hash?: string; error?: string };
  if (!shown.ok) return shown;
  return daemon.handleChannelRequest({ cmd: 'approve', actor, kind: 'strategy_version', id, hash: shown.hash }) as { ok: boolean; state?: string; error?: string };
}

test('approval moves the strategy to experiment; after a restart the next advance activates it exactly once and the one-off task carries the strategy', async (t) => {
  const env = policyEnv(t);
  const daemon = rig(env, [candidate('copy-test', marketingSpec())]);
  const id = await propose(env, daemon);

  // 에이전트: 승인 채널의 인증 단계에서 거부 (해시를 알아도)
  const hash = (daemon.handleChannelRequest({ cmd: 'show', actor: OWNER, kind: 'strategy_version', id }) as { hash: string }).hash;
  const byAgent = daemon.handleChannelRequest({ cmd: 'approve', actor: AGENT, kind: 'strategy_version', id, hash }) as { ok: boolean; error: string };
  assert.equal(byAgent.ok, false);
  assert.match(byAgent.error, /only human actors/);
  assert.equal(statusOf(env.db, id), 'proposed');

  const approved = approveStrategy(daemon, id);
  assert.deepEqual([approved.ok, approved.state], [true, 'experiment']);
  assert.equal(statusOf(env.db, id), 'experiment');
  assert.equal(activationEvents(env.db), 0, 'the approval transaction does not activate');

  // 승인 직후 데몬이 멈췄다고 보고 새로 조립한다 (같은 DB, 새 사이클·워커)
  const restarted = rig(env, [candidate('copy-test', marketingSpec())]);
  const report = await restarted.cycle!.advance();
  assert.deepEqual(report.activationFailed, []);
  assert.deepEqual(report.activated.map((a) => [a.strategyVersionId, a.activated, a.routineIds, a.taskIds.length]), [[id, true, [], 1]]);
  for (const cycle of [restarted.cycle!, daemon.cycle!, restarted.cycle!]) assert.deepEqual((await cycle.advance()).activated, []);
  assert.equal(activationEvents(env.db), 1);
  const [task] = experimentTasks(env.db, id);
  assert.deepEqual(experimentTasks(env.db, id), [{ id: task!.id, status: 'queued' }]);

  assert.equal((await restarted.worker.tick()).executed?.taskId, task!.id);
  const listed = restarted.handleChannelRequest({ cmd: 'list', actor: OWNER }) as { experiments: { id: string; activated_at: string | null }[]; strategy_proposals: unknown[] };
  assert.deepEqual(listed.experiments, [{ id, activated_at: env.clock.nowIso() }]);
  assert.deepEqual(listed.strategy_proposals, []);
});

test('a policy tightened after the approval refuses the marketing task: right before it runs, or already at creation if activation comes later', async (t) => {
  const deny = withExtraRule('{id: no-web-search, action: ["web_search.*"], decision: deny}');
  await t.test('tightened after activation -> re-judged before running -> needs_review', async (t) => {
    const env = policyEnv(t);
    const daemon = rig(env, [candidate('copy-test', marketingSpec())]);
    const id = await propose(env, daemon);
    approveStrategy(daemon, id);
    const [taskId] = (await daemon.cycle!.advance()).activated[0]!.taskIds;
    deployDirect(env, deny);
    const tick = await daemon.worker.tick();
    assert.equal(tick.executed, null);
    assert.deepEqual(tick.sentToReview, [taskId]);
    assert.equal(taskStatus(env.db, taskId!), 'needs_review');
    assert.match(lastReason(env.db, taskId!), /denied by the current policy/);
  });
  await t.test('tightened between approval and activation -> the creation gate refuses the task, nothing is activated', async (t) => {
    const env = policyEnv(t);
    const daemon = rig(env, [candidate('copy-test', marketingSpec())]);
    const id = await propose(env, daemon);
    approveStrategy(daemon, id);
    deployDirect(env, deny);
    const report = await daemon.cycle!.advance();
    assert.deepEqual(report.activated, []);
    assert.deepEqual(report.activationFailed.map((f) => [f.strategyVersionId, f.code]), [[id, 'task_refused']]);
    assert.match(report.activationFailed[0]!.error, /no-web-search|denied by policy/);
    assert.deepEqual((await daemon.cycle!.advance()).activationFailed, [], 'a deterministic refusal is reported once per process');
    assert.deepEqual([activationEvents(env.db), experimentTasks(env.db, id).length, statusOf(env.db, id)], [0, 0, 'experiment']);
  });
});

test('the experiment approval does not approve an external effect: the marketing task still goes through the risky-change approval', async (t) => {
  const env = policyEnv(t);
  const effectSpec = marketingSpec({
    allowed_tools: [
      { tool: 'web_search', operations: ['search'], scope: 'internal', impact: 'read' },
      { tool: 'notify-tool', operations: ['send'], scope: 'customer', impact: 'external_effect', target: 'mailbox:example' },
    ],
  });
  const daemon = rig(env, [candidate('notify-test', effectSpec)]);
  const id = await propose(env, daemon);
  assert.equal(approveStrategy(daemon, id).state, 'experiment');
  const [taskId] = (await daemon.cycle!.advance()).activated[0]!.taskIds;
  const tick = await daemon.worker.tick();
  assert.equal(tick.executed, null);
  assert.deepEqual(tick.sentToReview, [taskId]);
  assert.match(lastReason(env.db, taskId!), /approval required/);
  const shown = daemon.handleChannelRequest({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId }) as { hash: string };
  const taskApproval = daemon.handleChannelRequest({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash: shown.hash }) as { state: string };
  assert.equal(taskApproval.state, 'cooldown', 'the task follows the risky_change procedure (cooldown, then TOTP release)');
});

test('one experiment at a time; a pending approval can be cancelled before activation; content changed after approval is never activated', async (t) => {
  const env = policyEnv(t);
  const daemon = rig(env, [candidate('copy-test', marketingSpec())]);
  const first = await propose(env, daemon, 'r:1');
  const second = await propose(env, daemon, 'r:2');
  assert.notEqual(first, second);

  assert.equal(approveStrategy(daemon, first).state, 'experiment');
  const refused = approveStrategy(daemon, second);
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /already in progress/);
  assert.equal(statusOf(env.db, second), 'proposed');

  // 활성화 전 취소 → 켜지지 않고, 다음 실험을 승인할 수 있다
  const cancelled = daemon.handleChannelRequest({ cmd: 'cancel', actor: OWNER, kind: 'strategy_version', id: first }) as { ok: boolean; state: string };
  assert.deepEqual([cancelled.ok, cancelled.state], [true, 'cancelled']);
  assert.deepEqual(await daemon.cycle!.advance().then((r) => [r.activated, r.activationFailed]), [[], []]);
  assert.equal(approveStrategy(daemon, second).state, 'experiment');

  // 승인 뒤 내용이 바뀌면(승인 해시 불일치) 활성화하지 않는다
  env.db.writeTx((tx) => tx.run("UPDATE strategy_version SET body = 'hypothesis changed after approval' WHERE id = ?", [second]));
  const report = await daemon.cycle!.advance();
  assert.deepEqual(report.activated, []);
  assert.deepEqual(report.activationFailed.map((f) => [f.strategyVersionId, f.code]), [[second, 'approval_invalid']]);
  assert.match(report.activationFailed[0]!.error, /approved_hash mismatch/);
  assert.deepEqual([activationEvents(env.db), experimentTasks(env.db, first).length, experimentTasks(env.db, second).length], [0, 0, 0]);
});
