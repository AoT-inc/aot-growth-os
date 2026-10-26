// 설계 기준(docs/schema/schema.sql)과 마이그레이션(migrations/)이 어긋나지 않는지 고정한다.
// 결정(2026-10-19): schema.sql 이 단일 원천, migrations/0001 은 그 복사본. 첫 공개 릴리스 전에는 0001 을 함께 직접 고치고,
// 그 뒤에는 새 마이그레이션 + schema.sql 동시 수정.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeTempDir } from '../support/temp.ts';
import {
  diffSnapshots,
  MIGRATIONS_DIR,
  normalizeSql,
  snapshotOfMigrations,
  snapshotOfSchemaSql,
} from '../support/schema-snapshot.ts';

function migrationsCopy(t: Parameters<typeof makeTempDir>[0]): string {
  const dir = join(makeTempDir(t), 'migrations');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  return dir;
}

test('migrations/ applied to an empty DB matches schema.sql applied to an empty DB (sqlite_master)', () => {
  const schema = snapshotOfSchemaSql();
  assert.ok(schema.length > 40, 'snapshot should contain the whole schema (tables, indexes, triggers)');
  assert.deepEqual(diffSnapshots(schema, snapshotOfMigrations()), []);
});

test('the drift check fails when a migration adds something schema.sql lacks', (t) => {
  const dir = migrationsCopy(t);
  writeFileSync(join(dir, '0002_extra.sql'), 'ALTER TABLE task ADD COLUMN note TEXT;\n');
  const diff = diffSnapshots(snapshotOfSchemaSql(), snapshotOfMigrations(dir));
  assert.ok(diff.some((line) => line.includes('table task')), `expected a task table difference, got ${JSON.stringify(diff)}`);
});

test('the drift check fails when schema.sql changes without a migration, and for missing objects', (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, 'schema.sql');
  const original = snapshotOfSchemaSql();
  const edited = (extra: string) => {
    writeFileSync(file, `${extra}\n`);
  };

  edited('CREATE TABLE only_here (id INTEGER PRIMARY KEY);');
  assert.ok(diffSnapshots(snapshotOfSchemaSql(file), original).some((l) => l.startsWith('only in migrations')));
  assert.ok(diffSnapshots(snapshotOfSchemaSql(file), original).some((l) => l.startsWith('only in schema.sql')));
  assert.ok(diffSnapshots(original, snapshotOfSchemaSql(file)).some((l) => l.includes('only_here')));
});

test('formatting and comments are not drift, but a changed CHECK list is', () => {
  assert.equal(
    normalizeSql('CREATE TABLE a (\n  x   TEXT NOT NULL, -- note\n  y INTEGER /* c */\n)'),
    normalizeSql('CREATE TABLE a (x TEXT NOT NULL,y INTEGER)'),
  );
  assert.notEqual(
    normalizeSql("CREATE TABLE a (k TEXT CHECK (k IN ('x','y')))"),
    normalizeSql("CREATE TABLE a (k TEXT CHECK (k IN ('x','y','z')))"),
  );
});

test('migration numbering starts at 0001', () => {
  const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort();
  assert.match(names[0] ?? '', /^0001_/);
});
