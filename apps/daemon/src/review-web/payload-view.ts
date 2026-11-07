// 초안 payload 를 사람이 *전부* 볼 수 있는 글 조각으로 푼다 (ADR-0015: 승인하는 사람이 나가는 내용을 모두 본다).
// 화면에 그리는 글과 검사하는 글이 같은 조각이다: 조각 하나라도 (1) 너무 크거나 (2) 글이 아니거나 (3) 비밀 가리기가 바꾸면 "다 볼 수 없음"이고, 그 초안은 승인 버튼을 내지 않는다.
// 자르지 않는다. 이 화면은 로컬이고 쿠키로 보호되므로 받는 사람 주소도 그대로 보여 준다.
import { maskString } from '@aot/agent-runtime';
import { hasInvisibleText } from '@aot/domain';

/** 조각 하나(글 한 필드)의 상한, 전체 상한. 넘으면 자르지 않고 승인을 막는다 */
export const CHUNK_MAX = 50_000;
export const TOTAL_MAX = 300_000;
export const CHUNKS_MAX = 400;

export interface Chunk {
  /** 필드 이름 (키). 최상위가 객체가 아니면 '(전체)' */
  key: string;
  /** 사람이 읽는 글. 문자열은 그대로, 여러 줄 주소 목록은 줄마다 하나, 그 밖의 값은 들여쓴 JSON */
  text: string;
  /** 가리기·크기 검사 결과의 위치 표시용 */
  kind: 'string' | 'list' | 'json';
}

const ADDRESS_KEYS: readonly string[] = ['to', 'cc', 'bcc'];

/** 최상위 필드마다 조각 하나. 알려진 필드든 모르는 필드든 빠뜨리지 않는다 */
export function chunksOf(payload: unknown): Chunk[] {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return Object.entries(payload as Record<string, unknown>).map(([key, value]) => chunkOf(key, value));
  }
  return [chunkOf('(전체)', payload)];
}

function chunkOf(key: string, value: unknown): Chunk {
  if (typeof value === 'string') return { key, text: value, kind: 'string' };
  if (ADDRESS_KEYS.includes(key) && Array.isArray(value) && value.every((v) => typeof v === 'string')) return { key, text: (value as string[]).join('\n'), kind: 'list' };
  return { key, text: JSON.stringify(value, null, 2) ?? String(value), kind: 'json' };
}

// 제어 문자(줄바꿈·탭 제외), 짝 없는 서로게이트, 대체 문자(깨진 바이트) 는 글이 아니라고 본다
// eslint-disable-next-line no-control-regex
const BINARY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|�/u;

/** 다 볼 수 없는 필드와 이유. 비어 있어야 승인 버튼을 낼 수 있다 */
export function unshowableOf(payload: unknown): string[] {
  const chunks = chunksOf(payload);
  const out: string[] = [];
  if (chunks.length > CHUNKS_MAX) out.push(`(전체): 필드가 ${chunks.length}개로 너무 많음`);
  let total = 0;
  for (const chunk of chunks.slice(0, CHUNKS_MAX)) {
    total += chunk.text.length;
    if (chunk.text.length > CHUNK_MAX) out.push(`${chunk.key}: 너무 큼 (${chunk.text.length}자)`);
    else if (BINARY.test(chunk.text) || BINARY.test(chunk.key)) out.push(`${chunk.key}: 글이 아닌 값(바이너리)`);
    else if (hasInvisibleText(chunk.text) || hasInvisibleText(chunk.key)) out.push(`${chunk.key}: 화면에 보이지 않는 문자가 있음`);
    else if (maskString(chunk.text) !== chunk.text) out.push(`${chunk.key}: 비밀값처럼 보여 가려짐`);
  }
  if (total > TOTAL_MAX) out.push(`(전체): 합계 ${total}자로 너무 큼`);
  return out;
}
