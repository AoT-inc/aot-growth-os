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
// 7단계 (A6-U16): 실험 1주가 끝나면(활성화 시각 이후 *시작*하는 첫 ISO 주 — 신호 tz — 가 끝난 뒤) advance 가 결과 검토 업무를 만든다. 업무는 팩 템플릿
//   `experiment-result-review@1`(입력: 조사·기획 결과 + 그 주의 측정 값 = U13 대기 조건)에서 `instantiate` 로 풀고, `task.strategy_version_id` 로 실험에 묶이며, 만들 때 합격선·기준선을
//   검토 기록(event `experiment-review:<id>`)에 고정한다. 같은 트랜잭션에서 실험 루틴을 끈다(`endExperimentInTx`: 측정 구간이 끝났으니 더 쓸 비용이 없다).
//   업무는 기존 평가기로 평가된다(기준선 대비 합격선은 U13 측정 신호 조회기가 검토 기록에서 읽는다). 평가가 pass(또는 더 시도하지 않는 fail)로 정해지면 같은 트랜잭션에서
//   결과(`measurement`·`strategy_record` 기억 + 실험 총비용)를 기록하고, fail 이면 시스템이 `experiment → rejected` 와 종료까지 처리한다. pass 의 승격과 inconclusive 의
//   거절은 사람만(승인 CLI, experiment-review.ts). inconclusive 는 기억을 만들지 않고 사람 검토 목록(`experimentReviews()`)에 남는다.
// 데몬 설정 `experiment_cycle` 이 없으면 만들지 않는다(main 루프가 부르지 않는다 = 이전 동작). 시각은 주입된 Clock.
import {
  experimentEventId, experimentReviewKey, EXPERIMENT_RESULT_KEY_PREFIX, EXPERIMENT_REVIEW_KEY_PREFIX, findExperimentActivation, findExperimentResult, findExperimentReview,
  experimentsInProgress, isPlainObject, listStrategyReviews, pendingExperimentActivations, type TaskPolicyGate, proposeStrategyVersion, recordExperimentReview, recordStrategyComparison,
  rejectExperiment, STRATEGY_COMPARISON_KEY_PREFIX, TASK_RESULT_INPUT_KIND, taskIdOfResultRef,
  type Clock, type Db, type ExperimentActivation, type MeasurementSignal, type MemoryKind, type PlainObject, type StrategyReview, type StrategyVersionRow, type TaskSpec,
} from '@aot/domain';
import {
  candidatesFromResult, compareCandidates, createMeasurementSignalSource, decisiveReviewEvaluation, EXPERIMENT_CANDIDATES_CHECK_ID, inconclusiveComparison, recordExperimentResult,
  type ComparisonRecord, type ExperimentCandidate, type RiskJudge, type RiskVerdict,
} from '@aot/evaluation';
import { evaluateRequest, requestsFromSpec, strictest, type PolicyStore, type PolicyVerdict } from '@aot/policy';
import {
  activateExperiment, createTaskInTx, endExperimentInTx, EXPERIMENT_TASK_CAUSE, ExperimentActivationError, isoWeekKeyAt, isoWeekPeriod, resolveUpstream, TaskCreationError,
  withRefusalRecord, type ApprovalCheck, type ExperimentRefusalCode,
} from '@aot/task-engine';

import type { InstantiateOptions, PackTemplate, PackTemplateTask } from './pack-loader.ts';

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
  /**
   * 7단계 결과 검토 업무 생성 (A6-U16). 주면 advance 가 실험 주가 끝난 실험마다 검토 업무를 만든다. `instantiate` = 팩 템플릿을 풀어 명세 초안을 돌려주는 함수(팩 로더),
   * `gate` = 업무 생성 정책 게이트. 생략하면 검토 업무를 만들지 않는다(이미 있는 검토의 결과 기록은 계속 한다).
   */
  review?: {
    gate: TaskPolicyGate;
    instantiate: (templateRef: string, options?: InstantiateOptions) => readonly PackTemplateTask[];
    /** 기본 `experiment-result-review@1` */
    templateRef?: string;
  };
  /** 결과 기억의 기본 만료 (정책 파라미터 `memory.default_validity`, 규칙 5). 호출 시점의 현재 정책에서 읽는다. 없거나 undefined 를 돌려주면 만료 없음 */
  defaultValidity?: () => ((kind: MemoryKind) => number | null) | undefined;
}

export const DEFAULT_REVIEW_TEMPLATE = 'experiment-result-review@1';

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

export interface CycleReviewCreated {
  strategyVersionId: string;
  reviewTaskId: string;
  /** 판정 대상 주 (`YYYY-Www`, 측정 신호 tz) */
  experimentWeek: string;
  /** 끈 실험 루틴 */
  routineIds: string[];
}

export interface CycleReviewFailure {
  strategyVersionId: string;
  /** 결정적 거부(템플릿·정책·값)면 코드, 일시 오류면 null — null 이면 다음 advance 가 다시 시도한다 */
  code: string | null;
  error: string;
}

export interface CycleResultRecorded {
  strategyVersionId: string;
  conclusion: 'pass' | 'fail';
  evaluationId: string;
  totalCostUsd: number;
  /** 이번에 기록했는가 (다른 프로세스가 먼저 했으면 false) */
  recorded: boolean;
  /** 평가 fail 이라 시스템이 `experiment → rejected` 로 옮겼는가 */
  rejected: boolean;
}

export interface CycleAdvanceReport {
  compared: CycleCompared[];
  failed: { planningTaskId: string; error: string }[];
  /** 이번에 켠(또는 이미 켜져 있던) 실험 (A6-U15) */
  activated: CycleActivated[];
  activationFailed: CycleActivationFailure[];
  /** 이번에 만든 결과 검토 업무 (A6-U16) */
  reviewsCreated: CycleReviewCreated[];
  reviewFailed: CycleReviewFailure[];
  /** 이번에 기록한 실험 결과 (A6-U16) */
  resultsRecorded: CycleResultRecorded[];
  resultFailed: { strategyVersionId: string; error: string }[];
}

/** 사람이 볼 실험 결과 검토 현황 (A6-U16) */
export interface ExperimentReviewStatus {
  /** 결과 검토 업무를 만들었고 아직 결과가 정해지지 않았다(업무 진행 중이거나 측정 값을 기다림) */
  awaitingResult: { strategyVersionId: string; reviewTaskId: string; taskStatus: string }[];
  /** 평가가 pass 로 기록되어 사람이 `promote` 할 수 있다 */
  awaitingPromotion: { strategyVersionId: string; evaluationId: string; totalCostUsd: number }[];
  /** 평가가 inconclusive 거나 업무가 평가 없이 끝나 결과가 없다 — 사람이 검토하고 거절한다(기억은 만들어지지 않는다) */
  needsHuman: { strategyVersionId: string; reviewTaskId: string; reason: string }[];
}

export interface ExperimentCycle {
  /** 아직 비교하지 않은 완료된 기획 업무를 비교하고 제안을 만든다 (멱등: 다시 불러도 늘지 않는다) */
  advance(): Promise<CycleAdvanceReport>;
  /** 사람이 검토할 비교 기록 (추천 없음) */
  pendingReviews(): StrategyReview[];
  /** 실험 결과 검토 현황 (A6-U16) */
  experimentReviews(): ExperimentReviewStatus;
}

/** 비교 기록이 아직 없는 완료된 기획 업무 */
const PENDING_SQL = `SELECT t.id FROM task t
  WHERE t.status = 'completed'
    AND EXISTS (SELECT 1 FROM json_each(t.spec, '$.validation.deterministic') d WHERE d.value = ?)
    AND NOT EXISTS (SELECT 1 FROM event e WHERE e.idempotency_key = ? || t.id)
  ORDER BY t.updated_at, t.rowid LIMIT ?`;

/** 결정적으로 검토 업무를 만들 수 없는 이유 (범위·신호·템플릿). 같은 입력으로는 다시 시도해도 같다 */
class ReviewRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReviewRefused';
    this.code = code;
  }
}

/**
 * 실험 주 = 활성화 시각 *이후에 시작하는* 첫 ISO 주 (신호 tz). 활성화가 월요일 00:00 정각이면 그 주, 아니면 다음 주다 — 측정 구간 전체가 활성화 뒤에 있어야
 * 그 주의 값이 실험의 효과다(활성화 전 며칠이 섞이지 않는다). 1주·관측 1 (A6 결정 ②).
 */
export function experimentWeekOf(activatedAt: string, tz: string): string {
  const ms = Date.parse(activatedAt);
  const week = isoWeekKeyAt(ms, tz);
  const period = isoWeekPeriod(week, tz);
  return Date.parse(period.start) >= ms ? week : isoWeekKeyAt(Date.parse(period.end), tz);
}

/** 결과 검토 업무가 있고 결과 기록이 없는 전략 (상태 무관: 사람이 먼저 거절했어도 결과는 남긴다) */
const AWAITING_RESULT_SQL = `SELECT s.id FROM strategy_version s
  WHERE EXISTS (SELECT 1 FROM event e WHERE e.idempotency_key = ? || s.id)
    AND NOT EXISTS (SELECT 1 FROM event e WHERE e.idempotency_key = ? || s.id)
  ORDER BY s.created_at, s.rowid`;

/** 실험 결과 검토 현황 (읽기 전용). 승인 CLI 의 `reviews` 와 사이클이 같이 쓴다 */
export function listExperimentReviews(db: Db): ExperimentReviewStatus {
  const status: ExperimentReviewStatus = { awaitingResult: [], awaitingPromotion: [], needsHuman: [] };
  for (const { id } of db.all<{ id: string }>(AWAITING_RESULT_SQL, [EXPERIMENT_REVIEW_KEY_PREFIX, EXPERIMENT_RESULT_KEY_PREFIX])) {
    const review = findExperimentReview(db, id);
    // 이미 사람이 결정한(거절된) 전략은 더 기다리지 않는다
    if (review === null || db.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [id])?.status !== 'experiment') continue;
    const task = db.get<{ status: string }>('SELECT status FROM task WHERE id = ?', [review.reviewTaskId]);
    const taskStatus = task?.status ?? 'missing';
    const latest = db.get<{ outcome: string; id: string }>('SELECT outcome, id FROM evaluation WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', [review.reviewTaskId]);
    if (latest?.outcome === 'inconclusive') {
      status.needsHuman.push({ strategyVersionId: id, reviewTaskId: review.reviewTaskId, reason: `evaluation ${latest.id} is inconclusive (insufficient evidence); no measurement or strategy_record is recorded` });
    } else if (['needs_review', 'failed', 'cancelled'].includes(taskStatus) && decisiveReviewEvaluation(db, review.reviewTaskId) === null) {
      status.needsHuman.push({ strategyVersionId: id, reviewTaskId: review.reviewTaskId, reason: `the review task is '${taskStatus}' without a decisive evaluation` });
    } else {
      status.awaitingResult.push({ strategyVersionId: id, reviewTaskId: review.reviewTaskId, taskStatus });
    }
  }
  for (const strategy of db.all<{ id: string }>("SELECT id FROM strategy_version WHERE status = 'experiment' ORDER BY created_at, rowid")) {
    const result = findExperimentResult(db, strategy.id);
    if (result !== null && result.conclusion === 'pass') {
      status.awaitingPromotion.push({ strategyVersionId: strategy.id, evaluationId: result.evaluationId, totalCostUsd: result.totalCostUsd });
    }
  }
  return status;
}

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

  /** 결정적으로 거부된 검토 업무 생성 (이 프로세스에서 다시 시도하지 않는다) */
  const refusedReviews = new Set<string>();

  /** 실험 주가 끝난 실험의 결과 검토 업무를 만든다. 아직 주가 끝나지 않았으면 null */
  function createReviewFor(review: NonNullable<ExperimentCycleDeps['review']>, strategy: StrategyVersionRow, activation: ExperimentActivation): CycleReviewCreated | null {
    let scope: unknown;
    try {
      scope = strategy.experiment_scope === null ? null : JSON.parse(strategy.experiment_scope);
    } catch {
      scope = null;
    }
    const measurement = isPlainObject(scope) ? scope['measurement'] : undefined;
    const source = isPlainObject(scope) ? scope['source'] : undefined;
    if (!isPlainObject(measurement) || typeof measurement['signal_id'] !== 'string' || !isPlainObject(source) || typeof source['planning_task_id'] !== 'string') {
      throw new ReviewRefused('invalid_scope', `strategy_version '${strategy.id}' has no experiment_scope.measurement.signal_id / source.planning_task_id`);
    }
    const signalId = measurement['signal_id'];
    const signal = deps.signals.find((candidate) => candidate.id === signalId);
    if (signal === undefined) throw new ReviewRefused('unknown_signal', `measurement signal '${signalId}' of strategy_version '${strategy.id}' is not defined`);
    const week = experimentWeekOf(activation.activatedAt, signal.tz);
    const period = isoWeekPeriod(week, signal.tz);
    if (Date.parse(period.end) > clock.nowMs()) return null; // 아직 실험 주가 끝나지 않았다

    const planningTaskId = source['planning_task_id'];
    const planning = db.get<{ spec: string }>('SELECT spec FROM task WHERE id = ?', [planningTaskId]);
    if (!planning) throw new ReviewRefused('unknown_planning_task', `planning task '${planningTaskId}' does not exist`);
    const planningSpec = JSON.parse(planning.spec) as Pick<TaskSpec, 'inputs'>;
    const researchIds = (Array.isArray(planningSpec.inputs) ? planningSpec.inputs : [])
      .filter((input) => input.kind === TASK_RESULT_INPUT_KIND).map((input) => taskIdOfResultRef(input.ref)).filter((id): id is string => id !== null);
    if (researchIds.length === 0) throw new ReviewRefused('no_research_task', `planning task '${planningTaskId}' has no task_result input (the research it read)`);

    const templateRef = review.templateRef ?? DEFAULT_REVIEW_TEMPLATE;
    let tasks: readonly PackTemplateTask[];
    try {
      tasks = review.instantiate(templateRef, { values: { experiment_week: week, planning_task: planningTaskId, research_task: researchIds[0]! } });
    } catch (error) {
      if (error instanceof TaskCreationError) throw new ReviewRefused('template_refused', `the review template '${templateRef}' was refused: ${error.message}`);
      throw error;
    }
    if (tasks.length !== 1) throw new ReviewRefused('template_shape', `the review template '${templateRef}' must declare exactly one task (has ${tasks.length})`);
    const spec = tasks[0]!.spec;
    const wanted = `measurement:${signalId}@${week}`;
    const inputs = Array.isArray(spec['inputs']) ? spec['inputs'] : [];
    if (!inputs.some((input) => isPlainObject(input) && input['kind'] === 'measurement' && input['ref'] === wanted)) {
      throw new ReviewRefused('signal_mismatch', `the review template '${templateRef}' does not read ${wanted} (the signal of the experiment)`);
    }
    const baseline = measurement['baseline_week'] !== undefined && typeof measurement['baseline_value'] === 'number'
      ? { week: String(measurement['baseline_week']), value: measurement['baseline_value'] } : null;
    const passAtLeast = typeof measurement['pass_at_least'] === 'number' ? measurement['pass_at_least'] : null;
    const reviewEventId = experimentEventId(experimentReviewKey(strategy.id));
    const dependencies = [...new Set([planningTaskId, ...researchIds])];

    return withRefusalRecord(db, () => db.writeTx((tx) => {
      if (findExperimentReview(tx, strategy.id) !== null) return null; // 다른 프로세스가 먼저 만들었다
      const created = createTaskInTx(tx, { clock, gate: review.gate }, {
        spec: { ...spec, trigger: { kind: 'event', ref: reviewEventId }, dependencies },
        strategyVersionId: strategy.id,
        causedBy: EXPERIMENT_TASK_CAUSE,
      });
      recordExperimentReview(tx, clock, {
        strategyVersionId: strategy.id, reviewTaskId: created.taskId, experimentWeek: week, signalId, period, activatedAt: activation.activatedAt,
        baseline, passAtLeast, planningTaskId, by: 'evaluator',
      });
      const ended = endExperimentInTx(tx, clock, { strategyVersionId: strategy.id, by: 'system', reason: `the experiment week ${week} has ended; the result review task ${created.taskId} was created` });
      return { strategyVersionId: strategy.id, reviewTaskId: created.taskId, experimentWeek: week, routineIds: ended.routineIds };
    }));
  }

  function createReviews(report: CycleAdvanceReport): void {
    const review = deps.review;
    if (review === undefined) return;
    for (const id of experimentsInProgress(db)) {
      if (refusedReviews.has(id) || findExperimentReview(db, id) !== null) continue;
      const activation = findExperimentActivation(db, id);
      if (activation === null) continue;
      try {
        const strategy = db.get<StrategyVersionRow>('SELECT * FROM strategy_version WHERE id = ?', [id])!;
        const created = createReviewFor(review, strategy, activation);
        if (created !== null) report.reviewsCreated.push(created);
      } catch (error) {
        const code = error instanceof ReviewRefused ? error.code : error instanceof TaskCreationError ? 'task_refused' : null;
        if (code !== null) refusedReviews.add(id);
        report.reviewFailed.push({ strategyVersionId: id, code, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** 평가가 정해진 결과 검토 업무의 결과를 기록한다 (pass 또는 더 시도하지 않는 fail). fail 이면 같은 트랜잭션에서 시스템이 거절·종료한다. inconclusive 는 아무것도 쓰지 않는다 */
  function recordResults(report: CycleAdvanceReport): void {
    for (const { id } of db.all<{ id: string }>(AWAITING_RESULT_SQL, [EXPERIMENT_REVIEW_KEY_PREFIX, EXPERIMENT_RESULT_KEY_PREFIX])) {
      try {
        const review = findExperimentReview(db, id);
        const evaluation = review === null ? null : decisiveReviewEvaluation(db, review.reviewTaskId);
        if (evaluation === null) continue;
        const recorded = db.writeTx((tx) => {
          const validity = deps.defaultValidity?.();
          const result = recordExperimentResult(tx, clock, {
            strategyVersionId: id, evaluationId: evaluation.id, by: 'evaluator', ...(validity === undefined ? {} : { defaultValiditySeconds: validity }),
          });
          let rejected = false;
          const status = tx.get<{ status: string }>('SELECT status FROM strategy_version WHERE id = ?', [id])!.status;
          if (result.created && result.result.conclusion === 'fail' && status === 'experiment') {
            rejectExperiment(tx, clock, {
              strategyVersionId: id, by: 'evaluator',
              reason: `the result review (evaluation ${evaluation.id}) failed; recorded as strategy_record ${result.result.strategyRecordMemoryId}`,
            });
            endExperimentInTx(tx, clock, { strategyVersionId: id, by: 'system', reason: 'the experiment failed its review' });
            rejected = true;
          }
          return { result: result.result, created: result.created, rejected };
        });
        report.resultsRecorded.push({
          strategyVersionId: id, conclusion: recorded.result.conclusion, evaluationId: recorded.result.evaluationId, totalCostUsd: recorded.result.totalCostUsd,
          recorded: recorded.created, rejected: recorded.rejected,
        });
      } catch (error) {
        report.resultFailed.push({ strategyVersionId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    async advance() {
      const report: CycleAdvanceReport = {
        compared: [], failed: [], activated: [], activationFailed: [], reviewsCreated: [], reviewFailed: [], resultsRecorded: [], resultFailed: [],
      };
      activatePending(report);
      createReviews(report);
      recordResults(report);
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
    experimentReviews: () => listExperimentReviews(db),
  };
}
