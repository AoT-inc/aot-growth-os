// "SQL 의 현재 시각 함수 금지" 를 막는 세 겹 중 정적 두 겹을 시험한다 (세 번째는 db.test.ts 의 실행 시 가드).
//  1) 저장소의 모든 .sql 파일에 현재 시각 표현이 없다
//  2) ESLint 규칙 aot/no-sql-clock 이 TypeScript 안의 SQL 문자열에서 위반을 잡는다
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { ESLint } from 'eslint';

import { SQL_CLOCK_PATTERNS, stripSqlComments } from '@aot/domain';

const ROOT = join(import.meta.dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'instance', 'plans']);

function* sqlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sqlFiles(join(dir, entry.name));
    } else if (entry.name.endsWith('.sql')) {
      yield join(dir, entry.name);
    }
  }
}

test('no .sql file in the repository reads the current time', () => {
  const files = [...sqlFiles(ROOT)];
  assert.ok(files.some((f) => f.endsWith('docs/schema/schema.sql')), 'schema.sql must be among the scanned files');
  for (const file of files) {
    const code = stripSqlComments(readFileSync(file, 'utf8'));
    for (const pattern of SQL_CLOCK_PATTERNS) {
      assert.ok(!pattern.test(code), `${relative(ROOT, file)} matches ${pattern}`);
    }
  }
});

test('ESLint rule aot/no-sql-clock flags clock functions in SQL strings, and only those', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const lint = async (code: string) =>
    (await eslint.lintText(code, { filePath: join(ROOT, 'packages/task-engine/src/x.ts') }))[0]!.messages
      .filter((m) => m.ruleId === 'aot/no-sql-clock')
      .length;

  assert.equal(await lint("export const q = \"UPDATE task_run SET heartbeat_at = datetime('now')\";\n"), 1);
  assert.equal(await lint('export const q = `SELECT 1 WHERE at < CURRENT_TIMESTAMP`;\n'), 1);
  assert.equal(await lint('export const q = "UPDATE task_run SET heartbeat_at = ?";\n'), 0);
});
