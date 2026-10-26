// 채널 중립 구조화 결과 (ADR-0014 §0, §7). 통화·대화 뒤에 "자유 텍스트만" 남기지 않고 평가기가 읽을 수 있는 구조를 남긴다.
// 어떤 disposition 이 허용되는지, 어떤 structured_data 필드가 필수인지는 업무 명세(`expected_call_outcome`)가 정한다.
// 이 모듈은 영업 절차를 모르고 형식(이름 규칙·크기)만 검사한다.
import { IssueCollector, isPlainObject, type ValidationResult } from '../validation.ts';

import { jsonBytes } from './json.ts';

export interface ConversationOutcome {
  /** 결과 분류 (예: qualified, not_interested, callback_requested). 어휘는 업무 명세가 정한다 */
  disposition: string;
  summary: string;
  /** 업무가 요구한 구조화 필드 (예: budgetKnown, timeline). 상대의 말에서 나온 값이다 */
  structuredData: Record<string, unknown>;
  /** 다음 업무 후보의 이름 (예: schedule_demo). 업무를 만들지는 않는다 */
  nextAction?: string | undefined;
}

export const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_OUTCOME_SUMMARY_CHARS = 2000;
export const MAX_STRUCTURED_DATA_BYTES = 16 * 1024;

/** 알 수 없는 키는 거부한다. 허용 disposition 목록을 주면 그 안의 값만 받는다 */
export function validateConversationOutcome(input: unknown, allowedDispositions?: readonly string[]): ValidationResult<ConversationOutcome> {
  const out = new IssueCollector();
  const empty: ConversationOutcome = { disposition: '', summary: '', structuredData: {} };
  if (!isPlainObject(input)) {
    out.add('', 'type', 'an outcome must be an object');
    return out.result(empty);
  }
  for (const key of Object.keys(input)) {
    if (!['disposition', 'summary', 'structuredData', 'nextAction'].includes(key)) out.add(key, 'unknown_field', `unknown field '${key}'`);
  }
  const disposition = input['disposition'];
  if (typeof disposition !== 'string' || !NAME_PATTERN.test(disposition)) out.add('disposition', 'format', 'disposition must match [a-z][a-z0-9_]{0,63}');
  else if (allowedDispositions !== undefined && !allowedDispositions.includes(disposition)) out.add('disposition', 'not_allowed', `disposition '${disposition}' is not one of: ${allowedDispositions.join(', ')}`);
  const summary = input['summary'];
  if (typeof summary !== 'string' || summary.trim() === '') out.add('summary', 'required', 'summary must be a non-empty string');
  else if (summary.length > MAX_OUTCOME_SUMMARY_CHARS) out.add('summary', 'too_long', `summary is longer than ${MAX_OUTCOME_SUMMARY_CHARS} characters`);
  const data = input['structuredData'] ?? {};
  if (!isPlainObject(data)) out.add('structuredData', 'type', 'structuredData must be an object');
  else {
    const bytes = jsonBytes(data);
    if (bytes === null) out.add('structuredData', 'not_json', 'structuredData must be plain JSON data');
    else if (bytes > MAX_STRUCTURED_DATA_BYTES) out.add('structuredData', 'too_large', `structuredData is larger than ${MAX_STRUCTURED_DATA_BYTES} bytes`);
  }
  const next = input['nextAction'];
  if (next !== undefined && (typeof next !== 'string' || !NAME_PATTERN.test(next))) out.add('nextAction', 'format', 'nextAction must match [a-z][a-z0-9_]{0,63}');
  const value: ConversationOutcome = {
    disposition: typeof disposition === 'string' ? disposition : '',
    summary: typeof summary === 'string' ? summary.trim() : '',
    structuredData: isPlainObject(data) ? data : {},
    ...(typeof next === 'string' ? { nextAction: next } : {}),
  };
  return out.result(value);
}

/** 명세가 요구한 필수 필드 중 structuredData 에 없는(또는 null 인) 것 */
export function missingOutcomeFields(outcome: Pick<ConversationOutcome, 'structuredData'>, required: readonly string[]): string[] {
  return required.filter((field) => outcome.structuredData[field] === undefined || outcome.structuredData[field] === null);
}
