// claude-code-cli 어댑터의 프로세스 경계 (CC1·CC4 일부). 가짜 `claude` 스크립트(test/support/fake-claude.ts)를 *실제 프로세스*로 띄우고, 어댑터가 만든 MCP 설정으로
// 실제 브리지(gateway-mcp-bridge.ts) → 유닉스 소켓 → 게이트웨이까지 거친다. 모델은 부르지 않는다. Docker 가 필요 없다.
// 실제 `claude` 로 하는 격리 회귀(밖 읽기 거부·훅 미실행 등)는 사용자 PC 에서만 가능하다 (docs/spikes/q4-claude-code-cli.md §4.1, CC5).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { FakeClock } from '@aot/domain';
import {
  createClaudeCodeCliAdapter, serveGatewaySocket, type AdapterContext, type AdapterInput, type JsonObject, type ToolGatewayResponse,
} from '@aot/agent-runtime';

import { contractInput, contractUpstream, CONTRACT_ALLOWED_TOOL } from '../support/adapter-contract.ts';
import { writeFakeClaude, type FakeClaudeScenario } from '../support/fake-claude.ts';
import { makeTempDir } from '../support/temp.ts';

const CONSENT = { notice_version: 'notice-1', accepted_at: '2026-10-26T00:00:00.000Z' };
const BRIDGE = new URL('../../packages/agent-runtime/src/claude-code/gateway-mcp-bridge.ts', import.meta.url).pathname;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function untilReal(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function rig(t: TestContext, scenario: FakeClaudeScenario, gatewayResponse: ToolGatewayResponse = { ok: true, result: { hits: 2 } }) {
  const dir = makeTempDir(t, 'aot-ccs-');
  const fake = writeFakeClaude(dir, scenario);
  const calls: { tool: string; args: JsonObject }[] = [];
  const controller = new AbortController();
  const home = join(dir, 'home');
  const runRoot = join(dir, 'r');
  const adapter = createClaudeCodeCliAdapter({
    claudePath: fake.path, runRoot, env: { home, user: 'example-daemon', path: process.env['PATH'] ?? '/usr/bin:/bin' }, consent: CONSENT, clock: new FakeClock('2026-10-26T01:00:00.000Z'),
    keepRunDir: false,
  });
  const context: AdapterContext = {
    signal: controller.signal,
    onCostProgress: () => undefined,
    gateway: { call(tool, args) { calls.push({ tool, args }); return Promise.resolve(gatewayResponse); } },
  };
  const run = (input: AdapterInput = contractInput()) => adapter.run(input, context);
  const record = (): { args: string[]; cwd: string; env: Record<string, string>; entries: string[]; upstream: string | null } => JSON.parse(readFileSync(fake.recordPath, 'utf8')) as ReturnType<typeof record>;
  return { dir, fake, calls, controller, run, record, runRoot, home };
}

describe('claude-code-cli 어댑터 + 가짜 claude 프로세스', () => {
  it('게이트웨이 도구를 MCP 로 거쳐 호출하고 결과를 계약 모양으로 돌려준다', async (t) => {
    const r = rig(t, { kind: 'call_tool', tool: CONTRACT_ALLOWED_TOOL, args: { query: 'example' } });
    const output = await r.run({ ...contractInput(), upstream: contractUpstream() });
    assert.equal(output.status, 'submitted', JSON.stringify(output.error));
    assert.deepEqual(r.calls, [{ tool: CONTRACT_ALLOWED_TOOL, args: { query: 'example' } }]);
    const result = output.result as { tool_result: { content: { text: string }[] } };
    assert.deepEqual(JSON.parse(result.tool_result.content[0]?.text ?? 'null'), { hits: 2 });
    assert.deepEqual(output.evidence.map((e) => [e.kind, e.ref, e.trust_origin]), [['other', 'stub:1', 'external_untrusted']]);
    assert.deepEqual(output.cost, { tokens: 15 });
    assert.ok(output.run_log.some((e) => e.message.startsWith('init: ') && e.message.includes(`mcp__gateway__${CONTRACT_ALLOWED_TOOL}`)));
    assert.ok(!existsSync(join(r.runRoot, 'run-contract-1')), 'the run directory is removed after the run');
  });

  it('CLI 는 작업 디렉터리에서, HOME USER LOGNAME PATH 만 가진 환경으로, 호출 모양대로 시작한다', async (t) => {
    const r = rig(t, { kind: 'call_tool', tool: CONTRACT_ALLOWED_TOOL, args: {} });
    await r.run({ ...contractInput(), upstream: contractUpstream() });
    const seen = r.record();
    assert.deepEqual(Object.keys(seen.env).sort(), ['HOME', 'LOGNAME', 'PATH', 'USER']);
    assert.equal(seen.env['HOME'], r.home);
    assert.equal(seen.env['USER'], 'example-daemon');
    assert.equal(seen.env['LOGNAME'], 'example-daemon');
    assert.equal(seen.cwd, join(realpathSync(r.dir), 'r', 'run-contract-1', 'work'));
    assert.deepEqual(seen.entries.sort(), ['upstream']);
    assert.match(seen.upstream ?? '', /external_untrusted/);
    assert.ok(seen.args.includes('--restricted') && seen.args.includes('--strict-mcp-config'));
    assert.ok(!seen.args.includes('--bare') && !seen.args.includes('--safe-mode'));
  });

  it('게이트웨이가 거부하면 거부 코드가 MCP 도구 오류로 에이전트에 닿는다', async (t) => {
    const r = rig(t, { kind: 'call_tool', tool: CONTRACT_ALLOWED_TOOL, args: {} }, { ok: false, error: 'policy_denied' });
    const output = await r.run();
    assert.equal(output.status, 'submitted');
    const result = output.result as { tool_result: { isError: boolean; content: { text: string }[] } };
    assert.equal(result.tool_result.isError, true);
    assert.equal(result.tool_result.content[0]?.text, 'policy_denied');
  });

  it('취소하면 실제 프로세스가 SIGTERM 으로 끝나고 cancelled 를 돌려준다', async (t) => {
    const r = rig(t, { kind: 'hang' });
    const done = r.run();
    await untilReal(() => existsSync(r.fake.pidPath) && existsSync(r.fake.recordPath), 'the fake claude to start');
    await sleep(300); // init 이벤트를 쓰는 중이어도 취소가 이긴다
    r.controller.abort();
    const output = await done;
    assert.equal(output.status, 'cancelled');
    const pid = Number(readFileSync(r.fake.pidPath, 'utf8'));
    await untilReal(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'the fake claude process to be gone');
    assert.ok(!existsSync(join(r.runRoot, 'run-contract-1')));
  });

  it('claude 실행 파일이 없으면 cli_unavailable 이고 아무 것도 만들지 않는다', async (t) => {
    const r = rig(t, { kind: 'hang' });
    const adapter = createClaudeCodeCliAdapter({
      claudePath: join(r.dir, 'missing-claude'), runRoot: r.runRoot, env: { home: r.home, user: 'example-daemon', path: '/usr/bin:/bin' }, consent: CONSENT, clock: new FakeClock(),
    });
    const output = await adapter.run(contractInput(), { signal: r.controller.signal, onCostProgress: () => undefined, gateway: { call: () => Promise.resolve({ ok: true, result: null }) } });
    assert.equal(output.error?.code, 'cli_unavailable');
    assert.ok(!existsSync(r.runRoot));
  });
});

describe('게이트웨이 MCP 브리지 (실제 프로세스)', () => {
  /** 브리지를 띄워 줄 단위 JSON-RPC 를 주고받는다 */
  function startBridge(socketPath: string, toolsPath: string, token: string) {
    const child = spawn(process.execPath, [BRIDGE, socketPath, toolsPath], { env: { AOT_GATEWAY_TOKEN: token, PATH: process.env['PATH'] ?? '' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    let buffer = '';
    let nextId = 1;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        const resolve = pending.get(message['id'] as number);
        if (resolve !== undefined) {
          pending.delete(message['id'] as number);
          resolve(message);
        }
      }
    });
    const rpc = (method: string, params?: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
    return { child, rpc, stop: () => { child.stdin.end(); } };
  }

  async function socketRig(t: TestContext, response: ToolGatewayResponse) {
    const dir = makeTempDir(t, 'aot-brg-');
    const calls: { tool: string; args: JsonObject }[] = [];
    const socket = await serveGatewaySocket({
      dir, allowedTools: ['example_search'], gateway: { call(tool, args) { calls.push({ tool, args }); return Promise.resolve(response); } },
    });
    t.after(() => socket.close());
    const { writeFileSync } = await import('node:fs');
    const toolsPath = join(dir, 'tools.json');
    writeFileSync(toolsPath, JSON.stringify([{ name: 'example_search', description: 'Search.' }]));
    return { socket, toolsPath, calls };
  }

  it('initialize·tools/list·tools/call 을 MCP 로 처리하고 호출을 게이트웨이로 넘긴다', async (t) => {
    const s = await socketRig(t, { ok: true, result: { hits: 3 } });
    const bridge = startBridge(s.socket.path, s.toolsPath, s.socket.token);
    t.after(() => bridge.stop());
    const init = await bridge.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal((init['result'] as { protocolVersion: string }).protocolVersion, '2025-06-18');
    const listed = await bridge.rpc('tools/list');
    const tools = (listed['result'] as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['example_search']);
    assert.equal(tools[0]?.inputSchema.type, 'object');
    const called = await bridge.rpc('tools/call', { name: 'example_search', arguments: { query: 'q' } });
    const content = (called['result'] as { content: { text: string }[]; isError?: boolean });
    assert.equal(content.isError, undefined);
    assert.deepEqual(JSON.parse(content.content[0]?.text ?? 'null'), { hits: 3 });
    assert.deepEqual(s.calls, [{ tool: 'example_search', args: { query: 'q' } }]);
  });

  it('허용 목록 밖 도구와 게이트웨이 오류는 isError 도구 결과다', async (t) => {
    const s = await socketRig(t, { ok: false, error: 'approval_required' });
    const bridge = startBridge(s.socket.path, s.toolsPath, s.socket.token);
    t.after(() => bridge.stop());
    await bridge.rpc('initialize', { protocolVersion: '2024-11-05' });
    const denied = await bridge.rpc('tools/call', { name: 'example_search', arguments: {} });
    assert.deepEqual(denied['result'], { isError: true, content: [{ type: 'text', text: 'approval_required' }] });
    const outside = await bridge.rpc('tools/call', { name: 'example_forbidden_tool', arguments: {} });
    assert.deepEqual(outside['result'], { isError: true, content: [{ type: 'text', text: 'tool_not_allowed' }] });
    assert.equal(s.calls.length, 1, 'the tool outside the allow-list never reached the gateway');
  });

  it('모르는 메서드와 잘못된 tools/call 은 JSON-RPC 오류다', async (t) => {
    const s = await socketRig(t, { ok: true, result: null });
    const bridge = startBridge(s.socket.path, s.toolsPath, s.socket.token);
    t.after(() => bridge.stop());
    const unknown = await bridge.rpc('resources/list');
    assert.equal((unknown['error'] as { code: number }).code, -32601);
    const bad = await bridge.rpc('tools/call', { name: 5 });
    assert.equal((bad['error'] as { code: number }).code, -32602);
    assert.deepEqual((await bridge.rpc('ping'))['result'], {});
  });

  it('토큰이 틀리면 호출은 gateway_unavailable 이고 게이트웨이에 닿지 않는다', async (t) => {
    const s = await socketRig(t, { ok: true, result: { hits: 1 } });
    const bridge = startBridge(s.socket.path, s.toolsPath, 'wrong-token');
    t.after(() => bridge.stop());
    await bridge.rpc('initialize', { protocolVersion: '2025-06-18' });
    await sleep(100);
    const called = await bridge.rpc('tools/call', { name: 'example_search', arguments: {} });
    assert.deepEqual(called['result'], { isError: true, content: [{ type: 'text', text: 'gateway_unavailable' }] });
    assert.equal(s.calls.length, 0);
  });

  it('인자 없이 시작하면 종료 코드 2 로 끝난다', async () => {
    const child = spawn(process.execPath, [BRIDGE], { env: { PATH: process.env['PATH'] ?? '' }, stdio: ['ignore', 'ignore', 'ignore'] });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 2);
  });
});
