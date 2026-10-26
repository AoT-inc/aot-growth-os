// 호스트 근거 본문 저장소 (상품 등록 검증, docs/plans/registration-dogfood.md). 도구 실행기가 호출 시점에 결과 본문을 여기 저장하고, 평가기가 `EvidenceReader` 로 다시 읽어
// `evidence.content_hash` 와 대조한다. 에이전트는 이 디렉터리에 닿지 않는다(컨테이너는 마운트가 없고 CLI 의 작업 디렉터리는 따로다).
//   - 내용 주소 방식: 파일 이름이 본문의 sha256 이다(`<dir>/<sha256>`). 같은 본문은 한 번만 저장된다. 근거 행의 `ref` 는 `blob:sha256:<hex>`.
//   - 디렉터리는 0700, 파일은 0600. 임시 파일에 쓰고 이름을 바꾼다(반쯤 쓴 파일이 보이지 않는다). 이미 있는 파일은 덮어쓰지 않는다.
//   - 읽을 때 심볼릭 링크를 따라가지 않고 일반 파일만 읽는다. 본문 크기 상한이 있다.
// 이 저장소는 *무결성을 증명하지 않는다*: 평가기가 읽은 본문의 sha256 을 DB 에 적힌 해시와 대조해 바뀐 본문을 거른다.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EvidenceContent, EvidenceReader } from '@aot/evaluation';

export const EVIDENCE_REF_PREFIX = 'blob:sha256:';
export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const REF = /^blob:sha256:([0-9a-f]{64})$/;

export interface EvidenceStore {
  /** 본문을 저장한다. 같은 본문이면 그대로 둔다 */
  put(text: string): { sha256: string; ref: string };
  readonly reader: EvidenceReader;
}

export function createEvidenceStore(options: { dir: string }): EvidenceStore {
  const dir = options.dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = statSync(dir);
  if ((info.mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      throw new Error(`evidence directory ${dir} must not be accessible by other users (mode 0700)`);
    }
  }

  return {
    put(text) {
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length > MAX_EVIDENCE_BYTES) throw new Error(`evidence content is larger than ${MAX_EVIDENCE_BYTES} bytes`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const path = join(dir, sha256);
      if (!existsSync(path)) {
        const temp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
        writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
        renameSync(temp, path);
      }
      return { sha256, ref: `${EVIDENCE_REF_PREFIX}${sha256}` };
    },
    reader: {
      read(row): Promise<EvidenceContent> {
        const match = REF.exec(row.ref);
        if (!match) return Promise.resolve({ readable: false, reason: 'the reference is not a stored evidence blob' });
        try {
          const path = join(dir, match[1]!);
          const stat = lstatSync(path);
          if (!stat.isFile()) return Promise.resolve({ readable: false, reason: 'the stored blob is not a regular file' });
          if (stat.size > MAX_EVIDENCE_BYTES) return Promise.resolve({ readable: false, reason: 'the stored blob is too large' });
          return Promise.resolve({ readable: true, text: readFileSync(path, 'utf8') });
        } catch {
          return Promise.resolve({ readable: false, reason: 'the stored blob does not exist' });
        }
      },
    },
  };
}
