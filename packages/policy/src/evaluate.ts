// 7요소 판정 (ADR-0006 Amendment 2026-10-14, task-spec "권한 요청"). 순수 함수: 같은 정책·같은 요청이면 같은 결과.
//  주체 = `<role>@v<role_version>`, 행위 = `<tool>.<operation>`, 대상 = `allowed_tools[].target`,
//  범위 = scope, 영향 = impact, 제약 = 예산·시간·네트워크 등, 승인 = require_approval 일 때의 승인 요건(risky_change)
// 결합: 일치한 규칙 중 가장 엄격한 결과 (deny > require_approval > allow). 일치하는 규칙이 없으면 default(deny).
// 역할 데이터(role.allowed_tools)나 라우팅은 입력이 아니다 — 역할 생성·라우팅 변경으로 결과가 바뀌지 않는다 (trust-boundaries §2-7).
import type { Impact, PolicyDecisionValue, Scope, Sensitivity, TaskSpec, ToolRequest } from '@aot/domain';

import { humanApprovalParams, riskyApprovalParams, type ApprovalParams, type PolicyDocument, type PolicyRule } from './document.ts';

export interface RequestConstraints {
  max_usd: number;
  max_tokens?: number;
  time_limit?: string;
  network_allowlist?: string[];
  publish_scope?: Scope;
  data_classes?: Sensitivity[];
  /** 도구 게이트웨이의 호출별 판정에서만 쓴다: 부작용 호출임 (정책 판정 기록 `constraints` 에 남는다) */
  side_effect?: boolean;
  /** 도구 게이트웨이의 호출별 판정에서만 쓴다: 외부 입력이 영향을 준 호출임 (trust-boundaries §2-3) */
  influenced_by_external_input?: boolean;
}

export interface PolicyRequest {
  subject: string;
  action: string;
  /** 선언되지 않았으면 null */
  resource: string | null;
  scope: Scope | null;
  impact: Impact | null;
  constraints: RequestConstraints;
}

/** require_approval 판정의 승인 요건 (policy_decision.approval_required 에 남는다) */
export interface ApprovalRequirement extends ApprovalParams {
  approver_kind: 'human';
  channel: 'approval-socket';
}

export interface PolicyVerdict {
  decision: PolicyDecisionValue;
  reason: string;
  matchedRules: string[];
  approval: ApprovalRequirement | null;
}

const STRICTNESS: Record<PolicyDecisionValue, number> = { allow: 0, require_approval: 1, deny: 2 };

/**
 * 승인 요건 (2026-10-19 결정). 외부 부작용(`external_effect`)의 승인만 위험 변경 절차(승인자 수·cooldown·TOTP 재인증)를 거친다.
 * 그 밖의 `require_approval`(예: customer 범위 읽기)은 사람 1인의 승인만 받는다.
 */
export function approvalParamsFor(document: PolicyDocument, impact: Impact | null): ApprovalParams {
  return impact === 'external_effect' ? riskyApprovalParams(document) : humanApprovalParams(document);
}

export function approvalRequirement(document: PolicyDocument, impact: Impact | null): ApprovalRequirement {
  return { approver_kind: 'human', channel: 'approval-socket', ...approvalParamsFor(document, impact) };
}

/** 업무 하나의 승인 요건: 승인이 필요한 요청 중 외부 부작용이 하나라도 있으면 위험 변경 절차, 아니면 사람 1인 승인 */
export function taskApprovalParams(document: PolicyDocument, requests: readonly PolicyRequest[]): ApprovalParams {
  const external = requests.some((request) => request.impact === 'external_effect' && evaluateRequest(document, request).decision === 'require_approval');
  return approvalParamsFor(document, external ? 'external_effect' : null);
}

export function evaluateRequest(document: PolicyDocument, request: PolicyRequest): PolicyVerdict {
  const deny = (reason: string): PolicyVerdict => ({ decision: 'deny', reason, matchedRules: [], approval: null });

  // 판정할 수 없는 요청은 거부한다 (기본 거부). 요소를 추측해 채우지 않는다.
  // (새 명세는 task_spec 검증이 scope·impact 를 필수로 요구해 여기까지 오지 않는다. 저장된 옛 명세와 부작용 직전 재검증을 위한 방어다.)
  const undeclared = [request.scope === null ? 'scope' : null, request.impact === null ? 'impact' : null].filter((x) => x !== null);
  if (undeclared.length > 0) return deny(`${undeclared.join(' and ')} not declared for ${request.action}; undeclared requests are denied`);

  // 제약: 정책 상한 (task-spec: cost_budget "정책 상한 초과" → 거부)
  const { limits } = document;
  if (!(request.constraints.max_usd > 0) || request.constraints.max_usd > limits.max_usd_per_task) {
    return deny(`cost_budget.max_usd ${request.constraints.max_usd} exceeds the policy limit ${limits.max_usd_per_task}`);
  }
  if (limits.max_tokens_per_task !== undefined && request.constraints.max_tokens !== undefined
    && request.constraints.max_tokens > limits.max_tokens_per_task) {
    return deny(`cost_budget.max_tokens ${request.constraints.max_tokens} exceeds the policy limit ${limits.max_tokens_per_task}`);
  }

  const matched = document.rules.filter((rule) => ruleMatches(rule, request));
  if (matched.length === 0) return deny(`no rule matches ${describe(request)}; default deny`);
  const decision = matched.reduce<PolicyDecisionValue>((acc, rule) => (STRICTNESS[rule.decision] > STRICTNESS[acc] ? rule.decision : acc), 'allow');
  const deciding = matched.filter((rule) => rule.decision === decision).map((rule) => rule.id);
  return {
    decision,
    reason: `${decision} by rule ${deciding.join(', ')} for ${describe(request)}`,
    matchedRules: matched.map((rule) => rule.id),
    approval: decision === 'require_approval' ? approvalRequirement(document, request.impact) : null,
  };
}

function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.scope && !rule.scope.includes(request.scope!)) return false;
  if (rule.impact && !rule.impact.includes(request.impact!)) return false;
  if (rule.subject && !rule.subject.some((pattern) => globMatch(pattern, request.subject))) return false;
  if (rule.action && !rule.action.some((pattern) => globMatch(pattern, request.action))) return false;
  if (rule.resource && (request.resource === null || !rule.resource.some((pattern) => globMatch(pattern, request.resource!)))) return false;
  return true;
}

/** `*` 만 와일드카드(임의의 문자열). 전체 일치. */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`).test(value);
}

const describe = (request: PolicyRequest) =>
  `${request.subject} ${request.action} on ${request.resource ?? '(no target)'} [${request.scope}/${request.impact}]`;

export function subjectOf(spec: Pick<TaskSpec, 'role' | 'versions'>): string {
  if (spec.role === undefined) return 'unassigned';
  return `${spec.role}@v${spec.versions.role_version ?? '?'}`;
}

export function constraintsOf(spec: TaskSpec): RequestConstraints {
  const out: RequestConstraints = { max_usd: spec.cost_budget.max_usd };
  if (spec.cost_budget.max_tokens !== undefined) out.max_tokens = spec.cost_budget.max_tokens;
  const c = spec.constraints;
  if (c.time_limit !== undefined) out.time_limit = c.time_limit;
  if (c.network_allowlist !== undefined) out.network_allowlist = c.network_allowlist;
  if (c.publish_scope !== undefined) out.publish_scope = c.publish_scope;
  if (c.data_classes !== undefined) out.data_classes = c.data_classes;
  return out;
}

export function requestOf(spec: TaskSpec, tool: Pick<ToolRequest, 'tool' | 'target'> & Partial<Pick<ToolRequest, 'scope' | 'impact'>>, operation: string, overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    subject: subjectOf(spec),
    action: `${tool.tool}.${operation}`,
    resource: tool.target ?? null,
    scope: tool.scope ?? null,
    impact: tool.impact ?? null,
    constraints: constraintsOf(spec),
    ...overrides,
  };
}

/** 명세의 `allowed_tools` 를 도구 × 작업 단위의 요청으로 편다. */
export function requestsFromSpec(spec: TaskSpec): PolicyRequest[] {
  return spec.allowed_tools.flatMap((tool) => tool.operations.map((operation) => requestOf(spec, tool, operation)));
}

/** 여러 판정 중 가장 엄격한 것 (빈 목록이면 allow — 요청한 권한이 없다) */
export function strictest(verdicts: readonly PolicyVerdict[]): PolicyDecisionValue {
  return verdicts.reduce<PolicyDecisionValue>((acc, v) => (STRICTNESS[v.decision] > STRICTNESS[acc] ? v.decision : acc), 'allow');
}
