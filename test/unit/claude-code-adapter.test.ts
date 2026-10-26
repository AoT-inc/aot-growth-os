// claude-code-cli 어댑터 (CC1~CC3). 실제 `claude` 를 쓰지 않는다: 가짜 프로세스 포트가 `claude --version` 과 `claude -p` 를 대신하고, 시험이 stream-json 줄을 내보낸다
// (고정 JSON: test/support/claude-stream.ts). 실제 프로세스·MCP 브리지를 거치는 시험은 test/integration/claude-code-stub.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { FakeClock } from '@aot/domain';
import {
  CLAUDE_CODE_ADAPTER_NAME, createClaudeCodeCliAdapter, isClaudeCodeDeferredCode, isClaudeCodeReviewCode, validateAdapterOutput,
  type AdapterContext, type AdapterInput, type AdapterOutput, type ClaudeCodeCliOptions, type ClaudeCodeConsent, type JsonObject, type ToolGatewayResponse,
} from '@aot/agent-runtime';

import { contractInput, contractUpstream, CONTRACT_ALLOWED_TOOL, UPSTREAM_INJECTION } from '../support/adapter-contract.ts';
import {
  assistantEvent, GATEWAY_TOOL, initEvent, NOT_LOGGED_IN, rateLimitEvent, resultEvent, SESSION_LIMIT, successStream, toLines,
} from '../support/claude-stream.ts';
import { FakeDocker, type FakeProcess } from '../support/fake-docker.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { makeTempDir } from '../support/temp.ts';

const CLAUDE = '/opt/example/bin/claude';
const ENV = { home: '/home/example-daemon', user: 'example-daemon', path: '/usr/bin:/bin' };
const CONSENT = { notice_version: 'notice-1', accepted_at: '2026-10-26T00:00:00.000Z' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** 실제 파일 입출력이 끝나기를 기다린다 (가짜 포트의 `until` 은 setImmediate 만 돌려서 파일 작업을 못 기다린다) */
async function untilReal(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

interface Harness {
  docker: FakeDocker;
  timers: ManualGatewayTimers;
  runRoot: string;
  gatewayCalls: { tool: string; args: JsonObject }[];
  controller: AbortController;
  options: ClaudeCodeCliOptions;
  start(input?: AdapterInput, signal?: AbortSignal): { done: Promise<AdapterOutput>; proc: () => Promise<FakeProcess> };
  /** 프로세스를 띄우고 줄을 내보낸 뒤 닫는다 */
  /** n 번째로 띄워진 프로세스 (동시 실행 시험용) */
  procAt(n: number): Promise<FakeProcess>;
  runWith(events: readonly JsonObject[], exitCode?: number, input?: AdapterInput): Promise<{ output: AdapterOutput; proc: FakeProcess }>;
}

function harness(t: TestContext, overrides: Partial<ClaudeCodeCliOptions> = {}): Harness {
  const docker = new FakeDocker();
  docker.script = (record) => (record.args[0] === '--version' ? { code: 0, stdout: '2.1.263 (Claude Code)\n' } : { code: 0 });
  const timers = new ManualGatewayTimers();
  const runRoot = join(makeTempDir(t, 'aot-cc-'), 'runs');
  const gatewayCalls: { tool: string; args: JsonObject }[] = [];
  const controller = new AbortController();
  const options: ClaudeCodeCliOptions = {
    claudePath: CLAUDE, runRoot, env: ENV, consent: CONSENT, clock: new FakeClock('2026-10-26T01:00:00.000Z'), process: docker, timers, nodePath: '/usr/local/bin/node', ...overrides,
  };
  const adapter = createClaudeCodeCliAdapter(options);
  const context = (signal: AbortSignal): AdapterContext => ({
    signal,
    onCostProgress: () => undefined,
    gateway: {
      call(tool, args): Promise<ToolGatewayResponse> {
        gatewayCalls.push({ tool, args });
        return Promise.resolve({ ok: true, result: { hits: 1 } });
      },
    },
  });
  const start = (input: AdapterInput = contractInput(), signal: AbortSignal = controller.signal) => {
    const before = docker.spawned.length;
    const done = adapter.run(input, context(signal));
    return {
      done,
      proc: async (): Promise<FakeProcess> => {
        await untilReal(() => docker.spawned.length > before, 'the claude process to be spawned');
        const record = docker.spawned[before];
        if (record === undefined) throw new Error('no process');
        return record.proc;
      },
    };
  };
  const runWith: Harness['runWith'] = async (events, exitCode = 0, input) => {
    const { done, proc } = start(input);
    const p = await proc();
    p.emitStdout(toLines(events));
    p.emitClose(exitCode);
    return { output: await done, proc: p };
  };
  const procAt = async (n: number): Promise<FakeProcess> => {
    await untilReal(() => docker.spawned.length > n, `process #${n} to be spawned`);
    const record = docker.spawned[n];
    if (record === undefined) throw new Error('no process');
    return record.proc;
  };
  return { docker, timers, runRoot, gatewayCalls, controller, options, start, procAt, runWith };
}

const errorCode = (output: AdapterOutput): string | undefined => output.error?.code;
function assertValid(output: AdapterOutput): void {
  const checked = validateAdapterOutput(output);
  assert.ok(checked.ok, checked.ok ? '' : checked.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
}

describe('claude-code-cli 어댑터: 호출', () => {
  it('이름이 claude-code-cli 이고, 성공하면 계약 모양의 submitted 출력을 낸다', async (t) => {
    const h = harness(t);
    const { output } = await h.runWith(successStream());
    assert.equal(createClaudeCodeCliAdapter(h.options).name, CLAUDE_CODE_ADAPTER_NAME);
    assertValid(output);
    assert.equal(output.status, 'submitted');
    assert.deepEqual(output.result, { summary: 'ok' });
    assert.equal(output.evidence.length, 1);
    assert.equal(output.evidence[0]?.trust_origin, 'external_untrusted');
    assert.equal(output.evidence[0]?.captured_at, '2026-10-26T01:00:00.000Z');
    assert.deepEqual(output.cost, { tokens: 880 });
  });

  it('claude --version 을 한 번 기록하고, 인자·환경·작업 디렉터리·stdin 을 호출 모양대로 넘긴다', async (t) => {
    const h = harness(t, { keepRunDir: true });
    const { output, proc } = await h.runWith(successStream());
    assert.ok(output.run_log.some((e) => e.message.includes('claude CLI version: 2.1.263')));
    assert.equal(h.docker.execs.filter((e) => e.args[0] === '--version').length, 1);
    const spawned = h.docker.spawned[0];
    assert.ok(spawned !== undefined);
    assert.equal(spawned.file, CLAUDE);
    assert.deepEqual(spawned.env, { HOME: ENV.home, USER: ENV.user, LOGNAME: ENV.user, PATH: ENV.path });
    assert.equal(spawned.cwd, join(h.runRoot, 'run-contract-1', 'work'));
    assert.ok(proc.stdinEnded, 'stdin must be closed explicitly');
    assert.equal(spawned.args[0], '-p');
    assert.ok(spawned.args.includes('--restricted') && spawned.args.includes('--strict-mcp-config'));
    assert.ok(!spawned.args.includes('--bare') && !spawned.args.includes('--safe-mode'));
    // 두 번째 실행은 버전을 다시 묻지 않는다
    await h.runWith(successStream(), 0, { ...contractInput(), run_id: 'run-contract-2' });
    assert.equal(h.docker.execs.filter((e) => e.args[0] === '--version').length, 1);
  });

  it('프롬프트에는 선행 결과 본문이 없고, 작업 디렉터리 안에 읽기 전용 파일로만 있다', async (t) => {
    const h = harness(t, { keepRunDir: true });
    const input: AdapterInput = { ...contractInput(), upstream: contractUpstream() };
    const { done, proc } = h.start(input);
    const p = await proc();
    const record = h.docker.spawned[0];
    assert.ok(record !== undefined);
    assert.ok(!record.args.join('\n').includes(UPSTREAM_INJECTION));
    const file = join(h.runRoot, 'run-contract-1', 'work', 'upstream', '1.json');
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o444);
    assert.ok(readFileSync(file, 'utf8').includes('external_untrusted'));
    p.emitStdout(toLines(successStream()));
    p.emitClose(0);
    assert.equal((await done).status, 'submitted');
  });

  it('run 디렉터리(소켓·MCP 설정)는 끝난 뒤 지운다. keepRunDir 이면 남기고 MCP 설정은 작업 디렉터리 밖에 있다', async (t) => {
    const h = harness(t);
    await h.runWith(successStream());
    assert.ok(!existsSync(join(h.runRoot, 'run-contract-1')));
    const kept = harness(t, { keepRunDir: true });
    await kept.runWith(successStream());
    assert.ok(existsSync(join(kept.runRoot, 'run-contract-1', 'gateway-mcp.json')));
    assert.ok(!existsSync(join(kept.runRoot, 'run-contract-1', 'work', 'gateway-mcp.json')));
    assert.equal(statSync(join(kept.runRoot, 'run-contract-1', 'gateway-mcp.json')).mode & 0o777, 0o600);
  });

  it('허용 도구가 없는 업무는 소켓 없이 서버 없는 MCP 설정으로 돈다', async (t) => {
    const h = harness(t, { keepRunDir: true });
    const input: AdapterInput = { ...contractInput(), allowed_tools: [] };
    const { output } = await h.runWith([initEvent({ tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'], mcpServers: [] }), resultEvent()], 0, input);
    assert.equal(output.status, 'submitted');
    const config = JSON.parse(readFileSync(join(h.runRoot, 'run-contract-1', 'gateway-mcp.json'), 'utf8')) as { mcpServers: object };
    assert.deepEqual(config.mcpServers, {});
    assert.ok(!existsSync(join(h.runRoot, 'run-contract-1', 'gw.sock')));
  });

  it('입력은 변형하지 않는다', async (t) => {
    const h = harness(t);
    const input: AdapterInput = { ...contractInput(), upstream: contractUpstream() };
    const before = JSON.stringify(input);
    await h.runWith(successStream(), 0, input);
    assert.equal(JSON.stringify(input), before);
  });
});

describe('claude-code-cli 어댑터: 시작 전 거부 (CLI 를 띄우지 않는다)', () => {
  it('가드레일 4: 고지 동의가 없으면 consent_required (검토 대상), 프로세스를 띄우지 않는다', async (t) => {
    const h = harness(t, { consent: null });
    const output = await h.start().done;
    assertValid(output);
    assert.equal(output.status, 'error');
    assert.equal(errorCode(output), 'consent_required');
    assert.equal(h.docker.spawned.length, 0);
    assert.equal(h.docker.execs.length, 0);
    assert.equal(existsSync(h.runRoot), false);
  });

  it('consent 가 함수면 run 을 시작할 때마다 읽는다: 동의·철회가 다음 run 부터 적용된다', async (t) => {
    let current: ClaudeCodeConsent | null = null;
    const h = harness(t, { consent: () => current });
    assert.equal(errorCode(await h.start().done), 'consent_required');
    assert.equal(h.docker.spawned.length, 0, 'no consent: the CLI is not started');
    current = CONSENT;
    const output = (await h.runWith(successStream(), 0)).output;
    assert.equal(output.status, 'submitted', JSON.stringify(output.error));
    current = null;
    assert.equal(errorCode(await h.start().done), 'consent_required');
  });

  it('동의 기록이 비어 있어도 거부한다', async (t) => {
    const h = harness(t, { consent: { notice_version: ' ', accepted_at: CONSENT.accepted_at } });
    assert.equal(errorCode(await h.start().done), 'consent_required');
    assert.equal(h.docker.spawned.length, 0);
  });

  it('잘못된 run_id, 안전하지 않은 도구 이름, 비밀로 보이는 입력은 start_rejected', async (t) => {
    const h = harness(t);
    assert.equal(errorCode(await h.start({ ...contractInput(), run_id: '../escape' }).done), 'start_rejected');
    assert.equal(errorCode(await h.start({ ...contractInput(), allowed_tools: [{ tool: 'bad tool', operations: ['x'] }] }).done), 'start_rejected');
    const secret = contractInput();
    const withSecret: AdapterInput = { ...secret, task_spec: { ...secret.task_spec, objective: 'use key sk-abcdefghijklmnopqrstuvwx to publish' } };
    const output = await h.start(withSecret).done;
    assert.equal(errorCode(output), 'start_rejected');
    assert.match(output.error?.message ?? '', /secret/);
    assert.equal(h.docker.spawned.length, 0);
  });

  it('너무 긴 프롬프트는 거부한다', async (t) => {
    const h = harness(t);
    const base = contractInput();
    const huge: AdapterInput = { ...base, task_spec: { ...base.task_spec, objective: 'x'.repeat(120_000) } };
    const output = await h.start(huge).done;
    assert.equal(errorCode(output), 'start_rejected');
    assert.match(output.error?.message ?? '', /longer than/);
  });

  it('claude 를 못 찾으면 cli_unavailable (검토 대상)이고 호스트 대체 실행은 없다', async (t) => {
    const h = harness(t);
    h.docker.script = () => ({ code: null, spawnError: 'spawn /opt/example/bin/claude ENOENT' });
    const output = await h.start().done;
    assert.equal(errorCode(output), 'cli_unavailable');
    assert.equal(h.docker.spawned.length, 0);
  });

  it('claude 실행 자체가 던지면 cli_unavailable', async (t) => {
    const h = harness(t);
    h.docker.spawnThrows = new Error('EACCES');
    assert.equal(errorCode(await h.start().done), 'cli_unavailable');
  });

  it('이미 취소된 신호면 시작하지 않고 cancelled', async (t) => {
    const h = harness(t);
    h.controller.abort();
    const output = await h.start().done;
    assert.equal(output.status, 'cancelled');
    assert.equal(h.docker.spawned.length, 0);
  });

  it('같은 run_id 로 두 번 시작하지 않는다 (남아 있는 run 디렉터리를 지우지 않는다)', async (t) => {
    const h = harness(t, { keepRunDir: true });
    await h.runWith(successStream());
    const second = await h.start().done;
    assert.equal(errorCode(second), 'start_rejected');
    assert.ok(existsSync(join(h.runRoot, 'run-contract-1')), 'the earlier run directory must not be deleted');
  });

  it('설정 오류는 만들 때 던진다', () => {
    const base = { claudePath: CLAUDE, runRoot: '/var/example/runs', env: ENV, consent: CONSENT, clock: new FakeClock() };
    assert.throws(() => createClaudeCodeCliAdapter({ ...base, claudePath: 'claude' }), /absolute/);
    assert.throws(() => createClaudeCodeCliAdapter({ ...base, runRoot: 'runs' }), /absolute/);
    assert.throws(() => createClaudeCodeCliAdapter({ ...base, maxTurns: 0 }), /maxTurns/);
    assert.throws(() => createClaudeCodeCliAdapter({ ...base, maxConcurrent: 0 }), /maxConcurrent/);
    assert.throws(() => createClaudeCodeCliAdapter({ ...base, env: { ...ENV, home: 'rel' } }), /absolute/);
  });
});

describe('claude-code-cli 어댑터: 결과 분류는 JSON 으로 한다 (CC2·CC3)', () => {
  it('종료 코드 1 이라도 JSON 이 성공이면 submitted', async (t) => {
    const h = harness(t);
    assert.equal((await h.runWith(successStream(), 1)).output.status, 'submitted');
  });

  it('종료 코드 0 인데 permission_denials 가 있으면 error permission_denied', async (t) => {
    const h = harness(t);
    const { output } = await h.runWith([initEvent(), resultEvent({ denials: ['Bash'] })], 0);
    assertValid(output);
    assert.equal(errorCode(output), 'permission_denied');
    assert.equal(output.result, null);
  });

  it('로그인 없음 → login_required, 한도 → usage_limit (둘 다 검토 대상 코드)', async (t) => {
    const h = harness(t);
    assert.equal(errorCode((await h.runWith([initEvent(), NOT_LOGGED_IN], 1)).output), 'login_required');
    const limited = await h.runWith([initEvent(), rateLimitEvent({ status: 'rejected', five_hour: 1 }), SESSION_LIMIT], 1, { ...contractInput(), run_id: 'run-2' });
    assert.equal(errorCode(limited.output), 'usage_limit');
    assert.ok(limited.output.run_log.some((e) => e.message.includes('usage_warning')), 'a rate-limit warning must be in the run log');
  });

  it('결과 메시지 없이 끝나면(옵션 오류 등) cli_failed 이고 stderr 한 줄을 알린다', async (t) => {
    const h = harness(t);
    const { done, proc } = h.start();
    const p = await proc();
    p.emitStderr('error: option --output-format argument bogus is invalid\n');
    p.emitClose(1);
    const output = await done;
    assert.equal(errorCode(output), 'cli_failed');
    assert.match(output.error?.message ?? '', /bogus/);
  });

  it('한도 접근 경고: 사용률이 임계값 이상이면 성공해도 run_log 에 남긴다', async (t) => {
    const h = harness(t);
    const events = [initEvent(), rateLimitEvent({ five_hour: 0.92 }), assistantEvent('m1'), resultEvent()];
    const { output } = await h.runWith(events);
    assert.equal(output.status, 'submitted');
    assert.ok(output.run_log.some((e) => e.message.startsWith('usage_warning')));
    const quiet = await h.runWith([initEvent(), rateLimitEvent({ five_hour: 0.1 }), resultEvent()], 0, { ...contractInput(), run_id: 'run-quiet' });
    assert.ok(!quiet.output.run_log.some((e) => e.message.startsWith('usage_warning')));
  });

  it('정가 환산 추정치는 비용 단위에 넣지 않고 run_log 에만 남긴다 (예산 초과 종료에 쓰이지 않게)', async (t) => {
    const h = harness(t);
    const { output } = await h.runWith(successStream());
    assert.deepEqual(Object.keys(output.cost), ['tokens']);
    assert.ok(output.run_log.some((e) => /estimated cost \(subscription estimate at list prices, not a bill\): 0\.0123 USD/.test(e.message)));
  });

  it('run_log 는 비밀을 가리고 시각은 주입 시계다', async (t) => {
    const h = harness(t);
    const events = [initEvent(), assistantEvent('m1', 'token Bearer abcdefghijklmnop1234 here'), resultEvent()];
    const { output } = await h.runWith(events);
    assert.ok(!JSON.stringify(output.run_log).includes('abcdefghijklmnop1234'));
    for (const entry of output.run_log) assert.equal(entry.at, '2026-10-26T01:00:00.000Z');
  });

  it('잘못된 구조화 출력(알 수 없는 evidence 종류)은 invalid_structured_output', async (t) => {
    const h = harness(t);
    const { output } = await h.runWith([initEvent(), resultEvent({ structured: { result: {}, evidence: [{ kind: 'nope', ref: 'x' }] } })]);
    assert.equal(errorCode(output), 'invalid_structured_output');
  });
});

describe('claude-code-cli 어댑터: 어댑터가 직접 끝내는 경우', () => {
  it('init 에 Bash 가 보이면 isolation_violation 으로 CLI 를 SIGTERM 으로 멈춘다', async (t) => {
    const h = harness(t);
    const { done, proc } = h.start();
    const p = await proc();
    p.emitStdout(toLines([initEvent({ tools: ['Read', 'Grep', 'Glob', 'Bash', 'StructuredOutput', `mcp__gateway__${GATEWAY_TOOL}`] })]));
    await untilReal(() => p.signals.includes('SIGTERM'), 'SIGTERM');
    p.emitClose(null, 'SIGTERM');
    const output = await done;
    assert.equal(errorCode(output), 'isolation_violation');
    assert.match(output.error?.message ?? '', /Bash/);
  });

  it('게이트웨이 MCP 가 연결되지 않았으면 gateway_unavailable (종료 코드 0 이어도)', async (t) => {
    const h = harness(t);
    const { done, proc } = h.start();
    const p = await proc();
    p.emitStdout(toLines([initEvent({ tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'], mcpServers: [] })]));
    await untilReal(() => p.signals.includes('SIGTERM'), 'SIGTERM');
    p.emitClose(0);
    assert.equal(errorCode(await done), 'gateway_unavailable');
  });

  it('턴 한도를 넘으면 turn_limit_exceeded 로 멈춘다 (--max-turns 가 없어 직접 센다)', async (t) => {
    const h = harness(t, { maxTurns: 2 });
    const { done, proc } = h.start();
    const p = await proc();
    p.emitStdout(toLines([initEvent(), assistantEvent('a'), assistantEvent('b'), assistantEvent('c')]));
    await untilReal(() => p.signals.includes('SIGTERM'), 'SIGTERM');
    p.emitClose(null, 'SIGTERM');
    const output = await done;
    assert.equal(errorCode(output), 'turn_limit_exceeded');
    assertValid(output);
  });

  it('취소하면 SIGTERM 으로 멈추고 cancelled', async (t) => {
    const h = harness(t);
    const { done, proc } = h.start();
    const p = await proc();
    p.emitStdout(toLines([initEvent(), assistantEvent('a')]));
    h.controller.abort();
    await untilReal(() => p.signals.includes('SIGTERM'), 'SIGTERM');
    p.emitClose(null, 'SIGTERM');
    const output = await done;
    assertValid(output);
    assert.equal(output.status, 'cancelled');
    assert.equal(output.result, null);
  });

  it('SIGTERM 에 닫히지 않으면 유예 뒤 SIGKILL', async (t) => {
    const h = harness(t, { closeGraceMs: 1000 });
    const { done, proc } = h.start();
    const p = await proc();
    h.controller.abort();
    await untilReal(() => p.signals.includes('SIGTERM'), 'SIGTERM');
    await untilReal(() => h.timers.pending > 0, 'the grace timer');
    h.timers.advance(1000);
    await untilReal(() => p.signals.includes('SIGKILL'), 'SIGKILL');
    const output = await done;
    assert.equal(output.status, 'cancelled');
    assert.ok(output.run_log.some((e) => e.message.includes('SIGKILL')));
  });

  it('result 를 받은 뒤 CLI 가 닫히지 않으면 유예 뒤 종료시키고 결과는 그대로 받는다', async (t) => {
    const h = harness(t, { closeGraceMs: 500 });
    const { done, proc } = h.start();
    const p = await proc();
    p.emitStdout(toLines(successStream()));
    await untilReal(() => h.timers.pending > 0, 'the result grace timer');
    h.timers.advance(500);
    await untilReal(() => p.signals.includes('SIGTERM'), 'SIGTERM');
    p.emitClose(null, 'SIGTERM');
    assert.equal((await done).status, 'submitted');
  });

  it('출력 상한을 넘으면 output_limit', async (t) => {
    const h = harness(t, { maxOutputBytes: 100 });
    const { done, proc } = h.start();
    const p = await proc();
    p.emitStdout('x'.repeat(200));
    await untilReal(() => p.signals.includes('SIGTERM'), 'SIGTERM');
    p.emitClose(null, 'SIGTERM');
    assert.equal(errorCode(await done), 'output_limit');
  });

  it('JSON 이 아닌 줄은 무시하고 기록만 한다', async (t) => {
    const h = harness(t);
    const { done, proc } = h.start();
    const p = await proc();
    p.emitStdout(`garbage line\n${toLines(successStream())}`);
    p.emitClose(0);
    const output = await done;
    assert.equal(output.status, 'submitted');
    assert.ok(output.run_log.some((e) => e.message.startsWith('unparsed output line')));
  });
});

describe('claude-code-cli 어댑터: 동시 실행 제한 (가드레일 2)', () => {
  it('기본은 한 번에 하나만 실행한다', async (t) => {
    const h = harness(t);
    const first = h.start({ ...contractInput(), run_id: 'run-a' });
    const second = h.start({ ...contractInput(), run_id: 'run-b' });
    const p1 = await h.procAt(0);
    await sleep(40);
    assert.equal(h.docker.spawned.length, 1, 'the second run must wait for a free slot');
    p1.emitStdout(toLines(successStream()));
    p1.emitClose(0);
    assert.equal((await first.done).status, 'submitted');
    const p2 = await h.procAt(1);
    p2.emitStdout(toLines(successStream()));
    p2.emitClose(0);
    assert.equal((await second.done).status, 'submitted');
  });

  it('자리를 기다리는 중 취소하면 시작하지 않고 cancelled', async (t) => {
    const h = harness(t);
    const first = h.start({ ...contractInput(), run_id: 'run-a' });
    const p1 = await h.procAt(0);
    const waiting = new AbortController();
    const second = h.start({ ...contractInput(), run_id: 'run-b' }, waiting.signal);
    await sleep(20);
    waiting.abort();
    const output = await second.done;
    assert.equal(output.status, 'cancelled');
    assert.equal(h.docker.spawned.length, 1);
    p1.emitStdout(toLines(successStream()));
    p1.emitClose(0);
    assert.equal((await first.done).status, 'submitted');
  });

  it('maxConcurrent 를 올리면 동시에 실행한다', async (t) => {
    const h = harness(t, { maxConcurrent: 2 });
    const first = h.start({ ...contractInput(), run_id: 'run-a' });
    const second = h.start({ ...contractInput(), run_id: 'run-b' });
    const p1 = await h.procAt(0);
    const p2 = await h.procAt(1);
    assert.equal(h.docker.spawned.length, 2);
    for (const p of [p1, p2]) {
      p.emitStdout(toLines(successStream()));
      p.emitClose(0);
    }
    assert.equal((await first.done).status, 'submitted');
    assert.equal((await second.done).status, 'submitted');
  });
});

describe('claude-code-cli 어댑터: 게이트웨이 소켓 (브리지가 연결하는 곳)', () => {
  /** 브리지처럼 소켓에 붙어 hello 와 호출을 보낸다 */
  function bridgeClient(path: string, token: string): { send(message: object): void; lines: string[]; closed: () => boolean; ready: Promise<void> } {
    const lines: string[] = [];
    let buffer = '';
    let isClosed = false;
    const socket = connect(path);
    const ready = new Promise<void>((resolve) => socket.once('connect', () => {
      socket.write(`${JSON.stringify({ hello: token })}\n`);
      resolve();
    }));
    socket.on('error', () => undefined);
    socket.on('close', () => { isClosed = true; });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    return { send: (message) => void socket.write(`${JSON.stringify(message)}\n`), lines, closed: () => isClosed, ready };
  }

  async function mcpConfigOf(h: Harness): Promise<{ socket: string; token: string }> {
    const file = join(h.runRoot, 'run-contract-1', 'gateway-mcp.json');
    await untilReal(() => existsSync(file), 'the MCP config');
    const config = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: { gateway: { args: string[]; env: { AOT_GATEWAY_TOKEN: string } } } };
    return { socket: config.mcpServers.gateway.args[1] ?? '', token: config.mcpServers.gateway.env.AOT_GATEWAY_TOKEN };
  }

  it('토큰이 맞으면 허용 도구 호출을 게이트웨이로 넘기고 답을 돌려준다', async (t) => {
    const h = harness(t, { keepRunDir: true });
    const { done, proc } = h.start();
    const p = await proc();
    const { socket, token } = await mcpConfigOf(h);
    const client = bridgeClient(socket, token);
    await client.ready;
    client.send({ id: 1, tool: CONTRACT_ALLOWED_TOOL, args: { query: 'x' } });
    await untilReal(() => client.lines.length === 1, 'the gateway reply');
    assert.deepEqual(JSON.parse(client.lines[0] ?? 'null'), { id: 1, ok: true, result: { hits: 1 } });
    assert.deepEqual(h.gatewayCalls, [{ tool: CONTRACT_ALLOWED_TOOL, args: { query: 'x' } }]);
    p.emitStdout(toLines(successStream()));
    p.emitClose(0);
    await done;
  });

  it('허용 목록 밖 도구는 게이트웨이를 부르지 않고 tool_not_allowed', async (t) => {
    const h = harness(t, { keepRunDir: true });
    const { done, proc } = h.start();
    const p = await proc();
    const { socket, token } = await mcpConfigOf(h);
    const client = bridgeClient(socket, token);
    await client.ready;
    client.send({ id: 1, tool: 'example_forbidden_tool', args: {} });
    await untilReal(() => client.lines.length === 1, 'the refusal');
    assert.deepEqual(JSON.parse(client.lines[0] ?? 'null'), { id: 1, ok: false, error: 'tool_not_allowed' });
    assert.equal(h.gatewayCalls.length, 0);
    p.emitClose(0);
    await done;
  });

  it('토큰이 틀리면 연결을 끊고 아무것도 호출하지 않는다', async (t) => {
    const h = harness(t, { keepRunDir: true });
    const { done, proc } = h.start();
    const p = await proc();
    const { socket } = await mcpConfigOf(h);
    const client = bridgeClient(socket, 'wrong-token');
    await client.ready;
    client.send({ id: 1, tool: CONTRACT_ALLOWED_TOOL, args: {} });
    await untilReal(() => client.closed(), 'the connection to be closed');
    assert.equal(h.gatewayCalls.length, 0);
    p.emitClose(0);
    await done;
  });

  it('run 이 끝나면 소켓 파일이 사라진다', async (t) => {
    const h = harness(t, { keepRunDir: true });
    const { done, proc } = h.start();
    const p = await proc();
    const { socket } = await mcpConfigOf(h);
    assert.ok(existsSync(socket));
    p.emitStdout(toLines(successStream()));
    p.emitClose(0);
    await done;
    assert.ok(!existsSync(socket));
  });
});

describe('claude-code-cli 어댑터: 사람 우선 게이트 (yieldUtilization)', () => {
  const START_MS = Date.parse('2026-10-26T01:00:00.000Z');
  const resetsInSeconds = (afterMs: number): number => (START_MS + afterMs) / 1000;
  const busy = (extra: { five_hour?: number; seven_day?: number; five_hour_resets?: number | null } = {}): JsonObject[] => [
    initEvent(), rateLimitEvent({ five_hour: 0.92, five_hour_resets: resetsInSeconds(2 * 3600_000), ...extra }), assistantEvent('m1'), resultEvent(),
  ];
  const next = (id: string): AdapterInput => ({ ...contractInput(), run_id: id });

  it('기본은 꺼져 있다: 사용률이 높아도 다음 run 을 시작한다', async (t) => {
    const h = harness(t);
    assert.equal((await h.runWith(busy())).output.status, 'submitted');
    assert.equal((await h.runWith([initEvent(), resultEvent()], 0, next('run-2'))).output.status, 'submitted');
  });

  it('직전 run 이 임계값 이상을 봤고 창이 리셋 전이면 CLI 를 띄우지 않고 usage_deferred', async (t) => {
    const h = harness(t, { yieldUtilization: { five_hour: 0.7 } });
    assert.equal((await h.runWith(busy())).output.status, 'submitted');
    const spawnedBefore = h.docker.spawned.length;
    const output = await h.start(next('run-2')).done;
    assert.equal(errorCode(output), 'usage_deferred');
    assert.equal(isClaudeCodeReviewCode('usage_deferred'), false, 'deferral is a retry-later, not a review item');
    assert.equal(isClaudeCodeDeferredCode('usage_deferred'), true);
    assert.equal(isClaudeCodeDeferredCode('usage_limit'), false);
    assert.equal(h.docker.spawned.length, spawnedBefore, 'the claude process must not be started');
    assert.match(output.error?.message ?? '', /five_hour.*92%.*threshold 70%/);
    assert.ok(output.run_log.some((e) => e.message.includes('usage_deferred')));
    assertValid(output);
  });

  it('창이 리셋된 뒤에는 다시 시작한다', async (t) => {
    const clock = new FakeClock(START_MS);
    const h = harness(t, { yieldUtilization: { five_hour: 0.7 }, clock });
    await h.runWith(busy());
    assert.equal(errorCode((await h.start(next('run-2')).done)), 'usage_deferred');
    clock.advance(2 * 3600_000 + 1000);
    const { output } = await h.runWith([initEvent(), rateLimitEvent({ five_hour: 0.1 }), resultEvent()], 0, next('run-3'));
    assert.equal(output.status, 'submitted');
  });

  it('임계값 미만이면 시작한다. 임계값을 안 적은 창(seven_day)은 보지 않는다', async (t) => {
    const h = harness(t, { yieldUtilization: { five_hour: 0.7 } });
    await h.runWith([initEvent(), rateLimitEvent({ five_hour: 0.5, seven_day: 0.99, five_hour_resets: resetsInSeconds(3600_000) }), resultEvent()]);
    assert.equal((await h.runWith([initEvent(), resultEvent()], 0, next('run-2'))).output.status, 'submitted');
  });

  it('주간 창에 따로 임계값을 둘 수 있다 (퍼센트 표기도 받는다)', async (t) => {
    const h = harness(t, { yieldUtilization: { seven_day: 80 } });
    await h.runWith([initEvent(), rateLimitEvent({ five_hour: 0.1, seven_day: 0.85, five_hour_resets: resetsInSeconds(3600_000) }), resultEvent()]);
    const output = await h.start(next('run-2')).done;
    assert.equal(errorCode(output), 'usage_deferred');
    assert.match(output.error?.message ?? '', /seven_day/);
  });

  it('리셋 시각을 모르면 15분 뒤에 낡은 값으로 보고 다시 시작한다', async (t) => {
    const clock = new FakeClock(START_MS);
    const h = harness(t, { yieldUtilization: { five_hour: 0.7 }, clock });
    await h.runWith([initEvent(), rateLimitEvent({ five_hour: 0.92, five_hour_resets: null }), resultEvent()]);
    assert.equal(errorCode((await h.start(next('run-2')).done)), 'usage_deferred');
    clock.advance(15 * 60_000 + 1);
    assert.equal((await h.runWith([initEvent(), resultEvent()], 0, next('run-3'))).output.status, 'submitted');
  });

  it('잘못된 임계값은 만들 때 던진다', (t) => {
    for (const bad of [0, -1, Number.NaN, 101]) assert.throws(() => harness(t, { yieldUtilization: { five_hour: bad } }), /yieldUtilization/);
  });
});
