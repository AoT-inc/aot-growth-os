// A6-U12 통합: 데몬 설정(llm_verifier) → 조립 → 실행 → 검증(결정론적 검사 + 컨텍스트 분리 LLM 검증) → 전이.
// 설정 `llm_verifier: {kind: "stub"}` 가 모델 호출 없는 가짜 검증기를 평가 포트에 연결하고, 평가 순서·판정 규칙은 그대로다:
//   supported -> pass -> completed, unsupported -> fail -> retry_wait(시도 1 소모), 검증기 예외 -> inconclusive -> needs_review(시도 소모 없음),
//   결과에 `uncertainties` 가 없거나 형식이 틀리면 `uncertainty_listed` 가 fail -> retry_wait (LLM 검증은 건너뛴다), 설정이 없으면 이전 동작(inconclusive).
// 외부 접근은 없다(가짜 어댑터, 가짜 출처 조회기). Docker 를 쓰는 같은 경로의 시험은 daemon-research-pipeline.test.ts 다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeAgentAdapter, type JsonObject } from '@aot/agent-runtime';
import type { IsolatedVerificationInput, LlmVerifier } from '@aot/evaluation';
import { ISOLATED_INPUT_KEYS, createStubLlmVerifier } from '@aot/evaluation';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { buildAgentRuntime, type AgentRuntimeConfig } from '../../apps/daemon/src/runtime-config.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { EXAMPLE_URL, FakeFetcher } from '../support/evaluation.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { AGENT, createWithGate, policyEnv, readOnlyDraft, type PolicyEnv } from '../support/policy.ts';

const PAGE = 'The quarterly price is fixed for all plans. Seats are counted per team.';
const SUPPORTED = 'The quarterly price is fixed for all plans.';
const UNSUPPORTED = 'Prices doubled last week.';
const MARKER = 'MARKER-REPORT-PROSE-5be1';
const IMAGE = `sha256:${'ab12'.repeat(16)}`;

const claim = (statement: string) => ({ id: 'c1', statement, source_url: EXAMPLE_URL, quote: 'quarterly price is fixed' });
const goodResult = (statement = SUPPORTED, extra: Record<string, unknown> = {}): JsonObject => ({
  summary: `${MARKER}: everything is fine`,
  claims: [claim(statement)],
  uncertainties: [],
  ...extra,
}) as JsonObject;

/** 필드 하나를 뺀 결과 */
function resultWithout(key: string): JsonObject {
  const result = goodResult();
  delete result[key];
  return result;
}

interface Rig {
  env: PolicyEnv;
  daemon: ReturnType<typeof assembleDaemon>;
  inputs: IsolatedVerificationInput[];
  taskId: string;
}

/** 설정(llm_verifier)에서 평가 포트를 만들고 가짜 어댑터로 업무 하나를 만든다. `verifier` 가 있으면 설정이 만든 검증기를 그것으로 바꾼다 */
function rig(t: Parameters<typeof policyEnv>[0], options: { result: JsonObject; llm?: AgentRuntimeConfig['llm_verifier']; verifier?: (made: LlmVerifier) => LlmVerifier; deterministic?: string[]; llmSpec?: boolean }): Rig {
  const env = policyEnv(t);
  const inputs: IsolatedVerificationInput[] = [];
  const config: AgentRuntimeConfig = {
    container_agent: { docker_path: '/opt/example/bin/docker', memory_mib: 128, cpus: 0.5, pids_limit: 32, tmpfs_mib: 16 },
    research_agent: { image: IMAGE, allowed_hosts: ['docs.example.com'] },
    instance_id: 'test-instance',
    run_log_dir: join(env.dir, 'run-logs'),
    ...(options.llm === undefined ? {} : { llm_verifier: options.llm }),
  };
  const built = buildAgentRuntime(config, env.dir, {
    createSourceFetcher: () => new FakeFetcher({ [EXAMPLE_URL]: PAGE }),
    createLlmVerifier: (made) => {
      const base = createStubLlmVerifier(made.cost_usd === undefined ? {} : { costUsd: made.cost_usd });
      const verifier = options.verifier?.(base) ?? base;
      return { id: verifier.id, verify: (input) => { inputs.push(input); return verifier.verify(input); } };
    },
  });
  const adapter = createFakeAgentAdapter({ clock: env.clock, name: 'research-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }], result: options.result });
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: { adapter, timers: new ManualGatewayTimers() },
    ...(built.evaluation === undefined ? {} : { evaluation: built.evaluation }),
  });
  const taskId = createWithGate(env, readOnlyDraft({
    inputs: [{ name: 'k', ref: 'r:1', kind: 'k' }],
    validation: {
      deterministic: options.deterministic ?? ['url_reachable', 'quote_in_source', 'dedupe', 'budget', 'uncertainty_listed'],
      llm: options.llmSpec === false ? null : { check: 'claim_supported_by_source', isolated_context: true },
      human: false,
    },
  }));
  return { env, daemon, inputs, taskId };
}

async function validate(r: Rig) {
  const first = await r.daemon.worker.tick();
  assert.deepEqual(first.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  const second = await r.daemon.worker.tick();
  assert.equal(second.validated.length, 1);
  const evaluation = r.env.db.get<{ outcome: string; safety: string; quality_note: string; total_cost_usd: number }>('SELECT outcome, safety, quality_note, total_cost_usd FROM evaluation WHERE task_id = ?', [r.taskId])!;
  const attempts = Number(r.env.db.get('SELECT attempts FROM task WHERE id = ?', [r.taskId])?.['attempts']);
  const lastReason = r.env.db.get<{ reason: string }>('SELECT reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [r.taskId])!.reason;
  return { status: taskStatus(r.env.db, r.taskId), evaluation, attempts, lastReason, validated: second.validated[0]!.taskStatus };
}

test('supported: the stub verifier (from the settings) supports every claim -> pass -> completed; uncertainty_listed passed with an empty list', async (t) => {
  const r = rig(t, { result: goodResult(), llm: { kind: 'stub' } });
  const out = await validate(r);
  assert.equal(out.status, 'completed');
  assert.equal(out.validated, 'completed');
  assert.equal(out.evaluation.outcome, 'pass');
  assert.equal(out.evaluation.safety, 'pass');
  assert.match(out.evaluation.quality_note, /uncertainty_listed=pass/);
  assert.match(out.evaluation.quality_note, /stub-llm-verifier@v1: supported/);
  assert.equal(out.evaluation.total_cost_usd, 0);
  assert.equal(out.attempts, 0);
});

test('isolation through the daemon path: the verifier got the claim sentence, the original page and the criteria only; the report prose never reached it', async (t) => {
  const r = rig(t, { result: goodResult(SUPPORTED, { narrative: `${MARKER} long reasoning` }), llm: { kind: 'stub' } });
  await validate(r);
  assert.equal(r.inputs.length, 1);
  const input = r.inputs[0]!;
  assert.deepEqual(Object.keys(input).sort(), [...ISOLATED_INPUT_KEYS]);
  assert.deepEqual(input.claims, [{ id: 'c1', statement: SUPPORTED, sourceRef: EXAMPLE_URL }]);
  assert.deepEqual(input.sources.map((s) => [s.ref, s.text, s.trustOrigin]), [[EXAMPLE_URL, PAGE, 'external_untrusted']]);
  assert.equal(input.check, 'claim_supported_by_source');
  assert.ok(!JSON.stringify(input).includes(MARKER), 'neither the summary nor the narrative of the report reached the verifier');
});

test('unsupported: a claim that is not in its source -> fail -> retry_wait with one attempt used', async (t) => {
  const r = rig(t, { result: goodResult(UNSUPPORTED), llm: { kind: 'stub' } });
  const out = await validate(r);
  assert.equal(out.status, 'retry_wait');
  assert.equal(out.evaluation.outcome, 'fail');
  assert.match(out.evaluation.quality_note, /LLM verification found unsupported claim\(s\)/);
  assert.equal(out.attempts, 1);
});

test('the verifier throws: inconclusive -> needs_review, no attempt used (never a silent pass or fail)', async (t) => {
  const r = rig(t, { result: goodResult(), llm: { kind: 'stub' }, verifier: () => ({ id: 'broken-stub@v1', verify: () => Promise.reject(new Error('verifier unavailable')) }) });
  const out = await validate(r);
  assert.equal(out.status, 'needs_review');
  assert.equal(out.evaluation.outcome, 'inconclusive');
  assert.match(out.evaluation.quality_note, /LLM verification failed: verifier unavailable/);
  assert.match(out.lastReason, /inconclusive/);
  assert.equal(out.attempts, 0);
});

test('uncertainties missing from the result: uncertainty_listed fails -> fail -> retry_wait; the LLM verification is skipped (it runs only after every deterministic check passed)', async (t) => {
  const withoutField = resultWithout('uncertainties');
  const r = rig(t, { result: withoutField, llm: { kind: 'stub' } });
  const out = await validate(r);
  assert.equal(out.status, 'retry_wait');
  assert.equal(out.evaluation.outcome, 'fail');
  assert.match(out.evaluation.quality_note, /uncertainty_listed=fail \(the result has no 'uncertainties' field/);
  assert.match(out.evaluation.quality_note, /skipped: deterministic checks did not all pass/);
  assert.equal(r.inputs.length, 0, 'the verifier was not called');
  assert.equal(out.attempts, 1);
});

test('uncertainties malformed (wrong type, missing note, unknown key): fail with the reason in the evaluation note', async (t) => {
  for (const [bad, reason] of [
    ['none', /not an array/], [[{ topic: 'only a topic' }], /uncertainties\[0\]\.note/], [[{ topic: 't', note: 'n', severity: 'high' }], /unknown key\(s\): severity/],
  ] as const) {
    const r = rig(t, { result: goodResult(SUPPORTED, { uncertainties: bad }), llm: { kind: 'stub' } });
    const out = await validate(r);
    assert.equal(out.evaluation.outcome, 'fail');
    assert.equal(out.status, 'retry_wait');
    assert.match(out.evaluation.quality_note, reason);
  }
});

test('a result that lists real uncertainties passes like an empty list (the field is what is required, not its content)', async (t) => {
  const r = rig(t, { result: goodResult(SUPPORTED, { uncertainties: [{ topic: 'market-news', note: 'source answered HTTP 404' }] }), llm: { kind: 'stub' } });
  const out = await validate(r);
  assert.equal(out.evaluation.outcome, 'pass');
  assert.equal(out.status, 'completed');
});

test('the check applies only when the specification lists it: without it a result lacking uncertainties still passes', async (t) => {
  const withoutField = resultWithout('uncertainties');
  const r = rig(t, { result: withoutField, llm: { kind: 'stub' }, deterministic: ['url_reachable', 'quote_in_source'] });
  const out = await validate(r);
  assert.equal(out.evaluation.outcome, 'pass');
  assert.doesNotMatch(out.evaluation.quality_note, /uncertainty_listed/);
});

test('no llm_verifier in the settings: the previous behaviour - a task that asks for LLM verification is inconclusive -> needs_review', async (t) => {
  for (const llm of [undefined, null] as const) {
    const r = rig(t, { result: goodResult(), ...(llm === undefined ? {} : { llm }) });
    const out = await validate(r);
    assert.equal(out.evaluation.outcome, 'inconclusive');
    assert.match(out.evaluation.quality_note, /no LLM verifier is configured/);
    assert.equal(out.status, 'needs_review');
    assert.equal(out.attempts, 0);
  }
  // 검증기가 연결되어 있어도 명세가 LLM 검증을 요구하지 않으면 호출하지 않는다
  const unused = rig(t, { result: goodResult(), llm: { kind: 'stub' }, llmSpec: false });
  const out = await validate(unused);
  assert.equal(out.evaluation.outcome, 'pass');
  assert.equal(unused.inputs.length, 0);
});

test('cost_usd in the settings: the stub verification is recorded as a validation cost entry on the run and in the evaluation total', async (t) => {
  const r = rig(t, { result: goodResult(), llm: { kind: 'stub', cost_usd: 0.002 } });
  const out = await validate(r);
  assert.equal(out.status, 'completed');
  assert.equal(out.evaluation.total_cost_usd, 0.002);
  const entries = r.env.db.all<{ category: string; amount_usd: number; units: string }>('SELECT category, amount_usd, units FROM cost_entry WHERE task_id = ?', [r.taskId]);
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0]!.category, entries[0]!.amount_usd, JSON.parse(entries[0]!.units)], ['llm', 0.002, { source: 'validation', verifier: 'stub-llm-verifier@v1' }]);
});
