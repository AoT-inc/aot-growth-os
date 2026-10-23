// A5 U5 통합: 실제 어댑터(읽기 전용 조사 에이전트, 컨테이너 안)가 같은 어댑터 계약 스위트(test/support/adapter-contract.ts)를 통과한다. 실제 docker 를 쓴다.
// 게이트웨이는 계약 스위트의 기록용 가짜다(허용 목록 밖 도구를 거부). `fetch_url` 의 응답만 시험이 꾸민다(대본):
//   tool_call        허용된 `fetch_url` 호출을 그대로 기록하게 하고 준비된 페이지로 답한다
//   wait_for_cancel  `fetch_url` 응답을 취소 신호가 올 때까지 쥐고 있는다(느린 도구) — 컨테이너가 실제로 도구 응답을 기다리는 중에 취소가 와야 한다
// 지원하지 못하는 시나리오는 factory 가 null 을 돌려 skip 한다(통과로 세지 않는다): denied_tool — 조사 에이전트는 `fetch_url` 외의 도구를 부르는 코드 경로 자체가 없다(설계).
// 허용 목록 밖 도구가 거부되는 쪽은 게이트웨이 계약 스위트와 주입 시험(research-agent-injection.test.ts)이 본다.
// docker 가 없거나 이미지를 빌드할 수 없으면 전체를 skip 하고 이유를 출력한다. 시험이 만든 컨테이너는 라벨로 반드시 정리한다.
import assert from 'node:assert/strict';
import { after, describe, it, test } from 'node:test';

import { systemClock, validateTaskSpec } from '@aot/domain';
import {
  cleanupOrphanContainers, createResearchAgentAdapter, RESEARCH_AGENT_NAME, validateAdapterOutput,
  type AdapterContext, type AdapterInput, type AgentAdapter, type JsonObject, type ToolGateway,
} from '@aot/agent-runtime';

import { contractInput, runAdapterContractTests, type ContractScenario } from '../support/adapter-contract.ts';
import { labeledContainers, TEST_INSTANCE, waitUntilNoContainers, type SandboxEnvironment } from '../support/container-sandbox.ts';
import { prepareResearchAgent } from '../support/research-agent.ts';

const prepared = await prepareResearchAgent();
if (!prepared.ok) console.log(`[research-agent-contract] SKIPPED: ${prepared.reason}`);
else console.log(`[research-agent-contract] docker ${prepared.env.dockerVersion}, research agent image ${prepared.env.imageId.slice(0, 19)}…`);
const sandbox = (prepared.ok ? prepared.env : null) as SandboxEnvironment;

const SOURCE_URL = 'https://docs.example.com/release-notes';
const QUOTE = 'supports single sign-on';

/** 조사 대상이 들어 있는 시험 입력. `withSource` 가 false 면 가져올 출처가 없다 */
function researchInput(withSource: boolean): AdapterInput {
  const base = contractInput();
  const inputs = [
    { name: 'keywords', ref: 'strategy:active#research_keywords', kind: 'strategy' },
    ...(withSource ? [{ name: 'release-notes', ref: SOURCE_URL, kind: 'source_url' }, { name: 'release-notes', ref: QUOTE, kind: 'quote' }] : []),
  ];
  return {
    ...base,
    run_id: 'run-research-contract',
    task_spec: {
      ...base.task_spec,
      inputs,
      allowed_tools: [{ tool: 'fetch_url', operations: ['fetch'], scope: 'internal', impact: 'read' }],
      constraints: { time_limit: '30m', network_allowlist: ['docs.example.com'], publish_scope: 'internal' },
    },
    allowed_tools: [{ tool: 'fetch_url', operations: ['fetch'] }],
  };
}

const SCENARIO_NEEDS_SOURCE: Record<ContractScenario, boolean> = { success: false, tool_call: true, denied_tool: false, cost_progress: false, wait_for_cancel: true };

const cannedPage = (url: unknown): JsonObject => ({
  url: String(url), final_url: String(url), status: 200, content_type: 'text/html', redirects: [], bytes: 60, truncated: false, sha256: 'd'.repeat(64),
  text: `Release notes: the product ${QUOTE} for all plans.`, body_skipped: null,
});

/** 계약 스위트의 기록용 게이트웨이를 감싸 `fetch_url` 응답만 꾸민다 */
function scripted(inner: AgentAdapter, script: 'canned' | 'slow'): AgentAdapter {
  return {
    name: inner.name,
    run(input: AdapterInput, context: AdapterContext) {
      const gateway: ToolGateway = {
        async call(tool, args) {
          const response = await context.gateway.call(tool, args); // 기록·허용 목록 판정은 계약 스위트의 게이트웨이가 한다
          if (tool !== 'fetch_url' || !response.ok) return response;
          if (script === 'canned') return { ok: true, result: cannedPage(args['url']) };
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: false, error: 'run_cancelled' };
        },
      };
      return inner.run(input, { ...context, gateway });
    },
  };
}

function factory(scenario: ContractScenario): AgentAdapter | null {
  if (scenario === 'denied_tool') {
    console.log('[research-agent-contract] scenario denied_tool is not supported: the agent has no code path that calls a tool outside the allowed list (only fetch_url exists)');
    return null;
  }
  const inner = createResearchAgentAdapter({ docker: sandbox.docker, image: sandbox.imageId, instance: TEST_INSTANCE, clock: systemClock, namePrefix: 'aot-test-research' });
  return scenario === 'tool_call' ? scripted(inner, 'canned') : scenario === 'wait_for_cancel' ? scripted(inner, 'slow') : inner;
}

if (!prepared.ok) {
  test('research agent adapter contract (real docker)', { skip: `research agent tests skipped: ${prepared.reason}` }, () => undefined);
} else {
  after(async () => {
    await cleanupOrphanContainers({ docker: sandbox.docker, instance: TEST_INSTANCE });
    assert.deepEqual(await waitUntilNoContainers(sandbox.docker, 'aot.run'), [], 'no aot.run container is left behind by this file');
    assert.deepEqual(await labeledContainers(sandbox.docker, 'aot.run'), []);
  });

  describe('research agent inputs', () => {
    it('the contract inputs are valid stored task_specs', () => {
      for (const withSource of [true, false]) {
        const checked = validateTaskSpec(researchInput(withSource).task_spec, 'stored');
        assert.ok(checked.ok, checked.ok ? '' : JSON.stringify(checked.errors));
      }
    });
  });

  // 계약 스위트: 실제(컨테이너) 어댑터가 가짜 어댑터와 같은 항목을 통과해야 한다. 취소는 docker kill 이라 기한을 넉넉히 둔다
  runAdapterContractTests(factory, {
    name: 'research-agent (container, real docker)',
    cancelDeadlineMs: 30_000,
    input: (scenario) => researchInput(SCENARIO_NEEDS_SOURCE[scenario]),
  });

  describe('research agent adapter: beyond the shared contract', () => {
    it('is named research-agent, submits a structured report with source_url evidence, and reports the fetched quotation', async () => {
      const adapter = scripted(createResearchAgentAdapter({ docker: sandbox.docker, image: sandbox.imageId, instance: TEST_INSTANCE, clock: systemClock, namePrefix: 'aot-test-research' }), 'canned');
      assert.equal(adapter.name, RESEARCH_AGENT_NAME);
      const calls: { tool: string; args: JsonObject }[] = [];
      const progress: number[] = [];
      const context: AdapterContext = {
        gateway: { call: (tool, args) => { calls.push({ tool, args }); return Promise.resolve({ ok: true, result: { echo: tool } }); } },
        signal: new AbortController().signal,
        onCostProgress: (event) => void progress.push(event.cumulative),
      };
      const output = await adapter.run(researchInput(true), context);
      assert.ok(validateAdapterOutput(output).ok);
      assert.equal(output.status, 'submitted');
      assert.deepEqual(calls, [{ tool: 'fetch_url', args: { url: SOURCE_URL } }]);
      assert.deepEqual(progress, [0]);
      assert.deepEqual(output.evidence.map((item) => [item.kind, item.ref, item.content_hash]), [['source_url', SOURCE_URL, 'd'.repeat(64)]]);
      const result = output.result!;
      assert.equal(result['trust_origin'], 'external_untrusted');
      assert.deepEqual((result['claims'] as JsonObject[]).map((claim) => [claim['source_url'], claim['quote']]), [[SOURCE_URL, QUOTE]]);
      const [source] = result['sources'] as JsonObject[];
      assert.equal(source?.['trust_origin'], 'external_untrusted');
      assert.equal(source?.['http_status'], 200);
    });

    it('cancelling while the agent is blocked waiting for a tool answer kills the container: cancelled, nothing left behind', async () => {
      const adapter = createResearchAgentAdapter({ docker: sandbox.docker, image: sandbox.imageId, instance: TEST_INSTANCE, clock: systemClock, namePrefix: 'aot-test-research' });
      const controller = new AbortController();
      let arrived!: () => void;
      const called = new Promise<void>((resolve) => { arrived = resolve; });
      const running = adapter.run(researchInput(true), {
        gateway: { call: () => { arrived(); return new Promise(() => undefined); } }, // 답하지 않는 느린 도구
        signal: controller.signal,
        onCostProgress: () => undefined,
      });
      await called;
      assert.equal((await labeledContainers(sandbox.docker, 'aot.run')).length, 1, 'the container is running while it waits for the tool');
      controller.abort(new Error('cancel while waiting'));
      const output = await running;
      assert.ok(validateAdapterOutput(output).ok);
      assert.equal(output.status, 'cancelled');
      assert.deepEqual(await waitUntilNoContainers(sandbox.docker, 'aot.run'), []);
    });

    it('refuses to call anything when fetch_url is not in the allowed tools: error result, zero gateway calls', async () => {
      const adapter = createResearchAgentAdapter({ docker: sandbox.docker, image: sandbox.imageId, instance: TEST_INSTANCE, clock: systemClock, namePrefix: 'aot-test-research' });
      const calls: string[] = [];
      const input: AdapterInput = { ...researchInput(true), allowed_tools: [{ tool: 'example_search', operations: ['search'] }] };
      const output = await adapter.run(input, {
        gateway: { call: (tool) => { calls.push(tool); return Promise.resolve({ ok: true, result: {} }); } },
        signal: new AbortController().signal,
        onCostProgress: () => undefined,
      });
      assert.ok(validateAdapterOutput(output).ok);
      assert.equal(output.status, 'error');
      assert.equal(output.error?.code, 'fetch_url_not_allowed');
      assert.deepEqual(calls, []);
    });

    it('a gateway that refuses the fetch (policy_denied) is reported per source; the run still submits and nothing leaks into evidence', async () => {
      const adapter = createResearchAgentAdapter({ docker: sandbox.docker, image: sandbox.imageId, instance: TEST_INSTANCE, clock: systemClock, namePrefix: 'aot-test-research' });
      const output = await adapter.run(researchInput(true), {
        gateway: { call: () => Promise.resolve({ ok: false, error: 'policy_denied' }) },
        signal: new AbortController().signal,
        onCostProgress: () => undefined,
      });
      assert.equal(output.status, 'submitted');
      assert.deepEqual(output.evidence, []);
      const [source] = output.result!['sources'] as JsonObject[];
      assert.deepEqual([source?.['fetched'], source?.['fetch_error']], [false, 'policy_denied']);
    });
  });
}
