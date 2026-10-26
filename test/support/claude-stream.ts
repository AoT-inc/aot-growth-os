// claude-code-cli 시험용 `stream-json` 고정 JSON (fixture). 실제 `claude` 를 부르지 않는다(이 세션에는 구독 로그인이 없다).
// 필드 이름·값은 스파이크 Q4 §4.1 에 *관찰해 적은 것*만 쓴다(`claude` 2.1.263). 관찰하지 못한 것은 아래 UNVERIFIED 표시를 달았다:
//   - 사용량 한도 도달 시 `result` 의 `terminal_reason`·`api_error_status`·문구 (공식 문서 `errors` 의 문구만 안다)
//   - `rate_limit_event.status` 의 `allowed` 아닌 값 이름, `utilization` 의 척도(0~1 인지 0~100 인지)
//   - init `mcp_servers` 항목의 `status` 값 이름(`connected` 로 가정)
// 한 건 관찰한 뒤 이 파일의 UNVERIFIED 항목을 실제 값으로 바꾸고 문구 목록(`DEFAULT_LIMIT_PATTERNS`)을 확정한다.
import type { JsonObject, JsonValue } from '@aot/agent-runtime';

export const GATEWAY_TOOL = 'example_search';

export interface InitOptions {
  tools?: string[];
  mcpServers?: { name: string; status: string }[];
  skills?: string[];
  slashCommands?: string[];
}

/** 정상 격리 상태의 init: 내장 읽기 도구 셋 + StructuredOutput + 게이트웨이 도구 하나 */
export function initEvent(options: InitOptions = {}): JsonObject {
  return {
    type: 'system',
    subtype: 'init',
    model: 'haiku',
    tools: options.tools ?? ['Read', 'Grep', 'Glob', 'StructuredOutput', `mcp__gateway__${GATEWAY_TOOL}`],
    mcp_servers: options.mcpServers ?? [{ name: 'gateway', status: 'connected' }],
    skills: options.skills ?? [],
    slash_commands: options.slashCommands ?? [],
    permissionMode: 'dontAsk',
    apiKeySource: 'none',
  };
}

export function rateLimitEvent(info: { status?: string; five_hour?: number; seven_day?: number } = {}): JsonObject {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: info.status ?? 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: 1_790_000_000,
      unifiedWindows: { five_hour: { utilization: info.five_hour ?? 0.1 }, seven_day: { utilization: info.seven_day ?? 0.02 } },
    },
  };
}

export function assistantEvent(id: string, text = 'working'): JsonObject {
  return { type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } };
}

export function toolUseEvent(id: string, name: string, input: JsonObject): JsonObject {
  return { type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}`, name, input }] } };
}

export function toolResultEvent(text: string, isError = false): JsonObject {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: text, ...(isError ? { is_error: true } : {}) }] } };
}

export interface ResultOptions {
  isError?: boolean;
  subtype?: string;
  result?: string | null;
  structured?: JsonValue | null;
  terminalReason?: string;
  apiErrorStatus?: number | null;
  numTurns?: number;
  totalCostUsd?: number;
  usage?: JsonObject;
  denials?: string[];
}

export function resultEvent(options: ResultOptions = {}): JsonObject {
  const isError = options.isError ?? false;
  return {
    type: 'result',
    subtype: options.subtype ?? 'success',
    is_error: isError,
    result: options.result === undefined ? (isError ? 'error' : 'done') : options.result,
    ...(options.structured === null ? {} : { structured_output: options.structured ?? { result: { summary: 'ok' }, evidence: [{ kind: 'source_url', ref: 'https://docs.example.com/a' }] } }),
    terminal_reason: options.terminalReason ?? (isError ? 'api_error' : 'completed'),
    stop_reason: 'end_turn',
    api_error_status: options.apiErrorStatus === undefined ? null : options.apiErrorStatus,
    num_turns: options.numTurns ?? 2,
    total_cost_usd: options.totalCostUsd ?? 0.0123,
    usage: options.usage ?? { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 700, cache_read_input_tokens: 30 },
    permission_denials: (options.denials ?? []).map((tool_name) => ({ tool_name, tool_use_id: 'tu-x', tool_input: {} })),
    session_id: 'session-example',
  };
}

/** 성공한 실행 전체 (init → 한도 상태 → 도구 호출 → 결과) */
export function successStream(): JsonObject[] {
  return [initEvent(), rateLimitEvent(), toolUseEvent('m1', `mcp__gateway__${GATEWAY_TOOL}`, { query: 'example' }), toolResultEvent('{"hits":1}'), assistantEvent('m2', 'finished'), resultEvent()];
}

export const toLines = (events: readonly JsonObject[]): string => events.map((event) => `${JSON.stringify(event)}\n`).join('');

// ----- 오류 사례 (스파이크 §4.1 (6) 표) -----
/** 로그인 정보 없음(빈 HOME): 종료 코드 1, `Not logged in · Please run /login` */
export const NOT_LOGGED_IN = resultEvent({ isError: true, subtype: 'success', result: 'Not logged in · Please run /login', terminalReason: 'api_error', apiErrorStatus: null, structured: null });
/** 무효한 OAuth 토큰: 401 */
export const OAUTH_INVALID = resultEvent({ isError: true, subtype: 'success', result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', terminalReason: 'api_error', apiErrorStatus: 401, structured: null });
/** 무효한 API 키: 401 */
export const API_KEY_INVALID = resultEvent({ isError: true, subtype: 'success', result: 'Invalid API key · Fix external API key', terminalReason: 'api_error', apiErrorStatus: 401, structured: null });
/** 예산 초과: `error_max_budget_usd` / `budget_exhausted`, result: null */
export const BUDGET_EXHAUSTED = resultEvent({ isError: true, subtype: 'error_max_budget_usd', result: null, terminalReason: 'budget_exhausted', structured: null });
/** UNVERIFIED: 사용량 한도 도달. 문구는 공식 문서(errors › Usage limits)에서, 필드 모양은 추정 */
export const SESSION_LIMIT = resultEvent({ isError: true, subtype: 'success', result: "You've hit your session limit · resets at 3pm", terminalReason: 'api_error', apiErrorStatus: 429, structured: null });
export const WEEKLY_LIMIT = resultEvent({ isError: true, subtype: 'success', result: "You've hit your weekly limit", terminalReason: 'api_error', apiErrorStatus: null, structured: null });
/** UNVERIFIED: 서버 쪽 제한 */
export const SERVER_LIMITING = resultEvent({ isError: true, subtype: 'success', result: 'Server is temporarily limiting requests', terminalReason: 'api_error', apiErrorStatus: 429, structured: null });
