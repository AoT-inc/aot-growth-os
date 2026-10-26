// 등록 후보 저장소를 읽기 전용으로 만지는 파일 접근 (repo_read·secret_scan·license_check 공용). 저장소는 신뢰할 수 없는 입력이다:
//   - 경로는 저장소 루트 기준 상대 경로 문자열뿐이다(절대 경로·`..`·NUL·역슬래시 거부). 어디서 온 경로든 `realpath` 가 루트 안인지 다시 확인한다 → 심볼릭 링크로 밖을 읽을 수 없다.
//   - 마지막 요소는 `O_NOFOLLOW` 로 열고, 열린 파일을 `fstat` 해서 일반 파일이고 하드링크가 하나뿐인지 확인한다(저장소 밖 파일의 하드링크 거부).
//   - 목록은 심볼릭 링크를 따라가지 않고(`symlink` 로만 표시) `.git` 안으로 내려가지 않는다.
//   - 비밀 파일 이름(`.env`, 키 파일 등)과 `.git/` 안은 내용을 읽지 않는다. **요청한 경로와 `realpath` 로 해석한 경로 둘 다** 검사한다 — 이름이 평범한 심볼릭 링크로 `.env`·`.git` 을 읽을 수 없다.
//   - 일반 파일만 연다: `lstat` 로 FIFO·장치 같은 특수 파일을 먼저 거르고 `O_NONBLOCK` 으로 열어(바뀌어도 쓰는 쪽이 없는 FIFO 에서 막히지 않는다) `fstat` 로 다시 확인한다.
//   - 읽은 텍스트는 호출 기록과 같은 마스킹(`maskString`)에 더해 `키: 값` 꼴의 비밀 줄 마스킹을 거친다. 잘린 텍스트는 마지막 줄 경계까지만 돌려준다(토큰이 반쯤 잘려 새지 않게).
//   - 경로·이름 문자열은 제어 문자를 공백으로 바꾸고 마스킹한다(파일 이름에 심은 지시문·비밀 모양이 모델에 그대로 가지 않게).
// 쓰기 연산은 이 파일에 하나도 없다.
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { maskString } from '../mask.ts';

export type RepoToolErrorCode =
  | 'invalid_args' | 'repo_not_bound' | 'repo_access_not_granted' | 'git_failed' | 'scan_failed' | 'capture_failed' | 'too_many_files' | 'quota_exceeded';

/** 호출을 끝까지 수행할 수 없는 실패(설정·환경 문제). 게이트웨이가 에이전트에는 `tool_error` 만 알리고 사유는 호출 기록에 남긴다 */
export class RepoToolError extends Error {
  readonly code: RepoToolErrorCode;
  constructor(code: RepoToolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RepoToolError';
    this.code = code;
  }
}

/** 에이전트가 알아야 하는 "이 항목은 읽을 수 없음" 사유. 오류가 아니라 결과의 `status:'unavailable'` 로 돌려준다 */
export type UnavailableReason = 'not_found' | 'not_a_file' | 'not_a_directory' | 'path_denied' | 'path_outside_repo' | 'binary_file' | 'hardlinked_file' | 'invalid_path';

export const MAX_PATH_CHARS = 512;
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const MAX_FILE_BYTES_LIMIT = 512 * 1024;
export const MAX_TREE_ENTRIES = 2000;
export const MAX_TREE_DEPTH = 4;
export const MAX_COUNTED_FILES = 500_000;

const isControlCode = (code: number): boolean => code <= 0x1f || code === 0x7f;
/** 제어 문자(NUL·개행·탭 등 0x00-0x1f, 0x7f)가 있는가 */
export const hasControlChar = (text: string): boolean => [...text].some((char) => isControlCode(char.charCodeAt(0)));
/** 제어 문자를 공백으로 바꾼다 */
export const replaceControlChars = (text: string): string => [...text].map((char) => (isControlCode(char.charCodeAt(0)) ? ' ' : char)).join('');

/** 저장소 상대 경로를 정규화한다. 루트는 빈 문자열. 잘못된 경로는 null */
export function normalizeRelativePath(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_PATH_CHARS || hasControlChar(input) || input.includes('\\')) return null;
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) return null;
  const segments: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.join('/');
}

/** 내용을 읽지 않는 경로: 비밀 파일 이름과 `.git/` 안 (`.git/` 의 이력은 read_history 가 git 으로만 본다). 이름은 대소문자를 구분하지 않는다(대소문자 무시 파일시스템) */
const DENIED_NAMES: readonly RegExp[] = [
  /^\.?env([._-].*)?$/i, /\.env$/i, /^\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc|tfstate|tfvars|tfstate\.backup)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|htpasswd|pgpass|my\.cnf|dockercfg|vault-token|yarnrc\.yml|s3cfg|bash_history|zsh_history|python_history|psql_history|mysql_history)$/i,
  /^credentials?(\..*)?$/i, /^secrets?(\..*)?$/i, /^wp-config\.php$/i, /^\.?service[-_]?account.*\.json$/i,
  /(^|[-_.])(key|keys|secret|secrets|credential|credentials|token|tokens|apikey)\.(json|ya?ml|txt|ini|conf|toml|cfg)$/i,
  /^kubeconfig$/i,
];
/** 디렉터리 이름이 이 값이면 그 안의 어떤 파일도 읽지 않는다 */
const DENIED_DIRS: readonly string[] = ['.git', '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.azure', '.config/gcloud'];

export function isDeniedPath(rel: string): boolean {
  const segments = rel.split('/').filter((segment) => segment !== '').map((segment) => segment.toLowerCase());
  for (const dir of DENIED_DIRS) {
    const parts = dir.split('/');
    for (let i = 0; i + parts.length <= segments.length; i += 1) {
      if (parts.every((part, j) => segments[i + j] === part)) return true;
    }
  }
  const name = segments[segments.length - 1] ?? '';
  return DENIED_NAMES.some((pattern) => pattern.test(name));
}

/** 제어 문자를 공백으로 바꾸고 비밀 모양을 가린 뒤 길이를 자른다 (파일 이름·위치·브랜치 이름처럼 저장소가 정한 문자열용) */
export function safeText(text: string, max = 300): string {
  const cleaned = maskString(replaceControlChars(text));
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
}

/** `키: 값`·`키=값` 꼴에서 키 이름이 비밀을 가리키면 값을 가린다 (알려진 토큰 모양이 아닌 일반 설정 값용) */
const SECRET_KEY_VALUE = /\b((?:[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*)(?:"[^"\n]{3,}"|'[^'\n]{3,}'|[^\s"',;]{4,})/gi;

export function maskRepoText(text: string): string {
  return maskString(text).replace(SECRET_KEY_VALUE, (_match, key: string) => `${key}[REDACTED]`);
}

export interface ResolvedPath {
  /** `realpath` 로 해석한 절대 경로 (루트 안임이 확인됨) */
  real: string;
  /** 해석한 저장소 루트 */
  realRoot: string;
}

/** 루트 안의 경로를 `realpath` 로 해석한다. 루트 밖이면 `path_outside_repo`, 없으면 `not_found` */
export async function resolveInsideRoot(root: string, rel: string): Promise<ResolvedPath | UnavailableReason> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new RepoToolError('repo_not_bound', 'the repository root cannot be resolved');
  }
  let real: string;
  try {
    real = await realpath(join(realRoot, rel));
  } catch {
    return 'not_found';
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return 'path_outside_repo';
  return { real, realRoot };
}

/** `<루트>/.git` 이 이 저장소 자신의 실제 디렉터리인가. `.git` 파일(`gitdir:` 로 다른 저장소를 가리킴)·심볼릭 링크·없음이면 false — git 이 루트 밖의 다른 저장소를 읽지 않게 한다 */
export async function hasOwnGitDir(root: string): Promise<boolean> {
  try {
    const realRoot = await realpath(root);
    return (await lstat(join(realRoot, '.git'))).isDirectory();
  } catch {
    return false;
  }
}

export type FileRead = { ok: true; text: string; bytes: number; truncated: boolean } | { ok: false; reason: UnavailableReason };

/** 해석한 경로가 읽으면 안 되는 곳인가 (요청 경로는 평범한 이름이어도 심볼릭 링크가 `.env`·`.git` 을 가리킬 수 있다) */
function resolvedIsDenied(resolved: ResolvedPath): boolean {
  return isDeniedPath(relative(resolved.realRoot, resolved.real).split(sep).join('/'));
}

/** 텍스트 파일을 읽는다. 비밀 파일 이름(요청·해석 경로 둘 다)·특수 파일·바이너리·하드링크·일반 파일이 아닌 것은 내용을 읽지 않는다. 텍스트는 마스킹하고, 잘렸으면 마지막 줄 경계에서 자른다 */
export async function readTextFile(root: string, rel: string, maxBytes: number): Promise<FileRead> {
  if (isDeniedPath(rel)) return { ok: false, reason: 'path_denied' };
  const resolved = await resolveInsideRoot(root, rel);
  if (typeof resolved === 'string') return { ok: false, reason: resolved };
  if (resolvedIsDenied(resolved)) return { ok: false, reason: 'path_denied' };
  // FIFO·장치 같은 특수 파일은 열지 않는다(쓰는 쪽이 없는 FIFO 를 열면 스레드 풀이 막힌다). 해석한 경로에는 심볼릭 링크가 없다
  try {
    if (!(await lstat(resolved.real)).isFile()) return { ok: false, reason: 'not_a_file' };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  let handle;
  try {
    // O_NONBLOCK: lstat 뒤에 FIFO 로 바뀌어도 열기가 막히지 않는다(일반 파일에는 영향이 없다). 열린 파일을 fstat 로 다시 확인한다
    handle = await open(resolved.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: 'not_a_file' };
    if (info.nlink > 1) return { ok: false, reason: 'hardlinked_file' };
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    const truncated = bytesRead > maxBytes;
    let bytes = buffer.subarray(0, truncated ? maxBytes : bytesRead);
    if (bytes.subarray(0, 8192).includes(0)) return { ok: false, reason: 'binary_file' };
    let text: string | null = null;
    // 잘린 곳이 UTF-8 문자 한가운데일 수 있으니 끝에서 최대 3바이트까지 물러난다
    for (let cut = 0; cut <= (truncated ? 3 : 0) && text === null; cut += 1) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - cut));
        bytes = bytes.subarray(0, bytes.length - cut);
      } catch {
        text = null;
      }
    }
    if (text === null) return { ok: false, reason: 'binary_file' };
    if (truncated) {
      // 마지막 줄이 중간에 잘렸다: 토큰이 반쯤 남아 마스킹을 피하지 않도록 마지막 줄바꿈까지만 돌려준다(줄바꿈이 없으면 비운다)
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
      bytes = Buffer.from(text, 'utf8');
    }
    return { ok: true, text: maskRepoText(text), bytes: bytes.length, truncated };
  } finally {
    await handle.close();
  }
}

export interface TreeEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

export type TreeListing =
  | { ok: true; entries: TreeEntry[]; truncated: boolean }
  | { ok: false; reason: UnavailableReason };

/** 한 디렉터리에서 읽는 이름의 상한 (항목이 수십만 개인 디렉터리가 이벤트 루프를 막지 않게) */
export const MAX_ENTRIES_PER_DIRECTORY = 20_000;

export async function readNames(dir: string): Promise<{ names: { name: string; kind: TreeEntry['type'] }[]; capped: boolean }> {
  const names: { name: string; kind: TreeEntry['type'] }[] = [];
  let capped = false;
  const handle = await opendir(dir);
  try {
    for await (const entry of handle) {
      if (names.length >= MAX_ENTRIES_PER_DIRECTORY) {
        capped = true;
        break;
      }
      names.push({ name: entry.name, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other' });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { names, capped };
}

/** 디렉터리 목록 (너비 우선, 깊이 `depth`). 심볼릭 링크는 따라가지 않고 `.git` 안으로는 내려가지 않으며 해석한 경로가 `.git`·비밀 디렉터리 안이면 거부한다 */
export async function listTree(root: string, rel: string, depth: number, maxEntries: number): Promise<TreeListing> {
  if (isDeniedPath(rel)) return { ok: false, reason: 'path_denied' };
  const resolved = await resolveInsideRoot(root, rel);
  if (typeof resolved === 'string') return { ok: false, reason: resolved };
  if (resolvedIsDenied(resolved)) return { ok: false, reason: 'path_denied' };
  const start = await lstat(resolved.real);
  if (!start.isDirectory()) return { ok: false, reason: 'not_a_directory' };
  const entries: TreeEntry[] = [];
  let truncated = false;
  let level: { real: string; rel: string }[] = [{ real: resolved.real, rel }];
  for (let d = 0; d < depth && level.length > 0 && !truncated; d += 1) {
    const next: { real: string; rel: string }[] = [];
    for (const dir of level) {
      let read;
      try {
        read = await readNames(dir.real);
      } catch {
        continue; // 읽을 수 없는 디렉터리는 건너뛴다(권한 등)
      }
      if (read.capped) truncated = true;
      read.names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of read.names) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        const entryRel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`;
        const shown = safeText(entryRel, 400);
        if (entry.kind === 'dir') {
          entries.push({ path: shown, type: 'dir' });
          // `.git`·비밀 디렉터리 안으로는 내려가지 않는다 (이름만 보인다)
          if (!isDeniedPath(`${entryRel}/x`)) next.push({ real: join(dir.real, entry.name), rel: entryRel });
        } else if (entry.kind === 'file') {
          let size: number | undefined;
          try {
            size = (await lstat(join(dir.real, entry.name))).size;
          } catch {
            size = undefined;
          }
          entries.push({ path: shown, type: 'file', ...(size === undefined ? {} : { size }) });
        } else {
          entries.push({ path: shown, type: entry.kind });
        }
      }
      if (entries.length >= maxEntries) break;
    }
    level = next;
  }
  return { ok: true, entries, truncated };
}

/** 일반 파일 수와 확장자별 개수 (`.git` 안은 세지 않고 심볼릭 링크는 따라가지 않는다). 상한을 넘으면 던진다 */
export async function countFiles(root: string): Promise<{ files: number; byExtension: Map<string, number>; manifests: string[] }> {
  const realRoot = await realpath(root).catch(() => { throw new RepoToolError('repo_not_bound', 'the repository root cannot be resolved'); });
  const byExtension = new Map<string, number>();
  const manifests: string[] = [];
  let files = 0;
  const pending: string[] = [realRoot];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let handle;
    try {
      handle = await opendir(dir); // 스트리밍: 항목이 아주 많은 디렉터리도 배열로 한꺼번에 올리지 않는다
    } catch {
      continue;
    }
    try {
      for await (const entry of handle) {
        if (entry.isDirectory()) {
          if (entry.name !== '.git') pending.push(join(dir, entry.name));
        } else if (entry.isFile()) {
          files += 1;
          if (files > MAX_COUNTED_FILES) throw new RepoToolError('too_many_files', `more than ${MAX_COUNTED_FILES} files`);
          const dot = entry.name.lastIndexOf('.');
          const extension = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
          if (extension !== '' && extension.length <= 12) byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
          if (dir === realRoot && MANIFEST_NAMES.includes(entry.name)) manifests.push(entry.name);
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return { files, byExtension, manifests: manifests.sort() };
}

/** 루트에서 스택을 알려 주는 매니페스트·잠금 파일 이름 */
export const MANIFEST_NAMES: readonly string[] = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'requirements.txt',
  'Pipfile', 'poetry.lock', 'go.mod', 'go.sum', 'Gemfile', 'Gemfile.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'mix.exs', 'Dockerfile',
];
