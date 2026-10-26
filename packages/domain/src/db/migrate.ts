import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Clock } from '../clock.ts';
import type { Db } from './types.ts';

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

const BOOKKEEPING_DDL = `CREATE TABLE IF NOT EXISTS schema_migration (
  id          TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL
)`;

/**
 * `dir` 의 `NNNN_이름.sql` 을 번호순으로 적용한다 (순수 SQL, 자체 러너).
 * - 파일마다 `BEGIN IMMEDIATE` 트랜잭션: 실패하면 그 파일만 통째로 롤백된다. 파일 안에 BEGIN/COMMIT 을 쓰지 않는다.
 * - 적용 여부 확인도 같은 트랜잭션 안에서 하므로 여러 프로세스가 동시에 실행해도 파일당 한 번만 적용된다.
 * - 이미 적용된 파일의 내용이 바뀌었으면(체크섬 불일치) 오류.
 * @returns 이번에 새로 적용한 파일 이름
 */
export function applyMigrations(db: Db, options: { dir: string; clock: Clock }): string[] {
  const files = readdirSync(options.dir).filter((name) => name.endsWith('.sql')).sort();
  const seen = new Set<string>();
  for (const name of files) {
    const match = FILE_PATTERN.exec(name);
    if (!match) throw new Error(`invalid migration file name: ${name} (expected NNNN_name.sql)`);
    if (seen.has(match[1]!)) throw new Error(`duplicate migration number: ${match[1]}`);
    seen.add(match[1]!);
  }

  const applied: string[] = [];
  for (const name of files) {
    const sql = readFileSync(join(options.dir, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    db.writeTx((tx) => {
      tx.exec(BOOKKEEPING_DDL);
      const row = tx.get<{ checksum: string }>('SELECT checksum FROM schema_migration WHERE id = ?', [name]);
      if (row) {
        if (row.checksum !== checksum) throw new Error(`migration checksum mismatch: ${name}`);
        return;
      }
      tx.exec(sql);
      tx.run('INSERT INTO schema_migration (id, checksum, applied_at) VALUES (?, ?, ?)', [
        name,
        checksum,
        options.clock.nowIso(),
      ]);
      applied.push(name);
    });
  }
  return applied;
}
