// ADR-0020: `mcp-pin`(별칭 api-pin)이 api 사이트의 선언 고정 값을 출력하고 서비스에는 요청을 보내지 않는다. 예시 설정의 고정 값이 선언과 맞는다.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { apiPinOf, parseMcpSites } from '@aot/agent-runtime';

import { runMcpPin } from '../../apps/daemon/src/mcp-pin.ts';
import { mcpOptionsFromConfig } from '../../apps/daemon/src/mcp-config.ts';
import { startFakeService } from '../fixtures/api/fake-service.ts';
import { API_TOKEN, API_TOKEN_ENV, apiSiteRaw, withPins } from '../support/api.ts';
import { makeTempDir } from '../support/temp.ts';

const env = { [API_TOKEN_ENV]: API_TOKEN };

test('mcp-pin on an api site: unpinned tools show drift with the hash to copy; pinned tools show open; no request reaches the service; the token is not printed', async (t) => {
  const service = await startFakeService(t);
  const dir = makeTempDir(t, 'aot-api-pin-');
  const configPath = join(dir, 'daemon.config.json');
  writeFileSync(configPath, JSON.stringify({ mcp_sites: [apiSiteRaw(service.baseUrl)] }));
  const first = await runMcpPin([configPath, 'web'], env);
  assert.equal(first.code, 0, first.output);
  const [manifest] = parseMcpSites([apiSiteRaw(service.baseUrl)]);
  for (const tool of manifest!.tools) assert.ok(first.output.includes(`input_schema_sha256: ${apiPinOf(tool)}`), tool.name);
  assert.equal([...first.output.matchAll(/^drift /gm)].length, 3);
  assert.equal(service.seen.length, 0);
  assert.ok(!first.output.includes(API_TOKEN));

  writeFileSync(configPath, JSON.stringify({ mcp_sites: [withPins(apiSiteRaw(service.baseUrl))] }));
  const second = await runMcpPin([configPath, 'web'], env);
  assert.equal([...second.output.matchAll(/^open /gm)].length, 3, second.output);
  assert.equal(service.seen.length, 0);
});

test('the example config: _api_sites_example parses and every pin matches its declaration', () => {
  const example = JSON.parse(readFileSync(new URL('../../config/daemon.config.example.json', import.meta.url), 'utf8')) as { _api_sites_example: unknown };
  const [site] = parseMcpSites(example._api_sites_example);
  assert.equal(site!.transport.kind, 'api');
  assert.deepEqual(site!.tools.map((tool) => [tool.as, tool.impact]), [['draft_post', 'external_effect'], ['list_images', 'read'], ['list_posts', 'read']]);
  for (const tool of site!.tools) assert.equal(tool.inputSchemaSha256, apiPinOf(tool), `${tool.name}: run mcp-pin and update the example pin`);
});

test('daemon config: an api site reads its secret from the environment by name and a missing variable stops the start', () => {
  const raw = withPins(apiSiteRaw('http://127.0.0.1:9'));
  const options = mcpOptionsFromConfig({ mcp_sites: [raw] }, env);
  assert.deepEqual(options?.sites[0]?.secretEnv, env);
  assert.throws(() => mcpOptionsFromConfig({ mcp_sites: [raw] }, {}), /environment variable AOT_API_WEB_TOKEN is not set/);
});
