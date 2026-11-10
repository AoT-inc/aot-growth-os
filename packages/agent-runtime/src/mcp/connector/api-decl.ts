// API 전송의 동작 선언: 닫힌 문법 (ADR-0020). 호스트(manifest.ts)가 오너 선언을 검증하고, 커넥터 프로세스(api-runtime.ts)가 같은 정규형을 받아 쓴다.
// 이 파일은 node: 내장 모듈과 같은 폴더의 파일만 import 한다(.dependency-cruiser.cjs 의 mcp-connector-isolated).
// 값이 들어가는 자리는 `$arg`·`$const`·`$template` 셋뿐이고 키(이름) 자리에는 쓸 수 없다. 반복·조건·식이 없다. 알 수 없는 키는 모두 거부한다.
import { sha256Hex, canonicalJson } from './canonical.ts';

export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof API_METHODS)[number];
export type ApiNetwork = 'public' | 'tailnet' | 'loopback';
export const API_NETWORKS: readonly ApiNetwork[] = ['public', 'tailnet', 'loopback'];
/** 호스트가 정하는 예약 인자: 부작용 원장의 효과 키. 쓰기 동작에서만 쓰고 에이전트가 줄 수 없다 */
export const EFFECT_KEY_ARG = 'effect_key';
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const DEFAULT_STRING_MAX_LENGTH = 256;
export const MAX_STRING_MAX_LENGTH = 32768;
export const MAX_RETURN_PATHS = 20;

export type ApiArgType = 'string' | 'integer' | 'boolean';
export interface ApiArg {
  type: ApiArgType;
  required: boolean;
  enum?: (string | number | boolean)[];
  pattern?: string;
  min?: number;
  max?: number;
  max_length?: number;
}

export type ApiScalar = string | number | boolean | null;
export type ApiValueExpr = { $arg: string } | { $const: ApiScalar } | { $template: string; encode?: 'base64' };
export type ApiBodyNode = ApiValueExpr | ApiScalar | ApiBodyNode[] | { [key: string]: ApiBodyNode };
export type ApiQueryValue = string | { $arg: string } | { $const: ApiScalar };

export interface ApiRequest {
  method: ApiMethod;
  path: string;
  query: Record<string, ApiQueryValue>;
  body?: ApiBodyNode;
  headers: Record<string, string>;
}

/** 검증을 마친 동작 선언 (정규형: 기본값이 채워져 있다). 이 모양이 해시되고 커넥터로 간다 */
export interface ApiOperation {
  args: Record<string, ApiArg>;
  request: ApiRequest;
  returns: string[];
  record: string[];
  uses_effect_key: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ARG_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const QUERY_KEY = /^[A-Za-z0-9_.-]{1,40}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,200}$/;
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'accept-encoding', 'authorization', 'cookie', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'user-agent', 'proxy-authorization']);
const RETURN_SEGMENT = /^([A-Za-z0-9_-]{1,40}|\*)$/;
const PATH_LITERAL = /^[A-Za-z0-9._~-]*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONVERSIONS = ['raw', 'json_string', 'base64'] as const;
type Conversion = (typeof CONVERSIONS)[number];

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, problems: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${label}: unknown key '${key}'`);
}

// ===== 템플릿 =====

export type TemplatePart = string | { arg: string; conv: Conversion };

/** `"글 {slug}\n{title|json_string}"` → 조각들. `{{`·`}}` 는 글자 중괄호. 틀리면 사유 문자열 */
export function parseTemplate(text: string): TemplatePart[] | string {
  const parts: TemplatePart[] = [];
  let literal = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '{') {
      if (text[i + 1] === '{') { literal += '{'; i += 1; continue; }
      const end = text.indexOf('}', i);
      if (end === -1) return `template has an unclosed '{'`;
      const inner = text.slice(i + 1, end);
      const [name, conv = 'raw', ...rest] = inner.split('|');
      if (rest.length > 0 || name === undefined || !ARG_NAME.test(name)) return `template placeholder '{${inner.slice(0, 40)}}' is not {name} or {name|conversion}`;
      if (!(CONVERSIONS as readonly string[]).includes(conv)) return `template conversion '${conv.slice(0, 20)}' is not one of ${CONVERSIONS.join('|')}`;
      if (literal !== '') { parts.push(literal); literal = ''; }
      parts.push({ arg: name, conv: conv as Conversion });
      i = end;
    } else if (ch === '}') {
      if (text[i + 1] === '}') { literal += '}'; i += 1; continue; }
      return `template has a stray '}'`;
    } else literal += ch;
  }
  if (literal !== '') parts.push(literal);
  return parts;
}

// ===== 선언 검증 =====

function parseArgs(raw: unknown, label: string, problems: string[]): Record<string, ApiArg> {
  const out: Record<string, ApiArg> = {};
  if (!isRecord(raw)) { problems.push(`${label}.args must be an object (use {} for no arguments)`); return out; }
  for (const [name, spec] of Object.entries(raw)) {
    const at = `${label}.args.${name}`;
    if (!ARG_NAME.test(name)) { problems.push(`${at}: argument names match ${String(ARG_NAME)}`); continue; }
    if (name === EFFECT_KEY_ARG) { problems.push(`${at}: '${EFFECT_KEY_ARG}' is reserved for the host`); continue; }
    if (!isRecord(spec)) { problems.push(`${at} must be an object`); continue; }
    checkKeys(spec, ['type', 'enum', 'pattern', 'min', 'max', 'max_length', 'required'], at, problems);
    const type = spec['type'];
    if (type !== 'string' && type !== 'integer' && type !== 'boolean') { problems.push(`${at}.type must be string, integer or boolean`); continue; }
    const arg: ApiArg = { type, required: spec['required'] === true };
    if (spec['required'] !== undefined && typeof spec['required'] !== 'boolean') problems.push(`${at}.required must be a boolean`);
    if (spec['enum'] !== undefined) {
      const list = spec['enum'];
      if (!Array.isArray(list) || list.length === 0 || list.length > 50 || !list.every((v) => typeof v === type) || new Set(list).size !== list.length) problems.push(`${at}.enum must be 1-50 distinct ${type} values`);
      else arg.enum = list as (string | number | boolean)[];
    }
    if (spec['pattern'] !== undefined) {
      if (type !== 'string') problems.push(`${at}.pattern is only for strings`);
      else if (typeof spec['pattern'] !== 'string' || spec['pattern'].length > 200) problems.push(`${at}.pattern must be a string of at most 200 characters`);
      else {
        try { new RegExp(spec['pattern'], 'u'); arg.pattern = spec['pattern']; } catch { problems.push(`${at}.pattern is not a valid regular expression`); }
      }
    }
    if (type === 'integer') {
      const min = spec['min'] ?? -2_147_483_648;
      const max = spec['max'] ?? 2_147_483_647;
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || (min as number) > (max as number)) problems.push(`${at}: min/max must be safe integers with min <= max`);
      else { arg.min = min as number; arg.max = max as number; }
      if (spec['max_length'] !== undefined) problems.push(`${at}.max_length is only for strings`);
    } else {
      if (spec['min'] !== undefined || spec['max'] !== undefined) problems.push(`${at}: min/max are only for integers`);
      if (type === 'string') {
        const maxLength = spec['max_length'] ?? DEFAULT_STRING_MAX_LENGTH;
        if (!Number.isInteger(maxLength) || (maxLength as number) < 1 || (maxLength as number) > MAX_STRING_MAX_LENGTH) problems.push(`${at}.max_length must be an integer 1-${MAX_STRING_MAX_LENGTH}`);
        else arg.max_length = maxLength as number;
      } else if (spec['max_length'] !== undefined) problems.push(`${at}.max_length is only for strings`);
    }
    out[name] = arg;
  }
  return out;
}

interface Scan { used: Map<string, 'path' | 'query' | 'body'>; effectKey: boolean; bodyBytes: number }

function noteArg(name: string, where: 'path' | 'query' | 'body', args: Record<string, ApiArg>, scan: Scan, at: string, problems: string[], options: { optionalOk: boolean }): void {
  if (name === EFFECT_KEY_ARG) { scan.effectKey = true; return; }
  const arg = args[name];
  if (arg === undefined) { problems.push(`${at}: argument '${name}' is not declared in args`); return; }
  if (!arg.required && !options.optionalOk) problems.push(`${at}: argument '${name}' must be required (only query values may use optional arguments)`);
  if (!scan.used.has(name)) scan.used.set(name, where);
}

const worstCase = (arg: ApiArg | undefined, conv: Conversion): number => {
  if (arg === undefined) return 200; // 효과 키
  const base = arg.type === 'string' ? (arg.max_length ?? DEFAULT_STRING_MAX_LENGTH) * (conv === 'json_string' ? 6 : 3) : 24;
  return conv === 'base64' ? Math.ceil(base * 4 / 3) : base;
};

function checkBodyNode(node: unknown, args: Record<string, ApiArg>, scan: Scan, at: string, problems: string[], depth: number): void {
  if (depth > 8) { problems.push(`${at}: the body is nested too deeply`); return; }
  if (node === null || typeof node === 'number' || typeof node === 'boolean') { scan.bodyBytes += 8; return; }
  if (typeof node === 'string') { problems.push(`${at}: a string value must be {"$const":…}, {"$arg":…} or {"$template":…}`); return; }
  if (Array.isArray(node)) { node.forEach((item, i) => checkBodyNode(item, args, scan, `${at}[${i}]`, problems, depth + 1)); return; }
  if (!isRecord(node)) { problems.push(`${at}: unsupported value`); return; }
  const keys = Object.keys(node);
  const special = keys.filter((key) => key.startsWith('$'));
  if (special.length > 0) {
    if (keys.length === 1 && keys[0] === '$arg') {
      const name = node['$arg'];
      if (typeof name !== 'string') { problems.push(`${at}.$arg must be an argument name`); return; }
      noteArg(name, 'body', args, scan, at, problems, { optionalOk: false });
      scan.bodyBytes += worstCase(args[name], 'raw');
    } else if (keys.length === 1 && keys[0] === '$const') {
      const value = node['$const'];
      if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) problems.push(`${at}.$const must be a string, number, boolean or null`);
      else scan.bodyBytes += JSON.stringify(value).length;
    } else if ((keys.length === 1 && keys[0] === '$template') || (keys.length === 2 && keys.includes('$template') && keys.includes('encode'))) {
      const text = node['$template'];
      if (typeof text !== 'string') { problems.push(`${at}.$template must be a string`); return; }
      if (node['encode'] !== undefined && node['encode'] !== 'base64') problems.push(`${at}.encode must be 'base64'`);
      const parts = parseTemplate(text);
      if (typeof parts === 'string') { problems.push(`${at}: ${parts}`); return; }
      let size = 0;
      for (const part of parts) {
        if (typeof part === 'string') size += part.length * 3;
        else { noteArg(part.arg, 'body', args, scan, at, problems, { optionalOk: false }); size += worstCase(args[part.arg], part.conv); }
      }
      scan.bodyBytes += node['encode'] === 'base64' ? Math.ceil(size * 4 / 3) : size;
    } else problems.push(`${at}: '${special[0]}' is not a value form (use exactly one of $arg, $const, $template)`);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    scan.bodyBytes += key.length + 4;
    checkBodyNode(child, args, scan, `${at}.${key}`, problems, depth + 1);
  }
}

function parseReturnPaths(raw: unknown, label: string, problems: string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RETURN_PATHS) { problems.push(`${label} must be 1-${MAX_RETURN_PATHS} field paths`); return []; }
  const out: string[] = [];
  for (const path of raw) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 200 || !path.slice(1).split('/').every((segment) => RETURN_SEGMENT.test(segment))) { problems.push(`${label}: '${String(path).slice(0, 60)}' is not a field path like /commit/sha or /*/name`); continue; }
    out.push(path);
  }
  return out;
}

/**
 * 도구 선언 원본의 api 부분(`args`, `request`, `returns`, `record`)을 검증해 정규형으로 만든다.
 * @param impact 오너가 선언한 영향 — 쓰기(external_effect)와 읽기(read)의 규칙이 다르다
 */
export function parseApiOperation(raw: Record<string, unknown>, impact: unknown, label: string, problems: string[]): ApiOperation | null {
  const before = problems.length;
  const isWrite = impact === 'external_effect';
  const args = parseArgs(raw['args'], label, problems);
  const reqRaw = raw['request'];
  if (!isRecord(reqRaw)) { problems.push(`${label}.request must be an object`); return null; }
  checkKeys(reqRaw, ['method', 'path', 'query', 'body', 'headers'], `${label}.request`, problems);
  const method = reqRaw['method'];
  if (typeof method !== 'string' || !(API_METHODS as readonly string[]).includes(method)) { problems.push(`${label}.request.method must be one of ${API_METHODS.join('|')}`); return null; }
  if (isWrite && method === 'GET') problems.push(`${label}: a write tool cannot use GET`);
  if (impact === 'read' && method !== 'GET' && raw['ack_post_is_read'] !== true) problems.push(`${label}: a read tool with method ${method} needs ack_post_is_read: true (the owner confirms this call changes nothing)`);
  if (raw['ack_post_is_read'] !== undefined && (typeof raw['ack_post_is_read'] !== 'boolean' || impact !== 'read')) problems.push(`${label}.ack_post_is_read is a boolean for read tools only`);
  const scan: Scan = { used: new Map(), effectKey: false, bodyBytes: 0 };

  // 경로
  const path = reqRaw['path'];
  let pathText = '';
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512 || path.includes('//') || path.includes('?') || path.includes('#')) problems.push(`${label}.request.path must be a path like /repos/{name}/x (no query, no '//')`);
  else {
    pathText = path;
    for (const segment of path.slice(1).split('/')) {
      const parts = parseTemplate(segment);
      if (typeof parts === 'string') { problems.push(`${label}.request.path: ${parts}`); continue; }
      let literalOnly = '';
      for (const part of parts) {
        if (typeof part === 'string') { literalOnly += part; if (!PATH_LITERAL.test(part)) problems.push(`${label}.request.path: literal '${part.slice(0, 30)}' may use only letters, digits and ._~-`); continue; }
        if (part.conv !== 'raw') { problems.push(`${label}.request.path: placeholders take no conversion`); continue; }
        noteArg(part.arg, 'path', args, scan, `${label}.request.path`, problems, { optionalOk: false });
        const arg = args[part.arg];
        if (part.arg === EFFECT_KEY_ARG) problems.push(`${label}.request.path: the host effect key cannot go in the path`);
        else if (arg !== undefined && arg.type === 'string' && arg.pattern === undefined && arg.enum === undefined) problems.push(`${label}.request.path: argument '${part.arg}' needs a pattern or enum because it is placed in the path`);
      }
      if (literalOnly === '.' || literalOnly === '..') problems.push(`${label}.request.path: '.' and '..' segments are not allowed`);
    }
  }

  // query
  const query: Record<string, ApiQueryValue> = {};
  const queryRaw = reqRaw['query'] ?? {};
  if (!isRecord(queryRaw)) problems.push(`${label}.request.query must be an object`);
  else {
    for (const [key, value] of Object.entries(queryRaw)) {
      const at = `${label}.request.query.${key}`;
      if (!QUERY_KEY.test(key)) { problems.push(`${at}: query keys match ${String(QUERY_KEY)}`); continue; }
      if (typeof value === 'string') { query[key] = value; continue; }
      if (isRecord(value) && Object.keys(value).length === 1 && typeof value['$arg'] === 'string') {
        noteArg(value['$arg'], 'query', args, scan, at, problems, { optionalOk: true });
        query[key] = { $arg: value['$arg'] };
      } else if (isRecord(value) && Object.keys(value).length === 1 && '$const' in value && (value['$const'] === null || ['string', 'number', 'boolean'].includes(typeof value['$const']))) {
        query[key] = { $const: value['$const'] as ApiScalar };
      } else problems.push(`${at} must be a fixed string, {"$arg":…} or {"$const":…}`);
    }
  }

  // headers
  const headers: Record<string, string> = {};
  const headersRaw = reqRaw['headers'] ?? {};
  if (!isRecord(headersRaw)) problems.push(`${label}.request.headers must be an object`);
  else {
    for (const [name, value] of Object.entries(headersRaw)) {
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('proxy-') || name.toLowerCase().startsWith('x-forwarded-')) problems.push(`${label}.request.headers: '${name.slice(0, 30)}' is not a plain, non-reserved header name`);
      else if (typeof value !== 'string' || !HEADER_VALUE.test(value)) problems.push(`${label}.request.headers.${name} must be a fixed printable string`);
      else headers[name] = value;
    }
  }

  // body
  let body: ApiBodyNode | undefined;
  if (reqRaw['body'] !== undefined) {
    if (method === 'GET' || method === 'DELETE') problems.push(`${label}.request.body is not allowed with ${method}`);
    else {
      checkBodyNode(reqRaw['body'], args, scan, `${label}.request.body`, problems, 0);
      body = reqRaw['body'] as ApiBodyNode;
      if (scan.bodyBytes > MAX_REQUEST_BODY_BYTES) problems.push(`${label}.request.body could exceed ${MAX_REQUEST_BODY_BYTES} bytes with the declared argument sizes`);
    }
  }
  if (scan.effectKey && !isWrite) problems.push(`${label}: the host effect key is only for write tools`);

  // 쓰지 않는 인자는 오너 실수다
  for (const name of Object.keys(args)) if (!scan.used.has(name)) problems.push(`${label}.args.${name} is declared but never used by the request`);

  // 응답
  let returns: string[] = [];
  let record: string[] = [];
  if (isWrite) {
    if (raw['returns'] !== undefined) problems.push(`${label}.returns is not allowed on a write tool (use record for the ledger)`);
    if (raw['record'] !== undefined) record = parseReturnPaths(raw['record'], `${label}.record`, problems);
  } else {
    if (raw['record'] !== undefined) problems.push(`${label}.record is only for write tools`);
    returns = parseReturnPaths(raw['returns'], `${label}.returns`, problems);
  }
  if (problems.length > before) return null;
  return {
    args, request: { method: method as ApiMethod, path: pathText, query, ...(body === undefined ? {} : { body }), headers },
    returns, record, uses_effect_key: scan.effectKey,
  };
}

// ===== 합성 입력 스키마와 선언 고정 =====

/** 선언 고정에 들어가는 것 (설명·`as` 는 뺀다). 호스트가 만들어 해시한다 */
export interface ApiPinBasis {
  base_url: string;
  network: ApiNetwork;
  auth: { kind: string; header?: string };
  tool: { name: string; impact: string; side_effect: boolean; approval: string | null; scope: string; target: string; ack_post_is_read: boolean };
  op: ApiOperation;
}

export const apiDeclHash = (basis: ApiPinBasis): string => `sha256:${sha256Hex(canonicalJson(basis))}`;

/** 호스트가 보고 인자 1단계 검사(checkArguments)를 하는 합성 입력 스키마. 선언 해시를 품어 선언 변경이 스키마 해시를 바꾼다 */
export function synthInputSchema(op: ApiOperation, declHash: string): unknown {
  const properties: Record<string, unknown> = {};
  for (const [name, arg] of Object.entries(op.args)) properties[name] = { type: arg.type };
  return {
    type: 'object', properties, required: Object.entries(op.args).filter(([, arg]) => arg.required).map(([name]) => name).sort(),
    additionalProperties: false, 'x-aot-api-decl': declHash,
  };
}

// ===== 인자 검사 (호스트와 커넥터가 같이 쓴다) =====

/** 문제가 없으면 null, 있으면 사유. `effect_key` 는 호스트가 넣은 값으로만 허용한다 */
export function checkApiArguments(op: ApiOperation, args: unknown, options: { effectKeyPresent?: boolean } = {}): string | null {
  if (!isRecord(args)) return 'arguments must be an object';
  for (const key of Object.keys(args)) {
    if (key === EFFECT_KEY_ARG && op.uses_effect_key) continue;
    if (!Object.hasOwn(op.args, key)) return `argument '${key}' is not declared`;
  }
  for (const [name, spec] of Object.entries(op.args)) {
    const value = Object.hasOwn(args, name) ? args[name] : undefined;
    if (value === undefined) { if (spec.required) return `argument '${name}' is required`; continue; }
    if (spec.type === 'string') {
      if (typeof value !== 'string') return `argument '${name}' must be a string`;
      if (LONE_SURROGATE.test(value)) return `argument '${name}' is not well-formed Unicode`;
      if (value.includes('\u0000')) return `argument '${name}' contains a NUL character`;
      if (value.length > (spec.max_length ?? DEFAULT_STRING_MAX_LENGTH)) return `argument '${name}' is longer than ${spec.max_length ?? DEFAULT_STRING_MAX_LENGTH}`;
      if (spec.pattern !== undefined && !new RegExp(spec.pattern, 'u').test(value)) return `argument '${name}' does not match its pattern`;
    } else if (spec.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return `argument '${name}' must be an integer`;
      if (value < (spec.min ?? Number.MIN_SAFE_INTEGER) || value > (spec.max ?? Number.MAX_SAFE_INTEGER)) return `argument '${name}' is out of range`;
    } else if (typeof value !== 'boolean') return `argument '${name}' must be a boolean`;
    if (spec.enum !== undefined && !spec.enum.includes(value as never)) return `argument '${name}' is not one of the allowed values`;
  }
  if (op.uses_effect_key) {
    const key = args[EFFECT_KEY_ARG];
    if (key === undefined) { if (options.effectKeyPresent === true) return `the host effect key is missing`; }
    else if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) return 'the host effect key is malformed';
  }
  return null;
}
