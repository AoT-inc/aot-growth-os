// 주간 사이클 4·5단계 연결 (A6-U14): 완료된 기획 업무의 실험 후보 → 비교 → `strategy_version` 제안.
//
// 기획 업무 = 명세의 `validation.deterministic` 에 `experiment_candidates` 가 있는 업무(새 명세 필드를 만들지 않았다). `completed` 가 된 기획 업무마다 한 번:
//   1. 결과 읽기: 업무 간 결과 전달(U11)과 같은 규칙 — *통과 평가가 있는 완료 업무*의 그 평가가 가리키는 run 결과만 읽는다(`resolveUpstream`).
//      사람이 평가 없이 끝낸 업무의 결과는 쓰지 않는다. 읽을 수 없으면 비교는 inconclusive.
//   2. 후보 파싱(evaluation `candidatesFromResult`) → 기준선 = 그 기획 업무의 측정 입력(U13, `createMeasurementSignalSource`, 읽기 전용).
//   3. 비교(evaluation `compareCandidates`). 위험 판정 `riskOf` 는 여기서 정책(@aot/policy 의 `evaluateRequest`)으로 만들어 주입한다 — evaluation 은 policy 를 모른다.
//      비교용 사전 판정이라 `policy_decision` 에 남기지 않는다(실제 판정은 승인 뒤 업무를 만들 때 정책 게이트가 다시 하고 기록한다, U15).
//   4. 한 `Db.writeTx` 에서: 비교 기록(event, 멱등) → 추천이 있으면 `strategy_version` `proposed`(멱등, domain strategy.ts).
//      추천이 없으면(inconclusive, 후보 모두 제외) 제안을 만들지 않고 비교 기록이 사람 검토 목록(`listStrategyReviews`)에 오른다. 새 상태는 없다:
//      기획 업무는 이미 `completed`(종단)이고, 평가 `inconclusive` → 사람 검토라는 기존 규칙을 비교 기록의 `review_required` 로 표시할 뿐이다.
// 6단계 (A6-U15): 사람이 승인 소켓으로 `strategy_version` 을 승인하면(policy 승인 엔진, 같은 트랜잭션에서 `proposed → experiment`) 다음 advance 가
//   승인됐으나 아직 활성화 기록이 없는 전략마다 task-engine `activateExperiment` 를 부른다(승인 트랜잭션 밖, event 멱등 키 `experiment-activate:<id>`).
//   활성화 트랜잭션 안에서 policy `verifyStrategyApproval` 로 승인을 다시 확인한다(활성화 전 취소, 승인 뒤 내용 변경이면 켜지 않음).
//   승인 직후 데몬이 죽어도 재시작한 데몬의 advance 가 같은 전략을 찾아 한 번만 켠다(여러 데몬이 동시에 불러도 쓰기 트랜잭션 직렬화 + 멱등 키로 1회).
//   결정적 거부(ExperimentActivationError)는 이 프로세스에서 다시 시도하지 않는다(보고는 한 번, 재시작하면 다시 본다).
// 데몬 설정 `experiment_cycle` 이 없으면 만들지 않는다(main 루프가 부르지 않는다 = 이전 동작). 시각은 주입된 Clock.
import {
  isPlainObject, listStrategyReviews, pendingExperimentActivations, type TaskPolicyGate, proposeStrategyVersion, recordStrategyComparison, STRATEGY_COMPARISON_KEY_PREFIX, TASK_RESULT_INPUT_KIND,
  type Clock, type Db, type MeasurementSignal, type PlainObject, type StrategyReview, type TaskSpec,
} from '@aot/domain';
import {
  candidatesFromResult, compareCandidates, createMeasurementSignalSource, EXPERIMENT_CANDIDATES_CHECK_ID, inconclusiveComparison,
  type ComparisonRecord, type ExperimentCandidate, type RiskJudge, type RiskVerdict,
} from '@aot/evaluation';
import { evaluateRequest, requestsFromSpec, strictest, type PolicyStore, type PolicyVerdict } from '@aot/policy';
import { activateExperiment, ExperimentActivationError, resolveUpstream, type ApprovalCheck, type ExperimentRefusalCode } from '@aot/task-engine';

import type { PackTemplate } from './pack-loader.ts';

/** 데몬 설정 키 (config/daemon.config.example.json) */
export interface ExperimentCycleConfig {
  /** 실험 하나의 비용 상한(USD). 넘는 후보는 제외한다 */
  budget_usd: number;
  /** 합격선의 최소 상대 상승 (기본 0.1) */
  min_relative_lift?: number;
  /** 합격선의 최소 절대 상승 (신호 단위, 기본 1) */
  min_absolute_lift?: number;
}

export interface CycleConfig {
  experiment_cycle?: ExperimentCycleConfig | null;
}

export interface ExperimentCycleOptions {
  budgetUsd: number;
  minRelativeLift?: number;
  minAbsoluteLift?: number;
  /** 한 번의 advance 가 보는 기획 업무 수 (기본 20) */
  batch?: number;
}

const CONFIG_KEYS = ['budget_usd', 'min_relative_lift', 'min_absolute_lift'];
const DEFAULT_BATCH = 20;

/** 설정 → 옵션. 키가 없거나 null 이면 undefined(사이클을 돌리지 않는다). 잘못된 값은 시작 때 거부한다 */
export function cycleOptionsFromConfig(config: CycleConfig): ExperimentCycleOptions | undefined {
  const raw = config.experiment_cycle;
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) throw new Error('experiment_cycle must be an object {budget_usd, min_relative_lift?, min_absolute_lift?}');
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`experiment_cycle has unknown key(s): ${unknown.join(', ')}`);
  const number = (key: string, required: boolean): number | undefined => {
    const value = raw[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`experiment_cycle.${key} must be a finite number >= 0`);
    return value;
  };
  const budgetUsd = number('budget_usd', true)!;
  const minRelativeLift = number('min_relative_lift', false);
  const minAbsoluteLift = number('min_absolute_lift', false);
  return { budgetUsd, ...(minRelativeLift === undefined ? {} : { minRelativeLift }), ...(minAbsoluteLift === undefined ? {} : { minAbsoluteLift }) };
}

export interface PolicyRiskJudgeOptions {
  db: Db;
  store: PolicyStore;
  /** 팩 템플릿 (`task_template_ref` 후보의 명세를 찾는다) */
  templates: readonly PackTemplate[];
}

const PROBE_TRIGGER = { kind: 'manual', ref: 'experiment-candidate' } as const;

/**
 * 정책으로 후보의 위험을 판정한다: 후보가 실행할 업무 명세(직접 준 명세, 또는 팩 템플릿의 모든 업무)의 요청(도구 × 작업)마다 현재 정책으로 판정하고 가장 엄격한 결과.
 * 배포된 정책 내용이 없거나 모르는 템플릿이면 deny(기본 거부). 정책 상한을 넘는 예산도 deny(정책 게이트의 생성 거부와 같은 규칙).
 */
export function createPolicyRiskJudge(options: PolicyRiskJudgeOptions): RiskJudge {
  const templates = new Map(options.templates.map((template) => [`${template.id}@${template.version}`, template]));
  return (candidate: ExperimentCandidate): RiskVerdict => {
    const active = options.store.active(options.db);
    if (active === null || active.policy === null) return { decision: 'deny', reasons: ['no deployed policy content is available; default deny'] };
    const { policy } = active;
    let specs: PlainObject[];
    if (candidate.task_spec !== undefined) {
      specs = [candidate.task_spec];
    } else {
      const template = templates.get(candidate.task_template_ref ?? '');
      if (template === undefined) return { decision: 'deny', reasons: [`task template '${candidate.task_template_ref ?? ''}' is not a template of the loaded pack`] };
      specs = template.tasks.map((task) => task.spec);
    }
    const verdicts: PolicyVerdict[] = [];
    const reasons: string[] = [];
    for (const draft of specs) {
      const spec = storedLike(options.db, draft, policy.versionId);
      const budget = spec.cost_budget?.max_usd;
      if (typeof budget === 'number' && budget > policy.document.limits.max_usd_per_task) {
        verdicts.push({ decision: 'deny', reason: `cost_budget.max_usd ${budget} exceeds the policy limit ${policy.document.limits.max_usd_per_task}`, matchedRules: [], approval: null });
      }
      for (const request of requestsFromSpec(spec)) verdicts.push(evaluateRequest(policy.document, request));
    }
    const decision = strictest(verdicts);
    for (const verdict of verdicts) if (verdict.decision === decision && !reasons.includes(verdict.reason)) reasons.push(verdict.reason);
    if (verdicts.length === 0) reasons.push('the task requests no tool');
    return { decision, reasons: reasons.map((reason) => `${reason} (policy ${policy.versionId})`) };
  };
}

/** 판정용으로 시스템 필드를 채운 명세 (역할 버전은 DB 의 현재 값). 저장하지 않는다 */
function storedLike(db: Db, draft: PlainObject, policyVersionId: string): TaskSpec {
  const role = typeof draft['role'] === 'string' ? db.get<{ version: number }>('SELECT version FROM role WHERE slug = ?', [draft['role']]) : undefined;
  return {
    ...(structuredClone(draft) as unknown as TaskSpec),
    trigger: PROBE_TRIGGER,
    policy_version: policyVersionId,
    versions: { org_version: null, role_version: role === undefined ? null : Number(role.version), task_spec_version: null, strategy_version: null, tool_contract_version: null },
  };
}

export interface ExperimentCycleDeps {
  db: Db;
  clock: Clock;
  options: ExperimentCycleOptions;
  /** 측정 신호 정의 (기준선 조회와 후보 신호 대조) */
  signals: readonly MeasurementSignal[];
  riskOf: RiskJudge;
  /**
   * 6단계 실험 활성화 (A6-U15). 주면 advance 가 승인된 실험을 켠다. `gate` = 일회성 마케팅 업무의 생성 게이트(정책),
   * `verifyApproval` = 활성화 직전 승인 확인(policy `verifyStrategyApproval`). 생략하면 활성화하지 않는다.
   */
  activation?: { gate: TaskPolicyGate; verifyApproval: (tx: Db, strategyVersionId: string) => ApprovalCheck };
}

export interface CycleActivated {
  strategyVersionId: string;
  /** false 면 다른 프로세스가 먼저 켰다 */
  activated: boolean;
  activatedAt: string;
  routineIds: string[];
  taskIds: string[];
}

export interface CycleActivationFailure {
  strategyVersionId: string;
  /** 결정적 거부의 사유 코드 (일시 오류면 null — 다음 advance 가 다시 시도한다) */
  code: ExperimentRefusalCode | null;
  error: string;
}

export interface CycleCompared {
  planningTaskId: string;
  outcome: ComparisonRecord['outcome'];
  /** 이번에 비교 기록을 썼는가 (다른 프로세스가 먼저 썼으면 false) */
  recorded: boolean;
  /** 만든(또는 이미 있던) 제안. 추천이 없으면 null */
  strategyVersionId: string | null;
  proposalCreated: boolean;
}

export interface CycleAdvanceReport {
  compared: CycleCompared[];
  failed: { planningTaskId: string; error: string }[];
  /** 이번에 켠(또는 이미 켜져 있던) 실험 (A6-U15) */
  activated: CycleActivated[];
  activationFailed: CycleActivationFailure[];
}

export interface ExperimentCycle {
  /** 아직 비교하지 않은 완료된 기획 업무를 비교하고 제안을 만든다 (멱등: 다시 불러도 늘지 않는다) */
  advance(): Promise<CycleAdvanceReport>;
  /** 사람이 검토할 비교 기록 (추천 없음) */
  pendingReviews(): StrategyReview[];
}

/** 비교 기록이 아직 없는 완료된 기획 업무 */
const PENDING_SQL = `SELECT t.id FROM task t
  WHERE t.status = 'completed'
    AND EXISTS (SELECT 1 FROM json_each(t.spec, '$.validation.deterministic') d WHERE d.value = ?)
    AND NOT EXISTS (SELECT 1 FROM event e WHERE e.idempotency_key = ? || t.id)
  ORDER BY t.updated_at, t.rowid LIMIT ?`;

export function createExperimentCycle(deps: ExperimentCycleDeps): ExperimentCycle {
  const { db, clock, options } = deps;
  const source = createMeasurementSignalSource({ db, signals: deps.signals });

  async function compareOne(planningTaskId: string): Promise<{ record: ComparisonRecord; runId: string | null; evaluationId: string | null; candidates: ExperimentCandidate[] }> {
    const resolved = resolveUpstream(db, { inputs: [{ name: 'plan', ref: `task:${planningTaskId}`, kind: TASK_RESULT_INPUT_KIND }] });
    if (!resolved.ok) {
      return { record: inconclusiveComparison([`the planning result cannot be used: ${resolved.code}: ${resolved.detail}`], options), runId: null, evaluationId: null, candidates: [] };
    }
    const upstream = resolved.upstream[0]!;
    const parsed = candidatesFromResult(JSON.stringify(upstream.result));
    if (!parsed.ok) return { record: inconclusiveComparison([`the planning result has no usable candidates: ${parsed.reason}`], options), runId: upstream.runId, evaluationId: upstream.evaluationId, candidates: [] };
    const baseline = await source.read({ taskId: planningTaskId, taskRunId: upstream.runId });
    const record = compareCandidates({
      candidates: parsed.items, baseline, signals: deps.signals, riskOf: deps.riskOf, budgetUsd: options.budgetUsd,
      ...(options.minRelativeLift === undefined ? {} : { minRelativeLift: options.minRelativeLift }),
      ...(options.minAbsoluteLift === undefined ? {} : { minAbsoluteLift: options.minAbsoluteLift }),
    });
    return { record, runId: upstream.runId, evaluationId: upstream.evaluationId, candidates: parsed.items };
  }

  function persist(planningTaskId: string, compared: Awaited<ReturnType<typeof compareOne>>): CycleCompared {
    const { record } = compared;
    return db.writeTx((tx) => {
      const written = recordStrategyComparison(tx, clock, { planningTaskId, record: record as unknown as PlainObject, by: 'evaluator' });
      const base = { planningTaskId, outcome: record.outcome, recorded: written.created, strategyVersionId: null, proposalCreated: false };
      // 다른 프로세스가 먼저 비교 기록을 썼으면 그쪽이 제안까지 한 트랜잭션에서 끝냈다
      if (!written.created || record.outcome !== 'recommended' || record.recommended === null) return base;
      const candidate = compared.candidates.find((item) => item.id === record.recommended)!;
      const entry = record.candidates.find((item) => item.id === candidate.id)!;
      const actor = tx.get<{ actor_id: string }>('SELECT actor_id FROM task_run WHERE id = ?', [compared.runId!])!;
      const proposal = proposeStrategyVersion(tx, clock, {
        planningTaskId,
        candidateId: candidate.id,
        title: `Experiment proposal '${candidate.id}' from planning task ${planningTaskId}`.slice(0, 200),
        body: candidate.hypothesis,
        rationaleRefs: [`task:${planningTaskId}`, `task_run:${compared.runId!}`, `evaluation:${compared.evaluationId!}`, `event:${written.eventId}`],
        experimentScope: {
          duration: { period: candidate.measurement.period, weeks: 1 },
          measurement: {
            signal_id: candidate.measurement.signal_id, period: candidate.measurement.period, observations_per_experiment: 1,
            baseline_week: record.baseline!.week, baseline_value: record.baseline!.value, pass_at_least: record.pass_at_least,
          },
          task: candidate.task_spec === undefined ? { kind: 'task_template', ref: candidate.task_template_ref! } : { kind: 'task_spec', spec: candidate.task_spec },
          comparison: { event_id: written.eventId, comparator: record.comparator, rank: entry.rank, risk: entry.risk, agent_claim: entry.agent_claim },
          source: { planning_task_id: planningTaskId, candidate_id: candidate.id, task_run_id: compared.runId!, evaluation_id: compared.evaluationId! },
          // 가설·업무 명세는 기획 에이전트가 낸 값이다: 사람이 승인하기 전까지 지시가 아니라 데이터다
          trust_origin: 'external_untrusted',
        },
        proposedBy: actor.actor_id,
        by: 'evaluator',
      });
      return { ...base, strategyVersionId: proposal.strategyVersionId, proposalCreated: proposal.created };
    });
  }

  /** 결정적으로 거부된 활성화 (이 프로세스에서 다시 시도하지 않는다) */
  const refusedActivations = new Set<string>();

  function activatePending(report: CycleAdvanceReport): void {
    const activation = deps.activation;
    if (activation === undefined) return;
    for (const id of pendingExperimentActivations(db, options.batch ?? DEFAULT_BATCH)) {
      if (refusedActivations.has(id)) continue;
      try {
        const result = activateExperiment(db, { clock, gate: activation.gate }, { strategyVersionId: id, verifyApproval: activation.verifyApproval, by: 'system' });
        report.activated.push({ strategyVersionId: id, activated: result.activated, activatedAt: result.activatedAt, routineIds: result.routineIds, taskIds: result.taskIds });
      } catch (error) {
        const code = error instanceof ExperimentActivationError ? error.code : null;
        if (code !== null) refusedActivations.add(id);
        report.activationFailed.push({ strategyVersionId: id, code, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    async advance() {
      const report: CycleAdvanceReport = { compared: [], failed: [], activated: [], activationFailed: [] };
      activatePending(report);
      const pending = db.all<{ id: string }>(PENDING_SQL, [EXPERIMENT_CANDIDATES_CHECK_ID, STRATEGY_COMPARISON_KEY_PREFIX, options.batch ?? DEFAULT_BATCH]);
      for (const { id } of pending) {
        try {
          report.compared.push(persist(id, await compareOne(id)));
        } catch (error) {
          report.failed.push({ planningTaskId: id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return report;
    },
    pendingReviews: () => listStrategyReviews(db),
  };
}
