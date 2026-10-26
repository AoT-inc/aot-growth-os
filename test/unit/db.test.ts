import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connectionPragmas, createDb, openDb, type DbDriver } from '@aot/domain';

import { makeTempDir } from '../support/temp.ts';

test('busy_timeout is set before journal_mode=WAL', () => {
  const pragmas = connectionPragmas(5000, false);
  const busy = pragmas.findIndex((p) => p.includes('busy_timeout'));
  const wal = pragmas.findIndex((p) => p.includes('journal_mode'));
  assert.equal(busy, 0);
  assert.ok(busy < wal, 'busy_timeout must come before journal_mode');
  assert.ok(pragmas.some((p) => p.includes('foreign_keys = ON')));
  assert.ok(!connectionPragmas(5000, true).some((p) => p.includes('journal_mode')));
  assert.throws(() => connectionPragmas(0, false), RangeError);
});

test('opened file database has WAL, busy_timeout and foreign keys applied', (t) => {
  const dir = makeTempDir(t);
  const db = openDb({ path: `${dir}/a.db`, busyTimeoutMs: 1234 });
  t.after(() => db.close());
  assert.equal(db.get('PRAGMA journal_mode')?.['journal_mode'], 'wal');
  assert.equal(db.get('PRAGMA busy_timeout')?.['timeout'], 1234);
  assert.equal(db.get('PRAGMA foreign_keys')?.['foreign_keys'], 1);
});

test('writes outside writeTx are rejected; reads are fine', () => {
  const db = openDb({ path: ':memory:' });
  assert.throws(() => db.exec('CREATE TABLE t (id INTEGER)'), /write transaction/);
  assert.throws(() => db.run('SELECT 1'), /write transaction/);
  assert.equal(db.get('SELECT 1 AS one')?.['one'], 1);
  db.close();
});

test('writeTx commits on success and rolls back on error', () => {
  const db = openDb({ path: ':memory:' });
  db.writeTx((tx) => tx.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'));
  db.writeTx((tx) => tx.run('INSERT INTO t (v) VALUES (?)', ['kept']));
  assert.throws(() =>
    db.writeTx((tx) => {
      tx.run('INSERT INTO t (v) VALUES (:v)', { v: 'lost' });
      throw new Error('boom');
    }),
  /boom/);
  assert.deepEqual(db.all('SELECT v FROM t').map((r) => r['v']), ['kept']);
  assert.equal(db.inWriteTx, false);
  db.close();
});

test('writeTx rejects nesting and async callbacks (and rolls back)', () => {
  const db = openDb({ path: ':memory:' });
  db.writeTx((tx) => tx.exec('CREATE TABLE t (id INTEGER)'));
  assert.throws(() => db.writeTx((tx) => tx.writeTx(() => 1)), /nested/);
  assert.throws(
    () =>
      db.writeTx((tx) => {
        tx.run('INSERT INTO t VALUES (1)');
        return Promise.resolve(1);
      }),
    /synchronous/,
  );
  assert.equal(db.get('SELECT count(*) AS n FROM t')?.['n'], 0);
  db.close();
});

test('SQL that reads the clock or controls transactions never reaches the driver', () => {
  const executed: string[] = [];
  const driver: DbDriver = {
    exec: (sql) => void executed.push(sql),
    run: (sql) => (executed.push(sql), { changes: 0, lastInsertRowid: 0 }),
    get: (sql) => (executed.push(sql), undefined),
    all: (sql) => (executed.push(sql), []),
    close: () => {},
  };
  const db = createDb(driver);
  assert.throws(() => db.get("SELECT datetime('now')"), /current time/);
  db.writeTx((tx) => {
    assert.throws(() => tx.run('UPDATE t SET at = CURRENT_TIMESTAMP'), /current time/);
    assert.throws(() => tx.exec('COMMIT'), /transactions/);
  });
  assert.deepEqual(executed, ['BEGIN IMMEDIATE', 'COMMIT']);
});
