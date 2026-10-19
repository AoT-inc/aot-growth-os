// 상태 전이 허용표의 공통 부분. 허용표는 docs/schema/state-machines.md 가 정본이며, 표에 없는 전이는 모두 거부한다.
// 이 모듈은 "허용되는가"만 판정한다. 전이 기록(task_transition)과 조건 평가(평가 pass, 해시 일치 등)는 호출하는 쪽의 몫이다.
import type { Scope } from '../entities/enums.ts';

/**
 * 전이를 일으키는 주체의 종류. state-machines.md 의 "일으킬 수 있는 주체" 열에 대응한다.
 * `agent` 는 어느 표에도 허용되지 않는다 ("에이전트는 상태를 직접 바꿀 수 없다. 결과만 제출한다").
 */
export type TransitionActor =
  | 'human'
  | 'scheduler'
  | 'validator'
  | 'policy'
  | 'task_creator'
  | 'evaluator'
  | 'system'
  | 'org_management'
  | 'agent';

/** state-machines.md 가 주체를 따로 적지 않은 전이에 쓴다. 에이전트만 제외한다. */
export const NON_AGENT_ACTORS: readonly TransitionActor[] = [
  'human', 'scheduler', 'validator', 'policy', 'task_creator', 'evaluator', 'system', 'org_management',
];

/**
 * 전이 요청에 함께 와야 하는 것.
 * - `approval`: 사람 판단 기록(`approval`) 참조 필수
 * - `reason`: 사유 필수 (취소)
 * - `approval_unless_internal`: `audience` 가 `internal` 이 아니면 `approval` 필수 (게시)
 */
export type TransitionRequirement = 'approval' | 'reason' | 'approval_unless_internal';

export interface TransitionRule<S extends string> {
  /** `null` 은 생성(이전 상태 없음) */
  from: S | null;
  to: S;
  by: readonly TransitionActor[];
  requires?: readonly TransitionRequirement[];
  /** 문서의 "조건" 열 중 이 모듈이 검증하지 않는 선행 조건. 호출하는 쪽이 확인해야 한다. */
  preconditions?: string;
}

export interface StateMachine<S extends string> {
  name: string;
  states: readonly S[];
  /** 더 이상 어떤 상태로도 갈 수 없는 상태 */
  terminal: readonly S[];
  rules: readonly TransitionRule<S>[];
}

export interface TransitionRequest<S extends string> {
  from: S | null;
  to: S;
  by: TransitionActor;
  reason?: string | null;
  approvalId?: string | null;
  /** 게시 전이에서만 필요 */
  audience?: Scope;
}

export type TransitionCheckCode =
  | 'unknown_state'
  | 'agent_forbidden'
  | 'terminal_state'
  | 'not_allowed'
  | 'actor_not_allowed'
  | 'approval_required'
  | 'reason_required'
  | 'audience_required';

export type TransitionCheck<S extends string> =
  | { ok: true; rule: TransitionRule<S> }
  | { ok: false; code: TransitionCheckCode; message: string };

const isBlank = (value: string | null | undefined): boolean => value === undefined || value === null || value.trim() === '';

export function checkTransition<S extends string>(machine: StateMachine<S>, request: TransitionRequest<S>): TransitionCheck<S> {
  const label = `${machine.name}: ${request.from ?? '(none)'} -> ${request.to}`;
  const fail = (code: TransitionCheckCode, why: string): TransitionCheck<S> => ({ ok: false, code, message: `${label} rejected: ${why}` });

  if (request.from !== null && !machine.states.includes(request.from)) return fail('unknown_state', `unknown state '${request.from}'`);
  if (!machine.states.includes(request.to)) return fail('unknown_state', `unknown state '${request.to}'`);
  if (request.by === 'agent') return fail('agent_forbidden', 'agents cannot change state; they only submit results');
  if (request.from !== null && machine.terminal.includes(request.from)) {
    return fail('terminal_state', `'${request.from}' is a terminal state`);
  }

  const candidates = machine.rules.filter((rule) => rule.from === request.from && rule.to === request.to);
  if (candidates.length === 0) return fail('not_allowed', 'transition is not in the allowed table');
  const rule = candidates.find((candidate) => candidate.by.includes(request.by));
  if (!rule) return fail('actor_not_allowed', `'${request.by}' may not cause it (allowed: ${candidates[0]!.by.join(', ')})`);

  for (const requirement of rule.requires ?? []) {
    if (requirement === 'reason' && isBlank(request.reason)) return fail('reason_required', 'a reason is required');
    if (requirement === 'approval' && isBlank(request.approvalId)) return fail('approval_required', 'an approval record is required');
    if (requirement === 'approval_unless_internal') {
      if (request.audience === undefined) return fail('audience_required', 'the publication audience must be given');
      if (request.audience !== 'internal' && isBlank(request.approvalId)) {
        return fail('approval_required', `an approval is required to publish to '${request.audience}'`);
      }
    }
  }
  return { ok: true, rule };
}

export function assertTransition<S extends string>(machine: StateMachine<S>, request: TransitionRequest<S>): TransitionRule<S> {
  const result = checkTransition(machine, request);
  if (!result.ok) throw new TransitionError(result.code, result.message);
  return result.rule;
}

export class TransitionError extends Error {
  readonly code: TransitionCheckCode;
  constructor(code: TransitionCheckCode, message: string) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

/** `from` 에서 갈 수 있는 상태(주체 무관). 화면·진단용. */
export function reachableFrom<S extends string>(machine: StateMachine<S>, from: S | null): S[] {
  return [...new Set(machine.rules.filter((rule) => rule.from === from).map((rule) => rule.to))];
}
