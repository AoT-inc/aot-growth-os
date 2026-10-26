// repo_read 도구 실행기 (list_tree · read_file · read_metadata · read_history). 읽기 전용이고, 결과는 호스트 근거로 저장한 뒤 근거 id 와 함께 돌려준다.
// 인자는 키 목록이 닫혀 있다(모르는 키 거부). 저장소는 인자가 아니라 run 에 묶인 바인딩(`RegistrationToolRun.repo`)이 정한다.
// "읽을 수 없는 항목"(비밀 파일 이름·바이너리·없음 등)은 오류가 아니라 `status:'unavailable'` 결과다 — 에이전트가 보고서에 "수집 불가" 사유로 적을 수 있게.
// 이력은 개수·날짜만 돌려준다(작성자 이름·이메일·원격 주소는 돌려주지 않는다). 저장소가 정하는 문자열(경로·브랜치 이름)은 `safeText` 를 거친다.
// git 은 후보 루트 자신의 `.git` 디렉터리가 있을 때만 쓴다 — `.git` 파일(`gitdir:`)이나 부모 저장소로 루트 밖의 다른 저장소를 읽지 못한다.
import type { Clock } from '@aot/domain';

import type { JsonObject, JsonValue } from '../contract.ts';
import type { ToolExecutionRequest, ToolExecutionResult } from '../gateway.ts';
import type { RegistrationToolRun } from './capture.ts';
import type { GitRunner } from './git.ts';
import {
  countFiles, DEFAULT_MAX_FILE_BYTES, hasOwnGitDir, listTree, MAX_FILE_BYTES_LIMIT, MAX_TREE_DEPTH, MAX_TREE_ENTRIES, normalizeRelativePath, readTextFile, RepoToolError, safeText,
  type UnavailableReason,
} from './repo-files.ts';

export const REPO_READ_TOOL = 'repo_read';
export const REPO_READ_OPERATIONS = ['list_tree', 'read_file', 'read_metadata', 'read_history'] as const;

const DAY_MS = 86_400_000;
const MAX_CONTRIBUTOR_SAMPLE = 20_000;
const MAX_ROOT_COMMITS = 5;
/** 결과 JSON 의 상한(바이트). 게이트웨이 프레임 상한(1 MiB)보다 한참 아래로 둔다: 넘으면 게이트웨이가 결과를 잘라 앞부분 미리보기만 보낸다 */
export const MAX_RESULT_BYTES = 700_000;

const unavailable = (reason: UnavailableReason): JsonObject => ({ status: 'unavailable', reason });

function exactArgs(args: Readonly<JsonObject>, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new RepoToolError('invalid_args', `unknown argument(s): ${extra.join(', ')}`);
}

function intArg(args: Readonly<JsonObject>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new RepoToolError('invalid_args', `${key} must be an integer from ${min} to ${max}`);
  return value;
}

/** 원격 URL 에서 호스트 종류만 뽑는다. 주소 자체는 돌려주지 않는다 */
export function remoteKind(url: string): { kind: 'github' | 'gitlab' | 'bitbucket' | 'other'; credentialsInUrl: boolean } {
  const trimmed = url.trim();
  let host = '';
  let credentials = false;
  const scp = /^([^@/\s]+)@([^:/\s]+):/.exec(trimmed); // git@host:path
  if (scp) {
    host = scp[2]!;
  } else {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      credentials = parsed.password !== '';
    } catch {
      host = '';
    }
  }
  host = host.toLowerCase();
  const kind = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : host === 'bitbucket.org' ? 'bitbucket' : 'other';
  return { kind, credentialsInUrl: credentials };
}

/** 직렬화한 결과가 상한 안에 들어가게 줄인다 (목록은 뒤 항목부터, 본문은 줄 경계까지). 줄였으면 `truncated:true` */
function fitRecord(record: JsonObject): JsonObject {
  const size = (value: JsonObject): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
  let current = record;
  for (let guard = 0; guard < 40 && size(current) > MAX_RESULT_BYTES; guard += 1) {
    if (Array.isArray(current['entries']) && current['entries'].length > 1) {
      current = { ...current, truncated: true, entries: current['entries'].slice(0, Math.floor(current['entries'].length / 2)) };
    } else if (typeof current['text'] === 'string' && current['text'].length > 1) {
      const half = current['text'].slice(0, Math.floor(current['text'].length / 2));
      const cut = half.lastIndexOf('\n');
      current = { ...current, truncated: true, text: cut === -1 ? half : half.slice(0, cut + 1) };
    } else {
      break;
    }
  }
  return current;
}

export function createRepoReadExecutor(deps: { run: RegistrationToolRun; git: GitRunner; clock: Clock }) {
  const { run, git, clock } = deps;

  /** 결과를 근거로 저장하고 `evidence_id` 를 맨 앞에 붙여 돌려준다(게이트웨이가 큰 결과를 앞에서부터 자르므로 id 가 살아남게) */
  const store = async (record: JsonObject, signal: AbortSignal): Promise<JsonObject> => {
    const fitted = fitRecord(record);
    if (signal.aborted) throw new RepoToolError('capture_failed', 'the call was cancelled before the result was stored');
    let captured;
    try {
      captured = await run.evidence.capture({ text: JSON.stringify(fitted), trustOrigin: 'external_untrusted' });
    } catch (error) {
      throw new RepoToolError('capture_failed', error instanceof Error ? error.message : String(error));
    }
    return { evidence_id: captured.evidenceId, ...fitted };
  };

  async function listTreeOp(args: Readonly<JsonObject>, signal: AbortSignal): Promise<JsonValue> {
    exactArgs(args, ['path', 'depth', 'max_entries']);
    const rel = normalizeRelativePath(args['path'] ?? '');
    if (rel === null) return unavailable('invalid_path');
    const depth = intArg(args, 'depth', 2, 1, MAX_TREE_DEPTH);
    const maxEntries = intArg(args, 'max_entries', 500, 1, MAX_TREE_ENTRIES);
    const listing = await listTree(run.repo().root, rel, depth, maxEntries);
    if (!listing.ok) return unavailable(listing.reason);
    return store({ type: 'repo_tree@1', path: rel === '' ? '.' : safeText(rel, 400), depth, truncated: listing.truncated, entries: listing.entries.map((entry) => ({ ...entry })) }, signal);
  }

  async function readFileOp(args: Readonly<JsonObject>, signal: AbortSignal): Promise<JsonValue> {
    exactArgs(args, ['path', 'max_bytes']);
    const rel = normalizeRelativePath(args['path']);
    if (rel === null || rel === '') return unavailable('invalid_path');
    const maxBytes = intArg(args, 'max_bytes', DEFAULT_MAX_FILE_BYTES, 1, MAX_FILE_BYTES_LIMIT);
    const file = await readTextFile(run.repo().root, rel, maxBytes);
    if (!file.ok) return unavailable(file.reason);
    return store({ type: 'repo_file@1', path: safeText(rel, 400), bytes: file.bytes, truncated: file.truncated, text: file.text }, signal);
  }

  async function readMetadataOp(args: Readonly<JsonObject>, signal: AbortSignal): Promise<JsonValue> {
    exactArgs(args, []);
    const root = run.repo().root;
    const ownGit = await hasOwnGitDir(root);
    const inside = ownGit ? await git.tryRun(root, ['rev-parse', '--is-inside-work-tree'], signal) : { ok: false as const };
    const counted = await countFiles(root);
    const languages = [...counted.byExtension.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12).map(([extension, files]) => ({ extension, files }));
    const record: JsonObject = { type: 'repo_metadata@1', is_git: inside.ok && inside.stdout.trim() === 'true', file_count: counted.files, manifests: counted.manifests, languages };
    if (record['is_git'] === true) {
      const branch = await git.tryRun(root, ['symbolic-ref', '--short', 'HEAD'], signal);
      record['default_branch'] = branch.ok ? safeText(branch.stdout.trim(), 100) : null;
      const names = await git.tryRun(root, ['remote'], signal);
      const remotes: JsonObject[] = [];
      for (const name of (names.ok ? names.stdout.split('\n') : []).map((line) => line.trim()).filter((line) => line !== '').slice(0, 10)) {
        const url = await git.tryRun(root, ['remote', 'get-url', '--', name], signal);
        if (url.ok) {
          const { kind, credentialsInUrl } = remoteKind(url.stdout);
          remotes.push({ kind, credentials_in_url: credentialsInUrl });
        }
      }
      record['remotes'] = remotes;
    }
    return store(record, signal);
  }

  async function readHistoryOp(args: Readonly<JsonObject>, signal: AbortSignal): Promise<JsonValue> {
    exactArgs(args, []);
    const root = run.repo().root;
    if (!(await hasOwnGitDir(root))) return unavailable('not_found');
    const inside = await git.tryRun(root, ['rev-parse', '--is-inside-work-tree'], signal);
    if (!inside.ok || inside.stdout.trim() !== 'true') return unavailable('not_found');
    const head = await git.tryRun(root, ['rev-parse', '--verify', 'HEAD'], signal);
    if (!head.ok) return store({ type: 'repo_history@1', commit_count: 0, first_commit_at: null, last_commit_at: null, commits_last_90d: 0, contributors: 0, contributors_sampled_commits: 0 }, signal);
    // 리비전 뒤의 `--` 는 이름이 `HEAD`·커밋 해시인 작업 트리 파일과의 모호함을 없앤다
    const count = Number((await git.run(root, ['rev-list', '--count', 'HEAD', '--'], signal)).trim());
    const last = (await git.run(root, ['log', '-1', '--format=%cI', 'HEAD', '--'], signal)).trim();
    const roots = (await git.run(root, ['rev-list', '--max-parents=0', 'HEAD', '--'], signal)).split('\n').map((line) => line.trim()).filter((line) => /^[0-9a-f]{40,64}$/.test(line)).slice(0, MAX_ROOT_COMMITS);
    const firstDates: string[] = [];
    for (const commit of roots) firstDates.push((await git.run(root, ['log', '-1', '--format=%cI', commit, '--'], signal)).trim());
    const since = new Date(clock.nowMs() - 90 * DAY_MS).toISOString();
    const recent = Number((await git.run(root, ['rev-list', '--count', `--since=${since}`, 'HEAD', '--'], signal)).trim());
    // 기여자 수만 센다: 이메일은 메모리에서 세고 돌려주지도 저장하지도 않는다
    const emails = (await git.run(root, ['log', `--max-count=${MAX_CONTRIBUTOR_SAMPLE}`, '--format=%aE', 'HEAD', '--'], signal)).split('\n').map((line) => line.trim().toLowerCase()).filter((line) => line !== '');
    return store({
      type: 'repo_history@1',
      commit_count: Number.isFinite(count) ? count : 0,
      first_commit_at: firstDates.length === 0 ? null : [...firstDates].sort()[0]!,
      last_commit_at: last === '' ? null : last,
      commits_last_90d: Number.isFinite(recent) ? recent : 0,
      contributors: new Set(emails).size,
      contributors_sampled_commits: emails.length,
    }, signal);
  }

  return async function execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    switch (request.operation) {
      case 'list_tree':
        return { result: await listTreeOp(request.args, request.signal) };
      case 'read_file':
        return { result: await readFileOp(request.args, request.signal) };
      case 'read_metadata':
        return { result: await readMetadataOp(request.args, request.signal) };
      case 'read_history':
        return { result: await readHistoryOp(request.args, request.signal) };
      default:
        throw new RepoToolError('invalid_args', `unknown repo_read operation '${request.operation.slice(0, 40)}'`);
    }
  };
}
