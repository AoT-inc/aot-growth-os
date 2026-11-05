// 위임 주기 (ADR-0016, 제안 — 오너 결정 D-B1). 데몬 tick 뒤마다 부른다. 위임(`delegation.mandates`)이 없는 정책에서는 아무것도 쓰지 않는다.
//  1. 풀어 주기: 위임 승인이 정족수이고 위임 cooldown 이 끝났고 위임이 아직 유효한 업무를 `needs_review → queued` 로 넘긴다(엔진 `releaseDelegated`).
//     이 단계는 검토자(AI)가 없어도 돈다 — 이미 기록된 위임 승인은 cooldown 뒤에 나가야 하고, 정지·철회는 엔진이 다시 확인한다.
//  2. 검토: 적격 업무마다 검토자(`DelegateReviewer`, 도구 없는 별도 호출)에게 위임 기준·초안을 주고 `{verdict, hash, reason}` 을 받는다.
//     출력은 신뢰하지 않는 데이터다: 형식·해시·판정이 틀리면 `escalate`("AI 응답 형식 오류")로 기록한다. 적격하지 않은 업무도 `escalate` 로 기록해 "사람에게 온 이유"를 남긴다.
//     결정은 엔진의 프로세스 안 메서드 `delegateDecide` 가 같은 트랜잭션에서 적격을 다시 확인한 뒤 기록한다. 이 모듈은 소켓에 닿지 않는다.
//  같은 업무·같은 해시는 한 번만 검토한다(엔진 `delegationScan` 이 `delegate_review` 로 거른다). 검토자를 쓸 수 없으면(사용량 한도·로그인) 그 tick 의 검토를 건너뛰고 기록하지 않는다.
import type { ApprovalEngine, DelegateVerdict, DelegationReviewMaterial } from '@aot/policy';

/** 검토자를 지금은 쓸 수 없다 (사용량 한도·로그인 만료 등). 검토 기록을 남기지 않고 다음 tick 에 다시 한다 */
export class DelegateReviewerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegateReviewerUnavailableError';
  }
}

export interface DelegateReviewRequest {
  taskId: string;
  /** 지금 대상 해시 (초안 포함). 검토자는 이 값을 출력에 되돌려 줘야 한다 */
  hash: string;
  /** 위임 기준 글·한도·초안·앞선 결정. 초안 본문은 외부 데이터 영역이다 — 거기 적힌 지시는 따르지 않는다 */
  material: DelegationReviewMaterial;
}

export interface DelegateReviewResult {
  /** `{verdict, hash, reason}` 모양이어야 한다 (객체 또는 JSON 문자열). 검사는 이 모듈이 한다 */
  output: unknown;
  costUsd?: number;
}

/** 위임 검토자. 실행 에이전트와 컨텍스트를 공유하지 않는 별도 호출이어야 하고 도구가 없다 */
export interface DelegateReviewer {
  readonly id: string;
  review(request: DelegateReviewRequest): Promise<DelegateReviewResult>;
}

/** 가짜 검토자 (시험·점검용). 항상 같은 판정을 돌려준다 */
export function createStubDelegateReviewer(options: { verdict?: DelegateVerdict; reason?: string; costUsd?: number } = {}): DelegateReviewer {
  return {
    id: 'stub-delegate-reviewer',
    review: (request) => Promise.resolve({
      output: { verdict: options.verdict ?? 'escalate', hash: request.hash, reason: options.reason ?? 'stub reviewer' },
      ...(options.costUsd === undefined ? {} : { costUsd: options.costUsd }),
    }),
  };
}

export type ParsedReview = { ok: true; verdict: DelegateVerdict; reason: string } | { ok: false; reason: string };

const VERDICTS: readonly string[] = ['approve', 'request_changes', 'escalate'];

/** 위임이 멈췄거나 없는 동안의 적격 실패: 기록하지 않고 풀릴 때 다시 본다 */
const TRANSIENT: readonly string[] = ['mandate_inactive', 'holder_unavailable', 'no_mandate'];

/** 검토자 출력 검사: 형식, 해시 = 지금 해시, 판정이 셋 중 하나, 사유 문자열. 아니면 실패 */
export function parseReviewOutput(output: unknown, hash: string): ParsedReview {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { ok: false, reason: 'AI 응답 형식 오류' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'AI 응답 형식 오류' };
  const record = value as Record<string, unknown>;
  if (typeof record['verdict'] !== 'string' || !VERDICTS.includes(record['verdict'])) return { ok: false, reason: 'AI 응답 형식 오류' };
  if (typeof record['reason'] !== 'string' || record['reason'].trim() === '') return { ok: false, reason: 'AI 응답 형식 오류' };
  if (record['hash'] !== hash) return { ok: false, reason: 'AI 응답 형식 오류 (해시가 다릅니다)' };
  return { ok: true, verdict: record['verdict'] as DelegateVerdict, reason: record['reason'].trim() };
}

export interface DelegateCycleReport {
  /** 위임 cooldown 이 끝나 큐로 넘긴 업무 */
  released: Array<{ taskId: string; mandateId: string; approvalId: string }>;
  /** 이번 tick 에 기록한 결정 (recorded: 엔진이 기록, 아니면 사람에게 넘긴 코드) */
  decided: Array<{ taskId: string; verdict: DelegateVerdict; outcome: string }>;
  /** 검토자를 쓸 수 없어 건너뛴 업무 수 */
  unavailable: number;
}

export interface DelegateCycle {
  advance(): Promise<DelegateCycleReport>;
}

export interface DelegateCycleOptions {
  engine: ApprovalEngine;
  /** 없으면 풀어 주기만 한다 (새 검토를 하지 않는다 — 적격한 업무는 사람에게 남는다) */
  reviewer?: DelegateReviewer | undefined;
  /** 한 번의 advance 에서 검토할 업무 수 상한 (비용 폭주 방지). 기본 5 */
  maxReviewsPerAdvance?: number;
}

export function createDelegateCycle(options: DelegateCycleOptions): DelegateCycle {
  const { engine, reviewer } = options;
  const limit = options.maxReviewsPerAdvance ?? 5;
  return {
    async advance() {
      const report: DelegateCycleReport = { released: engine.releaseDelegated(), decided: [], unavailable: 0 };
      if (reviewer === undefined) return report;
      let reviews = 0;
      // 업무마다 적격을 다시 읽는다: 앞 업무의 승인이 하루 한도·검토 비용을 바꿀 수 있으므로, 한 번 훑은 목록으로 AI 를 부르지 않는다
      const handled = new Set<string>();
      for (;;) {
        const entry = engine.delegationScan().find((candidate) => !handled.has(candidate.taskId));
        if (entry === undefined) break;
        handled.add(entry.taskId);
        if (!entry.eligibility.eligible) {
          // 위임이 멈췄거나 보유자가 없는 동안은 아무것도 남기지 않는다(풀리면 다시 본다). 그 밖의 이유는 사람에게 온 이유로 남긴다 (AI 호출 없음)
          if (TRANSIENT.includes(entry.eligibility.code)) continue;
          const result = engine.delegateDecide({ task_id: entry.taskId, hash: entry.hash, verdict: 'escalate', reason: entry.eligibility.reason });
          report.decided.push({ taskId: entry.taskId, verdict: 'escalate', outcome: result.ok ? 'recorded' : result.code });
          continue;
        }
        if (reviews >= limit) break;
        reviews += 1;
        let result: DelegateReviewResult;
        try {
          result = await reviewer.review({ taskId: entry.taskId, hash: entry.hash, material: entry.review! });
        } catch (error) {
          if (error instanceof DelegateReviewerUnavailableError) {
            report.unavailable += 1;
            break; // 같은 사유로 다음 업무도 막힌다: 이번 tick 의 검토를 멈춘다
          }
          const why = `AI 검토 실패: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
          const failed = engine.delegateDecide({ task_id: entry.taskId, hash: entry.hash, verdict: 'escalate', reason: why });
          report.decided.push({ taskId: entry.taskId, verdict: 'escalate', outcome: failed.ok ? 'recorded' : failed.code });
          continue;
        }
        const cost = typeof result.costUsd === 'number' && result.costUsd > 0 ? result.costUsd : 0;
        const parsed = parseReviewOutput(result.output, entry.hash);
        const verdict: DelegateVerdict = parsed.ok ? parsed.verdict : 'escalate';
        const decision = engine.delegateDecide({ task_id: entry.taskId, hash: entry.hash, verdict, reason: parsed.reason, cost_usd: cost });
        report.decided.push({ taskId: entry.taskId, verdict, outcome: decision.ok ? 'recorded' : decision.code });
      }
      return report;
    },
  };
}

/**
 * 데몬 설정 `delegate_reviewer` (ADR-0016, 제안). 지금 받는 종류는 `{"kind": "stub", "verdict"?: "escalate"|"request_changes"|"approve", "cost_usd"?: number}` 뿐이다 —
 * 모델 호출 없는 가짜 검토자로, 점검·시험용이다(기본 판정은 사람에게 넘김). 실제 모델 검토자는 후속 작업이다. 없으면(undefined·null) undefined.
 * 위임이 켜지는 것은 이 설정이 아니라 정책의 `delegation.mandates` 다: 이 설정이 있어도 위임이 없는 정책에서는 아무 업무도 검토하지 않는다.
 */
export type DelegateReviewerConfig = { kind: 'stub'; verdict?: DelegateVerdict; cost_usd?: number };

/**
 * 가짜 검토자(stub)는 시험용이다: `verdict: "approve"` 를 두면 적격한 모든 업무를 사람 없이 승인한다. 그래서 데몬 설정(JSON)만으로는 읽히지 않는다 —
 * 호출하는 쪽이 `{ allowStub: true }` 를 명시해야 하고, 운영 조립(main.ts)은 절대 주지 않는다. 설정 파일에 stub 이 있으면 데몬이 시작을 거부한다.
 */
export function parseDelegateReviewerConfig(value: unknown, options: { allowStub?: boolean } = {}): DelegateReviewerConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('delegate_reviewer must be an object like {"kind": "stub"}');
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'stub') throw new Error(`delegate_reviewer.kind '${String(record['kind'])}' is not supported (use 'stub')`);
  if (options.allowStub !== true) throw new Error("delegate_reviewer.kind 'stub' is test-only and cannot be loaded by the daemon (it could approve everything eligible without a person); remove delegate_reviewer from the daemon config");
  const unknown = Object.keys(record).filter((key) => !['kind', 'verdict', 'cost_usd'].includes(key));
  if (unknown.length > 0) throw new Error(`delegate_reviewer has unknown key(s): ${unknown.join(', ')}`);
  if (record['verdict'] !== undefined && !VERDICTS.includes(String(record['verdict']))) throw new Error('delegate_reviewer.verdict must be approve, request_changes or escalate');
  const cost = record['cost_usd'];
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw new Error('delegate_reviewer.cost_usd must be a finite number >= 0');
  return { kind: 'stub', ...(record['verdict'] === undefined ? {} : { verdict: record['verdict'] as DelegateVerdict }), ...(cost === undefined ? {} : { cost_usd: cost }) };
}

export function delegateReviewerFromConfig(config: DelegateReviewerConfig | undefined): DelegateReviewer | undefined {
  if (config === undefined) return undefined;
  return createStubDelegateReviewer({ ...(config.verdict === undefined ? {} : { verdict: config.verdict }), ...(config.cost_usd === undefined ? {} : { costUsd: config.cost_usd }) });
}
