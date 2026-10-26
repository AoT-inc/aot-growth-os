// 상품 등록 검증 업무의 도구 3개(repo_read · secret_scan · license_check)를 조립한다 (workflows/product-registration.md, docs/plans/registration-dogfood.md).
// 모두 *호스트* 게이트웨이 실행기다: 에이전트(컨테이너·CLI)는 네트워크·마운트가 없고 저장소를 읽는 유일한 길이 이 도구들이다.
// 도구 선언은 정적이고(읽기·internal·부작용 없음, 결과는 외부 입력), 실행기는 run 마다 만든다(그 run 의 저장소·근거 저장 포트에 묶인다).
import type { Clock } from '@aot/domain';

import type { ProcessPort } from '../docker.ts';
import type { GatewayToolSpec, ToolExecutor } from '../gateway.ts';
import type { RegistrationToolRun } from './capture.ts';
import { createGitRunner } from './git.ts';
import { createLicenseCheckExecutor, LICENSE_CHECK_OPERATIONS, LICENSE_CHECK_TOOL } from './license-check.ts';
import { RepoToolError } from './repo-files.ts';
import { createRepoReadExecutor, REPO_READ_OPERATIONS, REPO_READ_TOOL } from './repo-read.ts';
import { createSecretScanExecutor, DEFAULT_SCAN_TIMEOUT_MS, SECRET_SCAN_OPERATIONS, SECRET_SCAN_TOOL } from './secret-scan.ts';

/** 에이전트가 보는 도구 설명 (이름 → 설명). 인자와 결과의 `evidence_id` 인용 방법을 알려 준다 */
export const REGISTRATION_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  repo_read_list_tree: 'List files and directories of the repository under verification (read-only). Arguments: {"path"?: relative directory, "depth"?: 1-4, "max_entries"?: number}. The result has "entries" and an "evidence_id" you cite in your report.',
  repo_read_read_file: 'Read one text file of the repository (read-only; secret-looking values are masked; secret files, binaries and paths outside the repository are "unavailable"). Arguments: {"path": relative file path, "max_bytes"?: number}. The result has "text" and an "evidence_id".',
  repo_read_read_metadata: 'Read repository facts (read-only): default branch, remote kinds (never addresses), manifests, file counts per extension. No arguments. The result has an "evidence_id".',
  repo_read_read_history: 'Read history facts (read-only): commit counts, first and last commit times, contributor count (no names or emails). No arguments. The result has an "evidence_id".',
  secret_scan_scan_tree: 'Scan the working tree for secrets with the operator-configured scanner. No arguments. The result lists finding locations and rule kinds only (never values) and an "evidence_id". An error means the scan could not be completed.',
  secret_scan_scan_history: 'Scan the whole commit history for secrets with the operator-configured scanner. No arguments. The result lists finding locations and rule kinds only (never values) and an "evidence_id". An error means the scan could not be completed.',
  license_check_identify: 'Report license facts (read-only): license files with hashes and recognised phrases, and license fields of manifests. It does not judge the license. No arguments. The result has an "evidence_id".',
};

export interface RegistrationToolsOptions {
  clock: Clock;
  /** `git` 실행 파일의 절대 경로 */
  gitPath: string;
  /** gitleaks 실행 파일의 절대 경로 */
  gitleaksPath: string;
  /** gitleaks 설정 파일의 절대 경로(후보 저장소의 설정을 쓰지 않는다) */
  gitleaksConfigPath: string;
  scanTimeoutMs?: number;
  /** run 별 호출·저장 상한. 기본 `DEFAULT_REGISTRATION_QUOTA` */
  quota?: Partial<RegistrationQuota>;
  /** 시험이 프로세스 포트를 가짜로 바꾼다 */
  process?: ProcessPort;
}

/** run 하나가 쓸 수 있는 양. 프롬프트 주입된 에이전트가 읽기·스캔을 무한히 반복해 호스트를 붙잡지 못하게 한다 */
export interface RegistrationQuota {
  /** 도구 호출 총수 */
  maxCalls: number;
  /** 그중 secret_scan 호출 수 */
  maxScans: number;
  /** 저장하는 근거 본문의 총 바이트 */
  maxEvidenceBytes: number;
}

export const DEFAULT_REGISTRATION_QUOTA: RegistrationQuota = { maxCalls: 300, maxScans: 6, maxEvidenceBytes: 64 * 1024 * 1024 };

export interface RegistrationTools {
  specs: readonly GatewayToolSpec[];
  /** run 마다 실행기를 만든다. 키는 도구 이름 */
  executorsFor(run: RegistrationToolRun): Map<string, ToolExecutor>;
}

/** 에이전트가 부르는 이름: `<tool>_<operation>` (예: `repo_read_read_file`). 정책의 행위는 `<tool>.<operation>` 그대로다 */
export const registrationToolName = (tool: string, operation: string): string => `${tool}_${operation}`;

const spec = (tool: string, operation: string, timeoutMs?: number): GatewayToolSpec => ({
  tool, name: registrationToolName(tool, operation), operation, scope: 'internal', impact: 'read', sideEffect: false, resultOrigin: 'external_untrusted', ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

export function registrationToolSpecs(scanTimeoutMs: number = DEFAULT_SCAN_TIMEOUT_MS): GatewayToolSpec[] {
  return [
    ...REPO_READ_OPERATIONS.map((operation) => spec(REPO_READ_TOOL, operation)),
    // 스캔은 오래 걸릴 수 있다: 도구 타임아웃을 스캐너 제한 시간보다 조금 길게 둔다
    ...SECRET_SCAN_OPERATIONS.map((operation) => spec(SECRET_SCAN_TOOL, operation, scanTimeoutMs + 30_000)),
    ...LICENSE_CHECK_OPERATIONS.map((operation) => spec(LICENSE_CHECK_TOOL, operation)),
  ];
}

export function createRegistrationTools(options: RegistrationToolsOptions): RegistrationTools {
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  return {
    specs: registrationToolSpecs(scanTimeoutMs),
    executorsFor(run) {
      const quota = { ...DEFAULT_REGISTRATION_QUOTA, ...options.quota };
      let calls = 0;
      let scans = 0;
      let evidenceBytes = 0;
      let queue: Promise<unknown> = Promise.resolve();
      // 저장하는 본문의 총량을 센다
      const limited: RegistrationToolRun = {
        repo: run.repo,
        evidence: {
          capture: (input) => {
            evidenceBytes += Buffer.byteLength(input.text, 'utf8');
            if (evidenceBytes > quota.maxEvidenceBytes) return Promise.reject(new RepoToolError('quota_exceeded', 'the evidence storage quota of this run is used up'));
            return run.evidence.capture(input);
          },
        },
      };
      // 호출 수를 세고 run 안에서는 한 번에 하나씩만 실행한다(병렬 호출로 호스트 자원을 몰아 쓰지 못하게)
      const guard = (tool: string, executor: ToolExecutor): ToolExecutor => (request) => {
        calls += 1;
        if (calls > quota.maxCalls) return Promise.reject(new RepoToolError('quota_exceeded', `more than ${quota.maxCalls} registration tool calls in one run`));
        if (tool === SECRET_SCAN_TOOL) {
          scans += 1;
          if (scans > quota.maxScans) return Promise.reject(new RepoToolError('quota_exceeded', `more than ${quota.maxScans} secret scans in one run`));
        }
        const result = queue.then(() => executor(request), () => executor(request));
        queue = result.catch(() => undefined);
        return result;
      };
      const git = createGitRunner({ gitPath: options.gitPath, ...(options.process === undefined ? {} : { process: options.process }) });
      return new Map<string, ToolExecutor>([
        [REPO_READ_TOOL, guard(REPO_READ_TOOL, createRepoReadExecutor({ run: limited, git, clock: options.clock }))],
        [SECRET_SCAN_TOOL, guard(SECRET_SCAN_TOOL, createSecretScanExecutor({
          run: limited, git, options: { gitleaksPath: options.gitleaksPath, configPath: options.gitleaksConfigPath, timeoutMs: scanTimeoutMs, ...(options.process === undefined ? {} : { process: options.process }) },
        }))],
        [LICENSE_CHECK_TOOL, guard(LICENSE_CHECK_TOOL, createLicenseCheckExecutor({ run: limited }))],
      ]);
    },
  };
}

export type { CapturedEvidence, EvidenceCapture, RegistrationToolRun, RepoBinding } from './capture.ts';
export { createGitRunner, type GitRunner } from './git.ts';
export { manifestLicense } from './license-check.ts';
export { remoteKind } from './repo-read.ts';
export { findingsFromReport } from './secret-scan.ts';
export { countFiles, hasOwnGitDir, isDeniedPath, listTree, maskRepoText, normalizeRelativePath, readTextFile, RepoToolError, safeText, type RepoToolErrorCode } from './repo-files.ts';
export { LICENSE_CHECK_TOOL, REPO_READ_TOOL, SECRET_SCAN_TOOL };
