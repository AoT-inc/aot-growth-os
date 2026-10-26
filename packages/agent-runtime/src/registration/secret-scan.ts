// secret_scan 도구 실행기 (scan_tree · scan_history). 비밀값 스캐너(gitleaks 8.30.1, Q21)를 호스트에서 실행하고 결과를 `secret_scan_summary@1` 로만 돌려준다.
//   - 스캐너 설정은 *항상* 운영자가 정한 파일(`--config`)이다. 후보 저장소 안의 `.gitleaks.toml` 로 허용 목록을 심어 스캔을 피할 수 없다.
//   - `--redact`. 보고서 파일은 0700 임시 디렉터리에 쓰고 읽은 뒤 지운다. 스캐너의 stdout·stderr 는 버린다.
//   - 보고서에서 읽는 필드는 RuleID·File·Commit 뿐이다. 값·매치·줄 같은 나머지는 읽지도 저장하지도 돌려주지도 않는다(요약 형식의 허용 키 목록이 닫혀 있어 시험이 확인한다).
//   - 스캐너가 시간 초과·오류로 끝나면 부분 결과를 "완전함"으로 위장하지 않고 던진다(`scan_failed`) → 에이전트는 수집 불가로 보고하고 `scan_coverage_complete` 가 실패한다.
// 이력 스캔은 `git log` 를 쓰므로 repo 설정이 코드를 실행하지 못하게 git 환경을 굳히고(GIT_CONFIG_*), `--no-textconv --no-ext-diff` 를 준다.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_SCAN_FINDINGS, parseSecretScanSummary, SECRET_SCAN_SUMMARY_TYPE, type SecretScanFindingSummary, type SecretScanSummary } from '@aot/evaluation';

import type { JsonObject, JsonValue } from '../contract.ts';
import type { ProcessPort } from '../docker.ts';
import { nodeProcessPort } from '../docker.ts';
import type { ToolExecutionRequest, ToolExecutionResult } from '../gateway.ts';
import type { RegistrationToolRun } from './capture.ts';
import type { GitRunner } from './git.ts';
import { countFiles, RepoToolError } from './repo-files.ts';

export const SECRET_SCAN_TOOL = 'secret_scan';
export const SECRET_SCAN_OPERATIONS = ['scan_tree', 'scan_history'] as const;
export const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60_000;
const SHOWN_FINDINGS = 20;

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
    const kind = clip(entry['RuleID'], 100) || 'unknown-rule';
    const location = scope === 'history' ? `${clip(entry['Commit'], 12)}:${file}` : file;
    findings.push({ location: location === '' || location === ':' ? '(unknown)' : location.slice(0, 500), kind });
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
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    GIT_CONFIG_KEY_2: 'log.showSignature', GIT_CONFIG_VALUE_2: 'false',
  });

  async function scannerVersion(home: string): Promise<string> {
    versionPromise ??= port.exec(options.gitleaksPath, ['version'], { env: baseEnv(home), timeoutMs: 15_000 }).then((result) => {
      const match = /\b(\d+\.\d+\.\d+)\b/.exec(result.stdout);
      return match ? `gitleaks@${match[1]}` : 'gitleaks';
    });
    return versionPromise;
  }

  async function scan(scope: 'tree' | 'history'): Promise<JsonValue> {
    const { root } = run.repo();
    const counted = scope === 'tree' ? await countFiles(root) : null;
    const commitsText = scope === 'history' ? await git.tryRun(root, ['rev-list', '--all', '--count']) : null;
    if (commitsText !== null && !commitsText.ok) throw new RepoToolError('scan_failed', 'the repository history cannot be read');
    const dir = await mkdtemp(join(tmpdir(), 'aot-scan-'));
    try {
      const reportPath = join(dir, 'report.json');
      const common = ['--config', options.configPath, '--redact', '--no-banner', '--log-level', 'error', '--exit-code', '3', '--report-format', 'json', '--report-path', reportPath];
      const args = scope === 'tree'
        ? ['dir', ...common, root]
        : ['git', ...common, '--log-opts=--all --no-textconv --no-ext-diff', root];
      const result = await port.exec(options.gitleaksPath, args, { env: baseEnv(dir), timeoutMs });
      if (result.timedOut) throw new RepoToolError('scan_failed', 'the scanner timed out');
      if (result.spawnError !== undefined) throw new RepoToolError('scan_failed', `the scanner could not start (${result.spawnError})`);
      if (result.code !== 0 && result.code !== 3) throw new RepoToolError('scan_failed', `the scanner failed (exit ${String(result.code)})`);
      let report: unknown = null;
      let text = '';
      try {
        text = await readFile(reportPath, 'utf8');
      } catch {
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
      const summary: SecretScanSummary = {
        type: SECRET_SCAN_SUMMARY_TYPE,
        scope,
        complete: true,
        scanner: await scannerVersion(dir),
        ...(scope === 'tree' ? { files_scanned: counted!.files } : { commits_scanned: Number((commitsText as { stdout: string }).stdout.trim()) || 0 }),
        findings,
      };
      // 만든 요약이 평가기가 읽는 형식을 지키는지 저장 전에 확인한다 (형식 어긋남은 코드 오류다)
      const checked = parseSecretScanSummary(JSON.stringify(summary));
      if (!checked.ok) throw new RepoToolError('scan_failed', `internal: the scan summary does not match its format (${checked.reason})`);
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
        return { result: await scan('tree') };
      case 'scan_history':
        return { result: await scan('history') };
      default:
        throw new RepoToolError('invalid_args', `unknown secret_scan operation '${request.operation.slice(0, 40)}'`);
    }
  };
}
