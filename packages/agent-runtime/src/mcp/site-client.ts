// 사이트 연결 (ADR-0018 §1, 설계 §5.3·§5.5·§5.6). 데몬 쪽에서 사이트마다 커넥터 프로세스 하나를 관리한다.
//  - 도구별 열림/닫힘(고정 확인): 시작, 목록 변경 알림, 주기, 쓰기 전송 직전에 `list` 로 다시 정한다. 상태가 바뀔 때마다 운영 이벤트를 남긴다.
//  - 요청 id·호스트 타이머·취소: 커넥터가 답하지 않아도 호스트는 기다리지 않는다. 비정상 종료하면 진행 중 요청을 모두 끝내고 지수 대기(1초→60초)로 다시 띄운다.
//  - 사이트별 분당 상한(주입된 Clock). 읽기는 즉시 거부, 전송은 상한 안에서 기다린다.
import type { Clock } from '@aot/domain';

import { realGatewayTimers, type GatewayTimers } from '../gateway.ts';

import type { ConnectorLink, ConnectorSpawner } from './connector-process.ts';
import {
  CLIENT_VERSION, DEFAULT_MAX_RESULT_BYTES,
  type ConnectorCallResult, type ConnectorConfig, type ConnectorError, type ConnectorResponse, type ConnectorServerInfo, type ConnectorToolInfo,
} from './connector/wire.ts';
import type { McpSiteManifest, McpToolDecl } from './manifest.ts';
import { createSiteRateLimiter, type SiteRateLimiter } from './rate-limit.ts';
import { evaluateTool, type ClosedReason, type ToolState } from './schema-pin.ts';

export type McpSiteEvent =
  | { type: 'connector_started'; site: string }
  | { type: 'connector_exit'; site: string; restartInMs: number | null }
  | { type: 'connector_stderr'; site: string; text: string }
  | { type: 'list_failed'; site: string; error: string }
  | { type: 'tool_state'; site: string; tool: string; state: string; previous: string }
  | { type: 'undeclared_tools'; site: string; names: string[] }
  | { type: 'server_request_refused'; site: string; method: string }
  | { type: 'server_requests_suppressed'; site: string; count: number }
  /** 로그인 위임: 사이트가 접근 토큰을 거절했다(401) */
  | { type: 'auth_rejected'; site: string }
  /** 토큰 원천(데몬): 갱신 성공 / 재시도 예정 / 로그인이 필요해졌다. 토큰 값은 싣지 않는다 */
  | { type: 'auth_refreshed'; site: string; expiresInS: number }
  | { type: 'auth_retry'; site: string; reason: string; inMs: number }
  | { type: 'auth_failed'; site: string; reason: string; action: string };

/**
 * 로그인 위임 사이트의 접근 토큰 원천 (ADR-0018 개정 1). 갱신은 이 포트 뒤(데몬의 토큰 원천) 한 곳에서만 한다.
 * 사이트 연결은 현재 토큰을 커넥터에 `token` 줄로 전달하고, 토큰이 바뀌면(null 포함) 다시 전달한다.
 */
export interface McpAuthPort {
  /** 지금 쓸 수 있는 접근 토큰. 없거나 만료됐으면 null */
  current(): string | null;
  /** 토큰이 바뀔 때(갱신, 로그인, 폐기) 부른다. 반환하는 함수로 해제 */
  subscribe(listener: () => void): () => void;
  /** 사이트가 토큰을 거절했다(401). 원천이 한 번 갱신을 시도한다 */
  rejected(): void;
}

/** 커넥터와의 통신 자체가 실패했다. `definite`: 요청이 서버에 닿지 않았음이 확실한가 */
export class McpTransportError extends Error {
  readonly code: 'timeout' | 'connector_exit' | 'connector_unavailable' | 'aborted' | 'protocol';
  readonly definite: boolean;
  constructor(code: McpTransportError['code'], message: string, definite: boolean) {
    super(message);
    this.name = 'McpTransportError';
    this.code = code;
    this.definite = definite;
  }
}

export type McpCallOutcome = { ok: true; result: ConnectorCallResult } | { ok: false; error: ConnectorError };

export interface McpSiteClientOptions {
  manifest: McpSiteManifest;
  clock: Clock;
  spawn: ConnectorSpawner;
  timers?: GatewayTimers;
  /** 로그인 위임(`oauth_delegated`) 사이트의 토큰 원천. 그 인증 종류에 필수다 */
  auth?: McpAuthPort;
  onEvent?: (event: McpSiteEvent) => void;
  /** 주기 확인 간격 (기본 10분) */
  recheckIntervalMs?: number;
  /** 확인 명령 전용: 선언 밖 도구의 스키마도 받는다(호출은 모두 거부) */
  inspect?: boolean;
  /** `list` 요청의 호스트 시간 제한 (기본 45초) */
  listTimeoutMs?: number;
}

export interface McpSiteClient {
  readonly site: string;
  /** 커넥터를 띄우고 첫 확인까지 마친다. 확인이 실패해도 던지지 않는다(모든 도구가 닫힌 채 다시 시도한다) */
  start(): Promise<void>;
  /**
   * 서버 목록을 다시 읽어 도구 상태를 정한다. 동시에 최대 하나가 돌고 하나가 대기한다(대기 중인 요청은 모두 같은 다음 읽기를 공유한다):
   * 알림이 쏟아져도 대기열이 늘지 않고, 부른 쪽은 부른 *뒤에* 시작한 읽기를 기다린다.
   * `timeoutMs` 안에 끝나지 않으면 기다리기를 그만두고 false (상태는 그대로이며 읽기는 계속될 수 있다).
   */
  refresh(options?: { timeoutMs?: number }): Promise<boolean>;
  /** 에이전트용 도구 이름(`mcp_<site>_<as>`)의 상태 */
  stateOf(gatewayName: string): ToolState;
  /** 열린 도구의 고정 스키마(서버가 알린 것이 고정 해시와 같은 경우만) */
  schemaOf(gatewayName: string): unknown;
  /** 선언 밖에서 서버가 더한 도구 이름 */
  undeclared(): readonly string[];
  /** 확인 명령용: 마지막 `list` 응답 전체 */
  lastListing(): { tools: readonly ConnectorToolInfo[]; undeclared: readonly string[]; server: ConnectorServerInfo } | null;
  /** 읽기용: 분당 상한에 걸리면 false (목록 확인은 토큰을 쓰지 않는다 — 합치기와 주기 타이머가 횟수를 묶는다) */
  tryAcquire(): boolean;
  /** 전송용: 상한 안에서 기다린다. 기다려도 안 되면 false */
  acquireForSend(maxWaitMs: number): Promise<boolean>;
  call(serverTool: string, args: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal; retrySafe?: boolean }): Promise<McpCallOutcome>;
  close(): Promise<void>;
}

const MIN_RESTART_MS = 1000;
const MAX_RESTART_MS = 60_000;
const MAX_REFUSAL_EVENTS_PER_MINUTE = 5;

export function createMcpSiteClient(options: McpSiteClientOptions): McpSiteClient {
  const { manifest, clock } = options;
  const delegated = manifest.auth.kind === 'oauth_delegated';
  if (delegated && options.auth === undefined) throw new Error(`site '${manifest.site}': oauth_delegated needs a token source (auth port)`);
  const timers = options.timers ?? realGatewayTimers;
  const emit = (event: McpSiteEvent): void => {
    try { options.onEvent?.(event); } catch { /* 운영 이벤트 처리기의 오류가 연결을 깨뜨리지 않게 한다 */ }
  };
  const limiter: SiteRateLimiter = createSiteRateLimiter(clock, manifest.rateLimitPerMinute);
  const recheckMs = options.recheckIntervalMs ?? 600_000;
  const listTimeoutMs = options.listTimeoutMs ?? 45_000;

  let link: ConnectorLink | null = null;
  let closing = false;
  let nextId = 1;
  let restartDelay = MIN_RESTART_MS;
  let timerHandle: unknown = null;
  let listing: ReturnType<McpSiteClient['lastListing']> = null;
  let undeclaredKey = '';
  let refusedWindowStart = Number.NEGATIVE_INFINITY;
  let refusedInWindow = 0;
  let refusedSuppressed = 0;
  const pending = new Map<number, { resolve(response: ConnectorResponse): void; reject(error: unknown): void }>();
  const states = new Map<string, { state: ToolState; schema: unknown }>();
  for (const tool of manifest.tools) states.set(tool.gatewayName, { state: { status: 'closed', reason: 'unavailable' }, schema: undefined });

  const label = (state: ToolState): string => (state.status === 'open' ? 'open' : `closed:${state.reason}`);
  const setState = (tool: McpToolDecl, state: ToolState, schema: unknown): void => {
    const previous = states.get(tool.gatewayName)!;
    states.set(tool.gatewayName, { state, schema: state.status === 'open' ? schema : undefined });
    if (label(previous.state) !== label(state)) emit({ type: 'tool_state', site: manifest.site, tool: tool.gatewayName, state: label(state), previous: label(previous.state) });
  };
  const closeAll = (reason: ClosedReason): void => {
    for (const tool of manifest.tools) setState(tool, { status: 'closed', reason }, undefined);
  };

  const configLine = (): ConnectorConfig => ({
    type: 'config', site: manifest.site,
    transport: manifest.transport.kind === 'http' ? { kind: 'http', url: manifest.transport.url } : { kind: 'stdio', command: manifest.transport.command, args: [...manifest.transport.args] },
    auth: manifest.auth.kind === 'none' ? { kind: 'none' }
      : manifest.auth.kind === 'bearer' ? { kind: 'bearer', token_env: manifest.auth.tokenEnv }
        : manifest.auth.kind === 'oauth_delegated' ? { kind: 'oauth_delegated' }
          : { kind: 'header', header: manifest.auth.header, value_env: manifest.auth.valueEnv },
    env_from: { ...manifest.envFrom },
    tools: manifest.tools.map((tool) => tool.name),
    max_result_bytes: DEFAULT_MAX_RESULT_BYTES,
    client_version: CLIENT_VERSION,
    ...(options.inspect === true ? { inspect: true } : {}),
  });

  const clearTimer = (): void => {
    if (timerHandle !== null) timers.clearTimeout(timerHandle);
    timerHandle = null;
  };
  const schedule = (ms: number, run: () => void): void => {
    clearTimer();
    if (closing) return;
    timerHandle = timers.setTimeout(run, ms);
    (timerHandle as { unref?: () => void } | null)?.unref?.();
  };

  const sendToken = (target: ConnectorLink): void => {
    try { target.send({ type: 'token', access_token: options.auth?.current() ?? null }); } catch { /* 커넥터가 없다: 다시 뜰 때 보낸다 */ }
  };
  /** 토큰이 바뀌었다: 커넥터에 전달하고, 닫혀 있던 도구는 다시 확인한다. 토큰이 사라졌으면 이 사이트의 도구를 닫는다 */
  const onTokenChange = (): void => {
    if (closing) return;
    if (link !== null) sendToken(link);
    if (options.auth?.current() == null) { closeAll('unauthorized'); return; }
    if (link !== null) void refresh();
  };
  const unsubscribe = delegated ? options.auth!.subscribe(onTokenChange) : () => undefined;

  const onLine = (line: string): void => {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message !== 'object' || message === null) return;
    const record = message as { id?: unknown; type?: unknown; method?: unknown };
    if (record.type === 'list_changed') { void refresh(); return; } // 합쳐진다: 알림이 몇 개든 대기열은 늘지 않는다
    if (record.type === 'server_request_refused') {
      // 서버가 요청을 쏟아내도 운영 이벤트는 분당 몇 건뿐이다(나머지는 건수로 합쳐 한 번 알린다)
      const now = clock.nowMs();
      if (now - refusedWindowStart >= 60_000) {
        if (refusedSuppressed > 0) emit({ type: 'server_requests_suppressed', site: manifest.site, count: refusedSuppressed });
        refusedWindowStart = now;
        refusedInWindow = 0;
        refusedSuppressed = 0;
      }
      if (refusedInWindow < MAX_REFUSAL_EVENTS_PER_MINUTE) {
        refusedInWindow += 1;
        emit({ type: 'server_request_refused', site: manifest.site, method: String(record.method ?? '').slice(0, 200) });
      } else refusedSuppressed += 1;
      return;
    }
    if (record.type === 'server_requests_suppressed') {
      emit({ type: 'server_requests_suppressed', site: manifest.site, count: Number((record as { count?: unknown }).count) || 0 });
      return;
    }
    if (typeof record.id === 'number') {
      const entry = pending.get(record.id);
      if (entry) { pending.delete(record.id); entry.resolve(message as ConnectorResponse); }
    }
  };

  const onExit = (exited: ConnectorLink): void => {
    if (link !== exited) return;
    link = null;
    const error = new McpTransportError('connector_exit', 'the connector process exited', false);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    closeAll('unavailable');
    listing = null;
    if (closing) return;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_MS);
    emit({ type: 'connector_exit', site: manifest.site, restartInMs: delay });
    schedule(delay, () => { void launch(); });
  };

  const launch = async (): Promise<void> => {
    if (closing || link !== null) return;
    try {
      const fresh = options.spawn();
      link = fresh;
      fresh.onLine(onLine);
      fresh.onExit(() => onExit(fresh));
      fresh.onStderr((text) => emit({ type: 'connector_stderr', site: manifest.site, text }));
      fresh.send(configLine());
      if (delegated) sendToken(fresh);
      emit({ type: 'connector_started', site: manifest.site });
    } catch (error) {
      link = null;
      emit({ type: 'list_failed', site: manifest.site, error: error instanceof Error ? error.message : 'could not start the connector' });
      const delay = restartDelay;
      restartDelay = Math.min(restartDelay * 2, MAX_RESTART_MS);
      schedule(delay, () => { void launch(); });
      return;
    }
    await refresh();
  };

  /** 요청 하나를 보내고 응답을 기다린다. 호스트 타이머가 먼저 끝나면 시간 초과, 신호가 abort 되면 취소 */
  const request = (body: { op: 'list' } | { op: 'call'; tool: string; arguments: Record<string, unknown>; retry_safe?: boolean }, timeoutMs: number, signal?: AbortSignal): Promise<ConnectorResponse> => {
    const active = link;
    if (active === null) return Promise.reject(new McpTransportError('connector_unavailable', 'the connector process is not running', true));
    if (signal?.aborted === true) return Promise.reject(new McpTransportError('aborted', 'cancelled before it was sent', true));
    const id = nextId++;
    return new Promise<ConnectorResponse>((resolve, reject) => {
      const finish = (): void => {
        timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.delete(id);
      };
      const cancelAtConnector = (): void => {
        try { active.send({ id: nextId++, op: 'cancel', target_id: id }); } catch { /* 이미 끝난 연결 */ }
      };
      const onAbort = (): void => {
        finish();
        cancelAtConnector();
        reject(new McpTransportError('aborted', 'the call was cancelled', false));
      };
      const timer = timers.setTimeout(() => {
        finish();
        cancelAtConnector();
        reject(new McpTransportError('timeout', `no answer within ${timeoutMs} ms`, false));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (response) => { finish(); resolve(response); },
        reject: (error) => { finish(); reject(error); },
      });
      try {
        active.send({ id, ...body });
      } catch {
        finish();
        reject(new McpTransportError('connector_unavailable', 'the connector process is not running', true));
      }
    });
  };

  const doRefresh = async (): Promise<void> => {
    let response: ConnectorResponse;
    try {
      response = await request({ op: 'list' }, listTimeoutMs);
    } catch (error) {
      closeAll('unavailable');
      emit({ type: 'list_failed', site: manifest.site, error: error instanceof Error ? error.message : 'list failed' });
      if (link !== null) { schedule(restartDelay, () => { void refresh(); }); restartDelay = Math.min(restartDelay * 2, MAX_RESTART_MS); }
      return;
    }
    if (!response.ok || !('tools' in response)) {
      closeAll(response.ok === false && response.error.code === 'unauthorized' ? 'unauthorized' : response.ok === false && response.error.code === 'auth_required' ? 'unauthorized' : 'unavailable');
      if (response.ok === false && response.error.code === 'unauthorized') { emit({ type: 'auth_rejected', site: manifest.site }); options.auth?.rejected(); }
      emit({ type: 'list_failed', site: manifest.site, error: !response.ok ? `${response.error.code}: ${response.error.message}` : 'unexpected list response' });
      if (link !== null) { schedule(restartDelay, () => { void refresh(); }); restartDelay = Math.min(restartDelay * 2, MAX_RESTART_MS); }
      return;
    }
    listing = { tools: response.tools, undeclared: response.undeclared, server: response.server };
    const byName = new Map(response.tools.map((tool) => [tool.name, tool]));
    const counts = new Map<string, number>();
    for (const tool of response.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    for (const decl of manifest.tools) {
      const server = byName.get(decl.name);
      // 같은 이름이 둘 이상이면 어느 쪽이 진짜인지 알 수 없다: 닫는다 (마지막 것이 이기게 두지 않는다)
      if ((counts.get(decl.name) ?? 0) > 1) { setState(decl, { status: 'closed', reason: 'duplicate' }, undefined); continue; }
      const state = evaluateTool(decl, server === undefined ? undefined : { name: server.name, inputSchema: server.input_schema, annotations: server.annotations });
      setState(decl, state, server?.input_schema);
    }
    const key = [...response.undeclared].sort().join('\n');
    if (key !== undeclaredKey) {
      undeclaredKey = key;
      if (response.undeclared.length > 0) emit({ type: 'undeclared_tools', site: manifest.site, names: [...response.undeclared] });
    }
    restartDelay = MIN_RESTART_MS;
    schedule(recheckMs, () => { void refresh(); });
  };

  // 동시에 하나만 돌고 하나만 대기한다. 대기 중에 온 요청은 모두 같은 "다음 읽기"를 기다린다 (그 읽기는 요청 *뒤에* 시작한다)
  let running: Promise<void> | null = null;
  let waiting: Promise<void> | null = null;
  const startRun = (): Promise<void> => {
    const run = doRefresh().catch(() => undefined).finally(() => { if (running === run) running = null; });
    running = run;
    return run;
  };
  const refreshCoalesced = (): Promise<void> => {
    if (running === null) return startRun();
    if (waiting === null) {
      const prior = running;
      const next = prior.then(() => { waiting = null; return startRun(); });
      waiting = next;
    }
    return waiting;
  };
  const refresh = async (options?: { timeoutMs?: number }): Promise<boolean> => {
    const done = refreshCoalesced().then(() => true);
    if (options?.timeoutMs === undefined) return done;
    let handle: unknown;
    const timedOut = new Promise<boolean>((resolve) => { handle = timers.setTimeout(() => resolve(false), Math.max(0, options.timeoutMs!)); });
    try {
      return await Promise.race([done, timedOut]);
    } finally {
      timers.clearTimeout(handle);
    }
  };

  return {
    site: manifest.site,
    async start() {
      await launch();
    },
    refresh,
    stateOf: (name) => states.get(name)?.state ?? { status: 'closed', reason: 'missing' },
    schemaOf: (name) => states.get(name)?.schema,
    undeclared: () => listing?.undeclared ?? [],
    lastListing: () => listing,
    tryAcquire: () => limiter.tryAcquire(),
    async acquireForSend(maxWaitMs) {
      const deadline = clock.nowMs() + maxWaitMs;
      for (;;) {
        if (limiter.tryAcquire()) return true;
        const wait = limiter.waitMs();
        if (clock.nowMs() + wait > deadline) return false;
        await new Promise<void>((resolve) => { timers.setTimeout(resolve, wait); });
      }
    },
    async call(serverTool, args, callOptions) {
      const response = await request(
        { op: 'call', tool: serverTool, arguments: args, ...(callOptions.retrySafe === true ? { retry_safe: true } : {}) }, callOptions.timeoutMs, callOptions.signal,
      );
      if (!response.ok) {
        if (response.error.code === 'unauthorized') { emit({ type: 'auth_rejected', site: manifest.site }); options.auth?.rejected(); }
        return { ok: false, error: response.error };
      }
      if (!('result' in response)) throw new McpTransportError('protocol', 'the connector answered a call with something else', false);
      return { ok: true, result: response.result };
    },
    close() {
      closing = true;
      unsubscribe();
      clearTimer();
      const active = link;
      link = null;
      const error = new McpTransportError('connector_exit', 'the site connection was closed', false);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      active?.kill();
      return Promise.resolve();
    },
  };
}
