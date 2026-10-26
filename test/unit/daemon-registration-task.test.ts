// 상품 등록 검증 업무 명세(apps/daemon/src/registration-task.ts)는 workflows/product-registration.md §3 의 템플릿과 같아야 한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { validateTaskSpec } from '@aot/domain';

import { buildRegistrationTaskSpec, registrationTriggerRef } from '../../apps/daemon/src/registration-task.ts';
import { REPO_ROOT } from '../support/schema-snapshot.ts';

const template = (): Record<string, unknown> => {
  const markdown = readFileSync(`${REPO_ROOT}/workflows/product-registration.md`, 'utf8');
  const block = /```json\n([\s\S]*?)\n```/.exec(markdown)?.[1];
  assert.ok(block !== undefined, 'the template holds a json block');
  return JSON.parse(block) as Record<string, unknown>;
};

test('the code spec is the document template with the slug filled in (no drift between them)', () => {
  assert.deepEqual(buildRegistrationTaskSpec('example-product'), template());
});

test('only the slug varies; the tools, targets and validation are fixed', () => {
  const spec = buildRegistrationTaskSpec('another-product') as { allowed_tools: { target: string; impact: string }[]; trigger: { ref: string }; validation: { human: boolean; llm: unknown } };
  assert.ok(spec.allowed_tools.every((tool) => tool.target === 'repo:another-product' && tool.impact === 'read'));
  assert.equal(spec.trigger.ref, registrationTriggerRef('another-product'));
  assert.equal(spec.validation.human, true);
  assert.ok(spec.validation.llm !== null);
  assert.throws(() => buildRegistrationTaskSpec('Not A Slug'), /slug/);
  assert.throws(() => buildRegistrationTaskSpec('../escape'), /slug/);
});

test('the spec is a valid draft', () => {
  const checked = validateTaskSpec(buildRegistrationTaskSpec('example-product'), 'draft');
  assert.ok(checked.ok, checked.ok ? '' : JSON.stringify(checked.errors));
});
