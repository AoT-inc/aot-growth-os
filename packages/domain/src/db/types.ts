// SQLite 접근 계층의 공개 형태. 드라이버(node:sqlite)는 `DbDriver` 뒤에 숨기고,
// 나머지 코드는 `Db` 만 쓴다 (docs/spikes/q24-sqlite-access-migration.md).

export type SqlValue = string | number | bigint | null | Uint8Array;
/** 위치 인자 배열 또는 이름 인자 객체 */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;
export type Row = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** 드라이버 교체 지점. 구현체는 db/node-sqlite.ts 한 곳뿐이다. */
export interface DbDriver {
  exec(sql: string): void;
  run(sql: string, params: SqlParams): RunResult;
  get(sql: string, params: SqlParams): Row | undefined;
  all(sql: string, params: SqlParams): Row[];
  close(): void;
}

export interface Db {
  /** 쓰기 트랜잭션 안에서만 호출할 수 있다. 여러 문장 허용 (DDL 등). */
  exec(sql: string): void;
  /** 쓰기 트랜잭션 안에서만 호출할 수 있다. */
  run(sql: string, params?: SqlParams): RunResult;
  get<T extends Row = Row>(sql: string, params?: SqlParams): T | undefined;
  all<T extends Row = Row>(sql: string, params?: SqlParams): T[];
  /**
   * `BEGIN IMMEDIATE` 로 시작하는 쓰기 트랜잭션. `fn` 이 정상 반환하면 COMMIT, 예외면 ROLLBACK.
   * `fn` 은 동기 함수여야 한다 (Promise 를 돌려주면 ROLLBACK 후 오류). 중첩 불가.
   * 트랜잭션은 짧게 유지하고 외부 호출을 안에 넣지 않는다.
   */
  writeTx<T>(fn: (tx: Db) => T): T;
  readonly inWriteTx: boolean;
  close(): void;
}
