// 검증기용 가짜 `claude` 실행 파일: 실제 프로세스·stdin 파이프를 거친다 (어댑터용 fake-claude.ts 는 게이트웨이 MCP 를 띄우지만 검증기는 MCP 가 없다).
// stdin 으로 받은 프롬프트의 주장 JSON 에서 id 를 읽어 시나리오(`verdicts`)대로 답한다. 받은 인자·stdin·작업 디렉터리를 기록 파일에 남긴다.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeVerifierScenario {
  /** 주장 id → 판정. 없는 id 는 `default` */
  verdicts?: Record<string, string>;
  default?: string;
  /** true 면 사용량 한도 오류로 끝낸다 */
  limit?: boolean;
}

const SCRIPT = String.raw`
'use strict';
const fs = require('fs');
const scenario = SCENARIO_JSON;
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.310 (Claude Code)\n'); process.exit(0); }
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(scenario.recordPath, JSON.stringify({ args, cwd: process.cwd(), stdin, entries: fs.readdirSync('.') }));
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'system', subtype: 'init', model: 'opus', tools: ['StructuredOutput'], mcp_servers: [], skills: [], slash_commands: [], permissionMode: 'dontAsk', apiKeySource: 'none' });
  if (scenario.limit) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit", structured_output: undefined, terminal_reason: 'api_error', api_error_status: 429, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 0 }, permission_denials: [] });
    process.exit(1);
  }
  const match = /## Claims[^\n]*\n(\[[\s\S]*?\n\])\n/.exec(stdin);
  const claims = match ? JSON.parse(match[1]) : [];
  const answers = claims.map((claim) => ({ id: claim.id, verdict: (scenario.verdicts || {})[claim.id] || scenario.default || 'unclear', reason: 'fake' }));
  emit({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'StructuredOutput', input: { claims: answers } }] } });
  emit({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: '{}', structured_output: { claims: answers }, terminal_reason: 'completed', stop_reason: 'end_turn', api_error_status: null, num_turns: 2, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, permission_denials: [] });
  process.exit(0);
});
`;

export interface FakeVerifierClaude {
  path: string;
  recordPath: string;
}

export function writeFakeVerifierClaude(dir: string, scenario: FakeVerifierScenario): FakeVerifierClaude {
  const recordPath = join(dir, 'fake-verifier-record.json');
  const path = join(dir, 'claude');
  writeFileSync(path, `#!${process.execPath}\n${SCRIPT.replace('SCENARIO_JSON', JSON.stringify({ ...scenario, recordPath }))}`);
  chmodSync(path, 0o755);
  return { path, recordPath };
}
