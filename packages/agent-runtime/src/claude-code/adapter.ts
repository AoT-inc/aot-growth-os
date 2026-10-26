// `claude-code-cli` 어댑터 (CC1~CC3, ADR-0005 Amendment 2026-10-25·2026-10-26). 구독으로 로그인된 사용자 PC 의 공식 `claude` CLI 를 `claude -p` 로 실행해 업무 하나를 맡긴다.
// 호출 모양은 스파이크 Q4 §3(invocation.ts), 결과 분류는 §4.1 (stream.ts). 이 파일은 둘을 프로세스·파일·소켓과 잇는다.
//
// 가드레일 5개 (스파이크 Q4 "결정", 2026-10-26) — 설계 제약이며 풀지 않는다:
//  1. 토큰·로그인 정보 비접촉: 환경은 `HOME USER LOGNAME PATH` 뿐이고(`buildClaudeEnv`), `setup-token`·`CLAUDE_CODE_OAUTH_TOKEN`·API 키를 만들거나 넘기는 경로가 없다.
//  2. 본인 PC·본인 구독·계정 공유/교대 금지: 어댑터는 계정을 고르지 않는다(데몬 OS 계정의 로그인 하나). 동시 실행은 `maxConcurrent`(기본 1)로 제한한다.
//  3. 호스팅 금지: 코드로 강제할 수 없는 운영 규칙이다(문서 handoff·operations 에 적는다).
//  4. 첫 실행 고지 동의: `consent` 가 없으면 CLI 를 띄우지 않고 `consent_required` 로 끝낸다. 동의를 *받는* 곳은 이 어댑터의 일이 아니다(데몬의 승인 CLI `consent`, apps/daemon/src/consent.ts).
//  5. API 키 + `--bare` 대안 어댑터: 이 어댑터와 별개의 후속 어댑터다(이 파일은 `--bare` 를 쓰지 않는다).
//
// 시작 전에 거부하는 것(CLI 를 띄우지 않는다): 동의 없음, 잘못된 run_id·도구 이름, 비밀로 보이는 값이 든 입력, 너무 긴 프롬프트, CLI 를 못 찾음/실행 불가(`cli_unavailable`).
// 시작 뒤 어댑터가 직접 끝내는 것: 취소(SIGTERM), init 이벤트가 격리 기대와 다름(`isolation_violation`·`gateway_unavailable`), 턴 한도(`turn_limit_exceeded`), 출력 상한.
// 그 밖에는 CLI 가 낸 `result` 메시지를 JSON 필드로 분류한다(`classifyRun`). 종료 코드는 쓰지 않는다.
import { Buffer } from 'node:buffer';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Clock } from '@aot/domain';

import type { AdapterContext, AdapterCost, AllowedTool, AdapterInput, AdapterOutput, AgentAdapter, EvidenceItem, RunLogEntry } from '../contract.ts';
import { nodeProcessPort, type ProcessPort } from '../docker.ts';
import { startFrameOf } from '../frames.ts';
import { realGatewayTimers, type GatewayTimers } from '../gateway.ts';
import { maskString } from '../mask.ts';
import { createClaudeCodeGate, type ClaudeCodeGate } from './gate.ts';
import { serveGatewaySocket, type GatewaySocket } from './gateway-socket.ts';
import {
  buildBridgeTools, buildClaudeArgs, buildClaudeEnv, buildMcpConfig, buildPrompt, buildWorkdirFiles, BUILTIN_TOOLS, GATEWAY_TOOL_NAME, mcpToolName, TASK_INSTRUCTIONS,
  GATEWAY_SERVER_NAME, type ClaudeEnvInput,
} from './invocation.ts';
import { runClaudeProcess } from './process-run.ts';
import { classifyRun } from './stream.ts';

/** `task_run.adapter` 에 기록되는 이름 */
export const CLAUDE_CODE_ADAPTER_NAME = 'claude-code-cli';

/** 첫 실행 고지에 동의했다는 기록. 고지 문구의 판(`notice_version`)과 시각을 남긴다 */
export interface ClaudeCodeConsent {
  notice_version: string;
  /** Clock.nowIso() 형식 */
  accepted_at: string;
}

export interface ClaudeCodeCliOptions {
  /** `claude` 실행 파일의 절대 경로. PATH 에서 찾지 않는다 */
  claudePath: string;
  /** run 별 디렉터리를 만드는 절대 경로 (소켓 경로 길이 때문에 짧게). 데몬 전용 OS 계정만 쓸 수 있어야 한다 */
  runRoot: string;
  env: ClaudeEnvInput;
  /**
   * 가드레일 4. null 이면 모든 run 이 `consent_required` 로 끝난다. 함수면 run 을 시작할 때마다 부른다 —
   * 데몬은 승인 CLI 로 받은 동의 기록을 읽는 함수를 넘겨서, 동의·철회가 데몬 재시작 없이 다음 run 부터 적용된다
   */
  consent: ClaudeCodeConsent | null | (() => ClaudeCodeConsent | null);
  clock: Clock;
  process?: ProcessPort;
  /** 브리지를 실행할 node. 기본 데몬의 node */
  nodePath?: string;
  /** 브리지 스크립트 경로. 기본: 이 패키지의 gateway-mcp-bridge.ts */
  bridgePath?: string;
  timers?: GatewayTimers;
  /** 서로 다른 assistant 메시지 수 상한. 2.1.263 에는 `--max-turns` 가 없어 직접 센다. 기본 40 */
  maxTurns?: number;
  /** `--max-budget-usd` (정가 환산 추정치 기준 상한). 기본 끔 — 쓸지는 열린 결정 */
  maxBudgetUsd?: number;
  model?: string;
  /** 게이트웨이 도구별 설명(`tools/list` 에 실린다). 생략하면 일반 문구 */
  toolDescriptions?: Readonly<Record<string, string>>;
  /** 사용량 한도 문구 (미확인: 한 건 관찰한 뒤 확정). 생략하면 `DEFAULT_LIMIT_PATTERNS` */
  limitPatterns?: readonly RegExp[];
  serverLimitPatterns?: readonly RegExp[];
  /** `rate_limit_event` 사용률이 이 값 이상이면 run_log 에 한도 접근 경고를 남긴다. 0~1 또는 0~100 어느 쪽으로 보고되든 같은 비교를 한다. 기본 0.8 */
  warnUtilization?: number;
  /**
   * 사람 우선 게이트: 직전 run 이 본 창별 사용률이 여기 적은 값 이상이면(그 창이 아직 리셋되지 않았을 때) 새 run 을 시작하지 않고
   * `usage_deferred` 로 끝낸다(CLI 를 띄우지 않으므로 사용량을 쓰지 않는다). 구독 한도를 사람이 직접 쓰는 에이전트와 나눠 쓰기 때문이다.
   * 창 이름은 `rate_limit_event.unifiedWindows` 의 키(`five_hour`, `seven_day`). 0~1 (1 을 넘으면 퍼센트). 기본 꺼짐.
   * 사용률은 메모리에만 두므로 데몬을 다시 띄우면 첫 run 이 측정한다. 리셋 시각을 모르면 읽은 지 15분 뒤에 낡은 값으로 본다. `gate` 를 주면 무시한다.
   */
  yieldUtilization?: Readonly<Record<string, number>>;
  /** 동시 실행 수 (가드레일 2). 기본 1. `gate` 를 주면 무시한다 */
  maxConcurrent?: number;
  /**
   * 구독 풀을 쓰는 다른 호출(검증기)과 나눠 쓰는 게이트. 주면 `maxConcurrent`·`yieldUtilization` 대신 이 게이트의 한도를 쓴다 (Q22 d).
   * 생략하면 이 어댑터만 쓰는 게이트를 `maxConcurrent`·`yieldUtilization` 으로 만든다.
   */
  gate?: ClaudeCodeGate;
  /** run 디렉터리를 끝난 뒤에도 남긴다(디버깅). 기본 false */
  keepRunDir?: boolean;
  versionTimeoutMs?: number;
  /** 종료 신호 뒤 CLI 가 닫히기를 기다리는 시간. 기본 5000 */
  closeGraceMs?: number;
  maxStderrBytes?: number;
  /** CLI 가 낼 수 있는 stdout 총량. 기본 64 MiB */
  maxOutputBytes?: number;
  /** 줄 하나의 최대 바이트. 기본 8 MiB (도구 결과가 든 이벤트가 크다) */
  maxLineBytes?: number;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** 리눅스의 인자 하나 상한은 128 KiB 다. 여유를 둔다 */
const MAX_PROMPT_BYTES = 100_000;

export function createClaudeCodeCliAdapter(options: ClaudeCodeCliOptions): AgentAdapter {
  if (!isAbsolute(options.claudePath) || /[\0\r\n]/.test(options.claudePath)) throw new Error('claudePath must be an absolute path (it is never looked up on PATH)');
  if (!isAbsolute(options.runRoot) || /[\0\r\n]/.test(options.runRoot)) throw new Error('runRoot must be an absolute path');
  const env = buildClaudeEnv(options.env); // 설정 오류는 만들 때 던진다
  const clock = options.clock;
  const port = options.process ?? nodeProcessPort;
  const timers = options.timers ?? realGatewayTimers;
  const nodePath = options.nodePath ?? process.execPath;
  const bridgePath = options.bridgePath ?? join(dirname(fileURLToPath(import.meta.url)), 'gateway-mcp-bridge.ts');
  const maxTurns = options.maxTurns ?? 40;
  const warnUtilization = options.warnUtilization ?? 0.8;
  const closeGraceMs = options.closeGraceMs ?? 5000;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
  if (!(Number.isInteger(maxTurns) && maxTurns > 0)) throw new Error('maxTurns must be a positive integer');
  const gate = options.gate ?? createClaudeCodeGate({
    clock, ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }), ...(options.yieldUtilization === undefined ? {} : { yieldUtilization: options.yieldUtilization }),
  });
  const processOptions = { claudePath: options.claudePath, env, port, timers, maxTurns, closeGraceMs, maxStderrBytes, maxOutputBytes, maxLineBytes };
  let versionNote: string | null = null;

  async function run(input: AdapterInput, context: AdapterContext): Promise<AdapterOutput> {
    const runLog: RunLogEntry[] = [];
    const note = (message: string): void => void runLog.push({ at: clock.nowIso(), message: maskString(message).slice(0, 1500) });
    const cost = (tokens: number | null): AdapterCost => ({ tokens: tokens ?? 0 });
    const error = (code: string, message: string, tokens: number | null = null): AdapterOutput => ({
      status: 'error', result: null, evidence: [], run_log: runLog, cost: cost(tokens), error: { code, message: maskString(message).slice(0, 500) },
    });
    const cancelled = (tokens: number | null = null): AdapterOutput => ({ status: 'cancelled', result: null, evidence: [], run_log: runLog, cost: cost(tokens) });
    const refuse = (code: string, message: string): AdapterOutput => {
      note(`claude was not started (${code}): ${message}`);
      return error(code, message);
    };

    // ----- 시작 전 검사: 여기서 거부하면 CLI 를 띄우지 않는다 -----
    const consent = typeof options.consent === 'function' ? options.consent() : options.consent;
    if (consent === null || typeof consent.notice_version !== 'string' || consent.notice_version.trim() === '' || typeof consent.accepted_at !== 'string' || consent.accepted_at === '') {
      return refuse('consent_required', 'the first-run notice has not been accepted: automatic runs use your own subscription on your own PC and complying with the provider terms is your responsibility');
    }
    const runId = typeof input.run_id === 'string' ? input.run_id : '';
    if (!RUN_ID.test(runId)) return refuse('start_rejected', 'run_id must be 1-80 letters, digits, "_", ".", "-" (it names the run directory)');
    const start = startFrameOf(input); // 비밀로 보이는 값·크기 상한 확인 (CLI 의 컨텍스트에도 비밀은 들어가지 않는다)
    if (!start.ok) return refuse('start_rejected', `the input was rejected (${start.rejection.code}): ${start.rejection.message}`);
    const tools = [...new Set(input.allowed_tools.map((t) => t.tool))];
    const offered: AllowedTool[] = tools.map((tool) => ({ tool, operations: [...new Set(input.allowed_tools.filter((t) => t.tool === tool).flatMap((t) => [...t.operations]))] }));
    const badTool = tools.find((t) => !GATEWAY_TOOL_NAME.test(t));
    if (badTool !== undefined) return refuse('start_rejected', `gateway tool name '${badTool.slice(0, 80)}' cannot be offered to the CLI`);
    const prompt = buildPrompt(input);
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return refuse('start_rejected', `the task prompt is longer than ${MAX_PROMPT_BYTES} bytes`);
    if (context.signal.aborted) {
      note('cancelled before the CLI was started');
      return cancelled();
    }

    if (!(await gate.acquire(context.signal))) {
      note('cancelled while waiting for a free slot');
      return cancelled();
    }
    try {
      return await runWithSlot();
    } finally {
      gate.release();
    }

    async function runWithSlot(): Promise<AdapterOutput> {
      // ----- 사람 우선 게이트: 사용자가 쓸 구독 몫을 남긴다 (CLI 를 띄우기 전에 거절하므로 사용량을 쓰지 않는다) -----
      const deferral = gate.deferral();
      if (deferral !== null) return refuse('usage_deferred', deferral);
      // ----- CLI 확인 (버전 기록) -----
      if (versionNote === null) {
        const version = await port.exec(options.claudePath, ['--version'], { env, timeoutMs: options.versionTimeoutMs ?? 15_000 });
        const text = version.stdout.trim().split('\n')[0]?.trim() ?? '';
        if (version.spawnError !== undefined || version.timedOut || version.code !== 0 || text === '') {
          const why = version.spawnError ?? (version.timedOut ? 'claude --version timed out' : (version.stderr.trim() || `exit code ${String(version.code)}`));
          return refuse('cli_unavailable', `the claude CLI cannot be run (agent work is not run another way): ${why.slice(0, 200)}`);
        }
        versionNote = text.slice(0, 100);
      }
      note(`claude CLI version: ${versionNote}`);
      if (context.signal.aborted) {
        note('cancelled before the CLI was started');
        return cancelled();
      }

      // ----- run 디렉터리: <runRoot>/<run_id>/{work/, gateway-mcp.json, tools.json, gw.sock}. 작업 디렉터리 밖에 둔 것은 에이전트의 파일 도구가 닿지 않는다 -----
      const runDir = join(options.runRoot, runId);
      const workdir = join(runDir, 'work');
      let socket: GatewaySocket | null = null;
      let created = false;
      try {
        await mkdir(options.runRoot, { recursive: true, mode: 0o700 });
        try {
          await mkdir(runDir, { mode: 0o700 });
          created = true;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return refuse('start_rejected', 'the run directory already exists (a run id is used once)');
          throw cause;
        }
        await mkdir(workdir, { mode: 0o700 });
        for (const [relative, content] of Object.entries(buildWorkdirFiles(input))) {
          const target = join(workdir, relative);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, content, { mode: 0o444 });
          await chmod(target, 0o444);
        }
        const mcpConfigPath = join(runDir, 'gateway-mcp.json');
        const toolsPath = join(runDir, 'tools.json');
        if (tools.length > 0) {
          socket = await serveGatewaySocket({ dir: runDir, gateway: context.gateway, allowedTools: tools });
          await writeFile(toolsPath, JSON.stringify(buildBridgeTools(offered, options.toolDescriptions)), { mode: 0o600 });
          await writeFile(mcpConfigPath, buildMcpConfig({ nodePath, bridgePath, socketPath: socket.path, toolsPath, token: socket.token }), { mode: 0o600 });
        } else {
          await writeFile(mcpConfigPath, buildMcpConfig(null), { mode: 0o600 });
        }
        const args = buildClaudeArgs({
          prompt, instructions: TASK_INSTRUCTIONS, mcpConfigPath, gatewayTools: tools,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
        });
        return await execute(args, workdir, tools);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'unknown error';
        note(`the run could not be prepared: ${message}`);
        return error('start_failed', `the run could not be prepared: ${message}`);
      } finally {
        await socket?.close().catch(() => undefined);
        if (created && options.keepRunDir !== true) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    async function execute(args: string[], workdir: string, gatewayToolNames: readonly string[]): Promise<AdapterOutput> {
      const processed = await runClaudeProcess(processOptions, {
        args, cwd: workdir, signal: context.signal, note,
        expected: { gatewayServer: GATEWAY_SERVER_NAME, gatewayTools: gatewayToolNames.map(mcpToolName), builtinTools: BUILTIN_TOOLS },
      });
      const { state, exit, stderrText } = processed;
      const how = exit.signal !== null ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`;
      const tokens = state.result?.tokens ?? null;
      const final = processed.ending;

      switch (final.kind) {
        case 'cancelled':
          note('cancelled: claude was stopped');
          return cancelled(tokens);
        case 'spawn_error':
          return refuse('cli_unavailable', `the claude CLI could not be started: ${final.message.slice(0, 200)}`);
        case 'turn_limit':
          note(`turn limit exceeded (${final.turns} > ${maxTurns}): claude was stopped`);
          return error('turn_limit_exceeded', `the agent used more than ${maxTurns} turns; it was stopped`, tokens);
        case 'init_problem':
          note(`${final.code}: ${final.message}; claude was stopped`);
          return error(final.code, final.message, tokens);
        case 'output_limit':
          note(`output limit: ${final.message}; claude was stopped`);
          return error('output_limit', final.message, tokens);
        case 'closed':
          break;
      }

      // ----- 결과 분류 (종료 코드가 아니라 JSON 필드) -----
      note(`claude ended (${how})`);
      const classified = classifyRun(state, exit, stderrText, {
        ...(options.limitPatterns === undefined ? {} : { limitPatterns: options.limitPatterns }),
        ...(options.serverLimitPatterns === undefined ? {} : { serverLimitPatterns: options.serverLimitPatterns }),
      });
      if (classified.estimatedUsd !== null) note(`estimated cost (subscription estimate at list prices, not a bill): ${classified.estimatedUsd} USD, ${String(classified.tokens)} tokens`);
      gate.observe(state);
      const utilization = state.maxUtilization;
      // 사용률은 0~1 또는 0~100 으로 보고될 수 있다(미확인): 1 을 넘으면 퍼센트로 본다
      if (utilization !== null && (utilization > 1 ? utilization / 100 : utilization) >= warnUtilization) {
        note(`usage_warning: the subscription window utilization reached ${utilization} (warning threshold ${warnUtilization}); the next runs may hit the usage limit`);
      }
      if (state.rateLimitWorst !== null) note(`usage_warning: rate limit status was '${state.rateLimitWorst.status ?? '?'}' (${state.rateLimitWorst.rateLimitType ?? '?'}, resets ${String(state.rateLimitWorst.resetsAt)})`);
      if (!classified.ok) {
        note(`classified as ${classified.code}${classified.review ? ' (needs review: a person or time must resolve it before a retry can work)' : ''}`);
        return error(classified.code, classified.message, classified.tokens);
      }
      const capturedAt = clock.nowIso();
      const evidence: EvidenceItem[] = classified.evidence.map((item) => ({
        kind: item.kind, ref: item.ref, trust_origin: 'external_untrusted', captured_at: capturedAt, ...(item.content_hash === undefined ? {} : { content_hash: item.content_hash }),
      }));
      return { status: 'submitted', result: classified.result, evidence, run_log: runLog, cost: cost(classified.tokens) };
    }
  }

  return { name: CLAUDE_CODE_ADAPTER_NAME, run };
}
