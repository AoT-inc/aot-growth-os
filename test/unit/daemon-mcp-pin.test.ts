// mcp-pin (ADR-0018): 서버의 도구 목록·스키마 해시를 출력하고 선언과 비교한다. 설정 파일을 쓰지 않는다.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { comparePins, formatPinReport, runMcpPin } from '../../apps/daemon/src/mcp-pin.ts';
import { DRIFTED_UPDATE_SCHEMA } from '../fixtures/mcp/fake-server.ts';
import { manifestOf, SEARCH_HASH, searchDecl, SECRET_ENV, stdioSiteRaw, UPDATE_HASH, updateDecl } from '../support/mcp.ts';
import { makeTempDir } from '../support/temp.ts';

const info = (name: string, schema: unknown, annotations: Record<string, unknown> | null = null) => ({ name, input_schema: schema, input_schema_sha256: 'sha256:x', annotations });

test('comparePins labels open / drift / missing / hint_conflict / undeclared', () => {
  const manifest = manifestOf(stdioSiteRaw('normal', undefined, { tools: [searchDecl(), updateDecl(), searchDecl({ name: 'gone', as: 'gone_tool' })] }));
  const rows = comparePins(manifest, { tools: [info('units_search', { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] }, { readOnlyHint: false }), info('unit_update', DRIFTED_UPDATE_SCHEMA), info('extra', {})] });
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [['units_search', 'hint_conflict'], ['unit_update', 'drift'], ['extra', 'undeclared'], ['gone', 'missing']]);
  assert.equal(comparePins(manifest, { tools: [info('units_search', { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] }), info('unit_update', DRIFTED_UPDATE_SCHEMA)] }).find((r) => r.name === 'units_search')!.status, 'open');
});

test('runMcpPin starts the real connector against the fake server, prints hashes and statuses, and never writes the config', async (t) => {
  const dir = makeTempDir(t);
  const configPath = join(dir, 'daemon.config.json');
  const config = { mcp_sites: [stdioSiteRaw('adds_tools', undefined, { tools: [searchDecl()] })] };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const before = readFileSync(configPath, 'utf8');
  const result = await runMcpPin([configPath, 'course'], SECRET_ENV);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, new RegExp(`open +"units_search"\\n +input_schema_sha256: ${SEARCH_HASH}`));
  assert.match(result.output, new RegExp(`undeclared +"unit_update"\\n +input_schema_sha256: ${UPDATE_HASH}`));
  assert.match(result.output, /undeclared +"admin_delete"/);
  assert.match(result.output, /annotations: \{"readOnlyHint":true\}/);
  assert.ok(!result.output.includes('SERVER DESCRIPTION'), 'server descriptions are not printed');
  assert.equal(readFileSync(configPath, 'utf8'), before);
  assert.equal(formatPinReport({ site: 'x', server: { name: 'n', version: '1', protocol_version: 'p' }, rows: [] }).includes('(the server lists no tools)'), true);
});

test('runMcpPin: usage, unknown site and a missing secret are reported without starting anything', async (t) => {
  const dir = makeTempDir(t);
  const configPath = join(dir, 'daemon.config.json');
  writeFileSync(configPath, JSON.stringify({ mcp_sites: [stdioSiteRaw('normal', undefined, { tools: [] })] }));
  assert.equal((await runMcpPin([])).code, 2);
  assert.match((await runMcpPin([configPath, 'other'], SECRET_ENV)).output, /not in mcp_sites/);
  await assert.rejects(runMcpPin([configPath, 'course'], {}), /environment variable/);
});
