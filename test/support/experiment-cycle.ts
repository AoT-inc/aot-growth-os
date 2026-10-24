// 주간 사이클 통합 시험 공용 (A6-U14·U15): 데몬 조립(실제 정책 게이트 + 업무 엔진 + 평가기 + 에이전트 실행 관리 + 측정 채널 + 사이클)과
// 조사 → 기준선 입력 → 기획 업무를 끝까지 돌리는 도우미. 외부 접근은 없다(가짜 어댑터, 가짜 출처 조회기).
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createFakeAgentAdapter, type JsonObject } from '@aot/agent-runtime';
import type { Db } from '@aot/domain';

import { assembleDaemon, type AssembleOptions } from '../../apps/daemon/src/assemble.ts';
import { manualTimers } from './engine.ts';
import { EXAMPLE_URL, FakeFetcher, researchReport, validationSpec } from './evaluation.ts';
import { ManualGatewayTimers } from './gateway-contract.ts';
import { AFTER_W43, PACK_SIGNAL, W43_KEY } from './measurement.ts';
import { AGENT, createWithGate, OWNER, readOnlyDraft, type PolicyEnv } from './policy.ts';

export const PAGE = 'The quarterly price is fixed for all plans.';
const SHA = 'e'.repeat(64);

/** 기획 에이전트가 낼 마케팅 업무 명세 (내부 읽기만 → 기본 정책 allow) */
export function marketingSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const draft: Record<string, unknown> = { ...readOnlyDraft({ objective: 'example-product 랜딩 페이지 문구를 한 주 동안 바꿔 본다' }), ...overrides };
  delete draft['trigger'];
  return draft;
}
/** 기본 정책에 규칙이 없는 영향(delete) → 기본 거부 */
export const deniedSpec = () => marketingSpec({ allowed_tools: [{ tool: 'cms', operations: ['remove'], scope: 'internal', impact: 'delete' }] });

export const candidate = (id: string, spec: Record<string, unknown>, expected = 20) => ({
  id, hypothesis: `hypothesis ${id}`, expected_effect: expected, est_cost_usd: 1, task_spec: spec, measurement: { signal_id: PACK_SIGNAL.id, period: 'iso_week' },
});

export type CycleDaemon = ReturnType<typeof assembleDaemon>;

export function rig(env: PolicyEnv, candidates: unknown[], extra: Partial<AssembleOptions> = { cycle: { budgetUsd: 5 } }): CycleDaemon {
  env.clock.set(AFTER_W43);
  const research = createFakeAgentAdapter({
    clock: env.clock, name: 'research-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }],
    result: { ...researchReport([{ id: 'c1', statement: 'Prices are fixed.', source_url: EXAMPLE_URL, quote: 'quarterly price is fixed' }]), uncertainties: [] } as JsonObject,
  });
  const planner = createFakeAgentAdapter({ clock: env.clock, name: 'planner-fake', result: { candidates, uncertainties: [] } as unknown as JsonObject });
  return assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: PAGE }) },
    measurementSignals: [PACK_SIGNAL],
    agent: {
      adapter: research, adapters: new Map([['planner-fake', planner]]), timers: new ManualGatewayTimers(),
      selectAdapter: (spec) => (spec.validation.deterministic.includes('experiment_candidates') ? 'planner-fake' : null),
    },
    ...extra,
  });
}

/** 조사 → 기준선 입력 → 기획을 끝까지 돌린다. 기획 업무 id */
export async function runCycle(env: PolicyEnv, daemon: CycleDaemon, key = 'r:1'): Promise<string> {
  const researchId = createWithGate(env, readOnlyDraft({ ...validationSpec(['url_reachable', 'dedupe', 'budget', 'uncertainty_listed']), inputs: [{ name: 'k', ref: key, kind: 'k' }] }));
  const planId = createWithGate(env, readOnlyDraft({
    objective: 'example-product 의 다음 1주 마케팅 실험 후보를 제안한다',
    allowed_tools: [],
    inputs: [{ name: 'findings', ref: `task:${researchId}`, kind: 'task_result' }, { name: 'baseline', ref: W43_KEY, kind: 'measurement' }],
    dependencies: [researchId],
    ...validationSpec(['schema_valid', 'experiment_candidates', 'uncertainty_listed', 'budget']),
  }));
  const measured = daemon.handleChannelRequest({
    cmd: 'measure', actor: OWNER, signal: PACK_SIGNAL.id, value: 10, observations: 3, quality: 'good', attachments: [{ ref: 'file:/example/week-43.png', sha256: SHA }],
  }) as { ok: boolean };
  assert.equal(measured.ok, true, JSON.stringify(measured));
  assert.equal((await daemon.worker.tick()).executed?.taskId, researchId);
  const second = await daemon.worker.tick();
  assert.deepEqual(second.validated.map((v) => [v.taskId, v.taskStatus]), [[researchId, 'completed']]);
  assert.equal(second.executed?.taskId, planId);
  const third = await daemon.worker.tick();
  assert.deepEqual(third.validated.map((v) => [v.taskId, v.taskStatus]), [[planId, 'completed']]);
  return planId;
}

export const strategyRows = (db: Db) => db.all<{ id: string; status: string; created_by: string; body: string; rationale_refs: string; experiment_scope: string }>('SELECT * FROM strategy_version ORDER BY id');
