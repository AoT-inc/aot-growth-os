// 입력 스키마 고정 (ADR-0018 §7): 스키마의 정규 JSON sha256, 오너 선언과의 비교, 서버 주석 충돌 판정, 인자 1단계 검사.
// 서버 주석(`readOnlyHint` 등)은 분류에 쓰지 않는다. 오너가 읽기로 선언한 도구를 서버가 "읽기 전용이 아니다"라고 알릴 때만 닫는 데 쓴다(더 안전하다는 주장은 무시한다).
import { Buffer } from 'node:buffer';

import { canonicalJson, sha256Hex } from '@aot/domain';

import type { McpToolDecl } from './manifest.ts';

export const MAX_ARGUMENT_BYTES = 64 * 1024;

/** `sha256:<hex>` — 커넥터(connector/canonical.ts)와 같은 값이 나와야 한다(시험이 대조한다) */
export const schemaHash = (schema: unknown): string => `sha256:${sha256Hex(canonicalJson(schema ?? null))}`;

export type ToolState =
  | { readonly status: 'open' }
  | { readonly status: 'closed'; readonly reason: 'drift' | 'missing' | 'hint_conflict' | 'unavailable' | 'invalid_declaration' };

export type ClosedReason = Extract<ToolState, { status: 'closed' }>['reason'];

export interface ServerToolView {
  name: string;
  inputSchema: unknown;
  annotations: Record<string, unknown> | null;
}

/** 오너가 읽기로 선언했는데 서버가 읽기 전용이 아니라고(명시적으로) 알리는가 */
export function hintConflict(annotations: Record<string, unknown> | null): boolean {
  if (annotations === null) return false;
  return annotations['readOnlyHint'] === false || annotations['destructiveHint'] === true;
}

/** 선언 하나의 열림/닫힘. 서버 목록에서 같은 이름의 도구를 찾아 넘긴다(없으면 undefined) */
export function evaluateTool(decl: McpToolDecl, server: ServerToolView | undefined): ToolState {
  if (server === undefined) return { status: 'closed', reason: 'missing' };
  if (schemaHash(server.inputSchema) !== decl.inputSchemaSha256) return { status: 'closed', reason: 'drift' };
  if (decl.impact === 'read' && !decl.ackServerHintConflict && hintConflict(server.annotations)) return { status: 'closed', reason: 'hint_conflict' };
  if (decl.idempotency !== null) {
    const properties = propertiesOf(server.inputSchema);
    if (properties === null || !Object.hasOwn(properties, decl.idempotency.keyArgument)) return { status: 'closed', reason: 'invalid_declaration' };
  }
  return { status: 'open' };
}

const propertiesOf = (schema: unknown): Record<string, unknown> | null => {
  if (typeof schema !== 'object' || schema === null) return null;
  const properties = (schema as { properties?: unknown }).properties;
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties) ? (properties as Record<string, unknown>) : null;
};

const typeMatches = (type: string, value: unknown): boolean => {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return true; // 모르는 형식 이름은 검사하지 않는다(서버가 검사한다)
  }
};

/**
 * 인자 1단계 검사: 고정 스키마의 `properties` 밖 키, `required` 누락, 최상위 값의 원시 형식 불일치는 거부한다. 깊은 검증은 서버 몫이다.
 * 문제가 없으면 null, 있으면 사유 문자열.
 */
export function checkArguments(schema: unknown, args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object';
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) return `arguments exceed ${MAX_ARGUMENT_BYTES} bytes`;
  const properties = propertiesOf(schema) ?? {};
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(properties, key)) return `argument '${key}' is not in the pinned input schema`;
    const declared = properties[key];
    const type = typeof declared === 'object' && declared !== null ? (declared as { type?: unknown }).type : undefined;
    const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter((t): t is string => typeof t === 'string') : [];
    if (types.length > 0 && !types.some((t) => typeMatches(t, record[key]))) return `argument '${key}' must be ${types.join('|')}`;
  }
  const required = typeof schema === 'object' && schema !== null ? (schema as { required?: unknown }).required : undefined;
  if (Array.isArray(required)) {
    for (const key of required) if (typeof key === 'string' && !Object.hasOwn(record, key)) return `argument '${key}' is required`;
  }
  return null;
}
