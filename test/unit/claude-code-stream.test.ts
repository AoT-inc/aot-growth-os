// claude-code-cli 결과 분류 (CC2·CC3). 종료 코드가 아니라 JSON 필드로 분류한다 (스파이크 Q4 §4.1 (6) 표). 고정 JSON 은 test/support/claude-stream.ts (한도 도달은 미확인 표시).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyStreamEvent, checkInit, CLAUDE_CODE_REVIEW_CODES, classifyRun, DEFAULT_LIMIT_PATTERNS, isClaudeCodeReviewCode, newStreamState, parseStreamLine, parseStructuredOutput,
  resultJsonSchema, summarizeStreamEvent, type ExpectedInit, type JsonObject,
} from '@aot/agent-runtime';

import {
  API_KEY_INVALID, assistantEvent, BUDGET_EXHAUSTED, GATEWAY_TOOL, initEvent, NOT_LOGGED_IN, OAUTH_INVALID, rateLimitEvent, resultEvent, SERVER_LIMITING, SESSION_LIMIT,
  successStream, toolResultEvent, toolUseEvent, WEEKLY_LIMIT,
} from '../support/claude-stream.ts';

const EXPECTED: ExpectedInit = { gatewayServer: 'gateway', gatewayTools: [`mcp__gateway__${GATEWAY_TOOL}`], builtinTools: ['Read', 'Grep', 'Glob'] };
const EXIT_OK = { code: 0, signal: null };
const EXIT_1 = { code: 1, signal: null };

function stateOf(events: readonly JsonObject[]) {
  const state = newStreamState();
  const seen = new Set<string>();
  for (const event of events) applyStreamEvent(state, event, seen);
  return state;
}
const classify = (events: readonly JsonObject[], exit = EXIT_OK, stderr = '') => classifyRun(stateOf(events), exit, stderr);

describe('claude-code-cli 성공 변환', () => {
  it('structured_output → result·evidence, 토큰 합계, 정가 환산 추정치', () => {
    const outcome = classify(successStream());
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result, { summary: 'ok' });
    assert.deepEqual(outcome.evidence, [{ kind: 'source_url', ref: 'https://docs.example.com/a' }]);
    assert.equal(outcome.tokens, 100 + 50 + 700 + 30);
    assert.equal(outcome.estimatedUsd, 0.0123);
  });

  it('종료 코드는 분류에 쓰지 않는다: 코드 1 이어도 JSON 이 성공이면 성공이다', () => {
    assert.ok(classify(successStream(), EXIT_1).ok);
  });

  it('evidence 는 선택이고, 없으면 빈 목록이다', () => {
    const outcome = classify([initEvent(), resultEvent({ structured: { result: { a: 1 } } })]);
    assert.ok(outcome.ok && outcome.evidence.length === 0);
  });
});

describe('claude-code-cli 오류 분류표 (스파이크 §4.1 (6))', () => {
  const cases: { name: string; events: JsonObject[]; code: string; review: boolean }[] = [
    { name: '로그인 없음 (Not logged in)', events: [NOT_LOGGED_IN], code: 'login_required', review: true },
    { name: '무효한 OAuth 토큰 (401)', events: [OAUTH_INVALID], code: 'login_required', review: true },
    { name: '무효한 API 키 (401)', events: [API_KEY_INVALID], code: 'login_required', review: true },
    { name: '예산 초과 (budget_exhausted)', events: [BUDGET_EXHAUSTED], code: 'budget_exhausted', review: false },
    { name: '[미확인 모양] 세션 한도', events: [SESSION_LIMIT], code: 'usage_limit', review: true },
    { name: '[미확인 모양] 주간 한도', events: [WEEKLY_LIMIT], code: 'usage_limit', review: true },
    { name: '[미확인 모양] 서버 쪽 제한', events: [SERVER_LIMITING], code: 'server_limited', review: true },
    { name: '일반 API 오류', events: [resultEvent({ isError: true, result: 'Overloaded', apiErrorStatus: 529, structured: null })], code: 'agent_error', review: false },
  ];
  for (const { name, events, code, review } of cases) {
    it(`${name} → ${code}`, () => {
      const outcome = classify([initEvent(), ...events], EXIT_1);
      assert.ok(!outcome.ok);
      if (outcome.ok) return;
      assert.equal(outcome.code, code);
      assert.equal(outcome.review, review);
      assert.equal(isClaudeCodeReviewCode(outcome.code), review);
    });
  }

  it('subtype 이 "success" 여도 is_error 가 true 면 오류다 (인증 실패 포함)', () => {
    const outcome = classify([NOT_LOGGED_IN]);
    assert.ok(!outcome.ok);
    assert.equal(NOT_LOGGED_IN['subtype'], 'success');
  });

  it('is_error 필드가 없으면 성공으로 보지 않는다', () => {
    const event = { ...resultEvent() } as Record<string, unknown>;
    delete event['is_error'];
    assert.ok(!classify([initEvent(), event as JsonObject]).ok);
  });

  it('종료 코드 0 이어도 permission_denials 가 있으면 실패다 (도구 거부는 종료 코드 0)', () => {
    const outcome = classify([initEvent(), resultEvent({ denials: ['Bash', 'Read'] })], EXIT_OK);
    assert.ok(!outcome.ok);
    if (outcome.ok) return;
    assert.equal(outcome.code, 'permission_denied');
    assert.match(outcome.message, /Bash, Read/);
    assert.equal(outcome.review, false);
  });

  it('structured_output 이 없으면 no_structured_output', () => {
    const outcome = classify([initEvent(), resultEvent({ structured: null })]);
    assert.ok(!outcome.ok && outcome.code === 'no_structured_output');
  });

  it('terminal_reason 이 completed 가 아니면 incomplete', () => {
    const outcome = classify([initEvent(), resultEvent({ terminalReason: 'max_turns' })]);
    assert.ok(!outcome.ok && outcome.code === 'incomplete');
  });

  it('result 메시지가 없으면: 옵션 오류는 cli_failed(재시도 대상 아님), 401 재시도 흔적은 login_required', () => {
    const noResult = classifyRun(stateOf([]), EXIT_1, 'error: option --output-format argument bogus is invalid\n');
    assert.ok(!noResult.ok && noResult.code === 'cli_failed' && noResult.review === false);
    assert.match(noResult.ok ? '' : noResult.message, /bogus/);
    const retried = classifyRun(stateOf([{ type: 'system', subtype: 'api_retry', error: 'authentication_failed', error_status: 401 }]), EXIT_1, '');
    assert.ok(!retried.ok && retried.code === 'login_required');
  });

  it('오류인데 한도 상태가 막힘(rejected)이면 usage_limit 로 본다', () => {
    const outcome = classify([initEvent(), rateLimitEvent({ status: 'rejected' }), resultEvent({ isError: true, result: 'something', structured: null })]);
    assert.ok(!outcome.ok && outcome.code === 'usage_limit');
  });

  it('한도 문구 목록은 설정으로 바꿀 수 있다', () => {
    const state = stateOf([initEvent(), resultEvent({ isError: true, result: 'LIMITE ATINGIDO', structured: null })]);
    assert.equal((classifyRun(state, EXIT_1, '') as { code: string }).code, 'agent_error');
    assert.equal((classifyRun(state, EXIT_1, '', { limitPatterns: [/limite atingido/i] }) as { code: string }).code, 'usage_limit');
    assert.ok(DEFAULT_LIMIT_PATTERNS.length > 0);
  });

  it('검토 대상 코드 목록은 기대한 것이다', () => {
    assert.deepEqual([...CLAUDE_CODE_REVIEW_CODES], ['login_required', 'usage_limit', 'server_limited', 'cli_unavailable', 'consent_required']);
    assert.ok(!isClaudeCodeReviewCode('agent_error') && !isClaudeCodeReviewCode('permission_denied'));
  });

  it('오류 문구의 비밀로 보이는 값은 가려진다', () => {
    const outcome = classify([initEvent(), resultEvent({ isError: true, result: 'boom Bearer abcdefghijklmnop1234', structured: null })]);
    assert.ok(!outcome.ok);
    assert.ok(!(outcome.ok ? '' : outcome.message).includes('abcdefghijklmnop1234'));
  });
});

describe('claude-code-cli 구조화 출력', () => {
  it('result 는 객체여야 하고 evidence 항목은 알려진 종류의 비어 있지 않은 ref 여야 한다', () => {
    assert.ok(!parseStructuredOutput({ evidence: [] }).ok);
    assert.ok(!parseStructuredOutput({ result: 'text' }).ok);
    assert.ok(!parseStructuredOutput({ result: {}, evidence: {} }).ok);
    assert.ok(!parseStructuredOutput({ result: {}, evidence: [{ kind: 'weird', ref: 'x' }] }).ok);
    assert.ok(!parseStructuredOutput({ result: {}, evidence: [{ kind: 'source_url', ref: ' ' }] }).ok);
    assert.ok(!parseStructuredOutput({ result: {}, evidence: [{ kind: 'source_url', ref: 'x', content_hash: 'md5:1' }] }).ok);
    const hash = `sha256:${'ab'.repeat(32)}`;
    const ok = parseStructuredOutput({ result: { a: 1 }, evidence: [{ kind: 'document', ref: 'doc:1', content_hash: hash }] });
    assert.ok(ok.ok && ok.evidence[0]?.content_hash === hash);
  });

  it('--json-schema 용 스키마는 result 를 필수로 둔다', () => {
    const schema = resultJsonSchema() as { required: string[]; properties: { evidence: { items: { properties: { kind: { enum: string[] } } } } } };
    assert.deepEqual(schema.required, ['result']);
    assert.ok(schema.properties.evidence.items.properties.kind.enum.includes('source_url'));
  });
});

describe('claude-code-cli 스트림 상태', () => {
  it('parseStreamLine 은 JSON 객체(type 문자열)만 받는다', () => {
    assert.equal(parseStreamLine('not json'), null);
    assert.equal(parseStreamLine('[1]'), null);
    assert.equal(parseStreamLine('{"type":5}'), null);
    assert.deepEqual(parseStreamLine('{"type":"x"}'), { type: 'x' });
  });

  it('턴 수는 서로 다른 assistant 메시지 id 로 센다', () => {
    const state = stateOf([assistantEvent('a'), assistantEvent('a', 'same message again'), assistantEvent('b')]);
    assert.equal(state.assistantTurns, 2);
  });

  it('한도 상태와 최대 사용률을 모은다', () => {
    const state = stateOf([rateLimitEvent({ five_hour: 0.4, seven_day: 0.9 }), rateLimitEvent({ status: 'allowed_warning', five_hour: 0.5, seven_day: 0.6 })]);
    assert.equal(state.maxUtilization, 0.9);
    assert.equal(state.rateLimitWorst?.status, 'allowed_warning');
  });

  it('run_log 요약은 비밀을 가리고 길이를 줄이며, 쓸모 없는 이벤트는 건너뛴다', () => {
    const long = summarizeStreamEvent(toolResultEvent(`Bearer abcdefghijklmnop1234 ${'x'.repeat(2000)}`)) ?? '';
    assert.ok(long.length < 600 && !long.includes('abcdefghijklmnop1234'));
    assert.equal(summarizeStreamEvent({ type: 'system', subtype: 'thinking_tokens' }), null);
    assert.match(summarizeStreamEvent(toolUseEvent('m', 'Read', { file_path: 'a.txt' })) ?? '', /tool_use Read/);
    assert.match(summarizeStreamEvent(resultEvent()) ?? '', /not a bill/);
  });
});

describe('claude-code-cli init 검사 (격리)', () => {
  const run = (options: Parameters<typeof initEvent>[0]) => {
    const state = stateOf([initEvent(options)]);
    return checkInit(state.init ?? (() => { throw new Error('no init'); })(), EXPECTED);
  };

  it('정상 init 은 통과한다', () => {
    const problems = run({});
    assert.deepEqual(problems, { gatewayProblems: [], isolationProblems: [] });
  });

  it('게이트웨이 서버가 없거나 연결 안 됐으면 gateway 문제다 (종료 코드 0 이라 여기서만 드러난다)', () => {
    assert.ok(run({ mcpServers: [] }).gatewayProblems.length > 0);
    assert.match(run({ mcpServers: [{ name: 'gateway', status: 'failed' }], tools: ['Read', 'Grep', 'Glob'] }).gatewayProblems.join(' '), /not connected/);
    assert.match(run({ tools: ['Read', 'Grep', 'Glob'] }).gatewayProblems.join(' '), /not available/);
  });

  it('Bash 같은 기대 밖 도구, 다른 MCP 서버, 스킬, 슬래시 명령은 격리 위반이다', () => {
    assert.match(run({ tools: ['Read', 'Grep', 'Glob', 'Bash', `mcp__gateway__${GATEWAY_TOOL}`] }).isolationProblems.join(' '), /Bash/);
    assert.match(run({ mcpServers: [{ name: 'gateway', status: 'connected' }, { name: 'nas-filesystem', status: 'connected' }] }).isolationProblems.join(' '), /nas-filesystem/);
    assert.match(run({ skills: ['my-skill'] }).isolationProblems.join(' '), /skills/);
    assert.match(run({ slashCommands: ['/deploy'] }).isolationProblems.join(' '), /slash commands/);
  });

  it('게이트웨이 도구가 없는 업무는 게이트웨이 서버를 요구하지 않는다', () => {
    const state = stateOf([initEvent({ tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'], mcpServers: [] })]);
    const problems = checkInit(state.init ?? (() => { throw new Error('no init'); })(), { ...EXPECTED, gatewayTools: [] });
    assert.deepEqual(problems, { gatewayProblems: [], isolationProblems: [] });
  });
});
