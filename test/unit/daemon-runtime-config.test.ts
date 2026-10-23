// A5 U6: 데몬 설정 -> 에이전트 실행 환경(apps/daemon/src/runtime-config.ts). docker 를 쓰지 않는다(경로만 있으면 되고 실행하지 않는다).
// 설정에서 어떤 부품이 어떻게 연결되는지(어댑터 이름, 도구 선언, 허용 호스트가 도구와 출처 조회기에 같이 전달되는지, 설정이 없으면 아무것도 연결되지 않는지)를 고정한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RESEARCH_AGENT_NAME, type FetchUrlToolOptions, type SourceFetcherOptions } from '@aot/agent-runtime';

import { buildAgentRuntime, deriveInstanceId, type AgentRuntimeConfig } from '../../apps/daemon/src/runtime-config.ts';
import { REPO_ROOT } from '../support/schema-snapshot.ts';

const IMAGE = `sha256:${'ab12'.repeat(16)}`;
const CONTAINER = { docker_path: '/opt/example/bin/docker', memory_mib: 256, cpus: 1, pids_limit: 64, tmpfs_mib: 32 };
const DIR = '/srv/example/instance';

describe('buildAgentRuntime: nothing is wired without settings (the previous behaviour)', () => {
  it('no container_agent: no agent, no evaluation port (a validating task is never completed automatically)', () => {
    for (const config of [{}, { container_agent: null }, { container_agent: null, research_agent: null }] as AgentRuntimeConfig[]) {
      const built = buildAgentRuntime(config, DIR);
      assert.equal(built.agent, undefined);
      assert.equal(built.evaluation, undefined);
    }
  });

  it('container_agent alone: the generic container adapter, no tools, no evaluation port', () => {
    const built = buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE, agent_args: ['roundtrip'] } }, DIR);
    assert.ok(built.agent);
    assert.equal(built.agent.adapter.name, 'container-sandbox');
    assert.equal(built.agent.tools, undefined);
    assert.equal(built.agent.executors, undefined);
    assert.equal(built.evaluation, undefined);
    assert.ok(built.agent.docker, 'the docker CLI is given so that daemon start checks docker and cleans up orphans');
    assert.equal(built.agent.instanceId, built.instanceId);
  });

  it('research_agent without container_agent is a configuration error, not a silent no-op', () => {
    assert.throws(() => buildAgentRuntime({ research_agent: { image: IMAGE, allowed_hosts: ['docs.example.com'] } }, DIR), /container_agent/);
    assert.throws(() => buildAgentRuntime({ container_agent: { ...CONTAINER } }, DIR), /container_agent\.image is required/);
  });
});

describe('buildAgentRuntime: research_agent wires the tool, the adapter and the same host list into the source fetcher', () => {
  it('declares fetch_url (internal read, no side effect, external_untrusted result) with an executor, and names the adapter research-agent', () => {
    const built = buildAgentRuntime({ container_agent: CONTAINER, research_agent: { image: IMAGE, allowed_hosts: ['docs.example.com'], fetch_unit_cost_usd: 0.001 } }, DIR);
    assert.equal(built.agent?.adapter.name, RESEARCH_AGENT_NAME);
    assert.deepEqual(built.agent?.tools?.map((tool) => [tool.tool, tool.operation, tool.scope, tool.impact, tool.sideEffect, tool.resultOrigin, tool.unitCost]), [
      ['fetch_url', 'fetch', 'internal', 'read', false, 'external_untrusted', { usd: 0.001 }],
    ]);
    assert.deepEqual([...(built.agent?.executors?.keys() ?? [])], ['fetch_url']);
    assert.ok(built.evaluation?.fetcher, 'the validator gets a source fetcher');
  });

  it('the allowed hosts and limits of the settings reach both the tool and the source fetcher, unchanged', () => {
    let toolOptions: FetchUrlToolOptions | undefined;
    let fetcherOptions: SourceFetcherOptions | undefined;
    const config: AgentRuntimeConfig = {
      container_agent: CONTAINER,
      research_agent: { image: IMAGE, allowed_hosts: ['docs.example.com', '*.example.org'], max_body_bytes: 1000, max_redirects: 2, fetch_unit_cost_usd: 0.002, source_fetch_timeout_ms: 7000 },
    };
    buildAgentRuntime(config, DIR, {
      createFetchUrlTool: (options) => { toolOptions = options; return { spec: { tool: 'fetch_url', operation: 'fetch', scope: 'internal', sideEffect: false }, executor: () => Promise.reject(new Error('unused')) }; },
      createSourceFetcher: (options) => { fetcherOptions = options; return { fetch: () => Promise.resolve({ reachable: false, reason: 'unused' }) }; },
    });
    assert.deepEqual(toolOptions, { allowedHosts: ['docs.example.com', '*.example.org'], maxBodyBytes: 1000, maxRedirects: 2, unitCost: { usd: 0.002 } });
    assert.deepEqual(fetcherOptions, { allowedHosts: ['docs.example.com', '*.example.org'], maxBodyBytes: 1000, maxRedirects: 2, unitCost: { usd: 0.002 }, fetchTimeoutMs: 7000 });
  });

  it('an empty allowed_hosts list is accepted (it denies every host) and a bad list fails at startup', () => {
    const built = buildAgentRuntime({ container_agent: CONTAINER, research_agent: { image: IMAGE, allowed_hosts: [] } }, DIR);
    assert.ok(built.evaluation?.fetcher);
    for (const allowed_hosts of [['*'], ['docs.example.com/path'], ['user@docs.example.com'], ['']]) {
      assert.throws(() => buildAgentRuntime({ container_agent: CONTAINER, research_agent: { image: IMAGE, allowed_hosts } }, DIR), /allowedHosts/);
    }
    assert.throws(() => buildAgentRuntime({ container_agent: CONTAINER, research_agent: { image: IMAGE } as unknown as AgentRuntimeConfig['research_agent'] & object }, DIR), /allowed_hosts/);
  });

  it('a production-form source fetcher refuses a host that is not on the list without any connection', async () => {
    const built = buildAgentRuntime({ container_agent: CONTAINER, research_agent: { image: IMAGE, allowed_hosts: ['docs.example.com'] } }, DIR);
    assert.deepEqual(await built.evaluation!.fetcher.fetch('http://other.example.com/'), { reachable: false, reason: 'host_not_allowed' });
    assert.deepEqual(await built.evaluation!.fetcher.fetch('http://127.0.0.1:9/'), { reachable: false, reason: 'host_not_allowed' });
  });
});

describe('instance id', () => {
  it('derives a safe, stable id from the instance directory and tells instances apart', () => {
    const a = deriveInstanceId('/srv/example/instance-a');
    assert.match(a, /^i-[0-9a-f]{16}$/);
    assert.equal(deriveInstanceId('/srv/example/instance-a'), a);
    assert.notEqual(deriveInstanceId('/srv/example/instance-b'), a);
    assert.equal(buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE } }, '/srv/example/instance-a').instanceId, a);
  });

  it('instance_id from the settings wins and must be label-safe', () => {
    assert.equal(buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE }, instance_id: 'daemon-1' }, DIR).instanceId, 'daemon-1');
    for (const instance_id of ['', 'a b', 'x=y', '-x', 'a'.repeat(64)]) assert.throws(() => buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE }, instance_id }, DIR), /instance_id/);
  });
});

describe('the example settings file', () => {
  it('parses, keeps the agent off by default, and holds no secret-looking value', () => {
    const text = readFileSync(join(REPO_ROOT, 'config', 'daemon.config.example.json'), 'utf8');
    const config = JSON.parse(text) as AgentRuntimeConfig & Record<string, unknown>;
    assert.equal(config.container_agent, null);
    assert.equal(config.research_agent, null);
    assert.equal(buildAgentRuntime(config, DIR).agent, undefined);
    assert.ok(!/(token|secret|password|api[_-]?key)\s*"\s*:/i.test(text.replace(/"_comment"[^\n]*/, '')), 'no credential-like key in the example settings');
  });
});
