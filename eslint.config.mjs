// 스타일·정확성 lint + "SQL 에서 현재 시각을 읽지 않는다" 정적 검사.
// 모듈 경계(의존 방향·공개 API·팩 경계)는 ESLint 가 아니라 dependency-cruiser 가 검사한다 (npm run lint:boundaries).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import { SQL_CLOCK_PATTERNS, stripSqlComments } from './packages/domain/src/db/sql-guard.ts';

const nodeGlobals = { process: 'readonly', console: 'readonly' };

/** SQL 문자열(리터럴·템플릿)이 현재 시각 함수를 쓰면 오류. 시각은 Clock 이 파라미터로 넘긴다. */
const noSqlClock = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      clock: 'SQL must not read the current time itself. Pass Clock.nowIso() as a parameter.',
    },
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text !== 'string') return;
      const code = stripSqlComments(text);
      if (SQL_CLOCK_PATTERNS.some((pattern) => pattern.test(code))) context.report({ node, messageId: 'clock' });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked ?? node.value.raw),
    };
  },
};

export default tseslint.config(
  { ignores: ['node_modules/**', 'instance/**', 'plans/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mjs,cjs}'],
    plugins: { aot: { rules: { 'no-sql-clock': noSqlClock } } },
    rules: { 'aot/no-sql-clock': 'error' },
  },
  {
    files: ['**/*.{mjs,cjs}'],
    languageOptions: { globals: { ...nodeGlobals, module: 'writable', require: 'readonly' } },
  },
  {
    // 금지 표현 자체를 정의하거나 거부되는지 시험하는 파일만 예외
    files: ['packages/domain/src/db/sql-guard.ts', 'test/unit/sql-guard.test.ts', 'test/unit/db.test.ts', 'test/unit/no-sql-clock.test.ts'],
    rules: { 'aot/no-sql-clock': 'off' },
  },
);
