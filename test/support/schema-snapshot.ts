// 스키마 비교용 스냅샷. 빈 DB 에 SQL 을 적용한 뒤 sqlite_master 를 정규화해 읽는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrations, FakeClock, openDb, stripSqlComments, type Db } from '@aot/domain';

export const REPO_ROOT = join(import.meta.dirname, '../..');
export const SCHEMA_SQL = join(REPO_ROOT, 'docs/schema/schema.sql');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

export interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

/** 주석을 지우고 공백을 접고 구두점 주변 공백을 없앤다. 서식 차이는 드리프트로 보지 않는다. */
export function normalizeSql(sql: string | null): string {
  return stripSqlComments(sql ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();
}

/** 정규화한 sqlite_master (마이그레이션 기록 테이블 제외, 종류·이름순). */
export function masterSnapshot(db: Db): MasterRow[] {
  return db
    .all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'schema_migration' AND name NOT LIKE 'sqlite_autoindex_schema_migration%'",
    )
    .map((row) => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: normalizeSql(row.sql) }))
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

/** schema.sql 만 적용한 빈 DB 의 스냅샷 */
export function snapshotOfSchemaSql(file = SCHEMA_SQL): MasterRow[] {
  const db = openDb({ path: ':memory:' });
  try {
    const sql = readFileSync(file, 'utf8');
    db.writeTx((tx) => tx.exec(sql));
    return masterSnapshot(db);
  } finally {
    db.close();
  }
}

/** migrations 디렉터리 전체를 적용한 빈 DB 의 스냅샷 */
export function snapshotOfMigrations(dir = MIGRATIONS_DIR): MasterRow[] {
  const db = openDb({ path: ':memory:' });
  try {
    applyMigrations(db, { dir, clock: new FakeClock('2026-10-19T00:00:00.000Z') });
    return masterSnapshot(db);
  } finally {
    db.close();
  }
}

/** 두 스냅샷의 차이를 사람이 읽을 문장으로. 같으면 빈 배열. */
export function diffSnapshots(expected: MasterRow[], actual: MasterRow[]): string[] {
  const key = (r: MasterRow) => `${r.type} ${r.name}`;
  const a = new Map(expected.map((r) => [key(r), r]));
  const b = new Map(actual.map((r) => [key(r), r]));
  const out: string[] = [];
  for (const [k, row] of a) {
    const other = b.get(k);
    if (!other) out.push(`only in schema.sql: ${k}`);
    else if (other.sql !== row.sql || other.tbl_name !== row.tbl_name) out.push(`differs: ${k}`);
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(`only in migrations: ${k}`);
  return out;
}
