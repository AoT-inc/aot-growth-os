// (도구, action) 멱등 선언 검증과 재전송 창 판정 — docs/operations/recovery.md §3. 순수 함수만 둔다 (DB·Clock 없음).
// 선언은 tool_contract_version 에 들어가는 계약 데이터다. 판정의 근거는 언제나 external_effect 행(스냅숏)이고,
// 현재 선언은 행을 강화(tightenSnapshot)만 할 수 있다. 이 파일은 effects.ts 를 가져오지 않는다 (구조적 타입만 쓴다).

/** effect_key 를 send() 가 어디에 싣는지 (lookup() 이 찾는 곳). 엔진은 동작을 바꾸지 않는 검증된 계약 데이터다 */
export const EFFECT_KEY_CARRIERS = ['metadata', 'slug', 'property', 'none'] as const;
export type EffectKeyCarrier = (typeof EFFECT_KEY_CARRIERS)[number];

export type IdempotencyDeclaration =
  | { readonly supported: true; readonly retention_ms: number }
  | { readonly supported: false };

/**
 * 한 (도구, action) 의 계약. `effect_key_carrier` 는 도구에 lookup 이 있을 때만, 그리고 있으면 반드시 선언한다.
 * 어댑터 의무(엔진 밖): carrier `none` 의 내용 대조는 전송 시각 이후로 한정, effect_key 를 공개 본문에 싣지 않는다.
 */
export interface EffectActionDeclaration {
  readonly idempotency: IdempotencyDeclaration;
  readonly effect_key_carrier?: EffectKeyCarrier;
}

export const DECLARATION_ERROR_CODES = [
  'not_object',
  'unknown_field',
  'supported_invalid',
  'retention_required',
  'retention_invalid',
  'retention_forbidden',
  'actions_missing',
  'action_name_invalid',
  'action_undeclared',
  'carrier_invalid',
  'carrier_required',
  'carrier_without_lookup',
  'name_mismatch',
] as const;
export type DeclarationErrorCode = (typeof DECLARATION_ERROR_CODES)[number];

export interface DeclarationError {
  readonly action: string | null;
  readonly code: DeclarationErrorCode;
  readonly detail: string;
}

export interface IdempotencySnapshot {
  supports_idempotency: number;
  idempotency_retention_ms: number | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/** 보존 기간 검증: 양의 안전 정수 (상한 없음) */
const validRetention = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const fail = (action: string | null, code: DeclarationErrorCode, detail: string): { ok: false; error: DeclarationError } =>
  ({ ok: false, error: { action, code, detail } });

export function validateIdempotencyDeclaration(
  value: unknown, action: string | null = null,
): { ok: true; declaration: IdempotencyDeclaration } | { ok: false; error: DeclarationError } {
  if (!isPlainObject(value)) return fail(action, 'not_object', 'idempotency declaration must be an object');
  for (const key of Object.keys(value)) {
    if (key !== 'supported' && key !== 'retention_ms') return fail(action, 'unknown_field', `unknown field '${key}'`);
  }
  if (typeof value['supported'] !== 'boolean') return fail(action, 'supported_invalid', 'supported must be a boolean');
  const hasRetention = Object.hasOwn(value, 'retention_ms');
  if (value['supported'] === false) {
    if (hasRetention) return fail(action, 'retention_forbidden', 'retention_ms is not allowed when supported is false');
    return { ok: true, declaration: { supported: false } };
  }
  if (!hasRetention) return fail(action, 'retention_required', 'retention_ms is required when supported is true');
  const retention = value['retention_ms'];
  if (!validRetention(retention)) return fail(action, 'retention_invalid', 'retention_ms must be a positive safe integer');
  return { ok: true, declaration: { supported: true, retention_ms: retention } };
}

type ActionResult = { ok: true; declaration: EffectActionDeclaration } | { ok: false; errors: DeclarationError[] };

function validateAction(action: string, entry: unknown, hasLookup: boolean): ActionResult {
  if (!isPlainObject(entry)) return { ok: false, errors: [{ action, code: 'not_object', detail: 'action declaration must be an object' }] };
  const errors: DeclarationError[] = [];
  for (const key of Object.keys(entry)) {
    if (key !== 'idempotency' && key !== 'effect_key_carrier') errors.push({ action, code: 'unknown_field', detail: `unknown field '${key}'` });
  }
  const idempotency = validateIdempotencyDeclaration(entry['idempotency'], action);
  if (!idempotency.ok) errors.push(idempotency.error);
  const carrier = entry['effect_key_carrier'];
  let validCarrier: EffectKeyCarrier | undefined;
  if (carrier !== undefined) {
    if (typeof carrier === 'string' && (EFFECT_KEY_CARRIERS as readonly string[]).includes(carrier)) validCarrier = carrier as EffectKeyCarrier;
    else errors.push({ action, code: 'carrier_invalid', detail: `effect_key_carrier must be one of ${EFFECT_KEY_CARRIERS.join(', ')}` });
  }
  if (hasLookup && carrier === undefined) errors.push({ action, code: 'carrier_required', detail: 'a tool with lookup must declare effect_key_carrier' });
  if (!hasLookup && validCarrier !== undefined) errors.push({ action, code: 'carrier_without_lookup', detail: 'effect_key_carrier declared but the tool has no lookup' });
  if (errors.length > 0 || !idempotency.ok) return { ok: false, errors };
  return { ok: true, declaration: validCarrier === undefined ? { idempotency: idempotency.declaration } : { idempotency: idempotency.declaration, effect_key_carrier: validCarrier } };
}

const actionsMissing = (): DeclarationError => ({ action: null, code: 'actions_missing', detail: 'tool.actions must be a non-empty object' });

/** 모든 action 을 검증하고 오류를 전부 돌려준다 (자기 키만 본다). */
export function validateEffectToolDeclaration(
  tool: { readonly name: string; readonly actions: unknown; readonly lookup?: unknown },
): { ok: true } | { ok: false; errors: readonly DeclarationError[] } {
  if (!isPlainObject(tool.actions) || Object.keys(tool.actions).length === 0) return { ok: false, errors: [actionsMissing()] };
  const errors: DeclarationError[] = [];
  const hasLookup = typeof tool.lookup === 'function';
  for (const action of Object.keys(tool.actions)) {
    if (action.trim() === '') {
      errors.push({ action, code: 'action_name_invalid', detail: 'action name must not be empty' });
      continue;
    }
    const result = validateAction(action, tool.actions[action], hasLookup);
    if (!result.ok) errors.push(...result.errors);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** 런타임 해석: 같은 규칙 (carrier 대 lookup 포함). 선언되지 않은 이름('constructor', '__proto__' 등)은 action_undeclared. */
export function resolveActionDeclaration(
  tool: { readonly actions: unknown; readonly lookup?: unknown }, action: string,
): { ok: true; declaration: EffectActionDeclaration } | { ok: false; error: DeclarationError } {
  if (!isPlainObject(tool.actions)) return { ok: false, error: actionsMissing() };
  if (!Object.hasOwn(tool.actions, action)) return fail(action, 'action_undeclared', `action '${action}' is not declared by the tool`);
  const result = validateAction(action, tool.actions[action], typeof tool.lookup === 'function');
  if (result.ok) return result;
  return { ok: false, error: result.errors[0]! };
}

const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `Date#toISOString` 형식(= Clock.nowIso)만 받는다. 아니면 null */
function parseCanonicalIso(value: unknown): number | null {
  if (typeof value !== 'string' || !CANONICAL_ISO.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value) return null;
  return ms;
}

/**
 * 같은 키 재전송 창: planned_at 부터 경과한 시간이 보존 기간의 50% 이하(경계 포함)이면 열려 있다.
 * 보존 기간이 양의 안전 정수가 아니거나, 시각이 정규 ISO 가 아니거나, 경과가 음수(시계 역행)면 닫힌다 (fail closed).
 */
export function idempotencyWindowOpen(plannedAt: string, now: string, retentionMs: number): boolean {
  if (!validRetention(retentionMs)) return false;
  const plannedMs = parseCanonicalIso(plannedAt);
  const nowMs = parseCanonicalIso(now);
  if (plannedMs === null || nowMs === null) return false;
  const elapsed = nowMs - plannedMs;
  if (elapsed < 0) return false;
  return elapsed <= Math.floor(retentionMs / 2);
}

export function snapshotOf(d: IdempotencyDeclaration): { supports_idempotency: 0 | 1; idempotency_retention_ms: number | null } {
  return d.supported ? { supports_idempotency: 1, idempotency_retention_ms: d.retention_ms } : { supports_idempotency: 0, idempotency_retention_ms: null };
}

/** 현재 선언으로 행의 스냅숏을 강화만 한다. 바뀔 게 없으면 null. 느슨하게 만들지 않는다. */
export function tightenSnapshot(
  stored: IdempotencySnapshot, current: IdempotencyDeclaration | null,
): { supports_idempotency: 0 | 1; idempotency_retention_ms: number | null } | null {
  if (Number(stored.supports_idempotency) !== 1) return null;
  if (current === null || !current.supported || stored.idempotency_retention_ms === null) return snapshotOf({ supported: false });
  if (current.retention_ms < Number(stored.idempotency_retention_ms)) return snapshotOf(current);
  return null;
}

/** 재전송 판정의 단일 술어 (performEffect, beginDispatch, settleRunEffects, takeOverExpiredRun 이 같이 쓴다). 행만 본다. */
export function resendAllowed(row: IdempotencySnapshot & { planned_at: string }, now: string): boolean {
  return Number(row.supports_idempotency) === 1 && row.idempotency_retention_ms !== null
    && idempotencyWindowOpen(row.planned_at, now, Number(row.idempotency_retention_ms));
}
