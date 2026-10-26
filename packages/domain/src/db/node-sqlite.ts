// `node:sqlite` 를 import 하는 유일한 파일 (경계 규칙 sqlite-driver-only-here).
// 연결은 반드시 openDb() 로 연다. 다른 곳에서 직접 연결하면 PRAGMA 순서·트랜잭션 규칙이 빠진다.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { createDb } from './create-db.ts';
import { connectionPragmas, DEFAULT_BUSY_TIMEOUT_MS } from './pragmas.ts';
import type { Db, DbDriver, Row, RunResult, SqlParams } from './types.ts';

export interface OpenDbOptions {
  /** 파일 경로 또는 ':memory:' */
  path: string;
  busyTimeoutMs?: number;
}

export function openDb(options: OpenDbOptions): Db {
  const inMemory = options.path === ':memory:';
  const raw = new DatabaseSync(options.path);
  try {
    for (const pragma of connectionPragmas(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, inMemory)) {
      raw.exec(pragma);
    }
  } catch (error) {
    raw.close();
    throw error;
  }
  return createDb(nodeSqliteDriver(raw));
}

function nodeSqliteDriver(raw: DatabaseSync): DbDriver {
  // 이름 인자 객체는 첫 인자로, 위치 인자는 펼쳐서 넘긴다.
  const bind = (params: SqlParams): SQLInputValue[] =>
    Array.isArray(params) ? ([...params] as SQLInputValue[]) : ([params] as unknown as SQLInputValue[]);
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, params): RunResult => {
      const result = raw.prepare(sql).run(...bind(params));
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: (sql, params) => raw.prepare(sql).get(...bind(params)) as Row | undefined,
    all: (sql, params) => raw.prepare(sql).all(...bind(params)) as Row[],
    close: () => raw.close(),
  };
}
