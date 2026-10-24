// 주간 사이클 전체 통합 시험 공용 (A6-U17): 예제 팩(루틴 `weekly-experiment-planning` 포함)을 읽은 데몬 조립과 업무별 가짜 어댑터.
//   - 조사 업무(기본 어댑터): 게이트웨이의 `fetch_url` 을 한 번 부르고(가짜 실행기, 호출당 도구 비용) 모델 비용을 보고한 뒤 출처·인용·불확실성이 있는 결과를 낸다
//   - 기획 업무: 실험 후보(`candidates`)를 낸다 / 마케팅 업무(실험): 게시 도구를 부른다(호스트 선언은 public 범위) / 결과 검토 업무: 요약만 낸다
//   - 검증: 데몬 설정 `llm_verifier: {kind: "stub"}` 이 만드는 가짜 LLM 검증기(설정 경로 그대로, 출처 조회기만 가짜)
// 외부 접근은 없다. 시각은 주입한 가짜 시계다. 프로세스 안 시험(weekly-cycle-fake)과 다중 프로세스 워커(workers/weekly-cycle-daemon.ts)가 같이 쓴다.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  fetchUrlToolSpec,
  type AdapterInput, type AgentAdapter, type GatewayToolSpec, type JsonObject, type ToolCallRecord, type ToolExecutor,
} from '@aot/agent-runtime';
import type { Clock, Db } from '@aot/domain';
import type { SourceFetcher } from '@aot/evaluation';
import type { Timers } from '@aot/task-engine';

import { assembleDaemon, type AssembleOptions, type InstancePaths } from '../../apps/daemon/src/assemble.ts';
import { buildAgentRuntime, type AgentRuntimeBuild } from '../../apps/daemon/src/runtime-config.ts';
import { manualTimers } from './engine.ts';
import { FakeFetcher } from './evaluation.ts';
import { ManualGatewayTimers } from './gateway-contract.ts';
import { readOnlyDraft } from './policy.ts';
import { REPO_ROOT } from './schema-snapshot.ts';

export const SHIPPED_PACK_DIR = join(REPO_ROOT, 'packs', 'example-marketing');
export const SOURCE_URL = 'https://docs.example.com/market-news';
export const PACK_VALUES = { org_unit: 'core', product: 'example-product', research_source_url: SOURCE_URL, research_host: 'docs.example.com' };
export const PLANNING_ROUTINE = 'routine-weekly-experiment-planning';
export const PAGE = 'Release notes. The quarterly price is fixed for all plans. Seats are counted per team.';
/** 출처 원문의 부분 문자열 → 가짜 LLM 검증기의 기본 규칙이 supported 로 본다 */
export const CLAIM = 'The quarterly price is fixed for all plans.';

/** 비용 (USD): 조사 run 의 모델 비용, fetch_url 호출당 도구 비용, 기획·검토 run 의 모델 비용, 검증 1회 비용 */
export const COST = { researchLlm: 0.05, fetch: 0.02, planLlm: 0.03, reviewLlm: 0.01, marketingLlm: 0.04, validation: 0.001 } as const;

export const PUBLISH_TOOL: GatewayToolSpec = { tool: 'publication', operation: 'publish', scope: 'public', impact: 'external_effect', sideEffect: true };

/**
 * 출하 팩을 임시 디렉터리에 복사하고 시험 전용 차이 하나를 더한다: 주간 기획 템플릿의 조사 업무에 컨텍스트 분리 LLM 검증을 요구한다
 * (`validation.llm`). 출하 템플릿은 `llm: null` 이다 — 실제 모델 검증기가 없어(Q22) 켜 두면 실제 조사 에이전트의 주장 문장이 가짜 검증기의 기본 규칙에서
 * 항상 unsupported 가 되기 때문이다. `edit` 로 조사 명세를 더 바꿀 수 있다(Docker 시험의 `expected_quotes`).
 */
export function cyclePackCopy(dir: string, edit: (research: Record<string, unknown>) => void = () => undefined): string {
  const target = join(dir, 'pack');
  cpSync(SHIPPED_PACK_DIR, target, { recursive: true });
  const file = join(target, 'workflows', 'weekly-experiment-planning.json');
  const template = JSON.parse(readFileSync(file, 'utf8')) as { tasks: { name: string; spec: Record<string, unknown> }[] };
  const research = template.tasks.find((task) => task.name === 'research')!.spec;
  (research['validation'] as Record<string, unknown>)['llm'] = { check: 'claim_supported_by_source', isolated_context: true };
  edit(research);
  writeFileSync(file, JSON.stringify(template, null, 2));
  return target;
}

/** 기획 에이전트가 내는 마케팅 업무 명세: 게시 도구를 `internal`/`write` 로 적는다(생성 게이트 allow). 게이트웨이의 호스트 선언은 public 이다 */
export function publishingSpec(): Record<string, unknown> {
  const draft = readOnlyDraft({
    objective: 'example-product 랜딩 페이지 문구를 한 주 동안 바꿔 본다',
    allowed_tools: [{ tool: 'publication', operations: ['publish'], scope: 'internal', impact: 'write' }],
    validation: { deterministic: ['budget', 'uncertainty_listed'], llm: null, human: false },
    cost_budget: { max_usd: 1 },
  });
  delete draft['trigger'];
  return draft;
}
/** 기본 정책에 규칙이 없는 영향(delete) → 기본 거부 */
export function deniedSpec(): Record<string, unknown> {
  const draft = publishingSpec();
  draft['allowed_tools'] = [{ tool: 'cms', operations: ['remove'], scope: 'internal', impact: 'delete' }];
  return draft;
}

export const SIGNAL_ID = 'weekly-landing-conversions';
export const cycleCandidates = (): unknown[] => [
  // 더 큰 효과를 주장하지만 정책이 거부하는 후보: 비교에서 빠져야 한다
  { id: 'risky-delete', hypothesis: 'hypothesis risky-delete', expected_effect: 40, est_cost_usd: 1, task_spec: deniedSpec(), measurement: { signal_id: SIGNAL_ID, period: 'iso_week' } },
  { id: 'copy-publish', hypothesis: 'hypothesis copy-publish', expected_effect: 20, est_cost_usd: 1, task_spec: publishingSpec(), measurement: { signal_id: SIGNAL_ID, period: 'iso_week' } },
];

interface ScriptStep { tool: string; args: JsonObject }

/** 정해진 도구 호출 → 비용 보고 → 결과. `hang` 이면 시작한 뒤 끝나지 않는다(프로세스 강제 종료 시험) */
export function scriptedAdapter(options: {
  name: string; clock: Clock; costUsd: number; result: (input: AdapterInput, toolResults: unknown[]) => JsonObject;
  calls?: (input: AdapterInput) => ScriptStep[]; evidence?: (input: AdapterInput) => { kind: 'source_url'; ref: string }[]; hang?: boolean;
}): AgentAdapter {
  return {
    name: options.name,
    async run(input, context) {
      if (options.hang === true) await new Promise<never>(() => undefined);
      const toolResults: unknown[] = [];
      for (const call of options.calls?.(input) ?? []) toolResults.push(await context.gateway.call(call.tool, call.args));
      context.onCostProgress({ cumulative: options.costUsd, unit: 'usd' });
      const at = options.clock.nowIso();
      return {
        status: 'submitted',
        result: options.result(input, toolResults),
        evidence: (options.evidence?.(input) ?? []).map((item) => ({ ...item, trust_origin: 'external_untrusted' as const, captured_at: at })),
        run_log: [{ at, message: `${options.name}: ${toolResults.length} tool call(s)` }],
        cost: { usd: options.costUsd },
      };
    },
  };
}

const sourceOf = (input: AdapterInput): string => input.task_spec.inputs.find((item) => item.kind === 'source_url')?.ref ?? '';

export function researchAdapter(clock: Clock, hang = false): AgentAdapter {
  return scriptedAdapter({
    name: 'research-fake', clock, costUsd: COST.researchLlm, hang,
    calls: (input) => [{ tool: 'fetch_url', args: { url: sourceOf(input) } }],
    evidence: (input) => [{ kind: 'source_url', ref: sourceOf(input) }],
    result: (input, results) => ({
      summary: 'weekly findings',
      claims: [{ id: 'c1', statement: CLAIM, source_url: sourceOf(input), quote: 'quarterly price is fixed' }],
      uncertainties: [],
      fetched: results.map((r) => (r as { ok: boolean }).ok),
    }),
  });
}

export function plannerAdapter(clock: Clock, candidates: unknown[]): AgentAdapter {
  return scriptedAdapter({ name: 'planner-fake', clock, costUsd: COST.planLlm, result: () => ({ candidates, uncertainties: [] } as unknown as JsonObject) });
}

export function marketingAdapter(clock: Clock): AgentAdapter {
  return scriptedAdapter({
    name: 'marketing-fake', clock, costUsd: COST.marketingLlm,
    calls: () => [{ tool: 'publication', args: { channel: 'landing', content_ref: 'draft-example-1' } }],
    result: (_input, results) => ({ summary: 'the landing copy draft is ready', publish_result: results as unknown as JsonObject[], uncertainties: [] } as unknown as JsonObject),
  });
}

export function reviewAdapter(clock: Clock): AgentAdapter {
  return scriptedAdapter({ name: 'review-fake', clock, costUsd: COST.reviewLlm, result: () => ({ summary: 'the experiment week was compared with the baseline', uncertainties: [] }) });
}

export interface CycleRigOptions {
  db: Db;
  clock: Clock;
  paths: InstancePaths;
  dir: string;
  packDir: string;
  workerId?: string;
  actorId?: string;
  candidates?: unknown[];
  hangResearch?: boolean;
  timers?: Timers;
  /** 게이트웨이 호출 기록 (모든 run) */
  records?: ToolCallRecord[];
  /** 게시 도구 실행기가 불린 횟수 (게이트웨이가 막으면 0) */
  published?: string[];
  fetcher?: SourceFetcher;
  /** 팩 값 (기본 PACK_VALUES) */
  values?: Readonly<Record<string, string>>;
  /**
   * 데몬 설정에서 만든 실제 런타임 (Docker 시험: 컨테이너 조사 어댑터·실제 `fetch_url`·실제 출처 조회기). 주면 조사 업무의 기본 어댑터·도구·실행기·평가 포트를 이것으로 쓰고
   * 기획·마케팅·검토 업무만 가짜 어댑터로 돌린다
   */
  runtime?: AgentRuntimeBuild;
  extra?: Partial<AssembleOptions>;
}

export type CycleRigDaemon = ReturnType<typeof assembleDaemon>;

/** 데몬 조립: 실제 정책 게이트·승인 엔진·업무 엔진·평가기(설정의 가짜 LLM 검증기)·측정 채널·사이클·팩(복사본) + 업무별 가짜 어댑터 */
export function assembleCycleDaemon(options: CycleRigOptions): CycleRigDaemon {
  const { clock } = options;
  // 평가 포트는 데몬 설정에서 만든다 (`llm_verifier: {kind: "stub", cost_usd}`). 시험이 바꾸는 것은 출처 조회기(외부 접근)뿐이다
  const built = options.runtime ?? buildAgentRuntime({
    container_agent: { docker_path: '/opt/example/bin/docker', memory_mib: 128, cpus: 0.5, pids_limit: 32, tmpfs_mib: 16 },
    research_agent: { image: `sha256:${'ab12'.repeat(16)}`, allowed_hosts: ['docs.example.com'] },
    instance_id: 'example-cycle',
    run_log_dir: join(options.dir, 'run-logs'),
    llm_verifier: { kind: 'stub', cost_usd: COST.validation },
  }, options.dir, { createSourceFetcher: () => options.fetcher ?? new FakeFetcher({ [SOURCE_URL]: PAGE }) });
  const real = options.runtime?.agent;
  const published = options.published ?? [];
  const fetchExecutor: ToolExecutor = () => Promise.resolve({ result: { status: 200, text: PAGE } });
  const publishExecutor: ToolExecutor = (request) => {
    published.push(request.runId);
    return Promise.resolve({ result: { published: true } });
  };
  const planner = plannerAdapter(clock, options.candidates ?? cycleCandidates());
  const marketing = marketingAdapter(clock);
  const review = reviewAdapter(clock);
  return assembleDaemon({
    db: options.db, clock, workerId: options.workerId ?? 'w1', actorId: options.actorId ?? 'actor-agent-1', timers: options.timers ?? manualTimers(), retryDelayMs: 10_000,
    paths: options.paths,
    evaluation: built.evaluation!,
    pack: { dir: options.packDir, values: options.values ?? PACK_VALUES },
    cycle: { budgetUsd: 5 },
    agent: {
      ...real,
      adapter: real?.adapter ?? researchAdapter(clock, options.hangResearch === true),
      adapters: new Map([[planner.name, planner], [marketing.name, marketing], [review.name, review]]),
      tools: [...(real?.tools ?? [fetchUrlToolSpec({ unitCost: { usd: COST.fetch } })]), PUBLISH_TOOL],
      executors: new Map([...(real?.executors ?? new Map([['fetch_url', fetchExecutor]])), ['publication', publishExecutor]]),
      timers: real?.timers ?? new ManualGatewayTimers(),
      ...(options.records === undefined ? {} : { recorder: { record: (record: ToolCallRecord) => void options.records!.push(record) } }),
      selectAdapter: (spec) => {
        if (spec.validation.deterministic.includes('experiment_candidates')) return planner.name;
        if (spec.allowed_tools.some((tool) => tool.tool === 'fetch_url')) return null;
        if (spec.allowed_tools.some((tool) => tool.tool === 'publication')) return marketing.name;
        return review.name;
      },
    },
    ...options.extra,
  });
}

/** 팩 루틴을 DB 에 반영한 뒤(조립이 한다) 주간 기획 루틴을 켠다. 켜는 운영 경로가 없어 시험이 DB 를 직접 고친다(열린 항목) */
export function enablePlanningRoutine(db: Db): void {
  db.writeTx((tx) => tx.run('UPDATE routine SET enabled = 1 WHERE id = ?', [PLANNING_ROUTINE]));
}
