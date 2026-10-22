// 컨테이너 샌드박스 실행기 (단계 A5 U3, 스파이크 Q26). 업무 하나를 `docker run -i` 컨테이너 안의 에이전트에게 맡기고 줄 단위 JSON 프레임으로만 통신한다.
//  1. 인자는 buildContainerArgs 의 고정 템플릿으로만 만든다. docker 는 설정값 절대 경로 + 환경 변수 화이트리스트로 spawn 한다(셸·PATH 탐색 없음).
//  2. 첫 프레임 `start`(입력 task_spec·허용 도구·근거·예산, 비밀 없음)를 stdin 에 쓴다. 이후 stdout 을 줄 단위로 읽어 parseFrame 으로 검증한다.
//     형식 오류·방향 위반·크기 초과(개행 전 누적 바이트 포함)·출력 상한 초과·id 중복 등은 즉시 `docker kill <이름>` 후 오류로 끝낸다.
//  3. tool_call 은 ToolGateway(U2)로 넘기고 tool_result 를 stdin 에 쓴다. cost_progress 는 콜백으로 전달한다. result 는 AdapterOutput 형태로 돌려준다.
//  4. 취소(AbortSignal)와 시간 제한은 `docker kill <이름>`(CLI 프로세스만 죽이지 않는다)로 끝내고 상태는 `cancelled` 다. 컨테이너가 아직 안 만들어졌을 수
//     있어 kill 은 CLI 가 살아 있는 동안 재시도한다. 끝난 뒤에는 `docker rm -f` 로 남은 컨테이너가 없게 한다.
//  5. 컨테이너 안 에이전트의 stderr 는 로그로만 모은다(상한, 비밀 가림). 프레임으로 해석하지 않는다.
// 이 파일은 시간 제한 정책·예산 강제를 모른다(U4). 시간 제한은 호출 인자(`timeLimitMs`)로만 받는다. Docker 를 쓸 수 없으면 오류로 끝내고 호스트 실행으로 대체하지 않는다.
import { Buffer } from 'node:buffer';

import type { Clock } from '@aot/domain';

import type { AdapterContext, AdapterCost, AdapterInput, AdapterOutput, RunLogEntry } from './contract.ts';
import { buildContainerArgs, type ContainerLimits } from './container-args.ts';
import type { DockerCli, SpawnedProcess } from './docker.ts';
import { encodeFrame, MAX_FRAME_BYTES, parseFrame, startFrameOf, type ResultFrame, type ToolCallFrame, type ToolResultFrame } from './frames.ts';
import { realGatewayTimers, type GatewayTimers } from './gateway.ts';
import { createLineReader } from './line-reader.ts';
import { maskString } from './mask.ts';

export interface ContainerRunnerOptions {
  docker: DockerCli;
  /** 이미지 ID `sha256:…` */
  image: string;
  limits: ContainerLimits;
  user?: { uid: number; gid: number };
  /** 이미지 뒤에 붙는 에이전트 인자(데몬 설정) */
  agentArgs?: readonly string[];
  /** 컨테이너 이름 = `<namePrefix>-<run_id>`. 기본 'aot-run' */
  namePrefix?: string;
  clock: Clock;
  timers?: GatewayTimers;
  /** 수집할 stderr 최대 바이트. 기본 64 KiB */
  maxStderrBytes?: number;
  /** 컨테이너가 보낼 수 있는 stdout 총량. 기본 32 MiB */
  maxOutputBytes?: number;
  /** 동시에 처리 중일 수 있는 tool_call 수. 기본 4 */
  maxInFlightToolCalls?: number;
  /** result 를 받은 뒤 컨테이너가 스스로 끝나기를 기다리는 시간. 지나면 kill. 기본 5000ms */
  exitGraceMs?: number;
  /** `docker kill` 이 실패했을 때(컨테이너가 아직 없음) 재시도 간격과 최대 횟수. 기본 100ms × 50 */
  killRetryMs?: number;
  killMaxAttempts?: number;
  /** kill 뒤 `docker run` CLI 가 닫히기를 기다리는 시간. 지나면 CLI 프로세스를 SIGKILL. 기본 5000ms */
  closeGraceMs?: number;
}

export interface ContainerRunOptions {
  /** 이 시간이 지나면 `docker kill` 로 끝내고 `cancelled`/`time_limit` 로 보고한다. 생략하면 제한 없음(취소 신호만) */
  timeLimitMs?: number;
}

export type ContainerEnd =
  /** 컨테이너가 유효한 result 프레임을 냈다 */
  | 'result'
  /** result 없이 컨테이너(CLI)가 끝났다 */
  | 'agent_exited'
  | 'cancelled'
  | 'time_limit'
  | 'protocol_violation'
  | 'docker_unavailable'
  /** 시작 전에 입력을 거부했다(컨테이너를 띄우지 않았다) */
  | 'start_rejected';

export interface ContainerRunReport {
  /** 어댑터 계약 형태의 출력 (validateAdapterOutput 을 통과한다) */
  output: AdapterOutput;
  end: ContainerEnd;
  containerName: string;
  exitCode: number | null;
  exitSignal: string | null;
  /** `docker kill` 이 성공했는가 */
  killed: boolean;
  /** protocol_violation 의 사유 코드 (`frame_<reject code>` 등) */
  violation?: string;
  /** 컨테이너 안 에이전트의 stderr(비밀 가림, 상한) */
  stderr: string;
  stderrTruncated: boolean;
  toolCalls: number;
}

export interface ContainerRunner {
  readonly name: string;
  containerNameFor(runId: string): string;
  run(input: AdapterInput, context: AdapterContext, options?: ContainerRunOptions): Promise<ContainerRunReport>;
}

type Ending =
  | { kind: 'result'; frame: ResultFrame }
  | { kind: 'agent_exited' }
  | { kind: 'cancelled' }
  | { kind: 'time_limit' }
  | { kind: 'protocol_violation'; code: string; message: string }
  | { kind: 'docker_unavailable'; message: string };

const NAME_FOR_RUN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

interface Deferred { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

export function createContainerRunner(options: ContainerRunnerOptions): ContainerRunner {
  const { docker, clock } = options;
  const timers = options.timers ?? realGatewayTimers;
  const namePrefix = options.namePrefix ?? 'aot-run';
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  const maxInFlight = options.maxInFlightToolCalls ?? 4;
  const exitGraceMs = options.exitGraceMs ?? 5000;
  const killRetryMs = options.killRetryMs ?? 100;
  const killMaxAttempts = options.killMaxAttempts ?? 50;
  const closeGraceMs = options.closeGraceMs ?? 5000;

  const containerNameFor = (runId: string): string => `${namePrefix}-${runId}`;
  const argsFor = (runId: string, name: string): string[] => buildContainerArgs({
    image: options.image, name, runId, limits: options.limits,
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.agentArgs === undefined ? {} : { agentArgs: options.agentArgs }),
  });
  // 설정 오류는 만들 때 던진다(운영에서 첫 업무가 실패한 뒤에야 알게 되지 않도록)
  argsFor('config-check', containerNameFor('config-check'));

  /** `promise` 가 `ms` 안에 끝나면 true */
  const settlesWithin = (promise: Promise<void>, ms: number): Promise<boolean> => new Promise((resolve) => {
    const handle = timers.setTimeout(() => resolve(false), ms);
    void promise.then(() => { timers.clearTimeout(handle); resolve(true); });
  });
  const exec = (args: readonly string[]) => docker.process.exec(docker.path, args, { env: docker.env, timeoutMs: docker.execTimeoutMs });

  async function run(input: AdapterInput, context: AdapterContext, runOptions: ContainerRunOptions = {}): Promise<ContainerRunReport> {
    const runLog: RunLogEntry[] = [];
    const note = (message: string): void => void runLog.push({ at: clock.nowIso(), message });
    const lastCost: AdapterCost = {};
    const costNow = (): AdapterCost => (lastCost.usd === undefined && lastCost.tokens === undefined ? { usd: 0 } : { ...lastCost });

    const runId = typeof input.run_id === 'string' ? input.run_id : '';
    const containerName = NAME_FOR_RUN.test(runId) ? containerNameFor(runId) : `${namePrefix}-invalid`;
    let stderrText = '';
    let stderrTruncated = false;
    let toolCalls = 0;
    let killed = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    const report = (end: ContainerEnd, output: AdapterOutput, extra: { violation?: string } = {}): ContainerRunReport => ({
      output, end, containerName, exitCode, exitSignal, killed, ...extra, stderr: stderrText, stderrTruncated, toolCalls,
    });
    const errorOutput = (code: string, message: string): AdapterOutput => ({
      status: 'error', result: null, evidence: [], run_log: runLog, cost: costNow(), error: { code, message },
    });
    const refuse = (message: string): ContainerRunReport => {
      note(`container not started: ${message}`);
      return report('start_rejected', errorOutput('start_rejected', message));
    };

    // ----- 시작 전 검사: 여기서 거부하면 컨테이너를 띄우지 않는다 -----
    if (!NAME_FOR_RUN.test(runId)) return refuse('run_id must be 1-80 letters, digits, "_", ".", "-" (it names the container)');
    const limit = runOptions.timeLimitMs;
    if (limit !== undefined && !(typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) return refuse('timeLimitMs must be a positive number');
    const start = startFrameOf(input);
    if (!start.ok) return refuse(`start frame rejected (${start.rejection.code}): ${start.rejection.message}`);
    const startLine = encodeFrame(start.frame);
    if (!startLine.ok) return refuse(`start frame rejected (${startLine.rejection.code}): ${startLine.rejection.message}`);
    if (context.signal.aborted) {
      note('cancelled before the container was started');
      return report('cancelled', { status: 'cancelled', result: null, evidence: [], run_log: runLog, cost: costNow() });
    }

    // ----- 시작 -----
    let proc: SpawnedProcess;
    try {
      proc = docker.process.spawn(docker.path, argsFor(runId, containerName), { env: docker.env });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'spawn failed';
      note(`docker could not be started: ${message}`);
      return report('docker_unavailable', errorOutput('docker_unavailable', `docker could not be started (agent work is not run on the host): ${message}`));
    }
    note(`container ${containerName} starting`);

    let ending: Ending | null = null;
    const ended = deferred();
    const closed = deferred();
    let isClosed = false;
    let spawnError: string | null = null;
    let stdinOpen = true;
    const inFlight = new Set<number>();

    const finish = (value: Ending): void => {
      if (ending !== null) return;
      ending = value;
      ended.resolve();
    };
    const violate = (code: string, message: string): void => finish({ kind: 'protocol_violation', code, message });
    const writeFrame = (frame: unknown): boolean => {
      if (!stdinOpen) return false;
      const encoded = encodeFrame(frame);
      if (!encoded.ok) return false;
      proc.writeStdin(`${encoded.line}\n`);
      return true;
    };
    const closeStdin = (): void => {
      if (!stdinOpen) return;
      stdinOpen = false;
      proc.endStdin();
    };

    proc.onStderr((chunk) => {
      if (stderrTruncated) return;
      const room = maxStderrBytes - Buffer.byteLength(stderrText, 'utf8');
      const text = chunk.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > room) {
        stderrText = maskString(stderrText + chunk.subarray(0, Math.max(0, room)).toString('utf8'));
        stderrTruncated = true;
      } else stderrText = maskString(stderrText + text);
    });
    proc.onError((error) => {
      spawnError = error.message;
      if (!isClosed) {
        isClosed = true;
        closed.resolve();
      }
      finish({ kind: 'docker_unavailable', message: error.message });
    });
    proc.onClose((code, signal) => {
      exitCode = code;
      exitSignal = signal;
      isClosed = true;
      closed.resolve();
      finish({ kind: 'agent_exited' });
    });

    const reader = createLineReader(MAX_FRAME_BYTES);
    let totalBytes = 0;
    proc.onStdout((chunk) => {
      if (ending !== null) return; // result·위반·취소 뒤의 출력은 읽지 않는다
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) return violate('output_limit', `the container wrote more than ${maxOutputBytes} bytes`);
      for (const event of reader.push(chunk)) {
        if (ending !== null) return;
        if (event.kind === 'too_long') return violate('frame_too_large', `a line exceeded ${MAX_FRAME_BYTES} bytes before its newline`);
        handleLine(event.line);
      }
    });

    function handleLine(line: string): void {
      const parsed = parseFrame(line, 'agent_to_host');
      if (!parsed.ok) return violate(`frame_${parsed.rejection.code}`, parsed.rejection.message);
      const frame = parsed.frame;
      switch (frame.type) {
        case 'tool_call': return dispatchToolCall(frame);
        case 'cost_progress':
          lastCost[frame.unit] = frame.cumulative;
          try {
            context.onCostProgress({ cumulative: frame.cumulative, unit: frame.unit });
          } catch {
            // 보고 콜백(실행 관리)의 예외가 프레임 처리를 깨뜨리지 않게 한다
          }
          return;
        case 'result': return finish({ kind: 'result', frame });
        default: return violate('frame_unexpected_direction', `'${frame.type}' frames are not accepted from the container`);
      }
    }

    function dispatchToolCall(frame: ToolCallFrame): void {
      if (inFlight.has(frame.id)) return violate('duplicate_tool_call_id', `tool_call id ${frame.id} is already in flight`);
      if (inFlight.size >= maxInFlight) return violate('too_many_tool_calls', `more than ${maxInFlight} tool calls in flight`);
      inFlight.add(frame.id);
      toolCalls += 1;
      void (async () => {
        let reply: ToolResultFrame;
        try {
          const response = await context.gateway.call(frame.tool, frame.args);
          reply = response.ok ? { type: 'tool_result', id: frame.id, result: response.result } : { type: 'tool_result', id: frame.id, error: response.error };
        } catch {
          reply = { type: 'tool_result', id: frame.id, error: 'gateway_error' };
        }
        inFlight.delete(frame.id);
        if (ending !== null) return; // 끝난 뒤에는 답을 쓰지 않는다
        if (!writeFrame(reply)) writeFrame({ type: 'tool_result', id: frame.id, error: 'tool_result_invalid' });
      })();
    }

    // 프레임 처리기는 위에서 이어 붙였다. 이제 시작 프레임을 쓰고 취소·시간 제한을 건다.
    writeFrame(start.frame);
    const onAbort = (): void => finish({ kind: 'cancelled' });
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    const limitHandle = limit === undefined ? null : timers.setTimeout(() => finish({ kind: 'time_limit' }), limit);

    await ended.promise;
    context.signal.removeEventListener('abort', onAbort);
    if (limitHandle !== null) timers.clearTimeout(limitHandle);
    const final = ending as Ending | null;
    if (final === null) throw new Error('unreachable: the run ended without a reason');

    // ----- 끝내기: 컨테이너를 반드시 없앤다 -----
    let killedBySignal = false;
    const killContainer = async (): Promise<void> => {
      for (let attempt = 1; attempt <= killMaxAttempts; attempt += 1) {
        const result = await exec(['kill', containerName]);
        if (result.code === 0) {
          killed = true;
          note(`docker kill ${containerName} succeeded`);
          return;
        }
        // CLI 가 이미 끝났으면 기다려도 컨테이너가 새로 생기지 않는다
        if (isClosed) break;
        // 재시도 간격 동안 CLI 가 닫히면(컨테이너가 안 생겼거나 이미 끝남) 더 시도하지 않는다
        if (attempt < killMaxAttempts && (await settlesWithin(closed.promise, killRetryMs))) break;
      }
      note(`docker kill ${containerName} did not succeed${isClosed ? '' : ' (gave up retrying)'}`);
    };
    const waitClosed = async (): Promise<void> => {
      if (isClosed) return;
      if (await settlesWithin(closed.promise, closeGraceMs)) return;
      killedBySignal = true;
      proc.kill('SIGKILL');
      await settlesWithin(closed.promise, closeGraceMs);
    };

    switch (final.kind) {
      case 'result':
        closeStdin(); // 협조적 에이전트는 stdin EOF 로 끝난다
        if (!(await settlesWithin(closed.promise, exitGraceMs))) {
          note(`the container did not exit ${exitGraceMs} ms after its result; killing it`);
          await killContainer();
        }
        break;
      case 'agent_exited':
      case 'docker_unavailable':
        break; // CLI 가 이미 끝났다. 아래 rm -f 로 남은 컨테이너(CLI 만 죽은 경우)를 없앤다
      default:
        // 취소·시간 제한·위반: 곧바로 kill 한다. stdin 을 먼저 닫으면 협조적 에이전트가 스스로 끝나 kill 이 "이미 끝남"으로 어긋난다
        await killContainer();
    }
    await waitClosed();
    if (killedBySignal) note('the docker CLI process had to be killed after the container kill');
    // `--rm` 이 늦거나 CLI 가 먼저 죽은 경우를 위해 이름으로 한 번 더 없앤다 (없으면 무해한 오류)
    const removal = await exec(['rm', '-f', containerName]);
    if (removal.code === 0) note(`docker rm -f ${containerName}: removed a leftover container`);

    // ----- 결과 -----
    switch (final.kind) {
      case 'result': {
        const { type: _type, ...output } = final.frame;
        void _type;
        note(`container ${containerName} returned a result`);
        return report('result', { ...output, run_log: [...output.run_log, ...runLog] });
      }
      case 'cancelled':
        note('cancelled: container killed');
        return report('cancelled', { status: 'cancelled', result: null, evidence: [], run_log: runLog, cost: costNow() });
      case 'time_limit':
        note(`time limit of ${String(limit)} ms exceeded: container killed`);
        return report('time_limit', { status: 'cancelled', result: null, evidence: [], run_log: runLog, cost: costNow() });
      case 'protocol_violation':
        note(`protocol violation (${final.code}): container killed`);
        return report('protocol_violation', errorOutput('protocol_violation', `${final.code}: ${final.message}`), { violation: final.code });
      case 'docker_unavailable': {
        note(`docker could not be started: ${final.message}`);
        return report('docker_unavailable', errorOutput('docker_unavailable', `docker is unavailable (agent work is not run on the host): ${spawnError ?? final.message}`.slice(0, 500)));
      }
      case 'agent_exited': {
        const how = exitSignal !== null ? `signal ${exitSignal}` : `exit code ${String(exitCode)}`;
        note(`container ${containerName} ended without a result (${how})`);
        // docker run 자체의 실패(125: 데몬 오류, 126·127: 명령 실행 불가)는 시작 실패로 구분한다
        const startFailed = exitCode === 125 || exitCode === 126 || exitCode === 127;
        return report('agent_exited', errorOutput(startFailed ? 'container_start_failed' : 'agent_exited', `the container ended without a result (${how})`));
      }
    }
  }

  return { name: 'container-sandbox', containerNameFor, run };
}
