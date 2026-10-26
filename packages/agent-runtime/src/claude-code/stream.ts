// claude-code-cli 어댑터의 `stream-json` 해석기 (CC2·CC3). 종료 코드는 구분력이 없다(스파이크 Q4 §4.1: 오류는 거의 1, 도구 거부·게이트웨이 연결 실패는 0).
// 그래서 결과는 JSON 필드로만 분류한다: `is_error`·`terminal_reason`·`api_error_status`·`result` 문구·`permission_denials`·init 의 `mcp_servers`.
// 이 파일은 순수 함수만 둔다(프로세스·파일·시계를 모른다). 필드 이름은 스파이크 §4.1 에 적힌 것이고 `claude` 2.1.263 에서 관찰한 값이다 — 모르는 필드는 무시하고,
// 기대한 필드가 없으면 성공으로 보지 않는다(닫힌 쪽으로 실패한다).
// 사용량 한도 도달의 *실제* 문구·`terminal_reason` 은 아직 관찰하지 못했다(미확인). 문구는 `DEFAULT_LIMIT_PATTERNS` 설정 목록이고, 한 건 관찰한 뒤 확정한다.
import type { EvidenceKind } from '@aot/domain';
import { EVIDENCE_KINDS } from '@aot/domain';

import type { JsonObject } from '../contract.ts';
import { isJsonObject } from '../validate.ts';
import { maskString } from '../mask.ts';

// ===== 이벤트 파싱 =====

/** `stream-json` 한 줄. JSON 객체가 아니거나 `type` 이 문자열이 아니면 null (어댑터는 그런 줄을 로그에만 남기고 무시한다) */
export function parseStreamLine(line: string): JsonObject | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isJsonObject(value) && typeof value['type'] === 'string' ? value : null;
}

const asObject = (value: unknown): JsonObject | null => (isJsonObject(value) ? value : null);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

// ===== 상태 =====

export interface InitInfo {
  model: string | null;
  tools: string[];
  /** init 의 MCP 서버 목록. `status` 가 없으면 null */
  mcpServers: { name: string; status: string | null }[];
  skills: string[];
  slashCommands: string[];
  permissionMode: string | null;
  apiKeySource: string | null;
}

export interface RateLimitInfo {
  status: string | null;
  rateLimitType: string | null;
  resetsAt: string | number | null;
  /** 0~1 (또는 0~100 으로 보고하면 그대로). 창 이름 → 사용률 */
  utilization: Record<string, number>;
  /** 창 이름 → 그 창의 리셋 시각(에포크 밀리초). 보고가 없으면 null (사람 우선 게이트가 쓴다) */
  windowResetsMs: Record<string, number | null>;
}

export interface ResultInfo {
  subtype: string | null;
  isError: boolean | null;
  result: string | null;
  structuredOutput: JsonObject | null;
  terminalReason: string | null;
  apiErrorStatus: number | null;
  numTurns: number | null;
  totalCostUsd: number | null;
  tokens: number | null;
  permissionDenials: string[];
}

export interface StreamState {
  init: InitInfo | null;
  /** 마지막 `rate_limit_event` */
  rateLimit: RateLimitInfo | null;
  /** 가장 나쁘게 본 한도 상태: `allowed` 가 아닌 값이 한 번이라도 나왔으면 그 값 */
  rateLimitWorst: RateLimitInfo | null;
  /** 가장 높게 본 사용률 */
  maxUtilization: number | null;
  /** `system/api_retry` 의 오류 상태 코드들 (순서대로) */
  retryStatuses: number[];
  /** 서로 다른 assistant 메시지 수 (턴 수 대용: `--max-turns` 가 2.1.263 에는 없다) */
  assistantTurns: number;
  result: ResultInfo | null;
}

export function newStreamState(): StreamState {
  return { init: null, rateLimit: null, rateLimitWorst: null, maxUtilization: null, retryStatuses: [], assistantTurns: 0, result: null };
}

function parseInit(event: JsonObject): InitInfo {
  const servers = asArray(event['mcp_servers']) ?? [];
  return {
    model: asString(event['model']),
    tools: (asArray(event['tools']) ?? []).filter((t): t is string => typeof t === 'string'),
    mcpServers: servers.flatMap((entry) => {
      if (typeof entry === 'string') return [{ name: entry, status: null }];
      const obj = asObject(entry);
      const name = obj === null ? null : asString(obj['name']);
      return obj === null || name === null ? [] : [{ name, status: asString(obj['status']) }];
    }),
    skills: (asArray(event['skills']) ?? []).filter((s): s is string => typeof s === 'string'),
    slashCommands: (asArray(event['slash_commands']) ?? []).filter((s): s is string => typeof s === 'string'),
    permissionMode: asString(event['permissionMode']),
    apiKeySource: asString(event['apiKeySource']),
  };
}

/** 리셋 시각: 에포크 초(관찰값) 또는 밀리초 숫자, ISO 문자열을 받아 에포크 밀리초로. 알 수 없으면 null */
function resetsToMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function parseRateLimit(event: JsonObject): RateLimitInfo {
  const info = asObject(event['rate_limit_info']) ?? {};
  const resets = info['resetsAt'];
  const utilization: Record<string, number> = {};
  const windowResetsMs: Record<string, number | null> = {};
  const windows = asObject(info['unifiedWindows']);
  if (windows !== null) {
    for (const [name, value] of Object.entries(windows)) {
      const u = asNumber(asObject(value)?.['utilization']);
      if (u === null) continue;
      utilization[name] = u;
      windowResetsMs[name] = resetsToMs(asObject(value)?.['resetsAt']);
    }
  }
  return {
    status: asString(info['status']),
    rateLimitType: asString(info['rateLimitType']),
    resetsAt: typeof resets === 'string' || typeof resets === 'number' ? resets : null,
    utilization,
    windowResetsMs,
  };
}

function parseResult(event: JsonObject): ResultInfo {
  const usage = asObject(event['usage']);
  let tokens: number | null = null;
  if (usage !== null) {
    const parts = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((k) => asNumber(usage[k]));
    const known = parts.filter((p): p is number => p !== null && p >= 0);
    if (known.length > 0) tokens = Math.round(known.reduce((a, b) => a + b, 0));
  }
  const denials = (asArray(event['permission_denials']) ?? []).map((entry) => {
    const obj = asObject(entry);
    return (obj === null ? null : asString(obj['tool_name'])) ?? 'unknown_tool';
  });
  return {
    subtype: asString(event['subtype']),
    isError: typeof event['is_error'] === 'boolean' ? event['is_error'] : null,
    result: asString(event['result']),
    structuredOutput: asObject(event['structured_output']),
    terminalReason: asString(event['terminal_reason']),
    apiErrorStatus: asNumber(event['api_error_status']),
    numTurns: asNumber(event['num_turns']),
    totalCostUsd: asNumber(event['total_cost_usd']),
    tokens,
    permissionDenials: denials,
  };
}

/** 이벤트 하나를 상태에 반영한다 */
export function applyStreamEvent(state: StreamState, event: JsonObject, seenMessageIds: Set<string>): void {
  const type = event['type'];
  const subtype = asString(event['subtype']);
  if (type === 'system' && subtype === 'init') {
    state.init = parseInit(event);
  } else if (type === 'system' && subtype === 'api_retry') {
    const status = asNumber(event['error_status']);
    if (status !== null) state.retryStatuses.push(status);
  } else if (type === 'rate_limit_event') {
    const info = parseRateLimit(event);
    state.rateLimit = info;
    if (info.status !== null && info.status !== 'allowed') state.rateLimitWorst = info;
    for (const u of Object.values(info.utilization)) state.maxUtilization = Math.max(state.maxUtilization ?? 0, u);
  } else if (type === 'assistant') {
    const message = asObject(event['message']);
    const id = message === null ? null : asString(message['id']);
    if (id === null) state.assistantTurns += 1;
    else if (!seenMessageIds.has(id)) {
      seenMessageIds.add(id);
      state.assistantTurns += 1;
    }
  } else if (type === 'result') {
    state.result = parseResult(event);
  }
}

// ===== run_log 요약 =====

const LOG_TEXT_CHARS = 400;
const clip = (text: string): string => {
  const masked = maskString(text).replace(/\s+/g, ' ').trim();
  return masked.length <= LOG_TEXT_CHARS ? masked : `${masked.slice(0, LOG_TEXT_CHARS)}…`;
};

/** 이벤트 하나를 run_log 한 줄로 줄인다(비밀 가림, 길이 상한). 남길 가치가 없는 이벤트는 null (thinking 토큰 등) */
export function summarizeStreamEvent(event: JsonObject): string | null {
  const type = event['type'];
  const subtype = asString(event['subtype']);
  if (type === 'system' && subtype === 'init') {
    const init = parseInit(event);
    return clip(`init: model=${init.model ?? '?'} tools=[${init.tools.join(',')}] mcp=[${init.mcpServers.map((s) => `${s.name}:${s.status ?? '?'}`).join(',')}] skills=${init.skills.length} permissionMode=${init.permissionMode ?? '?'} apiKeySource=${init.apiKeySource ?? '?'}`);
  }
  if (type === 'system' && subtype === 'api_retry') return clip(`api_retry: status=${String(event['error_status'])} error=${String(event['error'])}`);
  if (type === 'system') return null;
  if (type === 'rate_limit_event') {
    const info = parseRateLimit(event);
    return clip(`rate_limit: status=${info.status ?? '?'} type=${info.rateLimitType ?? '?'} utilization=${JSON.stringify(info.utilization)}`);
  }
  if (type === 'assistant' || type === 'user') {
    const message = asObject(event['message']);
    const content = asArray(message?.['content']) ?? [];
    const parts: string[] = [];
    for (const block of content) {
      const obj = asObject(block);
      if (obj === null) continue;
      const kind = asString(obj['type']);
      if (kind === 'text') parts.push(`text: ${asString(obj['text']) ?? ''}`);
      else if (kind === 'tool_use') parts.push(`tool_use ${asString(obj['name']) ?? '?'}: ${JSON.stringify(obj['input'] ?? {})}`);
      else if (kind === 'tool_result') {
        const body = obj['content'];
        parts.push(`tool_result${obj['is_error'] === true ? ' (error)' : ''}: ${typeof body === 'string' ? body : JSON.stringify(body ?? '')}`);
      }
    }
    return parts.length === 0 ? null : clip(`${String(type)}: ${parts.join(' | ')}`);
  }
  if (type === 'result') {
    const r = parseResult(event);
    return clip(`result: subtype=${r.subtype ?? '?'} is_error=${String(r.isError)} terminal_reason=${r.terminalReason ?? '?'} api_error_status=${String(r.apiErrorStatus)} turns=${String(r.numTurns)} denials=${r.permissionDenials.length} estimated_cost_usd=${String(r.totalCostUsd)} (subscription estimate at list prices, not a bill)${r.result === null ? '' : ` result=${r.result}`}`);
  }
  return null;
}

// ===== init 검사 (격리) =====

export interface ExpectedInit {
  /** 게이트웨이 MCP 서버 이름 (`--mcp-config` 의 키) */
  gatewayServer: string;
  /** 허용한 게이트웨이 도구의 MCP 이름 (`mcp__<server>__<tool>`) */
  gatewayTools: readonly string[];
  /** `--tools` 로 연 내장 도구 */
  builtinTools: readonly string[];
}

/** 구조화 출력용으로 CLI 가 자동으로 더하는 도구 이름 (스파이크 §3 표) */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * init 이벤트가 기대한 격리 상태인지 본다. 문제 목록을 돌려준다(비면 통과).
 *  - 게이트웨이 서버가 `connected` 가 아니면: 연결 실패는 종료 코드 0 이라 여기서만 드러난다 (`gateway_unavailable`)
 *  - 기대 밖 도구(특히 Bash)·기대 밖 MCP 서버·스킬·슬래시 명령이 보이면 격리 위반이다 (`isolation_violation`)
 */
export function checkInit(init: InitInfo, expected: ExpectedInit): { gatewayProblems: string[]; isolationProblems: string[] } {
  const gatewayProblems: string[] = [];
  const isolationProblems: string[] = [];
  if (expected.gatewayTools.length > 0) {
    const server = init.mcpServers.find((s) => s.name === expected.gatewayServer);
    if (server === undefined) gatewayProblems.push(`the gateway MCP server '${expected.gatewayServer}' is not in the init server list`);
    else if (server.status !== null && server.status !== 'connected') gatewayProblems.push(`the gateway MCP server '${expected.gatewayServer}' is '${server.status}', not connected`);
    for (const tool of expected.gatewayTools) {
      if (!init.tools.includes(tool)) gatewayProblems.push(`the gateway tool '${tool}' is not available`);
    }
  }
  const allowedTools = new Set<string>([...expected.builtinTools, ...expected.gatewayTools, STRUCTURED_OUTPUT_TOOL]);
  for (const tool of init.tools) {
    if (!allowedTools.has(tool)) isolationProblems.push(`unexpected tool '${tool}'`);
  }
  for (const server of init.mcpServers) {
    if (server.name !== expected.gatewayServer) isolationProblems.push(`unexpected MCP server '${server.name}'`);
  }
  if (init.skills.length > 0) isolationProblems.push(`skills are visible (${init.skills.slice(0, 5).join(', ')})`);
  if (init.slashCommands.length > 0) isolationProblems.push(`slash commands are visible (${init.slashCommands.slice(0, 5).join(', ')})`);
  return { gatewayProblems, isolationProblems };
}

// ===== 결과 분류 =====

/**
 * 사람이 보거나 시간이 지나야 풀리는 오류 코드. 업무를 `failed` 로 쓰지 말고 `needs_review`(재시도 대상)로 보내야 한다 (ADR-0005 Amendment 2026-10-25).
 * 이 어댑터는 `AdapterOutput.error.code` 로만 알린다; 코드를 업무 상태로 옮기는 일은 실행기 쪽 몫이다(apps/daemon/src/agent-executor.ts).
 */
export const CLAUDE_CODE_REVIEW_CODES = ['login_required', 'usage_limit', 'server_limited', 'cli_unavailable', 'consent_required'] as const;
export type ClaudeCodeReviewCode = (typeof CLAUDE_CODE_REVIEW_CODES)[number];
export const isClaudeCodeReviewCode = (code: string): code is ClaudeCodeReviewCode => (CLAUDE_CODE_REVIEW_CODES as readonly string[]).includes(code);

/**
 * 실패도 검토 대상도 아닌 "나중에 다시": 사람 우선 게이트(`yieldUtilization`)가 CLI 를 띄우지 않고 새 run 을 미뤘다.
 * 실행기는 시도를 소모하지 않고 잠시 뒤 다시 집히게 한다.
 */
export const CLAUDE_CODE_DEFERRED_CODE = 'usage_deferred';
export const isClaudeCodeDeferredCode = (code: string): boolean => code === CLAUDE_CODE_DEFERRED_CODE;

/**
 * 사용량 한도 문구 (공식 문서 `errors` 의 "Usage limits" 절). **headless JSON 에서 실제로 어떻게 나오는지는 미확인** — 사용자 PC 에서 한도 도달 한 건을 관찰한 뒤 확정한다.
 * 데몬 설정으로 바꿀 수 있다 (`ClaudeCodeCliOptions.limitPatterns`).
 */
export const DEFAULT_LIMIT_PATTERNS: readonly RegExp[] = [
  /you['’]ve hit your (?:session|weekly|opus|sonnet)? ?limit/i,
  /usage limit/i,
];
/** 서버 쪽 제한 문구 (같은 문서). 이것도 실제 JSON 모양은 미확인 */
export const DEFAULT_SERVER_LIMIT_PATTERNS: readonly RegExp[] = [
  /server is temporarily limiting requests/i,
  /request rejected \(429\)/i,
];
const LOGIN_PATTERNS: readonly RegExp[] = [
  /not logged in/i,
  /please run \/login/i,
  /failed to authenticate/i,
  /invalid api key/i,
  /oauth (?:access )?token (?:is )?(?:invalid|expired|revoked)/i,
  /authentication[_ ]failed/i,
];

export interface ClassifyOptions {
  limitPatterns?: readonly RegExp[];
  serverLimitPatterns?: readonly RegExp[];
  /** 구조화 출력을 읽는 함수. 기본은 업무용 `{result, evidence}` (`parseStructuredOutput`). 검증기는 자기 모양을 읽는다 */
  parseOutput?: (output: JsonObject) => { ok: true; result: JsonObject; evidence: ParsedEvidence[] } | { ok: false; message: string };
}

export type ClassifiedRun =
  | { ok: true; result: JsonObject; evidence: ParsedEvidence[]; tokens: number | null; estimatedUsd: number | null }
  | { ok: false; code: string; message: string; review: boolean; tokens: number | null; estimatedUsd: number | null };

export interface ParsedEvidence { kind: EvidenceKind; ref: string; content_hash?: string }

const MAX_EVIDENCE = 200;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

/** 구조화 출력은 `{result: 객체, evidence?: [{kind, ref, content_hash?}]}` 다 (`resultJsonSchema`) */
export function parseStructuredOutput(output: JsonObject): { ok: true; result: JsonObject; evidence: ParsedEvidence[] } | { ok: false; message: string } {
  const result = output['result'];
  if (!isJsonObject(result)) return { ok: false, message: "structured output has no object 'result'" };
  const rawEvidence = output['evidence'];
  const evidence: ParsedEvidence[] = [];
  if (rawEvidence !== undefined) {
    if (!Array.isArray(rawEvidence)) return { ok: false, message: "structured output 'evidence' is not an array" };
    if (rawEvidence.length > MAX_EVIDENCE) return { ok: false, message: `structured output has more than ${MAX_EVIDENCE} evidence items` };
    for (const [index, item] of rawEvidence.entries()) {
      if (!isJsonObject(item)) return { ok: false, message: `evidence[${index}] is not an object` };
      const kind = item['kind'];
      const ref = item['ref'];
      if (typeof kind !== 'string' || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) return { ok: false, message: `evidence[${index}].kind is not a known evidence kind` };
      if (typeof ref !== 'string' || ref.trim() === '' || ref.length > 2000) return { ok: false, message: `evidence[${index}].ref must be a non-empty string` };
      const hash = item['content_hash'];
      if (hash !== undefined && !(typeof hash === 'string' && SHA256.test(hash))) return { ok: false, message: `evidence[${index}].content_hash must look like sha256:<64 hex>` };
      evidence.push({ kind: kind as EvidenceKind, ref, ...(typeof hash === 'string' ? { content_hash: hash } : {}) });
    }
  }
  return { ok: true, result, evidence };
}

/**
 * 끝난 실행을 JSON 필드로 분류한다 (스파이크 Q4 §4.1 (6) 표). `exit` 는 종료 코드·신호이며 참고 문구에만 쓰고 분류에는 쓰지 않는다.
 * 취소·시간 제한·턴 한도·격리 위반처럼 어댑터가 직접 끝낸 경우는 여기 오기 전에 러너가 처리한다.
 */
export function classifyRun(state: StreamState, exit: { code: number | null; signal: string | null }, stderr: string, options: ClassifyOptions = {}): ClassifiedRun {
  const limitPatterns = options.limitPatterns ?? DEFAULT_LIMIT_PATTERNS;
  const serverPatterns = options.serverLimitPatterns ?? DEFAULT_SERVER_LIMIT_PATTERNS;
  const r = state.result;
  const how = exit.signal !== null ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`;
  const tokens = r?.tokens ?? null;
  const estimatedUsd = r?.totalCostUsd ?? null;
  const fail = (code: string, message: string): ClassifiedRun => ({ ok: false, code, message: maskString(message).slice(0, 500), review: isClaudeCodeReviewCode(code), tokens, estimatedUsd });

  if (r === null) {
    // 결과 메시지가 없다: 옵션 오류·없는 MCP 파일은 JSON 없이 stderr 로만 나온다 (종료 코드 1). 재시도로 풀리지 않는 설정 오류다.
    const detail = stderr.trim().split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
    if (state.retryStatuses.includes(401) || LOGIN_PATTERNS.some((p) => p.test(stderr))) return fail('login_required', `the CLI could not authenticate (${how})`);
    return fail('cli_failed', `the CLI ended without a result message (${how})${detail === '' ? '' : `: ${detail}`}`);
  }

  const text = r.result ?? '';
  if (r.isError !== false) {
    // isError === null(필드 없음)도 오류로 본다: 성공이라고 단정할 근거가 없다
    if (r.apiErrorStatus === 401 || LOGIN_PATTERNS.some((p) => p.test(text))) return fail('login_required', `the CLI is not logged in or its login is no longer valid: ${text || `api_error_status ${String(r.apiErrorStatus)}`}`);
    if (limitPatterns.some((p) => p.test(text))) return fail('usage_limit', `the subscription usage limit was reached: ${text}`);
    if (r.apiErrorStatus === 429 || serverPatterns.some((p) => p.test(text))) return fail('server_limited', `the service is limiting requests: ${text || 'api_error_status 429'}`);
    if (r.terminalReason === 'budget_exhausted' || r.subtype === 'error_max_budget_usd') return fail('budget_exhausted', 'the CLI stopped at its estimated budget cap (--max-budget-usd)');
    // 오류인데 한도 상태가 막힘으로 보였으면 한도로 본다 (rate_limit_event.status 가 allowed 가 아님)
    if (state.rateLimitWorst !== null && /rejected|exceeded|blocked/i.test(state.rateLimitWorst.status ?? '')) {
      return fail('usage_limit', `the run failed while the rate limit status was '${state.rateLimitWorst.status}'`);
    }
    return fail('agent_error', `the CLI reported an error (terminal_reason=${r.terminalReason ?? '?'}, api_error_status=${String(r.apiErrorStatus)}, ${how}): ${text}`);
  }

  if (r.terminalReason !== null && r.terminalReason !== 'completed') return fail('incomplete', `the CLI stopped before completing (terminal_reason=${r.terminalReason})`);
  if (r.permissionDenials.length > 0) {
    const names = [...new Set(r.permissionDenials)].join(', ');
    return fail('permission_denied', `the agent tried tools it was not allowed to use (${r.permissionDenials.length} denied: ${names}); the result is not trusted`);
  }
  if (r.structuredOutput === null) return fail('no_structured_output', 'the CLI finished without a structured output');
  const parsed = (options.parseOutput ?? parseStructuredOutput)(r.structuredOutput);
  if (!parsed.ok) return fail('invalid_structured_output', parsed.message);
  return { ok: true, result: parsed.result, evidence: parsed.evidence, tokens, estimatedUsd };
}

/** `--json-schema` 에 넘기는 결과 스키마. 어댑터가 `{result, evidence}` 를 받아 `AdapterOutput` 으로 옮긴다 */
export function resultJsonSchema(): JsonObject {
  return {
    type: 'object',
    properties: {
      result: { type: 'object', description: 'The structured result of the task (a JSON object).' },
      evidence: {
        type: 'array',
        description: 'Evidence the result rests on.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...EVIDENCE_KINDS] },
            ref: { type: 'string' },
            content_hash: { type: 'string' },
          },
          required: ['kind', 'ref'],
          additionalProperties: false,
        },
      },
    },
    required: ['result'],
    additionalProperties: false,
  };
}
