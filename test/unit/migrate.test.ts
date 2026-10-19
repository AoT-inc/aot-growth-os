import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyMigrations, FakeClock, openDb } from '@aot/domain';

import { makeTempDir } from '../support/temp.ts';

const SCHEMA = join(import.meta.dirname, '../../docs/schema/schema.sql');

function migrationsDir(t: Parameters<typeof makeTempDir>[0]): string {
  const dir = join(makeTempDir(t), 'migrations');
  mkdirSync(dir);
  copyFileSync(SCHEMA, join(dir, '0001_init.sql'));
  return dir;
}

test('docs/schema/schema.sql applies as migration 0001 and later files apply once, in order', (t) => {
  const dir = migrationsDir(t);
  writeFileSync(join(dir, '0002_task_note.sql'), 'ALTER TABLE task ADD COLUMN note TEXT;\n');
  const db = openDb({ path: ':memory:' });
  t.after(() => db.close());
  const clock = new FakeClock('2026-10-19T00:00:00.000Z');

  assert.deepEqual(applyMigrations(db, { dir, clock }), ['0001_init.sql', '0002_task_note.sql']);
  assert.deepEqual(applyMigrations(db, { dir, clock }), [], 'second run is a no-op');
  assert.equal(db.get('SELECT applied_at FROM schema_migration WHERE id = ?', ['0001_init.sql'])?.['applied_at'], '2026-10-19T00:00:00.000Z');
  assert.equal(db.all('PRAGMA foreign_key_check').length, 0);
  assert.equal(db.get('PRAGMA integrity_check')?.['integrity_check'], 'ok');
  assert.ok(db.all('PRAGMA table_info(task)').some((c) => c['name'] === 'note'));
});

test('a failing migration is rolled back completely and stops the run', (t) => {
  const dir = migrationsDir(t);
  writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE ok_table (id INTEGER);\nINSERT INTO missing_table VALUES (1);\n');
  const db = openDb({ path: ':memory:' });
  t.after(() => db.close());
  assert.throws(() => applyMigrations(db, { dir, clock: new FakeClock() }), /missing_table/);
  assert.equal(db.get("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok_table'")?.['n'], 0);
  assert.deepEqual(db.all('SELECT id FROM schema_migration').map((r) => r['id']), ['0001_init.sql']);
});

test('an edited, already-applied migration is detected', (t) => {
  const dir = migrationsDir(t);
  const db = openDb({ path: ':memory:' });
  t.after(() => db.close());
  applyMigrations(db, { dir, clock: new FakeClock() });
  writeFileSync(join(dir, '0001_init.sql'), '-- tampered\n');
  assert.throws(() => applyMigrations(db, { dir, clock: new FakeClock() }), /checksum mismatch/);
});

test('bad file names and duplicate numbers are rejected before anything is applied', (t) => {
  const dir = migrationsDir(t);
  writeFileSync(join(dir, '0001_other.sql'), 'SELECT 1;');
  const db = openDb({ path: ':memory:' });
  t.after(() => db.close());
  assert.throws(() => applyMigrations(db, { dir, clock: new FakeClock() }), /duplicate/);
  rmSync(join(dir, '0001_other.sql'));
  writeFileSync(join(dir, 'oops.sql'), 'SELECT 1;');
  assert.throws(() => applyMigrations(db, { dir, clock: new FakeClock() }), /invalid migration file name/);
  assert.equal(db.get("SELECT count(*) AS n FROM sqlite_master WHERE name = 'task'")?.['n'], 0);
});

test('migration files must not carry their own transaction control', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, '0001_x.sql'), 'BEGIN;\nCREATE TABLE a (id INTEGER);\nCOMMIT;\n');
  const db = openDb({ path: ':memory:' });
  t.after(() => db.close());
  assert.throws(() => applyMigrations(db, { dir, clock: new FakeClock() }), /transactions/);
});
