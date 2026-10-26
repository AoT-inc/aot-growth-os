// 정책 배포 (ADR-0006 Amendment 2026-10-19): 강화는 일반 변경으로 바로 배포, 보안 하향은 현재 정책의 위험 변경 절차
// (승인 → cooldown → TOTP 재인증)를 거쳐야 배포된다. 값 범위를 벗어난 정책은 배포되지 않는다.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { currentPolicyVersionId } from '@aot/domain';

import { AGENT, HOUR, OWNER, policyEnv, policyText, REVIEWER, type PolicyEnv } from '../support/policy.ts';

const deploy = (env: PolicyEnv, text: string, actor = OWNER) => env.send({ cmd: 'approve', actor, kind: 'policy_version', policy_text: text });
const versions = (env: PolicyEnv) => env.db.all<{ id: string; change_class: string; approved_by: string }>('SELECT id, change_class, approved_by FROM policy_version ORDER BY rowid').map((r) => ({ ...r }));

test('a tightening change (longer cooldown) is a normal change and is deployed right away', (t) => {
  const env = policyEnv(t);
  const text = policyText((y) => y.replace('cooldown: 1h ', 'cooldown: 2h '));
  const response = deploy(env, text);
  assert.equal(response['state'], 'deployed');
  assert.equal(response['change_class'], 'normal');
  assert.equal(currentPolicyVersionId(env.db), response['version_id']);
  assert.deepEqual(versions(env).at(-1), { id: String(response['version_id']), change_class: 'normal', approved_by: JSON.stringify([OWNER]) });
  const archived = join(env.store.dir, `${String(response['hash'])}.yaml`);
  assert.ok(existsSync(archived));
  assert.equal(statSync(archived).mode & 0o777, 0o600);
  assert.equal(statSync(env.store.dir).mode & 0o777, 0o700);
  assert.match(String(deploy(env, text)['error']), /already the deployed policy/);
});

test('lowering security settings needs the risky-change procedure of the CURRENT policy, not the new values', (t) => {
  const env = policyEnv(t);
  // 새 정책은 대기 0·재인증 없음이지만, 그 값으로 자기 자신을 승인할 수 없다
  const text = policyText((y) => y.replace('cooldown: 1h ', 'cooldown: 0 ').replace('reauth_before_effect: true', 'reauth_before_effect: false'));
  const approved = deploy(env, text);
  assert.equal(approved['change_class'], 'risky');
  assert.deepEqual(approved['reasons'], ['risky_change.cooldown shortened 3600s -> 0s', 'risky_change.reauth_before_effect turned off']);
  assert.equal(approved['state'], 'cooldown');
  assert.equal(currentPolicyVersionId(env.db), 'policy-v1', 'not deployed yet');
  const id = String(approved['id']);
  assert.deepEqual(env.send({ cmd: 'list', actor: OWNER })['policy_proposals'], [id]);

  env.clock.advance(HOUR - 1);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id, totp: env.code() })['error']), /cooldown/);
  env.clock.advance(1);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id })['error']), /TOTP code is required/);
  const released = env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id, totp: env.code() });
  assert.equal(released['state'], 'deployed');
  assert.deepEqual(versions(env).at(-1), { id, change_class: 'risky', approved_by: JSON.stringify([OWNER]) });
  assert.deepEqual(env.send({ cmd: 'list', actor: OWNER })['policy_proposals'], []);
});

test('each security-lowering setting is held back; cancel during the cooldown stops the deployment', (t) => {
  const env = policyEnv(t);
  const raised = deploy(env, policyText((y) => y.replace('min_approvers: 1 ', 'min_approvers: 2 ')));
  assert.equal(raised['state'], 'deployed', 'raising the approver count is a normal change');
  for (const [from, to] of [['min_approvers: 2 ', 'min_approvers: 1 '], ['cooldown: 1h ', 'cooldown: 5m ']]) {
    const base = policyText((y) => y.replace('min_approvers: 1 ', 'min_approvers: 2 '));
    const response = deploy(env, base.replace(from!, to!));
    assert.equal(response['change_class'], 'risky', to);
    assert.equal(response['state'], 'insufficient', 'the current policy needs two approvers');
    // 2인 → 1인은 자기 승인이 허용으로 바뀌는 변경이므로 그 이유가 위험 변경 사유에 드러난다
    assert.equal((response['reasons'] as string[]).some((r) => /self-approval becomes allowed/.test(r)), from === 'min_approvers: 2 ', to);
  }
  const pending = deploy(env, policyText((y) => y.replace('min_approvers: 1 ', 'min_approvers: 2 ').replace('cooldown: 1h ', 'cooldown: 5m ')));
  const id = String(pending['id']);
  assert.equal(pending['state'], 'insufficient');
  const second = deploy(env, policyText((y) => y.replace('min_approvers: 1 ', 'min_approvers: 2 ').replace('cooldown: 1h ', 'cooldown: 5m ')), REVIEWER);
  assert.equal(second['state'], 'cooldown');
  assert.equal(env.send({ cmd: 'cancel', actor: REVIEWER, kind: 'policy_version', id }).ok, true);
  env.clock.advance(2 * HOUR);
  assert.match(String(env.send({ cmd: 'release', actor: OWNER, kind: 'policy_version', id, totp: env.code() })['error']), /rejected or cancelled/);
});

test('out-of-range or malformed policies are not deployed; agents cannot deploy', (t) => {
  const env = policyEnv(t);
  assert.match(String(deploy(env, policyText((y) => y.replace('min_approvers: 1 ', 'min_approvers: 0 ')))['error']), /min_approvers must be an integer in \[1, 10\]/);
  assert.match(String(deploy(env, policyText((y) => y.replace('cooldown: 1h ', 'cooldown: forever ')))['error']), /cooldown must be a duration/);
  assert.match(String(deploy(env, 'format: aot-policy/v1\nrules: &a []')['error']), /anchors, aliases/);
  assert.match(String(deploy(env, policyText((y) => y.replace('cooldown: 2h', 'x')), AGENT)['error']), /only human actors/);
  assert.equal(versions(env).length, 1);
});
