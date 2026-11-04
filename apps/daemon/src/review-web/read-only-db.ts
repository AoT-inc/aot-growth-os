// 읽기 전용 DB 보호. `openDb({ readOnly: true })` 가 SQLite 수준에서 쓰기를 막고, 이 껍질이 *코드 수준*에서 한 번 더 막는다
// (쓰기 메서드를 부르면 SQLite 에 닿기 전에 던진다). 검토 화면 코드가 DB 를 바꿀 길은 없다.
import { openDb, type Db } from '@aot/domain';

export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`review-web is read-only: ${what} is not allowed`);
    this.name = 'ReadOnlyViolation';
  }
}

export function applyReadOnlyGuard(db: Db): Db {
  return {
    exec: () => {
      throw new ReadOnlyViolation('exec');
    },
    run: () => {
      throw new ReadOnlyViolation('run');
    },
    writeTx: () => {
      throw new ReadOnlyViolation('writeTx');
    },
    get: (sql, params) => db.get(sql, params),
    all: (sql, params) => db.all(sql, params),
    inWriteTx: false,
    close: () => db.close(),
  };
}

/** 읽기 전용으로 연다: 파일이 없으면 만들지 않고 오류, 쓰기 PRAGMA 없음 */
export function openReadOnlyDb(path: string, busyTimeoutMs?: number): Db {
  return applyReadOnlyGuard(openDb({ path, readOnly: true, ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }) }));
}
