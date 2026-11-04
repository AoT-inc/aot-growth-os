// 초안 승인(ADR-0015): 승인 대상 해시에 초안이 묶이는 방식과 승인 확인(기한)을 고정한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contentHash, type EffectDraftRow } from '@aot/domain';
import { taskSubject, taskSubjectHash, verifyTaskApproval } from '@aot/policy';
import type { TaskRow, TaskSpec } from '@aot/domain';

import { createWithGate, effectDraft, policyEnv, taskRow } from '../support/policy.ts';

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
