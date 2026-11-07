// 메일 부작용 도구 (ADR-0017 §6): 보내기 직전 재검증과 transport 결과 → 원장 상태 매핑 표의 각 행.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createFakeMailTransport, createMailEffectTool, type FakeMailTransport } from '@aot/agent-runtime';
import { messageIdOf } from '@aot/domain';

import { decodeMail } from '../support/mail-decode.ts';
import { addContact, contactRow, eventsOf, ledgerFixture, mailPayload, SENDER_ADDRESS, SENDERS, UNSUBSCRIBE } from '../support/mail.ts';
import { seededDb } from '../support/seeded-db.ts';

const KEY = 'a'.repeat(64);
const call = (request: unknown = mailPayload(), over: Partial<{ effectKey: string; target: string; action: string }> = {}) =>
  ({ effectKey: KEY, action: 'send', target: 'mail:support', request, ...over });

function rig(t: TestContext, over: { maxPerDay?: number; minIntervalMs?: number; bounceAddress?: string; messageIdDomain?: string } = {}) {
  const env = seededDb(t);
  const transport = createFakeMailTransport();
  const sleeps: number[] = [];
  const tool = createMailEffectTool({
    db: env.db, clock: env.clock, transport, senders: SENDERS, unsubscribeMailto: UNSUBSCRIBE,
    maxPerDay: over.maxPerDay ?? 200, minIntervalMs: over.minIntervalMs ?? 0, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    ...(over.bounceAddress === undefined ? {} : { bounceAddress: over.bounceAddress }),
    ...(over.messageIdDomain === undefined ? {} : { messageIdDomain: over.messageIdDomain }),
  });
  return { ...env, transport, tool, sleeps };
}

const FAILED = { status: 'failed', responseRef: null };

test('declaration: send is a draft action; idempotency comes from the transport; no lookup and no key carrier', (t) => {
  const r = rig(t);
  assert.equal(r.tool.name, 'mail_send');
  assert.deepEqual(r.tool.actions, { send: { approval: 'draft', idempotency: { supported: false } } });
  assert.equal('lookup' in r.tool, false);
  const idem = createMailEffectTool({
    db: r.db, clock: r.clock, transport: createFakeMailTransport({ idempotency: { supported: true, retention_ms: 86_400_000 } }), senders: SENDERS,
    unsubscribeMailto: UNSUBSCRIBE, maxPerDay: 1, minIntervalMs: 0,
  });
  assert.deepEqual(idem.actions['send']!.idempotency, { supported: true, retention_ms: 86_400_000 });
});

test('accepted -> confirmed; response_ref is the Message-ID, or the provider id when there is one; the transport gets the rendered bytes', async (t) => {
  const r = rig(t, { bounceAddress: 'bounce@sender.example.com' });
  const result = await r.tool.send(call());
  const messageId = messageIdOf(KEY, 'sender.example.com');
  assert.deepEqual(result, { status: 'confirmed', responseRef: messageId });
  const [mail] = r.transport.sent;
  assert.equal(r.transport.sent.length, 1);
  assert.equal(mail!.idempotencyKey, KEY);
  assert.equal(mail!.envelopeFrom, 'bounce@sender.example.com');
  assert.deepEqual(mail!.recipients, ['customer@example.com']);
  assert.equal(mail!.messageId, messageId);
  const decoded = decodeMail(mail!.raw);
  assert.equal(decoded.subject, 'Hello');
  assert.equal(decoded.text, 'First line\nSecond line');
  assert.equal(decoded.headers.get('Date'), 'Mon, 19 Oct 2026 00:00:00 +0000');
  assert.equal(decoded.headers.get('Message-ID'), messageId);

  r.transport.script({ status: 'accepted', providerMessageId: 'provider-123' });
  assert.deepEqual(await r.tool.send(call()), { status: 'confirmed', responseRef: 'provider-123' });
});

test('the envelope-from defaults to the sender; the Message-ID domain can be set; cc recipients are in the envelope', async (t) => {
  const r = rig(t, { messageIdDomain: 'ids.example.com' });
  await r.tool.send(call(mailPayload({ cc: ['b@example.com'] })));
  const [mail] = r.transport.sent;
  assert.equal(mail!.envelopeFrom, SENDER_ADDRESS);
  assert.deepEqual(mail!.recipients, ['customer@example.com', 'b@example.com']);
  assert.equal(mail!.messageId, `<${KEY.slice(0, 32)}@ids.example.com>`);
});

test('transport rejected (every stage) -> failed; nothing is thrown', async (t) => {
  const r = rig(t);
  for (const stage of ['connect', 'tls', 'auth', 'envelope', 'data', 'config'] as const) {
    r.transport.script({ status: 'rejected', stage, code: 'x', bouncedRecipients: [] });
    assert.deepEqual(await r.tool.send(call()), FAILED, stage);
  }
  assert.equal(r.transport.sent.length, 6);
});

test('RCPT 5.1.x rejection -> failed and the bounced contact is suppressed by the host with an audit event; other recipients and other rejections are untouched', async (t) => {
  const r = rig(t);
  addContact(r.db, r.clock, 'customer@example.com');
  addContact(r.db, r.clock, 'b@example.com');
  r.transport.script({ status: 'rejected', stage: 'envelope', code: 'smtp_550_5.1.1', bouncedRecipients: ['customer@example.com'] });
  assert.deepEqual(await r.tool.send(call(mailPayload({ cc: ['b@example.com'] }))), FAILED);
  assert.equal(contactRow(r.db, 'customer@example.com')!.status, 'suppressed');
  assert.equal(contactRow(r.db, 'customer@example.com')!.suppressed_by, null);
  assert.equal(contactRow(r.db, 'b@example.com')!.status, 'active', 'the other recipient is not suppressed');
  const events = eventsOf(r.db, 'mail.feedback.hard_bounce');
  assert.equal(events.length, 1);
  assert.match(events[0]!.payload, /envelope:smtp_550_5\.1\.1/);

  // 5.7.x 정책 거절 등 (bouncedRecipients 가 비어 있다) 은 수신 거부로 바꾸지 않는다
  r.transport.script({ status: 'rejected', stage: 'envelope', code: 'smtp_550_5.7.1', bouncedRecipients: [] });
  await r.tool.send(call(mailPayload({ to: ['b@example.com'] }), { effectKey: 'b'.repeat(64) }));
  assert.equal(contactRow(r.db, 'b@example.com')!.status, 'active');
  // transport 가 payload 에 없는 주소를 돌려줘도 반영하지 않는다
  addContact(r.db, r.clock, 'elsewhere@example.com');
  r.transport.script({ status: 'rejected', stage: 'envelope', code: 'smtp_550_5.1.1', bouncedRecipients: ['elsewhere@example.com'] });
  await r.tool.send(call(mailPayload(), { effectKey: 'c'.repeat(64) }));
  assert.equal(contactRow(r.db, 'elsewhere@example.com')!.status, 'active');
});

test('bounce of an address that is not a contact is only recorded (no contact row)', async (t) => {
  const r = rig(t);
  r.transport.script({ status: 'rejected', stage: 'envelope', code: 'smtp_550_5.1.1', bouncedRecipients: ['customer@example.com'] });
  assert.deepEqual(await r.tool.send(call()), FAILED);
  assert.equal(contactRow(r.db, 'customer@example.com'), undefined);
  assert.equal(eventsOf(r.db, 'mail.feedback.hard_bounce').length, 1);
});

test('transport throws (outcome unknown) -> the tool rethrows so the ledger records unknown; no retry inside', async (t) => {
  const r = rig(t);
  r.transport.script({ throws: new Error('smtp data: outcome unknown after end of data (closed)') });
  await assert.rejects(() => r.tool.send(call()), /outcome unknown/);
  assert.equal(r.transport.sent.length, 1);
});

test('re-validation failures return failed without touching the transport: bad payload, other keys, sender mismatch, unknown sender', async (t) => {
  const r = rig(t);
  const cases: [string, unknown, Partial<{ target: string }>][] = [
    ['unknown key', mailPayload({ bcc: ['x@example.com'] }), {}],
    ['two recipients in to', mailPayload({ to: ['a@example.com', 'b@example.com'] }), {}],
    ['no from', Object.fromEntries(Object.entries(mailPayload()).filter(([key]) => key !== 'from')), {}],
    ['not an object', 'text', {}],
    ['from differs from the configured sender', mailPayload({ from: 'other@sender.example.com' }), {}],
    ['unknown sender key', mailPayload(), { target: 'mail:other' }],
    ['target not a mail target', mailPayload(), { target: 'mailbox:example' }],
    ['inherited key', mailPayload(), { target: 'mail:constructor' }],
  ];
  for (const [label, request, over] of cases) assert.deepEqual(await r.tool.send(call(request, over)), FAILED, label);
  assert.equal(r.transport.sent.length, 0);
});

test('an unknown action is a programming error (throws)', async (t) => {
  const r = rig(t);
  await assert.rejects(() => r.tool.send(call(mailPayload(), { action: 'delete' })), /unknown action/);
});

test('a recipient suppressed after the approval -> failed, the transport is not called (to and cc)', async (t) => {
  const r = rig(t);
  addContact(r.db, r.clock, 'customer@example.com', 'suppressed');
  assert.deepEqual(await r.tool.send(call()), FAILED);
  addContact(r.db, r.clock, 'b@example.com', 'suppressed');
  assert.deepEqual(await r.tool.send(call(mailPayload({ to: ['other@example.com'], cc: ['b@example.com'] }), { effectKey: 'd'.repeat(64) })), FAILED);
  assert.equal(r.transport.sent.length, 0);
  // active 인 연락처와 표에 없는 주소는 막지 않는다
  addContact(r.db, r.clock, 'ok@example.com');
  assert.equal((await r.tool.send(call(mailPayload({ to: ['ok@example.com'] }), { effectKey: 'e'.repeat(64) }))).status, 'confirmed');
});

test('daily cap: dispatched/confirmed/unknown rows of the last 24h count (not itself, not failed/planned/other tools/older)', async (t) => {
  const r = rig(t, { maxPerDay: 3 });
  const ledger = ledgerFixture(r.db, r.clock);
  const now = r.clock.nowMs();
  const ago = (hours: number): string => new Date(now - hours * 3_600_000).toISOString();
  ledger.insert('k1', 'confirmed', ago(1));
  ledger.insert('k2', 'dispatched', ago(2));
  ledger.insert('k3', 'failed', ago(1));        // 세지 않는다
  ledger.insert('k4', 'planned', ago(1));       // 세지 않는다
  ledger.insert('k5', 'confirmed', ago(25));    // 24시간 밖
  ledger.insert('k6', 'confirmed', ago(1), 'other_tool');
  // 센 것: k1, k2 = 2 < 3 -> 보낸다
  assert.equal((await r.tool.send(call())).status, 'confirmed');
  // 이 호출 자신(KEY)이 원장에 dispatched 로 있어도 세지 않는다
  ledger.insert(KEY, 'dispatched', ago(0));
  assert.equal((await r.tool.send(call())).status, 'confirmed');
  ledger.insert('k7', 'unknown', ago(3));
  // k1, k2, k7 = 3 >= 3 -> 막는다 (자기 자신 제외)
  const before = r.transport.sent.length;
  assert.deepEqual(await r.tool.send(call()), FAILED);
  assert.equal(r.transport.sent.length, before);
});

test('minimum interval: the next send in the same process waits the remaining time via the injected sleep (it is not rejected)', async (t) => {
  const r = rig(t, { minIntervalMs: 1000 });
  await r.tool.send(call());
  assert.deepEqual(r.sleeps, [], 'the first send does not wait');
  await r.tool.send(call(mailPayload(), { effectKey: 'b'.repeat(64) }));
  assert.deepEqual(r.sleeps, [1000]);
  r.clock.advance(400);
  await r.tool.send(call(mailPayload(), { effectKey: 'c'.repeat(64) }));
  assert.deepEqual(r.sleeps, [1000, 1600], 'the slots are reserved back to back: 2000 - 400');
  r.clock.advance(60_000);
  await r.tool.send(call(mailPayload(), { effectKey: 'd'.repeat(64) }));
  assert.deepEqual(r.sleeps, [1000, 1600]);
  assert.equal(r.transport.sent.length, 4);
});

test('a failed re-validation does not consume an interval slot', async (t) => {
  const r = rig(t, { minIntervalMs: 1000 });
  assert.deepEqual(await r.tool.send(call(mailPayload({ bcc: ['x@example.com'] }))), FAILED);
  await r.tool.send(call());
  assert.deepEqual(r.sleeps, []);
});

test('the transport type is structural: a fake with sent records is a MailTransport', (t) => {
  const transport: FakeMailTransport = createFakeMailTransport();
  assert.equal(transport.name, 'fake-mail');
  void t;
});
