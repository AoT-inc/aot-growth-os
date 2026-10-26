// 근거 본문 읽기 (EvidenceReader 포트 감싸기). 한 번의 검증 안에서 같은 행은 한 번만 읽고, 읽은 본문의 sha256 을 `evidence.content_hash` 와 대조한다 —
// 저장된 본문이 바뀌었거나 해시를 기록하지 않은 근거는 원본 증거로 인정하지 않는다. 예외는 "읽을 수 없음"과 같다.
import { createHash } from 'node:crypto';

import type { EvidenceRow } from '@aot/domain';

import type { EvidenceReader } from './ports.ts';

export type VerifiedContent = { ok: true; text: string; sha256: string } | { ok: false; reason: string };

/** `sha256:<hex>` 와 `<hex>` 를 같게 본다 */
const normalizeHash = (hash: string): string => hash.trim().toLowerCase().replace(/^sha256:/, '');

export class EvidenceContentReader {
  readonly #reader: EvidenceReader;
  readonly #cache = new Map<string, Promise<VerifiedContent>>();

  constructor(reader: EvidenceReader) {
    this.#reader = reader;
  }

  read(row: Pick<EvidenceRow, 'id' | 'kind' | 'ref' | 'content_hash'>): Promise<VerifiedContent> {
    let found = this.#cache.get(row.id);
    if (!found) {
      found = this.#load(row);
      this.#cache.set(row.id, found);
    }
    return found;
  }

  async #load(row: Pick<EvidenceRow, 'id' | 'kind' | 'ref' | 'content_hash'>): Promise<VerifiedContent> {
    if (row.content_hash === null || row.content_hash.trim() === '') return { ok: false, reason: 'no content hash is recorded for this evidence' };
    let content;
    try {
      content = await this.#reader.read({ id: row.id, kind: row.kind, ref: row.ref, content_hash: row.content_hash });
    } catch (error) {
      return { ok: false, reason: `the content could not be read: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
    }
    if (!content.readable) return { ok: false, reason: `the content is not readable: ${content.reason}`.slice(0, 300) };
    const sha256 = createHash('sha256').update(content.text, 'utf8').digest('hex');
    if (sha256 !== normalizeHash(row.content_hash)) return { ok: false, reason: 'the stored content does not match the recorded content hash' };
    return { ok: true, text: content.text, sha256 };
  }
}
