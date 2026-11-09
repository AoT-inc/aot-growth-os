// MCP 커넥터 시험 공용: 가짜 서버(test/fixtures/mcp/fake-server.ts)를 stdio 로 띄우는 사이트 선언, 요청 기록 읽기, 실제 커넥터 프로세스를 직접 모는 하네스. 외부 네트워크는 없다.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import {
  createMcpSiteClient, parseMcpSite, schemaHash, spawnConnectorProcess,
  type ConnectorLink, type McpSiteClient, type McpSiteEvent, type McpSiteManifest,
} from '@aot/agent-runtime';
import type { Clock } from '@aot/domain';
import { systemClock } from '@aot/domain';

import { DRIFTED_UPDATE_SCHEMA, SEARCH_SCHEMA, UPDATE_SCHEMA, type Scenario } from '../fixtures/mcp/fake-server.ts';
import { makeTempDir } from './temp.ts';

export const FAKE_SERVER = join(import.meta.dirname, '../fixtures/mcp/fake-server.ts');
export const TOKEN_ENV = 'AOT_MCP_COURSE_TOKEN';
/** 시험용 가짜 토큰 (실제 비밀이 아니다) */
export const TEST_TOKEN = 'tok-example-0123456789abcdef';
export const SECRET_ENV = { [TOKEN_ENV]: TEST_TOKEN } as const;

export const SEARCH_HASH = schemaHash(SEARCH_SCHEMA);
export const UPDATE_HASH = schemaHash(UPDATE_SCHEMA);
export const DRIFTED_UPDATE_HASH = schemaHash(DRIFTED_UPDATE_SCHEMA);

export function searchDecl(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'units_search', as: 'search_units', description: '강좌 단원을 제목으로 찾는다. 읽기 전용.', scope: 'internal', impact: 'read', side_effect: false,
    target: 'site:course/units', input_schema_sha256: SEARCH_HASH, ...over,
  };
}

export function updateDecl(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'unit_update', as: 'update_unit', description: '단원 본문을 고친다. 학생에게 보인다.', scope: 'customer', impact: 'external_effect', side_effect: true, approval: 'draft',
    target: 'site:course/units', input_schema_sha256: UPDATE_HASH, ...over,
  };
}

export const SEARCH_TOOL = 'mcp_course_search_units';
export const UPDATE_TOOL = 'mcp_course_update_unit';

/** stdio 로 가짜 서버를 띄우는 사이트 선언 원본(JSON). `tools` 를 주지 않으면 읽기 1개 + 쓰기 1개 */
export function stdioSiteRaw(scenario: Scenario, recordPath: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site: 'course',
    transport: { kind: 'stdio', command: process.execPath, args: [FAKE_SERVER, scenario, ...(recordPath === undefined ? [] : [recordPath])] },
    env_from: { MCP_TOKEN: TOKEN_ENV },
    tools: [searchDecl(), updateDecl()],
    ...over,
  };
}

export function httpSiteRaw(url: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site: 'course', transport: { kind: 'http', url }, auth: { kind: 'bearer', token_env: TOKEN_ENV },
    tools: [searchDecl(), updateDecl()], ...over,
  };
}

export const manifestOf = (raw: Record<string, unknown>): McpSiteManifest => parseMcpSite(raw);

/** 가짜 서버가 받은 요청 기록 (JSONL) */
export interface Recorded { method: string | null; id: unknown; params: Record<string, unknown> | null; result: unknown; error: unknown; raw: string; headers?: Record<string, string | null> }
export function readRecords(path: string): Recorded[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Recorded);
}
export const callsTo = (path: string, tool?: string): Recorded[] =>
  readRecords(path).filter((r) => r.method === 'tools/call' && (tool === undefined || (r.params as { name?: string } | null)?.name === tool));

export interface SiteRig {
  client: McpSiteClient;
  manifest: McpSiteManifest;
  events: McpSiteEvent[];
  recordPath: string;
}

/** 실제 커넥터 프로세스 + 가짜 stdio 서버로 사이트 연결을 시작한다. 시험이 끝나면 닫는다 */
export async function startStdioSite(t: TestContext, scenario: Scenario, options: { raw?: Record<string, unknown>; clock?: Clock; timers?: import('@aot/agent-runtime').GatewayTimers; start?: boolean } = {}): Promise<SiteRig> {
  const dir = makeTempDir(t, 'aot-mcp-');
  const raw = options.raw ?? stdioSiteRaw(scenario, join(dir, 'requests.jsonl'));
  const manifest = manifestOf(raw);
  // 요청 기록 경로는 선언의 stdio 인자(세 번째)에서 읽는다 — 호출자가 선언을 직접 만들어도 같은 파일을 가리킨다
  const recordPath = manifest.transport.kind === 'stdio' ? (manifest.transport.args[2] ?? join(dir, 'none.jsonl')) : join(dir, 'none.jsonl');
  const events: McpSiteEvent[] = [];
  const client = createMcpSiteClient({
    manifest, clock: options.clock ?? systemClock, spawn: () => spawnConnectorProcess(SECRET_ENV), onEvent: (e) => events.push(e),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });
  t.after(() => client.close());
  if (options.start !== false) await client.start();
  return { client, manifest, events, recordPath };
}

// ===== 커넥터 프로세스를 줄 단위 JSON 으로 직접 모는 하네스 (커넥터 프로토콜 시험) =====

export interface ConnectorHarness {
  link: ConnectorLink;
  lines: Record<string, unknown>[];
  /** 요청을 보내고 같은 id 의 응답을 기다린다 */
  ask(body: Record<string, unknown>): Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  notices(): Record<string, unknown>[];
  sentConfig: Record<string, unknown>;
}

export function startConnector(t: TestContext, config: Record<string, unknown>, secretEnv: Record<string, string> = SECRET_ENV): ConnectorHarness {
  const link = spawnConnectorProcess(secretEnv);
  const lines: Record<string, unknown>[] = [];
  const waiters = new Map<number, (value: Record<string, unknown>) => void>();
  link.onLine((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    lines.push(parsed);
    if (typeof parsed['id'] === 'number') waiters.get(parsed['id'])?.(parsed);
  });
  link.onExit(() => undefined);
  t.after(() => link.kill());
  link.send(config);
  let next = 1;
  return {
    link, lines, sentConfig: config,
    ask: (body) => new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`connector did not answer ${JSON.stringify(body).slice(0, 80)}`)), 15_000);
      waiters.set(id, (value) => { clearTimeout(timer); resolve(value as never); });
      link.send({ id, ...body });
    }),
    notices: () => lines.filter((l) => typeof l['type'] === 'string'),
  };
}

export function connectorConfig(over: Record<string, unknown>): Record<string, unknown> {
  return { type: 'config', site: 'course', auth: { kind: 'none' }, env_from: {}, tools: ['units_search', 'unit_update'], max_result_bytes: 262144, client_version: '1', ...over };
}

export const stdioTransport = (scenario: Scenario, recordPath?: string): Record<string, unknown> => ({
  kind: 'stdio', command: process.execPath, args: [FAKE_SERVER, scenario, ...(recordPath === undefined ? [] : [recordPath])],
});

/** 조건이 참이 될 때까지 기다린다 (실제 프로세스 시험에서 기록이 쌓이길 기다리는 용도) */
export async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ===== 가짜 커넥터 연결 (사이트 연결 단위 시험: 프로세스 없이 줄 단위로 응답을 정한다) =====

type AnyJson = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export class FakeConnectorLink implements ConnectorLink {
  readonly sent: AnyJson[] = [];
  killed = false;
  /** list 응답에 실리는 서버 도구 (스키마 해시는 계산하지 않고 입력 스키마로 호스트가 계산한다) */
  tools: { name: string; input_schema: unknown; annotations: Record<string, unknown> | null }[] = [
    { name: 'units_search', input_schema: SEARCH_SCHEMA, annotations: { readOnlyHint: true } },
    { name: 'unit_update', input_schema: UPDATE_SCHEMA, annotations: null },
  ];
  undeclared: string[] = [];
  /** true 면 list 요청에 답하지 않는다 */
  listSilent = false;
  /** list 에 오류로 답한다 */
  listError: { code: string; message: string; definite: boolean } | null = null;
  /** call 에 대한 응답을 직접 정한다. undefined 를 돌려주면 답하지 않는다(시간 초과 시험) */
  onCall: (message: AnyJson) => AnyJson | undefined = () => ({ ok: true, result: { is_error: false, text: 'ok', dropped: {} } });
  #line: (line: string) => void = () => undefined;
  #exit: () => void = () => undefined;
  #stderr: (text: string) => void = () => undefined;

  send(value: unknown): void {
    if (this.killed) throw new Error('killed');
    const message = value as AnyJson;
    this.sent.push(message);
    if (message['type'] === 'config') return;
    queueMicrotask(() => {
      if (message['op'] === 'list') {
        if (this.listSilent) return;
        this.emit(this.listError === null
          ? { id: message['id'], ok: true, tools: this.tools.map((t) => ({ ...t, input_schema_sha256: schemaHash(t.input_schema) })), undeclared: this.undeclared, server: { name: 'fake', version: '1', protocol_version: '2025-06-18' } }
          : { id: message['id'], ok: false, error: this.listError });
      } else if (message['op'] === 'call') {
        const answer = this.onCall(message);
        if (answer !== undefined) this.emit({ id: message['id'], ...answer });
      }
    });
  }
  emit(value: unknown): void { this.#line(JSON.stringify(value)); }
  onLine(handler: (line: string) => void): void { this.#line = handler; }
  onExit(handler: () => void): void { this.#exit = handler; }
  onStderr(handler: (text: string) => void): void { this.#stderr = handler; }
  stderr(text: string): void { this.#stderr(text); }
  kill(): void { this.killed = true; }
  /** 프로세스가 죽은 것처럼 한다 */
  die(): void { this.killed = true; this.#exit(); }
  get ops(): string[] { return this.sent.filter((m) => typeof m['op'] === 'string').map((m) => String(m['op'])); }
}

/** 마이크로태스크가 비워지길 기다린다 */
export const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

/** 프로세스가 살아 있는가 (시험: 고아 서버 확인) */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
