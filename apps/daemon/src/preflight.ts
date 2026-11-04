// 섀도 파일럿 사전 점검 (docs/plans/handoff-pilot-prep.md WP2, docs/operations/shadow-pilot.md).
//   node apps/daemon/src/preflight.ts [설정 파일]      (기본: $AOT_DAEMON_CONFIG 또는 $AOT_INSTANCE_DIR/daemon.config.json)
//   npm run preflight -- [설정 파일]
// 데몬을 띄우기 전에 설정 실수(상대 경로, 실행 파일 없음, 실행·검증 모델 같음, 동의 안 함, 디렉터리 권한)를 한 줄씩 알려 준다. 줄마다 `ok|warn|fail|info` + 사유.
// 종료 코드: 0 = fail 없음(warn 은 있을 수 있다), 1 = fail 있음, 2 = 사용법·설정 파일을 읽지 못함.
//
// 하지 않는 것:
//   - 모델을 호출하지 않는다 (구독 사용량을 쓰지 않는다). 실행 파일은 `--version`/`version` 만 부른다.
//   - 환경 변수·토큰·로그인 정보를 읽거나 출력하지 않는다. 설정의 `claude_code_cli.env` 값(홈·계정·PATH)과 알려지지 않은 키의 값은 출력에 쓰지 않는다.
//   - DB 를 쓰지 않는다: 읽기 전용으로만 열고, 파일이 없으면 만들지 않는다. 디렉터리도 만들거나 권한을 고치지 않는다.
//   - 실제 구독 로그인 여부는 점검할 수 없다 → 절차서 §4 5번 명령을 PC 에서 직접 돌리라는 안내만 한다.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLAUDE_CODE_NOTICE } from '@aot/agent-runtime';
import { openDb, type Db } from '@aot/domain';

import { readClaudeCodeConsent } from './consent.ts';
import { parseClaudeCodeCliConfig, parseLlmVerifierConfig, parseRegistrationToolsConfig, type ClaudeCodeCliConfig, type LlmVerifierConfig, type RegistrationToolsConfig } from './runtime-config.ts';

export type PreflightLevel = 'ok' | 'warn' | 'fail' | 'info';
export interface PreflightLine {
  level: PreflightLevel;
  check: string;
  reason: string;
}
export interface PreflightResult {
  lines: PreflightLine[];
  /** 0 = fail 없음, 1 = fail 있음 */
  exitCode: 0 | 1;
}

/** Q21: 비밀값 스캐너 고정 버전 */
export const EXPECTED_GITLEAKS_VERSION = '8.30.1';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));
const VERSION_TIMEOUT_MS = 10_000;

export interface PreflightOptions {
  /** 실행 파일을 불러 버전 줄을 얻는다. 시험에서 바꿀 수 있다 */
  runVersion?: (path: string, args: readonly string[], env: Readonly<Record<string, string>>) => string;
  /** 인스턴스 디렉터리를 설정이 정하지 않았을 때 쓰는 값 (기본: $AOT_INSTANCE_DIR 또는 instance) */
  defaultInstanceDir?: string;
  migrationsDir?: string;
}

/** 실제 실행: 모델을 부르지 않는 버전 확인만. 첫 줄만, 길이 제한 */
function defaultRunVersion(path: string, args: readonly string[], env: Readonly<Record<string, string>>): string {
  const out = execFileSync(path, [...args], { env: { ...env }, encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 });
  return (out.split('\n', 1)[0] ?? '').trim().slice(0, 80);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.slice(0, 300);
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 설정 파일 내용(이미 JSON 으로 읽은 값)을 점검한다. 파일을 읽는 일은 `runPreflightFile` 이 한다 */
export function runPreflight(raw: unknown, options: PreflightOptions = {}): PreflightResult {
  const lines: PreflightLine[] = [];
  const add = (level: PreflightLevel, check: string, reason: string): void => { lines.push({ level, check, reason }); };
  const runVersion = options.runVersion ?? defaultRunVersion;

  // ① 설정 파싱 (운영과 같은 파서)
  if (!isRecord(raw)) {
    add('fail', 'config', 'the configuration must be a JSON object');
    return { lines, exitCode: 1 };
  }
  const config = raw;
  if (typeof config['db_path'] !== 'string' || typeof config['worker_id'] !== 'string') add('fail', 'config', 'db_path and worker_id are required strings');
  else add('ok', 'config', 'db_path and worker_id are set');

  const parse = <T>(name: string, parser: (value: unknown) => T | undefined, value: unknown): { ok: boolean; value: T | undefined } => {
    try {
      const parsed = parser(value);
      add('ok', `config.${name}`, parsed === undefined ? 'not configured' : 'parses');
      return { ok: true, value: parsed };
    } catch (error) {
      add('fail', `config.${name}`, errorText(error));
      return { ok: false, value: undefined };
    }
  };
  const claudeParsed = parse('claude_code_cli', parseClaudeCodeCliConfig, config['claude_code_cli']);
  const verifierParsed = parse('llm_verifier', parseLlmVerifierConfig, config['llm_verifier']);
  const toolsParsed = parse('registration_tools', parseRegistrationToolsConfig, config['registration_tools']);
  const claude: ClaudeCodeCliConfig | undefined = claudeParsed.value;
  const verifier: LlmVerifierConfig | undefined = verifierParsed.value;
  const tools: RegistrationToolsConfig | undefined = toolsParsed.value;

  const instanceDir = typeof config['instance_dir'] === 'string' ? config['instance_dir'] : (options.defaultInstanceDir ?? process.env['AOT_INSTANCE_DIR'] ?? 'instance');

  // ② 경로와 실행 파일
  const checkExecutable = (check: string, path: string): boolean => {
    if (!isAbsolute(path)) { add('fail', check, 'must be an absolute path (it is never looked up on PATH)'); return false; }
    try {
      if (!statSync(path).isFile()) { add('fail', check, `${path} is not a file`); return false; }
      accessSync(path, constants.X_OK);
    } catch {
      add('fail', check, `${path} does not exist or is not executable`);
      return false;
    }
    add('ok', check, `${path} is executable`);
    return true;
  };
  const checkReadableFile = (check: string, path: string): void => {
    if (!isAbsolute(path)) { add('fail', check, 'must be an absolute path'); return; }
    try {
      accessSync(path, constants.R_OK);
      add('ok', check, `${path} is readable`);
    } catch {
      add('fail', check, `${path} does not exist or is not readable`);
    }
  };

  const versionOf = (check: string, path: string, args: readonly string[], env: Readonly<Record<string, string>>): string | undefined => {
    try {
      return runVersion(path, args, env);
    } catch {
      add('fail', check, `\`${path} ${args.join(' ')}\` did not run successfully`);
      return undefined;
    }
  };

  if (claude !== undefined) {
    if (checkExecutable('claude.path', claude.claude_path)) {
      const version = versionOf('claude.version', claude.claude_path, ['--version'], { HOME: claude.env.home, USER: claude.env.user, PATH: claude.env.path });
      if (version !== undefined) add('ok', 'claude.version', version === '' ? 'ran (no version text)' : version);
    }
    // 홈·계정·PATH 의 값은 출력하지 않는다. 모양만 본다
    if (!isAbsolute(claude.env.home) || !isAbsolute(claude.run_root)) add('fail', 'claude.paths', 'claude_code_cli.env.home and run_root must be absolute paths');
    else {
      try {
        if (!statSync(claude.env.home).isDirectory()) add('fail', 'claude.home', 'claude_code_cli.env.home is not a directory');
        else add('ok', 'claude.home', 'claude_code_cli.env.home exists');
      } catch {
        add('fail', 'claude.home', 'claude_code_cli.env.home does not exist');
      }
    }
  } else if (claudeParsed.ok) {
    add('warn', 'claude.path', 'claude_code_cli is not configured: no subscription executor or verifier can run');
  }

  if (tools !== undefined) {
    if (checkExecutable('git.path', tools.git_path)) {
      const v = versionOf('git.version', tools.git_path, ['--version'], { PATH: '/usr/bin:/bin' });
      if (v !== undefined) add('ok', 'git.version', v === '' ? 'ran (no version text)' : v);
    }
    if (checkExecutable('gitleaks.path', tools.gitleaks_path)) {
      const v = versionOf('gitleaks.version', tools.gitleaks_path, ['version'], { PATH: '/usr/bin:/bin' });
      if (v !== undefined) {
        const found = /(?:^|[\s v])(\d+\.\d+\.\d+)(?:$|\s)/.exec(v)?.[1];
        if (found === EXPECTED_GITLEAKS_VERSION) add('ok', 'gitleaks.version', found);
        else add('warn', 'gitleaks.version', `expected ${EXPECTED_GITLEAKS_VERSION} (Q21), found ${found ?? 'an unrecognised version string'}`);
      }
    }
    if (tools.gitleaks_config !== undefined) checkReadableFile('gitleaks.config', tools.gitleaks_config);
  }

  // ④ 검증기: 구독 CLI, 섀도 모드, 실행 모델과 다른 모델
  if (verifierParsed.ok) {
    if (verifier === undefined) add('fail', 'verifier', 'llm_verifier is not configured: the pilot needs {"kind": "claude_code_cli", "model": …, "shadow": true}');
    else if (verifier.kind !== 'claude_code_cli') add('fail', 'verifier', `llm_verifier.kind is '${verifier.kind}': the pilot needs 'claude_code_cli'`);
    else {
      add('ok', 'verifier.kind', 'claude_code_cli');
      if (claude === undefined && claudeParsed.ok) add('fail', 'verifier.adapter', 'llm_verifier claude_code_cli needs the claude_code_cli executor configuration (same login, consent and gate)');
      if (verifier.shadow === true) add('ok', 'verifier.shadow', 'shadow mode is on (verdicts are recorded, not applied)');
      else add('fail', 'verifier.shadow', 'shadow must be true during the pilot (the first five products are decided by a human)');
      const executorModel = claude?.model;
      if (executorModel === undefined) {
        if (claude !== undefined) add('warn', 'verifier.model', 'the executor model is not set (the CLI default is used): cannot confirm that the verifier model differs');
      } else if (executorModel === verifier.model) {
        if (verifier.allow_same_model === true) add('warn', 'verifier.model', 'verifier and executor use the same model (allow_same_model is true); Q22 b wants a higher tier for verification');
        else add('fail', 'verifier.model', 'verifier and executor use the same model: the daemon refuses to start (Q22 b); set a different tier');
      } else add('ok', 'verifier.model', 'differs from the executor model');
    }
  }

  // ⑦ product 명령은 registration_tools 가 있어야 켜진다
  if (toolsParsed.ok) {
    if (tools === undefined) add('fail', 'registration_tools', 'not configured: the `product` commands (add/start/status/decide/…) are only enabled when registration_tools is set');
    else if (claude === undefined && config['container_agent'] === undefined) add('fail', 'registration_tools', 'needs an agent adapter: set claude_code_cli (or container_agent)');
    else add('ok', 'registration_tools', 'set: the `product` commands are enabled');
  }

  // ⑥ 디렉터리 권한 (0700). 만들거나 고치지 않는다
  const checkDir = (check: string, path: string): void => {
    if (!isAbsolute(path)) {
      add('warn', check, `${path} is relative: it resolves against the daemon's working directory`);
      return;
    }
    if (!existsSync(path)) { add('ok', check, `${path} does not exist yet (the daemon creates it)`); return; }
    try {
      const info = statSync(path);
      if (!info.isDirectory()) add('fail', check, `${path} is not a directory`);
      else if ((info.mode & 0o077) !== 0) add('fail', check, `${path} is accessible by other users (mode ${(info.mode & 0o777).toString(8)}; it must be 0700)`);
      else add('ok', check, `${path} is 0700`);
    } catch {
      add('fail', check, `${path} cannot be inspected`);
    }
  };
  checkDir('dir.evidence', tools?.evidence_dir ?? join(instanceDir, 'evidence'));
  if (claude !== undefined) checkDir('dir.run_root', claude.run_root);
  checkDir('dir.run_log', typeof config['run_log_dir'] === 'string' ? config['run_log_dir'] : join(instanceDir, 'run-logs'));
  checkDir('dir.totp', typeof config['totp_dir'] === 'string' ? config['totp_dir'] : join(instanceDir, 'totp'));

  // ⑤ DB: 읽기 전용. 마이그레이션 적용과 고지 동의
  if (typeof config['db_path'] === 'string') checkDatabase(config['db_path'], claude !== undefined, add, options.migrationsDir ?? MIGRATIONS_DIR);

  add('info', 'login', 'the subscription login cannot be checked here: run the verifier-shaped call from docs/operations/claude-code-cli.md §4 step 5 on this PC');

  return { lines, exitCode: lines.some((line) => line.level === 'fail') ? 1 : 0 };
}

function checkDatabase(dbPath: string, needsConsent: boolean, add: (level: PreflightLevel, check: string, reason: string) => void, migrationsDir: string): void {
  if (!existsSync(dbPath)) {
    add('warn', 'db', `${dbPath} does not exist yet: start the daemon once (it applies the migrations), then give the consent`);
    return;
  }
  let db: Db;
  try {
    db = openDb({ path: dbPath, readOnly: true });
  } catch (error) {
    add('fail', 'db', `${dbPath} cannot be opened read-only: ${errorText(error)}`);
    return;
  }
  try {
    const table = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'");
    if (table === undefined) {
      add('warn', 'db.migrations', 'no migrations applied yet (the daemon applies them at start)');
      return;
    }
    const applied = new Map(db.all<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migration').map((row) => [row.id, row.checksum]));
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    const missing: string[] = [];
    const changed: string[] = [];
    for (const name of files) {
      const checksum = applied.get(name);
      if (checksum === undefined) missing.push(name);
      else if (checksum !== sha256(readFileSync(join(migrationsDir, name), 'utf8'))) changed.push(name);
    }
    if (changed.length > 0) add('fail', 'db.migrations', `checksum mismatch for ${changed.join(', ')}: the daemon would refuse to start`);
    else if (missing.length > 0) add('warn', 'db.migrations', `not applied yet: ${missing.join(', ')} (the daemon applies them at start)`);
    else add('ok', 'db.migrations', `${files.length} migration(s) applied`);

    if (needsConsent) {
      try {
        if (readClaudeCodeConsent(db) !== null) add('ok', 'consent', `accepted for notice ${CLAUDE_CODE_NOTICE.version}`);
        else add('warn', 'consent', `not accepted for the current notice (${CLAUDE_CODE_NOTICE.version}): run \`approve.ts consent show\` then \`consent accept --version ${CLAUDE_CODE_NOTICE.version}\` (tasks would stop at needs_review)`);
      } catch {
        add('warn', 'consent', 'the consent state could not be read (the event table is missing: start the daemon once)');
      }
    }
  } catch (error) {
    add('fail', 'db', `the database could not be inspected: ${errorText(error)}`);
  } finally {
    db.close();
  }
}

export function formatPreflight(result: PreflightResult): string {
  return `${result.lines.map((line) => `${line.level.padEnd(4)} ${line.check}: ${line.reason}`).join('\n')}\n${result.exitCode === 0 ? 'preflight: no failures' : 'preflight: FAILED'}`;
}

/** 설정 파일을 읽어 점검한다. 읽을 수 없거나 JSON 이 아니면 null (호출자는 종료 코드 2) */
export function runPreflightFile(path: string, options: PreflightOptions = {}): { result: PreflightResult } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return { error: `cannot read the configuration ${path}: ${error instanceof SyntaxError ? 'not valid JSON' : errorText(error)}` };
  }
  return { result: runPreflight(raw, options) };
}

if (import.meta.main) {
  const path = process.argv[2] ?? process.env['AOT_DAEMON_CONFIG'] ?? join(process.env['AOT_INSTANCE_DIR'] ?? 'instance', 'daemon.config.json');
  if (process.argv.length > 3 || path.startsWith('-')) {
    console.error('usage: preflight.ts [config file]');
    process.exitCode = 2;
  } else {
    const outcome = runPreflightFile(path);
    if ('error' in outcome) {
      console.error(outcome.error);
      process.exitCode = 2;
    } else {
      console.log(formatPreflight(outcome.result));
      process.exitCode = outcome.result.exitCode;
    }
  }
}
