// 컨테이너 stdout 을 줄 단위로 읽는다 (스파이크 Q26 "남은 위험 4"). 크기 초과 줄은 개행이 오기 전에도 누적 바이트가 상한을 넘는 순간 끊는다:
// 적대적 에이전트가 개행 없이 무한히 쓰는 경우에도 호스트 메모리가 상한 이상 늘지 않는다. 한 번 `too_long` 이 나오면 리더는 막히고 더 받지 않는다.
import { Buffer } from 'node:buffer';

export type LineEvent = { kind: 'line'; line: string } | { kind: 'too_long'; bytes: number };

export interface LineReader {
  /** 조각을 넣고 완성된 줄(개행 제외)이나 초과 사건을 순서대로 돌려준다 */
  push(chunk: Buffer): LineEvent[];
  /** 개행을 기다리며 쌓아 둔 바이트 수 */
  pendingBytes(): number;
}

/** @param maxLineBytes 개행을 뺀 한 줄의 최대 바이트 수 */
export function createLineReader(maxLineBytes: number): LineReader {
  let parts: Buffer[] = [];
  let pending = 0;
  let blocked = false;
  return {
    push(chunk) {
      const events: LineEvent[] = [];
      if (blocked) return events;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const total = pending + (end - offset);
        if (total > maxLineBytes) {
          blocked = true;
          parts = [];
          pending = 0;
          events.push({ kind: 'too_long', bytes: total });
          return events;
        }
        if (newline === -1) {
          parts.push(Buffer.from(chunk.subarray(offset, end)));
          pending = total;
          break;
        }
        parts.push(chunk.subarray(offset, end));
        events.push({ kind: 'line', line: Buffer.concat(parts).toString('utf8') });
        parts = [];
        pending = 0;
        offset = newline + 1;
      }
      return events;
    },
    pendingBytes: () => pending,
  };
}
