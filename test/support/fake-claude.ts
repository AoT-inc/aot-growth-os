// 가짜 `claude` 실행 파일 (시험용 스텁 스크립트). 구독 로그인이 없는 환경에서 어댑터의 *프로세스 경계*를 실제로 거치게 한다:
//  - `--version` 에 답하고, 그 밖의 호출은 받은 인자·작업 디렉터리·환경을 기록 파일에 남긴다.
//  - 실제 CLI 가 하듯 `--mcp-config` 를 읽어 게이트웨이 MCP 서버(브리지)를 자식 프로세스로 띄우고 MCP(JSON-RPC, 줄 단위)로 `tools/list`·`tools/call` 을 한다.
//  - 그 결과로 스파이크 Q4 §4.1 에 적힌 필드의 `stream-json` 줄을 내보낸다.
// 시나리오는 스크립트에 박아 넣는다(어댑터는 자식 환경에 시험용 변수를 실을 수 없다: 환경은 HOME USER LOGNAME PATH 뿐).
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FakeClaudeScenario =
  /** 게이트웨이 도구 `tool` 을 한 번 호출하고 그 결과를 structured_output 에 담아 정상 종료 */
  | { kind: 'call_tool'; tool: string; args: Record<string, unknown> }
  /** init 만 내보내고 SIGTERM 을 받을 때까지 기다린다 (취소 시험) */
  | { kind: 'hang' };

export interface FakeClaude {
  path: string;
  /** 호출 기록 파일 (`claude -p` 호출마다 덮어쓴다) */
  recordPath: string;
  /** 스텁이 시작할 때 자기 pid 를 적는 파일 */
  pidPath: string;
}

const SCRIPT = String.raw`
'use strict';
const fs = require('fs');
const cp = require('child_process');
const scenario = SCENARIO_JSON;
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.263 (Claude Code)\n'); process.exit(0); }
fs.writeFileSync(scenario.pidPath, String(process.pid));
let upstream = null;
try { upstream = fs.readFileSync('upstream/1.json', 'utf8'); } catch (e) { upstream = null; }
fs.writeFileSync(scenario.recordPath, JSON.stringify({ args, cwd: process.cwd(), env: process.env, entries: fs.readdirSync('.'), upstream }));
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const mcpPath = args[args.indexOf('--mcp-config') + 1];
const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
const servers = config.mcpServers || {};

function startServer(spec) {
  const child = cp.spawn(spec.command, spec.args, { env: Object.assign({}, process.env, spec.env || {}), stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1; let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); nl = buffer.indexOf('\n');
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (entry) { pending.delete(msg.id); entry(msg); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { child, rpc, notify };
}

(async () => {
  const mcpServers = []; const toolNames = [];
  let server = null;
  if (servers.gateway) {
    server = startServer(servers.gateway);
    const init = await server.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    server.notify('notifications/initialized');
    const listed = await server.rpc('tools/list', {});
    if (init.result && listed.result) {
      mcpServers.push({ name: 'gateway', status: 'connected' });
      for (const tool of listed.result.tools) toolNames.push('mcp__gateway__' + tool.name);
    }
  }
  emit({ type: 'system', subtype: 'init', model: 'haiku', tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'].concat(toolNames), mcp_servers: mcpServers, skills: [], slash_commands: [], permissionMode: 'dontAsk', apiKeySource: 'none' });
  if (scenario.kind === 'hang') { setInterval(() => undefined, 1000); return; }
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1790000000, unifiedWindows: { five_hour: { utilization: 0.1 } } } });
  let toolResult = null;
  if (server) {
    const called = await server.rpc('tools/call', { name: scenario.tool, arguments: scenario.args });
    toolResult = called.result;
    emit({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'mcp__gateway__' + scenario.tool, input: scenario.args }] } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: toolResult.content[0].text, is_error: toolResult.isError === true }] } });
  }
  emit({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', structured_output: { result: { tool_result: toolResult }, evidence: [{ kind: 'other', ref: 'stub:1' }] }, terminal_reason: 'completed', stop_reason: 'end_turn', api_error_status: null, num_turns: 2, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, permission_denials: [] });
  if (server) server.child.stdin.end();
  process.exit(0);
})();
`;

/** `dir` 에 실행 가능한 가짜 claude 를 쓴다. node 는 이 시험을 돌리는 node 의 절대 경로다 */
export function writeFakeClaude(dir: string, scenario: FakeClaudeScenario): FakeClaude {
  const recordPath = join(dir, 'fake-claude-record.json');
  const pidPath = join(dir, 'fake-claude.pid');
  const path = join(dir, 'claude');
  const body = SCRIPT.replace('SCENARIO_JSON', JSON.stringify({ ...scenario, recordPath, pidPath }));
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
  return { path, recordPath, pidPath };
}
