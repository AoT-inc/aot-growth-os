// A5 U6: 데몬 설정 -> 에이전트 실행 환경(apps/daemon/src/runtime-config.ts). docker 를 쓰지 않는다(경로만 있으면 되고 실행하지 않는다).
// 설정에서 어떤 부품이 어떻게 연결되는지(어댑터 이름, 도구 선언, 허용 호스트가 도구와 출처 조회기에 같이 전달되는지, 설정이 없으면 아무것도 연결되지 않는지)를 고정한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RESEARCH_AGENT_NAME, type FetchUrlToolOptions, type SourceFetcherOptions } from '@aot/agent-runtime';
import { buildIsolatedInput, STUB_LLM_VERIFIER_ID, type LlmVerifier } from '@aot/evaluation';

import { buildAgentRuntime, deriveInstanceId, parseClaudeCodeCliConfig, parseLlmVerifierConfig, parseRegistrationToolsConfig, type AgentRuntimeConfig, type ClaudeCodeCliConfig } from '../../apps/daemon/src/runtime-config.ts';
import { REPO_ROOT } from '../support/schema-snapshot.ts';
import { seededDb } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

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

describe('llm_verifier: the stub verifier is switched on by the settings; nothing is wired without the key', () => {
  const RESEARCH = { image: IMAGE, allowed_hosts: ['docs.example.com'] };
  const input = () => buildIsolatedInput({
    check: 'claim_supported_by_source', criteria: [], claims: [{ id: 'c1', statement: 'Seats are counted per team.', sourceRef: 'https://docs.example.com/a' }],
    sources: [{ ref: 'https://docs.example.com/a', kind: 'source_url', text: 'Seats are counted per team.', contentHash: null, trustOrigin: 'external_untrusted' }],
  });

  it('absent or null: no verifier (the previous behaviour: a task that asks for LLM verification ends inconclusive)', () => {
    for (const llm_verifier of [undefined, null]) {
      const built = buildAgentRuntime({ container_agent: CONTAINER, research_agent: RESEARCH, ...(llm_verifier === undefined ? {} : { llm_verifier }) }, DIR);
      assert.ok(built.evaluation?.fetcher);
      assert.equal(built.evaluation && 'llm' in built.evaluation, false);
    }
  });

  it('{kind: "stub"}: the stub verifier is wired next to the source fetcher; it is a working stub (default rule) with no cost', async () => {
    const built = buildAgentRuntime({ container_agent: CONTAINER, research_agent: RESEARCH, llm_verifier: { kind: 'stub' } }, DIR);
    const llm = built.evaluation?.llm;
    assert.equal(llm?.id, STUB_LLM_VERIFIER_ID);
    assert.deepEqual(await llm!.verify(input()), { verdict: 'supported', note: 'stub (no model call): 1 claim(s) supported by their sources' });
  });

  it('cost_usd is carried to the stub (a verification cost entry is then recorded by the evaluator)', async () => {
    const built = buildAgentRuntime({ container_agent: CONTAINER, research_agent: RESEARCH, llm_verifier: { kind: 'stub', cost_usd: 0.01 } }, DIR);
    assert.equal((await built.evaluation!.llm!.verify(input())).costUsd, 0.01);
  });

  it('any other kind is refused, as are unknown keys and bad values; so is a stub verifier without an evaluation port', () => {
    const bad: unknown[] = [{ kind: 'openai' }, { kind: 'model' }, { kind: 'STUB' }, {}, { kind: null }, { kind: 'stub', model: 'x' }, { kind: 'stub', cost_usd: -1 }, { kind: 'stub', cost_usd: '0.1' }, { kind: 'stub', cost_usd: Number.POSITIVE_INFINITY }, 'stub', ['stub'], 3];
    for (const llm_verifier of bad) {
      assert.throws(() => buildAgentRuntime({ container_agent: CONTAINER, research_agent: RESEARCH, llm_verifier } as AgentRuntimeConfig, DIR), /llm_verifier/, JSON.stringify(llm_verifier));
      assert.throws(() => parseLlmVerifierConfig(llm_verifier), /llm_verifier/);
    }
    assert.throws(() => buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE }, llm_verifier: { kind: 'stub' } }, DIR), /llm_verifier \(kind "stub"\) needs research_agent/);
    assert.throws(() => buildAgentRuntime({ llm_verifier: { kind: 'stub' } }, DIR), /llm_verifier \(kind "stub"\) needs research_agent/);
    assert.throws(() => buildAgentRuntime({ llm_verifier: { kind: 'openai' } as never }, DIR), /not supported/);
  });

  it('the test injection point replaces the verifier but receives the validated settings', () => {
    let seen: unknown;
    const replacement: LlmVerifier = { id: 'replacement@v1', verify: () => Promise.resolve({ verdict: 'supported', note: 'x' }) };
    const built = buildAgentRuntime({ container_agent: CONTAINER, research_agent: RESEARCH, llm_verifier: { kind: 'stub', cost_usd: 0.5 } }, DIR, { createLlmVerifier: (config) => { seen = config; return replacement; } });
    assert.deepEqual(seen, { kind: 'stub', cost_usd: 0.5 });
    assert.equal(built.evaluation?.llm, replacement);
  });
});

describe('llm_verifier: kind claude_code_cli (the subscription verifier, Q22)', () => {
  const VERIFIER = { kind: 'claude_code_cli' as const, model: 'verifier-alias' };
  it('wires a verifier and a source-less evaluation port without research_agent (a local-evidence task needs no URL fetching)', async () => {
    const built = buildAgentRuntime({ claude_code_cli: { ...CLAUDE, model: 'executor-alias' }, llm_verifier: VERIFIER }, DIR, CONSENT_SOURCE);
    assert.match(built.evaluation?.llm?.id ?? '', /^claude-code-cli-verifier@v1:verifier-alias$/);
    const fetched = await built.evaluation!.fetcher.fetch('https://docs.example.com/a');
    assert.equal(fetched.reachable, false, 'no source URL is ever fetched');
    assert.equal(built.agent?.adapter.name, 'claude-code-cli');
  });

  it('works next to container_agent too (the container adapter stays the default; the verifier still uses the subscription CLI)', () => {
    const built = buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE }, claude_code_cli: { ...CLAUDE, roles: ['coder'] }, llm_verifier: VERIFIER }, DIR, CONSENT_SOURCE);
    assert.equal(built.agent?.adapter.name, 'container-sandbox');
    assert.ok(built.evaluation?.llm);
  });

  it('with research_agent the research source fetcher stays and the verifier is the subscription one', () => {
    const built = buildAgentRuntime({
      container_agent: CONTAINER, research_agent: { image: IMAGE, allowed_hosts: ['docs.example.com'] }, claude_code_cli: { ...CLAUDE, roles: ['coder'] }, llm_verifier: VERIFIER,
    }, DIR, CONSENT_SOURCE);
    assert.match(built.evaluation?.llm?.id ?? '', /claude-code-cli-verifier/);
    assert.ok(built.evaluation?.fetcher);
  });

  it('needs claude_code_cli (same login, consent and usage gate) and a consent source', () => {
    assert.throws(() => buildAgentRuntime({ llm_verifier: VERIFIER }, DIR), /needs claude_code_cli/);
    assert.throws(() => buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE }, llm_verifier: VERIFIER }, DIR), /needs claude_code_cli/);
    assert.throws(() => buildAgentRuntime({ claude_code_cli: CLAUDE, llm_verifier: VERIFIER }, DIR), /consent source/);
  });

  it('the model is required, and the same model as the executor is refused unless allow_same_model is set (Q22 b)', () => {
    assert.throws(() => parseLlmVerifierConfig({ kind: 'claude_code_cli' }), /llm_verifier\.model is required/);
    assert.throws(() => parseLlmVerifierConfig({ kind: 'claude_code_cli', model: '' }), /llm_verifier\.model/);
    assert.throws(() => parseLlmVerifierConfig({ kind: 'claude_code_cli', model: 'bad model' }), /llm_verifier\.model/);
    const sameModel = { claude_code_cli: { ...CLAUDE, model: 'haiku' }, llm_verifier: { kind: 'claude_code_cli' as const, model: 'haiku' } };
    assert.throws(() => buildAgentRuntime(sameModel, DIR, CONSENT_SOURCE), /same as claude_code_cli\.model/);
    assert.ok(buildAgentRuntime({ ...sameModel, llm_verifier: { ...sameModel.llm_verifier, allow_same_model: true } }, DIR, CONSENT_SOURCE).evaluation?.llm);
    // 실행 모델이 CLI 기본값(설정 없음)이면 같은지 알 수 없으므로 거부하지 않는다
    assert.ok(buildAgentRuntime({ claude_code_cli: CLAUDE, llm_verifier: { kind: 'claude_code_cli', model: 'haiku' } }, DIR, CONSENT_SOURCE).evaluation?.llm);
  });

  it('the shape check rejects unknown keys (no cost_usd here) and bad numbers', () => {
    assert.deepEqual(parseLlmVerifierConfig({ ...VERIFIER, time_limit_ms: 60000, max_source_bytes: 1000, unavailable_backoff_ms: 0, max_turns: 3, allow_same_model: false }), { ...VERIFIER, time_limit_ms: 60000, max_source_bytes: 1000, unavailable_backoff_ms: 0, max_turns: 3, allow_same_model: false });
    const bad: unknown[] = [
      { ...VERIFIER, cost_usd: 0.1 }, { ...VERIFIER, token: 'x' }, { ...VERIFIER, time_limit_ms: 0 }, { ...VERIFIER, time_limit_ms: 1.5 }, { ...VERIFIER, max_source_bytes: -1 },
      { ...VERIFIER, unavailable_backoff_ms: -1 }, { ...VERIFIER, max_turns: 0 }, { ...VERIFIER, allow_same_model: 'yes' },
    ];
    for (const value of bad) assert.throws(() => parseLlmVerifierConfig(value), /llm_verifier/, JSON.stringify(value));
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

const CLAUDE: ClaudeCodeCliConfig = { claude_path: '/opt/example/bin/claude', run_root: '/srv/example/r', env: { home: '/home/example-daemon', user: 'example-daemon', path: '/usr/bin:/bin' } };
const CONSENT_SOURCE = { claudeCodeConsent: () => null };

describe('claude_code_cli: the subscription CLI adapter from the settings', () => {
  it('alone it is the default adapter, with no docker (nothing to check or clean up at start)', () => {
    const built = buildAgentRuntime({ claude_code_cli: CLAUDE }, DIR, CONSENT_SOURCE);
    assert.equal(built.agent?.adapter.name, 'claude-code-cli');
    assert.equal(built.agent?.docker, undefined);
    assert.equal(built.agent?.adapters, undefined);
    assert.equal(built.agent?.selectAdapter, undefined);
    assert.equal(built.evaluation, undefined);
  });

  it('with container_agent only the listed roles go to the subscription CLI; the container adapter stays the default', () => {
    const built = buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE }, claude_code_cli: { ...CLAUDE, roles: ['coder'] } }, DIR, CONSENT_SOURCE);
    assert.equal(built.agent?.adapter.name, 'container-sandbox');
    assert.deepEqual([...(built.agent?.adapters?.keys() ?? [])], ['claude-code-cli']);
    const select = built.agent!.selectAdapter!;
    assert.equal(select({ role: 'coder' } as never), 'claude-code-cli');
    assert.equal(select({ role: 'researcher' } as never), null);
    assert.equal(select({} as never), null);
    assert.ok(built.agent?.docker, 'the container adapter still gets docker checks');
  });

  it('with research_agent the research adapter stays the default and keeps its tools and evaluation port', () => {
    const built = buildAgentRuntime({
      container_agent: CONTAINER, research_agent: { image: IMAGE, allowed_hosts: ['docs.example.com'] }, claude_code_cli: { ...CLAUDE, roles: ['coder'] },
    }, DIR, CONSENT_SOURCE);
    assert.equal(built.agent?.adapter.name, RESEARCH_AGENT_NAME);
    assert.deepEqual(built.agent?.tools?.map((tool) => tool.tool), ['fetch_url']);
    assert.ok(built.evaluation?.fetcher);
    assert.deepEqual([...(built.agent?.adapters?.keys() ?? [])], ['claude-code-cli']);
  });

  it('is off when null or missing; a configuration mistake is refused at start, not at the first run', () => {
    assert.equal(buildAgentRuntime({ claude_code_cli: null }, DIR).agent, undefined);
    assert.throws(() => buildAgentRuntime({ claude_code_cli: CLAUDE }, DIR), /consent source/);
    assert.throws(() => buildAgentRuntime({ claude_code_cli: { ...CLAUDE, roles: ['coder'] } }, DIR, CONSENT_SOURCE), /only for use with container_agent/);
    assert.throws(() => buildAgentRuntime({ container_agent: { ...CONTAINER, image: IMAGE }, claude_code_cli: CLAUDE }, DIR, CONSENT_SOURCE), /roles is required/);
    assert.throws(() => buildAgentRuntime({ claude_code_cli: { ...CLAUDE, claude_path: 'claude' } }, DIR, CONSENT_SOURCE), /absolute path/);
    assert.throws(() => buildAgentRuntime({ claude_code_cli: { ...CLAUDE, env: { ...CLAUDE.env, user: 'a b' } } }, DIR, CONSENT_SOURCE), /user/);
  });

  it('the settings reach the adapter; the shape check rejects unknown keys and bad values (no token or login key exists)', () => {
    assert.deepEqual(parseClaudeCodeCliConfig(null), undefined);
    assert.deepEqual(parseClaudeCodeCliConfig(CLAUDE), CLAUDE);
    const full = { ...CLAUDE, max_turns: 20, max_budget_usd: 1.5, model: 'haiku', warn_utilization: 0.7, yield_utilization: { five_hour: 0.7, seven_day: 0.8 }, max_concurrent: 2 };
    assert.deepEqual(parseClaudeCodeCliConfig(full), full);
    const bad: [unknown, RegExp][] = [
      ['claude', /must be an object/],
      [{ ...CLAUDE, token: 'x' }, /unknown key\(s\): token/],
      [{ ...CLAUDE, claude_path: '' }, /claude_path/],
      [{ ...CLAUDE, env: { ...CLAUDE.env, extra: 'x' } }, /claude_code_cli\.env has unknown key/],
      [{ ...CLAUDE, env: { home: '/h', user: 'u' } }, /env\.path/],
      [{ ...CLAUDE, roles: [] }, /roles/],
      [{ ...CLAUDE, max_turns: 1.5 }, /max_turns/],
      [{ ...CLAUDE, max_turns: 0 }, /max_turns/],
      [{ ...CLAUDE, yield_utilization: { hourly: 0.5 } }, /yield_utilization has unknown key/],
      [{ ...CLAUDE, yield_utilization: { five_hour: 'high' } }, /yield_utilization\.five_hour/],
    ];
    for (const [value, message] of bad) assert.throws(() => parseClaudeCodeCliConfig(value), message, JSON.stringify(value));
  });
});

const REGISTRATION = { git_path: '/usr/bin/git', gitleaks_path: '/usr/local/bin/gitleaks' };

describe('registration_tools: the product-registration tools, their evidence store and the evaluator reader from the settings', () => {
  it('adds the seven tool declarations (agent-facing names) and a run executor factory to the agent, and an evidence reader to the evaluation port', (t) => {
    const { db } = seededDb(t);
    const built = buildAgentRuntime({ claude_code_cli: CLAUDE, registration_tools: { ...REGISTRATION, evidence_dir: `${makeTempDir(t, 'aot-ev-')}/e` } }, DIR, { db, claudeCodeConsent: () => null, checkExecutable: () => undefined });
    assert.deepEqual(built.agent?.tools?.map((tool) => tool.name), [
      'repo_read_list_tree', 'repo_read_read_file', 'repo_read_read_metadata', 'repo_read_read_history', 'secret_scan_scan_tree', 'secret_scan_scan_history', 'license_check_identify',
    ]);
    assert.equal(typeof built.agent?.runExecutors, 'function');
    assert.ok(built.evaluation?.evidenceReader, 'the evaluator reads the stored bodies');
    assert.equal(built.evaluation?.llm, undefined);
    assert.equal(built.agent?.adapter.name, 'claude-code-cli', 'the subscription CLI stays the agent');
  });

  it('keeps the research tools and source fetcher when research_agent is also configured', (t) => {
    const { db } = seededDb(t);
    const built = buildAgentRuntime({
      container_agent: CONTAINER, research_agent: { image: IMAGE, allowed_hosts: ['docs.example.com'] }, claude_code_cli: { ...CLAUDE, roles: ['registration-verifier'] },
      registration_tools: { ...REGISTRATION, evidence_dir: `${makeTempDir(t, 'aot-ev-')}/e` },
    }, DIR, { db, claudeCodeConsent: () => null, checkExecutable: () => undefined });
    assert.equal(built.agent?.tools?.length, 8);
    assert.equal(built.agent?.tools?.[0]?.tool, 'fetch_url');
    assert.ok(built.evaluation?.fetcher && built.evaluation.evidenceReader);
  });

  it('refuses at start: no agent adapter, no database, a missing executable, a tool declared twice', (t) => {
    const { db } = seededDb(t);
    const dir = `${makeTempDir(t, 'aot-ev-')}/e`;
    const config = { claude_code_cli: CLAUDE, registration_tools: { ...REGISTRATION, evidence_dir: dir } };
    assert.throws(() => buildAgentRuntime({ registration_tools: { ...REGISTRATION, evidence_dir: dir } }, DIR, { db, checkExecutable: () => undefined }), /needs an agent adapter/);
    assert.throws(() => buildAgentRuntime(config, DIR, { claudeCodeConsent: () => null, checkExecutable: () => undefined }), /needs the database/);
    assert.throws(() => buildAgentRuntime(config, DIR, { db, claudeCodeConsent: () => null, checkExecutable: (path) => { if (path.endsWith('gitleaks')) throw new Error('nope'); } }), /gitleaks_path '\/usr\/local\/bin\/gitleaks' is not an executable file/);
    // 기본 확인은 실제 실행 권한을 본다
    assert.throws(() => buildAgentRuntime({ ...config, registration_tools: { ...REGISTRATION, gitleaks_path: '/nonexistent/gitleaks', evidence_dir: dir } }, DIR, { db, claudeCodeConsent: () => null }), /is not an executable file/);
  });

  it('settings shape: absolute paths only, no unknown keys, a sane scan limit; off when null or missing', () => {
    assert.equal(parseRegistrationToolsConfig(null), undefined);
    assert.deepEqual(parseRegistrationToolsConfig(REGISTRATION), REGISTRATION);
    const full = { ...REGISTRATION, gitleaks_config: '/srv/example/gitleaks.toml', evidence_dir: '/srv/example/evidence', scan_timeout_ms: 120_000 };
    assert.deepEqual(parseRegistrationToolsConfig(full), full);
    const bad: [unknown, RegExp][] = [
      ['git', /must be an object/],
      [{ ...REGISTRATION, git_path: 'git' }, /git_path must be an absolute path/],
      [{ ...REGISTRATION, gitleaks_path: undefined }, /gitleaks_path must be an absolute path/],
      [{ ...REGISTRATION, gitleaks_config: 'config.toml' }, /gitleaks_config must be an absolute path/],
      [{ ...REGISTRATION, evidence_dir: 'evidence' }, /evidence_dir must be an absolute path/],
      [{ ...REGISTRATION, scan_timeout_ms: 10 }, /scan_timeout_ms/],
      [{ ...REGISTRATION, api_key: 'x' }, /unknown key\(s\): api_key/],
    ];
    for (const [value, message] of bad) assert.throws(() => parseRegistrationToolsConfig(value), message, JSON.stringify(value));
  });
});

describe('the example settings file', () => {
  it('parses, keeps the agent off by default, and holds no secret-looking value', () => {
    const text = readFileSync(join(REPO_ROOT, 'config', 'daemon.config.example.json'), 'utf8');
    const config = JSON.parse(text) as AgentRuntimeConfig & Record<string, unknown>;
    assert.equal(config.container_agent, null);
    assert.equal(config.research_agent, null);
    assert.equal(config.llm_verifier, null, 'no verifier by default');
    assert.equal(config['claude_code_cli'], null, 'the subscription CLI is off by default');
    assert.equal(config['registration_tools'], null, 'the registration tools are off by default');
    assert.equal(buildAgentRuntime(config, DIR).agent, undefined);
    assert.ok(!/(token|secret|password|api[_-]?key)\s*"\s*:/i.test(text.replace(/"_comment"[^\n]*/, '')), 'no credential-like key in the example settings');
  });
});
