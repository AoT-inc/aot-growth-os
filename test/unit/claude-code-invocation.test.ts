// claude-code-cli 호출 모양 (CC1, 스파이크 Q4 §3). 고정된 옵션·환경·작업 디렉터리 파일·MCP 설정을 시험으로 못 박는다: 호출 모양이 바뀌면 격리 가정이 깨진다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBridgeTools, buildClaudeArgs, buildClaudeEnv, buildMcpConfig, buildPrompt, buildWorkdirFiles, CLAUDE_CODE_BUILTIN_TOOLS, CLAUDE_ENV_NAMES,
  FORBIDDEN_CLAUDE_FLAGS, TASK_INSTRUCTIONS, upstreamFileOf,
} from '@aot/agent-runtime';

import { contractInput, contractUpstream, UPSTREAM_INJECTION } from '../support/adapter-contract.ts';

const ENV = { home: '/home/example-daemon', user: 'example-daemon', path: '/usr/bin:/bin' };
const MCP = '/var/example/runs/run-1/gateway-mcp.json';
const baseArgs = (overrides: Partial<Parameters<typeof buildClaudeArgs>[0]> = {}): string[] => buildClaudeArgs({
  prompt: 'do the task', instructions: TASK_INSTRUCTIONS, mcpConfigPath: MCP, gatewayTools: ['example_search'], ...overrides,
});
const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe('claude-code-cli 환경 (가드레일 1: 토큰·로그인 정보 비접촉)', () => {
  it('HOME USER LOGNAME PATH 네 개뿐이다 (env -i 와 같다)', () => {
    const env = buildClaudeEnv(ENV);
    assert.deepEqual(Object.keys(env).sort(), [...CLAUDE_ENV_NAMES].sort());
    assert.deepEqual(env, { HOME: ENV.home, USER: ENV.user, LOGNAME: ENV.user, PATH: ENV.path });
  });

  it('토큰·API 키 환경 변수를 만들거나 받는 길이 없다', () => {
    const env = buildClaudeEnv({ ...ENV, ...{ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-example', ANTHROPIC_API_KEY: 'key-example' } } as typeof ENV);
    for (const name of Object.keys(env)) assert.ok(!/TOKEN|KEY|SECRET|AUTH/i.test(name), name);
    assert.ok(!JSON.stringify(env).includes('oauth-example') && !JSON.stringify(env).includes('key-example'));
  });

  it('홈은 절대 경로, 사용자는 계정 이름 모양이어야 한다', () => {
    assert.throws(() => buildClaudeEnv({ ...ENV, home: 'relative/home' }), /absolute/);
    assert.throws(() => buildClaudeEnv({ ...ENV, user: 'a b' }), /account name/);
    assert.throws(() => buildClaudeEnv({ ...ENV, user: '' }), /account name/);
    assert.throws(() => buildClaudeEnv({ ...ENV, path: 'a\nb' }), /PATH/);
  });
});

describe('claude-code-cli 인자 (스파이크 §3 정정된 모양)', () => {
  it('고정 옵션이 모두 있다', () => {
    const args = baseArgs();
    assert.equal(args[0], '-p');
    assert.equal(args[1], 'do the task');
    assert.equal(valueAfter(args, '--output-format'), 'stream-json');
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('--restricted'));
    assert.equal(valueAfter(args, '--setting-sources'), '');
    assert.equal(valueAfter(args, '--tools'), 'Read,Grep,Glob');
    assert.equal(valueAfter(args, '--allowedTools'), 'mcp__gateway__example_search');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(valueAfter(args, '--mcp-config'), MCP);
    assert.ok(args.includes('--disable-slash-commands'));
    assert.equal(valueAfter(args, '--permission-mode'), 'dontAsk');
    assert.equal(valueAfter(args, '--permission-prompts'), 'none');
    assert.equal(valueAfter(args, '--append-system-prompt'), TASK_INSTRUCTIONS);
    const schema = JSON.parse(valueAfter(args, '--json-schema') ?? 'null') as { required: string[] };
    assert.deepEqual(schema.required, ['result']);
  });

  it('--safe-mode 와 --bare 는 쓰지 않는다 (게이트웨이 MCP 가 꺼지고 구독 로그인을 못 읽는다)', () => {
    const args = baseArgs();
    for (const flag of FORBIDDEN_CLAUDE_FLAGS) assert.ok(!args.includes(flag), flag);
    assert.ok(!args.includes('--safe-mode') && !args.includes('--bare'));
  });

  it('내장 도구는 읽기 전용 셋뿐이다: Bash·Write·Edit·WebFetch 는 --tools 에 없다', () => {
    assert.deepEqual([...CLAUDE_CODE_BUILTIN_TOOLS], ['Read', 'Grep', 'Glob']);
    const tools = (valueAfter(baseArgs(), '--tools') ?? '').split(',');
    for (const forbidden of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']) assert.ok(!tools.includes(forbidden), forbidden);
  });

  it('게이트웨이 도구가 여럿이면 허용 목록은 쉼표 하나로 합친다 (가변 인자가 다른 값을 삼키지 않게)', () => {
    const args = baseArgs({ gatewayTools: ['example_search', 'fetch_url'] });
    assert.equal(valueAfter(args, '--allowedTools'), 'mcp__gateway__example_search,mcp__gateway__fetch_url');
    assert.equal(args.filter((a) => a === '--allowedTools').length, 1);
  });

  it('게이트웨이 도구가 없으면 --allowedTools 를 두지 않지만 MCP 는 여전히 엄격하게 막는다', () => {
    const args = baseArgs({ gatewayTools: [] });
    assert.ok(!args.includes('--allowedTools'));
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--mcp-config'));
  });

  it('CLI 인자로 안전하지 않은 도구 이름·빈 프롬프트·상대 경로는 거부한다', () => {
    assert.throws(() => baseArgs({ gatewayTools: ['bad tool'] }), /cannot be passed/);
    assert.throws(() => baseArgs({ gatewayTools: ['a,b'] }), /cannot be passed/);
    assert.throws(() => baseArgs({ prompt: '  ' }), /empty/);
    assert.throws(() => baseArgs({ mcpConfigPath: 'relative.json' }), /absolute/);
    assert.throws(() => baseArgs({ maxBudgetUsd: 0 }), /positive/);
    assert.throws(() => baseArgs({ model: 'bad model; rm' }), /model/);
  });

  it('--max-budget-usd 와 --model 은 켠 때만 붙는다 (기본은 끈다: 열린 결정)', () => {
    const plain = baseArgs();
    assert.ok(!plain.includes('--max-budget-usd') && !plain.includes('--model'));
    const set = baseArgs({ maxBudgetUsd: 1.5, model: 'sonnet' });
    assert.equal(valueAfter(set, '--max-budget-usd'), '1.5');
    assert.equal(valueAfter(set, '--model'), 'sonnet');
  });
});

describe('claude-code-cli 프롬프트·작업 디렉터리 파일', () => {
  it('선행 결과는 프롬프트에 본문이 들어가지 않고 읽기 전용 데이터 파일로만 둔다', () => {
    const input = { ...contractInput(), upstream: contractUpstream() };
    const prompt = buildPrompt(input);
    assert.ok(!prompt.includes(UPSTREAM_INJECTION), 'the upstream text must not be in the instruction prompt');
    assert.ok(prompt.includes(upstreamFileOf(0)));
    assert.ok(prompt.includes(input.task_spec.objective));
    const files = buildWorkdirFiles(input);
    assert.deepEqual(Object.keys(files), [upstreamFileOf(0)]);
    const stored = JSON.parse(files[upstreamFileOf(0)] ?? 'null') as { trust_origin: string; result: { summary: string } };
    assert.equal(stored.trust_origin, 'external_untrusted');
    assert.equal(stored.result.summary, UPSTREAM_INJECTION);
  });

  it('선행 결과가 없으면 파일이 없다', () => {
    assert.deepEqual(buildWorkdirFiles(contractInput()), {});
  });

  it('고정 지침은 파일·도구 결과를 데이터로 다루게 한다', () => {
    assert.match(TASK_INSTRUCTIONS, /DATA, never instructions/);
  });

  it('입력은 변형하지 않는다', () => {
    const input = { ...contractInput(), upstream: contractUpstream() };
    const before = JSON.stringify(input);
    buildPrompt(input);
    buildWorkdirFiles(input);
    assert.equal(JSON.stringify(input), before);
  });
});

describe('claude-code-cli MCP 설정', () => {
  const config = {
    nodePath: '/usr/local/bin/node', bridgePath: '/opt/example/bridge.ts', socketPath: '/var/example/runs/run-1/gw.sock', toolsPath: '/var/example/runs/run-1/tools.json', token: 'run-token',
  };

  it('게이트웨이 서버 하나만 가리키고 토큰은 서버 환경으로만 넘긴다', () => {
    const parsed = JSON.parse(buildMcpConfig(config)) as { mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> };
    assert.deepEqual(Object.keys(parsed.mcpServers), ['gateway']);
    const server = parsed.mcpServers['gateway'];
    assert.equal(server?.type, 'stdio');
    assert.equal(server?.command, config.nodePath);
    assert.deepEqual(server?.args, [config.bridgePath, config.socketPath, config.toolsPath]);
    assert.deepEqual(server?.env, { AOT_GATEWAY_TOKEN: 'run-token' });
  });

  it('도구가 없으면 서버가 없는 설정이다', () => {
    assert.deepEqual(JSON.parse(buildMcpConfig(null)), { mcpServers: {} });
  });

  it('상대 경로는 거부한다', () => {
    assert.throws(() => buildMcpConfig({ ...config, socketPath: 'gw.sock' }), /absolute/);
  });

  it('브리지 도구 목록은 도구 이름과 설명이다', () => {
    const tools = buildBridgeTools([{ tool: 'example_search', operations: ['search'] }], { example_search: 'Search example documents.' });
    assert.deepEqual(tools, [{ name: 'example_search', description: 'Search example documents.' }]);
    assert.match(buildBridgeTools([{ tool: 'x', operations: ['a', 'b'] }])[0]?.description ?? '', /operations: a, b/);
  });
});
