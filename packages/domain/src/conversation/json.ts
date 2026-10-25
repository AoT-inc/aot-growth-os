// 외부 대화(전화·이메일·채팅)가 다루는 "불투명한 업무 데이터"(context, structured_data)의 공통 검사.
// 이 값은 provider 에 넘기거나 DB 에 JSON 으로 저장되므로 JSON 으로 직렬화 가능하고 크기가 제한되어야 한다.
import { isPlainObject } from '../validation.ts';

const MAX_DEPTH = 8;

/** JSON 으로 직렬화되는 값(순환·함수·undefined·유한하지 않은 수 없음, 깊이 8 이하)인가 */
export function isJsonData(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonData(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).every((item) => isJsonData(item, depth + 1));
  return false;
}

/** UTF-8 바이트 수. JSON 데이터가 아니면 null */
export function jsonBytes(value: unknown): number | null {
  if (!isJsonData(value)) return null;
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
