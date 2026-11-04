// 초안 승인(ADR-0015): 승인 대상 해시에 초안이 묶이는 방식과 승인 확인(기한)을 고정한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contentHash, sha256Hex as sha, type EffectDraftRow } from '@aot/domain';
import { taskSubject, taskSubjectHash, verifyTaskApproval } from '@aot/policy';
import type { TaskRow, TaskSpec } from '@aot/domain';

import { claimNextTask, effectKeyOf } from '@aot/task-engine';

import { draftsOf } from '../support/drafts.ts';
import { claimWith, draftedTask, LEASE_MS } from '../support/draft-flow.ts';
import { taskStatus } from '../support/engine.ts';
import { examplePayload } from '../support/message-tool.ts';
import { AGENT, approve, createWithGate, deployDirect, HOUR, OWNER, REVIEWER, effectDraft, policyEnv, policyText, taskRow } from '../support/policy.ts';

const T0 = '2026-10-19T00:00:00.000Z';

function draftRow(over: Partial<EffectDraftRow> = {}): EffectDraftRow {
  return {
    id: 'draft-1', task_id: 't1', task_run_id: 'run-1', seq: 1, tool: 'notify-tool', action: 'send', target: 'mailbox:example', step_id: 'step-1',
    payload: '{"subject":"s"}', payload_hash: 'a'.repeat(64), effect_key: 'k1', influenced_by_external_input: 0, state: 'proposed',
    created_at: T0, expires_at: '2026-10-22T00:00:00.000Z', at: T0, ...over,
  };
}

const TASK = { id: 't1', role_id: null, role_version: null, product_id: null } as Pick<TaskRow, 'id' | 'role_id' | 'role_version' | 'product_id'>;
const SPEC = { objective: 'o', allowed_tools: [] } as unknown as TaskSpec;

test('without drafts the subject has no drafts key and the hash equals the pre-draft hash (I3)', () => {
  const plain = taskSubject(TASK, SPEC, 'pv-1');
  assert.equal('drafts' in plain, false);
  assert.deepEqual(taskSubject(TASK, SPEC, 'pv-1', []), plain);
  assert.deepEqual(taskSubject(TASK, SPEC, 'pv-1', undefined), plain);
  assert.equal(taskSubjectHash(taskSubject(TASK, SPEC, 'pv-1', [])), taskSubjectHash(plain));
  // 초안 도입 전 구성(이 필드들만)의 해시와 같다
  assert.equal(taskSubjectHash(plain), contentHash({
    kind: 'task', task_id: 't1', spec: SPEC, role_id: null, role_version: null, product_id: null, policy_version_id: 'pv-1',
  }));
});

test('drafts enter the subject as seq-ordered entries; any change to a draft changes the hash', () => {
  const a = draftRow({ id: 'a', seq: 1 });
  const b = draftRow({ id: 'b', seq: 2, effect_key: 'k2', step_id: 'step-2' });
  const base = taskSubjectHash(taskSubject(TASK, SPEC, 'pv-1', [a, b]));
  assert.equal(taskSubjectHash(taskSubject(TASK, SPEC, 'pv-1', [b, a])), base, 'order of the array does not matter, seq does');
  const subject = taskSubject(TASK, SPEC, 'pv-1', [a, b]) as { drafts: { draft_id: string }[] };
  assert.deepEqual(subject.drafts.map((d) => d.draft_id), ['a', 'b']);
  assert.notEqual(base, taskSubjectHash(taskSubject(TASK, SPEC, 'pv-1')));
  const changes: Partial<EffectDraftRow>[] = [
    { payload_hash: 'b'.repeat(64) }, { tool: 'other-tool' }, { action: 'post' }, { target: 'mailbox:other' }, { step_id: 'step-x' },
    { expires_at: '2026-10-23T00:00:00.000Z' }, { id: 'zzz' },
  ];
  for (const change of changes) {
    assert.notEqual(taskSubjectHash(taskSubject(TASK, SPEC, 'pv-1', [{ ...a, ...change }, b])), base, JSON.stringify(change));
  }
  assert.notEqual(taskSubjectHash(taskSubject(TASK, SPEC, 'pv-1', [a])), base, 'dropping a draft changes the hash');
});

test('verifyTaskApproval: an expired draft fails with hash_mismatch even when approved_hash matches; fresh drafts reach the approval check', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  const policy = env.store.active(env.db)!.policy!;
  const task = taskRow(env.db, id);
  const spec = JSON.parse(task.spec) as TaskSpec;
  const drafts = [draftRow({ task_id: id })];
  const hash = taskSubjectHash(taskSubject(task, spec, policy.versionId, drafts));
  const approved = { ...task, approved_hash: hash } as TaskRow;

  const fresh = verifyTaskApproval(env.db, approved, spec, policy, '2026-10-21T23:59:59.999Z', drafts);
  assert.equal(fresh.state, 'missing', 'the hash matched, so it went on to the approval rows (none recorded)');
  const expired = verifyTaskApproval(env.db, approved, spec, policy, '2026-10-22T00:00:00.000Z', drafts);
  assert.equal(expired.ok, false);
  assert.equal(expired.state, 'hash_mismatch');
  assert.match(expired.reason, /draft expired/);
  // 초안 없이 확인하면 해시가 달라 거부된다 (승인은 초안 묶음에 묶여 있다)
  assert.equal(verifyTaskApproval(env.db, approved, spec, policy, T0).state, 'hash_mismatch');
  // 초안을 바꾸면 거부된다
  const tampered = [draftRow({ task_id: id, payload_hash: 'c'.repeat(64) })];
  assert.equal(verifyTaskApproval(env.db, approved, spec, policy, T0, tampered).state, 'hash_mismatch');
});

// ===== 승인 엔진 (W10) =====


const requestsTwo = [examplePayload({ subject: 'one' }), examplePayload({ subject: 'two', to: ['second@example.com'] })];

test('show lists the proposed drafts with the exact payload and a hash that binds them', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env, { requests: requestsTwo, influenced: true });
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  assert.equal(shown.ok, true);
  const drafts = shown['drafts'] as { id: string; seq: number; tool: string; action: string; target: string; payload_hash: string; expires_at: string; expired: boolean; influenced_by_external_input: boolean; payload: unknown }[];
  assert.deepEqual(drafts.map((d) => d.seq), [1, 2]);
  assert.deepEqual(drafts.map((d) => d.payload), requestsTwo, 'payload is the parsed JSON original');
  assert.deepEqual(drafts.map((d) => d.influenced_by_external_input), [true, false]);
  assert.deepEqual(drafts.map((d) => d.expired), [false, false]);
  assert.deepEqual(Object.keys(drafts[0]!).sort(), ['action', 'expired', 'expires_at', 'id', 'influenced_by_external_input', 'masked_paths', 'payload', 'payload_hash', 'send_state', 'seq', 'target', 'tool']);
  assert.deepEqual(draftsOf(env.db, taskId).map((d) => d.payload_hash), drafts.map((d) => d.payload_hash));
  assert.equal(shown['hash'], taskSubjectHash(taskSubject(taskRow(env.db, taskId), JSON.parse(taskRow(env.db, taskId).spec) as TaskSpec, 'policy-v1', draftsOf(env.db, taskId))));
  assert.equal((shown['subject'] as { drafts: unknown[] }).drafts.length, 2);
  const listed = env.send({ cmd: 'list', actor: OWNER });
  assert.deepEqual((listed['tasks'] as { id: string; drafts: number }[]).map((x) => [x.id, x.drafts]), [[taskId, 2]]);
});

test('approve with the show hash -> cooldown -> release with TOTP -> queued; the snapshot holds the drafts and the TOTP purpose is bound to the draft hash', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  const hash = String(shown['hash']);
  const approved = env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash });
  assert.equal(approved['state'], 'cooldown');
  const row = taskRow(env.db, taskId);
  assert.equal(row.approved_hash, hash);
  assert.equal((JSON.parse(row.approved_snapshot!) as { drafts: { payload_hash: string }[] }).drafts[0]!.payload_hash, draftsOf(env.db, taskId)[0]!.payload_hash);
  assert.equal(row.status, 'needs_review');
  env.clock.advance(HOUR);
  assert.deepEqual(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: env.code() }), { ok: true, state: 'queued' });
  assert.equal(env.db.get<{ purpose: string }>('SELECT purpose FROM human_reauth ORDER BY id DESC LIMIT 1')!.purpose, `release:task:${taskId}:${hash}`);
});

test('after the approved release the next claim is a dispatch run (host:dispatch), and only then does beforeEffect pass for the approved draft', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const hash = String(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash']);
  env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash });
  env.clock.advance(HOUR);
  env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: env.code() });
  const claimed = claimWith(env, taskId, 'w2').claimed;
  assert.equal(claimed?.phase, 'dispatch');
  assert.equal(claimed?.adapter, 'host:dispatch');
  const task = taskRow(env.db, taskId);
  const draft = draftsOf(env.db, taskId)[0]!;
  const gate = (requestHash: string) => env.db.writeTx((tx) => env.gate.beforeEffect(tx, {
    task, spec: JSON.parse(task.spec) as TaskSpec, runId: claimed!.lease.runId, tool: draft.tool, action: draft.action, target: draft.target,
    dispatch: 'first', now: env.clock.nowIso(), phase: 'dispatch', requestHash,
  }));
  assert.deepEqual(gate(draft.payload_hash), { decision: 'allow' });
  assert.equal(gate('f'.repeat(64)).decision, 'refuse');
});

test('a policy change after approval blocks the dispatch; the same drafts are re-approved under the new policy hash and then dispatch', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const approveAndRelease = () => {
    const hash = String(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash']);
    assert.equal(env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash })['ok'], true);
    env.clock.advance(HOUR);
    env.clock.advance(31_000); // 다음 TOTP 시간창 (같은 코드 재사용 거부)
    assert.deepEqual(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: env.code() }), { ok: true, state: 'queued' });
    return hash;
  };
  const first = approveAndRelease();
  env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id: taskId });
  assert.equal(taskStatus(env.db, taskId), 'needs_review');
  const before = draftsOf(env.db, taskId).map((d) => d.payload_hash);
  deployDirect(env, policyText((y) => y.replace('rules:\n', 'rules:\n  - {id: tighten-nothing, action: ["unrelated_tool.*"], decision: deny}\n')));
  const second = approveAndRelease();
  assert.notEqual(first, second, 'a new policy version changes the approval hash');
  assert.deepEqual(draftsOf(env.db, taskId).map((d) => d.payload_hash), before, 'the drafts were not rewritten');
  assert.equal(claimWith(env, taskId, 'w3').claimed?.phase, 'dispatch');
});

test('rewriting a draft after show makes the old hash unusable', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const hash = String(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash']);
  env.db.writeTx((tx) => tx.run("UPDATE effect_draft SET payload_hash = ? WHERE task_id = ?", ['d'.repeat(64), taskId]));
  const refused = env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash });
  assert.equal(refused['ok'], false);
  assert.match(String(refused['error']), /subject hash mismatch/);
  assert.equal(taskRow(env.db, taskId).approved_hash, null);
});

test('an expired draft blocks approve and release', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env, { dedupeKey: 'expired-approve' });
  env.clock.advance(73 * HOUR);
  const hash = String(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash']);
  const refused = env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash });
  assert.equal(refused['ok'], false);
  assert.match(String(refused['error']), /draft expired/);
  assert.match(String(refused['error']), /request-changes/);
  assert.equal(((env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['drafts']) as { expired: boolean }[])[0]!.expired, true);

  const other = policyEnv(t);
  const second = await draftedTask(other);
  const h2 = String(other.send({ cmd: 'show', actor: OWNER, kind: 'task', id: second.taskId })['hash']);
  assert.equal(other.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: second.taskId, hash: h2 })['state'], 'cooldown');
  other.clock.advance(73 * HOUR);
  const release = other.send({ cmd: 'release', actor: OWNER, kind: 'task', id: second.taskId, totp: other.code() });
  assert.equal(release['ok'], false);
  assert.match(String(release['error']), /draft expired/);
  assert.equal(taskStatus(other.db, second.taskId), 'needs_review');
});

test('reject: the task fails and the proposed drafts become rejected in the same transaction', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env, { requests: requestsTwo });
  const rejected = env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: taskId, comment: 'wrong tone' });
  assert.equal(rejected['state'], 'failed');
  assert.equal(taskStatus(env.db, taskId), 'failed');
  assert.deepEqual(draftsOf(env.db, taskId).map((d) => d.state), ['rejected', 'rejected']);
});

test('request_changes: a changes_requested approval row, drafts superseded, approval columns cleared, task queued; the next claim is a new draft run', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const hash = String(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash']);
  env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash }); // cooldown 중
  assert.notEqual(taskRow(env.db, taskId).approved_hash, null);
  const response = env.send({ cmd: 'request_changes', actor: REVIEWER, kind: 'task', id: taskId, comment: '  shorter subject  ' });
  assert.equal(response['ok'], true);
  assert.equal(response['state'], 'queued');
  assert.equal(response['drafts_superseded'], 1);
  const approvals = env.db.all<{ decision: string; subject_hash: string; comment: string; decided_by: string }>("SELECT decision, subject_hash, comment, decided_by FROM approval WHERE subject_kind = 'task' AND subject_id = ? ORDER BY at, rowid", [taskId]);
  assert.deepEqual(approvals.map((a) => a.decision), ['approved', 'changes_requested']);
  assert.deepEqual([approvals[1]!.subject_hash, approvals[1]!.comment, approvals[1]!.decided_by], [hash, 'shorter subject', REVIEWER]);
  const row = taskRow(env.db, taskId);
  assert.deepEqual([row.status, row.approval_id, row.approved_snapshot, row.approved_hash], ['queued', null, null, null]);
  assert.deepEqual(draftsOf(env.db, taskId).map((d) => d.state), ['superseded']);
  const last = env.db.get<{ from_status: string; to_status: string; caused_by: string }>('SELECT from_status, to_status, caused_by FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!;
  assert.deepEqual([last.from_status, last.to_status, last.caused_by], ['needs_review', 'queued', REVIEWER]);
  assert.equal(claimWith(env, taskId, 'w2').claimed?.phase, 'draft', 'no proposed drafts, so the agent rewrites them');
});

test('request_changes input rules: a human, a task in needs_review, and a comment of 1 to 500 characters', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const send = (over: Record<string, unknown>) => env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id: taskId, comment: 'why', ...over });
  assert.match(String(send({ actor: AGENT })['error']), /only human actors/);
  for (const comment of [undefined, '', '   ', 'x'.repeat(501)]) {
    const refused = send({ comment });
    assert.equal(refused['ok'], false, String(comment).slice(0, 5));
    assert.match(String(refused['error']), /comment of 1 to 500/);
  }
  assert.match(String(send({ kind: 'publication' })['error']), /applies to a task/);
  assert.equal(taskRow(env.db, taskId).status, 'needs_review', 'nothing changed');
  assert.deepEqual(draftsOf(env.db, taskId).map((d) => d.state), ['proposed']);
  assert.equal(send({ comment: 'x'.repeat(500) })['ok'], true);
  assert.match(String(send({})['error']), /is 'queued'/);
});

test('cancel during the cooldown only voids the approval; the proposed drafts stay and can be approved again', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const hash = String(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash']);
  env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash });
  assert.equal(env.send({ cmd: 'cancel', actor: OWNER, kind: 'task', id: taskId })['state'], 'cancelled');
  assert.deepEqual(draftsOf(env.db, taskId).map((d) => d.state), ['proposed']);
  assert.equal(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash'], hash);
  assert.equal(approve(env, taskId).ok, true);
});

test('an agent actor cannot approve, release, reject or cancel a draft task (I5)', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const hash = String(env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['hash']);
  for (const command of [
    { cmd: 'approve', hash }, { cmd: 'release', totp: '000000' }, { cmd: 'reject' }, { cmd: 'cancel' }, { cmd: 'show' },
  ]) {
    const response = env.send({ ...command, actor: AGENT, kind: 'task', id: taskId });
    assert.equal(response.ok, false, command.cmd);
    assert.match(String(response.error), /only human actors/);
  }
  assert.deepEqual(draftsOf(env.db, taskId).map((d) => d.state), ['proposed']);
});

test('tasks without drafts keep today\'s show output hash and approval flow (I3)', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft({ objective: 'plain scope approval' }));
  assert.equal(claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', leaseMs: LEASE_MS, taskId: id }).claimed, null);
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id });
  assert.deepEqual(shown['drafts'], []);
  assert.equal('drafts' in (shown['subject'] as object), false);
  assert.equal(shown['hash'], taskSubjectHash(taskSubject(taskRow(env.db, id), JSON.parse(taskRow(env.db, id).spec) as TaskSpec, 'policy-v1')));
});

// ===== 리뷰 반영: 가려지는 초안, 전송이 시작된 초안 =====


/** proposed 초안의 payload 를 직접 바꿔 넣는다 (평가기를 거치지 않은 경우를 흉내 낸다) */
function rewriteDraft(env: ReturnType<typeof policyEnv>, taskId: string, payload: object): void {
  const row = draftsOf(env.db, taskId)[0]!;
  const text = JSON.stringify(payload);
  env.db.writeTx((tx) => tx.run('UPDATE effect_draft SET payload = ?, payload_hash = ?, effect_key = ? WHERE id = ?', [text, sha(text), effectKeyOf(taskId, row.step_id, payload), row.id]));
}

test('show reports masked_paths and approve/release refuse a draft the person could not see in full', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  rewriteDraft(env, taskId, { to: ['a@example.com'], subject: 's', text: 'hi', headers: { authorization: 'abc', note: 'x' } });
  const shown = env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });
  assert.deepEqual((shown['drafts'] as { masked_paths: string[] }[])[0]!.masked_paths, ['headers.authorization']);
  const refused = env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash: String(shown['hash']) });
  assert.equal(refused['ok'], false);
  assert.match(String(refused['error']), /would show masked values \(.*headers\.authorization\)/);
  assert.equal(taskRow(env.db, taskId).approved_hash, null);
  // 깨끗한 초안은 masked_paths 가 비어 있고 승인된다
  const clean = await draftedTask(env, { dedupeKey: 'clean' });
  assert.deepEqual((env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: clean.taskId })['drafts'] as { masked_paths: string[] }[])[0]!.masked_paths, []);
  assert.equal(approve(env, clean.taskId).ok, true);
  // 승인 뒤 release 직전에 가려지는 값이 생기면 해제도 거부된다 (해시가 달라져 먼저 막히지만 사유가 분명하다)
  env.clock.advance(HOUR);
  rewriteDraft(env, clean.taskId, { to: ['a@example.com'], subject: 's', text: 'hi', api_token: 'x' });
  assert.equal(env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: clean.taskId, totp: env.code() })['ok'], false);
});

test('show reports send_state per draft; once a draft left the ledger, request_changes and reject are refused and point to effects/resolve-effect', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env, { requests: requestsTwo });
  const states = () => (env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId })['drafts'] as { send_state: string }[]).map((d) => d.send_state);
  assert.deepEqual(states(), ['none', 'none']);
  const [first, second] = draftsOf(env.db, taskId);
  const insertEffect = (draft: typeof first, state: string) => env.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, planned_at, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [`e-${draft!.id}`, draft!.effect_key, taskId, draft!.task_run_id, draft!.tool, draft!.action, draft!.target, draft!.payload_hash, state, env.clock.nowIso(), env.clock.nowIso()],
  ));
  insertEffect(first, 'planned');
  assert.deepEqual(states(), ['planned', 'none']);
  // planned 는 아직 나가지 않았다: 변경 요청이 가능하다 (아래에서 다시 확인)
  insertEffect(second, 'confirmed');
  assert.deepEqual(states(), ['planned', 'confirmed']);
  for (const command of [{ cmd: 'request_changes', comment: 'again' }, { cmd: 'reject' }]) {
    const refused = env.send({ ...command, actor: OWNER, kind: 'task', id: taskId });
    assert.equal(refused['ok'], false, command.cmd);
    assert.match(String(refused['error']), /already left the ledger/);
    assert.match(String(refused['error']), /resolve-effect/);
  }
  assert.equal(taskStatus(env.db, taskId), 'needs_review');
  assert.deepEqual(draftsOf(env.db, taskId).map((d) => d.state), ['proposed', 'proposed']);
});

test('a draft that is only planned (never dispatched) may still be sent back for changes', async (t) => {
  const env = policyEnv(t);
  const { taskId } = await draftedTask(env);
  const d = draftsOf(env.db, taskId)[0]!;
  env.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, planned_at, at)
     VALUES ('e1', ?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?, ?)`,
    [d.effect_key, taskId, d.task_run_id, d.tool, d.action, d.target, d.payload_hash, env.clock.nowIso(), env.clock.nowIso()],
  ));
  assert.equal(env.send({ cmd: 'request_changes', actor: OWNER, kind: 'task', id: taskId, comment: 'again' })['ok'], true);
});
