import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { applyMigrations, openDb, systemClock, type Db } from '@aot/domain';

import { makeTempDir } from './temp.ts';

const MIGRATION = `
CREATE TABLE claim_item (id INTEGER PRIMARY KEY, owner TEXT, claimed_at TEXT);
CREATE TABLE claim_counter (n INTEGER NOT NULL);
INSERT INTO claim_counter (n) VALUES (0);
`;

/** 임시 파일 DB 를 만들고 마이그레이션 러너로 시험용 테이블을 만든다. */
export function createClaimDb(t: TestContext, itemCount: number): { dbPath: string; db: Db } {
  const dir = makeTempDir(t);
  const migrations = join(dir, 'migrations');
  mkdirSync(migrations);
  writeFileSync(join(migrations, '0001_claim.sql'), MIGRATION);
  const dbPath = join(dir, 'test.db');
  const db = openDb({ path: dbPath });
  t.after(() => db.close());
  applyMigrations(db, { dir: migrations, clock: systemClock });
  db.writeTx((tx) => {
    for (let id = 1; id <= itemCount; id += 1) tx.run('INSERT INTO claim_item (id) VALUES (?)', [id]);
  });
  return { dbPath, db };
}
