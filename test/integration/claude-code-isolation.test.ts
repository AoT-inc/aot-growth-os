// claude-code-cli 격리 회귀 계약 시험 (CC4). 스파이크 Q4 §4.1 이 실측으로 통과시킨 격리 항목을 *회귀*로 고정한다:
//   (a) 작업 디렉터리 밖 읽기 거부  (b) 프로젝트 훅·설정 미실행  (c) 전역 CLAUDE.md·스킬·MCP 미노출  (d) 내장 Bash 미노출  (e) 비밀값 미노출
// 두 층이다.
//  A. 항상 도는 층 — 고정 JSON(fixture)과 가짜 프로세스로 *어댑터가 위반을 알아보고 거절하는가*를 본다. 실제 CLI 의 동작은 보지 못한다.
//  B. 사용자 PC 에서만 도는 층 — `AOT_CLAUDE_BIN=<claude 절대 경로>` 가 있을 때만 실제 구독 로그인된 `claude` 로 같은 항목을 확인한다.
//     모델을 부르므로 구독 사용량을 조금 쓴다(작은 프롬프트, 기본 모델). 이 층은 클라우드 세션에서 실행해 본 적이 없다 — 첫 실행은 사용자가 한다(CC5).
// `claude` 버전이 바뀌면(특히 `--bare` 가 `-p` 기본이 되는 경우) B 층을 다시 돌린다 (스파이크 §5).
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { FakeClock } from '@aot/domain';
import {
  buildClaudeArgs, buildClaudeEnv, createClaudeCodeCliAdapter, TASK_INSTRUCTIONS, type AdapterContext, type AdapterInput, type AdapterOutput, type ClaudeCodeCliOptions,
} from '@aot/agent-runtime';

import { contractInput } from '../support/adapter-contract.ts';
import { initEvent, resultEvent, toLines } from '../support/claude-stream.ts';
import { FakeDocker } from '../support/fake-docker.ts';
import { makeTempDir } from '../support/temp.ts';

const CONSENT = { notice_version: 'notice-1', accepted_at: '2026-10-26T00:00:00.000Z' };
const ENV = { home: '/home/example-daemon', user: 'example-daemon', path: '/usr/bin:/bin' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function untilReal(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

function fixtureRig(t: TestContext) {
  const docker = new FakeDocker();
  docker.script = (record) => (record.args[0] === '--version' ? { code: 0, stdout: '2.1.263 (Claude Code)\n' } : { code: 0 });
  const runRoot = join(makeTempDir(t, 'aot-iso-'), 'r');
  const options: ClaudeCodeCliOptions = { claudePath: '/opt/example/bin/claude', runRoot, env: ENV, consent: CONSENT, clock: new FakeClock(), process: docker, keepRunDir: true };
  const adapter = createClaudeCodeCliAdapter(options);
  const context: AdapterContext = { signal: new AbortController().signal, onCostProgress: () => undefined, gateway: { call: () => Promise.resolve({ ok: true, result: null }) } };
  const run = async (events: Parameters<typeof toLines>[0], input: AdapterInput = contractInput()): Promise<AdapterOutput> => {
    const before = docker.spawned.length;
    const done = adapter.run(input, context);
    await untilReal(() => docker.spawned.length > before, 'the process to start');
    const proc = docker.spawned[before]?.proc;
    assert.ok(proc !== undefined);
    proc.emitStdout(toLines(events));
    proc.emitClose(0);
    return done;
  };
  return { docker, runRoot, run };
}

describe('격리 계약 A: 어댑터가 위반을 알아보고 거절한다 (고정 JSON)', () => {
  it('(a) 작업 디렉터리 밖 읽기가 거부되면(permission_denials) 결과를 믿지 않는다', async (t) => {
    const rig = fixtureRig(t);
    const output = await rig.run([initEvent(), resultEvent({ denials: ['Read'] })]);
    assert.equal(output.status, 'error');
    assert.equal(output.error?.code, 'permission_denied');
    assert.equal(output.result, null);
  });

  it('(b) 어댑터는 작업 디렉터리에 설정·훅·MCP 파일을 만들지 않는다 (선행 결과 데이터 파일만)', async (t) => {
    const rig = fixtureRig(t);
    const input: AdapterInput = { ...contractInput(), upstream: [{ name: 'findings', task_ref: 'task:t1', trust_origin: 'external_untrusted', result: { a: 1 } }] };
    const { done, proc } = (() => {
      const adapter = createClaudeCodeCliAdapter({ claudePath: '/opt/example/bin/claude', runRoot: rig.runRoot, env: ENV, consent: CONSENT, clock: new FakeClock(), process: rig.docker, keepRunDir: true });
      const ctx: AdapterContext = { signal: new AbortController().signal, onCostProgress: () => undefined, gateway: { call: () => Promise.resolve({ ok: true, result: null }) } };
      const promise = adapter.run(input, ctx);
      return { done: promise, proc: async () => { await untilReal(() => rig.docker.spawned.length > 0, 'start'); return rig.docker.spawned[0]?.proc; } };
    })();
    const p = await proc();
    const work = join(rig.runRoot, 'run-contract-1', 'work');
    assert.deepEqual(readdirSync(work).sort(), ['upstream']);
    assert.ok(!existsSync(join(work, '.claude')) && !existsSync(join(work, '.mcp.json')) && !existsSync(join(work, 'CLAUDE.md')));
    const args = rig.docker.spawned[0]?.args ?? [];
    assert.ok(args.includes('--restricted'));
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    p?.emitStdout(toLines([initEvent(), resultEvent()]));
    p?.emitClose(0);
    await done;
  });

  it('(c) 전역 스킬·슬래시 명령·다른 MCP 서버가 init 에 보이면 isolation_violation', async (t) => {
    const rig = fixtureRig(t);
    for (const [index, event] of [
      initEvent({ skills: ['my-global-skill'] }),
      initEvent({ slashCommands: ['/my-command'] }),
      initEvent({ mcpServers: [{ name: 'gateway', status: 'connected' }, { name: 'global-server', status: 'connected' }] }),
    ].entries()) {
      const output = await rig.run([event], { ...contractInput(), run_id: `run-c-${index}` });
      assert.equal(output.error?.code, 'isolation_violation', `case ${index}`);
    }
  });

  it('(d) 내장 Bash·Write·WebFetch 가 init 도구 목록에 보이면 isolation_violation, 인자의 --tools 에는 처음부터 없다', async (t) => {
    const rig = fixtureRig(t);
    for (const [index, extra] of ['Bash', 'Write', 'WebFetch'].entries()) {
      const output = await rig.run([initEvent({ tools: ['Read', 'Grep', 'Glob', 'StructuredOutput', 'mcp__gateway__example_search', extra] })], { ...contractInput(), run_id: `run-d-${index}` });
      assert.equal(output.error?.code, 'isolation_violation', extra);
      assert.match(output.error?.message ?? '', new RegExp(extra));
    }
    const args = buildClaudeArgs({ prompt: 'p', instructions: TASK_INSTRUCTIONS, mcpConfigPath: '/x/gateway-mcp.json', gatewayTools: [] });
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  });

  it('(e) 비밀값: CLI 환경은 네 이름뿐이고, 비밀로 보이는 값이 든 업무 입력은 CLI 를 띄우지 않는다', async (t) => {
    const rig = fixtureRig(t);
    assert.deepEqual(Object.keys(buildClaudeEnv(ENV)).sort(), ['HOME', 'LOGNAME', 'PATH', 'USER']);
    const base = contractInput();
    const tainted: AdapterInput = { ...base, task_spec: { ...base.task_spec, objective: 'call with Bearer abcdefghijklmnop1234 attached' } };
    const done = createClaudeCodeCliAdapter({ claudePath: '/opt/example/bin/claude', runRoot: rig.runRoot, env: ENV, consent: CONSENT, clock: new FakeClock(), process: rig.docker })
      .run(tainted, { signal: new AbortController().signal, onCostProgress: () => undefined, gateway: { call: () => Promise.resolve({ ok: true, result: null }) } });
    assert.equal((await done).error?.code, 'start_rejected');
    assert.equal(rig.docker.spawned.length, 0);
  });
});

// ===== B. 실제 claude (사용자 PC, 구독 로그인) =====
const REAL_CLAUDE = process.env['AOT_CLAUDE_BIN'];
const realSkip = REAL_CLAUDE === undefined || REAL_CLAUDE === '' ? 'set AOT_CLAUDE_BIN=<absolute path of a logged-in claude> to run the real-CLI isolation check on your own PC (uses a little subscription quota)' : false;

describe('격리 계약 B: 실제 claude (AOT_CLAUDE_BIN 이 있을 때만, 사용자 PC)', { skip: realSkip }, () => {
  it('도구 없는 작은 업무가 어댑터의 init 격리 검사(스킬·MCP·Bash 미노출)를 통과하고 submitted 로 끝난다', async (t) => {
    const home = process.env['HOME'];
    const user = process.env['USER'] ?? process.env['LOGNAME'];
    assert.ok(home && user, 'HOME and USER are needed (the CLI reads the subscription login from them)');
    const runRoot = join(makeTempDir(t, 'aot-real-'), 'r');
    const adapter = createClaudeCodeCliAdapter({
      claudePath: REAL_CLAUDE ?? '', runRoot, env: { home, user, path: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin' }, consent: CONSENT, clock: new FakeClock(), model: 'haiku',
    });
    const base = contractInput();
    const input: AdapterInput = {
      ...base, run_id: 'run-real-isolation', allowed_tools: [], evidence_refs: [],
      task_spec: { ...base.task_spec, objective: 'Answer with the structured output {"result": {"answer": 4}} for the question: what is 2+2? Do not use any tool.', allowed_tools: [], inputs: [], acceptance_criteria: ['result.answer is 4'] },
    };
    const output = await adapter.run(input, { signal: AbortSignal.timeout(180_000), onCostProgress: () => undefined, gateway: { call: () => Promise.resolve({ ok: false, error: 'tool_not_allowed' }) } });
    // 격리 위반(isolation_violation)이나 로그인 문제(login_required)가 나면 이 PC 에서 호출 모양이 기대와 다르다는 뜻이다
    assert.equal(output.status, 'submitted', JSON.stringify(output.error));
    const initLine = output.run_log.find((entry) => entry.message.startsWith('init: '));
    assert.ok(initLine, 'the run log must contain the init summary');
    assert.ok(!/\bBash\b|\bWrite\b|\bWebFetch\b/.test(initLine.message), initLine.message);
    assert.match(initLine.message, /skills=0/);
  });
});
