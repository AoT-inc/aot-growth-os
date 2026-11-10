// 고객 연락처 채널 (apps/daemon/src/contacts.ts, D-B11): 사람만 쓴다, 추가·일괄·정지가 감사로 남는다, 정지는 TOTP 없이 즉시이고 되돌릴 수 없다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listContacts } from '@aot/domain';

import { createContactsHandler, isContactsCommand, parseContactImport } from '../../apps/daemon/src/contacts.ts';
import { AGENT, OWNER, policyEnv } from '../support/policy.ts';

const rig = (t: Parameters<typeof policyEnv>[0]) => {
  const env = policyEnv(t);
  const handle = createContactsHandler({ db: env.db, clock: env.clock });
  const send = (request: Record<string, unknown>, actor = OWNER) => handle({ cmd: 'contacts', actor, ...request });
  const events = () => env.db.all<{ type: string; payload: string }>("SELECT type, payload FROM event WHERE source = 'contacts' ORDER BY rowid");
  return { env, send, events };
};

test('isContactsCommand picks only the contacts command', () => {
  assert.equal(isContactsCommand({ cmd: 'contacts' }), true);
  for (const other of [{ cmd: 'consent' }, {}, null, 'contacts']) assert.equal(isContactsCommand(other), false);
});

test('add stores the normalized address with who and when, and audits it; adding again changes nothing', (t) => {
  const { env, send, events } = rig(t);
  const first = send({ op: 'add', address: ' Kim <Customer@Example.COM> ', label: '김 고객' });
  assert.deepEqual(first, { ok: true, address: 'customer@example.com', applied: true });
  assert.equal(send({ op: 'add', address: 'customer@example.com' })['applied'], false);
  const [row] = listContacts(env.db);
  assert.deepEqual({ ...row! }, {
    address: 'customer@example.com', label: '김 고객', status: 'active', added_by: OWNER, added_at: env.clock.nowIso(), suppressed_by: null, suppressed_at: null,
  });
  assert.deepEqual(events().map((e) => e.type), ['contact.added']);
  assert.equal(send({ op: 'add', address: 'not an address' })['code'], 'bad_address');
});

test('an agent actor, an unknown actor and extra fields are refused and nothing is written', (t) => {
  const { env, send, events } = rig(t);
  const refused = send({ op: 'add', address: 'a@example.com' }, AGENT);
  assert.equal(refused['ok'], false);
  assert.equal(refused['code'], 'not_human');
  assert.equal(send({ op: 'suppress', address: 'a@example.com' }, AGENT)['code'], 'not_human');
  assert.equal(send({ op: 'import', text: 'a@example.com' }, AGENT)['code'], 'not_human');
  assert.equal(send({ op: 'add', address: 'a@example.com' }, 'nobody')['code'], 'unknown_actor');
  assert.equal(send({ op: 'add', address: 'a@example.com', status: 'active' })['code'], 'invalid_request');
  assert.equal(send({ op: 'delete', address: 'a@example.com' })['code'], 'unknown_op');
  assert.equal(listContacts(env.db).length, 0);
  assert.equal(events().length, 0);
});

test('suppress needs no TOTP, works for known and never-seen addresses, and the address can never be re-added', (t) => {
  const { env, send, events } = rig(t);
  send({ op: 'add', address: 'a@example.com' });
  assert.deepEqual(send({ op: 'suppress', address: 'A@example.com' }), { ok: true, address: 'a@example.com', applied: true });
  assert.equal(send({ op: 'suppress', address: 'a@example.com' })['applied'], false);
  assert.equal(send({ op: 'suppress', address: 'new@example.com' })['applied'], true);
  const rows = listContacts(env.db).map((r) => [r.address, r.status, r.suppressed_by]);
  assert.deepEqual(rows, [['a@example.com', 'suppressed', OWNER], ['new@example.com', 'suppressed', OWNER]]);
  assert.equal(send({ op: 'add', address: 'a@example.com' })['code'], 'suppressed');
  assert.equal(listContacts(env.db)[0]!.status, 'suppressed');
  assert.deepEqual(events().map((e) => e.type), ['contact.added', 'contact.suppressed', 'contact.suppressed']);
});

test('import reads CSV or one address per line, skips comments and the header, and is all-or-nothing', (t) => {
  const { env, send, events } = rig(t);
  send({ op: 'suppress', address: 'blocked@example.com' });
  const text = '﻿address,label\nA@Example.com,"김 고객"\n# comment\n\nb@example.com\nblocked@example.com,x\na@example.com\n';
  assert.deepEqual(send({ op: 'import', text }), { ok: true, added: 2, existing: 1, suppressed: 1 });
  assert.deepEqual(listContacts(env.db).map((r) => [r.address, r.label, r.status]), [
    ['a@example.com', '김 고객', 'active'], ['b@example.com', null, 'active'], ['blocked@example.com', null, 'suppressed'],
  ]);
  assert.equal(events().at(-1)!.type, 'contact.imported');
  const before = listContacts(env.db).length;
  const bad = send({ op: 'import', text: 'ok@example.com\nbroken-line\nalso@bad' });
  assert.equal(bad['code'], 'bad_import');
  assert.deepEqual(bad['errors'], ['2번째 줄: 이메일 주소로 읽을 수 없습니다', '3번째 줄: 이메일 주소로 읽을 수 없습니다']);
  assert.equal(listContacts(env.db).length, before, 'a bad line imports nothing');
  assert.equal(send({ op: 'import', text: '  \n# only a comment' })['code'], 'bad_import');
  assert.equal(parseContactImport('x@example.com,').lines[0]!.label, null);
});

test('list shows the counts', (t) => {
  const { send } = rig(t);
  send({ op: 'add', address: 'a@example.com' });
  send({ op: 'suppress', address: 'b@example.com' });
  const listed = send({ op: 'list' });
  assert.equal(listed['active'], 1);
  assert.equal(listed['suppressed'], 1);
});
