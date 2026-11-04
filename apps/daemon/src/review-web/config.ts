// 검토 화면 실행 인자·위치 결정. 데몬과 같은 관례를 따른다(main.ts·runtime-config.ts):
//   DB: `--db` > 데몬 설정 파일의 `db_path`. 설정 파일: `--config` > $AOT_DAEMON_CONFIG > <인스턴스>/daemon.config.json (`--db` 가 있으면 없어도 된다)
//   인스턴스 폴더: `--instance-dir` > 설정의 `instance_dir` > $AOT_INSTANCE_DIR > (`--db` 만 줬으면 그 DB 가 있는 폴더) > `instance`
//   근거 저장소: `--evidence-dir` > 설정의 `registration_tools.evidence_dir` > <인스턴스>/evidence
//   정책 보관소: `--policy-dir` > 설정의 `policy_store_dir` > <인스턴스>/policies
//   추가로 증거 파일을 읽어도 되는 폴더: `--evidence-root <폴더>` (여러 번). 이 목록 밖의 파일은 보여 주지 않는다.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ReviewWebConfig {
  dbPath: string;
  port: number;
  host: string;
  policyStoreDir: string;
  evidenceDir: string;
  evidenceRoots: string[];
}

export class UsageError extends Error {}

export const USAGE = 'usage: node apps/daemon/src/review-web.ts [--config <daemon.config.json>] [--db <path>] [--instance-dir <dir>] [--port <N>] [--evidence-dir <dir>] [--policy-dir <dir>] [--evidence-root <dir> ...]';
const VALUE_FLAGS = ['config', 'db', 'instance-dir', 'port', 'host', 'evidence-dir', 'policy-dir', 'evidence-root'];

export interface ConfigDeps {
  env: Readonly<Record<string, string | undefined>>;
  readText(path: string): string | undefined;
}

export const realDeps: ConfigDeps = {
  env: process.env,
  readText: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
};

export function parseReviewWebArgs(argv: readonly string[], deps: ConfigDeps = realDeps): ReviewWebConfig {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument '${arg}'`);
    const name = arg.slice(2);
    if (!VALUE_FLAGS.includes(name)) throw new UsageError(`unknown option --${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    i += 1;
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  const one = (name: string): string | undefined => {
    const values = flags.get(name);
    if (values !== undefined && values.length > 1 && name !== 'evidence-root') throw new UsageError(`--${name} can be given once`);
    return values?.[0];
  };

  const instanceFlag = one('instance-dir');
  const envInstance = deps.env['AOT_INSTANCE_DIR'];
  const configPath = one('config') ?? deps.env['AOT_DAEMON_CONFIG'] ?? join(instanceFlag ?? envInstance ?? 'instance', 'daemon.config.json');
  const configText = deps.readText(configPath);
  if (configText === undefined && one('config') !== undefined) throw new UsageError(`--config ${configPath}: file not found`);
  let config: Record<string, unknown> = {};
  if (configText !== undefined) {
    try {
      const parsed = JSON.parse(configText) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      config = parsed as Record<string, unknown>;
    } catch (error) {
      throw new UsageError(`${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
  const dbFlag = one('db');
  const dbPath = dbFlag ?? str(config['db_path']);
  const instanceDir = instanceFlag ?? str(config['instance_dir']) ?? envInstance ?? (dbFlag === undefined ? 'instance' : dirname(dbFlag));
  if (dbPath === undefined) throw new UsageError('the database is unknown: give --db <path> or a daemon config with db_path');
  const registration = typeof config['registration_tools'] === 'object' && config['registration_tools'] !== null ? (config['registration_tools'] as Record<string, unknown>) : {};
  const portText = one('port');
  if (portText !== undefined && !/^\d{1,5}$/.test(portText)) throw new UsageError('--port must be a whole number from 0 to 65535');
  const port = portText === undefined ? 8787 : Number(portText);
  if (port > 65_535) throw new UsageError('--port must be a whole number from 0 to 65535');
  const host = one('host') ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new UsageError(`review-web listens only on 127.0.0.1 (got '${host}')`);
  return {
    dbPath, port, host,
    policyStoreDir: one('policy-dir') ?? str(config['policy_store_dir']) ?? join(instanceDir, 'policies'),
    evidenceDir: one('evidence-dir') ?? str(registration['evidence_dir']) ?? join(instanceDir, 'evidence'),
    evidenceRoots: flags.get('evidence-root') ?? [],
  };
}
