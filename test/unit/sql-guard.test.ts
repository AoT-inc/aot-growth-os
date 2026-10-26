import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSafeSql } from '@aot/domain';

// 이 파일은 금지 표현을 일부러 담는다 (eslint.config.mjs 에서 이 파일만 예외).
const CLOCK_SQL = [
  "SELECT datetime('now')",
  'SELECT CURRENT_TIMESTAMP',
  'select current_date',
  'UPDATE task SET updated_at = now()',
  'SELECT unixepoch()',
  "SELECT strftime('%s')",
  'SELECT julianday( )',
  "SELECT 1 /* ok */ , date('NOW')",
];

for (const sql of CLOCK_SQL) {
  test(`rejects SQL that reads the current time: ${sql}`, () => {
    assert.throws(() => assertSafeSql(sql), /current time/);
  });
}

test('allows time passed as parameter, and the word "now" inside comments', () => {
  assert.doesNotThrow(() => assertSafeSql('UPDATE task SET updated_at = ? WHERE lease_expires_at > ?'));
  assert.doesNotThrow(() => assertSafeSql('SELECT 1 -- datetime now() is forbidden here\n'));
  assert.doesNotThrow(() => assertSafeSql("SELECT datetime(?, '+30 seconds')"));
  assert.doesNotThrow(() => assertSafeSql("SELECT strftime('%s', ?)"));
});

test('rejects caller-controlled transactions', () => {
  for (const sql of ['BEGIN', 'begin deferred', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a', 'RELEASE a', 'SELECT 1; BEGIN IMMEDIATE']) {
    assert.throws(() => assertSafeSql(sql), /transactions/, sql);
  }
});

test('trigger bodies (BEGIN ... END inside CREATE TRIGGER) are allowed', () => {
  assert.doesNotThrow(() =>
    assertSafeSql("CREATE TRIGGER t BEFORE UPDATE ON x BEGIN SELECT RAISE(ABORT, 'append-only'); END;"),
  );
});
