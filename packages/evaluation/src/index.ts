// @aot/evaluation 공개 API 진입점 (단계 A4). 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 책임: 실험 결과 기록(A6-U16: measurement·strategy_record 기억과 실험 총비용), 결정론적 검증기, 실험 후보 형식과 후보 비교기(A6-U14, 위험 판정은 주입), 컨텍스트 분리 LLM 검증 인터페이스(포트 + 모델 호출 없는 가짜 구현 createStubLlmVerifier), 평가기(pass/fail/inconclusive, 4축), 비용 원장 집계와 예산 초과 판정.
// 의존: @aot/domain 만. task-engine 과는 domain 의 TaskValidator 포트로 연결되고, apps/daemon 이 조립한다.
export {
  CALL_COMPLETED_CHECK_ID, CALL_OUTCOME_CHECK_ID, CALL_TRANSCRIPT_CHECK_ID, checkCallCompleted, checkCallOutcome, checkCallTranscript, qualifyingCall,
  type CallCheckInput, type CallCheckOutcome,
} from './call-checks.ts';
export {
  applyEvidenceVerification, defaultChecks, runDeterministicChecks, SourceReader,
  type CheckContext, type CheckOutcome, type CheckReport, type CheckStatus, type DeterministicCheck, type DeterministicReport, type EvidenceContribution,
} from './checks.ts';
export {
  candidateSignalProblems, candidateSpecProblems, candidatesFromResult, checkExperimentCandidates, EXPERIMENT_CANDIDATES_CHECK_ID, MAX_CANDIDATE_ID_CHARS,
  MAX_CANDIDATE_SPEC_BYTES, MAX_CANDIDATES, MAX_HYPOTHESIS_CHARS, parseCandidates,
  type CandidateMeasurement, type CandidatesParse, type ExperimentCandidate,
} from './candidates.ts';
export { claimsFromResult, type ReportedClaim } from './claims.ts';
export {
  COMPARATOR_ID, COMPARATOR_REF, COMPARATOR_VERSION, compareCandidates, DEFAULT_MIN_ABSOLUTE_LIFT, DEFAULT_MIN_RELATIVE_LIFT, inconclusiveComparison,
  MIN_COST_FOR_RATIO_USD, RANKING_ORDER,
  type AgentClaim, type BaselineFacts, type CandidateComparison, type CompareCandidatesInput, type ComparisonOutcome, type ComparisonRecord, type Exclusion,
  type ExclusionCode, type RiskDecision, type RiskJudge, type RiskVerdict,
} from './compare.ts';
export {
  budgetLimitsOf, costForProduct, costForRun, costForTask, CostRecordError, evaluateBudget, parseUnits, recordCost, reportCostProgress, summarizeCosts,
  type BudgetLimits, type CancelReason, type CancelSignal, type CostInput, type CostProgressReport, type CostProgressResult, type CostRange,
  type CostSummary, type CostUnits,
} from './cost.ts';
export {
  assertEvaluationInvariants, assessEffect, decide, EVALUATOR_ID, EVALUATOR_REF, EVALUATOR_VERSION, EvaluationError, evaluateRun, findEvaluation, isSuccessCase,
  type Decision, type DecisionFacts, type EffectAssessment, type EvaluateRunRequest, type EvaluationReport, type EvaluatorDeps, type LlmState,
} from './evaluator.ts';
export {
  decisiveReviewEvaluation, experimentCost, ExperimentResultError, recordExperimentResult,
  type ExperimentCost, type ExperimentResultErrorCode, type RecordedExperimentResult, type RecordExperimentResultInput,
} from './experiment-result.ts';
export { createMeasurementSignalSource, MEASUREMENT_SOURCE_EVENT, type MeasurementSignalSourceOptions } from './measurement-source.ts';
export { buildIsolatedInput, ISOLATED_INPUT_KEYS, IsolationError, MAX_CLAIMS, MAX_STATEMENT_CHARS, type IsolatedInputParts } from './isolation.ts';
export type {
  ClaimStatement, EffectObservation, EffectSignal, EffectSignalSource, FetchResult, IsolatedVerificationInput, LlmVerdict, LlmVerifier,
  SourceFetcher, SourceText,
} from './ports.ts';
export { createStubLlmVerifier, STUB_LLM_VERIFIER_ID, substringRule, type StubClaimVerdict, type StubLlmVerifierOptions } from './stub-verifier.ts';
export {
  MAX_UNCERTAINTIES, MAX_UNCERTAINTY_NOTE_CHARS, MAX_UNCERTAINTY_TOPIC_CHARS, uncertaintiesFromResult, type UncertaintiesCheck, type Uncertainty,
} from './uncertainties.ts';
export { createTaskValidator, summarizeEvaluation } from './validator.ts';
