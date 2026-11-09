// 데몬 설정 mcp_sites (ADR-0018): 환경 변수 *이름*만 받고, 값이 비어 있으면 시작하지 않는다. 도구 이름 충돌은 조립이 거부한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { McpManifestError } from '@aot/agent-runtime';

import { mcpOptionsFromConfig, readSiteSecrets } from '../../apps/daemon/src/mcp-config.ts';
import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { createFakeAgentAdapter } from '@aot/agent-runtime';
import { join } from 'node:path';
import { manualTimers } from '../support/engine.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { httpSiteRaw, manifestOf, SEARCH_TOOL, TEST_TOKEN, TOKEN_ENV } from '../support/mcp.ts';
import { AGENT, policyEnv } from '../support/policy.ts';

const raw = () => httpSiteRaw('https://mcp.course.example.com/mcp');

test('no mcp_sites: nothing is assembled', () => {
  assert.equal(mcpOptionsFromConfig({}), undefined);
  assert.equal(mcpOptionsFromConfig({ mcp_sites: [] }), undefined);
});

test('the secret value is read from the named environment variable; it is not part of the manifest', () => {
  const options = mcpOptionsFromConfig({ mcp_sites: [raw()] }, { [TOKEN_ENV]: TEST_TOKEN })!;
  assert.deepEqual(options.sites[0]!.secretEnv, { [TOKEN_ENV]: TEST_TOKEN });
  assert.ok(!JSON.stringify(options.sites[0]!.manifest).includes(TEST_TOKEN));
});

test('an unset or empty secret variable stops the daemon at startup', () => {
  assert.throws(() => mcpOptionsFromConfig({ mcp_sites: [raw()] }, {}), new RegExp(`environment variable ${TOKEN_ENV} is not set`));
  assert.throws(() => mcpOptionsFromConfig({ mcp_sites: [raw()] }, { [TOKEN_ENV]: '' }), /is not set/);
  assert.throws(() => readSiteSecrets(manifestOf(raw()), {}), /site 'course'/);
});

test('a literal secret in the declaration is rejected (only names are accepted)', () => {
  assert.throws(() => mcpOptionsFromConfig({ mcp_sites: [{ ...raw(), auth: { kind: 'bearer', token: TEST_TOKEN } }] }, {}), McpManifestError);
});

test('stdio servers get their secrets through env_from names only; all of them must be set', () => {
  const stdio = { site: 'course', transport: { kind: 'stdio', command: '/usr/bin/server', args: [] }, env_from: { API_KEY: 'COURSE_KEY_ENV', OTHER: 'COURSE_OTHER_ENV' }, tools: [] };
  assert.throws(() => mcpOptionsFromConfig({ mcp_sites: [stdio] }, { COURSE_KEY_ENV: 'x' }), /COURSE_OTHER_ENV/);
  const ok = mcpOptionsFromConfig({ mcp_sites: [stdio] }, { COURSE_KEY_ENV: 'a', COURSE_OTHER_ENV: 'b' })!;
  assert.deepEqual(ok.sites[0]!.secretEnv, { COURSE_KEY_ENV: 'a', COURSE_OTHER_ENV: 'b' });
});

test('assembly refuses an MCP tool whose name is already configured', (t) => {
  const env = policyEnv(t);
  const manifest = manifestOf(raw());
  assert.throws(() => assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: {
      adapter: createFakeAgentAdapter({ clock: env.clock, scenario: 'tool_calls', name: 'x', evidence: [], toolCalls: [] }),
      tools: [{ tool: SEARCH_TOOL, operation: 'call', scope: 'internal', sideEffect: false }], timers: new ManualGatewayTimers(),
    },
    mcp: { sites: [{ manifest, secretEnv: { [TOKEN_ENV]: TEST_TOKEN } }] },
  }), /already configured; the mcp connector provides it/);
});

test('without the mcp option the daemon has no MCP runtime and no extra tools', (t) => {
  const env = policyEnv(t);
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(),
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    executor: { execute: () => Promise.reject(new Error('unused')) },
  });
  assert.equal(daemon.mcp, null);
});
