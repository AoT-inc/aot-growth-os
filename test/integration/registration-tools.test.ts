// 상품 등록 검증 도구 3개(repo_read · secret_scan · license_check)의 실행기. 실제 git 으로 만든 임시 저장소를 읽고, 스캐너는 가짜 gitleaks 실행 파일이다
// (실제 gitleaks 와의 연결은 registration-real-gitleaks 시험). 외부 접근은 없다.
// 확인하는 것: 읽기 전용, 결과가 호스트 근거로 저장되고 id 가 돌아온다, 비밀값·이메일·원격 주소가 어디에도 나가지 않는다, 스캐너를 저장소 설정으로 피할 수 없다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { createRegistrationTools, LICENSE_CHECK_TOOL, REPO_READ_TOOL, SECRET_SCAN_TOOL, type JsonObject } from '@aot/agent-runtime';
import { parseSecretScanSummary } from '@aot/evaluation';
import { FakeClock } from '@aot/domain';

import { git, GIT, makeRepo, MemoryCapture, request, STUB_SECRET_VALUE, toolRun, writeStubGitleaks, type RepoFiles, type StubScanScenario } from '../support/registration-tools.ts';
import { makeTempDir } from '../support/temp.ts';

const clock = new FakeClock('2026-10-26T00:00:00.000Z');
const CONFIG = '/srv/example/gitleaks-registration.toml';

function rig(t: TestContext, files: RepoFiles, scenario: StubScanScenario = { kind: 'clean' }, options: { scanTimeoutMs?: number; prepare?: (root: string) => void; clock?: FakeClock } = {}) {
  const root = makeRepo(t, files);
  options.prepare?.(root);
  const dir = makeTempDir(t, 'aot-stub-');
  const scanner = writeStubGitleaks(dir, scenario);
  const capture = new MemoryCapture();
  const tools = createRegistrationTools({
    clock: options.clock ?? clock, gitPath: GIT, gitleaksPath: scanner.path, gitleaksConfigPath: CONFIG, ...(options.scanTimeoutMs === undefined ? {} : { scanTimeoutMs: options.scanTimeoutMs }),
  });
  const executors = tools.executorsFor(toolRun(root, capture));
  const call = async (tool: string, operation: string, args: JsonObject = {}) => (await executors.get(tool)!(request(tool, operation, args))).result as JsonObject;
  return { root, capture, scanner, tools, call };
}

const FILES: RepoFiles = {
  'README.md': '# example-product\nA small command line tool.\n',
  'package.json': JSON.stringify({ name: 'example-product', license: 'MIT' }),
  'src/index.ts': 'export const x = 1;\n',
  '.env': 'DATABASE_PASSWORD=do-not-read-me\n',
  'LICENSE': 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n',
};

describe('tool declarations', () => {
  it('every operation is a read-only, internal, no-side-effect tool whose results are external input', (t) => {
    const { tools } = rig(t, FILES);
    assert.deepEqual(tools.specs.map((spec) => `${spec.tool}.${spec.operation}`), [
      'repo_read.list_tree', 'repo_read.read_file', 'repo_read.read_metadata', 'repo_read.read_history', 'secret_scan.scan_tree', 'secret_scan.scan_history', 'license_check.identify',
    ]);
    for (const spec of tools.specs) {
      assert.equal(spec.impact, 'read');
      assert.equal(spec.scope, 'internal');
      assert.equal(spec.sideEffect, false);
      assert.equal(spec.resultOrigin, 'external_untrusted');
    }
    assert.ok((tools.specs.find((spec) => spec.tool === 'secret_scan')?.timeoutMs ?? 0) > 600_000, 'the scan tool timeout outlasts the scanner limit');
    assert.deepEqual([...tools.executorsFor(toolRun('/tmp', new MemoryCapture())).keys()].sort(), ['license_check', 'repo_read', 'secret_scan']);
  });
});

describe('repo_read', () => {
  it('read_file stores what the agent saw as evidence and returns its id; secret names and escapes are unavailable, nothing is stored for them', async (t) => {
    const { call, capture, root } = rig(t, FILES);
    const outside = makeTempDir(t, 'aot-outside-');
    writeFileSync(join(outside, 'o.txt'), 'outside');
    symlinkSync(join(outside, 'o.txt'), join(root, 'escape.txt'));
    const file = await call(REPO_READ_TOOL, 'read_file', { path: 'README.md' });
    assert.equal(file['evidence_id'], 'ev-1');
    assert.equal(file['text'], FILES['README.md']);
    assert.deepEqual(JSON.parse(capture.last().text), { type: 'repo_file@1', path: 'README.md', bytes: Buffer.byteLength(FILES['README.md'] as string), truncated: false, text: FILES['README.md'] });
    assert.equal(capture.last().trustOrigin, 'external_untrusted');
    for (const [path, reason] of [['.env', 'path_denied'], ['escape.txt', 'path_outside_repo'], ['nope.md', 'not_found'], ['../x', 'invalid_path'], ['/etc/passwd', 'invalid_path'], ['', 'invalid_path']] as const) {
      assert.deepEqual(await call(REPO_READ_TOOL, 'read_file', { path }), { status: 'unavailable', reason }, path);
    }
    assert.equal(capture.saved.length, 1, 'only the successful read was stored');
    assert.ok(!capture.saved.some((saved) => saved.text.includes('do-not-read-me')));
  });

  it('list_tree returns entries (no .git contents) with an evidence id', async (t) => {
    const { call, capture } = rig(t, FILES);
    const tree = await call(REPO_READ_TOOL, 'list_tree', { depth: 2 });
    const paths = (tree['entries'] as { path: string }[]).map((entry) => entry.path);
    assert.ok(paths.includes('src/index.ts') && paths.includes('README.md') && paths.includes('.git'));
    assert.ok(!paths.some((path) => path.startsWith('.git/')));
    assert.equal(tree['evidence_id'], 'ev-1');
    assert.equal(JSON.parse(capture.last().text)['type'], 'repo_tree@1');
  });

  it('read_metadata reports branch, manifests, language counts and remote KINDS; the remote address never appears', async (t) => {
    const { call, capture } = rig(t, FILES, { kind: 'clean' }, {
      prepare: (root) => {
        git(root, 'remote', 'add', 'origin', ['https:', '//deploy:hunter2example@git.example.invalid/internal/example-product.git'].join('')); // 소스에 URL 비밀번호 모양을 그대로 두지 않는다
        git(root, 'remote', 'add', 'mirror', 'git@github.com:example/example-product.git');
      },
    });
    const meta = await call(REPO_READ_TOOL, 'read_metadata');
    assert.equal(meta['is_git'], true);
    assert.equal(meta['default_branch'], 'main');
    assert.deepEqual(meta['manifests'], ['package.json']);
    assert.deepEqual(meta['remotes'], [{ kind: 'github', credentials_in_url: false }, { kind: 'other', credentials_in_url: true }]); // `git remote` lists names sorted: mirror, origin
    const everything = JSON.stringify(meta) + capture.saved.map((saved) => saved.text).join('');
    for (const leaked of ['git.example.invalid', 'hunter2example', 'internal/example-product', 'github.com:example']) assert.ok(!everything.includes(leaked), leaked);
  });

  it('read_metadata on a directory that is not a git repository is still useful (is_git=false)', async (t) => {
    const { call } = rig(t, FILES);
    const plain = makeTempDir(t, 'aot-plain-');
    writeFileSync(join(plain, 'a.txt'), 'a');
    const tools = createRegistrationTools({ clock, gitPath: GIT, gitleaksPath: '/nonexistent', gitleaksConfigPath: CONFIG });
    const executors = tools.executorsFor(toolRun(plain, new MemoryCapture()));
    const meta = (await executors.get('repo_read')!(request('repo_read', 'read_metadata'))).result as JsonObject;
    assert.equal(meta['is_git'], false);
    assert.equal(meta['file_count'], 1);
    assert.equal('remotes' in meta, false);
    void call;
  });

  it('read_history gives counts and dates only — no author names or emails anywhere', async (t) => {
    const { call, capture } = rig(t, FILES, { kind: 'clean' }, {
      clock: new FakeClock('2035-01-01T00:00:00.000Z'), // 90 일 창은 주입한 시계로 센다: 실제 커밋 날짜(지금)보다 한참 뒤
      prepare: (root) => {
        writeFileSync(join(root, 'second.txt'), '2');
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'second');
      },
    });
    const history = await call(REPO_READ_TOOL, 'read_history');
    assert.equal(history['commit_count'], 2);
    assert.equal(history['contributors'], 1);
    assert.equal(history['commits_last_90d'], 0, 'the window comes from the injected clock (2035), far after the real commit dates');
    assert.match(String(history['first_commit_at']), /^\d{4}-\d\d-\d\dT/);
    const everything = JSON.stringify(history) + capture.saved.map((saved) => saved.text).join('');
    assert.ok(!everything.includes('author@example.invalid') && !everything.includes('Example Author'));
  });

  it('read_history counts the commits inside the 90-day window of the injected clock', async (t) => {
    const { call } = rig(t, FILES, { kind: 'clean' }, { clock: new FakeClock(new Date().toISOString()) });
    assert.equal((await call(REPO_READ_TOOL, 'read_history'))['commits_last_90d'], 1);
  });

  it('read_history of a repository with no commit is an empty history, not an error', async (t) => {
    const root = makeRepo(t, {}, { commit: false });
    const tools = createRegistrationTools({ clock, gitPath: GIT, gitleaksPath: '/nonexistent', gitleaksConfigPath: CONFIG });
    const executors = tools.executorsFor(toolRun(root, new MemoryCapture()));
    const history = (await executors.get('repo_read')!(request('repo_read', 'read_history'))).result as JsonObject;
    assert.equal(history['commit_count'], 0);
  });

  it('rejects unknown arguments and operations; a failing evidence store surfaces as capture_failed', async (t) => {
    const { call, capture } = rig(t, FILES);
    await assert.rejects(call(REPO_READ_TOOL, 'read_file', { path: 'README.md', root: '/etc' }), /invalid_args: unknown argument\(s\): root/);
    await assert.rejects(call(REPO_READ_TOOL, 'read_file', { path: 'README.md', max_bytes: 0 }), /invalid_args: max_bytes/);
    await assert.rejects(call(REPO_READ_TOOL, 'delete_file', { path: 'README.md' }), /invalid_args: unknown repo_read operation/);
    await assert.rejects(call(REPO_READ_TOOL, 'read_metadata', { x: 1 }), /invalid_args/);
    capture.failWith = new Error('disk full');
    await assert.rejects(call(REPO_READ_TOOL, 'read_file', { path: 'README.md' }), /capture_failed: disk full/);
  });

  it('never writes: the repository is byte-for-byte the same after every operation', async (t) => {
    const { call, root } = rig(t, FILES, { kind: 'clean' });
    const before = git(root, 'status', '--porcelain=v1', '--ignored') + readFileSync(join(root, '.git', 'HEAD'), 'utf8');
    for (const [operation, args] of [['list_tree', {}], ['read_file', { path: 'README.md' }], ['read_metadata', {}], ['read_history', {}]] as const) await call(REPO_READ_TOOL, operation, args);
    await call(SECRET_SCAN_TOOL, 'scan_tree');
    await call(LICENSE_CHECK_TOOL, 'identify');
    assert.equal(git(root, 'status', '--porcelain=v1', '--ignored') + readFileSync(join(root, '.git', 'HEAD'), 'utf8'), before);
    assert.ok(!existsSync(join(root, 'report.json')));
  });
});

describe('secret_scan', () => {
  it('scan_tree: the scanner runs with the OPERATOR config and redaction, the summary matches the evaluator format, and no value leaves', async (t) => {
    const { call, capture, scanner } = rig(t, FILES, { kind: 'findings', items: [{ RuleID: 'aws-access-token', File: 'ABS:src/index.ts' }, { RuleID: 'generic-api-key', File: '.env' }] });
    const result = await call(SECRET_SCAN_TOOL, 'scan_tree');
    assert.equal(result['scope'], 'tree');
    assert.equal(result['complete'], true);
    assert.equal(result['findings_count'], 2);
    assert.deepEqual(result['findings'], [{ location: 'src/index.ts', kind: 'aws-access-token' }, { location: '.env', kind: 'generic-api-key' }]);
    assert.equal(result['scanner'], 'gitleaks@8.30.1');
    assert.equal(result['files_scanned'], 5);
    // 저장된 요약: 평가기 형식 그대로, 값 필드 없음
    const stored = parseSecretScanSummary(capture.last().text);
    assert.ok(stored.ok, stored.ok ? '' : stored.reason);
    assert.equal(stored.summary.findings.length, 2);
    for (const text of [capture.last().text, JSON.stringify(result)]) {
      for (const leaked of [STUB_SECRET_VALUE, 'author@example.invalid', 'Example Author', 'rule description', 'REDACTED']) assert.ok(!text.includes(leaked), leaked);
    }
    // 호출 모양: 하위 명령, 운영자 설정, --redact, 루트는 마지막 인자, 후보 저장소의 설정은 쓰지 않는다
    const recorded = JSON.parse(readFileSync(scanner.recordPath, 'utf8')) as { args: string[]; env: Record<string, string> };
    assert.equal(recorded.args[0], 'dir');
    assert.equal(recorded.args[recorded.args.indexOf('--config') + 1], CONFIG);
    assert.ok(recorded.args.includes('--redact'));
    assert.equal(recorded.args[recorded.args.length - 1], await import('node:fs').then((fs) => fs.realpathSync(rootOf(recorded.args))));
    assert.ok(!recorded.args.some((arg) => arg.endsWith('.gitleaks.toml')));
    assert.equal(recorded.env['GIT_CONFIG_GLOBAL'], '/dev/null');
    assert.equal(recorded.env['GIT_CONFIG_KEY_0'], 'core.fsmonitor');
    assert.equal(Object.keys(recorded.env).includes('AOT_ENV_SECRET'), false);
  });

  it('scan_tree on a clean tree: zero findings', async (t) => {
    const { call, capture } = rig(t, FILES, { kind: 'clean' });
    const result = await call(SECRET_SCAN_TOOL, 'scan_tree');
    assert.equal(result['findings_count'], 0);
    assert.equal(JSON.parse(capture.last().text)['complete'], true);
  });

  it('scan_history: scans every ref without text conversion or external diff, counts the commits, locations carry the short commit', async (t) => {
    const { call, capture, scanner } = rig(t, FILES, { kind: 'findings', items: [{ RuleID: 'github-pat', File: 'old/config.txt', Commit: 'abcdef0123456789abcdef' }] });
    const result = await call(SECRET_SCAN_TOOL, 'scan_history');
    assert.equal(result['scope'], 'history');
    assert.equal(result['commits_scanned'], 1);
    assert.deepEqual(result['findings'], [{ location: 'abcdef012345:old/config.txt', kind: 'github-pat' }]);
    const stored = parseSecretScanSummary(capture.last().text);
    assert.ok(stored.ok && stored.summary.scope === 'history');
    const recorded = JSON.parse(readFileSync(scanner.recordPath, 'utf8')) as { args: string[] };
    assert.equal(recorded.args[0], 'git');
    assert.ok(recorded.args.includes('--log-opts=--all --no-textconv --no-ext-diff'));
  });

  it('a scanner that fails, times out, or reports unreadable findings is an error, never a partial result presented as complete', async (t) => {
    for (const scenario of [{ kind: 'error', code: 2 }, { kind: 'findings_without_report' }, { kind: 'bad_report' }] as StubScanScenario[]) {
      const { call, capture } = rig(t, FILES, scenario);
      await assert.rejects(call(SECRET_SCAN_TOOL, 'scan_tree'), /scan_failed/, scenario.kind);
      assert.equal(capture.saved.length, 0, 'nothing is stored for a failed scan');
    }
    const slow = rig(t, FILES, { kind: 'hang' }, { scanTimeoutMs: 150 });
    await assert.rejects(slow.call(SECRET_SCAN_TOOL, 'scan_tree'), /scan_failed: the scanner timed out/);
    const missing = createRegistrationTools({ clock, gitPath: GIT, gitleaksPath: '/nonexistent/gitleaks', gitleaksConfigPath: CONFIG }).executorsFor(toolRun(makeRepo(t, FILES), new MemoryCapture()));
    await assert.rejects(missing.get('secret_scan')!(request('secret_scan', 'scan_tree')), /scan_failed: the scanner could not start/);
  });

  it('takes no arguments', async (t) => {
    const { call } = rig(t, FILES);
    await assert.rejects(call(SECRET_SCAN_TOOL, 'scan_tree', { path: '/etc' }), /invalid_args: secret_scan takes no arguments/);
    await assert.rejects(call(SECRET_SCAN_TOOL, 'scan_everything'), /invalid_args: unknown secret_scan operation/);
  });
});

function rootOf(args: string[]): string {
  return args[args.length - 1]!;
}

describe('license_check', () => {
  it('reports facts: license files with hash and recognized phrases, and the manifest license field; dependency licenses are not collected', async (t) => {
    const { call, capture } = rig(t, FILES);
    const result = await call(LICENSE_CHECK_TOOL, 'identify');
    const files = result['license_files'] as { path: string; phrases: string[]; sha256: string }[];
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, 'LICENSE');
    assert.deepEqual(files[0]?.phrases, ['MIT']);
    assert.match(files[0]!.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(result['manifest_fields'], [{ file: 'package.json', license: 'MIT' }]);
    assert.equal(result['dependency_licenses'], 'not_collected');
    assert.equal(result['evidence_id'], 'ev-1');
    assert.equal(JSON.parse(capture.last().text)['type'], 'license_facts@1');
  });

  it('a repository with no license file reports none (a fact, not a verdict)', async (t) => {
    const { call } = rig(t, { 'a.txt': 'a' });
    const result = await call(LICENSE_CHECK_TOOL, 'identify');
    assert.deepEqual(result['license_files'], []);
    assert.deepEqual(result['manifest_fields'], []);
  });
});

describe('review findings: confinement of git and the scanner to the approved directory', () => {
  const callOn = (root: string, scenario: StubScanScenario = { kind: 'clean' }, t?: TestContext) => {
    const dir = makeTempDir(t as TestContext, 'aot-stub-');
    const scanner = writeStubGitleaks(dir, scenario);
    const capture = new MemoryCapture();
    const tools = createRegistrationTools({ clock, gitPath: GIT, gitleaksPath: scanner.path, gitleaksConfigPath: CONFIG });
    const executors = tools.executorsFor(toolRun(root, capture));
    return { scanner, capture, call: async (tool: string, operation: string, args: JsonObject = {}) => (await executors.get(tool)!(request(tool, operation, args))).result as JsonObject, executors };
  };

  it('a .git FILE pointing at another repository is not followed: no metadata, no history, no history scan from the other repository', async (t) => {
    const other = makeRepo(t, { 'prod-credentials-notes.txt': 'x' });
    git(other, 'remote', 'add', 'origin', 'git@github.com:acme/private.git');
    const candidate = makeRepo(t, { 'README.md': '# candidate\n' }, { commit: false });
    rmSync(join(candidate, '.git'), { recursive: true });
    writeFileSync(join(candidate, '.git'), `gitdir: ${join(other, '.git')}\n`);
    const { call } = callOn(candidate, { kind: 'clean' }, t);
    const meta = await call(REPO_READ_TOOL, 'read_metadata');
    assert.equal(meta['is_git'], false);
    assert.equal('remotes' in meta, false, 'the other repository\'s remote is not reported');
    assert.deepEqual(await call(REPO_READ_TOOL, 'read_history'), { status: 'unavailable', reason: 'not_found' });
    await assert.rejects(call(SECRET_SCAN_TOOL, 'scan_history'), /scan_failed: the repository has no \.git directory of its own/);
  });

  it('a directory inside another git repository (no .git of its own) does not report the parent\'s history', async (t) => {
    const parent = makeRepo(t, { 'sub/a.txt': 'a', 'top.txt': 't' });
    const { call } = callOn(join(parent, 'sub'), { kind: 'clean' }, t);
    assert.equal((await call(REPO_READ_TOOL, 'read_metadata'))['is_git'], false);
    assert.deepEqual(await call(REPO_READ_TOOL, 'read_history'), { status: 'unavailable', reason: 'not_found' });
  });

  it('read_history works when a work-tree file is named HEAD (the revision is separated from paths)', async (t) => {
    const root = makeRepo(t, { HEAD: 'a file called HEAD', 'a.txt': 'a' });
    const { call } = callOn(root, { kind: 'clean' }, t);
    assert.equal((await call(REPO_READ_TOOL, 'read_history'))['commit_count'], 1);
  });

  it('the scanner is run so that the candidate cannot hide findings: gitleaks:allow ignored, replace refs off, git kept at the root; a root .gitleaksignore is itself reported', async (t) => {
    const root = makeRepo(t, FILES);
    const { call, scanner } = callOn(root, { kind: 'clean' }, t);
    const clean = await call(SECRET_SCAN_TOOL, 'scan_tree');
    assert.equal(clean['findings_count'], 0);
    const recorded = JSON.parse(readFileSync(scanner.recordPath, 'utf8')) as { args: string[]; env: Record<string, string> };
    assert.ok(recorded.args.includes('--ignore-gitleaks-allow'));
    assert.equal(recorded.args[recorded.args.indexOf('--log-level') + 1], 'warn');
    assert.equal(recorded.env['GIT_NO_REPLACE_OBJECTS'], '1');
    assert.equal(recorded.env['GIT_CONFIG_KEY_3'], 'core.useReplaceRefs');
    assert.equal(recorded.env['GIT_CEILING_DIRECTORIES'], dirname(root));
    // 루트의 .gitleaksignore 는 스캐너가 발견을 지운다: 그 존재를 발견으로 보고한다 (트리·이력 둘 다)
    writeFileSync(join(root, '.gitleaksignore'), 'anything:rule:1\n');
    for (const operation of ['scan_tree', 'scan_history']) {
      const result = await call(SECRET_SCAN_TOOL, operation);
      assert.equal(result['findings_count'], 1, operation);
      assert.deepEqual(result['findings'], [{ location: '.gitleaksignore', kind: 'scanner-suppression' }], operation);
    }
  });

  it('a shallow repository and a scan that skipped files are errors, never a "complete" scan', async (t) => {
    const root = makeRepo(t, FILES);
    const shallow = callOn(root, { kind: 'clean' }, t);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(root, '.git', 'shallow'), `${head}\n`);
    await assert.rejects(shallow.call(SECRET_SCAN_TOOL, 'scan_history'), /scan_failed: the repository is shallow/);
    rmSync(join(root, '.git', 'shallow'));
    const skipping = callOn(root, { kind: 'clean_but_skipped_file' }, t);
    await assert.rejects(skipping.call(SECRET_SCAN_TOOL, 'scan_tree'), /scan_failed: the scanner skipped part of the target/);
    assert.equal(skipping.capture.saved.length, 0);
  });

  it('a "leaks found" warning is not mistaken for a skipped file', async (t) => {
    const { call } = rig(t, FILES, { kind: 'findings', items: [{ RuleID: 'generic-api-key', File: 'ABS:src/index.ts' }] });
    assert.equal((await call(SECRET_SCAN_TOOL, 'scan_tree'))['findings_count'], 1);
  });

  it('cancelling the call kills the scanner at once and stores nothing', async (t) => {
    const root = makeRepo(t, FILES);
    const hang = callOn(root, { kind: 'hang' }, t);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await assert.rejects(hang.executors.get(SECRET_SCAN_TOOL)!(request(SECRET_SCAN_TOOL, 'scan_tree', {}, controller.signal)), /scan_failed: the scan was cancelled/);
    assert.ok(Date.now() - started < 5000, 'the scanner did not run to its own time limit');
    assert.equal(hang.capture.saved.length, 0);
  });

  it('a LICENSE that is a symlink (here to .git/config) is not read or reported', async (t) => {
    const root = makeRepo(t, { 'a.txt': 'a' });
    symlinkSync('.git/config', join(root, 'LICENSE'));
    const { call, capture } = callOn(root, { kind: 'clean' }, t);
    const result = await call(LICENSE_CHECK_TOOL, 'identify');
    assert.deepEqual(result['license_files'], []);
    assert.ok(!capture.saved.some((saved) => saved.text.includes('[core]')));
  });
});

describe('review findings: per-run limits and result size', () => {
  it('a run has a call quota, a scan quota and an evidence byte quota; the next call is refused', async (t) => {
    const root = makeRepo(t, FILES);
    const dir = makeTempDir(t, 'aot-stub-');
    const scanner = writeStubGitleaks(dir, { kind: 'clean' });
    const make = (quota: { maxCalls?: number; maxScans?: number; maxEvidenceBytes?: number }) => createRegistrationTools({
      clock, gitPath: GIT, gitleaksPath: scanner.path, gitleaksConfigPath: CONFIG, quota,
    }).executorsFor(toolRun(root, new MemoryCapture()));
    const calls = make({ maxCalls: 3 });
    for (let i = 0; i < 3; i += 1) await calls.get('repo_read')!(request('repo_read', 'read_metadata'));
    await assert.rejects(calls.get('repo_read')!(request('repo_read', 'read_metadata')), /quota_exceeded: more than 3 registration tool calls/);
    const scans = make({ maxScans: 1 });
    await scans.get('secret_scan')!(request('secret_scan', 'scan_tree'));
    await assert.rejects(scans.get('secret_scan')!(request('secret_scan', 'scan_tree')), /quota_exceeded: more than 1 secret scans/);
    const bytes = make({ maxEvidenceBytes: 50 });
    await assert.rejects(bytes.get('repo_read')!(request('repo_read', 'read_file', { path: 'README.md' })), /quota_exceeded: the evidence storage quota/);
  });

  it('parallel calls of one run are executed one at a time', async (t) => {
    const root = makeRepo(t, FILES);
    let active = 0;
    let peak = 0;
    const capture = {
      saved: 0,
      async capture() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        this.saved += 1;
        return { evidenceId: `ev-${this.saved}`, sha256: 'x' };
      },
    };
    const executors = createRegistrationTools({ clock, gitPath: GIT, gitleaksPath: '/nonexistent', gitleaksConfigPath: CONFIG }).executorsFor(toolRun(root, capture));
    await Promise.all([1, 2, 3, 4].map(() => executors.get('repo_read')!(request('repo_read', 'read_file', { path: 'README.md' }))));
    assert.equal(peak, 1);
  });

  it('a result larger than the limit is shrunk (not cut by the gateway), keeps evidence_id first, and says it was truncated', async (t) => {
    // JSON 이스케이프로 두 배가 되는 문자: 512 KiB 본문이 약 1 MiB 직렬화가 된다
    const root = makeRepo(t, { 'big.txt': '"\n'.repeat(250_000) });
    const tools = createRegistrationTools({ clock, gitPath: GIT, gitleaksPath: '/nonexistent', gitleaksConfigPath: CONFIG });
    const store = new MemoryCapture();
    const result = (await tools.executorsFor(toolRun(root, store)).get('repo_read')!(request('repo_read', 'read_file', { path: 'big.txt', max_bytes: 500_000 }))).result as JsonObject;
    assert.equal(Object.keys(result)[0], 'evidence_id');
    assert.equal(result['truncated'], true);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 700_000);
    assert.equal(JSON.parse(store.last().text)['truncated'], true, 'the stored body is the shrunk one — what the agent saw');
  });
});
