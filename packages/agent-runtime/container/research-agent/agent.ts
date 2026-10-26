// 읽기 전용 조사 에이전트의 컨테이너 진입점 (단계 A5 U5). 프레임 입출력만 한다: 판단은 core.ts 다.
//  - stdin 첫 줄 `start` 프레임을 읽고, 게이트웨이 도구 `fetch_url` 호출(`tool_call` 프레임)과 그 응답(`tool_result` 프레임)을 주고받고, `cost_progress` 와 `result` 프레임을 낸다.
//  - stdout 에는 프레임만 쓴다. 로그는 stderr 다. 환경 변수·파일·네트워크·자식 프로세스를 쓰지 않는다(컨테이너에는 어차피 없다).
//  - 도구 이름은 이 파일에서 리터럴 'fetch_url' 하나뿐이다. 응답·페이지 텍스트로 도구 이름이나 인자를 정하는 코드 경로가 없다.
//  - stdin 이 result 전에 닫히면(호스트가 취소) 종료 코드 3 으로 끝난다. 시간 제한·예산 초과는 호스트가 `docker kill` 한다.
import { createLineReader } from '../../src/line-reader.ts';
import { MAX_FRAME_BYTES } from '../../src/wire.ts';

import { FETCH_TOOL, runResearch, type Json, type JsonObject, type StartInfo, type ToolReply } from './core.ts';

const stderr = (message: string): void => void process.stderr.write(`[research-agent] ${message}\n`);

const pending = new Map<number, (reply: ToolReply) => void>();
let nextId = 1;
let finished = false;
let onStart: ((start: StartInfo) => void) | null = null;
const started = new Promise<StartInfo>((resolve) => { onStart = resolve; });
let sawStart = false;

function send(frame: JsonObject): Promise<void> {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('outgoing frame is too large');
  return new Promise((resolve) => void process.stdout.write(`${line}\n`, () => resolve()));
}

/** 게이트웨이 호출 하나: tool_call 프레임을 보내고 같은 id 의 tool_result 를 기다린다 */
function call(tool: string, args: JsonObject): Promise<ToolReply> {
  const id = nextId;
  nextId += 1;
  return new Promise<ToolReply>((resolve) => {
    pending.set(id, resolve);
    void send({ type: 'tool_call', id, tool, args });
  });
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function startInfoOf(frame: JsonObject): StartInfo | null {
  const { run_id: runId, task_spec: spec, allowed_tools: tools } = frame;
  if (typeof runId !== 'string' || !isObject(spec) || !Array.isArray(tools)) return null;
  const allowed: StartInfo['allowed_tools'] = [];
  for (const tool of tools) {
    if (!isObject(tool) || typeof tool['tool'] !== 'string' || !Array.isArray(tool['operations'])) return null;
    allowed.push({ tool: tool['tool'], operations: tool['operations'].filter((op): op is string => typeof op === 'string') });
  }
  return { run_id: runId, task_spec: spec, allowed_tools: allowed };
}

function handle(line: string): void {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    stderr('a line from the host was not JSON; exiting');
    process.exit(2);
  }
  if (!isObject(frame)) {
    stderr('a frame from the host was not an object; exiting');
    process.exit(2);
  }
  if (frame['type'] === 'start' && !sawStart) {
    sawStart = true;
    const info = startInfoOf(frame);
    if (info === null) {
      stderr('the start frame is malformed; exiting');
      process.exit(2);
    }
    onStart?.(info);
  } else if (frame['type'] === 'tool_result') {
    const id = frame['id'];
    const waiter = typeof id === 'number' ? pending.get(id) : undefined;
    if (waiter === undefined) return; // 모르는 id 는 무시한다
    pending.delete(id as number);
    const error = frame['error'];
    if (typeof error === 'string') waiter({ ok: false, error });
    else if ('result' in frame) waiter({ ok: true, result: frame['result'] as Json });
    else waiter({ ok: false, error: 'invalid_tool_result' });
  }
  // 그 밖의 프레임은 무시한다
}

const reader = createLineReader(MAX_FRAME_BYTES);
process.stdin.on('data', (chunk: Buffer) => {
  for (const event of reader.push(chunk)) {
    if (event.kind === 'too_long') {
      stderr('a line from the host was too long; exiting');
      process.exit(2);
    }
    handle(event.line);
  }
});
process.stdin.on('end', () => {
  if (!finished) {
    stderr('stdin closed before the result; exiting');
    process.exit(3);
  }
});

const start = await started;
const output = await runResearch({
  start,
  fetchUrl: (url) => call(FETCH_TOOL, { url }),
  now: () => new Date().toISOString(),
  reportCost: (cumulative) => void send({ type: 'cost_progress', cumulative, unit: 'usd' }),
  log: stderr,
});
finished = true;
await send({ type: 'result', ...output } as unknown as JsonObject);
process.exit(0);
