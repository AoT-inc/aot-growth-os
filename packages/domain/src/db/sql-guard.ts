// SQL 문자열 검사. 규칙을 우회하는 SQL 이 접근 계층을 통과하지 못하게 하는 안전망이다.
//  1) 시각은 주입된 Clock 이 SQL 파라미터로 넘긴다 -> SQL 의 현재 시각 함수 금지
//  2) 트랜잭션 제어는 Db.writeTx 만 한다 -> 호출자의 BEGIN/COMMIT/ROLLBACK/SAVEPOINT 금지
// 정규식 기반이라 완전하지 않다. 정적 검사는 eslint.config.mjs 와 test/unit/no-sql-clock.test.ts 가 맡는다.

/** 현재 시각을 암시하는 SQL 표현 (SQLite 기준). */
export const SQL_CLOCK_PATTERNS: readonly RegExp[] = [
  /\bnow\s*\(/i,
  /\bcurrent_(?:timestamp|date|time)\b/i,
  /['"]now['"]/i,
  /\b(?:date|time|datetime|julianday|unixepoch)\s*\(\s*\)/i,
  /\bstrftime\s*\(\s*'[^']*'\s*\)/i,
];

const TX_CONTROL = /^\s*(?:begin|commit|rollback|savepoint|release)\b/i;

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** 위반하면 설명이 담긴 Error 를 던진다. */
export function assertSafeSql(sql: string): void {
  const code = stripSqlComments(sql);
  for (const pattern of SQL_CLOCK_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(
        `SQL must not read the current time (${pattern}); pass Clock.nowIso() as a parameter instead`,
      );
    }
  }
  for (const statement of stripStringLiterals(code).split(';')) {
    if (TX_CONTROL.test(statement)) {
      throw new Error('SQL must not control transactions; use Db.writeTx() (BEGIN IMMEDIATE)');
    }
  }
}
