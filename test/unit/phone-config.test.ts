// 전화 설정: 환경 변수 이름만 받고 값은 환경에서 읽는다. 잘못된 설정은 시작 때 거부한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { phoneOptionsFromConfig, type PhoneConfig } from '../../apps/daemon/src/phone-config.ts';

const ENV = { AOT_TEST_KEY: 'k-not-real', AOT_TEST_SECRET: 's-not-real' };
const base = (): PhoneConfig => ({
  provider: 'vapi', api_key_env: 'AOT_TEST_KEY', webhook_secret_env: 'AOT_TEST_SECRET', vapi_contract_verified_on: '2026-11-01', phone_numbers: { '+82200000000': 'pn-1' },
});

test('no phone section: nothing is assembled', () => {
  assert.equal(phoneOptionsFromConfig({}), undefined);
  assert.equal(phoneOptionsFromConfig({ phone: null }), undefined);
});

test('a valid section builds the Vapi adapter from environment variables and defaults the listener to loopback', () => {
  const built = phoneOptionsFromConfig({ phone: { ...base(), webhook: { port: 8787 }, grace_ms: 1000 } }, ENV)!;
  assert.equal(built.options.port.name, 'vapi');
  assert.equal(built.options.graceMs, 1000);
  assert.deepEqual(built.webhook, { host: '127.0.0.1', port: 8787, path: '/phone/webhook' });
  assert.equal(phoneOptionsFromConfig({ phone: base() }, ENV)!.webhook, null, 'no listener unless configured');
});

test('startup refuses a missing secret, a secret-looking value instead of a name, unknown keys and providers, bad numbers and bad routes', () => {
  assert.throws(() => phoneOptionsFromConfig({ phone: base() }, {}), /environment variable AOT_TEST_KEY is not set/);
  assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), api_key_env: '' } }, ENV), /must name an environment variable/);
  assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), api_key: 'sk-live' } as never }, ENV), /unknown key 'api_key'/);
  assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), provider: 'retell' as never } }, ENV), /not supported/);
  assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), phone_numbers: { '02-1234': 'pn' } } }, ENV), /E\.164/);
  assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), inbound_routes: [{ id: 'a', target: { kind: 'teleport' } }] } }, ENV), /inbound_routes/);
  assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), webhook: { port: 99999 } } }, ENV), /port/);
});

test('config validation is strict about nested values and keys', () => {
  for (const [patch, pattern] of [
    [{ webhook: null }, /phone\.webhook must be an object/],
    [{ webhook: { prot: 8787, port: 1 } }, /unknown key 'prot'/],
    [{ grace_ms: -1 }, /grace_ms/],
    [{ grace_ms: 'soon' }, /grace_ms/],
    [{ phone_numbers: { '+82200000000': 7 } }, /phone_numbers/],
    [{ assistants: { qualify_lead: '' } }, /assistants/],
    [{ default_assistant_id: 5 }, /default_assistant_id/],
  ] as const) {
    assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), ...patch } as never }, ENV), pattern, JSON.stringify(patch));
  }
});

test('the Vapi contract must have been verified by a manual smoke before the daemon starts with the real provider', () => {
  for (const value of [undefined, '', 'yesterday', '2026-1-1', true]) {
    assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), vapi_contract_verified_on: value as never } }, ENV), /vapi_contract_verified_on/, String(value));
  }
});

test('a listener bound to a non-loopback address must acknowledge that TLS is terminated in front of it', () => {
  for (const host of ['0.0.0.0', '10.0.0.5', '::']) {
    assert.throws(() => phoneOptionsFromConfig({ phone: { ...base(), webhook: { host, port: 8787 } } }, ENV), /does not speak TLS/, host);
  }
  for (const host of ['127.0.0.1', '::1', 'localhost']) assert.equal(phoneOptionsFromConfig({ phone: { ...base(), webhook: { host, port: 8787 } } }, ENV)!.webhook!.host, host);
  assert.equal(phoneOptionsFromConfig({ phone: { ...base(), webhook: { host: '0.0.0.0', port: 8787, allow_insecure: true } } }, ENV)!.webhook!.host, '0.0.0.0');
});
