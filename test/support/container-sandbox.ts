// 컨테이너 샌드박스 OS 수준 시험의 도우미 (test/integration/container-sandbox.test.ts). 실제 docker 를 쓴다.
//  - docker 를 찾는다: AOT_DOCKER_PATH 또는 PATH 의 `docker` (시험 편의일 뿐이다. 운영 코드는 PATH 를 찾지 않는다). 절대 경로로 바꿔 `createDockerCli` 에 준다.
//  - 가짜 에이전트 이미지(test/fixtures/container-agent)를 빌드해 이미지 ID(`sha256:…`)를 얻는다. 빌드할 수 없으면(오프라인 등) 이유를 돌려주고 시험은 skip 한다.
//  - macOS 전용 가정이 없다: 경로는 OS 임시 디렉터리에서 만들고, 컨테이너 안 경로 점검은 리눅스 컨테이너 기준이다.
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDockerAvailable, createDockerCli, pickDockerEnv, type DockerCli } from '@aot/agent-runtime';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/container-agent', import.meta.url));

/** 시험에서만 PATH 를 훑는다. 못 찾으면 null */
export function locateDocker(): string | null {
  const fromEnv = process.env['AOT_DOCKER_PATH'];
  if (fromEnv && isAbsolute(fromEnv) && existsSync(fromEnv)) return fromEnv;
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'docker');
    try {
      accessSync(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // 다음 후보
    }
  }
  return null;
}

export interface SandboxEnvironment {
  docker: DockerCli;
  dockerVersion: string;
  /** `sha256:…` 이미지 ID */
  imageId: string;
}

export type SandboxPreparation = { ok: true; env: SandboxEnvironment } | { ok: false; reason: string };

/** docker 가 있고 응답하면 CLI 를, 아니면 건너뛸 이유를 돌려준다 */
export async function prepareDocker(): Promise<{ ok: true; docker: DockerCli; dockerVersion: string } | { ok: false; reason: string }> {
  const path = locateDocker();
  if (path === null) return { ok: false, reason: 'docker CLI not found (set AOT_DOCKER_PATH or put docker on PATH)' };
  const docker = createDockerCli({ path, env: pickDockerEnv(process.env), execTimeoutMs: 30_000 });
  try {
    return { ok: true, docker, dockerVersion: await checkDockerAvailable(docker) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'docker is unavailable' };
  }
}

export interface ImageSource {
  /** 이미지 설명 (오류 문구와 태그 이름에 쓴다) */
  label: string;
  dockerfile: string;
  /** 빌드 컨텍스트 디렉터리 */
  context: string;
  /** 내용 해시에 넣는 파일들 (같은 내용이면 이미 빌드한 이미지를 재사용한다) */
  hashFiles: readonly string[];
}

/** 이미지를 빌드(또는 같은 내용의 기존 이미지를 재사용)해 이미지 ID 를 얻는다. 빌드할 수 없으면(오프라인 등) 이유를 돌려준다 */
export async function buildImage(docker: DockerCli, source: ImageSource): Promise<{ ok: true; imageId: string } | { ok: false; reason: string }> {
  const hash = createHash('sha256');
  for (const file of source.hashFiles) hash.update(readFileSync(file));
  const tag = `aot-test-${source.label}:${hash.digest('hex').slice(0, 12)}`;
  // 같은 내용으로 이미 빌드한 이미지가 있으면 재사용한다(태그에 내용 해시가 들어 있다)
  const existing = await docker.process.exec(docker.path, ['image', 'inspect', '--format', '{{.Id}}', tag], { env: docker.env, timeoutMs: docker.execTimeoutMs });
  if (existing.code === 0 && /^sha256:[0-9a-f]{64}$/.test(existing.stdout.trim())) return { ok: true, imageId: existing.stdout.trim() };
  const build = await docker.process.exec(docker.path, ['build', '-q', '-f', source.dockerfile, '-t', tag, source.context], { env: docker.env, timeoutMs: 600_000 });
  const imageId = build.stdout.trim().split('\n').pop() ?? '';
  if (build.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    const why = (build.stderr.trim().split('\n').find((line) => line.trim() !== '') ?? `exit code ${String(build.code)}`).slice(0, 200);
    return { ok: false, reason: `${source.label} image could not be built (offline or base image unavailable?): ${why}` };
  }
  return { ok: true, imageId };
}

/** docker 가 있고 응답하며 시험 이미지를 빌드할 수 있으면 환경을, 아니면 건너뛸 이유를 돌려준다 */
export async function prepareSandbox(): Promise<SandboxPreparation> {
  const ready = await prepareDocker();
  if (!ready.ok) return ready;
  const built = await buildImage(ready.docker, {
    label: 'container-agent',
    dockerfile: join(FIXTURE_DIR, 'Dockerfile'),
    context: FIXTURE_DIR,
    hashFiles: ['Dockerfile', 'agent.mjs'].map((file) => join(FIXTURE_DIR, file)),
  });
  if (!built.ok) return { ok: false, reason: `test agent ${built.reason}` };
  return { ok: true, env: { docker: ready.docker, dockerVersion: ready.dockerVersion, imageId: built.imageId } };
}

export async function dockerOut(docker: DockerCli, args: readonly string[]): Promise<string> {
  const result = await docker.process.exec(docker.path, args, { env: docker.env, timeoutMs: docker.execTimeoutMs });
  if (result.code !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout;
}

/** 라벨(`aot.run` 또는 `aot.run=<id>`)이 붙은 컨테이너 id (실행 중이 아니어도 포함) */
export async function labeledContainers(docker: DockerCli, label: string): Promise<string[]> {
  return (await dockerOut(docker, ['ps', '-aq', '--filter', `label=${label}`])).split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/** 컨테이너가 없어질 때까지 기다린다(`--rm` 제거가 늦을 수 있다). 끝내 남으면 남은 id 를 돌려준다 */
export async function waitUntilNoContainers(docker: DockerCli, label: string, timeoutMs = 10_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let left = await labeledContainers(docker, label);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = await labeledContainers(docker, label);
  }
  return left;
}

export async function inspectContainer(docker: DockerCli, name: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await dockerOut(docker, ['inspect', name])) as Record<string, unknown>[];
  if (parsed.length !== 1) throw new Error(`docker inspect ${name} returned ${parsed.length} entries`);
  return parsed[0]!;
}

export const uniqueRunId = (): string => `sbx-${randomUUID().slice(0, 8)}`;

// ===== 가짜 instance =====

export interface FakeInstance {
  root: string;
  /** 컨테이너 안에서 보이면 안 되는 호스트 절대 경로들 */
  hostPaths: string[];
  close(): Promise<void>;
}

/**
 * 임시 디렉터리에 실제 모양의 가짜 instance 를 만든다: `instance/run/approval.sock`(듣고 있는 소켓), `instance/totp/owner.secret`, `instance/aot.db`, `policies/`.
 * 비밀값은 가짜 문자열이다. 컨테이너에 마운트하지 않는 한 어느 것도 컨테이너 안에서 보이면 안 된다.
 */
export async function makeFakeInstance(): Promise<FakeInstance> {
  const root = mkdtempSync(join(tmpdir(), 'aot-sbx-'));
  const instance = join(root, 'instance');
  mkdirSync(join(instance, 'run'), { recursive: true, mode: 0o700 });
  mkdirSync(join(instance, 'totp'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'policies'), { recursive: true });
  writeFileSync(join(instance, 'totp', 'owner.secret'), 'FAKE-TOTP-SECRET-NOT-REAL\n', { mode: 0o600 });
  writeFileSync(join(instance, 'aot.db'), 'not a real database\n', { mode: 0o600 });
  writeFileSync(join(root, 'policies', 'default.yaml'), 'version: 1\n');
  const socketPath = join(instance, 'run', 'approval.sock');
  let server: Server | null = createServer((socket) => socket.end('fake approval engine\n'));
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once('error', rejectListen);
      server!.listen(socketPath, resolveListen);
    });
  } catch {
    // 소켓 경로가 너무 길면 일반 파일로 대신한다(경로 존재 점검에는 같다)
    server = null;
    writeFileSync(socketPath, '');
  }
  const hostPaths = [
    root, instance, socketPath, join(instance, 'run'), join(instance, 'totp'), join(instance, 'totp', 'owner.secret'),
    join(instance, 'aot.db'), join(root, 'policies'), join(root, 'policies', 'default.yaml'), tmpdir(),
  ];
  return {
    root, hostPaths,
    async close() {
      if (server !== null) await new Promise<void>((done) => server!.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
