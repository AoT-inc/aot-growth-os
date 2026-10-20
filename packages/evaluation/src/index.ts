// @aot/evaluation 공개 API 진입점 (단계 A4). 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 책임: 결정론적 검증기, 컨텍스트 분리 LLM 검증 인터페이스(포트만), 평가기(pass/fail/inconclusive, 4축), 비용 원장 집계와 예산 초과 판정.
// 의존: @aot/domain 만. task-engine 과는 domain 의 TaskValidator 포트로 연결되고, apps/daemon 이 조립한다.
export {
  applyEvidenceVerification, defaultChecks, runDeterministicChecks, SourceReader,
  type CheckContext, type CheckOutcome, type CheckReport, type CheckStatus, type DeterministicCheck, type DeterministicReport, type EvidenceContribution,
} from './checks.ts';
export { claimsFromResult, type ReportedClaim } from './claims.ts';
export {
  budgetLimitsOf, costForProduct, costForRun, costForTask, CostRecordError, evaluateBudget, parseUnits, recordCost, reportCostProgress, summarizeCosts,
  type BudgetLimits, type CancelReason, type CancelSignal, type CostInput, type CostProgressReport, type CostProgressResult, type CostRange,
  type CostSummary, type CostUnits,
} from './cost.ts';
export {
  assertEvaluationInvariants, decide, EVALUATOR_ID, EVALUATOR_REF, EVALUATOR_VERSION, EvaluationError, evaluateRun, findEvaluation, isSuccessCase,
  type Decision, type DecisionFacts, type EffectAssessment, type EvaluateRunRequest, type EvaluationReport, type EvaluatorDeps, type LlmState,
} from './evaluator.ts';
export { buildIsolatedInput, ISOLATED_INPUT_KEYS, IsolationError, MAX_CLAIMS, MAX_STATEMENT_CHARS, type IsolatedInputParts } from './isolation.ts';
export type {
  ClaimStatement, EffectObservation, EffectSignal, EffectSignalSource, FetchResult, IsolatedVerificationInput, LlmVerdict, LlmVerifier,
  SourceFetcher, SourceText,
} from './ports.ts';
export { createTaskValidator, summarizeEvaluation } from './validator.ts';
