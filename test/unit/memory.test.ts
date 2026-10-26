// memory_item 신뢰·만료 규칙 (docs/schema/memory-item.md "규칙", "필수 테스트").
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMemoryItem, currentFacts, FakeClock, getMemoryItem, isCurrentFact, listMemoryItems, MemoryRuleError,
  refuteMemoryItem, SEED_IDS, supersedeMemoryItem, sweepExpiredMemory,
  type Db, type MemoryRuleCode, type NewMemoryItem,
} from '@aot/domain';

import { addAgent, seededDb } from '../support/seeded-db.ts';

const HOUR = 3_600_000;

function setup(t: { after(fn: () => void): void }) {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  let n = 0;
  const context = { clock, newId: () => `mem-${++n}` };
  const owner = SEED_IDS.owner;
  const item = (extra: Partial<NewMemoryItem> = {}): NewMemoryItem => ({
    kind: 'fact',
    body: '경쟁사 예시의 월 요금은 정해진 값이다',
    source_ref: 'https://docs.example.com/pricing',
    observed_at: '2026-10-18T00:00:00Z',
    verification_status: 'verified',
    created_by: owner,
    ...extra,
  });
  const add = (extra: Partial<NewMemoryItem> = {}) => db.writeTx((tx) => createMemoryItem(tx, item(extra), context));
  const ids = () => currentFacts(db, { clock }).map((m) => m.id);
  return { db, clock, agent, owner, context, item, add, ids };
}

const rejects = (code: MemoryRuleCode) => (error: unknown) => error instanceof MemoryRuleError && error.code === code;

test('a verified, valid, unexpired item is a current fact; unverified items are not', (t) => {
  const { add, ids } = setup(t);
  const verified = add();
  const unverified = add({ verification_status: 'unverified', kind: 'hypothesis' });
  assert.deepEqual(ids(), [verified.id]);
  assert.ok(!ids().includes(unverified.id));
});

test('refuted items are not current facts but remain readable as past observations', (t) => {
  const { db, add, ids, owner } = setup(t);
  const kept = add();
  const wrong = add({ body: '틀린 주장' });
  db.writeTx((tx) => refuteMemoryItem(tx, wrong.id, owner));
  assert.deepEqual(ids(), [kept.id]);
  const row = getMemoryItem(db, wrong.id);
  assert.equal(row?.verification_status, 'refuted');
  assert.equal(row?.validity, 'refuted');
  assert.ok(listMemoryItems(db).some((m) => m.id === wrong.id), 'still returned by the history listing');
});

test('an item whose valid_until has passed is not a current fact, with or without the stale sweep; the boundary is exclusive', (t) => {
  const { db, clock, add, ids } = setup(t);
  const expiring = add({ valid_until: '2026-10-19T10:00:00Z' });
  const open = add({ valid_until: null });
  clock.set('2026-10-19T09:59:59.999Z');
  assert.deepEqual(ids().sort(), [expiring.id, open.id].sort());
  clock.set('2026-10-19T10:00:00.000Z');
  assert.deepEqual(ids(), [open.id], 'valid_until == now counts as elapsed');
  assert.equal(getMemoryItem(db, expiring.id)?.validity, 'valid', 'not swept yet, but already excluded');

  assert.equal(db.writeTx((tx) => sweepExpiredMemory(tx, clock)), 1);
  assert.equal(getMemoryItem(db, expiring.id)?.validity, 'stale');
  assert.equal(db.writeTx((tx) => sweepExpiredMemory(tx, clock)), 0, 'second sweep changes nothing');
  assert.deepEqual(ids(), [open.id]);
  assert.ok(listMemoryItems(db).some((m) => m.id === expiring.id), 'expired items are kept as history');
});

test('a commitment does not expire by time; it ends only by fulfilment or cancellation', (t) => {
  const { db, clock, add, ids } = setup(t);
  const promise = add({ kind: 'commitment', valid_until: '2026-10-20T00:00:00Z' });
  clock.set('2027-01-01T00:00:00.000Z');
  assert.deepEqual(ids(), [promise.id]);
  assert.equal(db.writeTx((tx) => sweepExpiredMemory(tx, clock)), 0);
  assert.equal(getMemoryItem(db, promise.id)?.validity, 'valid');
});

test('time zone offsets in valid_until are normalised, so string comparison matches real time order', (t) => {
  const { db, clock, add, ids } = setup(t);
  const item = add({ valid_until: '2026-10-19T09:00:00+09:00' }); // = 2026-10-19T00:00:00Z
  assert.equal(getMemoryItem(db, item.id)?.valid_until, '2026-10-19T00:00:00.000Z');
  assert.equal(getMemoryItem(db, item.id)?.observed_at, '2026-10-18T00:00:00.000Z');
  clock.set('2026-10-18T23:59:59.999Z');
  assert.deepEqual(ids(), [item.id]);
  clock.advance(1);
  assert.deepEqual(ids(), []);
  assert.equal(db.writeTx((tx) => sweepExpiredMemory(tx, clock)), 1);
});

test('superseding keeps the old item as history and makes only the new one current', (t) => {
  const { db, add, ids, context, item, owner } = setup(t);
  const old = add({ body: '이전 가격' });
  const next = db.writeTx((tx) => supersedeMemoryItem(tx, old.id, item({ body: '바뀐 가격', created_by: owner }), context));
  assert.deepEqual(ids(), [next.id]);
  const history = listMemoryItems(db);
  assert.ok(history.some((m) => m.id === old.id), 'the old item is not deleted');
  const oldRow = getMemoryItem(db, old.id)!;
  assert.equal(oldRow.superseded_by, next.id);
  assert.equal(oldRow.validity, 'superseded');
  assert.equal(oldRow.body, '이전 가격');
  assert.throws(() => db.writeTx((tx) => supersedeMemoryItem(tx, old.id, item(), context)), rejects('already_superseded'));
  assert.throws(() => db.writeTx((tx) => supersedeMemoryItem(tx, 'missing', item(), context)), rejects('not_found'));
});

test('a rejected replacement leaves the old item untouched (all-or-nothing)', (t) => {
  const { db, add, ids, context, item, owner } = setup(t);
  const old = add();
  assert.throws(
    () => db.writeTx((tx) => supersedeMemoryItem(tx, old.id, item({ source_ref: '', created_by: owner }), context)),
    rejects('source_required'),
  );
  assert.equal(getMemoryItem(db, old.id)?.superseded_by, null);
  assert.deepEqual(ids(), [old.id]);
});

test('agents cannot create a fact (or any kind other than hypothesis)', (t) => {
  const { db, agent, context, item } = setup(t);
  for (const kind of ['fact', 'commitment', 'measurement', 'strategy_record', 'lesson'] as const) {
    assert.throws(() => db.writeTx((tx) => createMemoryItem(tx, item({ kind, created_by: agent, verification_status: 'unverified' }), context)), rejects('agent_kind_forbidden'), kind);
  }
  assert.equal(listMemoryItems(db).length, 0);
  const hypothesis = db.writeTx((tx) => createMemoryItem(tx, item({ kind: 'hypothesis', created_by: agent, verification_status: 'unverified' }), context));
  assert.equal(hypothesis.kind, 'hypothesis');
});

test('agents cannot verify their own hypotheses, so an agent cannot produce a current fact by any route', (t) => {
  const { db, agent, context, item, ids } = setup(t);
  for (const verification_status of ['verified', 'refuted'] as const) {
    assert.throws(() => db.writeTx((tx) => createMemoryItem(tx, item({ kind: 'hypothesis', created_by: agent, verification_status }), context)), rejects('agent_cannot_verify'), verification_status);
  }
  assert.deepEqual(ids(), []);
});

test('agents cannot refute or supersede a non-hypothesis item', (t) => {
  const { db, agent, add, context, item, ids } = setup(t);
  const fact = add();
  assert.throws(() => db.writeTx((tx) => refuteMemoryItem(tx, fact.id, agent)), rejects('agent_kind_forbidden'));
  assert.throws(
    () => db.writeTx((tx) => supersedeMemoryItem(tx, fact.id, item({ kind: 'hypothesis', created_by: agent, verification_status: 'unverified' }), context)),
    rejects('agent_kind_forbidden'),
  );
  assert.deepEqual(ids(), [fact.id]);
  const mine = db.writeTx((tx) => createMemoryItem(tx, item({ kind: 'hypothesis', created_by: agent, verification_status: 'unverified' }), context));
  assert.equal(db.writeTx((tx) => refuteMemoryItem(tx, mine.id, agent)).validity, 'refuted');
});

test('items from external input are stored only as hypothesis / unverified / external_untrusted', (t) => {
  const { db, context, item, owner, ids } = setup(t);
  const stored = db.writeTx((tx) =>
    createMemoryItem(tx, { kind: 'hypothesis', body: '외부 페이지의 주장', source_ref: 'https://docs.example.com/post', observed_at: '2026-10-18T00:00:00Z', trust_origin: 'external_untrusted', created_by: owner }, context),
  );
  assert.equal(stored.kind, 'hypothesis');
  assert.equal(stored.verification_status, 'unverified');
  assert.equal(stored.trust_origin, 'external_untrusted');
  assert.deepEqual(ids(), []);

  const bad: Array<Partial<NewMemoryItem>> = [
    { trust_origin: 'external_untrusted', kind: 'fact', verification_status: 'unverified' },
    { trust_origin: 'external_untrusted', kind: 'hypothesis', verification_status: 'verified' },
    { trust_origin: 'external_untrusted', kind: 'measurement' },
    { trust_origin: 'external_untrusted', kind: 'hypothesis', verification_status: 'refuted' },
  ];
  for (const extra of bad) {
    assert.throws(() => db.writeTx((tx) => createMemoryItem(tx, item({ created_by: owner, ...extra }), context)), rejects('external_must_be_hypothesis'), JSON.stringify(extra));
  }
  assert.equal(listMemoryItems(db).length, 1, 'only the valid external item was stored');
});

test('a source and an observation time are mandatory; other fields are checked too', (t) => {
  const { db, item, context } = setup(t);
  const store = (extra: Partial<NewMemoryItem>) => db.writeTx((tx) => createMemoryItem(tx, item(extra), context));
  assert.throws(() => store({ source_ref: '' }), rejects('source_required'));
  assert.throws(() => store({ source_ref: '   ' }), rejects('source_required'));
  assert.throws(() => store({ observed_at: '' }), rejects('observed_at_required'));
  assert.throws(() => store({ observed_at: 'yesterday' }), rejects('observed_at_required'));
  assert.throws(() => store({ valid_until: 'soon' }), rejects('invalid_field'));
  assert.throws(() => store({ body: ' ' }), rejects('invalid_field'));
  assert.throws(() => store({ kind: 'rumour' as never }), rejects('invalid_field'));
  assert.throws(() => store({ sensitivity: 'secret' as never }), rejects('invalid_field'));
  assert.throws(() => store({ created_by: 'actor-nobody' }), rejects('unknown_actor'));
  assert.equal(listMemoryItems(db).length, 0);
});

test('created_at comes from the injected clock and is distinct from observed_at', (t) => {
  const { clock, add } = setup(t);
  clock.set('2026-10-19T05:00:00.000Z');
  const stored = add({ observed_at: '2026-10-01T00:00:00Z' });
  assert.equal(stored.created_at, '2026-10-19T05:00:00.000Z');
  assert.equal(stored.observed_at, '2026-10-01T00:00:00.000Z');
  assert.equal(stored.sensitivity, 'internal');
  assert.equal(stored.trust_origin, 'internal');
});

test('writes only work inside Db.writeTx', (t) => {
  const { db, item, context } = setup(t);
  assert.throws(() => createMemoryItem(db, item(), context), /write transaction/);
  assert.throws(() => sweepExpiredMemory(db, context.clock), /write transaction/);
});

test('currentFacts filters by product and kind; the pure isCurrentFact agrees with the SQL on every combination', (t) => {
  const { db, clock, add } = setup(t);
  db.writeTx((tx) =>
    tx.run(
      'INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['p1', 'example-product', 'example-product', 'service', 'idea', 'registered', clock.nowIso(), clock.nowIso()],
    ),
  );
  const forProduct = add({ product_id: 'p1' });
  add();
  assert.deepEqual(currentFacts(db, { clock, product_id: 'p1' }).map((m) => m.id), [forProduct.id]);
  assert.deepEqual(currentFacts(db, { clock, kind: 'measurement' }), []);

  // 모든 조합: kind × validity × verification × valid_until(없음/과거/미래)
  const kinds = ['fact', 'commitment', 'hypothesis'] as const;
  const validities = ['valid', 'stale', 'superseded', 'refuted'] as const;
  const verifications = ['unverified', 'verified', 'refuted'] as const;
  const untils = [null, '2026-10-18T00:00:00.000Z', '2026-10-25T00:00:00.000Z'] as const;
  const created: string[] = [];
  let seq = 0;
  for (const kind of kinds) for (const validity of validities) for (const verification_status of verifications) for (const valid_until of untils) {
    const id = `combo-${++seq}`;
    insertRaw(db, id, kind, validity, verification_status, valid_until, clock.nowIso());
    created.push(id);
  }
  const bySql = new Set(currentFacts(db, { clock }).map((m) => m.id));
  for (const id of created) {
    const row = getMemoryItem(db, id)!;
    assert.equal(bySql.has(id), isCurrentFact(row, clock.nowIso()), `${row.kind}/${row.validity}/${row.verification_status}/${row.valid_until}`);
  }
  assert.ok(bySql.size > 0 && bySql.size < created.length);
  // 시계가 흐르면 같은 행의 판정이 바뀐다
  clock.advance(10 * 24 * HOUR);
  const later = new Set(currentFacts(db, { clock }).map((m) => m.id));
  for (const id of created) assert.equal(later.has(id), isCurrentFact(getMemoryItem(db, id)!, clock.nowIso()), id);
});

function insertRaw(db: Db, id: string, kind: string, validity: string, verification: string, validUntil: string | null, at: string): void {
  db.writeTx((tx) =>
    tx.run(
      `INSERT INTO memory_item (id, kind, body, source_ref, observed_at, verification_status, validity, valid_until, created_by, created_at)
       VALUES (?, ?, 'x', 'ref', ?, ?, ?, ?, ?, ?)`,
      [id, kind, at, verification, validity, validUntil, SEED_IDS.owner, at],
    ),
  );
}

test('FakeClock drives expiry across the whole flow (create -> current -> expired -> stale)', (t) => {
  const { db, add } = setup(t);
  const clock = new FakeClock('2026-10-19T00:00:00.000Z');
  const fact = add({ valid_until: '2026-10-19T01:00:00Z' });
  assert.deepEqual(currentFacts(db, { clock }).map((m) => m.id), [fact.id]);
  clock.advance(HOUR);
  assert.deepEqual(currentFacts(db, { clock }), []);
  assert.equal(db.writeTx((tx) => sweepExpiredMemory(tx, clock)), 1);
  assert.equal(getMemoryItem(db, fact.id)?.validity, 'stale');
});
