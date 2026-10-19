// memory-item 규칙 5: 변동성 높은 종류의 기본 만료 기간은 정책 파라미터(memory.default_validity)다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryItem } from '@aot/domain';
import { memoryDefaultValidity, parsePolicy } from '@aot/policy';

import { OWNER, policyEnv, policyText } from '../support/policy.ts';

test('the policy default validity fills valid_until from observed_at; explicit values and other kinds are untouched', (t) => {
  const env = policyEnv(t);
  const parsed = parsePolicy(policyText((y) => y.replace('default_validity: {}', 'default_validity: {measurement: 30d}')));
  assert.ok(parsed.ok);
  const context = { clock: env.clock, defaultValiditySeconds: memoryDefaultValidity(parsed.value.document) };
  const base = { body: 'example-product signup count', source_ref: 'evidence:1', observed_at: '2026-10-01T00:00:00.000Z', created_by: OWNER };
  const write = (extra: Record<string, unknown>) => env.db.writeTx((tx) => createMemoryItem(tx, { ...base, kind: 'measurement', ...extra }, context));
  assert.equal(write({}).valid_until, '2026-10-31T00:00:00.000Z');
  assert.equal(write({ valid_until: null }).valid_until, null, 'an explicit null means no expiry');
  assert.equal(write({ valid_until: '2026-10-05T00:00:00.000Z' }).valid_until, '2026-10-05T00:00:00.000Z');
  assert.equal(write({ kind: 'fact' }).valid_until, null);
  assert.equal(env.db.writeTx((tx) => createMemoryItem(tx, { ...base, kind: 'measurement' }, { clock: env.clock })).valid_until, null, 'no policy hook, no default');
});
