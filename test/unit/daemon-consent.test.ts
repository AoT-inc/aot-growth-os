// claude-code-cli 고지 동의 채널 (apps/daemon/src/consent.ts): 사람만, 현재 고지 판에만 유효, 가장 나중 기록이 상태, 동의·철회가 어댑터가 읽는 값에 바로 반영된다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLAUDE_CODE_NOTICE } from '@aot/agent-runtime';

import { CONSENT_ACCEPTED, createConsentHandler, isConsentCommand, readClaudeCodeConsent } from '../../apps/daemon/src/consent.ts';
import { AGENT, OWNER, policyEnv } from '../support/policy.ts';

const rig = (t: Parameters<typeof policyEnv>[0]) => {
  const env = policyEnv(t);
  const handle = createConsentHandler({ db: env.db, clock: env.clock });
  const send = (request: Record<string, unknown>) => handle({ cmd: 'consent', actor: OWNER, ...request });
  return { env, send };
};

const stateOf = (response: Record<string, unknown>) => response['consent'] as Record<string, unknown>;

test('isConsentCommand picks only the consent command', () => {
  assert.equal(isConsentCommand({ cmd: 'consent' }), true);
  for (const other of [{ cmd: 'list' }, {}, null, 'consent', ['consent']]) assert.equal(isConsentCommand(other), false);
});

test('before any consent: show gives the notice and a not-accepted state, and the adapter reads null', (t) => {
  const { env, send } = rig(t);
  const shown = send({ op: 'show' });
  assert.equal(shown['ok'], true);
  assert.deepEqual(shown['notice'], { version: CLAUDE_CODE_NOTICE.version, text: CLAUDE_CODE_NOTICE.text });
  assert.deepEqual(stateOf(shown), { accepted: false, stale: false, notice_version: null, accepted_at: null, accepted_by: null });
  assert.equal(readClaudeCodeConsent(env.db), null);
});

test('accept needs the version the person read; a wrong or missing version records nothing', (t) => {
  const { env, send } = rig(t);
  assert.deepEqual(send({ op: 'accept' }), { ok: false, code: 'notice_version_required', error: 'accept needs the notice version you read (see `consent show`)' });
  const wrong = send({ op: 'accept', notice_version: 'some-older-version' });
  assert.equal(wrong['code'], 'notice_version_mismatch');
  assert.equal(readClaudeCodeConsent(env.db), null);
  assert.equal(env.db.get('SELECT COUNT(*) AS n FROM event WHERE source = ?', ['consent'])?.['n'], 0);
});

test('accept records who and when; the adapter reads it at once; accepting again changes nothing', (t) => {
  const { env, send } = rig(t);
  const accepted = send({ op: 'accept', notice_version: CLAUDE_CODE_NOTICE.version });
  assert.equal(accepted['ok'], true);
  assert.equal(accepted['applied'], true);
  assert.deepEqual(stateOf(accepted), { accepted: true, stale: false, notice_version: CLAUDE_CODE_NOTICE.version, accepted_at: env.clock.nowIso(), accepted_by: OWNER });
  assert.deepEqual(readClaudeCodeConsent(env.db), { notice_version: CLAUDE_CODE_NOTICE.version, accepted_at: env.clock.nowIso() });
  const again = send({ op: 'accept', notice_version: CLAUDE_CODE_NOTICE.version });
  assert.equal(again['applied'], false);
  assert.equal(env.db.get('SELECT COUNT(*) AS n FROM event WHERE source = ?', ['consent'])?.['n'], 1);
});

test('revoke makes the adapter read null again; re-accepting at the very same clock time wins (the later row decides)', (t) => {
  const { env, send } = rig(t);
  send({ op: 'accept', notice_version: CLAUDE_CODE_NOTICE.version });
  assert.equal(send({ op: 'revoke' })['applied'], true);
  assert.equal(readClaudeCodeConsent(env.db), null);
  assert.equal(send({ op: 'revoke' })['applied'], false, 'revoking twice is a no-op');
  send({ op: 'accept', notice_version: CLAUDE_CODE_NOTICE.version }); // 가짜 시계는 멈춰 있다: 같은 시각의 세 번째 행
  assert.notEqual(readClaudeCodeConsent(env.db), null);
  assert.deepEqual(env.db.all<{ type: string }>('SELECT type FROM event WHERE source = ? ORDER BY rowid', ['consent']).map((row) => row.type), ['consent.accepted', 'consent.revoked', 'consent.accepted']);
});

test('a consent given for an older notice version is stale: the adapter reads null and show says so', (t) => {
  const { env, send } = rig(t);
  env.db.writeTx((tx) => tx.run(
    'INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
    ['event-old', 'consent', 'claude-code-cli', CONSENT_ACCEPTED, JSON.stringify({ adapter: 'claude-code-cli', notice_version: '2020-01-01', actor_id: OWNER }), 'consent:old', env.clock.nowIso(), env.clock.nowIso()],
  ));
  assert.equal(readClaudeCodeConsent(env.db), null);
  assert.deepEqual(stateOf(send({ op: 'show' })), { accepted: false, stale: true, notice_version: '2020-01-01', accepted_at: env.clock.nowIso(), accepted_by: OWNER });
  assert.equal(send({ op: 'accept', notice_version: CLAUDE_CODE_NOTICE.version })['applied'], true, 'accepting the current notice replaces the stale consent');
  assert.notEqual(readClaudeCodeConsent(env.db), null);
});

test('only human actors; unknown actors, unknown fields and unknown operations are refused without writing', (t) => {
  const { env, send } = rig(t);
  assert.equal(send({ actor: AGENT, op: 'accept', notice_version: CLAUDE_CODE_NOTICE.version })['code'], 'not_human');
  assert.equal(send({ actor: 'nobody', op: 'show' })['code'], 'unknown_actor');
  assert.equal(send({ actor: undefined, op: 'show' })['code'], 'unknown_actor');
  assert.equal(send({ op: 'show', extra: 1 })['code'], 'invalid_request');
  assert.equal(send({ op: 'show', notice_version: CLAUDE_CODE_NOTICE.version })['code'], 'invalid_request');
  assert.equal(send({ op: 'grant' })['code'], 'unknown_op');
  assert.equal(readClaudeCodeConsent(env.db), null);
  assert.equal(env.db.get('SELECT COUNT(*) AS n FROM event WHERE source = ?', ['consent'])?.['n'], 0);
});
