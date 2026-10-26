// `claude -p` 프로세스 하나를 띄워 stream-json 을 끝까지 읽고 정리하는 부분. 실행 어댑터(adapter.ts)와 검증기(verifier.ts)가 함께 쓴다.
// 하는 일: 시작, stdin 처리, 출력 줄 파싱, init 격리 검사, 턴 수·출력 크기 상한, 취소, 종료·정리(SIGTERM → SIGKILL).
// 하지 않는 일: 결과 분류(`classifyRun`)와 `AdapterOutput`/판정으로의 변환 — 호출하는 쪽이 한다.
import { Buffer } from 'node:buffer';

import { type ProcessPort, type SpawnedProcess } from '../docker.ts';
import { type GatewayTimers } from '../gateway.ts';
import { createLineReader } from '../line-reader.ts';
import { maskString } from '../mask.ts';
import { applyStreamEvent, checkInit, newStreamState, parseStreamLine, summarizeStreamEvent, type ExpectedInit, type StreamState } from './stream.ts';

const MAX_RUN_LOG_LINES = 2000;

export interface ClaudeProcessOptions {
  claudePath: string;
  env: Readonly<Record<string, string>>;
  port: ProcessPort;
  timers: GatewayTimers;
  /** 서로 다른 assistant 메시지 수 상한 */
  maxTurns: number;
  /** 종료 신호 뒤 CLI 가 닫히기를 기다리는 시간 */
  closeGraceMs: number;
  maxStderrBytes: number;
  maxOutputBytes: number;
  maxLineBytes: number;
}

export interface ClaudeProcessRequest {
  args: readonly string[];
  cwd: string;
  expected: ExpectedInit;
  signal: AbortSignal;
  /** 프롬프트를 인자로 넘기지 않고 stdin 으로 줄 때의 본문. 없으면 stdin 을 바로 닫는다 */
  stdin?: string;
  /** run_log 에 한 줄 남긴다 (마스킹은 호출하는 쪽의 `note` 가 한다) */
  note(message: string): void;
}

export type ProcessEnding =
  | { kind: 'closed' }
  | { kind: 'spawn_error'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'turn_limit'; turns: number }
  | { kind: 'init_problem'; code: 'gateway_unavailable' | 'isolation_violation'; message: string }
  | { kind: 'output_limit'; message: string };

export interface ClaudeProcessResult {
  ending: ProcessEnding;
  state: StreamState;
  exit: { code: number | null; signal: string | null };
  /** 마스킹된 stderr */
  stderrText: string;
}

interface Deferred { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

export async function runClaudeProcess(options: ClaudeProcessOptions, request: ClaudeProcessRequest): Promise<ClaudeProcessResult> {
  const { note, signal } = request;
  const timers = options.timers;
  const state: StreamState = newStreamState();
  const seenMessages = new Set<string>();
  let logged = 0;
  let omitted = 0;
  let stderrText = '';
  let stderrTruncated = false;
  let totalBytes = 0;
  let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
  let ending: ProcessEnding | null = null;
  let isClosed = false;
  // `result` 메시지를 받은 뒤에도 CLI 가 닫히지 않으면 `closeGraceMs` 뒤에 정리 단계로 넘어간다(정리가 SIGTERM·SIGKILL 을 보낸다)
  let resultGraceHandle: unknown = null;
  const ended = deferred();
  const closed = deferred();
  const finish = (value: ProcessEnding): void => {
    if (ending !== null) return;
    ending = value;
    ended.resolve();
  };

  let proc: SpawnedProcess;
  try {
    proc = options.port.spawn(options.claudePath, request.args, { env: options.env, cwd: request.cwd });
  } catch (cause) {
    return { ending: { kind: 'spawn_error', message: cause instanceof Error ? cause.message : 'spawn failed' }, state, exit, stderrText };
  }
  if (request.stdin !== undefined) proc.writeStdin(request.stdin);
  proc.endStdin(); // `-p` 는 stdin 을 기다린다(경고 3초): 입력이 없으면 바로 닫는다
  note('claude started');

  proc.onStderr((chunk) => {
    if (stderrTruncated) return;
    const room = options.maxStderrBytes - Buffer.byteLength(stderrText, 'utf8');
    const text = chunk.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > room) {
      stderrText = maskString(stderrText + chunk.subarray(0, Math.max(0, room)).toString('utf8'));
      stderrTruncated = true;
    } else stderrText = maskString(stderrText + text);
  });
  proc.onError((cause) => {
    if (!isClosed) {
      isClosed = true;
      closed.resolve();
    }
    finish({ kind: 'spawn_error', message: cause.message });
  });
  proc.onClose((code, closeSignal) => {
    exit = { code, signal: closeSignal };
    isClosed = true;
    closed.resolve();
    finish({ kind: 'closed' });
  });

  const onEvent = (line: string): void => {
    const event = parseStreamLine(line);
    if (event === null) {
      if (logged < MAX_RUN_LOG_LINES) {
        logged += 1;
        note(`unparsed output line (${line.length} chars)`);
      } else omitted += 1;
      return;
    }
    const hadInit = state.init !== null;
    applyStreamEvent(state, event, seenMessages);
    const summary = summarizeStreamEvent(event);
    if (summary !== null) {
      if (logged < MAX_RUN_LOG_LINES) {
        logged += 1;
        note(summary);
      } else omitted += 1;
    }
    if (!hadInit && state.init !== null) {
      // 게이트웨이 연결 실패와 격리 위반은 종료 코드 0 이므로 init 에서만 드러난다. 기대와 다르면 진행하지 않는다
      const problems = checkInit(state.init, request.expected);
      if (problems.isolationProblems.length > 0) finish({ kind: 'init_problem', code: 'isolation_violation', message: `the CLI is not isolated as expected: ${problems.isolationProblems.join('; ')}` });
      else if (problems.gatewayProblems.length > 0) finish({ kind: 'init_problem', code: 'gateway_unavailable', message: problems.gatewayProblems.join('; ') });
    }
    if (state.result === null && state.assistantTurns > options.maxTurns) finish({ kind: 'turn_limit', turns: state.assistantTurns });
    if (state.result !== null && resultGraceHandle === null) resultGraceHandle = timers.setTimeout(() => finish({ kind: 'closed' }), options.closeGraceMs);
  };

  const reader = createLineReader(options.maxLineBytes);
  proc.onStdout((chunk) => {
    if (ending !== null) return;
    totalBytes += chunk.length;
    if (totalBytes > options.maxOutputBytes) return finish({ kind: 'output_limit', message: `the CLI wrote more than ${options.maxOutputBytes} bytes` });
    for (const event of reader.push(chunk)) {
      if (ending !== null) return;
      if (event.kind === 'too_long') return finish({ kind: 'output_limit', message: `an output line exceeded ${options.maxLineBytes} bytes` });
      onEvent(event.line);
    }
  });

  const onAbort = (): void => finish({ kind: 'cancelled' });
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  // `result` 메시지가 오면 CLI 가 곧 끝난다. 끝나기를 기다린다(아래 정리 단계가 상한을 건다)
  await ended.promise;
  signal.removeEventListener('abort', onAbort);
  if (resultGraceHandle !== null) timers.clearTimeout(resultGraceHandle);

  // ----- 정리: CLI 가 아직 살아 있으면 끝낸다 -----
  const settlesWithin = (promise: Promise<void>, ms: number): Promise<boolean> => new Promise((resolve) => {
    const handle = timers.setTimeout(() => resolve(false), ms);
    void promise.then(() => { timers.clearTimeout(handle); resolve(true); });
  });
  if (!isClosed) {
    proc.kill('SIGTERM');
    if (!(await settlesWithin(closed.promise, options.closeGraceMs))) {
      note(`claude did not exit ${options.closeGraceMs} ms after SIGTERM; sending SIGKILL`);
      proc.kill('SIGKILL');
      if (!(await settlesWithin(closed.promise, options.closeGraceMs))) note('claude could not be confirmed stopped');
    }
  }
  if (omitted > 0) note(`(${omitted} more output events were not logged)`);
  if (stderrText.trim() !== '') note(`stderr${stderrTruncated ? ' (truncated)' : ''}: ${stderrText.trim().slice(0, 600)}`);
  const final = ending as ProcessEnding | null;
  if (final === null) throw new Error('unreachable: the run ended without a reason');
  return { ending: final, state, exit, stderrText };
}
