// 팩 manifest 형식 검증 (ADR-0012 §1). 값이 아니라 형식만 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { validatePackManifest, type Issue } from '@aot/domain';

import { REPO_ROOT } from '../support/schema-snapshot.ts';

const valid = () => ({
  name: 'example-marketing',
  version: '0.0.0',
  requires_core: '>=0.0.0 <1.0.0',
  required_tools: ['web_search'],
  contents: { workflows: 'workflows/', routines: 'routines/', evaluations: 'evaluations/', policy_examples: 'policy-examples/' },
});
const errorsOf = (input: unknown): Issue[] => {
  const result = validatePackManifest(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors;
};
const has = (errors: Issue[], path: string, code: string) => errors.some((e) => e.path === path && e.code === code);

test('packs/example-marketing/manifest.json is a valid manifest', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packs/example-marketing/manifest.json'), 'utf8')) as unknown;
  assert.equal(validatePackManifest(manifest).ok, true);
});

test('a minimal manifest (no contents, no tools) is valid', () => {
  assert.equal(validatePackManifest({ name: 'p', version: '1.2.3', requires_core: '>=1.0.0', required_tools: [] }).ok, true);
  assert.equal(validatePackManifest(valid()).ok, true);
});

test('name, version and requires_core must be well formed', () => {
  assert.ok(has(errorsOf({ ...valid(), name: 'Example Marketing' }), 'name', 'format'));
  assert.ok(has(errorsOf({ ...valid(), name: undefined }), 'name', 'format'));
  assert.ok(has(errorsOf({ ...valid(), version: '1.0' }), 'version', 'format'));
  assert.ok(has(errorsOf({ ...valid(), requires_core: 'latest' }), 'requires_core', 'format'));
  assert.ok(has(errorsOf({ ...valid(), requires_core: '' }), 'requires_core', 'format'));
});

test('required_tools is a list of unique names', () => {
  assert.ok(has(errorsOf({ ...valid(), required_tools: undefined }), 'required_tools', 'required'));
  assert.ok(has(errorsOf({ ...valid(), required_tools: ['a', 'a'] }), 'required_tools[1]', 'duplicate'));
  assert.ok(has(errorsOf({ ...valid(), required_tools: [''] }), 'required_tools[0]', 'type'));
});

test('contents may only name the five pack directories and must stay inside the pack', () => {
  assert.equal(validatePackManifest({ ...valid(), contents: { ...valid().contents, measurement_signals: 'measurement-signals/' } }).ok, true);
  assert.ok(has(errorsOf({ ...valid(), contents: { connectors: 'connectors/' } }), 'contents.connectors', 'unknown_field'));
  assert.ok(has(errorsOf({ ...valid(), contents: { workflows: '../core/' } }), 'contents.workflows', 'path'));
  assert.ok(has(errorsOf({ ...valid(), contents: { workflows: '/etc/' } }), 'contents.workflows', 'path'));
  assert.ok(has(errorsOf({ ...valid(), contents: 'workflows/' }), 'contents', 'type'));
});

test('unknown top-level fields and non-objects are rejected (a pack cannot smuggle in policy or schema)', () => {
  assert.ok(has(errorsOf({ ...valid(), policy: { allow: '*' } }), 'policy', 'unknown_field'));
  assert.ok(has(errorsOf({ ...valid(), schema_changes: ['ALTER TABLE task ...'] }), 'schema_changes', 'unknown_field'));
  assert.ok(has(errorsOf(null), '', 'type'));
  assert.ok(has(errorsOf([]), '', 'type'));
});
