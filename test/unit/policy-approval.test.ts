// 승인 엔진 (phase-a §3 "승인"·"정책 변경" A3): approved_hash 묶음, cooldown·취소·재인증(TOTP)·재사용 거부,
// 자기 승인 금지, 에이전트 승인 불가, 실행 직전 재검증(해시 불일치, 정책 강화), 부작용 직전 재검증.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Db } from '@aot/domain';
import { TOTP_LOCKOUT_MS, TOTP_MAX_FAILURES } from '@aot/policy';
import { claimNextTask, TaskWorker, type EffectTool } from '@aot/task-engine';

import { asEffectTool, manualTimers, taskStatus } from '../support/engine.ts';
import { createIdempotentFakeTool } from '../support/fake-tool.ts';
import {
  AGENT, approve, createWithGate, customerReadDraft, decisionsOf, deployDirect, effectDraft, HOUR, OWNER, policyEnv, policyText, REVIEWER, taskRow, withExtraRule,
  type PolicyEnv,
} from '../support/policy.ts';

const claim = (env: PolicyEnv, taskId: string) =>
  claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', leaseMs: 90_000, taskId });

const lastReason = (db: Db, id: string) => db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [id])!.reason;

/** 승인이 필요한 업무를 만들어 needs_review 로 보낸다 */
function pendingTask(env: PolicyEnv, overrides: Record<string, unknown> = {}, causedBy?: string): string {
  const id = createWithGate(env, effectDraft(overrides), causedBy === undefined ? {} : { causedBy });
  assert.equal(claim(env, id).claimed, null);
  assert.equal(taskStatus(env.db, id), 'needs_review');
  return id;
}

/** 승인 → cooldown 경과 → TOTP 해제까지 */
function approveAndRelease(env: PolicyEnv, id: string): void {
  assert.equal(approve(env, id).ok, true);
  env.clock.advance(HOUR);
  const released = env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() });
  assert.deepEqual(released, { ok: true, state: 'queued' });
}

test('approve → cooldown → release with TOTP → the daemon runs it; the approval is bound to the subject hash', (t) => {
  const env = policyEnv(t);
  const id = pendingTask(env);
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id });
  assert.equal(shown.ok, true);
  assert.equal((shown['approval'] as { state: string }).state, 'missing');
  assert.match(String(shown['hash']), /^[0-9a-f]{64}$/);

  const approved = env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id, hash: shown['hash'] });
  assert.equal(approved['state'], 'cooldown');
  assert.equal(approved['cooldown_ends_at'], '2026-10-19T01:00:00.000Z');
  const row = taskRow(env.db, id);
  assert.equal(row.approved_hash, shown['hash']);
  assert.equal(JSON.parse(row.approved_snapshot!).policy_version_id, 'policy-v1');
  assert.equal(row.status, 'needs_review', 'still waiting');

  // 대기 중: 해제도 실행도 안 된다
  env.clock.advance(HOUR - 1);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() })['error']), /cooldown until 2026-10-19T01:00:00.000Z/);
  assert.equal(claim(env, id).claimed, null);

  env.clock.advance(1);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id })['error']), /TOTP code is required/);
  const wrong = String((Number(env.code()) + 1) % 1_000_000).padStart(6, '0');
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: wrong })['error']), /not valid/);
  assert.deepEqual(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() }), { ok: true, state: 'queued' });
  const reauth = env.db.all<{ actor_id: string; purpose: string }>('SELECT actor_id, purpose FROM human_reauth').map((r) => ({ ...r }));
  assert.deepEqual(reauth, [{ actor_id: OWNER, purpose: `release:task:${id}:${String(shown['hash'])}` }]);

  const claimed = claim(env, id).claimed;
  assert.equal(claimed?.task.id, id);
  const notify = decisionsOf(env.db, id).filter((r) => r.action === 'notify-tool.send').at(-1)!;
  assert.match(notify.reason, /approval: valid \(re-check before run\)/);
  // TOTP 비밀·코드는 어디에도 남지 않는다
  const secret = env.secrets.get(OWNER)!;
  for (const table of ['policy_decision', 'approval', 'human_reauth', 'task_transition']) {
    const dump = JSON.stringify(env.db.all(`SELECT * FROM ${table}`));
    assert.ok(!dump.includes(secret), `${table} holds no TOTP secret`);
  }
});

test('a TOTP code cannot be reused, even for another subject in the same time window', (t) => {
  const env = policyEnv(t);
  const first = pendingTask(env, { inputs: [{ name: 'n', ref: 'r:1', kind: 'k' }] });
  const second = pendingTask(env, { inputs: [{ name: 'n', ref: 'r:2', kind: 'k' }] });
  approve(env, first);
  approve(env, second);
  env.clock.advance(HOUR);
  const code = env.code();
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: first, totp: code }).ok, true);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: second, totp: code })['error']), /already used/);
  assert.equal(taskStatus(env.db, second), 'needs_review');
  env.clock.advance(30_000);
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: second, totp: env.code() }).ok, true, 'the next window code works');
});

test('wrong TOTP codes are throttled: after 5 consecutive failures the actor is locked out for 5 minutes', (t) => {
  const env = policyEnv(t);
  const id = pendingTask(env);
  approve(env, id);
  env.clock.advance(HOUR);
  const wrong = () => String((Number(env.code()) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: wrong() })['error']), /not valid/);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() })['error']), /too many wrong TOTP codes/);
  env.clock.advance(TOTP_LOCKOUT_MS);
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() }).ok, true);
});

test('cancel during the cooldown revokes the approval; a released task can be pulled back before it runs', (t) => {
  const env = policyEnv(t);
  const id = pendingTask(env);
  approve(env, id);
  env.clock.advance(10 * 60_000);
  assert.deepEqual(Object.keys(env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id, comment: 'changed my mind' })), ['ok', 'state', 'approval_id']);
  env.clock.advance(HOUR);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() })['error']), /rejected or cancelled/);

  // 다시 승인하면 새 cooldown 이 시작된다
  assert.equal(approve(env, id)['state'], 'cooldown');
  env.clock.advance(HOUR);
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() }).ok, true);
  assert.equal(taskStatus(env.db, id), 'queued');
  assert.equal(env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id }).ok, true);
  assert.equal(taskStatus(env.db, id), 'needs_review');
  assert.match(lastReason(env.db, id), /approval cancelled by actor-owner/);
  assert.equal(env.db.get<{ n: number }>('SELECT count(*) AS n FROM task_run WHERE task_id = ?', [id])!.n, 0);
});

test('approved_hash mismatch: execution arguments changed after approval block the run and ask for re-approval', (t) => {
  const env = policyEnv(t);
  const id = pendingTask(env);
  approveAndRelease(env, id);
  // 승인 뒤 실행 인자를 바꾼다 (다른 대상으로 보내기)
  const spec = JSON.parse(taskRow(env.db, id).spec);
  spec.allowed_tools[1].target = 'mailbox:everyone';
  env.db.writeTx((tx) => tx.run('UPDATE task SET spec = ? WHERE id = ?', [JSON.stringify(spec), id]));
  assert.equal(claim(env, id).claimed, null);
  assert.equal(taskStatus(env.db, id), 'needs_review');
  assert.match(lastReason(env.db, id), /approved_hash mismatch: the execution arguments differ/);
  // 오래된 해시로는 다시 승인할 수 없다
  assert.match(String(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id, hash: taskRow(env.db, id).approved_hash })['error']), /changed since it was shown/);
});

test('a policy tightened after approval is applied at run time; an old approval cannot override it', (t) => {
  const env = policyEnv(t);
  const denied = pendingTask(env, { inputs: [{ name: 'n', ref: 'r:1', kind: 'k' }] });
  approveAndRelease(env, denied);
  deployDirect(env, withExtraRule('{id: no-notify, action: ["notify-tool.*"], decision: deny}'));
  assert.equal(claim(env, denied).claimed, null);
  assert.match(lastReason(env.db, denied), /denied by the current policy/);
  assert.match(String(approve(env, denied)['error']), /an approval cannot override deny/);

  // 승인자 수만 올린 정책(일반 변경): 정책 버전이 바뀌어 옛 승인은 무효, 새 기준(2인)을 채워야 한다
  const env2 = policyEnv(t);
  const id = pendingTask(env2);
  approveAndRelease(env2, id);
  deployDirect(env2, policyText((y) => y.replace('min_approvers: 1 ', 'min_approvers: 2 ')));
  assert.equal(claim(env2, id).claimed, null);
  assert.match(lastReason(env2.db, id), /policy changed since approval \(approved under policy-v1, current policy-[0-9a-f]{16}\)/);
  assert.equal(approve(env2, id)['state'], 'insufficient');
  assert.equal(approve(env2, id, REVIEWER)['state'], 'cooldown');
  env2.clock.advance(HOUR);
  assert.equal(env2.send({ cmd: 'release', actor: REVIEWER, kind: 'task', id, totp: env2.code(REVIEWER) }).ok, true);
  assert.equal(claim(env2, id).claimed?.task.id, id);
});

test('self approval: allowed for the owner only when min_approvers is 1 (cooldown and TOTP still apply); forbidden for 2 or more', (t) => {
  const env = policyEnv(t);
  const id = pendingTask(env, {}, OWNER);
  assert.equal(approve(env, id, OWNER)['state'], 'cooldown', 'min_approvers 1: the requester may approve their own task');
  assert.equal(claim(env, id).claimed, null, 'but it does not run during the cooldown');
  env.clock.advance(HOUR);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id })['error']), /TOTP code is required/);
  assert.deepEqual(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id, totp: env.code() }), { ok: true, state: 'queued' });

  // 2인 이상: 자기 승인은 자동으로 금지된다. 다른 사람의 승인은 인원수에 센다
  const envTwo = policyEnv(t);
  deployDirect(envTwo, policyText((y) => y.replace('min_approvers: 1 ', 'min_approvers: 2 ')));
  const two = pendingTask(envTwo, {}, OWNER);
  assert.match(String(approve(envTwo, two, OWNER)['error']), /requester cannot approve their own task \(self-approval is allowed only when risky_change.min_approvers is 1\)/);
  assert.equal(approve(envTwo, two, REVIEWER)['state'], 'insufficient');

  // 에이전트 actor 는 어떤 경우에도 승인할 수 없다
  for (const command of [
    { cmd: 'whoami', actor: AGENT }, { cmd: 'list', actor: AGENT }, { cmd: 'show', actor: AGENT, kind: 'task', id },
    { cmd: 'approve', actor: AGENT, kind: 'task', id, hash: taskRow(env.db, id).approved_hash },
    { cmd: 'release', actor: AGENT, kind: 'task', id, totp: '000000' }, { cmd: 'cancel', actor: AGENT, kind: 'task', id },
    { cmd: 'approve', actor: AGENT, kind: 'policy_version', policy_text: 'format: x' },
    { cmd: 'whoami', actor: 'actor-unknown' },
  ]) {
    const response = env.send(command);
    assert.equal(response.ok, false, JSON.stringify(command));
    assert.match(String(response['error']), /only human actors|unknown actor/);
  }
  // DB 에 직접 넣은 에이전트 "승인"은 세지 않는다 (approval.decided_by 는 사람만)
  const env2 = policyEnv(t);
  const other = pendingTask(env2);
  const hash = String(env2.send({ cmd: 'show', actor: OWNER, kind: 'task', id: other })['hash']);
  env2.db.writeTx((tx) => {
    tx.run("INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, at) VALUES ('forged', 'task', ?, 'approved', ?, ?, ?)", [other, hash, AGENT, env2.clock.nowIso()]);
    tx.run("UPDATE task SET status = 'queued', approval_id = 'forged', approved_hash = ?, approved_snapshot = ? WHERE id = ?", [hash, JSON.stringify({ policy_version_id: 'policy-v1' }), other]);
  });
  env2.clock.advance(2 * HOUR);
  assert.equal(claim(env2, other).claimed, null);
  assert.match(lastReason(env2.db, other), /approval required \(no approval recorded\)/);
});

test('reject sends the task to failed with the human decision recorded', (t) => {
  const env = policyEnv(t);
  const id = pendingTask(env);
  assert.deepEqual(Object.keys(env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id, comment: 'not now' })), ['ok', 'state', 'approval_id']);
  assert.equal(taskStatus(env.db, id), 'failed');
  assert.equal(env.db.get<{ decision: string }>("SELECT decision FROM approval WHERE subject_id = ?", [id])!.decision, 'rejected');
});

test('re-check before the external effect: approved target is sent once; a different target is refused and nothing is sent', async (t) => {
  const env = policyEnv(t);
  const fake = createIdempotentFakeTool({ name: 'notify-tool' });
  const tools: Record<string, EffectTool> = { 'notify-tool': asEffectTool(fake) };
  let target = 'mailbox:example';
  const worker = new TaskWorker({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', gate: env.gate, tools, timers: manualTimers(),
    executor: {
      async execute(context) {
        const outcome = await context.performEffect('notify-tool', { stepId: 'notify', action: 'send', target, request: { subject: 'example-product weekly' } });
        return { result: outcome };
      },
    },
  });
  const ok = pendingTask(env, { inputs: [{ name: 'n', ref: 'r:1', kind: 'k' }] });
  approveAndRelease(env, ok);
  const report = await worker.tick();
  assert.deepEqual(report.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(fake.deliveries.length, 1);
  assert.ok(decisionsOf(env.db, ok).some((r) => r.task_run_id !== null && /approval: valid .*external effect, first/.test(r.reason)));

  const moved = pendingTask(env, { inputs: [{ name: 'n', ref: 'r:2', kind: 'k' }] });
  approveAndRelease(env, moved);
  target = 'mailbox:everyone'; // 실행기가 승인되지 않은 대상으로 보내려 한다
  const refused = await worker.tick();
  assert.deepEqual(refused.executed?.end, { outcome: 'killed', taskStatus: 'needs_review' });
  assert.equal(fake.deliveries.length, 1, 'nothing more was sent');
  assert.equal(taskStatus(env.db, moved), 'needs_review');
  assert.match(lastReason(env.db, moved), /stopped before an external effect: notify-tool\.send on mailbox:everyone was not requested/);
  assert.deepEqual(env.db.all('SELECT state FROM external_effect WHERE task_id = ?', [moved]).map((r) => r['state']), ['planned']);
});

test("a failed effect is resent only when the policy decision is 'allow' (recovery §3 \"정책 허용 시\")", async (t) => {
  const env = policyEnv(t);
  let calls = 0;
  const flaky: EffectTool = {
    name: 'notify-tool', supportsIdempotency: true,
    send: () => (calls += 1) === 1 ? { status: 'failed', responseRef: null } : { status: 'confirmed', responseRef: `delivery-${calls}` },
  };
  const step = { stepId: 'notify', action: 'send', target: 'mailbox:example', request: { n: 1 } };
  const worker = new TaskWorker({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', gate: env.gate, tools: { 'notify-tool': flaky }, timers: manualTimers(),
    executor: {
      async execute(context) {
        const first = await context.performEffect('notify-tool', step);
        const again = await context.performEffect('notify-tool', step);
        return { result: [first.state, again.state] };
      },
    },
  });
  // 기본 정책: 외부 부작용은 require_approval → 승인은 한 번의 전송에 대한 것이므로 실패 재전송은 하지 않는다
  const id = pendingTask(env);
  approveAndRelease(env, id);
  await worker.tick();
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(String(env.db.get('SELECT result FROM task_run WHERE task_id = ?', [id])!['result'])), ['failed', 'failed']);
  assert.match(decisionsOf(env.db, id).at(-1)!.reason, /resending a failed effect needs an 'allow' decision/);

  // 정책이 이 부작용을 allow 하면 재전송한다
  const env2 = policyEnv(t);
  deployDirect(env2, withExtraRule('{id: notify-ok, action: ["notify-tool.send"], resource: ["mailbox:example"], scope: [internal], impact: [external_effect], decision: allow}')
    .replace('  - id: external-effect-needs-approval\n    impact: [external_effect]\n    decision: require_approval\n', ''));
  calls = 0;
  const worker2 = new TaskWorker({
    db: env2.db, clock: env2.clock, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', gate: env2.gate, tools: { 'notify-tool': flaky }, timers: manualTimers(),
    executor: {
      async execute(context) {
        const first = await context.performEffect('notify-tool', step);
        const again = await context.performEffect('notify-tool', step);
        return { result: [first.state, again.state] };
      },
    },
  });
  const allowed = createWithGate(env2, effectDraft({ allowed_tools: [{ tool: 'notify-tool', operations: ['send'], scope: 'internal', impact: 'external_effect', target: 'mailbox:example' }] }));
  await worker2.tick();
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(String(env2.db.get('SELECT result FROM task_run WHERE task_id = ?', [allowed])!['result'])), ['failed', 'confirmed']);
});

test('a require_approval that is not an external effect (customer-scope read) needs one human approval only: no cooldown, no TOTP', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, customerReadDraft(), { causedBy: OWNER });
  assert.equal(claim(env, id).claimed, null);
  assert.equal(taskStatus(env.db, id), 'needs_review');
  const requirement = JSON.parse(String(decisionsOf(env.db, id).length > 0 && env.db.get("SELECT approval_required AS a FROM policy_decision WHERE task_id = ? AND decision = 'require_approval' LIMIT 1", [id])!['a']));
  assert.deepEqual(requirement, { approver_kind: 'human', channel: 'approval-socket', min_approvers: 1, cooldown: 0, reauth_before_effect: false, self_approval: true });

  // 요청자(오너)가 자기 승인(min_approvers 1) → 곧바로 queued. 해제도 TOTP 도 없다
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id });
  assert.equal(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id, hash: shown['hash'] })['state'], 'queued');
  assert.equal(env.db.get('SELECT count(*) AS n FROM human_reauth')?.['n'], 0);
  assert.equal(claim(env, id).claimed?.task.id, id);
  assert.match(decisionsOf(env.db, id).at(-1)!.reason, /approval: valid \(re-check before run\)/);

  // 승인이 없으면 여전히 실행되지 않고, 에이전트는 승인할 수 없다
  const other = createWithGate(env, customerReadDraft({ inputs: [{ name: 'n', ref: 'r:2', kind: 'k' }] }));
  assert.equal(claim(env, other).claimed, null);
  assert.match(lastReason(env.db, other), /approval required/);
  assert.match(String(env.send({ cmd: 'approve', actor: AGENT, kind: 'task', id: other, hash: 'x' })['error']), /only human actors/);
});

test('plain approval with min_approvers 2: one other human is enough, the requester cannot approve; an external effect in the same task brings back the full procedure', (t) => {
  const env = policyEnv(t);
  deployDirect(env, policyText((y) => y.replace('min_approvers: 1 ', 'min_approvers: 2 ')));
  const id = createWithGate(env, customerReadDraft(), { causedBy: OWNER });
  assert.equal(claim(env, id).claimed, null);
  assert.match(String(approve(env, id, OWNER)['error']), /requester cannot approve their own task/);
  assert.equal(approve(env, id, REVIEWER)['state'], 'queued', 'no second approver, cooldown or TOTP for a non-external require_approval');

  const mixed = createWithGate(env, effectDraft({ inputs: [{ name: 'n', ref: 'r:mixed', kind: 'k' }], allowed_tools: [
    { tool: 'crm_read', operations: ['read'], scope: 'customer', impact: 'read', target: 'crm:example' },
    { tool: 'notify-tool', operations: ['send'], scope: 'customer', impact: 'external_effect', target: 'mailbox:example' },
  ] }), { causedBy: OWNER });
  assert.equal(claim(env, mixed).claimed, null);
  assert.equal(approve(env, mixed, REVIEWER)['state'], 'insufficient', 'needs 2 approvers because of the external effect');
});
