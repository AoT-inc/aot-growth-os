// A5 U3: 컨테이너 러너 (가짜 docker 포트). 프레임 처리, 형식 오류·크기 초과 시 `docker kill`, 취소·시간 제한 시 `docker kill`(CLI 프로세스만 죽이지 않음),
// CLI 만 죽은 경우의 정리, Docker 없음 처리, 환경 변수 화이트리스트, 고아 정리. 실제 docker 를 쓰는 시험은 test/integration/container-sandbox.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeClock } from '@aot/domain';
import {
  buildContainerArgs, checkDockerAvailable, cleanupOrphanContainers, createContainerRunner, createDockerCli, createLineReader, DOCKER_ENV_WHITELIST,
  DockerUnavailableError, encodeFrame, MAX_FRAME_BYTES, parseFrame, pickDockerEnv, startFrameOf, validateAdapterOutput,
  type AdapterContext, type AdapterInput, type ContainerRunner, type ContainerRunnerOptions, type ContainerRunReport, type CostProgressEvent,
  type JsonObject, type ToolGateway, type ToolGatewayResponse,
} from '@aot/agent-runtime';

import { contractInput } from '../support/adapter-contract.ts';
import { FakeDocker, tick, until, type FakeProcess } from '../support/fake-docker.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';

const IMAGE = `sha256:${'cd34'.repeat(16)}`;
const DOCKER_PATH = '/opt/example/bin/docker';
const INSTANCE = 'inst-1';
const LIMITS = { memoryMiB: 128, cpus: 0.5, pidsLimit: 32, tmpfsMiB: 16 };
const AT = '2026-10-22T00:00:00.000Z';
const NAME = 'aot-run-run-contract-1';
const RESULT_FRAME = {
  type: 'result', status: 'submitted', result: { summary: 'done' }, evidence: [{ kind: 'source_url', ref: 'https://example.com/', captured_at: AT }],
  run_log: [{ at: AT, message: 'agent finished' }], cost: { usd: 0.03 },
};

interface Harness {
  docker: FakeDocker;
  timers: ManualGatewayTimers;
  runner: ContainerRunner;
  calls: { tool: string; args: JsonObject }[];
  progress: CostProgressEvent[];
  controller: AbortController;
  gateway: { respond: (tool: string, args: JsonObject) => Promise<ToolGatewayResponse> };
  /** 비용 진행 콜백의 행동을 바꾼다 */
  costHook: { throws: boolean };
  input: AdapterInput;
  start(options?: { timeLimitMs?: number; input?: AdapterInput }): Promise<{ done: Promise<ContainerRunReport>; proc: FakeProcess }>;
}

function harness(overrides: Partial<ContainerRunnerOptions> = {}, dockerEnv: Record<string, string> = { HOME: '/home/example' }): Harness {
  const docker = new FakeDocker();
  const timers = new ManualGatewayTimers();
  const runner = createContainerRunner({
    docker: createDockerCli({ path: DOCKER_PATH, env: dockerEnv, process: docker }),
    image: IMAGE, instance: INSTANCE, limits: LIMITS, clock: new FakeClock(AT), timers, ...overrides,
  });
  const calls: { tool: string; args: JsonObject }[] = [];
  const gateway: Harness['gateway'] = { respond: (tool): Promise<ToolGatewayResponse> => Promise.resolve(tool === 'example_search' ? { ok: true, result: { echo: tool } } : { ok: false, error: 'tool_not_allowed' }) };
  const toolGateway: ToolGateway = { call: (tool, args) => { calls.push({ tool, args }); return gateway.respond(tool, args); } };
  const progress: CostProgressEvent[] = [];
  const controller = new AbortController();
  const costHook = { throws: false };
  const context: AdapterContext = {
    gateway: toolGateway, signal: controller.signal,
    onCostProgress: (event) => {
      progress.push(event);
      if (costHook.throws) throw new Error('cost callback failed');
    },
  };
  const h: Harness = {
    docker, timers, runner, calls, progress, controller, gateway, costHook, input: contractInput(),
    async start(options = {}) {
      const done = runner.run(options.input ?? h.input, context, options.timeLimitMs === undefined ? {} : { timeLimitMs: options.timeLimitMs });
      await until(() => docker.spawned.length > 0, 'spawn');
      return { done, proc: docker.last()!.proc };
    },
  };
  return h;
}

const killCalls = (docker: FakeDocker): string[][] => docker.execsOf('kill').map((e) => [...e.args]);
const expectValid = (report: ContainerRunReport): void => {
  const checked = validateAdapterOutput(report.output);
  assert.ok(checked.ok, `output must satisfy the adapter contract: ${JSON.stringify(checked.ok ? [] : checked.errors)}`);
};

describe('container runner: frames and the gateway', () => {
  it('spawns docker by absolute path with a whitelisted environment and the template arguments, then sends the start frame first', async () => {
    const h = harness();
    const { done, proc } = await h.start();
    const [spawned] = h.docker.spawned;
    assert.equal(spawned!.file, DOCKER_PATH);
    assert.deepEqual(spawned!.env, { HOME: '/home/example' });
    assert.deepEqual(spawned!.args, buildContainerArgs({ image: IMAGE, name: NAME, runId: 'run-contract-1', instance: INSTANCE, limits: LIMITS }));
    assert.ok(!spawned!.args.some((arg) => arg === '-v' || arg === '--mount' || arg === '--volume' || arg === '--env' || arg === '-e'));
    const [first] = proc.frames();
    assert.equal(first!['type'], 'start');
    assert.equal(first!['run_id'], 'run-contract-1');
    assert.deepEqual(first!['allowed_tools'], [{ tool: 'example_search', operations: ['search'] }]);
    assert.deepEqual(first!['budget'], { max_usd: 2 });
    assert.equal((first!['task_spec'] as JsonObject)['objective'], h.input.task_spec.objective);
    proc.sendFrame(RESULT_FRAME);
    proc.emitClose(0);
    await done;
  });

  it('answers tool_call frames through the gateway (ok and refusal), handles frames split across chunks and many frames in one chunk', async () => {
    const h = harness();
    const { done, proc } = await h.start();
    const call1 = JSON.stringify({ type: 'tool_call', id: 1, tool: 'example_search', args: { query: 'q' } });
    proc.emitStdout(call1.slice(0, 20));
    proc.emitStdout(`${call1.slice(20)}\n${JSON.stringify({ type: 'tool_call', id: 2, tool: 'denied_tool', args: {} })}\n`);
    await until(() => proc.frames().length === 3, 'two tool results');
    const [, r1, r2] = proc.frames();
    assert.deepEqual(r1, { type: 'tool_result', id: 1, result: { echo: 'example_search' } });
    assert.deepEqual(r2, { type: 'tool_result', id: 2, error: 'tool_not_allowed' });
    assert.deepEqual(h.calls.map((c) => c.tool), ['example_search', 'denied_tool']);
    proc.sendFrame(RESULT_FRAME);
    proc.emitClose(0);
    const report = await done;
    assert.equal(report.toolCalls, 2);
  });

  it('a gateway that throws becomes an error code for the agent, not a crash', async () => {
    const h = harness();
    h.gateway.respond = () => Promise.reject(new Error('boom'));
    const { done, proc } = await h.start();
    proc.sendFrame({ type: 'tool_call', id: 7, tool: 'example_search', args: {} });
    await until(() => proc.frames().length === 2, 'tool result');
    assert.deepEqual(proc.frames()[1], { type: 'tool_result', id: 7, error: 'gateway_error' });
    proc.sendFrame(RESULT_FRAME);
    proc.emitClose(0);
    await done;
  });

  it('passes cost_progress to the callback and returns the result frame as a contract output after the container exits', async () => {
    const h = harness();
    const { done, proc } = await h.start();
    proc.sendFrame({ type: 'cost_progress', cumulative: 0.01, unit: 'usd' });
    proc.sendFrame({ type: 'cost_progress', cumulative: 0.02, unit: 'usd' });
    proc.sendFrame(RESULT_FRAME);
    await until(() => proc.stdinEnded, 'stdin closed after the result');
    assert.deepEqual(h.progress, [{ cumulative: 0.01, unit: 'usd' }, { cumulative: 0.02, unit: 'usd' }]);
    proc.emitClose(0);
    const report = await done;
    expectValid(report);
    assert.equal(report.end, 'result');
    assert.equal(report.output.status, 'submitted');
    assert.deepEqual(report.output.result, { summary: 'done' });
    assert.deepEqual(report.output.cost, { usd: 0.03 });
    assert.ok(!('type' in report.output));
    assert.ok(report.output.run_log.some((entry) => entry.message === 'agent finished'));
    assert.equal(report.exitCode, 0);
    assert.equal(killCalls(h.docker).length, 0, 'a container that exits by itself is not killed');
    assert.equal(h.docker.execsOf('rm').length, 1, 'a leftover is removed by name afterwards');
  });

  it('kills a container that does not exit after its result, once the grace period has passed', async () => {
    const h = harness({ exitGraceMs: 5000 });
    const { done, proc } = await h.start();
    proc.sendFrame(RESULT_FRAME);
    await until(() => proc.stdinEnded, 'stdin closed');
    await tick();
    assert.equal(killCalls(h.docker).length, 0);
    h.timers.advance(5000);
    await until(() => killCalls(h.docker).length === 1, 'docker kill');
    assert.deepEqual(killCalls(h.docker)[0], ['kill', NAME]);
    const report = await done;
    assert.equal(report.end, 'result');
    assert.equal(report.killed, true);
  });

  it('survives a cost callback that throws: later frames are still handled', async () => {
    const h = harness();
    h.costHook.throws = true;
    const { done, proc } = await h.start();
    proc.sendFrame({ type: 'cost_progress', cumulative: 0.01, unit: 'usd' });
    proc.sendFrame({ type: 'tool_call', id: 1, tool: 'example_search', args: {} });
    await until(() => proc.frames().length === 2, 'tool result after the failing callback');
    proc.sendFrame(RESULT_FRAME);
    proc.emitClose(0);
    assert.equal((await done).end, 'result');
  });

  it('keeps task_spec values out of the docker arguments entirely', async () => {
    const plain = harness();
    const first = await plain.start();
    first.proc.sendFrame(RESULT_FRAME);
    first.proc.emitClose(0);
    await first.done;

    const hostile = harness();
    const input = contractInput();
    const evil = { ...input, task_spec: { ...input.task_spec, objective: '--privileged -v /:/host --network host', acceptance_criteria: ['--cap-add=ALL', '$(rm -rf /)'] }, evidence_refs: ['-v/etc:/etc', '--env=A=b'] };
    const second = await hostile.start({ input: evil });
    assert.deepEqual(hostile.docker.spawned[0]!.args, plain.docker.spawned[0]!.args, 'the arguments do not depend on the task at all');
    assert.ok(second.proc.frames()[0]!['task_spec'] && JSON.stringify(second.proc.frames()[0]).includes('--privileged'), 'the task input travels only in the start frame');
    second.proc.sendFrame(RESULT_FRAME);
    second.proc.emitClose(0);
    await second.done;
  });
});

describe('container runner: protocol violations kill the container', () => {
  const longValue = 'x'.repeat(MAX_FRAME_BYTES + 10);
  const cases: [string, string, string][] = [
    ['not JSON', 'this is not a frame\n', 'frame_not_json'],
    ['an empty line', '\n', 'frame_empty'],
    ['a JSON array', '[1,2]\n', 'frame_not_object'],
    ['an unknown type', '{"type":"shell","cmd":"ls"}\n', 'frame_unknown_type'],
    ['a tool_result from the agent (wrong direction)', '{"type":"tool_result","id":1,"result":1}\n', 'frame_unexpected_direction'],
    ['a start frame from the agent (wrong direction)', '{"type":"start","run_id":"x"}\n', 'frame_unexpected_direction'],
    ['a malformed tool_call', '{"type":"tool_call","id":0,"tool":"x","args":{}}\n', 'frame_invalid_frame'],
    ['a malformed result', '{"type":"result","status":"submitted"}\n', 'frame_invalid_frame'],
    ['a carriage return inside the line', '{"type":"cost_progress","cumulative":1,"unit":"usd"}\r\n', 'frame_multiple_lines'],
    ['a complete line over the size limit', `${longValue}\n`, 'frame_too_large'],
  ];

  for (const [label, line, code] of cases) {
    it(`kills the container by name on ${label} and reports a violation`, async () => {
      const h = harness();
      const { done, proc } = await h.start();
      // 위반 뒤에 따라오는 프레임은 처리되지 않아야 한다
      proc.emitStdout(`${line}${JSON.stringify({ type: 'tool_call', id: 1, tool: 'example_search', args: {} })}\n`);
      const report = await done;
      expectValid(report);
      assert.equal(report.end, 'protocol_violation');
      assert.equal(report.violation, code);
      assert.equal(report.output.status, 'error');
      assert.equal(report.output.error?.code, 'protocol_violation');
      assert.deepEqual(killCalls(h.docker), [['kill', NAME]], 'docker kill <name>, not just the CLI process');
      assert.deepEqual(proc.signals, [], 'the docker CLI process itself is not what gets killed');
      assert.equal(h.calls.length, 0, 'frames after the violation are never handled');
      assert.equal(report.killed, true);
    });
  }

  it('cuts an over-long line before its newline: the accumulated bytes alone trigger the kill, and no newline ever arrives', async () => {
    const h = harness();
    const { done, proc } = await h.start();
    const chunk = Buffer.alloc(256 * 1024, 0x78);
    for (let i = 0; i < 4; i += 1) proc.emitStdout(chunk); // 1 MiB: 아직 상한 이하
    assert.equal(killCalls(h.docker).length, 0);
    proc.emitStdout(Buffer.from('x'.repeat(10)));
    const report = await done;
    assert.equal(report.violation, 'frame_too_large');
    assert.deepEqual(killCalls(h.docker), [['kill', NAME]]);
  });

  it('kills when the container writes more than the total output limit, even in valid frames', async () => {
    const h = harness({ maxOutputBytes: 400 });
    const { done, proc } = await h.start();
    for (let i = 0; i < 20 && !proc.closed; i += 1) proc.sendFrame({ type: 'cost_progress', cumulative: i, unit: 'usd' });
    const report = await done;
    assert.equal(report.violation, 'output_limit');
    assert.deepEqual(killCalls(h.docker), [['kill', NAME]]);
  });

  it('kills on a duplicate in-flight tool_call id and on too many calls in flight', async () => {
    const dup = harness();
    dup.gateway.respond = () => new Promise(() => undefined);
    const a = await dup.start();
    a.proc.sendFrame({ type: 'tool_call', id: 1, tool: 'example_search', args: {} });
    a.proc.sendFrame({ type: 'tool_call', id: 1, tool: 'example_search', args: {} });
    assert.equal((await a.done).violation, 'duplicate_tool_call_id');

    const many = harness({ maxInFlightToolCalls: 2 });
    many.gateway.respond = () => new Promise(() => undefined);
    const b = await many.start();
    for (let id = 1; id <= 3; id += 1) b.proc.sendFrame({ type: 'tool_call', id, tool: 'example_search', args: {} });
    assert.equal((await b.done).violation, 'too_many_tool_calls');
  });

  it('does not write a tool_result once the run has ended', async () => {
    const h = harness();
    let release!: (response: ToolGatewayResponse) => void;
    h.gateway.respond = () => new Promise((resolve) => { release = resolve; });
    const { done, proc } = await h.start();
    proc.sendFrame({ type: 'tool_call', id: 1, tool: 'example_search', args: {} });
    await until(() => h.calls.length === 1, 'gateway call');
    proc.emitStdout('garbage\n');
    await done;
    release({ ok: true, result: 1 });
    await tick();
    assert.equal(proc.frames().length, 1, 'only the start frame was written');
  });
});

describe('container runner: cancellation and time limit use docker kill', () => {
  it('abort => docker kill <name> (not only the CLI), status cancelled, last reported cost kept', async () => {
    const h = harness();
    const { done, proc } = await h.start();
    proc.sendFrame({ type: 'cost_progress', cumulative: 0.04, unit: 'usd' });
    h.controller.abort();
    const report = await done;
    expectValid(report);
    assert.equal(report.end, 'cancelled');
    assert.equal(report.output.status, 'cancelled');
    assert.deepEqual(report.output.cost, { usd: 0.04 });
    assert.deepEqual(killCalls(h.docker), [['kill', NAME]]);
    assert.deepEqual(proc.signals, [], 'the CLI process was not signalled; the container was killed');
    assert.equal(proc.stdinEnded, false, 'killed at once: stdin is not closed first, which would let a cooperative agent exit before the kill');
    assert.equal(report.killed, true);
    assert.equal(report.exitCode, 137);
  });

  it('abort before the start does not spawn anything', async () => {
    const h = harness();
    h.controller.abort();
    const report = await h.runner.run(h.input, { gateway: { call: () => Promise.reject(new Error('no')) }, signal: h.controller.signal, onCostProgress: () => undefined });
    expectValid(report);
    assert.equal(report.output.status, 'cancelled');
    assert.equal(h.docker.spawned.length, 0);
    assert.equal(h.docker.execs.length, 0);
  });

  it('time limit => docker kill, status cancelled, end time_limit; the timer is gone afterwards', async () => {
    const h = harness();
    const { done, proc } = await h.start({ timeLimitMs: 30_000 });
    h.timers.advance(29_999);
    await tick();
    assert.equal(killCalls(h.docker).length, 0);
    h.timers.advance(1);
    const report = await done;
    expectValid(report);
    assert.equal(report.end, 'time_limit');
    assert.equal(report.output.status, 'cancelled');
    assert.deepEqual(killCalls(h.docker), [['kill', NAME]]);
    assert.deepEqual(proc.signals, []);
    assert.equal(h.timers.pending, 0);
  });

  it('a finished run cancels the time limit timer and ignores a later abort', async () => {
    const h = harness();
    const { done, proc } = await h.start({ timeLimitMs: 60_000 });
    proc.sendFrame(RESULT_FRAME);
    proc.emitClose(0);
    await done;
    h.controller.abort();
    h.timers.advance(60_000);
    await tick();
    assert.equal(killCalls(h.docker).length, 0);
    assert.equal(h.timers.pending, 0);
  });

  it('retries docker kill while the CLI is alive but the container does not exist yet', async () => {
    const h = harness({ killRetryMs: 100 });
    let attempts = 0;
    const normal = h.docker.script;
    h.docker.script = (record, docker) => {
      if (record.args[0] === 'kill' && ++attempts < 3) return { code: 1, stderr: 'Error response from daemon: No such container' };
      return normal(record, docker);
    };
    const { done } = await h.start();
    h.controller.abort();
    await until(() => attempts === 1, 'first kill attempt');
    h.timers.advance(100);
    await until(() => attempts === 2, 'second kill attempt');
    h.timers.advance(100);
    const report = await done;
    assert.equal(attempts, 3);
    assert.equal(report.killed, true);
  });

  it('falls back to killing the CLI process only after the container kill, if the CLI will not close', async () => {
    const h = harness({ closeGraceMs: 2000 });
    h.docker.script = (record) => (record.args[0] === 'kill' ? { code: 0 } : { code: 1, stderr: 'No such container' });
    const { done, proc } = await h.start();
    h.controller.abort();
    await until(() => killCalls(h.docker).length === 1, 'docker kill');
    await tick();
    assert.deepEqual(proc.signals, []);
    h.timers.advance(2000);
    const report = await done;
    assert.deepEqual(proc.signals, ['SIGKILL']);
    assert.equal(report.end, 'cancelled');
    assert.ok(report.output.run_log.some((entry) => /CLI process had to be killed/.test(entry.message)));
  });

  it('gives up retrying a failing docker kill once the CLI is gone, and still removes by name', async () => {
    const h = harness({ killRetryMs: 100 });
    h.docker.script = (record) => (record.args[0] === 'kill' ? { code: 1, stderr: 'No such container' } : { code: 0 });
    const { done, proc } = await h.start();
    h.controller.abort();
    await until(() => killCalls(h.docker).length === 1, 'first kill attempt');
    proc.emitClose(1);
    const report = await done;
    assert.equal(report.killed, false);
    assert.equal(h.docker.execsOf('rm').length, 1);
  });
});

describe('container runner: the CLI dies on its own (orphan risk)', () => {
  it('a CLI killed by a signal without a result => error output and `docker rm -f <name>` so no container is left', async () => {
    const h = harness();
    const { done, proc } = await h.start();
    proc.emitClose(null, 'SIGKILL');
    const report = await done;
    expectValid(report);
    assert.equal(report.end, 'agent_exited');
    assert.equal(report.output.status, 'error');
    assert.equal(report.output.error?.code, 'agent_exited');
    assert.deepEqual(h.docker.execsOf('rm').map((e) => [...e.args]), [['rm', '-f', NAME]]);
  });

  it('a container that exits without a result is an error; docker run failures (125) are reported as start failures', async () => {
    const a = harness();
    const first = await a.start();
    first.proc.emitClose(3);
    assert.equal((await first.done).output.error?.code, 'agent_exited');
    const b = harness();
    const second = await b.start();
    second.proc.emitStderr('docker: Error response from daemon: pull access denied\n');
    second.proc.emitClose(125);
    const report = await second.done;
    assert.equal(report.output.error?.code, 'container_start_failed');
    assert.match(report.stderr, /pull access denied/);
  });
});

describe('container runner: no Docker, no run', () => {
  it('a spawn that throws => docker_unavailable error; nothing is executed on the host', async () => {
    const h = harness();
    h.docker.spawnThrows = new Error('spawn docker ENOENT');
    const report = await h.runner.run(h.input, { gateway: { call: () => Promise.reject(new Error('no')) }, signal: h.controller.signal, onCostProgress: () => undefined });
    expectValid(report);
    assert.equal(report.end, 'docker_unavailable');
    assert.equal(report.output.status, 'error');
    assert.equal(report.output.error?.code, 'docker_unavailable');
    assert.match(report.output.error?.message ?? '', /not run on the host/);
    assert.equal(h.docker.spawned.length, 0);
  });

  it('an async spawn error (ENOENT) => docker_unavailable, and the run is not retried another way', async () => {
    const h = harness();
    const { done, proc } = await h.start();
    proc.emitError(new Error('spawn /opt/example/bin/docker ENOENT'));
    const report = await done;
    expectValid(report);
    assert.equal(report.end, 'docker_unavailable');
    assert.equal(h.docker.spawned.length, 1, 'no second attempt');
  });

  it('checkDockerAvailable returns the engine version, and throws DockerUnavailableError otherwise', async () => {
    const make = (partial: Record<string, unknown>) => {
      const docker = new FakeDocker();
      docker.script = () => partial;
      return createDockerCli({ path: DOCKER_PATH, process: docker });
    };
    assert.equal(await checkDockerAvailable(make({ code: 0, stdout: '29.6.2\n' })), '29.6.2');
    await assert.rejects(checkDockerAvailable(make({ code: null, spawnError: 'spawn ENOENT' })), (e: unknown) => e instanceof DockerUnavailableError && e.code === 'docker_not_found' && /never falls back/.test(e.message));
    await assert.rejects(checkDockerAvailable(make({ code: 1, stderr: 'Cannot connect to the Docker daemon' })), (e: unknown) => e instanceof DockerUnavailableError && e.code === 'docker_daemon_unreachable');
    await assert.rejects(checkDockerAvailable(make({ code: null, timedOut: true })), (e: unknown) => e instanceof DockerUnavailableError && e.code === 'docker_daemon_unreachable');
    await assert.rejects(checkDockerAvailable(make({ code: 0, stdout: '' })), DockerUnavailableError);
  });

  it('refuses a docker path that is not absolute, so PATH is never searched', () => {
    for (const path of ['docker', './docker', '', '../bin/docker']) assert.throws(() => createDockerCli({ path }), /absolute/);
  });
});

describe('container runner: start frame and secrets', () => {
  it('refuses to start when the input carries a secret-looking value, and spawns nothing', async () => {
    const h = harness();
    const input = contractInput();
    const key = ['sk', 'start', 'z'.repeat(24)].join('-');
    const withKey = { ...input, task_spec: { ...input.task_spec, objective: `use ${key} to log in` } };
    const report = await h.runner.run(withKey, { gateway: { call: () => Promise.reject(new Error('no')) }, signal: h.controller.signal, onCostProgress: () => undefined });
    expectValid(report);
    assert.equal(report.end, 'start_rejected');
    assert.equal(h.docker.spawned.length, 0);
    assert.ok(!JSON.stringify(report).includes(key), 'the secret is not echoed back');
  });

  it('startFrameOf: valid input becomes a start frame that only the container may receive; a secret key name is refused', () => {
    const ok = startFrameOf(contractInput());
    assert.ok(ok.ok);
    const line = encodeFrame(ok.ok ? ok.frame : null);
    assert.ok(line.ok);
    assert.ok(parseFrame(line.ok ? line.line : '', 'host_to_agent').ok);
    assert.equal(parseFrame(line.ok ? line.line : '', 'agent_to_host').ok, false, 'the host never accepts a start frame from the agent');
    const input = contractInput();
    const withSecretKey = { ...input, task_spec: { ...input.task_spec, api_key: 'abc' } as unknown as typeof input.task_spec };
    const refused = startFrameOf(withSecretKey);
    assert.equal(refused.ok, false);
  });

  it('parseFrame rejects a start frame with bad fields', () => {
    const base = { type: 'start', run_id: 'r', task_spec: {}, allowed_tools: [], evidence_refs: [], budget: { max_usd: 1 } };
    assert.ok(parseFrame(JSON.stringify(base), 'host_to_agent').ok);
    for (const patch of [{ run_id: '' }, { task_spec: [] }, { allowed_tools: [{ tool: 'x' }] }, { evidence_refs: [1] }, { budget: { max_usd: -1 } }, { budget: {} }, { time_limit_ms: 0 }, { extra: 1 }]) {
      assert.equal(parseFrame(JSON.stringify({ ...base, ...patch }), 'host_to_agent').ok, false, JSON.stringify(patch));
    }
  });

  it('collects the container stderr as a masked, capped log and never as frames', async () => {
    const h = harness({ maxStderrBytes: 100 });
    const { done, proc } = await h.start();
    const key = ['sk', 'log', 'q'.repeat(24)].join('-');
    proc.emitStderr(`loaded key ${key}\n`);
    proc.emitStderr('y'.repeat(500));
    proc.sendFrame(RESULT_FRAME);
    proc.emitClose(0);
    const report = await done;
    assert.equal(report.stderrTruncated, true);
    assert.ok(report.stderr.length <= 100 + 20);
    assert.ok(!report.stderr.includes(key));
    assert.match(report.stderr, /\[REDACTED\]/);
    assert.equal(report.end, 'result');
  });
});

describe('docker environment whitelist', () => {
  it('passes only whitelisted names and refuses anything else, so no secret or DB path can ride along', () => {
    const source = { HOME: '/home/example', DOCKER_HOST: 'unix:///var/run/docker.sock', PATH: '/usr/bin', AOT_DB_PATH: '/x/aot.db', API_KEY: 'k', TOTP_SECRET: 's' };
    assert.deepEqual(pickDockerEnv(source), { HOME: '/home/example', DOCKER_HOST: 'unix:///var/run/docker.sock' });
    assert.ok(!DOCKER_ENV_WHITELIST.includes('PATH'));
    for (const name of ['PATH', 'AOT_DB_PATH', 'API_KEY', 'LD_PRELOAD']) assert.throws(() => createDockerCli({ path: DOCKER_PATH, env: { [name]: 'x' } }), /whitelist/);
    assert.deepEqual(createDockerCli({ path: DOCKER_PATH }).env, {});
  });

  it('a runner built with a bad configuration fails at creation, not at the first run', () => {
    const docker = createDockerCli({ path: DOCKER_PATH, process: new FakeDocker() });
    const base = { docker, instance: INSTANCE, limits: LIMITS, clock: new FakeClock(AT) };
    assert.throws(() => createContainerRunner({ ...base, image: 'node:24' }), /image/);
    assert.throws(() => createContainerRunner({ ...base, image: IMAGE, agentArgs: ['--privileged'] }), /forbidden_flag/);
    assert.throws(() => createContainerRunner({ ...base, image: IMAGE, namePrefix: 'bad prefix' }), /invalid_name/);
    assert.throws(() => createContainerRunner({ ...base, image: IMAGE, instance: 'bad instance' }), /invalid_instance/);
    assert.throws(() => createContainerRunner({ ...base, image: IMAGE, instance: undefined as unknown as string }), /invalid_instance/);
  });

  it('refuses a run_id that cannot name a container, without starting anything', async () => {
    const h = harness();
    const report = await h.runner.run({ ...h.input, run_id: 'run 1; rm -rf /' }, { gateway: { call: () => Promise.reject(new Error('no')) }, signal: h.controller.signal, onCostProgress: () => undefined });
    assert.equal(report.end, 'start_rejected');
    assert.equal(h.docker.spawned.length, 0);
  });
});

describe('cleanupOrphanContainers', () => {
  const dockerWith = (script: FakeDocker['script']): { fake: FakeDocker; cli: ReturnType<typeof createDockerCli> } => {
    const fake = new FakeDocker();
    fake.script = script;
    return { fake, cli: createDockerCli({ path: DOCKER_PATH, env: { HOME: '/home/example' }, process: fake }) };
  };

  it('lists by the run label AND the instance label, then kills and removes exactly those containers', async () => {
    const { fake, cli } = dockerWith((record) => (record.args[0] === 'ps' ? { code: 0, stdout: 'a1b2c3d4e5f6\n0123456789ab\n' } : { code: 0 }));
    const result = await cleanupOrphanContainers({ docker: cli, instance: INSTANCE });
    assert.deepEqual(fake.execs.map((e) => [...e.args]), [
      ['ps', '-aq', '--filter', 'label=aot.run', '--filter', 'label=aot.instance=inst-1'], ['kill', 'a1b2c3d4e5f6', '0123456789ab'], ['rm', '-f', 'a1b2c3d4e5f6', '0123456789ab'],
    ]);
    assert.deepEqual(result, { found: ['a1b2c3d4e5f6', '0123456789ab'], removed: 2, failures: [] });
    assert.ok(fake.execs.every((e) => e.file === DOCKER_PATH));
  });

  it('never selects by the run label alone: every listing carries the instance filter, and a run id only narrows it further', async () => {
    const { fake, cli } = dockerWith(() => ({ code: 0, stdout: '' }));
    await cleanupOrphanContainers({ docker: cli, instance: 'other.inst_2' });
    await cleanupOrphanContainers({ docker: cli, instance: INSTANCE, runId: 'run-9' });
    assert.deepEqual(fake.execs.map((e) => [...e.args]), [
      ['ps', '-aq', '--filter', 'label=aot.run', '--filter', 'label=aot.instance=other.inst_2'],
      ['ps', '-aq', '--filter', 'label=aot.run=run-9', '--filter', 'label=aot.instance=inst-1'],
    ]);
    // 인스턴스 ID 없이는 부를 수 없다(타입에서도 필수이고, 런타임에서도 거부한다)
    for (const instance of [undefined, '', 'a b', 'i=1', '--all', 'x'.repeat(64), 5]) {
      await assert.rejects(cleanupOrphanContainers({ docker: cli, instance: instance as unknown as string }), /instance/);
    }
    for (const runId of ['', 'a b', 'run=1', '--all', 'x;rm']) await assert.rejects(cleanupOrphanContainers({ docker: cli, instance: INSTANCE, runId }), /runId/);
    assert.equal(fake.execs.length, 2, 'the refused calls did not reach docker');
  });

  it('does nothing more when there is nothing left, and ignores "not running" / "no such container" noise', async () => {
    const none = dockerWith(() => ({ code: 0, stdout: '' }));
    assert.deepEqual(await cleanupOrphanContainers({ docker: none.cli, instance: INSTANCE }), { found: [], removed: 0, failures: [] });
    assert.equal(none.fake.execs.length, 1);

    const noisy = dockerWith((record) => {
      if (record.args[0] === 'ps') return { code: 0, stdout: 'a1b2c3d4e5f6\n' };
      if (record.args[0] === 'kill') return { code: 1, stderr: 'Error response from daemon: cannot kill container: a1b2c3d4e5f6: container is not running' };
      return { code: 1, stderr: 'Error response from daemon: No such container: a1b2c3d4e5f6' };
    });
    assert.deepEqual((await cleanupOrphanContainers({ docker: noisy.cli, instance: INSTANCE, runId: 'run-1' })).failures, []);
  });

  it('reports real failures, refuses odd docker output, and raises DockerUnavailableError when docker is gone', async () => {
    const failing = dockerWith((record) => (record.args[0] === 'ps' ? { code: 0, stdout: 'a1b2c3d4e5f6\n' } : { code: 1, stderr: 'permission denied' }));
    const result = await cleanupOrphanContainers({ docker: failing.cli, instance: INSTANCE });
    assert.equal(result.removed, 0);
    assert.equal(result.failures.length, 2);

    const odd = dockerWith(() => ({ code: 0, stdout: '--force\n' }));
    await assert.rejects(cleanupOrphanContainers({ docker: odd.cli, instance: INSTANCE }), /container id/);
    const gone = dockerWith(() => ({ code: null, spawnError: 'ENOENT' }));
    await assert.rejects(cleanupOrphanContainers({ docker: gone.cli, instance: INSTANCE }), DockerUnavailableError);
    const down = dockerWith(() => ({ code: 1, stderr: 'Cannot connect' }));
    await assert.rejects(cleanupOrphanContainers({ docker: down.cli, instance: INSTANCE }), DockerUnavailableError);
  });
});

describe('createLineReader', () => {
  it('splits lines across chunks, keeps multi-byte characters intact, and never needs a newline to enforce the limit', () => {
    const reader = createLineReader(10);
    assert.deepEqual(reader.push(Buffer.from('ab')), []);
    assert.equal(reader.pendingBytes(), 2);
    assert.deepEqual(reader.push(Buffer.from('c\nde\n\nf')), [{ kind: 'line', line: 'abc' }, { kind: 'line', line: 'de' }, { kind: 'line', line: '' }]);
    const bytes = Buffer.from('가나\n', 'utf8');
    const split = createLineReader(10);
    assert.deepEqual(split.push(bytes.subarray(0, 2)), []);
    assert.deepEqual(split.push(bytes.subarray(2)), [{ kind: 'line', line: '가나' }]);
    assert.deepEqual(createLineReader(4).push(Buffer.from('abcd\n')), [{ kind: 'line', line: 'abcd' }], 'exactly the limit is allowed');
    const over = createLineReader(4);
    assert.deepEqual(over.push(Buffer.from('abcde')), [{ kind: 'too_long', bytes: 5 }], 'the 5th byte trips it before any newline');
    assert.deepEqual(over.push(Buffer.from('\nok\n')), [], 'a blocked reader stays blocked');
    assert.equal(over.pendingBytes(), 0, 'and does not keep buffering');
  });
});
