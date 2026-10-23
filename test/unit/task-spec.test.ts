// task_spec 스키마 검증 (docs/schema/task-spec.md): 문서의 예시는 통과하고, "생성 거부 조건" 은 거부한다.
import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { contentHash, MAX_EXPECTED_QUOTE_CHARS, MAX_EXPECTED_QUOTES, MAX_EXPECTED_QUOTES_PER_SOURCE, resolveExpectedQuotes, validateTaskSpec, type Issue } from '@aot/domain';
import { taskSubject, taskSubjectHash } from '@aot/policy';

import { marketResearchExample, minimalDraft, productRegistrationTemplate, sourceQuoteExample } from '../support/spec-fixtures.ts';

const draft = (input: unknown) => validateTaskSpec(input, 'draft');
const errorsOf = (input: unknown, stage: 'draft' | 'stored' = 'draft'): Issue[] => {
  const result = stage === 'draft' ? draft(input) : validateTaskSpec(input, 'stored');
  assert.equal(result.ok, false, 'expected the spec to be rejected');
  return result.ok ? [] : result.errors;
};
const has = (errors: Issue[], path: string, code?: string) =>
  errors.some((e) => e.path === path && (code === undefined || e.code === code));

test('the documented examples are valid drafts (market research example, product-registration template)', () => {
  assert.deepEqual(draft(marketResearchExample()), { ok: true, value: marketResearchExample() });
  assert.equal(draft(productRegistrationTemplate()).ok, true);
  assert.equal(draft(minimalDraft()).ok, true);
});

test('the documented source-quote example (expected_quotes) is a valid draft', () => {
  assert.deepEqual(draft(sourceQuoteExample()), { ok: true, value: sourceQuoteExample() });
});

describe('expected_quotes', () => {
  const withQuotes = (expected_quotes: unknown, deterministic: string[] = ['quote_in_source'], inputs: unknown = [
    { name: 'notes', ref: 'https://docs.example.com/notes', kind: 'source_url' }, { name: 'price', ref: 'https://docs.example.com/price', kind: 'source_url' },
  ]) => ({ ...minimalDraft(), inputs, expected_quotes, validation: { deterministic, llm: null, human: false } });

  it('is optional; a list of {source, text} whose source names a source_url input is accepted and resolved to the input URL', () => {
    assert.equal(draft(minimalDraft()).ok, true);
    const spec = withQuotes([{ source: 'notes', text: ' supports single sign-on ' }, { source: 'price', text: 'billed annually' }]);
    assert.equal(draft(spec).ok, true);
    assert.deepEqual(resolveExpectedQuotes(spec as never), [
      { source: 'notes', url: 'https://docs.example.com/notes', text: 'supports single sign-on' },
      { source: 'price', url: 'https://docs.example.com/price', text: 'billed annually' },
    ]);
    assert.equal(draft(withQuotes([])).ok, true, 'an empty list is allowed (and then needs no quote_in_source)');
  });

  it('rejects: not an array, entries that are not {source, text}, empty or blank text/source, unknown keys', () => {
    assert.ok(has(errorsOf(withQuotes('x')), 'expected_quotes', 'type'));
    assert.ok(has(errorsOf(withQuotes(['x'])), 'expected_quotes[0]', 'type'));
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes', text: '' }])), 'expected_quotes[0].text', 'required'));
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes', text: '   ' }])), 'expected_quotes[0].text', 'required'));
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes' }])), 'expected_quotes[0].text', 'required'));
    assert.ok(has(errorsOf(withQuotes([{ text: 'x' }])), 'expected_quotes[0].source', 'required'));
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes', text: 'x', ref: 'y' }])), 'expected_quotes[0].ref', 'unknown_field'));
  });

  it('rejects a source that names no source_url input (a quote input, a missing name, a differently kinded input), and an ambiguous one', () => {
    assert.ok(has(errorsOf(withQuotes([{ source: 'ghost', text: 'x' }])), 'expected_quotes[0].source', 'unknown_source'));
    const wrongKind = [{ name: 'notes', ref: 'https://docs.example.com/notes', kind: 'document' }];
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes', text: 'x' }], ['quote_in_source'], wrongKind)), 'expected_quotes[0].source', 'unknown_source'));
    const twice = [{ name: 'notes', ref: 'https://docs.example.com/a', kind: 'source_url' }, { name: 'notes', ref: 'https://docs.example.com/b', kind: 'source_url' }];
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes', text: 'x' }], ['quote_in_source'], twice)), 'expected_quotes[0].source', 'ambiguous_source'));
  });

  it('bounds: text length, quotations per source and in total; duplicates (whitespace-insensitive, per source) are rejected', () => {
    assert.equal(draft(withQuotes([{ source: 'notes', text: 'x'.repeat(MAX_EXPECTED_QUOTE_CHARS) }])).ok, true);
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes', text: 'x'.repeat(MAX_EXPECTED_QUOTE_CHARS + 1) }])), 'expected_quotes[0].text', 'too_long'));
    const many = (n: number, source = 'notes') => Array.from({ length: n }, (_, i) => ({ source, text: `sentence ${i}` }));
    assert.equal(draft(withQuotes(many(MAX_EXPECTED_QUOTES_PER_SOURCE))).ok, true);
    assert.ok(has(errorsOf(withQuotes(many(MAX_EXPECTED_QUOTES_PER_SOURCE + 1))), `expected_quotes[${MAX_EXPECTED_QUOTES_PER_SOURCE}].source`, 'too_many'));
    const sources = Array.from({ length: MAX_EXPECTED_QUOTES / MAX_EXPECTED_QUOTES_PER_SOURCE + 1 }, (_, i) => ({ name: `s${i}`, ref: `https://docs.example.com/${i}`, kind: 'source_url' }));
    const spread = sources.flatMap((s) => many(MAX_EXPECTED_QUOTES_PER_SOURCE, s.name));
    assert.ok(spread.length > MAX_EXPECTED_QUOTES);
    assert.ok(has(errorsOf(withQuotes(spread, ['quote_in_source'], sources)), 'expected_quotes', 'too_many'));
    const dup = [{ source: 'notes', text: 'one  sentence' }, { source: 'price', text: 'one sentence' }, { source: 'notes', text: ' one sentence ' }];
    const errors = errorsOf(withQuotes(dup));
    assert.ok(has(errors, 'expected_quotes[2]', 'duplicate'));
    assert.ok(!has(errors, 'expected_quotes[1]'), 'the same sentence for another source is fine');
  });

  it("needs 'quote_in_source' in validation.deterministic: otherwise nothing would verify the quotations", () => {
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes', text: 'x' }], ['url_reachable'])), 'validation.deterministic', 'check_required'));
    assert.ok(has(errorsOf(withQuotes([{ source: 'notes', text: 'x' }], [])), 'validation.deterministic', 'check_required'));
  });

  it('is part of the approved hash: adding, removing or changing a quotation changes the task subject hash (re-approval is required)', () => {
    const task = { id: 't1', role_id: null, role_version: null, product_id: null } as never;
    const hashOf = (spec: unknown) => taskSubjectHash(taskSubject(task, spec as never, 'pv-1'));
    const base = withQuotes([{ source: 'notes', text: 'one' }]);
    assert.notEqual(hashOf(base), hashOf(withQuotes([{ source: 'notes', text: 'two' }])));
    assert.notEqual(hashOf(base), hashOf(withQuotes([{ source: 'notes', text: 'one' }, { source: 'price', text: 'one' }])));
    assert.notEqual(hashOf(base), hashOf({ ...base, expected_quotes: undefined }));
    assert.equal(hashOf(base), hashOf(withQuotes([{ source: 'notes', text: 'one' }])));
    assert.notEqual(contentHash(base), contentHash(withQuotes([{ source: 'notes', text: 'two' }])));
  });
});

test('a non-object is rejected at the root', () => {
  for (const bad of [null, 'text', 42, [], [{}]]) assert.ok(has(errorsOf(bad), '', 'type'));
});

test('rejected: empty objective', () => {
  for (const objective of ['', '   ', undefined, 7]) {
    const spec = { ...minimalDraft(), objective };
    assert.ok(has(errorsOf(spec), 'objective', 'required'), String(objective));
  }
});

test('rejected: trigger without ref, or with a kind outside event|routine|manual|task', () => {
  assert.ok(has(errorsOf({ ...minimalDraft(), trigger: { kind: 'manual' } }), 'trigger.ref', 'required'));
  assert.ok(has(errorsOf({ ...minimalDraft(), trigger: { kind: 'webhook', ref: 'x' } }), 'trigger.kind', 'enum'));
  assert.ok(has(errorsOf({ ...minimalDraft(), trigger: undefined }), 'trigger', 'required'));
  for (const kind of ['event', 'routine', 'manual', 'task']) {
    assert.equal(draft({ ...minimalDraft(), trigger: { kind, ref: 'r' } }).ok, true, kind);
  }
});

test('rejected: an input without a source', () => {
  const errors = errorsOf({ ...minimalDraft(), inputs: [{ name: 'a', kind: 'doc' }, { name: 'b', ref: 'x', kind: 'doc' }] });
  assert.ok(has(errors, 'inputs[0].ref', 'required'));
  assert.ok(!errors.some((e) => e.path.startsWith('inputs[1]')));
  assert.ok(has(errorsOf({ ...minimalDraft(), inputs: 'none' }), 'inputs', 'required'));
});

test('dependencies: optional list of unique ids', () => {
  assert.equal(draft({ ...minimalDraft(), dependencies: ['t1', 't2'] }).ok, true);
  assert.ok(has(errorsOf({ ...minimalDraft(), dependencies: ['t1', 't1'] }), 'dependencies[1]', 'duplicate'));
  assert.ok(has(errorsOf({ ...minimalDraft(), dependencies: [''] }), 'dependencies[0]', 'type'));
});

test('allowed_tools: required; entries need tool, operations, scope and impact; scope and impact must be known values', () => {
  const base = minimalDraft();
  assert.equal(draft({ ...base, allowed_tools: [] }).ok, true, 'a task without tools is allowed');
  assert.ok(has(errorsOf({ ...base, allowed_tools: undefined }), 'allowed_tools', 'required'));
  assert.ok(has(errorsOf({ ...base, allowed_tools: [{ tool: 'x' }] }), 'allowed_tools[0].operations', 'required'));
  assert.ok(has(errorsOf({ ...base, allowed_tools: [{ tool: 'x', operations: [] }] }), 'allowed_tools[0].operations', 'required'));
  assert.ok(has(errorsOf({ ...base, allowed_tools: [{ tool: 'x', operations: ['a'], scope: 'world' }] }), 'allowed_tools[0].scope', 'enum'));
  assert.ok(has(errorsOf({ ...base, allowed_tools: [{ tool: 'x', operations: ['a'], impact: 'destroy' }] }), 'allowed_tools[0].impact', 'enum'));
  const full = { tool: 'x', operations: ['a'], scope: 'internal', impact: 'external_effect', target: 'site:staging' };
  assert.equal(draft({ ...base, allowed_tools: [full] }).ok, true);
  const withoutTarget = { tool: 'x', operations: ['a'], scope: 'internal', impact: 'external_effect' };
  assert.equal(draft({ ...base, allowed_tools: [withoutTarget] }).ok, true, 'target stays optional');
});

test('allowed_tools: scope and impact are required, and the reason says what is missing (rejected before any policy decision)', () => {
  const base = minimalDraft();
  const entry = { tool: 'x', operations: ['a'], scope: 'internal', impact: 'read' };
  const noScope = { tool: 'x', operations: ['a'], impact: 'read' };
  const noImpact = { tool: 'x', operations: ['a'], scope: 'internal' };
  const missingScope = errorsOf({ ...base, allowed_tools: [noScope] });
  assert.ok(has(missingScope, 'allowed_tools[0].scope', 'required'));
  assert.match(missingScope.find((e) => e.path === 'allowed_tools[0].scope')!.message, /scope is required .*internal\|customer\|public.* cannot be judged by the policy/);
  const missingImpact = errorsOf({ ...base, allowed_tools: [noImpact] });
  assert.ok(has(missingImpact, 'allowed_tools[0].impact', 'required'));
  assert.match(missingImpact.find((e) => e.path === 'allowed_tools[0].impact')!.message, /impact is required .*read\|write\|delete\|external_effect/);
  assert.equal(errorsOf({ ...base, allowed_tools: [{ tool: 'x', operations: ['a'] }, entry] }).filter((e) => e.code === 'required').length, 2, 'both are reported for the entry that lacks them');
  assert.ok(has(errorsOf({ ...base, allowed_tools: [entry, { ...noScope }] }), 'allowed_tools[1].scope', 'required'));
  // stored 단계에서도 같다 (저장된 명세에 빠져 있으면 통과하지 못한다)
  assert.ok(has(errorsOf({ ...base, allowed_tools: [noScope] }, 'stored'), 'allowed_tools[0].scope', 'required'));
});

test('constraints: network_allowlist must be explicit domains; "*" is forbidden, an empty list means no network', () => {
  const base = minimalDraft();
  assert.ok(has(errorsOf({ ...base, constraints: { network_allowlist: ['*'] } }), 'constraints.network_allowlist[0]', 'wildcard'));
  assert.ok(has(errorsOf({ ...base, constraints: { network_allowlist: ['ok.example.com', ' * '] } }), 'constraints.network_allowlist[1]', 'wildcard'));
  assert.equal(draft({ ...base, constraints: { network_allowlist: [] } }).ok, true);
  assert.ok(has(errorsOf({ ...base, constraints: { network_allowlist: 'docs.example.com' } }), 'constraints.network_allowlist', 'type'));
  assert.ok(has(errorsOf({ ...base, constraints: undefined }), 'constraints', 'required'));
});

test('constraints: publish_scope and data_classes use the documented vocabularies; unknown constraints are rejected, not ignored', () => {
  const base = minimalDraft();
  assert.ok(has(errorsOf({ ...base, constraints: { publish_scope: 'everyone' } }), 'constraints.publish_scope', 'enum'));
  assert.ok(has(errorsOf({ ...base, constraints: { data_classes: ['secret'] } }), 'constraints.data_classes[0]', 'enum'));
  assert.equal(draft({ ...base, constraints: { data_classes: ['internal', 'restricted'], fs_scope: ['repo:example-product:read-only'] } }).ok, true);
  assert.ok(has(errorsOf({ ...base, constraints: { max_cpu: 4 } }), 'constraints.max_cpu', 'unknown_field'));
});

test('rejected: no acceptance criteria', () => {
  assert.ok(has(errorsOf({ ...minimalDraft(), acceptance_criteria: [] }), 'acceptance_criteria', 'required'));
  assert.ok(has(errorsOf({ ...minimalDraft(), acceptance_criteria: undefined }), 'acceptance_criteria', 'required'));
  assert.ok(has(errorsOf({ ...minimalDraft(), acceptance_criteria: ['ok', ' '] }), 'acceptance_criteria[1]', 'type'));
  assert.equal(errorsOf({ ...minimalDraft(), acceptance_criteria: [] }).filter((e) => e.path === 'acceptance_criteria').length, 1);
});

test('rejected: no validation method; each single method is enough', () => {
  const none = { deterministic: [], llm: null, human: false };
  assert.ok(has(errorsOf({ ...minimalDraft(), validation: none }), 'validation', 'no_method'));
  assert.equal(draft({ ...minimalDraft(), validation: { ...none, deterministic: ['budget'] } }).ok, true);
  assert.equal(draft({ ...minimalDraft(), validation: { ...none, human: true } }).ok, true);
  assert.equal(draft({ ...minimalDraft(), validation: { ...none, llm: { check: 'claim_supported_by_source', isolated_context: true } } }).ok, true);
  assert.ok(has(errorsOf({ ...minimalDraft(), validation: { deterministic: ['a'], human: false } }), 'validation.llm', 'required'));
  assert.ok(has(errorsOf({ ...minimalDraft(), validation: { deterministic: ['a'], llm: { isolated_context: true }, human: false } }), 'validation.llm.check', 'required'));
  assert.ok(has(errorsOf({ ...minimalDraft(), validation: undefined }), 'validation', 'required'));
});

test('cost_budget: max_usd is required and non-negative; max_tokens is a positive integer', () => {
  assert.equal(draft({ ...minimalDraft(), cost_budget: { max_usd: 1, max_tokens: 200000 } }).ok, true);
  assert.ok(has(errorsOf({ ...minimalDraft(), cost_budget: {} }), 'cost_budget.max_usd', 'type'));
  assert.ok(has(errorsOf({ ...minimalDraft(), cost_budget: { max_usd: -1 } }), 'cost_budget.max_usd', 'type'));
  assert.ok(has(errorsOf({ ...minimalDraft(), cost_budget: { max_usd: Number.NaN } }), 'cost_budget.max_usd', 'type'));
  assert.ok(has(errorsOf({ ...minimalDraft(), cost_budget: { max_usd: '2' } }), 'cost_budget.max_usd', 'type'));
  assert.ok(has(errorsOf({ ...minimalDraft(), cost_budget: { max_usd: 1, max_tokens: 1.5 } }), 'cost_budget.max_tokens', 'type'));
  assert.ok(has(errorsOf({ ...minimalDraft(), cost_budget: undefined }), 'cost_budget', 'required'));
});

test('optional department/role/product must be non-empty when given (leave them out for an unassigned task)', () => {
  assert.equal(draft({ ...minimalDraft(), department: 'core', role: 'generalist', product: 'example-product' }).ok, true);
  for (const key of ['department', 'role', 'product']) assert.ok(has(errorsOf({ ...minimalDraft(), [key]: '' }), key, 'type'), key);
});

test('draft: fields the system fills cannot be specified by the author', () => {
  const versions = { org_version: 'org-v1', role_version: 1, task_spec_version: 1, strategy_version: null, tool_contract_version: null };
  for (const [field, value] of [['policy_version', 'policy-v1'], ['versions', versions], ['approved_snapshot', { hash: 'x' }]] as const) {
    assert.ok(has(errorsOf({ ...minimalDraft(), [field]: value }), field, 'system_field'), field);
  }
});

test('unknown top-level fields are rejected', () => {
  assert.ok(has(errorsOf({ ...minimalDraft(), priority: 'high' }), 'priority', 'unknown_field'));
});

test('every problem is reported at once, not just the first', () => {
  const errors = errorsOf({ objective: '', trigger: {}, inputs: [{}], allowed_tools: 1, constraints: [], acceptance_criteria: [], validation: [], cost_budget: [] });
  const paths = new Set(errors.map((e) => e.path.split(/[.[]/)[0]));
  for (const key of ['objective', 'trigger', 'inputs', 'allowed_tools', 'constraints', 'acceptance_criteria', 'validation', 'cost_budget']) {
    assert.ok(paths.has(key), `missing error for ${key}`);
  }
});

test('stored stage: policy_version and versions are required and checked; approved_snapshot is optional', () => {
  const versions = { org_version: 'org-v1', role_version: 1, task_spec_version: 1, strategy_version: null, tool_contract_version: null };
  const stored = { ...minimalDraft(), policy_version: 'policy-v1', versions };
  assert.equal(validateTaskSpec(stored, 'stored').ok, true);
  assert.equal(validateTaskSpec({ ...stored, approved_snapshot: { hash: 'abc' } }, 'stored').ok, true);

  const noPolicy = errorsOf({ ...stored, policy_version: undefined }, 'stored');
  assert.ok(has(noPolicy, 'policy_version', 'required'));
  assert.ok(has(errorsOf({ ...minimalDraft(), policy_version: 'policy-v1' }, 'stored'), 'versions', 'required'));
  assert.ok(has(errorsOf({ ...stored, versions: { ...versions, role_version: undefined } }, 'stored'), 'versions.role_version', 'type'));
  assert.ok(has(errorsOf({ ...stored, versions: { ...versions, extra: 1 } }, 'stored'), 'versions.extra', 'unknown_field'));
  assert.ok(has(errorsOf({ ...stored, approved_snapshot: 'x' }, 'stored'), 'approved_snapshot', 'type'));
  // 저장 단계에서도 본문 규칙은 그대로 적용된다
  assert.ok(has(errorsOf({ ...stored, acceptance_criteria: [] }, 'stored'), 'acceptance_criteria', 'required'));
});
