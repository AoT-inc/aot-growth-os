// task_spec: mail_send 는 보내는 사람 키(target `mail:<키>`)를 반드시 밝힌다 (ADR-0017 §3, phone_target 과 같은 자리).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateTaskSpec } from '@aot/domain';

import { minimalDraft } from '../support/spec-fixtures.ts';

const spec = (target: unknown, tool = 'mail_send') => ({
  ...minimalDraft(),
  allowed_tools: [{ tool, operations: ['send'], scope: 'customer', impact: 'external_effect', ...(target === undefined ? {} : { target }) }],
});

test('a valid sender key target is accepted', () => {
  for (const ok of ['mail:support', 'mail:a', 'mail:sales-team', 'mail:0day', `mail:${'a'.repeat(32)}`]) assert.ok(validateTaskSpec(spec(ok), 'draft').ok, ok);
});

test('mail_send without a target, or with a malformed one, is refused with mail_target', () => {
  for (const bad of [undefined, 'mail:', 'mail:Support', 'mail:-x', 'mail:a_b', 'mail:a b', `mail:${'a'.repeat(33)}`, 'support', 'mailbox:example', 'mail:support@example.com', 5]) {
    const checked = validateTaskSpec(spec(bad), 'draft');
    assert.ok(!checked.ok, String(bad));
    assert.ok(!checked.ok && checked.errors.some((e) => e.code === 'mail_target' && e.path === 'allowed_tools[0].target'), `${String(bad)}: ${JSON.stringify(!checked.ok && checked.errors)}`);
  }
});

test('other tools are unaffected by the mail rule', () => {
  assert.ok(validateTaskSpec(spec(undefined, 'notify-tool'), 'draft').ok);
  assert.ok(validateTaskSpec(spec('mailbox:example', 'notify-tool'), 'draft').ok);
  assert.ok(validateTaskSpec({ ...minimalDraft() }, 'draft').ok);
});
