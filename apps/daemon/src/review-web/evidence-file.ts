// 증거 파일 읽기 (검토 화면). 요청 경로가 아니라 *증거 행 id* 로만 찾고, 행의 ref 가 가리키는 로컬 파일만 본다.
//   `file:<절대 경로>`   `measure --attach` 가 남긴 로컬 참조. 허용 폴더(근거 저장소 + `--evidence-root`) 밑의 실경로여야 한다(심볼릭 링크는 따라간 뒤 확인).
//   `blob:sha256:<hex>`  호스트 근거 저장소의 본문(텍스트). 이름이 곧 sha256 이라 읽은 내용의 해시가 이름과 같아야 한다.
// 한 번 읽은 바이트로 해시·형식 판정·응답을 모두 한다(검사 뒤 파일이 바뀌는 틈을 없앤다). 그림은 앞부분 바이트(png·jpeg·gif·webp)로 판정한 정확한 형식으로만 내보내고,
// SVG·HTML 등 다른 것은 이름·크기·해시만 보인다. 읽은 내용을 DB 에 쓰거나 서버가 URL 을 가져오는 일은 없다.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, sep } from 'node:path';

import { EVIDENCE_REF_PREFIX, MAX_EVIDENCE_BYTES } from '../evidence-store.ts';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 20_000;
const BLOB = /^blob:sha256:([0-9a-f]{64})$/;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface EvidenceRowLike {
  ref: string;
  content_hash: string | null;
}

export type FileView =
  | { kind: 'image'; mime: ImageType; bytes: Buffer; size: number; sha256: string; name: string; hashChecked: boolean }
  | { kind: 'file'; size: number; sha256: string; name: string; hashChecked: boolean; note?: string }
  | { kind: 'text'; text: string; size: number; sha256: string; hashChecked: boolean }
  | { kind: 'refused'; reason: string };

/** 앞부분 바이트로 그림 형식을 판정한다. 모르면 null (SVG·HTML 포함) */
export function sniffImage(bytes: Buffer): ImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const refuse = (reason: string): FileView => ({ kind: 'refused', reason });

class Refusal extends Error {}

/**
 * 일반 파일 하나를 `limit` 바이트까지 읽는다. 경로 검사 뒤 바뀌는 틈을 줄이려고: 심볼릭 링크를 따라가지 않고(O_NOFOLLOW) 열고,
 * 열린 기술자의 dev/ino 가 먼저 본 lstat 과 같아야 하며, 하드 링크(nlink > 1)는 거부한다(허용 폴더 안의 이름이 폴더 밖 파일의 다른 이름일 수 있다). 읽기는 기술자로만 한다.
 */
function readRegularFile(path: string, limit: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile()) throw new Refusal('일반 파일이 아니다');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Refusal('일반 파일이 아니다');
    if (info.dev !== before.dev || info.ino !== before.ino) throw new Refusal('검사하는 사이 파일이 바뀌었다');
    if (info.nlink > 1) throw new Refusal('하드 링크가 있는 파일은 보여 주지 않는다 (허용 폴더 밖 파일의 다른 이름일 수 있다)');
    if (info.size > limit) throw new Refusal(`파일이 너무 크다 (최대 ${Math.round(limit / 1024 / 1024)} MB)`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** 허용 폴더의 실경로 목록 (없는 폴더는 건너뛴다). 파일 시스템 루트는 허용하지 않는다 */
export function resolveRoots(paths: readonly string[]): string[] {
  const roots: string[] = [];
  for (const path of paths) {
    try {
      const real = realpathSync(path);
      if (real === sep || /^[A-Za-z]:\\?$/.test(real)) throw new Error(`evidence root '${path}' is a filesystem root; give a specific directory`);
      roots.push(real);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('evidence root')) throw error;
      // 아직 없는 폴더는 허용 목록에 넣지 않는다
    }
  }
  return roots;
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** 증거 행 하나의 참조가 가리키는 내용을 안전하게 읽는다 */
export function readEvidence(row: EvidenceRowLike, options: { evidenceDir: string; roots: readonly string[] }): FileView {
  const expected = row.content_hash === null || row.content_hash === '' ? null : row.content_hash.replace(/^sha256:/, '').toLowerCase();
  const blob = BLOB.exec(row.ref);
  try {
    if (blob) {
      const hex = blob[1]!;
      const path = join(options.evidenceDir, hex);
      const bytes = readRegularFile(path, MAX_EVIDENCE_BYTES);
      const sha256 = sha256Of(bytes);
      if (sha256 !== hex) return refuse('저장된 본문의 해시가 파일 이름과 다르다 (바뀐 것으로 보고 보여 주지 않는다)');
      if (expected !== null && expected !== sha256) return refuse('저장된 본문의 해시가 증거 행의 해시와 다르다 (보여 주지 않는다)');
      if (bytes.includes(0)) return { kind: 'file', size: bytes.length, sha256, name: hex.slice(0, 12), hashChecked: true };
      // 자르지 않는다: 비밀 가리기를 먼저 하고 화면이 길이를 자르며 생략 표시를 붙인다
      return { kind: 'text', text: bytes.toString('utf8'), size: bytes.length, sha256, hashChecked: true };
    }
    if (row.ref.startsWith('file:')) {
      const requested = row.ref.slice('file:'.length);
      if (!isAbsolute(requested) || /[\0\r\n]/.test(requested)) return refuse('절대 경로가 아닌 로컬 참조');
      const roots = resolveRoots(options.roots);
      if (roots.length === 0) return refuse('허용된 증거 폴더가 없다 (--evidence-root 로 알려 준다)');
      const real = realpathSync(requested);
      if (!roots.some((root) => within(real, root))) return refuse('허용된 증거 폴더 밖의 파일이다');
      const bytes = readRegularFile(real, MAX_IMAGE_BYTES);
      const sha256 = sha256Of(bytes);
      if (expected !== null && expected !== sha256) return refuse('파일의 해시가 증거 행의 해시와 다르다 (바뀐 파일이라 보여 주지 않는다)');
      // 해시가 없으면 내용을 확인할 수 없다: 이름·크기·해시만 알리고 표시하지 않는다
      if (expected === null) return { kind: 'file', size: bytes.length, sha256, name: basename(real), hashChecked: false, note: '해시 없음 — 표시하지 않음' };
      const mime = sniffImage(bytes);
      if (mime === null) return { kind: 'file', size: bytes.length, sha256, name: basename(real), hashChecked: expected !== null };
      return { kind: 'image', mime, bytes, size: bytes.length, sha256, name: basename(real), hashChecked: expected !== null };
    }
  } catch (error) {
    if (error instanceof Refusal) return refuse(error.message);
    return refuse('파일을 읽을 수 없다 (없거나 접근할 수 없다)');
  }
  return refuse('로컬 파일 참조가 아니다');
}

export const isBlobRef = (ref: string): boolean => ref.startsWith(EVIDENCE_REF_PREFIX);
export const isFileRef = (ref: string): boolean => ref.startsWith('file:');
