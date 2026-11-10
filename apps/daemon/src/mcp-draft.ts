// 선언 초안 명령 (ADR-0018, docs/operations/new-site.md): `npm run mcp-draft -- <데몬 설정 경로> <site> [--out <파일>]`
// 사이트의 MCP 서버에서 도구 목록(tools/list)을 읽어 `mcp_sites[].tools[]` 에 넣을 *초안*을 낸다. 설정 파일은 고치지 않는다.
// 안전 규칙:
// - 초안은 `tools` 가 아니라 `draft_tools` 에 담는다(설정에 그대로 붙여도 알 수 없는 키라 검증기가 거부한다). 각 항목에는 `_review` 가 있고 `description` 은 비어 있다:
//   오너가 설명을 쓰고 `_review` 를 지워 `tools` 로 옮기기 전에는 어떤 도구도 열리지 않는다(기본 거부).
// - 서버가 준 이름·주석은 신뢰하지 않는 자료다. 이름은 SERVER_NAME 모양일 때만 초안에 오르고(아니면 `skipped` 에 잘라서 JSON 으로 인용), 주석은 알려진 불리언 4개만 옮긴다. 서버 설명 문자열은 아예 읽지 않는다.
// - 읽기 제안은 서버가 `readOnlyHint:true` 이고 파괴적·외부 접촉이 아니라고 *분명히* 알린 도구뿐이다. 나머지는 쓰기(external_effect + approval:draft)다.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { McpSiteManifest } from '@aot/agent-runtime';

import { readSiteListing, type SiteListing } from './mcp-pin.ts';

export const MAX_DRAFT_TOOLS = 200;
const MAX_NAME_LENGTH = 64;
/** mcp-config 의 SERVER_NAME / AGENT_NAME 과 같은 모양 (manifest.ts) */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AGENT_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

export type SafeHints = Partial<Record<(typeof HINT_KEYS)[number], boolean>>;

export interface DraftTool {
  name: string;
  as: string;
  description: '';
  scope: 'internal' | 'customer';
  impact: 'read' | 'external_effect';
  side_effect: boolean;
  approval?: 'draft';
  target: string;
  input_schema_sha256: string;
  _review: { suggested: 'read' | 'write'; basis: string; server_hints: SafeHints; todo: string };
}

export interface DraftReport {
  _notice: string;
  site: string;
  /** 설정에 이미 있는 사이트 항목(전송·인증 그대로, 도구는 비운다). 오너가 확인한 도구만 `tools` 로 옮긴다 */
  site_entry: Record<string, unknown>;
  draft_tools: DraftTool[];
  already_declared: string[];
  skipped: { name: string; reason: string }[];
  omitted_over_limit: number;
}

/** 서버가 준 문자열을 한 줄 JSON 인용으로: 제어 문자 제거, 길이 제한 */
export function quoteUntrusted(value: unknown, max = 40): string {
  const text = typeof value === 'string' ? value : String(value);
  const cleaned = Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? '?' : ch;
  }).join('');
  return JSON.stringify(cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned);
}

export function safeHints(annotations: Record<string, unknown> | null): SafeHints {
  const out: SafeHints = {};
  if (annotations === null || typeof annotations !== 'object') return out;
  for (const key of HINT_KEYS) if (typeof annotations[key] === 'boolean') out[key] = annotations[key] as boolean;
  return out;
}

export function classify(hints: SafeHints): { suggested: 'read' | 'write'; basis: string } {
  if (hints.readOnlyHint === true && hints.destructiveHint !== true && hints.openWorldHint !== true) {
    return { suggested: 'read', basis: 'server says readOnlyHint:true (a hint, not proof: read the server code before you accept it)' };
  }
  if (hints.readOnlyHint === undefined) return { suggested: 'write', basis: 'server gave no readOnlyHint, so it is treated as a write (needs approval)' };
  if (hints.readOnlyHint === true) return { suggested: 'write', basis: 'server says read-only but also destructive or open-world, so it is treated as a write' };
  return { suggested: 'write', basis: 'server says readOnlyHint:false' };
}

/** `Get-Unit.v2` → `get_unit_v2`. 에이전트 이름 모양이 안 되면 null */
export function deriveAgentName(serverName: string): string | null {
  const lowered = serverName.toLowerCase().replace(/[.-]+/g, '_');
  return AGENT_NAME.test(lowered) ? lowered : null;
}

export function buildDraft(manifest: McpSiteManifest, listing: SiteListing): DraftReport {
  const declared = new Set(manifest.tools.map((tool) => tool.name));
  const counts = new Map<string, number>();
  for (const tool of listing.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  const usedAs = new Set(manifest.tools.map((tool) => tool.as));
  const draft: DraftTool[] = [];
  const already: string[] = [];
  const skipped: DraftReport['skipped'] = [];
  let omitted = 0;
  for (const tool of listing.tools) {
    const name = tool.name;
    if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH || !SERVER_NAME.test(name)) { skipped.push({ name: quoteUntrusted(name), reason: 'name has unsupported characters or is too long' }); continue; }
    if ((counts.get(name) ?? 0) > 1) { if (!skipped.some((s) => s.name === JSON.stringify(name))) skipped.push({ name: JSON.stringify(name), reason: 'listed more than once by the server' }); continue; }
    if (declared.has(name)) { already.push(name); continue; }
    const as = deriveAgentName(name);
    if (as === null || usedAs.has(as)) { skipped.push({ name: JSON.stringify(name), reason: as === null ? 'cannot derive an agent tool name (choose `as` by hand)' : `agent name '${as}' would collide` }); continue; }
    if (draft.length >= MAX_DRAFT_TOOLS) { omitted += 1; continue; }
    usedAs.add(as);
    const hints = safeHints(tool.annotations);
    const { suggested, basis } = classify(hints);
    const read = suggested === 'read';
    draft.push({
      name, as, description: '', scope: read ? 'internal' : 'customer', impact: read ? 'read' : 'external_effect', side_effect: !read,
      ...(read ? {} : { approval: 'draft' as const }),
      target: `site:${manifest.site}/${as}`, input_schema_sha256: tool.input_schema_sha256,
      _review: { suggested, basis, server_hints: hints, todo: 'Write description (1-500 chars, by the owner), check scope/target/approval, delete this _review key, then move the entry into tools.' },
    });
  }
  return {
    _notice: 'DRAFT. Nothing here is active: tools are listed under draft_tools, descriptions are empty and every entry carries _review, so the daemon rejects this if pasted as is. Server-provided names and hints are untrusted. Review each tool against the server code, then move it into site_entry.tools.',
    site: manifest.site, site_entry: siteEntryOf(manifest), draft_tools: draft, already_declared: already, skipped, omitted_over_limit: omitted,
  };
}

function siteEntryOf(manifest: McpSiteManifest): Record<string, unknown> {
  const transport = manifest.transport;
  const auth = manifest.auth;
  return {
    site: manifest.site,
    transport: transport.kind === 'http' ? { kind: 'http', url: transport.url } : transport.kind === 'stdio' ? { kind: 'stdio', command: transport.command, args: [...transport.args] } : { kind: 'api', base_url: transport.baseUrl, network: transport.network },
    auth: auth.kind === 'bearer' ? { kind: 'bearer', token_env: auth.tokenEnv } : auth.kind === 'header' ? { kind: 'header', header: auth.header, value_env: auth.valueEnv }
      : auth.kind === 'oauth_delegated' ? { kind: 'oauth_delegated', hub: auth.hub, resource: auth.resource, scopes: [...auth.scopes] } : { kind: 'none' },
    ...(Object.keys(manifest.envFrom).length > 0 ? { env_from: { ...manifest.envFrom } } : {}),
    rate_limit_per_minute: manifest.rateLimitPerMinute, timeout_ms: manifest.timeoutMs, tools: [],
  };
}

export async function runMcpDraft(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; output: string }> {
  const args = [...argv];
  let out: string | undefined;
  const outIndex = args.indexOf('--out');
  if (outIndex >= 0) { out = args[outIndex + 1]; args.splice(outIndex, 2); }
  const [configPath, site] = args;
  if (configPath === undefined || site === undefined || args.length !== 2 || (outIndex >= 0 && (out === undefined || out === ''))) {
    return { code: 2, output: 'usage: npm run mcp-draft -- <daemon config path> <site> [--out <new file>]' };
  }
  if (out !== undefined && resolve(out) === resolve(configPath)) return { code: 2, output: 'refusing to write the draft over the config file' };
  const read = await readSiteListing(configPath, site, env);
  if (read.code !== 0) return { code: read.code, output: (read as { output: string }).output };
  const { manifest, listing } = read as { manifest: McpSiteManifest; listing: SiteListing };
  if (manifest.transport.kind === 'api') return { code: 2, output: `site '${site}' is an api site: it has no server tool list. Write the declarations by hand (docs/operations/api-sites.md)` };
  const json = JSON.stringify(buildDraft(manifest, listing), null, 2);
  if (out === undefined) return { code: 0, output: json };
  try { writeFileSync(out, `${json}\n`, { flag: 'wx', mode: 0o600 }); } catch (error) { return { code: 1, output: `could not write ${out}: ${(error as Error).message}` }; }
  return { code: 0, output: `draft written to ${out} (config file untouched; no tool is active until you review and move it into tools)` };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMcpDraft(process.argv.slice(2));
  (result.code === 0 ? console.log : console.error)(result.output);
  process.exit(result.code);
}
