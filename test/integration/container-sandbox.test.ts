// A5 U3: 컨테이너 샌드박스 OS 수준 시험 (스파이크 Q26 §1~§4, "남은 위험 1·4"). 실제 docker 로 가짜 에이전트 이미지(test/fixtures/container-agent)를 띄워 확인한다:
//  (a) 실행 중 `docker inspect` 의 Mounts 에 호스트 경로가 없다   (b) 가짜 instance 의 호스트 경로·docker 소켓 등이 컨테이너 안에서 ENOENT
//  (c) 외부 네트워크 연결 실패   (d) 도구 호출 왕복·허용 밖 도구 거부·result 수신(U2 게이트웨이)   (e) 멈춘 에이전트 + 시간 제한 → docker kill, 잔존 0
//  (f) 러너 프로세스가 SIGKILL 로 죽어 CLI 만 남은 경우 → 라벨 고아 정리로 잔존 0   (g) stdin EOF 를 무시하는 적대적 에이전트도 kill 로 종료
//  (h) 프레임이 아닌 출력·개행 없는 폭주 출력 → kill
// docker 가 없거나 이미지를 빌드할 수 없으면(오프라인) 전체를 skip 하고 이유를 출력한다. 시험이 만든 컨테이너는 라벨로 반드시 정리한다.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeClock, systemClock } from '@aot/domain';
import {
  checkDockerAvailable, cleanupOrphanContainers, createContainerRunner, createDockerCli, createToolGateway, DockerUnavailableError, toolCallConstraintsOf,
  validateAdapterOutput,
  type AdapterContext, type AdapterInput, type ContainerRunReport, type CostProgressEvent, type GatewayToolSpec, type JsonObject, type ToolExecutor,
} from '@aot/agent-runtime';

import { contractInput } from '../support/adapter-contract.ts';
import {
  dockerOut, inspectContainer, labeledContainers, makeFakeInstance, prepareSandbox, TEST_INSTANCE, uniqueRunId, waitUntilNoContainers, type SandboxEnvironment,
} from '../support/container-sandbox.ts';

const prepared = await prepareSandbox();
if (!prepared.ok) console.log(`[container-sandbox] SKIPPED: ${prepared.reason}`);
const skip = prepared.ok ? false : `container sandbox tests skipped: ${prepared.reason}`;
const sandbox = (prepared.ok ? prepared.env : null) as SandboxEnvironment;
if (prepared.ok) console.log(`[container-sandbox] docker ${prepared.env.dockerVersion}, test agent image ${prepared.env.imageId.slice(0, 19)}…`);

const LIMITS = { memoryMiB: 128, cpus: 0.5, pidsLimit: 32, tmpfsMiB: 16 };
const usedRunIds: string[] = [];

function newRunId(): string {
  const id = uniqueRunId();
  usedRunIds.push(id);
  return id;
}

function makeRunner(agentArgs: readonly string[], overrides: { maxOutputBytes?: number } = {}) {
  return createContainerRunner({
    docker: sandbox.docker, image: sandbox.imageId, instance: TEST_INSTANCE, limits: LIMITS, namePrefix: 'aot-test', clock: systemClock, agentArgs, ...overrides,
  });
}

function sandboxInput(runId: string): AdapterInput {
  const base = contractInput();
  return {
    ...base, run_id: runId,
    allowed_tools: [{ tool: 'echo', operations: ['echo'] }, { tool: 'fetch_url', operations: ['fetch'] }],
    budget: { max_usd: 2 },
  };
}

interface Gateway {
  context: AdapterContext;
  controller: AbortController;
  executed: { tool: string; args: JsonObject }[];
  agentCost: CostProgressEvent[];
  records(): { tool: string; outcome: string }[];
}

/** U2 게이트웨이(허용 도구 echo·fetch_url, 허용 정책)를 컨텍스트로 만든다. `onEcho` 는 echo 실행기 안에서 부른다 */
function makeGateway(input: AdapterInput, onEcho?: (args: JsonObject) => Promise<void>): Gateway {
  const controller = new AbortController();
  const executed: { tool: string; args: JsonObject }[] = [];
  const tools: GatewayToolSpec[] = [
    { tool: 'echo', operation: 'echo', scope: 'internal', sideEffect: false },
    { tool: 'fetch_url', operation: 'fetch', scope: 'internal', sideEffect: false, resultOrigin: 'external_untrusted' },
  ];
  const executors = new Map<string, ToolExecutor>([
    ['echo', async (request) => { executed.push({ tool: 'echo', args: request.args as JsonObject }); await onEcho?.(request.args as JsonObject); return { result: request.args as JsonObject }; }],
    ['fetch_url', (request) => { executed.push({ tool: 'fetch_url', args: request.args as JsonObject }); return Promise.resolve({ result: { status: 200 } }); }],
  ]);
  const gateway = createToolGateway({
    runId: input.run_id, subject: 'generalist@v1', tools, executors, policy: { judge: () => ({ decision: 'allow' }) },
    clock: new FakeClock('2026-10-22T00:00:00.000Z'), constraints: toolCallConstraintsOf(input), toolTimeoutMs: 10_000, signal: controller.signal,
  });
  const agentCost: CostProgressEvent[] = [];
  return {
    controller, executed, agentCost,
    context: { gateway, signal: controller.signal, onCostProgress: (event) => void agentCost.push(event) },
    records: () => gateway.records().map((r) => ({ tool: r.tool, outcome: r.outcome })),
  };
}

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const expectContract = (report: ContainerRunReport): void => {
  const checked = validateAdapterOutput(report.output);
  assert.ok(checked.ok, `output must satisfy the adapter contract: ${JSON.stringify(checked.ok ? [] : checked.errors)}`);
};

describe('container sandbox (OS level, real docker)', { skip }, () => {
  // 시험이 끝날 때마다 이 시험이 만든 컨테이너를 라벨로 정리한다(통과해도 실패해도)
  afterEach(async () => {
    for (const id of usedRunIds.splice(0)) {
      await cleanupOrphanContainers({ docker: sandbox.docker, instance: TEST_INSTANCE, runId: id });
    }
  });
  after(async () => {
    const left = await labeledContainers(sandbox.docker, 'aot.run');
    assert.deepEqual(left, [], 'no aot.run container is left behind by this file');
  });

  it('(a) a running container has no mounts and the hardened settings; (g) a hostile agent ignoring stdin EOF is still killed by docker kill', async () => {
    const runId = newRunId();
    const input = sandboxInput(runId);
    const runner = makeRunner(['hostile']);
    let inspected: Record<string, unknown> | null = null;
    const gw = makeGateway(input, async () => { inspected = await inspectContainer(sandbox.docker, runner.containerNameFor(runId)); });
    const running = runner.run(input, gw.context);
    await waitFor(() => inspected !== null, 'the agent to call its first tool while the container runs');
    gw.controller.abort();
    const report = await running;

    const info = inspected as unknown as { Mounts: unknown[]; HostConfig: Record<string, unknown>; Config: { Env: string[]; Labels: Record<string, string>; User: string } };
    // 마운트는 0개다: bind·volume 은 물론 tmpfs 도 Mounts 에 나타나지 않는다(작업 디렉터리는 HostConfig.Tmpfs 로만 선언된다)
    assert.deepEqual(info.Mounts, [], 'docker inspect Mounts is empty');
    assert.deepEqual(Object.keys(info.HostConfig['Tmpfs'] as object), ['/work'], 'the only filesystem added is the /work tmpfs');
    assert.ok([null, undefined].includes(info.HostConfig['Binds'] as null) || (info.HostConfig['Binds'] as unknown[]).length === 0, 'HostConfig.Binds is empty');
    assert.equal(info.HostConfig['NetworkMode'], 'none');
    assert.equal(info.HostConfig['ReadonlyRootfs'], true);
    assert.equal(info.HostConfig['Privileged'], false);
    assert.deepEqual(info.HostConfig['CapDrop'], ['ALL']);
    assert.ok([null, undefined].includes(info.HostConfig['CapAdd'] as null) || (info.HostConfig['CapAdd'] as unknown[]).length === 0);
    assert.ok((info.HostConfig['SecurityOpt'] as string[]).includes('no-new-privileges'));
    assert.equal(info.HostConfig['Memory'], LIMITS.memoryMiB * 1024 * 1024);
    assert.equal(info.HostConfig['MemorySwap'], LIMITS.memoryMiB * 1024 * 1024);
    assert.equal(info.HostConfig['PidsLimit'], LIMITS.pidsLimit);
    assert.equal(info.HostConfig['NanoCpus'], LIMITS.cpus * 1e9);
    assert.equal(info.HostConfig['IpcMode'], 'none');
    assert.equal((info.HostConfig['LogConfig'] as { Type: string }).Type, 'none');
    assert.equal(info.Config.User, '65532:65532');
    assert.equal(info.Config.Labels['aot.run'], runId);
    assert.ok(!info.Config.Env.some((entry) => /AOT|DB_|TOTP|SECRET|TOKEN|API_?KEY/i.test(entry)), `no secret-like environment variable: ${info.Config.Env.join(',')}`);

    // (g) 적대적 에이전트: stdin 을 닫아도 안 끝나므로 docker kill 로 끝났다
    expectContract(report);
    assert.equal(report.end, 'cancelled');
    assert.equal(report.output.status, 'cancelled');
    assert.equal(report.killed, true, 'docker kill succeeded');
    assert.equal(report.exitCode, 137);
    assert.deepEqual(await waitUntilNoContainers(sandbox.docker, `aot.run=${runId}`), []);
  });

  it('(b)(c) from inside: the fake instance, docker socket and host mounts do not exist (ENOENT) and no external network is reachable', async () => {
    const instance = await makeFakeInstance();
    try {
      const runId = newRunId();
      const input = sandboxInput(runId);
      const extra = ['/var/run/docker.sock', '/run/docker.sock', '/host_mnt', '/Users', '/Volumes', '/private', '/run/host-services', '/mnt/host'];
      const probed = [...instance.hostPaths, ...extra];
      const gw = makeGateway(input);
      const report = await makeRunner(['probe', ...probed]).run(input, gw.context);
      expectContract(report);
      assert.equal(report.end, 'result', `probe run ended with ${report.end}: ${JSON.stringify(report.output.error)} stderr=${report.stderr.slice(0, 300)}`);
      const probe = report.output.result as {
        uid: number; gid: number; seen: Record<string, string>; net: Record<string, string>;
        canary: Record<string, string>; writes: Record<string, string>; env_names: string[];
      };

      // 점검이 헛돌지 않음을 보이는 대조: 컨테이너 안의 자기 파일은 보이고, 작업 tmpfs 에는 쓸 수 있고, 루트는 읽기 전용이다
      assert.deepEqual(probe.canary, { agent_file: 'VISIBLE', work_dir: 'VISIBLE' });
      assert.equal(probe.writes['root_fs'], 'EROFS');
      assert.equal(probe.writes['work_tmpfs'], 'WRITABLE');
      assert.equal(probe.uid, 65532, 'not root');
      assert.equal(probe.gid, 65532);

      // (b) 호스트 경로는 하나도 보이지 않는다 (임시 디렉터리 자체, 가짜 instance 의 소켓·TOTP 비밀·DB·policies, docker 소켓, 파일 공유 경로)
      assert.deepEqual(Object.keys(probe.seen).sort(), [...probed].sort());
      for (const [path, code] of Object.entries(probe.seen)) assert.equal(code, 'ENOENT', `${path} must not exist in the container (got ${code})`);
      assert.ok(!probe.env_names.some((name) => /AOT|DB_|TOTP|SECRET|TOKEN|API_?KEY/i.test(name)), `environment: ${probe.env_names.join(',')}`);

      // (c) 외부 네트워크는 전부 실패한다 (DNS 해석 실패 또는 ENETUNREACH)
      for (const [target, code] of Object.entries(probe.net)) {
        assert.notEqual(code, 'CONNECTED', `${target} must not connect`);
        assert.notEqual(code, 'RESOLVED', `${target} must not resolve`);
        assert.match(code, /^(ENETUNREACH|EAI_AGAIN|ENOTFOUND)$/, `${target}: ${code}`);
      }
      assert.deepEqual(await waitUntilNoContainers(sandbox.docker, `aot.run=${runId}`), []);
    } finally {
      await instance.close();
    }
  });

  it('(d) round trip through the U2 gateway: allowed tools answered, a tool outside the list refused, start frame and result delivered', async () => {
    const runId = newRunId();
    const input = sandboxInput(runId);
    const gw = makeGateway(input);
    const report = await makeRunner(['roundtrip']).run(input, gw.context);
    expectContract(report);
    assert.equal(report.end, 'result', `ended with ${report.end}: ${JSON.stringify(report.output.error)} stderr=${report.stderr.slice(0, 300)}`);
    assert.equal(report.output.status, 'submitted');
    assert.deepEqual(report.output.result, {
      a: { text: 'hello' }, b_status: 200, c_error: 'tool_not_allowed',
      start: { run_id: runId, tools: ['echo', 'fetch_url'], max_usd: 2, objective: input.task_spec.objective },
    });
    assert.deepEqual(report.output.cost, { usd: 0.01 });
    assert.deepEqual(gw.agentCost, [{ cumulative: 0.005, unit: 'usd' }]);
    assert.deepEqual(gw.executed.map((e) => e.tool), ['echo', 'fetch_url'], 'the refused tool never reached an executor');
    assert.deepEqual(gw.records().map((r) => [r.tool, r.outcome]), [['echo', 'ok'], ['fetch_url', 'ok'], ['denied_tool', 'tool_not_allowed']]);
    assert.equal(report.exitCode, 0);
    assert.equal(report.toolCalls, 3);
    assert.deepEqual(await waitUntilNoContainers(sandbox.docker, `aot.run=${runId}`), []);
  });

  it('(e) a hung agent with a time limit is ended by docker kill (exit 137), and no container remains', async () => {
    const runId = newRunId();
    const input = sandboxInput(runId);
    const gw = makeGateway(input);
    const started = Date.now();
    const report = await makeRunner(['hang']).run(input, gw.context, { timeLimitMs: 4000 });
    const elapsed = Date.now() - started;
    expectContract(report);
    assert.equal(report.end, 'time_limit');
    assert.equal(report.output.status, 'cancelled');
    assert.equal(report.killed, true, 'docker kill found and killed the container');
    assert.equal(report.exitCode, 137);
    assert.ok(elapsed < 4000 + 8000, `the run ended promptly after the limit (${elapsed} ms)`);
    assert.deepEqual(await waitUntilNoContainers(sandbox.docker, `aot.run=${runId}`), []);
  });

  it('(f) if only the runner process is SIGKILLed the container survives; cleanupOrphanContainers then leaves none', async () => {
    const runId = newRunId();
    const worker = fork(fileURLToPath(new URL('./workers/container-run-worker.ts', import.meta.url)), [sandbox.docker.path, sandbox.imageId, runId], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the worker never reached its first tool call')), 30_000);
        worker.on('message', (message) => {
          if ((message as { type?: string }).type === 'tool-called') {
            clearTimeout(timer);
            resolve();
          }
        });
        worker.once('exit', (code) => reject(new Error(`worker exited early (${String(code)})`))); // 메시지 뒤의 reject 는 무시된다
      });
      const exited = new Promise((resolve) => worker.once('exit', resolve));
      worker.kill('SIGKILL');
      await exited;

      // 러너(데몬)는 죽었지만 컨테이너는 계속 돈다
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const survivors = await labeledContainers(sandbox.docker, `aot.run=${runId}`);
      assert.equal(survivors.length, 1, 'killing the CLI/daemon does not stop the container');
      const state = (await inspectContainer(sandbox.docker, survivors[0]!))['State'] as { Running: boolean };
      assert.equal(state.Running, true);

      const cleaned = await cleanupOrphanContainers({ docker: sandbox.docker, instance: TEST_INSTANCE, runId });
      assert.equal(cleaned.found.length, 1);
      assert.deepEqual(cleaned.failures, []);
      assert.deepEqual(await waitUntilNoContainers(sandbox.docker, `aot.run=${runId}`), []);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    }
  });

  it('(i) orphan cleanup is scoped to one daemon instance: another instance\'s running container and a container without an instance label survive; only this instance\'s container is removed', async () => {
    const [instanceA, instanceB] = ['aot-test-a', 'aot-test-b'];
    const [runA, runB, runLegacy] = [newRunId(), newRunId(), newRunId()];
    const runnerFor = (instance: string) => createContainerRunner({ docker: sandbox.docker, image: sandbox.imageId, instance, limits: LIMITS, namePrefix: 'aot-test', clock: systemClock, agentArgs: ['hostile'] });
    const controllers = { a: new AbortController(), b: new AbortController() };
    const hang = (controller: AbortController): AdapterContext => ({ gateway: { call: () => new Promise(() => undefined) }, signal: controller.signal, onCostProgress: () => undefined });
    const runningA = runnerFor(instanceA).run(sandboxInput(runA), hang(controllers.a));
    const runningB = runnerFor(instanceB).run(sandboxInput(runB), hang(controllers.b));
    // 라벨만 같은 "옛" 컨테이너: 인스턴스 라벨이 없다(이 변경 전에 만들어졌거나 다른 도구가 만든 것). aot.run 하나로 고르면 이것까지 지워진다
    await dockerOut(sandbox.docker, ['create', '--name', `aot-test-legacy-${runLegacy}`, '--label', `aot.run=${runLegacy}`, sandbox.imageId]);
    try {
      for (const id of [runA, runB]) {
        const deadline = Date.now() + 20_000;
        while ((await labeledContainers(sandbox.docker, `aot.run=${id}`)).length === 0) {
          if (Date.now() > deadline) assert.fail(`the container of ${id} never appeared`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      // 두 컨테이너의 라벨 확인
      const labelsOf = async (id: string) => ((await inspectContainer(sandbox.docker, (await labeledContainers(sandbox.docker, `aot.run=${id}`))[0]!))['Config'] as { Labels: Record<string, string> }).Labels;
      assert.equal((await labelsOf(runA))['aot.instance'], instanceA);
      assert.equal((await labelsOf(runB))['aot.instance'], instanceB);

      // 아무 컨테이너도 없는 인스턴스의 정리는 아무것도 지우지 않는다
      assert.deepEqual(await cleanupOrphanContainers({ docker: sandbox.docker, instance: TEST_INSTANCE }), { found: [], removed: 0, failures: [] });
      assert.equal((await labeledContainers(sandbox.docker, 'aot.run')).length, 3, 'all three are still there');

      const cleaned = await cleanupOrphanContainers({ docker: sandbox.docker, instance: instanceA });
      assert.equal(cleaned.found.length, 1);
      assert.deepEqual(cleaned.failures, []);
      assert.deepEqual(await waitUntilNoContainers(sandbox.docker, `aot.run=${runA}`), [], 'this instance\'s container is gone');
      const survivorB = await labeledContainers(sandbox.docker, `aot.run=${runB}`);
      assert.equal(survivorB.length, 1, 'the other instance\'s container survives');
      assert.equal(((await inspectContainer(sandbox.docker, survivorB[0]!))['State'] as { Running: boolean }).Running, true, 'and it is still running');
      assert.equal((await labeledContainers(sandbox.docker, `aot.run=${runLegacy}`)).length, 1, 'a container without an instance label is not touched either');
    } finally {
      controllers.a.abort(new Error('test over'));
      controllers.b.abort(new Error('test over'));
      await Promise.allSettled([runningA, runningB]);
      await cleanupOrphanContainers({ docker: sandbox.docker, instance: instanceA });
      await cleanupOrphanContainers({ docker: sandbox.docker, instance: instanceB });
      await dockerOut(sandbox.docker, ['rm', '-f', `aot-test-legacy-${runLegacy}`]).catch(() => undefined);
    }
    assert.deepEqual(await waitUntilNoContainers(sandbox.docker, 'aot.run'), []);
  });

  it('(h) output that is not a frame, or a flood without newlines, makes the runner kill the container at once', async () => {
    for (const [mode, violation] of [['garbage', 'frame_not_json'], ['flood', 'frame_too_large']] as const) {
      const runId = newRunId();
      const input = sandboxInput(runId);
      const gw = makeGateway(input);
      const report = await makeRunner([mode]).run(input, gw.context);
      expectContract(report);
      assert.equal(report.end, 'protocol_violation', `${mode}: ${JSON.stringify(report.output.error)}`);
      assert.equal(report.violation, violation);
      assert.equal(report.output.status, 'error');
      assert.equal(report.killed, true);
      assert.deepEqual(await waitUntilNoContainers(sandbox.docker, `aot.run=${runId}`), [], mode);
    }
  });

  it('refuses an image given by tag even though the test image has one', async () => {
    const tagged = await dockerOut(sandbox.docker, ['images', '--format', '{{.Repository}}:{{.Tag}}']);
    assert.ok(tagged.includes('aot-test-container-agent:'), 'the test image has a tag, which the runner still refuses to use');
    assert.throws(() => createContainerRunner({ docker: sandbox.docker, image: 'aot-test-container-agent:latest', instance: TEST_INSTANCE, limits: LIMITS, clock: systemClock }), /image_not_id/);
  });
});

// docker 가 있든 없든 도는 시험: 실행 파일이 없으면 명시적 오류이고, 에이전트 업무를 호스트에서 대신 실행하지 않는다 (실제 spawn 포트 사용)
describe('container sandbox without docker (real process port)', () => {
  it('a missing docker executable is an explicit error for the availability check and for a run, with nothing executed', async () => {
    const missing = createDockerCli({ path: join(tmpdir(), 'aot-no-such-dir', 'docker') });
    await assert.rejects(checkDockerAvailable(missing), (e: unknown) => e instanceof DockerUnavailableError && e.code === 'docker_not_found');
    const runner = createContainerRunner({ docker: missing, image: `sha256:${'a'.repeat(64)}`, instance: TEST_INSTANCE, limits: LIMITS, clock: systemClock, agentArgs: ['roundtrip'] });
    const input = sandboxInput('no-docker-1');
    const gw = makeGateway(input);
    const report = await runner.run(input, gw.context);
    expectContract(report);
    assert.equal(report.end, 'docker_unavailable');
    assert.equal(report.output.status, 'error');
    assert.equal(report.output.error?.code, 'docker_unavailable');
    assert.equal(gw.executed.length, 0);
  });
});
