// 메일 설정 (ADR-0017 §8·§9): 환경 변수 이름만 받고 값은 환경에서 읽는다. 잘못된 설정은 시작 때 거부한다.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { mailOptionsFromConfig, type MailConfig } from '../../apps/daemon/src/mail-config.ts';
import { makeTempDir } from '../support/temp.ts';

const ENV = { AOT_TEST_SMTP_USER: 'user-not-real', AOT_TEST_SMTP_PASS: 'pass-not-real' };
const base = (): MailConfig => ({
  provider: 'smtp',
  smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', username_env: 'AOT_TEST_SMTP_USER', password_env: 'AOT_TEST_SMTP_PASS' },
  senders: { support: { address: 'support@sender.example.com' } },
  unsubscribe_mailto: 'unsubscribe@sender.example.com',
});
const patched = (patch: Record<string, unknown>): { mail: MailConfig } => ({ mail: { ...base(), ...patch } as MailConfig });
const smtp = (patch: Record<string, unknown>): { mail: MailConfig } => ({ mail: { ...base(), smtp: { ...base().smtp, ...patch } } as MailConfig });

test('no mail section: nothing is assembled', () => {
  assert.equal(mailOptionsFromConfig({}), undefined);
  assert.equal(mailOptionsFromConfig({ mail: null }), undefined);
});

test('a valid section builds the options with defaults (200 per day, 1s interval) and an SMTP transport', () => {
  const options = mailOptionsFromConfig({ mail: base() }, ENV)!;
  assert.equal(options.transport.name, 'smtp');
  assert.deepEqual(options.transport.idempotency, { supported: false });
  assert.deepEqual(options.senders, { support: { address: 'support@sender.example.com' } });
  assert.equal(options.unsubscribeMailto, 'unsubscribe@sender.example.com');
  assert.equal(options.maxPerDay, 200);
  assert.equal(options.minIntervalMs, 1000);
  assert.equal(options.bounceAddress, undefined);
  const custom = mailOptionsFromConfig(patched({ max_per_day: 5, min_interval_ms: 0, bounce_address: 'bounce@sender.example.com', message_id_domain: 'ids.example.com' }), ENV)!;
  assert.deepEqual([custom.maxPerDay, custom.minIntervalMs, custom.bounceAddress, custom.messageIdDomain], [5, 0, 'bounce@sender.example.com', 'ids.example.com']);
});

test('unknown keys are refused at every level; the provider must be smtp', () => {
  assert.throws(() => mailOptionsFromConfig(patched({ password: 'x' }), ENV), /unknown key 'password'/);
  assert.throws(() => mailOptionsFromConfig(smtp({ password: 'x' }), ENV), /mail\.smtp: unknown key 'password'/);
  assert.throws(() => mailOptionsFromConfig(smtp({ timeouts: { connect: 5 } }), ENV), /timeouts: unknown key 'connect'/);
  assert.throws(() => mailOptionsFromConfig(patched({ senders: { support: { address: 'support@sender.example.com', name: 'x' } } }), ENV), /unknown key 'name'/);
  assert.throws(() => mailOptionsFromConfig(patched({ provider: 'sendgrid' }), ENV), /not supported/);
  assert.throws(() => mailOptionsFromConfig({ mail: 'smtp' as never }, ENV), /must be an object/);
});

test('secrets: both env names or neither; the variables must be set; a literal secret in place of a name is not read as one', () => {
  assert.throws(() => mailOptionsFromConfig(smtp({ password_env: undefined }), ENV), /together/);
  assert.throws(() => mailOptionsFromConfig({ mail: base() }, {}), /environment variable AOT_TEST_SMTP_USER is not set/);
  assert.throws(() => mailOptionsFromConfig({ mail: base() }, { AOT_TEST_SMTP_USER: 'u' }), /AOT_TEST_SMTP_PASS is not set/);
  assert.throws(() => mailOptionsFromConfig(smtp({ username_env: '' }), ENV), /must name an environment variable/);
  const noAuth = mailOptionsFromConfig(smtp({ username_env: undefined, password_env: undefined }), {});
  assert.equal(noAuth!.transport.name, 'smtp');
});

test('startup errors never contain the secret values', () => {
  const messages: string[] = [];
  for (const cfg of [smtp({ security: 'none' }), smtp({ security: 'bogus' }), smtp({ port: 0 }), patched({ senders: {} })]) {
    try { mailOptionsFromConfig(cfg, ENV); } catch (error) { messages.push(String(error)); }
  }
  assert.equal(messages.length, 4);
  for (const message of messages) assert.ok(!message.includes('pass-not-real') && !message.includes('user-not-real'), message);
});

test("security 'none' is only for a loopback host and then credentials are refused", () => {
  const none = (host: string, withCredentials: boolean) => smtp({ host, security: 'none', ...(withCredentials ? {} : { username_env: undefined, password_env: undefined }) });
  for (const host of ['127.0.0.1', '::1', 'localhost']) assert.ok(mailOptionsFromConfig(none(host, false), ENV), host);
  assert.throws(() => mailOptionsFromConfig(none('smtp.example.com', false), ENV), /only allowed for a loopback host/);
  assert.throws(() => mailOptionsFromConfig(none('10.0.0.5', false), ENV), /loopback/);
  assert.throws(() => mailOptionsFromConfig(none('127.0.0.1', true), ENV), /cannot be combined with credentials/);
  assert.throws(() => mailOptionsFromConfig(smtp({ security: 'plain' }), ENV), /starttls/);
});

test('smtp values are validated: host, port, timeouts (total at most 60s), ca_file', (t) => {
  assert.throws(() => mailOptionsFromConfig(smtp({ host: '' }), ENV), /host/);
  assert.throws(() => mailOptionsFromConfig(smtp({ host: 'smtp.example.com/x' }), ENV), /host/);
  for (const port of [0, 65536, 587.5, '587']) assert.throws(() => mailOptionsFromConfig(smtp({ port }), ENV), /port/, String(port));
  assert.throws(() => mailOptionsFromConfig(smtp({ timeouts: { total_ms: 60_001 } }), ENV), /total_ms/);
  assert.throws(() => mailOptionsFromConfig(smtp({ timeouts: { connect_ms: 0 } }), ENV), /connect_ms/);
  assert.ok(mailOptionsFromConfig(smtp({ timeouts: { connect_ms: 5000, command_ms: 10_000, total_ms: 60_000 } }), ENV));
  assert.throws(() => mailOptionsFromConfig(smtp({ ca_file: '/nonexistent/ca.pem' }), ENV), /cannot be read/);
  const dir = makeTempDir(t);
  const file = join(dir, 'ca.pem');
  writeFileSync(file, 'not really a certificate');
  assert.ok(mailOptionsFromConfig(smtp({ ca_file: file }), ENV));
});

test('senders: keys match the target key rule, addresses are normalized, free-mail senders are refused', () => {
  assert.throws(() => mailOptionsFromConfig(patched({ senders: {} }), ENV), /senders/);
  for (const key of ['Support', '-x', 'a_b', 'a'.repeat(33)]) assert.throws(() => mailOptionsFromConfig(patched({ senders: { [key]: { address: 'a@sender.example.com' } } }), ENV), /key/, key);
  for (const address of ['Support@Sender.example.com', 'Name <a@sender.example.com>', 'not-an-address', 5]) {
    assert.throws(() => mailOptionsFromConfig(patched({ senders: { support: { address } } }), ENV), /normalized address/, String(address));
  }
  assert.throws(() => mailOptionsFromConfig(patched({ senders: { support: { address: 'me@gmail.com' } } }), ENV), /free-mail/);
  assert.throws(() => mailOptionsFromConfig(patched({ senders: { support: 'support@sender.example.com' } }), ENV), /must be \{address\}/);
});

test('unsubscribe_mailto is required and normalized; bounce address, message-id domain, limits are validated', () => {
  const noUnsub: Record<string, unknown> = { ...base() };
  delete noUnsub['unsubscribe_mailto'];
  assert.throws(() => mailOptionsFromConfig({ mail: noUnsub as unknown as MailConfig }, ENV), /unsubscribe_mailto is required/);
  assert.throws(() => mailOptionsFromConfig(patched({ unsubscribe_mailto: 'Unsub@Sender.example.com' }), ENV), /unsubscribe_mailto/);
  assert.throws(() => mailOptionsFromConfig(patched({ bounce_address: 'Name <b@sender.example.com>' }), ENV), /bounce_address/);
  assert.throws(() => mailOptionsFromConfig(patched({ message_id_domain: 'Not A Domain' }), ENV), /message_id_domain/);
  for (const value of [0, -1, 1.5, '5']) assert.throws(() => mailOptionsFromConfig(patched({ max_per_day: value }), ENV), /max_per_day/, String(value));
  for (const value of [-1, 1.5, '5']) assert.throws(() => mailOptionsFromConfig(patched({ min_interval_ms: value }), ENV), /min_interval_ms/, String(value));
});
