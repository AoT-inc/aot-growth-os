// 커넥터 프로세스 전용 정규 JSON·해시. 커넥터는 @aot/* 를 import 하지 않으므로(경계 lint) @aot/domain 의 canonicalJson·sha256Hex 와 같은 알고리즘을 여기에 따로 둔다.
// 호스트 쪽 해시(schema-pin.ts)와 같은 값이 나오는지는 시험(test/unit/mcp-schema-pin.test.ts)이 대조한다.
import { createHash } from 'node:crypto';

/** 키 순서를 정렬한 JSON. `undefined` 값의 키는 빠진다 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    // `out[key] = …` 는 `__proto__` 키를 자기 키로 만들지 않고 프로토타입을 바꾼다. fromEntries 는 항상 자기 키로 정의한다
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) entries.push([key, sortKeys(item)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 입력 스키마의 고정 해시 표기: `sha256:<hex>` */
export const schemaHashOf = (schema: unknown): string => `sha256:${sha256Hex(canonicalJson(schema ?? null))}`;
