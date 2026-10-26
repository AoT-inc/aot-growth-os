// 정규화 JSON 과 해시. 같은 값이면 항상 같은 문자열·해시다.
// 쓰는 곳: effect_key·dedupe_key(task-engine), 정책 버전 content_hash·승인 대상 해시 approved_hash(policy).
import { createHash } from 'node:crypto';

/** 키 순서를 정렬한 JSON. `undefined` 값의 키는 빠진다. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** sha256(canonicalJson(value)) */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
