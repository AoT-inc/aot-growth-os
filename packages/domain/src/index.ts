// @aot/domain 공개 API 진입점. 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// A0 에는 기반만 있다: 시계 주입(Clock)과 SQLite 접근 계층(Db). 엔터티·상태 전이·task_spec 검증은 A1.
export { FakeClock, systemClock, type Clock } from './clock.ts';
export { createDb } from './db/create-db.ts';
export { applyMigrations } from './db/migrate.ts';
export { openDb, type OpenDbOptions } from './db/node-sqlite.ts';
export { connectionPragmas, DEFAULT_BUSY_TIMEOUT_MS } from './db/pragmas.ts';
export { assertSafeSql, SQL_CLOCK_PATTERNS, stripSqlComments } from './db/sql-guard.ts';
export type { Db, DbDriver, Row, RunResult, SqlParams, SqlValue } from './db/types.ts';
