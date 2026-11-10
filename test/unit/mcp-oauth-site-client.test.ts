// 로그인 위임 사이트 연결 (ADR-0018 개정 1): 설정 줄에는 토큰이 없고 별도 `token` 줄로만 간다. 토큰이 사라지거나 거절되면 그 사이트의 도구만 닫힌다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpSiteClient, type McpAuthPort, type McpSiteEvent } from '@aot/agent-runtime';
import { FakeClock } from '@aot/domain';

import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { FakeConnectorLink, flush, manifestOf, SEARCH_TOOL, UPDATE_TOOL } from '../support/mcp.ts';
import { oauthSiteRaw } from '../support/mcp-oauth.ts';

class FakeAuth implements McpAuthPort {
  token: string | null;
  rejects = 0;
  readonly #listeners = new Set<() => void>();
  constructor(token: string | null) { this.token = token; }
  current(): string | null { return this.token; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  rejected(): void { this.rejects += 1; }
  set(token: string | null): void { this.token = token; for (const l of [...this.#listeners]) l(); }
  get listenerCount(): number { return this.#listeners.size; }
}

function rig(token: string | null) {
  const links: FakeConnectorLink[] = [];
  const events: McpSiteEvent[] = [];
  const auth = new FakeAuth(token);
  const client = createMcpSiteClient({
    manifest: manifestOf(oauthSiteRaw('http://127.0.0.1:1', 'http://127.0.0.1:2/mcp')), clock: new FakeClock(), timers: new ManualGatewayTimers(), auth,
    onEvent: (e) => events.push(e), spawn: () => { const l = new FakeConnectorLink(); links.push(l); return l; },
  });
  return { links, events, auth, client };
}

test('the config line names no token; the access token travels in a separate token line', async () => {
  const r = rig('at-first');
  await r.client.start();
  const [config, token] = r.links[0]!.sent;
  assert.deepEqual(config!['auth'], { kind: 'oauth_delegated' });
  assert.ok(!JSON.stringify(config).includes('at-first'));
  assert.deepEqual(token, { type: 'token', access_token: 'at-first' });
  assert.deepEqual(r.client.stateOf(SEARCH_TOOL), { status: 'open' });
});

test('a refreshed token is passed on without restarting the connector', async () => {
  const r = rig('at-first');
  await r.client.start();
  r.auth.set('at-second');
  await flush();
  assert.equal(r.links.length, 1);
  assert.deepEqual(r.links[0]!.sent.filter((m) => m['type'] === 'token').map((m) => m['access_token']), ['at-first', 'at-second']);
});

test('losing the token closes this site\'s tools (closed:unauthorized) and a new token reopens them', async () => {
  const r = rig('at-first');
  await r.client.start();
  r.auth.set(null);
  await flush();
  assert.deepEqual(r.client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unauthorized' });
  assert.deepEqual(r.client.stateOf(UPDATE_TOOL), { status: 'closed', reason: 'unauthorized' });
  assert.deepEqual(r.links[0]!.sent.filter((m) => m['type'] === 'token').at(-1), { type: 'token', access_token: null });
  r.auth.set('at-new');
  await flush();
  assert.deepEqual(r.client.stateOf(SEARCH_TOOL), { status: 'open' });
});

test('starting without a token closes the tools; a 401 from the site closes them and asks the token source to refresh', async () => {
  const first = rig(null);
  await first.client.start();
  // 커넥터가 auth_required 로 답하는 상황
  const link = first.links[0]!;
  assert.deepEqual(link.sent[1], { type: 'token', access_token: null });
  link.listError = { code: 'auth_required', message: 'no token', definite: true };
  await first.client.refresh();
  assert.deepEqual(first.client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unauthorized' });
  assert.equal(first.auth.rejects, 0, 'a missing token is not a rejection');

  const second = rig('at-first');
  await second.client.start();
  second.links[0]!.listError = { code: 'unauthorized', message: 'HTTP 401', definite: true };
  await second.client.refresh();
  assert.deepEqual(second.client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'unauthorized' });
  assert.equal(second.auth.rejects, 1);
  assert.ok(second.events.some((e) => e.type === 'auth_rejected'));
});

test('an oauth_delegated site cannot be built without a token source; closing unsubscribes', async () => {
  assert.throws(() => createMcpSiteClient({ manifest: manifestOf(oauthSiteRaw('http://127.0.0.1:1', 'http://127.0.0.1:2/mcp')), clock: new FakeClock(), spawn: () => new FakeConnectorLink() }), /needs a token source/);
  const r = rig('at-first');
  await r.client.start();
  assert.equal(r.auth.listenerCount, 1);
  await r.client.close();
  assert.equal(r.auth.listenerCount, 0);
});

test('connector redactor: dynamic secrets are replaced (not accumulated) while the fixed ones stay', async () => {
  const { createRedactor } = await import('../../packages/agent-runtime/src/mcp/connector/redact.ts');
  const redactor = createRedactor(['fixed-secret']);
  redactor.setDynamic(['tok-1', 'tok-2']);
  assert.equal(redactor.text('fixed-secret tok-1 tok-2'), '[redacted] [redacted] [redacted]');
  redactor.setDynamic(['tok-3']);
  assert.equal(redactor.text('fixed-secret tok-1 tok-3'), '[redacted] tok-1 [redacted]');
});
