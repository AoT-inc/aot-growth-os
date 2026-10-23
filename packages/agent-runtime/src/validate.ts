// 어댑터 출력·비용 진행 보고의 형태 검증. 어댑터가 낸 값은 신뢰하지 않는다 (trust-boundaries §1: 실행 에이전트 = 낮음).
// 예외 대신 모든 문제를 모아 돌려준다 (domain 의 IssueCollector 와 같은 방식). 프레임 검증(frames.ts)도 이 함수를 쓴다.
import { EVIDENCE_KINDS, IssueCollector, isNonBlankString, isPlainObject, TRUST_ORIGINS, type PlainObject, type ValidationResult } from '@aot/domain';

import { ADAPTER_STATUSES, COST_UNITS, type AdapterOutput, type CostProgressEvent, type JsonObject } from './contract.ts';

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
