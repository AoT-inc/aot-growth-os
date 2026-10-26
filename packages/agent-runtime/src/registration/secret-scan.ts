// secret_scan 도구 실행기 (scan_tree · scan_history). 비밀값 스캐너(gitleaks 8.30.1, Q21)를 호스트에서 실행하고 결과를 `secret_scan_summary@1` 로만 돌려준다.
//   - 스캐너 설정은 *항상* 운영자가 정한 파일(`--config`)이다. 후보 저장소 안의 `.gitleaks.toml` 로 허용 목록을 심어 스캔을 피할 수 없다.
//   - `--redact`. 보고서 파일은 0700 임시 디렉터리에 쓰고 읽은 뒤 지운다. 스캐너의 stdout·stderr 는 버린다.
//   - 보고서에서 읽는 필드는 RuleID·File·Commit 뿐이다. 값·매치·줄 같은 나머지는 읽지도 저장하지도 돌려주지도 않는다(요약 형식의 허용 키 목록이 닫혀 있어 시험이 확인한다).
//   - 후보 저장소가 스캔을 가리지 못하게 한다: `--ignore-gitleaks-allow`(소스의 `gitleaks:allow` 주석 무시), 루트의 `.gitleaksignore` 는 억제를 막을 수 없으므로 *발견*(`scanner-suppression`)으로 보고한다,
//     교체 객체(`refs/replace`)는 쓰지 않고(`GIT_NO_REPLACE_OBJECTS`), 얕은 저장소(`shallow`)·자기 `.git` 디렉터리가 없는 루트는 이력 스캔을 하지 않는다.
//   - 스캐너가 시간 초과·오류로 끝나거나 파일을 건너뛰었다고 경고하면(권한 등) 부분 결과를 "완전함"으로 위장하지 않고 던진다(`scan_failed`) → 에이전트는 수집 불가로 보고하고 `scan_coverage_complete` 가 실패한다.
//   - 기본 규칙 집합의 허용 경로(`node_modules/` 등)는 스캐너가 조용히 건너뛴다 — 이것은 막지 못하는 한계다(docs/operations/registration-tools.md §4).
// 이력 스캔은 `git log` 를 쓰므로 repo 설정이 코드를 실행하지 못하게 git 환경을 굳히고(GIT_CONFIG_*), `--no-textconv --no-ext-diff` 를 준다.
import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAX_SCAN_FINDINGS, parseSecretScanSummary, SECRET_SCAN_SUMMARY_TYPE, type SecretScanFindingSummary, type SecretScanSummary } from '@aot/evaluation';

import type { JsonObject, JsonValue } from '../contract.ts';
import type { ProcessPort } from '../docker.ts';
import { nodeProcessPort } from '../docker.ts';
import type { ToolExecutionRequest, ToolExecutionResult } from '../gateway.ts';
import type { RegistrationToolRun } from './capture.ts';
import type { GitRunner } from './git.ts';
import { countFiles, hasOwnGitDir, RepoToolError, safeText } from './repo-files.ts';

export const SECRET_SCAN_TOOL = 'secret_scan';
export const SECRET_SCAN_OPERATIONS = ['scan_tree', 'scan_history'] as const;
export const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60_000;
const SHOWN_FINDINGS = 20;
/** 스캐너 보고서 파일의 상한(바이트). 넘으면 읽지 않고 실패한다 */
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
/** 스캐너가 일부를 건너뛰었다는 경고. "leaks found" 같은 정상 경고는 제외한다 */
const SKIPPED_WARNING = /skipping|permission denied|no such file|cannot (?:read|open)|failed to (?:read|open|scan)/i;

export interface SecretScanOptions {
  /** gitleaks 실행 파일의 절대 경로 */
  gitleaksPath: string;
  /** 스캐너 설정 파일의 절대 경로(운영자가 정한다. 기본 규칙을 쓰려면 `[extend] useDefault = true`) */
  configPath: string;
  process?: ProcessPort;
  timeoutMs?: number;
}

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value : '').slice(0, max);

/** 스캐너 보고서에서 위치·종류만 뽑는다 (그 밖의 필드는 읽지 않는다) */
export function findingsFromReport(report: unknown, scope: 'tree' | 'history', root: string): SecretScanFindingSummary[] {
  if (report === null) return [];
  if (!Array.isArray(report)) throw new RepoToolError('scan_failed', 'the scanner report is not a list');
  const findings: SecretScanFindingSummary[] = [];
  for (const item of report.slice(0, MAX_SCAN_FINDINGS)) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    let file = clip(entry['File'], 400);
    if (file.startsWith(`${root}/`)) file = file.slice(root.length + 1);
    if (file.startsWith('/')) file = file.slice(file.lastIndexOf('/') + 1); // 루트 밖 절대 경로는 이름만 (경로 노출 최소화)
    const kind = safeText(clip(entry['RuleID'], 100), 100) || 'unknown-rule';
    const location = scope === 'history' ? `${clip(entry['Commit'], 12).replace(/[^0-9a-f]/gi, '')}:${file}` : file;
    findings.push({ location: location === '' || location === ':' ? '(unknown)' : safeText(location, 500), kind });
  }
  return findings;
}

export function createSecretScanExecutor(deps: { run: RegistrationToolRun; git: GitRunner; options: SecretScanOptions }) {
  const { run, git, options } = deps;
  const port = options.process ?? nodeProcessPort;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  let versionPromise: Promise<string> | undefined;

  const baseEnv = (home: string): Record<string, string> => ({
    PATH: '/usr/bin:/bin:/usr/local/bin',
    HOME: home,
    // gitleaks 가 부르는 git 이 저장소 설정으로 코드를 실행하지 못하게 한다 (명령줄 설정이 저장소 설정을 이긴다)
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat',
    GIT_NO_REPLACE_OBJECTS: '1', // 저장소의 refs/replace 로 커밋을 가릴 수 없다
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    GIT_CONFIG_KEY_2: 'log.showSignature', GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'core.useReplaceRefs', GIT_CONFIG_VALUE_3: 'false',
  });

  async function scannerVersion(home: string): Promise<string> {
    versionPromise ??= port.exec(options.gitleaksPath, ['version'], { env: baseEnv(home), timeoutMs: 15_000 }).then((result) => {
      const match = /\b(\d+\.\d+\.\d+)\b/.exec(result.stdout);
      if (!match) versionPromise = undefined; // 실패한 조회는 기억하지 않는다
      return match ? `gitleaks@${match[1]}` : 'gitleaks';
    });
    return versionPromise;
  }

  async function scan(scope: 'tree' | 'history', signal: AbortSignal): Promise<JsonValue> {
    const { root } = run.repo();
    const counted = scope === 'tree' ? await countFiles(root) : null;
    let commits = 0;
    if (scope === 'history') {
      // 이력 스캔은 이 저장소 자신의 `.git` 디렉터리와 완전한(얕지 않은) 이력이 있을 때만 한다: 아니면 완전하다고 말할 수 없다
      if (!(await hasOwnGitDir(root))) throw new RepoToolError('scan_failed', 'the repository has no .git directory of its own');
      const shallow = await git.tryRun(root, ['rev-parse', '--is-shallow-repository'], signal);
      if (!shallow.ok) throw new RepoToolError('scan_failed', 'the repository history cannot be read');
      if (shallow.stdout.trim() !== 'false') throw new RepoToolError('scan_failed', 'the repository is shallow: its history is incomplete');
      const commitCount = await git.tryRun(root, ['rev-list', '--all', '--count'], signal);
      if (!commitCount.ok) throw new RepoToolError('scan_failed', 'the repository history cannot be read');
      commits = Number(commitCount.stdout.trim()) || 0;
    }
    const dir = await mkdtemp(join(tmpdir(), 'aot-scan-'));
    try {
      const reportPath = join(dir, 'report.json');
      const common = [
        '--config', options.configPath, '--ignore-gitleaks-allow', '--redact', '--no-banner', '--log-level', 'warn', '--exit-code', '3', '--report-format', 'json', '--report-path', reportPath,
      ];
      const args = scope === 'tree'
        ? ['dir', ...common, root]
        : ['git', ...common, '--log-opts=--all --no-textconv --no-ext-diff', root];
      const result = await port.exec(options.gitleaksPath, args, { env: { ...baseEnv(dir), GIT_CEILING_DIRECTORIES: dirname(root) }, timeoutMs, signal });
      if (result.timedOut) throw new RepoToolError('scan_failed', signal.aborted ? 'the scan was cancelled' : 'the scanner timed out');
      if (result.spawnError !== undefined) throw new RepoToolError('scan_failed', `the scanner could not start (${result.spawnError})`);
      if (result.code !== 0 && result.code !== 3) throw new RepoToolError('scan_failed', `the scanner failed (exit ${String(result.code)})`);
      // 경고 수준 출력에 "건너뜀"이 있으면 일부를 못 본 것이다 (권한 없는 파일 등). 내용은 버리고 사실만 오류로 알린다
      for (const line of result.stderr.split('\n')) {
        if (/leaks? found/i.test(line)) continue;
        if (SKIPPED_WARNING.test(line)) throw new RepoToolError('scan_failed', 'the scanner skipped part of the target, so the scan is not complete');
      }
      let report: unknown = null;
      let text = '';
      try {
        if ((await stat(reportPath)).size > MAX_REPORT_BYTES) throw new RepoToolError('scan_failed', 'the scanner report is too large');
        text = await readFile(reportPath, 'utf8');
      } catch (error) {
        if (error instanceof RepoToolError) throw error;
        if (result.code === 3) throw new RepoToolError('scan_failed', 'the scanner reported findings but wrote no report');
      }
      if (text.trim() !== '') {
        try {
          report = JSON.parse(text);
        } catch {
          throw new RepoToolError('scan_failed', 'the scanner report is not valid JSON');
        }
      } else if (result.code === 3) {
        throw new RepoToolError('scan_failed', 'the scanner reported findings but wrote an empty report');
      }
      const findings = findingsFromReport(report, scope, root);
      if (result.code === 3 && findings.length === 0) throw new RepoToolError('scan_failed', 'the scanner reported findings that could not be read');
      // 루트의 .gitleaksignore 는 스캐너가 읽어 발견을 지운다(후보 저장소가 정한다): 막을 수 없으니 그 존재를 발견으로 보고한다
      const ignoreFile = await lstat(join(root, '.gitleaksignore')).then(() => true, () => false);
      if (ignoreFile) findings.push({ location: '.gitleaksignore', kind: 'scanner-suppression' });
      const summary: SecretScanSummary = {
        type: SECRET_SCAN_SUMMARY_TYPE,
        scope,
        complete: true,
        scanner: await scannerVersion(dir),
        ...(scope === 'tree' ? { files_scanned: counted!.files } : { commits_scanned: commits }),
        findings,
      };
      // 만든 요약이 평가기가 읽는 형식을 지키는지 저장 전에 확인한다 (형식 어긋남은 코드 오류다)
      const checked = parseSecretScanSummary(JSON.stringify(summary));
      if (!checked.ok) throw new RepoToolError('scan_failed', `internal: the scan summary does not match its format (${checked.reason})`);
      if (signal.aborted) throw new RepoToolError('scan_failed', 'the scan was cancelled before the result was stored');
      let captured;
      try {
        captured = await run.evidence.capture({ text: JSON.stringify(summary), trustOrigin: 'external_untrusted' });
      } catch (error) {
        throw new RepoToolError('capture_failed', error instanceof Error ? error.message : String(error));
      }
      const shown: JsonObject[] = findings.slice(0, SHOWN_FINDINGS).map((finding) => ({ location: finding.location, kind: finding.kind }));
      return {
        evidence_id: captured.evidenceId,
        scope,
        complete: true,
        scanner: summary.scanner,
        ...(scope === 'tree' ? { files_scanned: summary.files_scanned! } : { commits_scanned: summary.commits_scanned! }),
        findings_count: findings.length,
        findings: shown,
        findings_truncated: findings.length > SHOWN_FINDINGS,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return async function execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const extra = Object.keys(request.args);
    if (extra.length > 0) throw new RepoToolError('invalid_args', `secret_scan takes no arguments (got ${extra.join(', ')})`);
    switch (request.operation) {
      case 'scan_tree':
        return { result: await scan('tree', request.signal) };
      case 'scan_history':
        return { result: await scan('history', request.signal) };
      default:
        throw new RepoToolError('invalid_args', `unknown secret_scan operation '${request.operation.slice(0, 40)}'`);
    }
  };
}
