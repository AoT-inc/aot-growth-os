// API 전송의 요청 조립과 응답 필드 선택 (ADR-0020). 순수 함수다: 같은 선언·인자는 항상 같은 요청 바이트를 낸다.
import { Buffer } from 'node:buffer';

import {
  checkApiArguments, EFFECT_KEY_ARG, MAX_REQUEST_BODY_BYTES, parseTemplate,
  type ApiBodyNode, type ApiOperation, type TemplatePart,
} from './api-decl.ts';

export class ApiBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiBuildError';
  }
}

export interface BuiltRequest {
  method: string;
  /** base_url 의 경로 접두어 + 선언 경로 + 쿼리. 호스트는 base_url 에서만 온다 */
  target: string;
  headers: Record<string, string>;
  body: string | null;
}

type Scalar = string | number | boolean;
const text = (value: Scalar): string => String(value);
// eslint-disable-next-line no-control-regex -- 제어 문자를 찾는 것이 목적이다
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function convert(value: Scalar, conv: 'raw' | 'json_string' | 'base64'): string {
  if (conv === 'json_string') return JSON.stringify(text(value));
  if (conv === 'base64') return Buffer.from(text(value), 'utf8').toString('base64');
  return text(value);
}

function renderTemplate(parts: readonly TemplatePart[], args: Record<string, unknown>): string {
  let out = '';
  for (const part of parts) {
    if (typeof part === 'string') { out += part; continue; }
    const value = args[part.arg];
    if (value === undefined || value === null || typeof value === 'object') throw new ApiBuildError(`argument '${part.arg}' has no value`);
    out += convert(value as Scalar, part.conv);
  }
  return out;
}

function pathValue(name: string, value: unknown): string {
  if (value === undefined || value === null || typeof value === 'object') throw new ApiBuildError(`argument '${name}' has no value`);
  const raw = text(value as Scalar);
  if (raw === '' || /[/\\]/.test(raw) || CONTROL.test(raw)) throw new ApiBuildError(`argument '${name}' cannot be placed in the path`);
  return encodeURIComponent(raw);
}

function evalBody(node: ApiBodyNode, args: Record<string, unknown>): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => evalBody(item, args));
  const record = node as Record<string, unknown>;
  if ('$arg' in record) {
    const value = args[record['$arg'] as string];
    if (value === undefined) throw new ApiBuildError(`argument '${String(record['$arg'])}' has no value`);
    return value;
  }
  if ('$const' in record) return record['$const'];
  if ('$template' in record) {
    const parts = parseTemplate(record['$template'] as string);
    if (typeof parts === 'string') throw new ApiBuildError(parts);
    const rendered = renderTemplate(parts, args);
    return record['encode'] === 'base64' ? Buffer.from(rendered, 'utf8').toString('base64') : rendered;
  }
  // 키는 선언에 박힌 것만 쓴다. `__proto__` 도 자기 키로 정의한다
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, evalBody(child as ApiBodyNode, args)]));
}

/**
 * 동작 선언과 (이미 검증된) 인자로 요청 하나를 조립한다. `basePath` 는 base_url 의 경로 접두어(끝 `/` 없음).
 * 인자 검사 실패·경로 규칙 위반·본문 크기 초과는 ApiBuildError (서버에 아무것도 보내지 않았다).
 */
export function buildApiRequest(op: ApiOperation, args: Record<string, unknown>, basePath: string): BuiltRequest {
  const problem = checkApiArguments(op, args, { effectKeyPresent: true });
  if (problem !== null) throw new ApiBuildError(problem);
  const segments = op.request.path.slice(1).split('/').map((segment) => {
    const parts = parseTemplate(segment);
    if (typeof parts === 'string') throw new ApiBuildError(parts);
    return parts.map((part) => (typeof part === 'string' ? part : pathValue(part.arg, args[part.arg]))).join('');
  });
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new ApiBuildError('the assembled path has an empty, "." or ".." segment');
  }
  const path = `${basePath}/${segments.join('/')}`;
  if (/%2f|%5c|%2e%2e|%00/i.test(path) || path.includes('//') || /[\s#?]/.test(path)) throw new ApiBuildError('the assembled path is not allowed');
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(op.request.query)) {
    let resolved: Scalar | null | undefined;
    if (typeof value === 'string') resolved = value;
    else if ('$arg' in value) resolved = args[value.$arg] as Scalar | undefined;
    else resolved = value.$const;
    if (resolved === undefined) continue; // 선택 인자가 없다: 키를 보내지 않는다
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(resolved === null ? '' : text(resolved))}`);
  }
  const headers: Record<string, string> = { ...op.request.headers, accept: 'application/json' };
  let body: string | null = null;
  if (op.request.body !== undefined) {
    body = JSON.stringify(evalBody(op.request.body, args));
    headers['content-type'] = 'application/json';
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) throw new ApiBuildError(`the request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
  }
  return { method: op.request.method, target: `${path}${pairs.length > 0 ? `?${pairs.join('&')}` : ''}`, headers, body };
}

// ===== 응답 필드 선택 =====

export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}

function project(value: unknown, segments: readonly string[], at: string): unknown {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments as [string, ...string[]];
  if (head === '*') {
    if (!Array.isArray(value)) throw new ShapeError(`${at} is not a list`);
    return value.map((item, i) => project(item, rest, `${at}/${i}`));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, head)) throw new ShapeError(`${at}/${head} is missing`);
  return { [head]: project((value as Record<string, unknown>)[head], rest, `${at}/${head}`) };
}

function merge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((item, i) => merge(item, b[i]));
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: [string, unknown][] = Object.entries(a);
    for (const [key, value] of Object.entries(b)) {
      const index = out.findIndex(([existing]) => existing === key);
      if (index === -1) out.push([key, value]);
      else out[index] = [key, merge(out[index]![1], value)];
    }
    return Object.fromEntries(out);
  }
  return b === undefined ? a : b;
}

/** 허용 목록(경로 틀: 슬래시로 이은 키, 별표는 배열 원소)에 있는 필드만 남긴다. 경로가 응답에 없으면 ShapeError */
export function selectFields(json: unknown, paths: readonly string[]): unknown {
  let out: unknown;
  for (const path of paths) {
    const projected = project(json, path.slice(1).split('/'), '');
    out = out === undefined ? projected : merge(out, projected);
  }
  return out;
}

/** 쓰기 응답의 `record` 필드: 응답이 JSON 이 아니거나 필드가 없으면 빈 객체 (확정 판정에는 영향이 없다) */
export function tryRecordFields(json: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return {};
  try { return selectFields(json, paths) ?? {}; } catch { return {}; }
}

export { EFFECT_KEY_ARG };
