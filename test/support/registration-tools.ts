// 상품 등록 도구(repo_read · secret_scan · license_check) 시험 공용: 임시 git 저장소, 메모리 근거 저장, 가짜 gitleaks 실행 파일, 도구 호출 요청.
// 모두 가상의 example-product 다. 실제 저장소·스캐너 결과는 쓰지 않는다 (가짜 gitleaks 가 시나리오대로 보고서를 쓴다).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

import type { EvidenceCapture, JsonObject, RegistrationToolRun, ToolExecutionRequest } from '@aot/agent-runtime';

import { makeTempDir } from './temp.ts';

const GIT_ENV = {
  PATH: '/usr/bin:/bin:/usr/local/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Example Author', GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_COMMITTER_NAME: 'Example Author', GIT_COMMITTER_EMAIL: 'author@example.invalid',
};

export const GIT = '/usr/bin/git';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, ['-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...GIT_ENV, HOME: cwd }, encoding: 'utf8' });
}

export interface RepoFiles { [path: string]: string | Buffer }

/** 파일을 쓰고 커밋 한 번 한 임시 저장소. 루트의 절대 경로를 돌려준다 */
export function makeRepo(t: TestContext, files: RepoFiles, options: { commit?: boolean } = {}): string {
  const root = join(makeTempDir(t, 'aot-repo-'), 'example-product');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (options.commit !== false) {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial commit');
  }
  return root;
}

/** 메모리 근거 저장: 저장한 본문과 신뢰 출처를 모은다. id 는 ev-1, ev-2 … */
export class MemoryCapture implements EvidenceCapture {
  readonly saved: { evidenceId: string; text: string; trustOrigin: string }[] = [];
  failWith: Error | null = null;

  capture(input: { text: string; trustOrigin: 'internal' | 'external_untrusted' }) {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    const evidenceId = `ev-${this.saved.length + 1}`;
    this.saved.push({ evidenceId, text: input.text, trustOrigin: input.trustOrigin });
    return Promise.resolve({ evidenceId, sha256: 'unused-in-these-tests' });
  }

  last(): { evidenceId: string; text: string; trustOrigin: string } {
    const saved = this.saved[this.saved.length - 1];
    if (saved === undefined) throw new Error('nothing was captured');
    return saved;
  }
}

export function toolRun(root: string, evidence: EvidenceCapture): RegistrationToolRun {
  return { repo: () => ({ slug: 'example-product', root }), evidence };
}

export const request = (tool: string, operation: string, args: JsonObject = {}): ToolExecutionRequest => ({
  runId: 'run-1', tool, operation, args, signal: new AbortController().signal, constraints: { max_usd: 1 },
});

export type StubScanScenario =
  | { kind: 'clean' }
  /** 보고서에 항목을 쓰고 exit 3. 스캐너가 실제로 쓰는 값 필드(Secret·Match·Line)를 일부러 넣어, 도구가 읽지 않고 버리는지 본다 */
  | { kind: 'findings'; items: { RuleID: string; File: string; Commit?: string }[] }
  | { kind: 'findings_without_report' }
  | { kind: 'error'; code: number }
  | { kind: 'hang' }
  | { kind: 'bad_report' };

export interface StubScanner {
  path: string;
  /** 스캔 호출마다 덮어쓰는 기록 파일 (인자·환경) */
  recordPath: string;
}

export const STUB_SECRET_VALUE = ['STUBSECRETVALUE', '0123456789'].join(''); // 도구가 어디에도 내보내면 안 되는 값

const STUB = String.raw`
'use strict';
const fs = require('fs');
const scenario = SCENARIO_JSON;
const args = process.argv.slice(2);
if (args[0] === 'version') { process.stdout.write('8.30.1\n'); process.exit(0); }
fs.writeFileSync(scenario.recordPath, JSON.stringify({ args, env: process.env }));
const reportPath = args[args.indexOf('--report-path') + 1];
const root = args[args.length - 1];
const k = scenario.kind;
if (k === 'hang') { setInterval(() => {}, 1000); }
else if (k === 'error') { process.exit(scenario.code); }
else if (k === 'clean') { fs.writeFileSync(reportPath, '[]'); process.exit(0); }
else if (k === 'bad_report') { fs.writeFileSync(reportPath, '{not json'); process.exit(3); }
else if (k === 'findings_without_report') { process.exit(3); }
else {
  const items = scenario.items.map((item) => ({
    ...item, File: item.File.startsWith('ABS:') ? root + '/' + item.File.slice(4) : item.File,
    Description: 'rule description', StartLine: 3, EndLine: 3, Match: 'REDACTED', Secret: '${STUB_SECRET_VALUE}', Fingerprint: 'fp', Entropy: 4.2, Tags: [], Author: 'Example Author', Email: 'author@example.invalid',
  }));
  fs.writeFileSync(reportPath, JSON.stringify(items));
  process.exit(3);
}
`;

export function writeStubGitleaks(dir: string, scenario: StubScanScenario): StubScanner {
  const recordPath = join(dir, 'stub-gitleaks-record.json');
  const path = join(dir, 'gitleaks');
  writeFileSync(path, `#!${process.execPath}\n${STUB.replace('SCENARIO_JSON', JSON.stringify({ ...scenario, recordPath }))}`);
  chmodSync(path, 0o755);
  return { path, recordPath };
}
