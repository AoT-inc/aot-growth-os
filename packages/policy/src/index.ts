// @aot/policy 공개 API 진입점 (단계 A3). 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 책임: 정책 형식 v1(YAML, ADR-0013)과 정책 버전, 7요소 판정과 policy_decision, 승인 엔진(approved_hash, cooldown, TOTP 재인증),
// 실험 전략 승인(strategy_version, A6-U15), 사람 승인 채널(Unix 소켓), 실행 시점 재검증(TaskPolicyGate 구현), 도구 호출별 재판정(ToolCallPolicy 구현, A5), 게시 게이트.
// 의존: @aot/domain 만. task-engine 과는 domain 의 TaskPolicyGate 포트로 연결되고, apps/daemon 이 조립한다.
export {
  approvalStatus, publicationSubject, reauthPurpose, recordReauth, ReauthError, strategySubject, strategySubjectHash, taskRequester, taskSubject, taskSubjectHash,
  verifyStrategyApproval,
  type ApprovalQuery, type ApprovalState, type ApprovalStatus, type DelegationAuthority, type StrategyApprovalCheck, type StrategySubject, type TaskSubject,
} from './approval.ts';
export { ApprovalChannelError, MAX_REQUEST_BYTES, prepareSocketDir, sendApprovalRequest, startApprovalServer, type ApprovalHandler, type ApprovalServer } from './channel.ts';
export { classifyChange, type PolicyChange } from './change.ts';
export {
  ALWAYS_HUMAN, humanOnlyKind, taskHumanOnly, UNCLASSIFIED, delegationAuthority, delegationEligibility, DELEGABLE_SUBJECTS, DELEGATION_WINDOW_MS, mandatesOf, mandateStop, mandateUsability, MAX_DELEGATE_REASON_CHARS,
  readDelegationControls, recipientRuleViolation, rewritesUsed,
  classifyShadowComparison, shadowAgreement, shadowPromotionSuggested, SHADOW_MAX_DANGEROUS, SHADOW_MAX_FAILED_SHARE, SHADOW_MIN_AGREEMENT, SHADOW_MIN_COMPARED, SHADOW_RECENT_LIMIT, SHADOW_WINDOW_DAYS,
  type AlwaysHuman, type DelegationTaskContext, type Eligibility, type EligibilityCode, type MandateStop, type MandateUsability, type ShadowAgreement, type ShadowAiVerdict, type ShadowComparison,
  type ShadowHumanDecision, type ShadowRecentEntry,
} from './delegation.ts';
export { recordDecision, type DecisionRecord } from './decisions.ts';
export {
  DELEGATION_MAX_DAYS, mandateExpiresAt, NON_HOLDER_ACTORS, MAX_GUIDANCE_CHARS, memoryDefaultValidity, parseDuration, parsePolicy, PHONE_RECORDING_MODES, POLICY_FORMAT, policyHash, policyVersionIdOf,
  RISKY_CHANGE_RANGE, validatePolicyDocument,
  type DelegationSection, type Mandate, type MandateLimits, type MandateMode, type MandateMatch, type RecipientRule, type ParsedPolicy, type PhonePolicySection, type PhoneRecordingMode, type PolicyDocument, type PolicyLimits,
  type PolicyRule, type RiskyChangeParams,
} from './document.ts';
export {
  ApprovalEngine, ApprovalRefusedError, DECISION_VIA, orgProposalStaleness, ReauthRefusedError, REFUSAL_CODES, TOTP_LOCKOUT_MS, TOTP_MAX_FAILURES, type ApprovalCommand, type ApprovalEngineOptions,
  type ApprovalResponse, type ApprovalSubject, type DecisionVia, type DelegateDecideResult, type DelegateDecision, type DelegateVerdict, type DelegationReviewFacts, type DelegationReviewMaterial, type DelegationScanEntry,
  type ReauthRefusalCode, type RefusalCode,
} from './engine.ts';
export {
  approvalRequirement, constraintsOf, evaluateRequest, globMatch, requestOf, requestsFromSpec, strictest, subjectOf,
  type ApprovalRequirement, type PolicyRequest, type PolicyVerdict, type RequestConstraints,
} from './evaluate.ts';
export { createPolicyGate, verifyTaskApproval, type PolicyGateOptions } from './gate.ts';
export { transitionPublication, type PublicationGateResult, type PublicationTransitionRequest } from './publication.ts';
export { PolicyFormatError, PolicyStore, type ActivePolicy, type PolicyStoreOptions } from './store.ts';
export { createToolCallPolicy, type ToolCallPolicyOptions } from './tool-call.ts';
export {
  base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, TOTP_DIGITS, TOTP_STEP_SECONDS, TOTP_WINDOW, totpCode, TotpSecretError,
  TotpSecretStore, totpStep, verifyTotp,
} from './totp.ts';
export { parseYaml, YamlError, type YamlValue } from './yaml.ts';
export { createPhoneCallPolicy, type PhoneCallPolicyOptions, type SyncPhoneCallPolicy } from './phone.ts';
