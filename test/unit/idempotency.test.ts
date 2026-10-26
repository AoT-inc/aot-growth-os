// (도구, action) 멱등 선언 검증과 재전송 창 판정 — 순수 함수 시험 (docs/operations/recovery.md §3).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DECLARATION_ERROR_CODES, EFFECT_KEY_CARRIERS, idempotencyWindowOpen, resendAllowed, resolveActionDeclaration, snapshotOf, tightenSnapshot,
  validateEffectToolDeclaration, validateIdempotencyDeclaration,
  type DeclarationErrorCode, type IdempotencyDeclaration,
} from '@aot/task-engine';

const PLANNED = '2026-10-19T00:00:00.000Z';
const at = (elapsedMs: number): string => new Date(Date.parse(PLANNED) + elapsedMs).toISOString();
const lookup = () => ({ found: false as const });

const codeOf = (value: unknown): DeclarationErrorCode | 'ok' => {
  const result = validateIdempotencyDeclaration(value);
  return result.ok ? 'ok' : result.error.code;
};

test('declaration error codes are the closed set the spec names', () => {
  assert.deepEqual([...DECLARATION_ERROR_CODES].sort(), [
    'action_name_invalid', 'action_undeclared', 'actions_missing', 'carrier_invalid', 'carrier_required', 'carrier_without_lookup',
    'name_mismatch', 'not_object', 'retention_forbidden', 'retention_invalid', 'retention_required', 'supported_invalid', 'unknown_field',
  ]);
  assert.deepEqual([...EFFECT_KEY_CARRIERS], ['metadata', 'slug', 'property', 'none']);
});

test('validateIdempotencyDeclaration: valid declarations (no upper bound on retention, D2)', () => {
  for (const value of [{ supported: true, retention_ms: 1 }, { supported: true, retention_ms: 604_800_000 }, { supported: true, retention_ms: Number.MAX_SAFE_INTEGER }, { supported: false }]) {
    const result = validateIdempotencyDeclaration(value, 'send');
    assert.ok(result.ok, JSON.stringify(value));
    assert.deepEqual(result.declaration, value);
  }
  assert.equal(codeOf({ supported: true, retention_ms: 604_800_001 }), 'ok', '7일 상한은 없다');
  assert.equal(codeOf({ supported: true, retention_ms: 2 ** 31 }), 'ok');
});

test('validateIdempotencyDeclaration: rejects with a specific code', () => {
  assert.equal(codeOf({ supported: true }), 'retention_required');
  for (const retention of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', 2 ** 53, null]) {
    assert.equal(codeOf({ supported: true, retention_ms: retention }), 'retention_invalid', String(retention));
  }
  assert.equal(codeOf({ supported: false, retention_ms: 1 }), 'retention_forbidden');
  assert.equal(codeOf({ supported: false, retention_ms: undefined }), 'retention_forbidden', '키가 있으면 값이 undefined 여도 금지');
  assert.equal(codeOf({ supported: 'true', retention_ms: 1 }), 'supported_invalid');
  assert.equal(codeOf({ supported: 1, retention_ms: 1 }), 'supported_invalid');
  for (const value of [null, [], 'x', 1, undefined]) assert.equal(codeOf(value), 'not_object', String(value));
  assert.equal(codeOf({ supported: false, natural: true }), 'unknown_field');
});

test('validateIdempotencyDeclaration: the error carries the action name', () => {
  const result = validateIdempotencyDeclaration({ supported: true }, 'send');
  assert.ok(!result.ok);
  assert.equal(result.error.action, 'send');
  const unnamed = validateIdempotencyDeclaration({ supported: true });
  assert.ok(!unnamed.ok);
  assert.equal(unnamed.error.action, null);
});

test('validateEffectToolDeclaration: actions must be a non-empty plain object with sane names', () => {
  const codes = (actions: unknown) => {
    const result = validateEffectToolDeclaration({ name: 'example-tool', actions });
    return result.ok ? [] : result.errors.map((e) => e.code);
  };
  assert.deepEqual(codes({}), ['actions_missing']);
  assert.deepEqual(codes(null), ['actions_missing']);
  assert.deepEqual(codes([]), ['actions_missing']);
  assert.deepEqual(codes(undefined), ['actions_missing']);
  assert.deepEqual(codes({ '': { idempotency: { supported: false } } }), ['action_name_invalid']);
  assert.deepEqual(codes({ '  ': { idempotency: { supported: false } } }), ['action_name_invalid']);
  assert.deepEqual(codes({ send: { idempotency: { supported: false } } }), []);
});

test('validateEffectToolDeclaration: the key carrier is required exactly when the tool has lookup', () => {
  const idempotency = { supported: true, retention_ms: 1000 };
  for (const carrier of EFFECT_KEY_CARRIERS) {
    assert.deepEqual(validateEffectToolDeclaration({ name: 't', lookup, actions: { send: { idempotency, effect_key_carrier: carrier } } }), { ok: true }, carrier);
  }
  const check = (tool: { lookup?: unknown; actions: unknown }) => {
    const result = validateEffectToolDeclaration({ name: 't', ...tool });
    return result.ok ? [] : result.errors.map((e) => [e.action, e.code]);
  };
  assert.deepEqual(check({ lookup, actions: { send: { idempotency, effect_key_carrier: 'body' } } }), [['send', 'carrier_invalid']]);
  assert.deepEqual(check({ lookup, actions: { send: { idempotency } } }), [['send', 'carrier_required']]);
  assert.deepEqual(check({ actions: { send: { idempotency, effect_key_carrier: 'metadata' } } }), [['send', 'carrier_without_lookup']]);
  assert.deepEqual(check({ actions: { send: { idempotency } } }), []);
});

test('validateEffectToolDeclaration: reports every bad action, not just the first', () => {
  const result = validateEffectToolDeclaration({
    name: 't',
    actions: {
      send: { idempotency: { supported: true } },
      post: { idempotency: { supported: false, retention_ms: 5 } },
      ok: { idempotency: { supported: false } },
      '': { idempotency: { supported: false } },
    },
  });
  assert.ok(!result.ok);
  const found = result.errors.map((e) => [e.action, e.code]).sort();
  assert.deepEqual(found, [['', 'action_name_invalid'], ['post', 'retention_forbidden'], ['send', 'retention_required']].sort());
});

test('resolveActionDeclaration: declared actions resolve; anything else is action_undeclared (own keys only)', () => {
  const tool = { lookup, actions: { send: { idempotency: { supported: true, retention_ms: 1000 }, effect_key_carrier: 'slug' } } };
  const ok = resolveActionDeclaration(tool, 'send');
  assert.ok(ok.ok);
  assert.deepEqual(ok.declaration, tool.actions.send);
  for (const action of ['post', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const result = resolveActionDeclaration(tool, action);
    assert.ok(!result.ok, action);
    assert.equal(result.error.code, 'action_undeclared', action);
  }
  // 같은 규칙 (carrier vs lookup) 이 런타임 해석에도 적용된다
  const noCarrier = resolveActionDeclaration({ lookup, actions: { send: { idempotency: { supported: false } } } }, 'send');
  assert.ok(!noCarrier.ok);
  assert.equal(noCarrier.error.code, 'carrier_required');
});

test('idempotencyWindowOpen: the boundary is inclusive at exactly 50% (r=1000)', () => {
  for (const [elapsed, expected] of [[0, true], [499, true], [500, true], [501, false], [1000, false], [10_000, false]] as const) {
    assert.equal(idempotencyWindowOpen(PLANNED, at(elapsed), 1000), expected, `elapsed ${elapsed}`);
  }
});

test('idempotencyWindowOpen: odd retention uses floor(r/2) (r=1001)', () => {
  assert.equal(idempotencyWindowOpen(PLANNED, at(500), 1001), true);
  assert.equal(idempotencyWindowOpen(PLANNED, at(501), 1001), false);
});

test('idempotencyWindowOpen: D7 boundaries (49.9%, exactly 50%, just past 50%)', () => {
  assert.equal(idempotencyWindowOpen(PLANNED, at(4990), 10_000), true, '49.9%');
  assert.equal(idempotencyWindowOpen(PLANNED, at(5000), 10_000), true, '정확히 50%');
  assert.equal(idempotencyWindowOpen(PLANNED, at(5001), 10_000), false);
});

test('idempotencyWindowOpen: tiny retentions (r=1 opens only at elapsed 0; r=2 up to 1)', () => {
  assert.equal(idempotencyWindowOpen(PLANNED, at(0), 1), true);
  assert.equal(idempotencyWindowOpen(PLANNED, at(1), 1), false);
  assert.equal(idempotencyWindowOpen(PLANNED, at(1), 2), true);
  assert.equal(idempotencyWindowOpen(PLANNED, at(2), 2), false);
});

test('idempotencyWindowOpen: huge retention does not overflow (MAX_SAFE_INTEGER, ten years elapsed)', () => {
  const tenYears = 10 * 365 * 24 * 3600 * 1000;
  assert.equal(idempotencyWindowOpen(PLANNED, at(tenYears), Number.MAX_SAFE_INTEGER), true);
});

test('idempotencyWindowOpen: negative elapsed (clock went backwards) fails closed', () => {
  assert.equal(idempotencyWindowOpen(PLANNED, at(-1), 1000), false);
  assert.equal(idempotencyWindowOpen(PLANNED, at(-86_400_000), Number.MAX_SAFE_INTEGER), false);
});

test('idempotencyWindowOpen: invalid retention is closed (no upper bound, but must be a positive safe integer)', () => {
  for (const retention of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1000' as unknown as number]) {
    assert.equal(idempotencyWindowOpen(PLANNED, PLANNED, retention), false, String(retention));
  }
  assert.equal(idempotencyWindowOpen(PLANNED, PLANNED, 604_800_001), true, '7일 상한은 없다');
});

test('idempotencyWindowOpen: non-canonical timestamps are closed, for both planned_at and now', () => {
  const bad = ['2026-10-19', '2026-10-19T09:00:00.000+09:00', '2026-10-19T00:00:00Z', '2026-02-30T00:00:00.000Z', '2026-10-19T00:00:00.000', ''];
  for (const value of bad) {
    assert.equal(idempotencyWindowOpen(value, PLANNED, 1000), false, `planned ${value}`);
    assert.equal(idempotencyWindowOpen(PLANNED, value, 1000), false, `now ${value}`);
  }
});

test('snapshotOf: maps a declaration to the stored columns', () => {
  assert.deepEqual(snapshotOf({ supported: true, retention_ms: 5000 }), { supports_idempotency: 1, idempotency_retention_ms: 5000 });
  assert.deepEqual(snapshotOf({ supported: false }), { supports_idempotency: 0, idempotency_retention_ms: null });
});

test('tightenSnapshot: only ever tightens (case table)', () => {
  const stored1000 = { supports_idempotency: 1, idempotency_retention_ms: 1000 };
  const unsupported = { supports_idempotency: 0, idempotency_retention_ms: null };
  const cases: [string, { supports_idempotency: number; idempotency_retention_ms: number | null }, IdempotencyDeclaration | null, unknown][] = [
    ['unsupported x null', unsupported, null, null],
    ['unsupported x unsupported', unsupported, { supported: false }, null],
    ['unsupported x supported never loosens', unsupported, { supported: true, retention_ms: 5000 }, null],
    ['supported x null', stored1000, null, { supports_idempotency: 0, idempotency_retention_ms: null }],
    ['supported x unsupported', stored1000, { supported: false }, { supports_idempotency: 0, idempotency_retention_ms: null }],
    ['supported x shorter', stored1000, { supported: true, retention_ms: 400 }, { supports_idempotency: 1, idempotency_retention_ms: 400 }],
    ['supported x equal', stored1000, { supported: true, retention_ms: 1000 }, null],
    ['supported x longer', stored1000, { supported: true, retention_ms: 5000 }, null],
  ];
  for (const [label, stored, current, expected] of cases) assert.deepEqual(tightenSnapshot(stored, current), expected, label);
});

test('resendAllowed: the single predicate (supported, has retention, window open)', () => {
  const base = { supports_idempotency: 1, idempotency_retention_ms: 1000, planned_at: PLANNED };
  assert.equal(resendAllowed(base, at(0)), true);
  assert.equal(resendAllowed(base, at(500)), true);
  assert.equal(resendAllowed(base, at(501)), false);
  assert.equal(resendAllowed(base, at(-1)), false);
  assert.equal(resendAllowed({ ...base, supports_idempotency: 0, idempotency_retention_ms: null }, at(0)), false);
  assert.equal(resendAllowed({ ...base, idempotency_retention_ms: null }, at(0)), false, '방어: 지원인데 보존 기간이 없으면 닫힘');
  assert.equal(resendAllowed({ ...base, planned_at: 'garbage' }, at(0)), false);
});
