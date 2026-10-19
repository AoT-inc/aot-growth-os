// ADR-0012 §5 스키마 보강: product.kind 와 product_repo 0개 허용.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations, FakeClock, openDb, type Db } from '@aot/domain';

import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';

function freshDb(t: { after(fn: () => void): void }): Db {
  const db = openDb({ path: ':memory:' });
  t.after(() => db.close());
  applyMigrations(db, { dir: MIGRATIONS_DIR, clock: new FakeClock('2026-10-19T00:00:00.000Z') });
  return db;
}

const AT = '2026-10-19T00:00:00.000Z';
const insertProduct = (tx: Db, slug: string, kind: string | null) =>
  tx.run(
    'INSERT INTO product (id, slug, name, kind, lifecycle_stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`p-${slug}`, slug, slug, kind, 'idea', AT, AT],
  );

test('product.kind accepts software|physical|service|other and rejects anything else, including NULL', (t) => {
  const db = freshDb(t);
  for (const kind of ['software', 'physical', 'service', 'other']) {
    db.writeTx((tx) => insertProduct(tx, `example-${kind}`, kind));
  }
  assert.throws(() => db.writeTx((tx) => insertProduct(tx, 'example-bad', 'hardware')), /CHECK constraint/);
  assert.throws(() => db.writeTx((tx) => insertProduct(tx, 'example-null', null)), /NOT NULL/);
});

test('a product may have zero repositories; a repository still needs an existing product', (t) => {
  const db = freshDb(t);
  db.writeTx((tx) => insertProduct(tx, 'example-product', 'service'));
  assert.equal(db.get('SELECT count(*) AS n FROM product_repo WHERE product_id = ?', ['p-example-product'])?.['n'], 0);
  assert.equal(db.get("SELECT registration_status AS s FROM product WHERE slug = 'example-product'")?.['s'], 'candidate');
  assert.throws(
    () => db.writeTx((tx) => tx.run('INSERT INTO product_repo (id, product_id, name) VALUES (?, ?, ?)', ['r1', 'missing', 'x'])),
    /FOREIGN KEY/,
  );
  db.writeTx((tx) => tx.run('INSERT INTO product_repo (id, product_id, name) VALUES (?, ?, ?)', ['r1', 'p-example-product', 'main']));
});
