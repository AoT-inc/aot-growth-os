// 반송·불만 반영 (ADR-0017 §5): 좁히기만 한다, 새 연락처 행을 만들지 않는다, 감사 기록은 항상 남는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMailFeedback } from '@aot/domain';

import { addContact, contactRow, eventsOf } from '../support/mail.ts';
import { seededDb } from '../support/seeded-db.ts';

test('a hard bounce suppresses an existing active contact as the host (suppressed_by NULL) and writes an audit event', (t) => {
  const { db, clock } = seededDb(t);
  addContact(db, clock, 'customer@example.com');
  clock.advance(1000);
  const result = applyMailFeedback(db, clock, { kind: 'hard_bounce', address: 'Customer@Example.com', detail: 'envelope:smtp_550_5.1.1' });
  assert.deepEqual(result, { applied: true });
  const row = contactRow(db, 'customer@example.com')!;
  assert.deepEqual([row.status, row.suppressed_by, row.suppressed_at, row.added_by], ['suppressed', null, clock.nowIso(), 'actor-owner']);
  const events = eventsOf(db, 'mail.feedback.hard_bounce');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source, 'mail');
  assert.equal(events[0]!.external_id, 'customer@example.com');
  assert.deepEqual(JSON.parse(events[0]!.payload), { kind: 'hard_bounce', address: 'customer@example.com', detail: 'envelope:smtp_550_5.1.1', applied: true });
});

test('an address that is not in the contact table is only recorded: no contact row is created', (t) => {
  const { db, clock } = seededDb(t);
  const result = applyMailFeedback(db, clock, { kind: 'complaint', address: 'stranger@example.com' });
  assert.deepEqual(result, { applied: false });
  assert.equal(contactRow(db, 'stranger@example.com'), undefined);
  assert.equal(eventsOf(db, 'mail.feedback.complaint').length, 1);
  assert.equal(db.get('SELECT count(*) AS n FROM contact')?.['n'], 0);
});

test('an already suppressed contact is not touched (narrowing only), but the event is still written; each event has its own idempotency key', (t) => {
  const { db, clock } = seededDb(t);
  addContact(db, clock, 'gone@example.com', 'suppressed');
  const before = contactRow(db, 'gone@example.com');
  clock.advance(5000);
  assert.deepEqual(applyMailFeedback(db, clock, { kind: 'unsubscribe', address: 'gone@example.com' }), { applied: false });
  assert.deepEqual(contactRow(db, 'gone@example.com'), before);
  applyMailFeedback(db, clock, { kind: 'unsubscribe', address: 'gone@example.com' });
  const events = eventsOf(db, 'mail.feedback.unsubscribe');
  assert.equal(events.length, 2);
  assert.notEqual(events[0]!.idempotency_key, events[1]!.idempotency_key);
});

test('an unusable address records nothing; an unknown kind is refused; the detail is bounded', (t) => {
  const { db, clock } = seededDb(t);
  assert.deepEqual(applyMailFeedback(db, clock, { kind: 'hard_bounce', address: 'not an address' }), { applied: false });
  assert.equal(db.get("SELECT count(*) AS n FROM event WHERE source = 'mail'")?.['n'], 0);
  assert.throws(() => applyMailFeedback(db, clock, { kind: 'spam' as never, address: 'a@example.com' }), /unknown kind/);
  applyMailFeedback(db, clock, { kind: 'hard_bounce', address: 'a@example.com', detail: 'x'.repeat(1000) });
  assert.equal((JSON.parse(eventsOf(db, 'mail.feedback.hard_bounce')[0]!.payload) as { detail: string }).detail.length, 200);
});
