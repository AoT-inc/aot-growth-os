// 스키마 고정·인자 검사·서버 주석 충돌 판정·분당 상한 (ADR-0018 §3·§7·§8)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkArguments, createSiteRateLimiter, evaluateTool, hintConflict, parseMcpSite, schemaHash } from '@aot/agent-runtime';
import { FakeClock } from '@aot/domain';

import { schemaHashOf } from '../../packages/agent-runtime/src/mcp/connector/canonical.ts';
import { DRIFTED_UPDATE_SCHEMA, SEARCH_SCHEMA, UPDATE_SCHEMA } from '../fixtures/mcp/fake-server.ts';
import { httpSiteRaw, searchDecl, SEARCH_HASH, updateDecl, UPDATE_HASH } from '../support/mcp.ts';

test('the host hash and the connector hash agree (they are two copies of the same algorithm), and key order does not matter', () => {
  for (const schema of [SEARCH_SCHEMA, UPDATE_SCHEMA, DRIFTED_UPDATE_SCHEMA, null, {}, { b: 1, a: [{ d: 1, c: 2 }] }]) assert.equal(schemaHash(schema), schemaHashOf(schema));
  assert.equal(schemaHash({ a: 1, b: 2 }), schemaHash({ b: 2, a: 1 }));
  assert.notEqual(schemaHash({ a: 1 }), schemaHash({ a: 2 }));
  assert.match(schemaHash({}), /^sha256:[0-9a-f]{64}$/);
});

const manifest = (tools: Record<string, unknown>[]) => parseMcpSite(httpSiteRaw('https://a.example.com/m', { tools }));

test('hint conflict only counts explicit dangerous claims; "safer" claims and silence are ignored', () => {
  assert.equal(hintConflict({ readOnlyHint: false }), true);
  assert.equal(hintConflict({ destructiveHint: true }), true);
  assert.equal(hintConflict({ readOnlyHint: true }), false);
  assert.equal(hintConflict({ destructiveHint: false }), false);
  assert.equal(hintConflict({}), false);
  assert.equal(hintConflict(null), false);
});

test('evaluateTool: open / missing / drift / hint_conflict, in that precedence; ack opens a hint conflict', () => {
  const [read] = manifest([searchDecl()]).tools;
  const ok = { name: 'units_search', inputSchema: SEARCH_SCHEMA, annotations: { readOnlyHint: true } };
  assert.deepEqual(evaluateTool(read!, ok), { status: 'open' });
  assert.deepEqual(evaluateTool(read!, undefined), { status: 'closed', reason: 'missing' });
  assert.deepEqual(evaluateTool(read!, { ...ok, inputSchema: UPDATE_SCHEMA }), { status: 'closed', reason: 'drift' });
  assert.deepEqual(evaluateTool(read!, { ...ok, annotations: { readOnlyHint: false } }), { status: 'closed', reason: 'hint_conflict' });
  assert.deepEqual(evaluateTool(read!, { ...ok, annotations: { destructiveHint: true } }), { status: 'closed', reason: 'hint_conflict' });
  assert.deepEqual(evaluateTool(read!, { ...ok, inputSchema: UPDATE_SCHEMA, annotations: { readOnlyHint: false } }), { status: 'closed', reason: 'drift' });
  const [acked] = manifest([searchDecl({ ack_server_hint_conflict: true })]).tools;
  assert.deepEqual(evaluateTool(acked!, { ...ok, annotations: { readOnlyHint: false } }), { status: 'open' });
});

test('a write declaration never looks at server annotations: "readOnlyHint:true" on a write tool changes nothing', () => {
  const [write] = manifest([updateDecl()]).tools;
  const server = { name: 'unit_update', inputSchema: UPDATE_SCHEMA, annotations: { readOnlyHint: true } };
  assert.deepEqual(evaluateTool(write!, server), { status: 'open' });
  assert.deepEqual(evaluateTool(write!, { ...server, annotations: { readOnlyHint: false, destructiveHint: true } }), { status: 'open' });
  assert.equal(write!.impact, 'external_effect');
  assert.equal(write!.approval, 'draft');
});

test('the idempotency key argument must exist in the pinned schema (checked when the state is decided)', () => {
  const [ok] = manifest([updateDecl({ idempotency: { key_argument: 'request_id', retention_ms: 1000 } })]).tools;
  assert.deepEqual(evaluateTool(ok!, { name: 'unit_update', inputSchema: UPDATE_SCHEMA, annotations: null }), { status: 'open' });
  const [bad] = manifest([updateDecl({ idempotency: { key_argument: 'nonce', retention_ms: 1000 } })]).tools;
  assert.deepEqual(evaluateTool(bad!, { name: 'unit_update', inputSchema: UPDATE_SCHEMA, annotations: null }), { status: 'closed', reason: 'invalid_declaration' });
  assert.equal(UPDATE_HASH, schemaHash(UPDATE_SCHEMA));
  assert.equal(SEARCH_HASH, schemaHash(SEARCH_SCHEMA));
});

test('checkArguments: one level only — unknown keys, missing required, primitive type mismatch, size cap, non-object', () => {
  assert.equal(checkArguments(SEARCH_SCHEMA, { query: 'a' }), null);
  assert.equal(checkArguments(SEARCH_SCHEMA, { query: 'a', limit: 3 }), null);
  assert.match(checkArguments(SEARCH_SCHEMA, { query: 'a', admin: true }) ?? '', /'admin' is not in the pinned input schema/);
  assert.match(checkArguments(SEARCH_SCHEMA, {}) ?? '', /'query' is required/);
  assert.match(checkArguments(SEARCH_SCHEMA, { query: 5 }) ?? '', /'query' must be string/);
  assert.match(checkArguments(SEARCH_SCHEMA, { query: 'a', limit: 1.5 }) ?? '', /'limit' must be integer/);
  assert.match(checkArguments(SEARCH_SCHEMA, ['x']) ?? '', /must be an object/);
  assert.match(checkArguments(SEARCH_SCHEMA, null) ?? '', /must be an object/);
  assert.match(checkArguments(SEARCH_SCHEMA, { query: 'x'.repeat(70_000) }) ?? '', /exceed/);
  assert.match(checkArguments(null, { a: 1 }) ?? '', /not in the pinned input schema/, 'a schema without properties admits no argument');
  assert.equal(checkArguments({ properties: { a: { type: ['string', 'null'] } } }, { a: null }), null);
});

test('rate limiter: capacity, refill over time with an injected clock, clock going backwards adds nothing', () => {
  const clock = new FakeClock();
  const limiter = createSiteRateLimiter(clock, 3);
  assert.deepEqual([limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire()], [true, true, true, false]);
  assert.equal(limiter.waitMs(), 20_000);
  clock.advance(19_999);
  assert.equal(limiter.tryAcquire(), false);
  clock.advance(1);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
  clock.advance(10 * 60_000);
  assert.deepEqual([limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire()], [true, true, true, false], 'refill is capped at the capacity');
  clock.set('2020-01-01T00:00:00.000Z');
  assert.equal(limiter.tryAcquire(), false, 'a clock that goes backwards gives no tokens');
});
