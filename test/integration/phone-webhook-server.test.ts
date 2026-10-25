// webhook 리스너: 실제 로컬 소켓(127.0.0.1, 임시 포트)으로 경로·메서드·크기 제한과 인증 결과, 인바운드 지시 응답을 확인한다. 외부 접근은 없다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakePhoneProvider } from '@aot/agent-runtime';

import { createPhoneRuntime } from '../../apps/daemon/src/phone.ts';
import { startPhoneWebhookServer } from '../../apps/daemon/src/phone-webhook-server.ts';
import { OUR_NUMBER, TO } from '../support/phone.ts';
import { policyEnv } from '../support/policy.ts';

async function listen(t: Parameters<typeof policyEnv>[0], maxBodyBytes?: number) {
  const env = policyEnv(t);
  const port = createFakePhoneProvider();
  const runtime = createPhoneRuntime({
    db: env.db, clock: env.clock, store: env.store,
    options: { port, inboundRoutes: [{ id: 'closed', target: { kind: 'reject', reason: 'closed' } }] },
  });
  const server = await startPhoneWebhookServer({ runtime, host: '127.0.0.1', port: 0, path: '/phone/test', ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }) });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/phone/test`;
  return { env, port, url, base: `http://127.0.0.1:${server.port}` };
}

test('only POST on the configured path is accepted', async (t) => {
  const { url, base } = await listen(t);
  assert.equal((await fetch(`${base}/other`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'PUT', body: '{}' })).status, 405);
});

test('authentication is the adapter\'s job: a forged request gets 401, a malformed one 400, and nothing is stored', async (t) => {
  const { env, port, url } = await listen(t);
  const forged = port.webhook([{ kind: 'answered', id: 'w-1', call: 'p-1', at: '2026-10-25T01:00:00.000Z' }], { secret: 'wrong' });
  assert.equal((await fetch(url, { method: 'POST', headers: forged.headers as Record<string, string>, body: forged.body })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-fake-secret': 'fake-secret' }, body: '{bad' })).status, 400);
  assert.equal(env.db.all("SELECT 1 FROM event WHERE source = 'phone'").length, 0);
});

test('an oversized body is refused with 413 before it is parsed', async (t) => {
  const { url, port } = await listen(t, 256);
  const big = port.webhook([{ kind: 'speech', id: 'w-2', call: 'p-2', at: '2026-10-25T01:00:00.000Z', lines: [{ who: 'user', said: 'x'.repeat(2000) }] }]);
  const response = await fetch(url, { method: 'POST', headers: big.headers as Record<string, string>, body: big.body });
  assert.equal(response.status, 413, 'the declared content length is checked before any body is read');
});

test('an inbound call over HTTP is answered with the directive in the provider\'s reply format', async (t) => {
  const { env, port, url } = await listen(t);
  const request = port.webhook([{ kind: 'dialing', id: 'w-3', call: 'p-3', at: '2026-10-25T01:00:00.000Z', direction: 'in', from: TO, to: OUR_NUMBER }], { wantsDirective: true });
  const response = await fetch(url, { method: 'POST', headers: request.headers as Record<string, string>, body: request.body });
  assert.equal(response.status, 200);
  const body = await response.json() as { fakeDirective: string };
  assert.equal(body.fakeDirective, 'reject');
  assert.equal(env.db.get<{ status: string }>("SELECT status FROM call WHERE provider_call_id = 'p-3'")?.status, 'cancelled');
});
