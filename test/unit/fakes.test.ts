import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '@aot/domain';

import { createFakeAdapter } from '../support/fake-adapter.ts';
import {
  createIdempotentFakeTool,
  createNonIdempotentFakeTool,
  FakeToolTimeoutError,
} from '../support/fake-tool.ts';

const request = { effectKey: 'key-1', payload: { to: 'user@example.invalid' } };

test('idempotent fake tool: same key sent N times -> one side effect', () => {
  const tool = createIdempotentFakeTool();
  const first = tool.call(request);
  const again = tool.call(request);
  assert.equal(tool.deliveries.length, 1);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.deliveryId, first.deliveryId);
  assert.equal(tool.lookup?.('key-1')?.deliveryId, first.deliveryId);
});

test('non-idempotent fake tool: every call is a side effect and status cannot be looked up', () => {
  const tool = createNonIdempotentFakeTool();
  tool.call(request);
  tool.call(request);
  assert.equal(tool.supportsIdempotency, false);
  assert.equal(tool.deliveries.length, 2);
  assert.equal(tool.lookup, undefined);
});

test('lost response still leaves the side effect (the "unknown" case)', () => {
  const tool = createNonIdempotentFakeTool();
  tool.loseNextResponses(1);
  assert.throws(() => tool.call(request), FakeToolTimeoutError);
  assert.equal(tool.deliveries.length, 1);
});

test('fake adapter is deterministic and reports ADR-0005 output fields', () => {
  const adapter = createFakeAdapter(new FakeClock('2026-10-19T00:00:00.000Z'), {
    costSteps: [0.01, 0.03],
    evidence: [{ kind: 'note', ref: 'evidence/1' }],
  });
  const input = { taskSpec: {}, allowedTools: ['fake-idempotent-tool'], evidenceRefs: [], budgetUsd: 1 };
  const a = adapter.run(input);
  assert.deepEqual(a, adapter.run(input));
  assert.deepEqual(a.cost, { amount: 0.03, unit: 'USD' });
  assert.deepEqual(a.costProgress, [0.01, 0.03]);
  assert.equal(a.evidence[0]?.observedAt, '2026-10-19T00:00:00.000Z');
});
