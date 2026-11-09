// 오너 선언(데몬 설정 `mcp_sites[]`) 검증 (ADR-0018 §2, 설계 §2). 한 항목을 동결된 `McpSiteManifest` 로 만든다.
// 알 수 없는 키·잘못된 조합은 거부한다(기본 거부). 에이전트가 보는 도구 목록·분류·설명은 모두 여기서만 나온다 — 서버가 알리는 값은 어디에도 쓰지 않는다.
import { SCOPES, type Scope } from '@aot/domain';

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type McpTransportDecl =
  | { readonly kind: 'http'; readonly url: string }
  | { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[] };

export type McpAuthDecl =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly tokenEnv: string }
  | { readonly kind: 'header'; readonly header: string; readonly valueEnv: string };

export interface McpToolDecl {
  /** 서버가 아는 도구 이름 */
  readonly name: string;
  /** 에이전트에 보이는 이름: `mcp_<site>_<as>` */
  readonly gatewayName: string;
  readonly as: string;
  /** 오너가 쓴 설명. 에이전트에는 이것만 보인다 */
  readonly description: string;
  readonly scope: Scope;
  readonly impact: 'read' | 'external_effect';
  readonly sideEffect: boolean;
  readonly approval: 'draft' | 'scope' | null;
  readonly target: string;
  readonly inputSchemaSha256: string;
  readonly unitCostUsd: number | null;
  readonly idempotency: { readonly keyArgument: string; readonly retentionMs: number } | null;
  readonly ackServerHintConflict: boolean;
}

export interface McpSiteManifest {
  readonly site: string;
  readonly transport: McpTransportDecl;
  readonly auth: McpAuthDecl;
  /** stdio 서버가 받을 환경: 서버가 받을 이름 → 데몬 환경 변수 이름 */
  readonly envFrom: Readonly<Record<string, string>>;
  readonly rateLimitPerMinute: number;
  readonly timeoutMs: number;
  readonly tools: readonly McpToolDecl[];
}

const SITE = /^[a-z][a-z0-9]{0,15}$/;
const AGENT_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** MCP 서버 도구 이름으로 흔한 문자(대시·점 포함). `as` 가 없으면 AGENT_NAME 이어야 한다 */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'connection', 'transfer-encoding', 'upgrade', 'cookie']);
const SCHEMA_HASH = /^sha256:[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export class McpManifestError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid mcp_sites: ${problems.join('; ')}`);
    this.name = 'McpManifestError';
    this.problems = problems;
  }
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, problems: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${label}: unknown key '${key}'`);
}

function parseTransport(raw: unknown, label: string, problems: string[]): McpTransportDecl | null {
  if (!isRecord(raw)) { problems.push(`${label}.transport must be an object`); return null; }
  if (raw['kind'] === 'http') {
    checkKeys(raw, ['kind', 'url'], `${label}.transport`, problems);
    const text = raw['url'];
    if (typeof text !== 'string') { problems.push(`${label}.transport.url must be a string`); return null; }
    let url: URL;
    try { url = new URL(text); } catch { problems.push(`${label}.transport.url is not a valid URL`); return null; }
    if (url.username !== '' || url.password !== '') problems.push(`${label}.transport.url must not carry credentials (use auth)`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) problems.push(`${label}.transport.url must be https (http is allowed only for 127.0.0.1, localhost, [::1])`);
    return { kind: 'http', url: text };
  }
  if (raw['kind'] === 'stdio') {
    checkKeys(raw, ['kind', 'command', 'args'], `${label}.transport`, problems);
    const command = raw['command'];
    const args = raw['args'] ?? [];
    if (typeof command !== 'string' || !command.startsWith('/')) problems.push(`${label}.transport.command must be an absolute path`);
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) problems.push(`${label}.transport.args must be an array of strings`);
    if (typeof command !== 'string' || !Array.isArray(args)) return null;
    return { kind: 'stdio', command, args: Object.freeze([...(args as string[])]) };
  }
  problems.push(`${label}.transport.kind must be 'http' or 'stdio'`);
  return null;
}

function parseAuth(raw: unknown, label: string, problems: string[]): McpAuthDecl {
  if (raw === undefined) return { kind: 'none' };
  if (!isRecord(raw)) { problems.push(`${label}.auth must be an object`); return { kind: 'none' }; }
  if (raw['kind'] === 'none') { checkKeys(raw, ['kind'], `${label}.auth`, problems); return { kind: 'none' }; }
  if (raw['kind'] === 'bearer') {
    checkKeys(raw, ['kind', 'token_env'], `${label}.auth`, problems);
    if (typeof raw['token_env'] !== 'string' || !ENV_NAME.test(raw['token_env'])) problems.push(`${label}.auth.token_env must name an environment variable`);
    return { kind: 'bearer', tokenEnv: String(raw['token_env']) };
  }
  if (raw['kind'] === 'header') {
    checkKeys(raw, ['kind', 'header', 'value_env'], `${label}.auth`, problems);
    const header = raw['header'];
    if (typeof header !== 'string' || !HEADER_NAME.test(header) || FORBIDDEN_HEADERS.has(header.toLowerCase())) problems.push(`${label}.auth.header must be a plain header name that is not reserved`);
    if (typeof raw['value_env'] !== 'string' || !ENV_NAME.test(raw['value_env'])) problems.push(`${label}.auth.value_env must name an environment variable`);
    return { kind: 'header', header: String(header), valueEnv: String(raw['value_env']) };
  }
  problems.push(`${label}.auth.kind must be 'none', 'bearer' or 'header'`);
  return { kind: 'none' };
}

function parseTool(raw: unknown, site: string, label: string, problems: string[]): McpToolDecl | null {
  if (!isRecord(raw)) { problems.push(`${label} must be an object`); return null; }
  const before = problems.length;
  checkKeys(raw, ['name', 'as', 'description', 'scope', 'impact', 'side_effect', 'approval', 'target', 'input_schema_sha256', 'unit_cost_usd', 'idempotency', 'ack_server_hint_conflict'], label, problems);
  const name = raw['name'];
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) problems.push(`${label}.name must be a server tool name`);
  const as = raw['as'] ?? name;
  if (typeof as !== 'string' || !AGENT_NAME.test(as)) problems.push(`${label}.as (or name when as is omitted) must match ${String(AGENT_NAME)}`);
  const description = raw['description'];
  if (typeof description !== 'string' || description.trim() === '' || description.length > 500) problems.push(`${label}.description is required (1-500 characters, written by the owner)`);
  const scope = raw['scope'];
  if (!(SCOPES as readonly unknown[]).includes(scope)) problems.push(`${label}.scope must be one of ${SCOPES.join('|')}`);
  const impact = raw['impact'];
  if (impact !== 'read' && impact !== 'external_effect') problems.push(`${label}.impact must be 'read' or 'external_effect'`);
  const sideEffect = raw['side_effect'];
  if (typeof sideEffect !== 'boolean') problems.push(`${label}.side_effect must be a boolean`);
  else if ((impact === 'read') === sideEffect) problems.push(`${label}: impact '${String(impact)}' contradicts side_effect ${String(sideEffect)}`);
  const approval = raw['approval'];
  if (impact === 'read' && approval !== undefined) problems.push(`${label}: a read tool must not declare approval`);
  if (impact === 'external_effect' && approval !== 'draft' && approval !== 'scope') problems.push(`${label}.approval ('draft' or 'scope') is required for a write tool`);
  const target = raw['target'];
  if (typeof target !== 'string' || target.trim() === '' || target.length > 200) problems.push(`${label}.target is required (1-200 characters)`);
  const hash = raw['input_schema_sha256'];
  if (typeof hash !== 'string' || !SCHEMA_HASH.test(hash)) problems.push(`${label}.input_schema_sha256 is required ('sha256:' + 64 hex; run npm run mcp-pin)`);
  const cost = raw['unit_cost_usd'];
  if (cost !== undefined && !(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) problems.push(`${label}.unit_cost_usd must be a non-negative number`);
  let idempotency: McpToolDecl['idempotency'] = null;
  if (raw['idempotency'] !== undefined) {
    const idem = raw['idempotency'];
    if (impact !== 'external_effect') problems.push(`${label}: idempotency is only for write tools`);
    if (!isRecord(idem)) problems.push(`${label}.idempotency must be an object`);
    else {
      checkKeys(idem, ['key_argument', 'retention_ms'], `${label}.idempotency`, problems);
      if (typeof idem['key_argument'] !== 'string' || idem['key_argument'] === '') problems.push(`${label}.idempotency.key_argument is required`);
      if (!isInt(idem['retention_ms'], 1, Number.MAX_SAFE_INTEGER)) problems.push(`${label}.idempotency.retention_ms must be a positive integer`);
      else if (typeof idem['key_argument'] === 'string' && idem['key_argument'] !== '') idempotency = Object.freeze({ keyArgument: idem['key_argument'], retentionMs: idem['retention_ms'] });
    }
  }
  const ack = raw['ack_server_hint_conflict'];
  if (ack !== undefined && typeof ack !== 'boolean') problems.push(`${label}.ack_server_hint_conflict must be a boolean`);
  if (ack !== undefined && impact !== 'read') problems.push(`${label}: ack_server_hint_conflict is only for read tools`);
  if (problems.length > before) return null;
  return Object.freeze({
    name: name as string, as: as as string, gatewayName: `mcp_${site}_${as as string}`, description: (description as string).trim(), scope: scope as Scope,
    impact: impact as 'read' | 'external_effect', sideEffect: sideEffect as boolean, approval: impact === 'read' ? null : (approval as 'draft' | 'scope'),
    target: target as string, inputSchemaSha256: hash as string, unitCostUsd: typeof cost === 'number' ? cost : null, idempotency, ackServerHintConflict: ack === true,
  });
}

/** `mcp_sites[]` 의 한 항목을 검증한다. 오류는 전부 모아 던진다 */
export function parseMcpSite(raw: unknown, index = 0): McpSiteManifest {
  const problems: string[] = [];
  const manifest = validateSite(raw, `mcp_sites[${index}]`, problems);
  if (manifest === null || problems.length > 0) throw new McpManifestError(problems);
  return manifest;
}

function validateSite(raw: unknown, label: string, problems: string[]): McpSiteManifest | null {
  if (!isRecord(raw)) { problems.push(`${label} must be an object`); return null; }
  checkKeys(raw, ['site', 'transport', 'auth', 'env_from', 'rate_limit_per_minute', 'timeout_ms', 'tools'], label, problems);
  const site = raw['site'];
  if (typeof site !== 'string' || !SITE.test(site)) problems.push(`${label}.site must match ${String(SITE)}`);
  const transport = parseTransport(raw['transport'], label, problems);
  const auth = parseAuth(raw['auth'], label, problems);
  let envFrom: Record<string, string> = {};
  if (raw['env_from'] !== undefined) {
    const env = raw['env_from'];
    if (!isRecord(env) || !Object.entries(env).every(([k, v]) => ENV_NAME.test(k) && typeof v === 'string' && ENV_NAME.test(v))) problems.push(`${label}.env_from must map environment names to daemon environment variable names`);
    else envFrom = { ...(env as Record<string, string>) };
    if (transport?.kind === 'http') problems.push(`${label}.env_from is only for stdio transports`);
  }
  if (transport?.kind === 'stdio' && auth.kind !== 'none') problems.push(`${label}: a stdio server gets its secrets through env_from, not auth`);
  const rate = raw['rate_limit_per_minute'] ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (!isInt(rate, 1, 600)) problems.push(`${label}.rate_limit_per_minute must be an integer 1-600`);
  const timeout = raw['timeout_ms'] ?? DEFAULT_TIMEOUT_MS;
  if (!isInt(timeout, 1000, 120_000)) problems.push(`${label}.timeout_ms must be an integer 1000-120000`);
  const toolsRaw = raw['tools'];
  if (!Array.isArray(toolsRaw)) problems.push(`${label}.tools must be an array (use [] before the first mcp-pin)`);
  const tools: McpToolDecl[] = [];
  if (Array.isArray(toolsRaw) && typeof site === 'string') {
    const names = new Set<string>();
    const serverNames = new Set<string>();
    toolsRaw.forEach((entry, i) => {
      const tool = parseTool(entry, site, `${label}.tools[${i}]`, problems);
      if (tool === null) return;
      if (names.has(tool.gatewayName)) problems.push(`${label}.tools[${i}]: agent tool name '${tool.gatewayName}' is used twice`);
      if (serverNames.has(tool.name)) problems.push(`${label}.tools[${i}]: server tool '${tool.name}' is declared twice`);
      names.add(tool.gatewayName);
      serverNames.add(tool.name);
      tools.push(tool);
    });
  }
  if (transport === null || typeof site !== 'string' || problems.length > 0) return null;
  return Object.freeze({
    site, transport, auth, envFrom: Object.freeze(envFrom), rateLimitPerMinute: rate as number, timeoutMs: timeout as number, tools: Object.freeze(tools),
  });
}

/** `mcp_sites` 전체를 검증한다. 사이트 이름이 겹치면 거부한다 */
export function parseMcpSites(raw: unknown): McpSiteManifest[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new McpManifestError(['mcp_sites must be an array']);
  const problems: string[] = [];
  const out: McpSiteManifest[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const local: string[] = [];
    const manifest = validateSite(entry, `mcp_sites[${i}]`, local);
    problems.push(...local);
    if (manifest === null) return;
    if (seen.has(manifest.site)) problems.push(`mcp_sites[${i}]: site '${manifest.site}' is declared twice`);
    seen.add(manifest.site);
    out.push(manifest);
  });
  if (problems.length > 0) throw new McpManifestError(problems);
  return out;
}

/** 이 사이트의 비밀을 담은 데몬 환경 변수 이름 (커넥터 프로세스에 넘기는 변수의 전부) */
export function secretEnvNames(manifest: McpSiteManifest): string[] {
  const names: string[] = [];
  if (manifest.auth.kind === 'bearer') names.push(manifest.auth.tokenEnv);
  if (manifest.auth.kind === 'header') names.push(manifest.auth.valueEnv);
  names.push(...Object.values(manifest.envFrom));
  return [...new Set(names)];
}
