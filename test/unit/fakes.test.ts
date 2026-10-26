import assert from 'node:assert/strict';
import { test } from 'node:test';

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
  assert.deepEqual(tool.idempotency, { supported: true, retention_ms: 86_400_000 });
});

test('non-idempotent fake tool: every call is a side effect and status cannot be looked up', () => {
  const tool = createNonIdempotentFakeTool();
  tool.call(request);
  tool.call(request);
  assert.deepEqual(tool.idempotency, { supported: false });
  assert.equal(tool.deliveries.length, 2);
  assert.equal(tool.lookup, undefined);
});

test('lost response still leaves the side effect (the "unknown" case)', () => {
  const tool = createNonIdempotentFakeTool();
  tool.loseNextResponses(1);
  assert.throws(() => tool.call(request), FakeToolTimeoutError);
  assert.equal(tool.deliveries.length, 1);
});
