import { assertSafeSql } from './sql-guard.ts';
import type { Db, DbDriver, SqlParams } from './types.ts';

const NO_PARAMS: SqlParams = [];

/** 드라이버 위에 규칙(IMMEDIATE 전용 쓰기, 시각 함수 금지)을 입힌 `Db` 를 만든다. */
export function createDb(driver: DbDriver): Db {
  let inTx = false;

  const requireTx = (what: string): void => {
    if (!inTx) throw new Error(`${what} requires an open write transaction; use Db.writeTx()`);
  };

  const db: Db = {
    exec(sql) {
      requireTx('exec');
      assertSafeSql(sql);
      driver.exec(sql);
    },
    run(sql, params = NO_PARAMS) {
      requireTx('run');
      assertSafeSql(sql);
      return driver.run(sql, params);
    },
    get(sql, params = NO_PARAMS) {
      assertSafeSql(sql);
      return driver.get(sql, params) as never;
    },
    all(sql, params = NO_PARAMS) {
      assertSafeSql(sql);
      return driver.all(sql, params) as never;
    },
    writeTx(fn) {
      if (inTx) throw new Error('nested writeTx is not supported');
      driver.exec('BEGIN IMMEDIATE');
      inTx = true;
      try {
        const result = fn(db);
        if (isThenable(result)) {
          throw new Error('writeTx callback must be synchronous (it returned a Promise)');
        }
        driver.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          driver.exec('ROLLBACK');
        } catch {
          // COMMIT 실패 등으로 이미 트랜잭션이 없으면 무시하고 원래 오류를 던진다.
        }
        throw error;
      } finally {
        inTx = false;
      }
    },
    get inWriteTx() {
      return inTx;
    },
    close() {
      driver.close();
    },
  };
  return db;
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
