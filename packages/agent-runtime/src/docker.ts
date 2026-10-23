// docker CLI 호출 (단계 A5 U3, 스파이크 Q26 §5). 데몬은 `docker` CLI 를 `child_process.spawn` 으로 호출한다: 셸 없음, 인자 배열, 의존성 추가 없음.
//  - 실행 파일은 설정값의 절대 경로로 고정한다(PATH 탐색 금지). 환경 변수는 화이트리스트 이름만 넘긴다(`pickDockerEnv`).
//  - 프로세스 실행은 `ProcessPort` 로 주입한다: 시험은 가짜 포트를 넣고, 운영은 `nodeProcessPort` 를 쓴다.
//  - Docker 를 쓸 수 없으면 `DockerUnavailableError` 로 명시적으로 실패한다. 호스트 직접 실행으로 대체하는 경로는 없다 (스파이크 "남은 위험 2").
//  - 고아 정리: 컨테이너에 run 라벨과 인스턴스 라벨을 붙이고(container-args.ts), 데몬 시작 시 `aot.run` AND `aot.instance=<내 인스턴스>` 인 컨테이너만 죽이고 지운다
//    (`cleanupOrphanContainers`). 인스턴스 ID 없이 라벨 하나로 지우는 경로는 없다: 한 Docker 호스트의 다른 데몬 컨테이너를 지우지 않기 위해서다.
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { CONTAINER_LABEL_KEY, INSTANCE_LABEL_KEY, isValidInstanceId } from './container-args.ts';

/** 실행 중인 프로세스(장기 실행: `docker run -i`). Node 의 ChildProcess 를 감싼 최소 인터페이스라 시험에서 가짜로 바꾼다 */
export interface SpawnedProcess {
  writeStdin(text: string): void;
  endStdin(): void;
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  /** 프로세스와 입출력 스트림이 모두 닫혔을 때 */
  onClose(listener: (code: number | null, signal: string | null) => void): void;
  /** 시작 실패(ENOENT 등) */
  onError(listener: (error: Error) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export interface ExecResult {
  /** 종료 코드. 시작하지 못했거나 시간 초과·신호 종료면 null */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 시작 실패 문구(예: ENOENT). 없으면 undefined */
  spawnError?: string;
  timedOut: boolean;
}

export interface ProcessPort {
  spawn(file: string, args: readonly string[], options: { env: Readonly<Record<string, string>> }): SpawnedProcess;
  /** 짧은 명령을 끝까지 실행하고 출력을 모은다. 던지지 않는다 */
  exec(file: string, args: readonly string[], options: { env: Readonly<Record<string, string>>; timeoutMs: number }): Promise<ExecResult>;
}

const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;

export const nodeProcessPort: ProcessPort = {
  spawn(file, args, options) {
    const child = spawn(file, [...args], { env: { ...options.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    child.stdin.on('error', () => undefined); // EPIPE: 컨테이너가 이미 끝났다. 종료는 close 이벤트로 안다
    return {
      writeStdin: (text) => void child.stdin.write(text),
      endStdin: () => void child.stdin.end(),
      onStdout: (listener) => void child.stdout.on('data', listener),
      onStderr: (listener) => void child.stderr.on('data', listener),
      onClose: (listener) => void child.on('close', listener),
      onError: (listener) => void child.on('error', listener),
      kill: (signal) => void child.kill(signal),
    };
  },
  exec(file, args, options) {
    return new Promise<ExecResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let spawnError: string | undefined;
      let child;
      try {
        child = spawn(file, [...args], { env: { ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
      } catch (error) {
        resolve({ code: null, stdout, stderr, spawnError: error instanceof Error ? error.message : 'spawn failed', timedOut });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
      const collect = (current: string, chunk: Buffer): string => (current.length >= MAX_EXEC_OUTPUT_BYTES ? current : current + chunk.toString('utf8'));
      child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); });
      child.on('error', (error) => { spawnError = error.message; });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, ...(spawnError === undefined ? {} : { spawnError }), timedOut });
      });
    });
  },
};

/** docker CLI 에 넘겨도 되는 환경 변수 이름. 그 밖의 이름(특히 비밀·DB 경로)은 넘기지 않는다 */
export const DOCKER_ENV_WHITELIST: readonly string[] = [
  'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR',
];

/** 환경에서 화이트리스트 이름만 골라 새 객체를 만든다 */
export function pickDockerEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of DOCKER_ENV_WHITELIST) {
    const value = source[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

export interface DockerCliOptions {
  /** `docker` 실행 파일의 절대 경로. PATH 에서 찾지 않는다 */
  path: string;
  /** 화이트리스트 이름만 허용한다. 생략하면 빈 환경 */
  env?: Readonly<Record<string, string>>;
  process?: ProcessPort;
  /** 짧은 명령(kill·ps·rm·version)의 제한 시간. 기본 15초 */
  execTimeoutMs?: number;
}

export interface DockerCli {
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
  readonly process: ProcessPort;
  readonly execTimeoutMs: number;
}

export function createDockerCli(options: DockerCliOptions): DockerCli {
  if (typeof options.path !== 'string' || !isAbsolute(options.path) || /[\0\n\r]/.test(options.path)) {
    throw new Error('docker path must be an absolute path (it is never looked up on PATH)');
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (!DOCKER_ENV_WHITELIST.includes(name)) throw new Error(`environment variable '${name}' is not on the docker environment whitelist`);
    if (typeof value !== 'string') throw new Error(`environment variable '${name}' must be a string`);
    env[name] = value;
  }
  const timeout = options.execTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('execTimeoutMs must be a positive number');
  return { path: options.path, env: Object.freeze(env), process: options.process ?? nodeProcessPort, execTimeoutMs: timeout };
}

// ===== 가용성 =====

export type DockerUnavailableCode = 'docker_not_found' | 'docker_daemon_unreachable';

/** Docker 를 쓸 수 없다. 에이전트 업무를 실행하지 않는다(호스트에서 직접 실행하지 않는다) */
export class DockerUnavailableError extends Error {
  readonly code: DockerUnavailableCode;
  constructor(code: DockerUnavailableCode, detail: string) {
    super(`${code}: docker is unavailable, so agent work is not run (never falls back to running on the host): ${detail}`);
    this.name = 'DockerUnavailableError';
    this.code = code;
  }
}

/** `docker version` 으로 서버(엔진)가 응답하는지 확인한다. 쓸 수 없으면 `DockerUnavailableError`, 되면 서버 버전 문자열 */
export async function checkDockerAvailable(docker: DockerCli): Promise<string> {
  const result = await docker.process.exec(docker.path, ['version', '--format', '{{.Server.Version}}'], { env: docker.env, timeoutMs: docker.execTimeoutMs });
  if (result.spawnError !== undefined) throw new DockerUnavailableError('docker_not_found', result.spawnError.slice(0, 200));
  if (result.timedOut) throw new DockerUnavailableError('docker_daemon_unreachable', 'docker version timed out');
  const version = result.stdout.trim();
  if (result.code !== 0 || version === '') {
    throw new DockerUnavailableError('docker_daemon_unreachable', (result.stderr.trim() || `exit code ${String(result.code)}`).slice(0, 200));
  }
  return version;
}

// ===== 고아 정리 =====

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;

export interface OrphanCleanupResult {
  /** 라벨로 찾은 컨테이너 id */
  found: string[];
  /** `rm -f` 가 성공한 수 */
  removed: number;
  /** 실패 문구 (kill 의 "not running" 은 실패로 세지 않는다) */
  failures: string[];
}

/**
 * 이 인스턴스가 띄운 컨테이너(라벨 `aot.run` AND `aot.instance=<instance>`)를 모두 죽이고 지운다. 데몬 시작 시 부른다:
 * 데몬이 비정상 종료돼도 `docker run` CLI 가 죽을 뿐 컨테이너는 계속 돈다 (스파이크 §3).
 * `instance` 는 필수다 — 같은 Docker 호스트의 다른 데몬 인스턴스 컨테이너(다른 `aot.instance` 값, 또는 라벨 없음)는 건드리지 않는다.
 * `runId` 를 주면 그 run 의 컨테이너로 더 좁힌다(`aot.run=<runId>`).
 */
export async function cleanupOrphanContainers(options: { docker: DockerCli; instance: string; runId?: string }): Promise<OrphanCleanupResult> {
  const { docker, instance, runId } = options;
  if (!isValidInstanceId(instance)) throw new Error('instance must be a safe instance id (letters, digits, _ . -; max 63 chars)');
  if (runId !== undefined && !RUN_ID_PATTERN.test(runId)) throw new Error('runId must look like a run label value (letters, digits, _ . -)');
  const filters = ['--filter', runId === undefined ? `label=${CONTAINER_LABEL_KEY}` : `label=${CONTAINER_LABEL_KEY}=${runId}`, '--filter', `label=${INSTANCE_LABEL_KEY}=${instance}`];
  const run = (args: readonly string[]): Promise<ExecResult> => docker.process.exec(docker.path, args, { env: docker.env, timeoutMs: docker.execTimeoutMs });

  const listed = await run(['ps', '-aq', ...filters]);
  if (listed.spawnError !== undefined) throw new DockerUnavailableError('docker_not_found', listed.spawnError.slice(0, 200));
  if (listed.code !== 0) throw new DockerUnavailableError('docker_daemon_unreachable', (listed.stderr.trim() || `exit code ${String(listed.code)}`).slice(0, 200));
  const found = listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const bad = found.filter((id) => !CONTAINER_ID_PATTERN.test(id));
  if (bad.length > 0) throw new Error('docker ps returned something that is not a container id');
  const failures: string[] = [];
  if (found.length === 0) return { found, removed: 0, failures };

  const killed = await run(['kill', ...found]);
  if (killed.code !== 0 && !/is not running|No such container/i.test(killed.stderr)) failures.push(`kill: ${killed.stderr.trim().slice(0, 200) || `exit code ${String(killed.code)}`}`);
  const removed = await run(['rm', '-f', ...found]);
  // 그사이 `--rm` 이 먼저 지운 컨테이너("No such container")나 지우는 중인 컨테이너는 실패가 아니다
  const benign = /No such container|already in progress/i;
  const rmFailed = removed.code !== 0 && !removed.stderr.split('\n').filter((line) => line.trim() !== '').every((line) => benign.test(line));
  if (rmFailed) failures.push(`rm: ${removed.stderr.trim().slice(0, 200) || `exit code ${String(removed.code)}`}`);
  return { found, removed: rmFailed ? 0 : found.length, failures };
}
