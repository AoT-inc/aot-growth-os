// WP2: 파일럿 사전 점검(apps/daemon/src/preflight.ts). 가짜 실행 파일로 각 점검의 ok/warn/fail을 고정한다.
// 모델을 부르지 않고(실행 파일은 버전 인자만 받는다), DB 를 쓰지 않고, 설정의 비밀스러운 값을 출력하지 않는다.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { CLAUDE_CODE_NOTICE } from '@aot/agent-runtime';
import { applyMigrations, FakeClock, openDb } from '@aot/domain';

import { EXPECTED_GITLEAKS_VERSION, formatPreflight, runPreflight, runPreflightFile, type PreflightLevel, type PreflightResult } from '../../apps/daemon/src/preflight.ts';
import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';
import { makeTempDir } from '../support/temp.ts';

interface Rig {
  dir: string;
  config: Record<string, unknown>;
  /** 가짜 실행 파일이 받은 인자 (한 줄에 한 번 호출) */
  calls(): string[];
  dbPath: string;
}

/** `$1` 이 버전 인자일 때만 한 줄을 출력하는 가짜 실행 파일. 호출마다 인자를 기록 파일에 남긴다 */
function fakeExecutable(path: string, record: string, versionLine: string): void {
  writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> '${record}'\nif [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo '${versionLine}'; exit 0; fi\nexit 9\n`);
  chmodSync(path, 0o755);
}

function rig(t: TestContext, mutate: (config: Record<string, unknown>) => void = () => undefined): Rig {
  const dir = makeTempDir(t, 'aot-preflight-');
  const record = join(dir, 'calls.log');
  writeFileSync(record, '');
  fakeExecutable(join(dir, 'claude'), record, '2.1.310 (Claude Code)');
  fakeExecutable(join(dir, 'git'), record, 'git version 2.50.0');
  fakeExecutable(join(dir, 'gitleaks'), record, EXPECTED_GITLEAKS_VERSION);
  const home = join(dir, 'home');
  mkdirSync(home);
  const dbPath = join(dir, 'aot.db');
  const config: Record<string, unknown> = {
    db_path: dbPath,
    worker_id: 'daemon-1',
    instance_dir: join(dir, 'instance'),
    claude_code_cli: { claude_path: join(dir, 'claude'), run_root: join(dir, 'r'), env: { home, user: 'example-daemon', path: '/usr/bin:/bin' }, model: 'executor-alias' },
    registration_tools: { git_path: join(dir, 'git'), gitleaks_path: join(dir, 'gitleaks') },
    llm_verifier: { kind: 'claude_code_cli', model: 'verifier-alias', shadow: true },
  };
  mutate(config);
  return { dir, config, dbPath, calls: () => readFileSync(record, 'utf8').split('\n').filter((line) => line !== '') };
}

function levelOf(result: PreflightResult, check: string): PreflightLevel | undefined {
  return result.lines.find((line) => line.check === check)?.level;
}
function reasonOf(result: PreflightResult, check: string): string {
  return result.lines.find((line) => line.check === check)?.reason ?? '';
}

/** 마이그레이션을 적용한 DB 파일을 만들고 (선택) 고지 동의를 남긴다 */
function makeDatabase(path: string, options: { consent?: boolean; migrate?: boolean } = {}): void {
  const db = openDb({ path });
  try {
    if (options.migrate !== false) applyMigrations(db, { dir: MIGRATIONS_DIR, clock: new FakeClock('2026-11-04T00:00:00.000Z') });
    if (options.consent === true) {
      db.writeTx((tx) => tx.run(
        'INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
        ['event-consent-1', 'consent', 'claude-code-cli', 'consent.accepted', JSON.stringify({ notice_version: CLAUDE_CODE_NOTICE.version, actor_id: 'actor-owner' }), 'consent:1', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z'],
      ));
    }
  } finally {
    db.close();
  }
}

describe('preflight: a good configuration', () => {
  it('has no failure; the DB and directories do not exist yet, so those are ok/warn and the login is only an info line', (t) => {
    const r = rig(t);
    const result = runPreflight(r.config);
    assert.equal(result.exitCode, 0, formatPreflight(result));
    for (const check of ['config', 'config.claude_code_cli', 'config.llm_verifier', 'config.registration_tools', 'claude.path', 'claude.version', 'git.path', 'git.version', 'gitleaks.path', 'gitleaks.version', 'verifier.kind', 'verifier.shadow', 'verifier.model', 'registration_tools']) {
      assert.equal(levelOf(result, check), 'ok', `${check}: ${reasonOf(result, check)}`);
    }
    assert.equal(levelOf(result, 'db'), 'warn');
    assert.equal(levelOf(result, 'login'), 'info');
    assert.match(formatPreflight(result), /preflight: no failures/);
  });

  it('with the migrations applied and the consent given the database lines are ok', (t) => {
    const r = rig(t);
    makeDatabase(r.dbPath, { consent: true });
    const result = runPreflight(r.config);
    assert.equal(levelOf(result, 'db.migrations'), 'ok', reasonOf(result, 'db.migrations'));
    assert.equal(levelOf(result, 'consent'), 'ok', reasonOf(result, 'consent'));
    assert.equal(result.exitCode, 0);
  });
});

describe('preflight: configuration and executables', () => {
  it('fails on a parse error with the parser\'s reason, and on a non-object configuration', (t) => {
    const r = rig(t, (c) => { (c['registration_tools'] as Record<string, unknown>)['typo_key'] = 1; });
    const result = runPreflight(r.config);
    assert.equal(levelOf(result, 'config.registration_tools'), 'fail');
    assert.match(reasonOf(result, 'config.registration_tools'), /unknown key/);
    assert.equal(result.exitCode, 1);
    assert.equal(runPreflight([]).exitCode, 1);
    assert.equal(runPreflight(null).exitCode, 1);
  });

  it('fails on a relative executable path, a missing file and a file that is not executable', (t) => {
    const relative = runPreflight(rig(t, (c) => { (c['claude_code_cli'] as Record<string, unknown>)['claude_path'] = 'claude'; }).config);
    assert.equal(levelOf(relative, 'claude.path'), 'fail');
    assert.match(reasonOf(relative, 'claude.path'), /absolute/);

    const missing = rig(t, (c) => { (c['registration_tools'] as Record<string, unknown>)['gitleaks_path'] = '/nonexistent/example/gitleaks'; });
    assert.equal(levelOf(runPreflight(missing.config), 'gitleaks.path'), 'fail');

    const plain = rig(t);
    writeFileSync(join(plain.dir, 'git'), 'not executable');
    chmodSync(join(plain.dir, 'git'), 0o644);
    const result = runPreflight(plain.config);
    assert.equal(levelOf(result, 'git.path'), 'fail');
    assert.equal(result.exitCode, 1);
  });

  it('fails when the executable cannot report its version', (t) => {
    const r = rig(t);
    const result = runPreflight(r.config, { runVersion: () => { throw new Error('boom'); } });
    assert.equal(levelOf(result, 'claude.version'), 'fail');
    assert.equal(levelOf(result, 'git.version'), 'fail');
    assert.equal(levelOf(result, 'gitleaks.version'), 'fail');
  });

  it('warns (does not fail) when gitleaks is not 8.30.1', (t) => {
    const r = rig(t);
    fakeExecutable(join(r.dir, 'gitleaks'), join(r.dir, 'calls.log'), '8.28.0');
    const result = runPreflight(r.config);
    assert.equal(levelOf(result, 'gitleaks.version'), 'warn');
    assert.match(reasonOf(result, 'gitleaks.version'), /8\.30\.1/);
    assert.equal(result.exitCode, 0);
  });

  it('fails when registration_tools is missing: the product commands would not exist', (t) => {
    const r = rig(t, (c) => { c['registration_tools'] = null; });
    const result = runPreflight(r.config);
    assert.equal(levelOf(result, 'registration_tools'), 'fail');
    assert.match(reasonOf(result, 'registration_tools'), /product/);
  });
});

describe('preflight: the verifier', () => {
  it('fails when llm_verifier is absent, a stub, or not in shadow mode', (t) => {
    assert.equal(levelOf(runPreflight(rig(t, (c) => { c['llm_verifier'] = null; }).config), 'verifier'), 'fail');
    assert.equal(levelOf(runPreflight(rig(t, (c) => { c['llm_verifier'] = { kind: 'stub' }; }).config), 'verifier'), 'fail');
    const noShadow = runPreflight(rig(t, (c) => { c['llm_verifier'] = { kind: 'claude_code_cli', model: 'verifier-alias' }; }).config);
    assert.equal(levelOf(noShadow, 'verifier.shadow'), 'fail');
    assert.equal(noShadow.exitCode, 1);
  });

  it('fails when the verifier uses the executor\'s model; warns with allow_same_model; warns when the executor model is unset', (t) => {
    const same = runPreflight(rig(t, (c) => { c['llm_verifier'] = { kind: 'claude_code_cli', model: 'executor-alias', shadow: true }; }).config);
    assert.equal(levelOf(same, 'verifier.model'), 'fail');
    const allowed = runPreflight(rig(t, (c) => { c['llm_verifier'] = { kind: 'claude_code_cli', model: 'executor-alias', shadow: true, allow_same_model: true }; }).config);
    assert.equal(levelOf(allowed, 'verifier.model'), 'warn');
    assert.equal(allowed.exitCode, 0);
    const unset = runPreflight(rig(t, (c) => { delete (c['claude_code_cli'] as Record<string, unknown>)['model']; }).config);
    assert.equal(levelOf(unset, 'verifier.model'), 'warn');
  });

  it('fails when the verifier is configured but the executor configuration is missing', (t) => {
    const result = runPreflight(rig(t, (c) => { c['claude_code_cli'] = null; c['container_agent'] = null; }).config);
    assert.equal(levelOf(result, 'verifier.adapter'), 'fail');
  });
});

describe('preflight: database and consent (read only)', () => {
  it('warns about a missing consent and about unapplied migrations; fails on a changed migration', (t) => {
    const r = rig(t);
    makeDatabase(r.dbPath);
    const noConsent = runPreflight(r.config);
    assert.equal(levelOf(noConsent, 'consent'), 'warn');
    assert.match(reasonOf(noConsent, 'consent'), /consent accept/);
    assert.equal(noConsent.exitCode, 0);

    const empty = rig(t);
    makeDatabase(empty.dbPath, { migrate: false });
    const result = runPreflight(empty.config);
    assert.equal(levelOf(result, 'db.migrations'), 'warn');

    const tampered = rig(t);
    makeDatabase(tampered.dbPath);
    const writer = openDb({ path: tampered.dbPath });
    writer.writeTx((tx) => tx.run("UPDATE schema_migration SET checksum = 'changed'"));
    writer.close();
    const changed = runPreflight(tampered.config);
    assert.equal(levelOf(changed, 'db.migrations'), 'fail');
    assert.equal(changed.exitCode, 1);
  });

  it('a consent for an older notice version does not count', (t) => {
    const r = rig(t);
    makeDatabase(r.dbPath);
    const writer = openDb({ path: r.dbPath });
    writer.writeTx((tx) => tx.run(
      'INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
      ['event-consent-old', 'consent', 'claude-code-cli', 'consent.accepted', JSON.stringify({ notice_version: '2000-01-01', actor_id: 'actor-owner' }), 'consent:old', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z'],
    ));
    writer.close();
    assert.equal(levelOf(runPreflight(r.config), 'consent'), 'warn');
  });

  it('never writes: a missing database is not created and an existing one is byte-identical afterwards', (t) => {
    const missing = rig(t);
    runPreflight(missing.config);
    assert.equal(existsSync(missing.dbPath), false);

    const r = rig(t);
    makeDatabase(r.dbPath, { consent: true });
    // 쓰기 연결을 닫으면 WAL 이 정리돼 파일 하나로 비교할 수 있다
    const before = readFileSync(r.dbPath);
    const mtime = statSync(r.dbPath).mtimeMs;
    runPreflight(r.config);
    assert.deepEqual(readFileSync(r.dbPath), before);
    assert.equal(statSync(r.dbPath).mtimeMs, mtime);
  });
});

describe('preflight: directories are checked, never created or changed', () => {
  it('fails on an evidence directory other users can read; ok at 0700; a missing one is ok and stays missing', (t) => {
    const r = rig(t);
    const evidence = join(r.dir, 'evidence');
    (r.config['registration_tools'] as Record<string, unknown>)['evidence_dir'] = evidence;
    const missing = runPreflight(r.config);
    assert.equal(levelOf(missing, 'dir.evidence'), 'ok');
    assert.equal(existsSync(evidence), false, 'preflight must not create the directory');

    mkdirSync(evidence, { mode: 0o755 });
    chmodSync(evidence, 0o755);
    const open = runPreflight(r.config);
    assert.equal(levelOf(open, 'dir.evidence'), 'fail');
    assert.match(reasonOf(open, 'dir.evidence'), /0700/);
    assert.equal(statSync(evidence).mode & 0o777, 0o755, 'preflight must not fix the mode either');

    chmodSync(evidence, 0o700);
    assert.equal(levelOf(runPreflight(r.config), 'dir.evidence'), 'ok');
  });

  it('checks run_root and the run-log directory too', (t) => {
    const r = rig(t);
    const runRoot = join(r.dir, 'r');
    mkdirSync(runRoot);
    chmodSync(runRoot, 0o770);
    assert.equal(levelOf(runPreflight(r.config), 'dir.run_root'), 'fail');
    const logDir = join(r.dir, 'logs');
    mkdirSync(logDir);
    chmodSync(logDir, 0o750);
    r.config['run_log_dir'] = logDir;
    assert.equal(levelOf(runPreflight(r.config), 'dir.run_log'), 'fail');
  });
});

describe('preflight: what it must not do', () => {
  it('only asks the executables for their version (no model call, no other arguments)', (t) => {
    const r = rig(t);
    runPreflight(r.config);
    const calls = r.calls();
    assert.equal(calls.length, 3);
    for (const call of calls) assert.match(call, / (--version|version)$/, call);
  });

  it('does not print secret-looking configuration values (environment values, unknown keys, pack values, API key names)', (t) => {
    const r = rig(t, (c) => {
      (c['claude_code_cli'] as { env: Record<string, string> }).env.user = 'marker-user-7f3a';
      (c['claude_code_cli'] as { env: Record<string, string> }).env.path = '/usr/bin:/bin:/marker-path-7f3a';
      c['pack_values'] = { research_source_url: 'https://marker-pack-7f3a.example.invalid/x' };
      c['phone'] = { api_key_env: 'MARKER_PHONE_KEY_7F3A', webhook_secret_env: 'MARKER_WEBHOOK_SECRET_7F3A' };
      c['extra_secretish'] = 'marker-extra-7f3a';
    });
    const result = runPreflight(r.config);
    const text = formatPreflight(result) + JSON.stringify(result.lines);
    assert.doesNotMatch(text, /7f3a/);
    assert.doesNotMatch(text, new RegExp(String((r.config['claude_code_cli'] as { env: { home: string } }).env.home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the home directory path is not printed either');
  });

  it('a version probe gets only the three configured environment values for claude and a fixed PATH for git and gitleaks', (t) => {
    const r = rig(t);
    const seen: Array<{ path: string; env: Record<string, string> }> = [];
    runPreflight(r.config, { runVersion: (path, _args, env) => { seen.push({ path, env: { ...env } }); return 'x 1.0.0'; } });
    assert.deepEqual(seen.map((entry) => Object.keys(entry.env).sort()), [['HOME', 'PATH', 'USER'], ['PATH'], ['PATH']]);
  });
});

describe('preflight: reading the file', () => {
  it('reports an unreadable or non-JSON file instead of throwing', (t) => {
    const dir = makeTempDir(t);
    assert.ok('error' in runPreflightFile(join(dir, 'missing.json')));
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    const bad = runPreflightFile(join(dir, 'bad.json'));
    assert.ok('error' in bad);
    assert.match(bad.error, /not valid JSON/);
    const r = rig(t);
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(r.config));
    const good = runPreflightFile(join(dir, 'ok.json'));
    assert.ok('result' in good);
    assert.equal(good.result.exitCode, 0);
  });
});
