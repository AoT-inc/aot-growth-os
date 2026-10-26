// 어댑터 출력·비용 진행 보고의 형태 검증. 어댑터가 낸 값은 신뢰하지 않는다 (trust-boundaries §1: 실행 에이전트 = 낮음).
// 예외 대신 모든 문제를 모아 돌려준다 (domain 의 IssueCollector 와 같은 방식). 프레임 검증(frames.ts)도 이 함수를 쓴다.
import { Buffer } from 'node:buffer';

import {
  EVIDENCE_KINDS, IssueCollector, isNonBlankString, isPlainObject, MAX_TASK_RESULT_BYTES, MAX_TASK_RESULT_INPUTS, MAX_TASK_RESULT_TOTAL_BYTES, taskIdOfResultRef,
  TRUST_ORIGINS, type PlainObject, type ValidationResult,
} from '@aot/domain';

import { ADAPTER_STATUSES, COST_UNITS, type AdapterOutput, type CostProgressEvent, type JsonObject, type UpstreamResult } from './contract.ts';

/** Clock.nowIso() 가 만드는 형식. 문자열 비교가 시간순과 같도록 이 형식만 받는다 */
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const isClockIso = (value: unknown): value is string => typeof value === 'string' && ISO_UTC_MS.test(value) && !Number.isNaN(Date.parse(value));

const MAX_JSON_DEPTH = 32;

/** JSON 으로 그대로 직렬화되는 값인가 (undefined·함수·NaN·순환·클래스 인스턴스 없음). 깊이는 32 로 제한한다 */
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value) && isJsonValue(value);
}

/** `allowed` 밖의 키를 각각 문제로 쌓는다 */
export function rejectUnknown(obj: PlainObject, allowed: readonly string[], path: string, out: IssueCollector): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) out.add(path === '' ? key : `${path}.${key}`, 'unknown_field', `unknown field '${key}'`);
  }
}

const MAX_UPSTREAM_NAME_CHARS = 200;

/**
 * 선행 업무 결과 `upstream`(A6-U11) 검증: 배열(개수 상한), 항목은 `{name, task_ref, trust_origin, result}` 뿐이고, `trust_origin` 은 정확히 `external_untrusted`
 * (선행 결과를 신뢰된 입력으로 표시한 입력을 거부한다), `task_ref` 는 `task:<id>`, 이름·참조는 유일, `result` 는 JSON 객체이며 항목당·전체 크기 상한(자르지 않고 거부).
 * 호스트가 어댑터를 띄우기 전과 `start` 프레임을 받는 쪽이 같은 검사를 쓴다.
 */
export function validateUpstream(input: unknown): ValidationResult<UpstreamResult[]> {
  const out = new IssueCollector();
  checkUpstream(input, 'upstream', out);
  return out.result(input as UpstreamResult[]);
}

export function checkUpstream(value: unknown, path: string, out: IssueCollector): void {
  if (!Array.isArray(value)) return void out.add(path, 'type', 'upstream must be an array');
  if (value.length > MAX_TASK_RESULT_INPUTS) out.add(path, 'too_many', `upstream has more than ${MAX_TASK_RESULT_INPUTS} entries`);
  const names = new Set<string>();
  const refs = new Set<string>();
  let total = 0;
  value.forEach((item: unknown, index) => {
    const base = `${path}[${index}]`;
    if (!isPlainObject(item)) return void out.add(base, 'type', 'upstream entry must be an object');
    rejectUnknown(item, ['name', 'task_ref', 'trust_origin', 'result'], base, out);
    const name = item['name'];
    if (!isNonBlankString(name) || name.length > MAX_UPSTREAM_NAME_CHARS) out.add(`${base}.name`, 'required', `name must be a non-empty string of at most ${MAX_UPSTREAM_NAME_CHARS} characters`);
    else if (names.has(name)) out.add(`${base}.name`, 'duplicate', `upstream name '${name}' is used more than once`);
    else names.add(name);
    const ref = item['task_ref'];
    if (typeof ref !== 'string' || taskIdOfResultRef(ref) === null) out.add(`${base}.task_ref`, 'format', "task_ref must be 'task:<task id>'");
    else if (refs.has(ref)) out.add(`${base}.task_ref`, 'duplicate', `${ref} is given more than once`);
    else refs.add(ref);
    if (item['trust_origin'] !== 'external_untrusted') out.add(`${base}.trust_origin`, 'enum', "trust_origin must be 'external_untrusted': a result from another agent is data, never trusted input");
    const result = item['result'];
    if (!isJsonObject(result)) return void out.add(`${base}.result`, 'type', 'result must be a JSON object');
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (bytes > MAX_TASK_RESULT_BYTES) out.add(`${base}.result`, 'too_large', `result is ${bytes} bytes (limit ${MAX_TASK_RESULT_BYTES}); it is never truncated`);
    total += bytes;
  });
  if (total > MAX_TASK_RESULT_TOTAL_BYTES) out.add(path, 'too_large', `the upstream results together are ${total} bytes (limit ${MAX_TASK_RESULT_TOTAL_BYTES})`);
}

const nonNegativeFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 누적 비용 진행 보고 `{cumulative, unit}` */
export function validateCostProgress(input: unknown): ValidationResult<CostProgressEvent> {
  const out = new IssueCollector();
  if (!isPlainObject(input)) {
    out.add('', 'type', 'cost_progress must be an object');
    return out.result(input as CostProgressEvent);
  }
  checkCostProgress(input, '', out);
  return out.result(input as unknown as CostProgressEvent);
}

export function checkCostProgress(obj: PlainObject, path: string, out: IssueCollector, extraKeys: readonly string[] = []): void {
  const at = (key: string): string => (path === '' ? key : `${path}.${key}`);
  rejectUnknown(obj, ['cumulative', 'unit', ...extraKeys], path, out);
  if (!nonNegativeFinite(obj['cumulative'])) out.add(at('cumulative'), 'type', 'cumulative must be a finite, non-negative number');
  if (!(COST_UNITS as readonly unknown[]).includes(obj['unit'])) out.add(at('unit'), 'enum', `unit must be one of ${COST_UNITS.join('|')}`);
  else if (obj['unit'] === 'tokens' && nonNegativeFinite(obj['cumulative']) && !Number.isInteger(obj['cumulative'])) {
    out.add(at('cumulative'), 'type', 'cumulative tokens must be an integer');
  }
}

/**
 * 어댑터 출력 `{status, result, evidence[], run_log[], cost, error?}` 검증.
 * evidence / run_log / cost 는 취소·오류에서도 필수다(비어 있는 배열은 허용, 없는 필드는 거부).
 */
export function validateAdapterOutput(input: unknown): ValidationResult<AdapterOutput> {
  const out = new IssueCollector();
  if (!isPlainObject(input)) {
    out.add('', 'type', 'adapter output must be a JSON object');
    return out.result(input as AdapterOutput);
  }
  checkAdapterOutput(input, '', out);
  return out.result(input as unknown as AdapterOutput);
}

export function checkAdapterOutput(obj: PlainObject, path: string, out: IssueCollector, extraKeys: readonly string[] = []): void {
  const at = (key: string): string => (path === '' ? key : `${path}.${key}`);
  rejectUnknown(obj, ['status', 'result', 'evidence', 'run_log', 'cost', 'error', ...extraKeys], path, out);

  const status = obj['status'];
  if (!(ADAPTER_STATUSES as readonly unknown[]).includes(status)) out.add(at('status'), 'enum', `status must be one of ${ADAPTER_STATUSES.join('|')}`);

  const result = obj['result'];
  if (!('result' in obj)) out.add(at('result'), 'required', 'result is required (null when there is none)');
  else if (result !== null && !isJsonObject(result)) out.add(at('result'), 'type', 'result must be a JSON object or null');
  else if (status === 'submitted' && result === null) out.add(at('result'), 'required', "result must be an object when status is 'submitted'");

  const evidence = obj['evidence'];
  if (!Array.isArray(evidence)) out.add(at('evidence'), 'required', 'evidence must be an array');
  else {
    evidence.forEach((item: unknown, index) => {
      const base = `${at('evidence')}[${index}]`;
      if (!isPlainObject(item)) return void out.add(base, 'type', 'evidence item must be an object');
      rejectUnknown(item, ['kind', 'ref', 'trust_origin', 'captured_at', 'content_hash'], base, out);
      if (!(EVIDENCE_KINDS as readonly unknown[]).includes(item['kind'])) out.add(`${base}.kind`, 'enum', `kind must be one of ${EVIDENCE_KINDS.join('|')}`);
      if (!isNonBlankString(item['ref'])) out.add(`${base}.ref`, 'required', 'ref must be a non-empty string');
      // 자기 신고의 어휘 검증: 신뢰 출처를 밝히지 않았거나 어휘 밖인 근거는 거부한다. 통과한 값도 저장되지 않는다 (호스트가 external_untrusted 로 쓴다, A5-U8)
      if (!(TRUST_ORIGINS as readonly unknown[]).includes(item['trust_origin'])) out.add(`${base}.trust_origin`, 'enum', `trust_origin is required and must be one of ${TRUST_ORIGINS.join('|')}`);
      if (!isClockIso(item['captured_at'])) out.add(`${base}.captured_at`, 'type', 'captured_at must be a UTC ISO 8601 timestamp with milliseconds');
      if ('content_hash' in item && !isNonBlankString(item['content_hash'])) out.add(`${base}.content_hash`, 'type', 'content_hash must be a non-empty string when given');
    });
  }

  const runLog = obj['run_log'];
  if (!Array.isArray(runLog)) out.add(at('run_log'), 'required', 'run_log must be an array');
  else {
    runLog.forEach((item: unknown, index) => {
      const base = `${at('run_log')}[${index}]`;
      if (!isPlainObject(item)) return void out.add(base, 'type', 'run_log entry must be an object');
      rejectUnknown(item, ['at', 'message'], base, out);
      if (!isClockIso(item['at'])) out.add(`${base}.at`, 'type', 'at must be a UTC ISO 8601 timestamp with milliseconds');
      if (typeof item['message'] !== 'string') out.add(`${base}.message`, 'type', 'message must be a string');
    });
  }

  checkCost(obj['cost'], at('cost'), out);

  if (status === 'error') {
    const error = obj['error'];
    if (!isPlainObject(error)) out.add(at('error'), 'required', "error is required when status is 'error'");
    else {
      rejectUnknown(error, ['code', 'message'], at('error'), out);
      if (!isNonBlankString(error['code'])) out.add(at('error.code'), 'required', 'error.code must be a non-empty string');
      if (typeof error['message'] !== 'string') out.add(at('error.message'), 'type', 'error.message must be a string');
    }
  } else if ('error' in obj) {
    out.add(at('error'), 'unexpected', "error is only allowed when status is 'error'");
  }
}

function checkCost(cost: unknown, path: string, out: IssueCollector): void {
  if (!isPlainObject(cost)) return void out.add(path, 'required', 'cost is required: {usd?, tokens?} with at least one value');
  rejectUnknown(cost, ['usd', 'tokens'], path, out);
  if (!('usd' in cost) && !('tokens' in cost)) out.add(path, 'required', 'cost needs usd or tokens');
  if ('usd' in cost && !nonNegativeFinite(cost['usd'])) out.add(`${path}.usd`, 'type', 'usd must be a finite, non-negative number');
  if ('tokens' in cost && !(nonNegativeFinite(cost['tokens']) && Number.isInteger(cost['tokens']))) {
    out.add(`${path}.tokens`, 'type', 'tokens must be a non-negative integer');
  }
}
