// 정책 파일용 YAML 부분집합 (ADR-0013 Amendment): 받는 문법과 거부하는 기능.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseYaml, YamlError } from '@aot/policy';

test('parses block mappings, sequences of mappings, flow lists, scalars and comments', () => {
  const value = parseYaml([
    '# comment',
    'format: aot-policy/v1   # trailing comment',
    'n: 5',
    'f: 0.5',
    'yes_no: [true, false, null, ~]',
    'quoted: ["*:task-own", \'it\'\'s\', "a # b"]',
    'empty: {}',
    'map: {a: 1, b: x}',
    'fm: {id: x, scope: [a, b]}',
    'rules:',
    '  - id: one',
    '    scope: [internal]',
    '  -',
    '    id: two',
    'top:',
    '- plain item',
    'nested:',
    '  inner:',
    '    deep: 1h',
  ].join('\n'));
  assert.deepEqual(value, {
    format: 'aot-policy/v1', n: 5, f: 0.5, yes_no: [true, false, null, null], quoted: ['*:task-own', "it's", 'a # b'],
    empty: {}, map: { a: 1, b: 'x' }, fm: { id: 'x', scope: ['a', 'b'] }, rules: [{ id: 'one', scope: ['internal'] }, { id: 'two' }], top: ['plain item'],
    nested: { inner: { deep: '1h' } },
  });
});

test('rejects YAML features that make policy review harder', () => {
  const cases: [string, RegExp][] = [
    ['a: &x 1', /anchors, aliases/],
    ['a: *x', /anchors, aliases/],
    ['a: !!str 1', /anchors, aliases/],
    ['a: |\n  text', /block scalars/],
    ['a: 1\na: 2', /duplicate key/],
    ['a:\n\tb: 1', /tabs/],
    ['---\na: 1', /multiple documents/],
    ['a: [1, [2]]', /nested flow/],
    ['a: {b: [1, [2]]}', /nested flow/],
    ['a: {b: {c: 1}}', /nested flow/],
    ['a: b: c', /ambiguous/],
    ['a: "unterminated', /unterminated/],
    ['a: 1\n   b: 2', /indentation/],
    ['- a\nb: 1', /expected|indentation|sequence/],
    ['', /empty/],
  ];
  for (const [source, pattern] of cases) {
    assert.throws(() => parseYaml(source), (error: unknown) => error instanceof YamlError && pattern.test(error.message), source);
  }
});
