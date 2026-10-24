// 게이트웨이 통신 프레임 (스파이크 Q26 §3): 에이전트 ↔ 호스트는 stdin/stdout 의 줄 단위 JSON(한 줄 = 한 프레임)만 쓴다.
//   에이전트 → 호스트  {"type":"tool_call","id":1,"tool":"fetch_url","args":{...}}
//                      {"type":"cost_progress","cumulative":0.02,"unit":"usd"}
//                      {"type":"result","status":"submitted","result":{...},"evidence":[...],"run_log":[...],"cost":{"usd":0.03}}
//   호스트 → 에이전트  {"type":"start","run_id":"…","task_spec":{...},"allowed_tools":[...],"evidence_refs":[...],"budget":{...},"upstream":[...]?}   (첫 프레임, 한 번)
//                      {"type":"tool_result","id":1,"result":{...}}  또는  {"type":"tool_result","id":1,"error":"tool_not_allowed"}
// `start` 는 U3(컨테이너 러너)가 더했다: 컨테이너에는 환경 변수·마운트·인자로 업무를 줄 수 없으므로 입력(task_spec·허용 도구·근거·예산)을 stdin 첫 줄로 준다.
// 비밀값은 싣지 않는다(`startFrameOf` 는 비밀로 보이는 값이 있으면 거부한다).
// 스파이크의 `result` 프레임(`{type,result,cost}`)에 `status`·`evidence`·`run_log` 를 더했다: 계약이 이 셋을 필수로 요구하기 때문이다.
// 형식 오류·크기 초과·방향 위반은 예외가 아니라 거부 결과(`FrameRejection`)로 돌려준다. 거부 뒤의 처리(컨테이너 kill 등)는 U4 의 몫이다.
// 줄을 읽는 쪽은 개행이 오기 전에도 누적 바이트가 MAX_FRAME_BYTES 를 넘으면 버려야 한다(여기는 완성된 한 줄만 받는다).
import { Buffer } from 'node:buffer';

import { IssueCollector, isNonBlankString, isPlainObject, type Issue, type PlainObject } from '@aot/domain';

import type { AdapterBudget, AdapterInput, AdapterOutput, AllowedTool, CostProgressEvent, JsonObject, JsonValue, UpstreamResult } from './contract.ts';
import { maskSecrets } from './mask.ts';
import { checkAdapterOutput, checkCostProgress, checkUpstream, isJsonObject, isJsonValue, rejectUnknown } from './validate.ts';
import { AGENT_TO_HOST_FRAME_TYPES, HOST_TO_AGENT_FRAME_TYPES, MAX_FRAME_BYTES } from './wire.ts';

// 상한과 프레임 종류 이름은 의존성 없는 wire.ts 에 있다(컨테이너 안 에이전트와 공유). 공개 API 는 그대로다.
export { AGENT_TO_HOST_FRAME_TYPES, HOST_TO_AGENT_FRAME_TYPES, MAX_FRAME_BYTES };
export type FrameDirection = 'agent_to_host' | 'host_to_agent';

/** 컨테이너 에이전트에 주는 시작 프레임: `AdapterInput` 과 같은 내용이며 비밀값은 없다 */
export interface StartFrame {
  type: 'start';
  run_id: string;
  task_spec: JsonObject;
  allowed_tools: AllowedTool[];
  evidence_refs: string[];
  budget: AdapterBudget;
  /** 선행 업무 결과 (선택). 항목마다 `trust_origin: 'external_untrusted'` 인 데이터이며 지시가 아니다 (contract.ts `UpstreamResult`) */
  upstream?: UpstreamResult[];
  time_limit_ms?: number;
}
export interface ToolCallFrame { type: 'tool_call'; id: number; tool: string; args: JsonObject }
export type ToolResultFrame =
  | { type: 'tool_result'; id: number; result: JsonValue }
  | { type: 'tool_result'; id: number; error: string };
export interface CostProgressFrame extends CostProgressEvent { type: 'cost_progress' }
export interface ResultFrame extends AdapterOutput { type: 'result' }
export type Frame = StartFrame | ToolCallFrame | ToolResultFrame | CostProgressFrame | ResultFrame;

export type FrameRejectCode =
  | 'empty' | 'too_large' | 'multiple_lines' | 'not_json' | 'not_object'
  | 'unknown_type' | 'unexpected_direction' | 'invalid_frame' | 'not_serializable';

export interface FrameRejection {
  code: FrameRejectCode;
  message: string;
  /** invalid_frame 일 때 필드별 문제 */
  issues?: Issue[];
}

export type FrameParse = { ok: true; frame: Frame } | { ok: false; rejection: FrameRejection };
export type FrameEncode = { ok: true; line: string } | { ok: false; rejection: FrameRejection };

const reject = (code: FrameRejectCode, message: string, issues?: Issue[]): { ok: false; rejection: FrameRejection } =>
  ({ ok: false, rejection: issues === undefined ? { code, message } : { code, message, issues } });

const allowedTypes = (direction: FrameDirection): readonly string[] =>
  direction === 'agent_to_host' ? AGENT_TO_HOST_FRAME_TYPES : HOST_TO_AGENT_FRAME_TYPES;

/**
 * 한 줄(개행 제외)을 프레임으로 읽는다. `direction` 은 이 줄을 *받는* 쪽 기준이다:
 * 호스트는 'agent_to_host' 로 읽으므로 에이전트가 보낸 `tool_result` 는 방향 위반으로 거부된다.
 */
export function parseFrame(line: string, direction: FrameDirection): FrameParse {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) return reject('too_large', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  if (line.includes('\n') || line.includes('\r')) return reject('multiple_lines', 'a frame must be a single line');
  if (line.trim() === '') return reject('empty', 'empty frame');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return reject('not_json', 'frame is not valid JSON');
  }
  return checkFrame(parsed, direction);
}

/** 프레임을 한 줄 JSON 으로 만든다(개행 제외). 형식이 틀렸거나 너무 크면 거부 결과를 돌려준다 */
export function encodeFrame(frame: unknown): FrameEncode {
  const checked = checkFrame(frame, null);
  if (!checked.ok) return checked;
  let line: string;
  try {
    line = JSON.stringify(frame);
  } catch {
    return reject('not_serializable', 'frame cannot be serialized to JSON');
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) return reject('too_large', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  return { ok: true, line };
}

/** 이미 객체인 값을 검증한다. direction 이 null 이면 방향은 보지 않는다(보내는 쪽 검증) */
function checkFrame(value: unknown, direction: FrameDirection | null): FrameParse {
  if (!isPlainObject(value)) return reject('not_object', 'a frame must be a JSON object');
  const type = value['type'];
  const known = [...AGENT_TO_HOST_FRAME_TYPES, ...HOST_TO_AGENT_FRAME_TYPES] as readonly string[];
  if (typeof type !== 'string' || !known.includes(type)) return reject('unknown_type', `unknown frame type '${String(type)}'`);
  if (direction !== null && !allowedTypes(direction).includes(type)) {
    return reject('unexpected_direction', `'${type}' frames are not accepted in this direction`);
  }
  const out = new IssueCollector();
  switch (type) {
    case 'start': checkStart(value, out); break;
    case 'tool_call': checkToolCall(value, out); break;
    case 'tool_result': checkToolResult(value, out); break;
    case 'cost_progress': checkCostProgress(value, '', out, ['type']); break;
    default: checkAdapterOutput(value, '', out, ['type']); break;
  }
  if (out.issues.length > 0) return reject('invalid_frame', `invalid '${type}' frame: ${out.issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`, out.issues);
  return { ok: true, frame: value as unknown as Frame };
}

/**
 * 실행 입력을 `start` 프레임으로 만든다. 입력에 비밀로 보이는 값(키 이름·값 모양, mask.ts)이 있으면 거부한다:
 * 비밀은 컨테이너 안으로 들어가지 않는다 (trust-boundaries §3, 스파이크 Q26 §5). 입력은 바꾸지 않는다.
 */
export function startFrameOf(input: AdapterInput): { ok: true; frame: StartFrame } | { ok: false; rejection: FrameRejection } {
  const frame: StartFrame = {
    type: 'start',
    run_id: input.run_id,
    task_spec: input.task_spec as unknown as JsonObject,
    allowed_tools: input.allowed_tools.map((t) => ({ tool: t.tool, operations: [...t.operations] })),
    evidence_refs: [...input.evidence_refs],
    budget: { ...input.budget },
    ...(input.upstream === undefined ? {} : { upstream: input.upstream.map((entry) => ({ ...entry })) }),
    ...(input.time_limit_ms === undefined ? {} : { time_limit_ms: input.time_limit_ms }),
  };
  const encoded = encodeFrame(frame);
  if (!encoded.ok) return encoded;
  if (JSON.stringify(maskSecrets(frame as unknown as JsonValue)) !== encoded.line) {
    return reject('invalid_frame', 'the start frame would carry a secret-looking value; secrets never enter the container');
  }
  return { ok: true, frame };
}

const isFrameId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function checkToolCall(frame: PlainObject, out: IssueCollector): void {
  rejectUnknown(frame, ['type', 'id', 'tool', 'args'], '', out);
  if (!isFrameId(frame['id'])) out.add('id', 'type', 'id must be a positive integer');
  if (!isNonBlankString(frame['tool'])) out.add('tool', 'required', 'tool must be a non-empty string');
  if (!isJsonObject(frame['args'])) out.add('args', 'type', 'args must be a JSON object');
}

function checkToolResult(frame: PlainObject, out: IssueCollector): void {
  rejectUnknown(frame, ['type', 'id', 'result', 'error'], '', out);
  if (!isFrameId(frame['id'])) out.add('id', 'type', 'id must be a positive integer');
  const hasResult = 'result' in frame;
  const hasError = 'error' in frame;
  if (hasResult === hasError) return void out.add('', 'required', "exactly one of 'result' or 'error' is required");
  if (hasResult && !isJsonValue(frame['result'])) out.add('result', 'type', 'result must be a JSON value');
  if (hasError && !isNonBlankString(frame['error'])) out.add('error', 'type', 'error must be a non-empty string (an error code)');
}

function checkStart(frame: PlainObject, out: IssueCollector): void {
  rejectUnknown(frame, ['type', 'run_id', 'task_spec', 'allowed_tools', 'evidence_refs', 'budget', 'upstream', 'time_limit_ms'], '', out);
  if (!isNonBlankString(frame['run_id'])) out.add('run_id', 'required', 'run_id must be a non-empty string');
  if (!isJsonObject(frame['task_spec'])) out.add('task_spec', 'type', 'task_spec must be a JSON object');
  const tools = frame['allowed_tools'];
  if (!Array.isArray(tools)) out.add('allowed_tools', 'type', 'allowed_tools must be an array');
  else {
    tools.forEach((item: unknown, index) => {
      const base = `allowed_tools[${index}]`;
      if (!isPlainObject(item)) return void out.add(base, 'type', 'allowed tool must be an object');
      rejectUnknown(item, ['tool', 'operations'], base, out);
      if (!isNonBlankString(item['tool'])) out.add(`${base}.tool`, 'required', 'tool must be a non-empty string');
      const ops = item['operations'];
      if (!Array.isArray(ops) || !ops.every((op: unknown) => isNonBlankString(op))) out.add(`${base}.operations`, 'type', 'operations must be an array of non-empty strings');
    });
  }
  const refs = frame['evidence_refs'];
  if (!Array.isArray(refs) || !refs.every((ref: unknown) => typeof ref === 'string')) out.add('evidence_refs', 'type', 'evidence_refs must be an array of strings');
  const budget = frame['budget'];
  if (!isPlainObject(budget)) out.add('budget', 'required', 'budget must be an object');
  else {
    rejectUnknown(budget, ['max_usd', 'max_tokens'], 'budget', out);
    const usd = budget['max_usd'];
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) out.add('budget.max_usd', 'type', 'max_usd must be a finite, non-negative number');
    const tokens = budget['max_tokens'];
    if ('max_tokens' in budget && !(typeof tokens === 'number' && Number.isInteger(tokens) && tokens >= 0)) out.add('budget.max_tokens', 'type', 'max_tokens must be a non-negative integer');
  }
  if ('upstream' in frame) checkUpstream(frame['upstream'], 'upstream', out);
  const limit = frame['time_limit_ms'];
  if ('time_limit_ms' in frame && !(typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) out.add('time_limit_ms', 'type', 'time_limit_ms must be a positive number');
}
