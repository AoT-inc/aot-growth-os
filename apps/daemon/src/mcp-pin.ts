// 고정 확인 명령 (ADR-0018, docs/operations/mcp-sites.md): `npm run mcp-pin -- <데몬 설정 경로> <site>`
// 사이트의 MCP 서버에 접속해 도구 목록을 읽고, 도구마다 입력 스키마 해시(`sha256:`)·서버 주석·오너 선언과의 일치 여부를 출력한다.
// 일치 여부: open(선언과 같다) | drift(스키마가 다르다) | missing(선언했는데 서버에 없다) | hint_conflict(읽기 선언인데 서버가 읽기 전용이 아니라고 알린다) | undeclared(선언에 없다).
// 설정 파일을 쓰지 않는다. 선언 밖 도구의 스키마도 보되(inspect 모드) 호출은 하지 않는다. 서버 설명은 보여 주지 않는다(길이만) — 오너가 직접 설명을 쓴다.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createMcpSiteClient, evaluateTool, parseMcpSites, spawnConnectorProcess, type McpSiteManifest } from '@aot/agent-runtime';
import { systemClock } from '@aot/domain';

import { readSiteSecrets } from './mcp-config.ts';

export interface PinRow {
  name: string;
  hash: string;
  annotations: Record<string, unknown> | null;
  status: 'open' | 'drift' | 'missing' | 'hint_conflict' | 'undeclared' | 'invalid_declaration' | 'duplicate';
}

export interface PinReport {
  site: string;
  server: { name: string; version: string; protocol_version: string };
  rows: PinRow[];
}

/** 서버 목록과 선언을 비교한다 (순수 함수) */
export function comparePins(manifest: McpSiteManifest, listing: { tools: readonly { name: string; input_schema: unknown; input_schema_sha256: string; annotations: Record<string, unknown> | null }[] }): PinRow[] {
  const rows: PinRow[] = [];
  const declared = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const tool of listing.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  for (const tool of listing.tools) {
    seen.add(tool.name);
    const decl = declared.get(tool.name);
    // 같은 이름이 둘 이상이면 어느 쪽이 진짜인지 알 수 없다 (호스트도 그 도구를 닫는다)
    if ((counts.get(tool.name) ?? 0) > 1) { rows.push({ name: tool.name, hash: tool.input_schema_sha256, annotations: tool.annotations, status: 'duplicate' }); continue; }
    if (decl === undefined) { rows.push({ name: tool.name, hash: tool.input_schema_sha256, annotations: tool.annotations, status: 'undeclared' }); continue; }
    const state = evaluateTool(decl, { name: tool.name, inputSchema: tool.input_schema, annotations: tool.annotations });
    rows.push({ name: tool.name, hash: tool.input_schema_sha256, annotations: tool.annotations, status: state.status === 'open' ? 'open' : state.reason === 'unavailable' ? 'missing' : state.reason });
  }
  for (const decl of manifest.tools) if (!seen.has(decl.name)) rows.push({ name: decl.name, hash: '-', annotations: null, status: 'missing' });
  return rows;
}

export function formatPinReport(report: PinReport): string {
  // 서버가 정한 문자열은 JSON 으로 따옴표를 쳐서 출력한다(제어 문자·줄바꿈이 터미널을 속이지 못한다)
  const lines = [`site ${report.site}: server ${JSON.stringify(report.server.name)} ${JSON.stringify(report.server.version)} (MCP ${JSON.stringify(report.server.protocol_version)})`];
  for (const row of report.rows) {
    lines.push(`${row.status.padEnd(18)} ${JSON.stringify(row.name)}`);
    lines.push(`${' '.repeat(19)}input_schema_sha256: ${row.hash}`);
    lines.push(`${' '.repeat(19)}annotations: ${row.annotations === null ? '(none)' : JSON.stringify(row.annotations)}`);
  }
  if (report.rows.length === 0) lines.push('(the server lists no tools)');
  lines.push('Nothing was written. Copy the hash of each tool you classified into mcp_sites[].tools[].input_schema_sha256.');
  return lines.join('\n');
}

export async function runMcpPin(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; output: string }> {
  const [configPath, site] = argv;
  if (configPath === undefined || site === undefined) return { code: 2, output: 'usage: npm run mcp-pin -- <daemon config path> <site>' };
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { mcp_sites?: unknown };
  const manifest = parseMcpSites(config.mcp_sites).find((entry) => entry.site === site);
  if (manifest === undefined) return { code: 2, output: `site '${site}' is not in mcp_sites of ${configPath}` };
  const secretEnv = readSiteSecrets(manifest, env);
  const client = createMcpSiteClient({ manifest, clock: systemClock, spawn: () => spawnConnectorProcess(secretEnv), inspect: true, onEvent: () => undefined });
  try {
    await client.start();
    const listing = client.lastListing();
    if (listing === null) return { code: 1, output: `could not read the tool list of site '${site}' (is the server reachable and the token valid?)` };
    return { code: 0, output: formatPinReport({ site, server: listing.server, rows: comparePins(manifest, listing) }) };
  } finally {
    await client.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMcpPin(process.argv.slice(2));
  (result.code === 0 ? console.log : console.error)(result.output);
  process.exit(result.code);
}
