// docs/schema/state-machines.md 의 허용표. 표에 없는 전이는 checkTransition 이 거부한다.
// `terminal` 은 문서가 "종료 상태" 로 명시한 업무(task)에만 채운다. 다른 기계는 나가는 전이가 없는 상태가 곧 끝이다.
// 시험(test/unit/state-machines.test.ts)이 문서의 "금지된 전이" 절을 그대로 고정한다.
import type {
  ExternalEffectState, OrgProposalStatus, ProductLifecycleStage, ProductRegistrationStatus, PublicationStatus, Lifecycle,
  StrategyStatus, TaskStatus,
} from '../entities/enums.ts';
import {
  NON_AGENT_ACTORS, type StateMachine, type TransitionActor, type TransitionRule,
} from './machine.ts';

const rule = <S extends string>(
  from: S | null, to: S, by: readonly TransitionActor[], extra: Partial<TransitionRule<S>> = {},
): TransitionRule<S> => ({ from, to, by, ...extra });

// ===== 업무 (task.status) =====
const TASK_NON_TERMINAL = ['unassigned', 'queued', 'running', 'validating', 'needs_review', 'retry_wait'] as const;

export const TASK_MACHINE: StateMachine<TaskStatus> = {
  name: 'task',
  states: ['unassigned', 'queued', 'running', 'validating', 'completed', 'needs_review', 'retry_wait', 'failed', 'cancelled'],
  terminal: ['completed', 'failed', 'cancelled'],
  rules: [
    rule(null, 'queued', ['task_creator'], { preconditions: '명세 검증 통과, 의존 업무 존재, 배정 가능한 trial/active 역할 있음' }),
    rule(null, 'unassigned', ['task_creator'], { preconditions: '맞는 역할 없음 (조직 관리팀의 재편 신호)' }),
    rule('unassigned', 'queued', ['scheduler'], { preconditions: '역할 배정됨' }),
    rule('queued', 'running', ['scheduler'], { preconditions: '선행 업무 completed, 예산 잔여, 정책 허용, 실행 인자 = approved_hash, lease 획득(같은 트랜잭션에서 task_run 생성)' }),
    rule('queued', 'needs_review', ['scheduler', 'policy'], { preconditions: 'approved_hash 불일치(재승인 요청), 실행 직전 재검증에서 승인 범위 이탈, 또는 선행 결과 입력(task_result) 미충족·어댑터 선택 불가(A6-U11)' }),
    rule('running', 'validating', ['scheduler'], { preconditions: "task_run.outcome='submitted'" }),
    rule('running', 'queued', ['scheduler'], { preconditions: "lease 만료로 run 을 'lease_expired' 로 닫음, 미확정 부작용 없음 (recovery §4)" }),
    rule('running', 'needs_review', ['scheduler'], { preconditions: "run 'effect_unknown', 또는 실행 중 재검증에서 정책 거부/승인 범위 이탈" }),
    rule('running', 'retry_wait', ['scheduler'], { preconditions: 'error/timeout, attempts < max_attempts' }),
    rule('running', 'failed', ['scheduler'], { preconditions: 'attempts >= max_attempts 또는 치명적 정책 위반' }),
    rule('validating', 'completed', ['validator'], { preconditions: "모든 acceptance_criteria 충족 AND safety != 'fail' (최신 evaluation.safety='pass')" }),
    rule('validating', 'retry_wait', ['validator'], { preconditions: '기준 미충족, 재시도 가능' }),
    rule('validating', 'needs_review', ['validator', 'policy'], { preconditions: "validation.human=true, 승인 필요, 또는 평가 'inconclusive' (증거 부족, 2026-10-21 결정)" }),
    rule('needs_review', 'queued', ['human'], { requires: ['approval'] }),
    rule('needs_review', 'completed', ['human'], { requires: ['approval'] }),
    rule('needs_review', 'failed', ['human'], { requires: ['approval'] }),
    rule('retry_wait', 'queued', ['scheduler'], { preconditions: 'next_run_at 도달' }),
    ...TASK_NON_TERMINAL.map((from) => rule<TaskStatus>(from, 'cancelled', ['human', 'policy'], { requires: ['reason'] })),
  ],
};

export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = TASK_MACHINE.terminal;
export const isTaskTerminal = (status: TaskStatus): boolean => TASK_MACHINE.terminal.includes(status);

// ===== 조직 제안 (org_proposal.status) =====
// `inconclusive` 는 재시험 승인(→ trial) 전까지 종료로 취급한다 (state-machines.md, 2026-10-21 결정). 나가는 전이가 있으므로 terminal 목록에는 넣지 않고 별도 상태도 없다.
export const ORG_PROPOSAL_MACHINE: StateMachine<OrgProposalStatus> = {
  name: 'org_proposal',
  states: ['proposed', 'rejected', 'approved', 'trial', 'active', 'inconclusive', 'rolled_back', 'retired', 'expired', 'superseded'],
  terminal: [],
  rules: [
    rule('proposed', 'approved', ['human'], { preconditions: "base_org_version_id = 현재 활성 조직 버전 (다르면 'superseded'). change_class='risky' 면 ADR-0006 위험 변경 승인자 요건" }),
    rule('proposed', 'superseded', ['system'], { preconditions: '승인 시점의 기준 버전 충돌' }),
    rule('proposed', 'rejected', ['human']),
    rule('proposed', 'expired', ['system'], { preconditions: 'expires_at 경과' }),
    rule('approved', 'trial', ['system'], { preconditions: 'evaluation_plan·rollback_plan 완비' }),
    rule('trial', 'active', ['system'], { preconditions: '독립 평가 pass + 필수 성공 조건 충족 + 사람 확인. 새 org_version 생성' }),
    rule('trial', 'inconclusive', ['evaluator'], { preconditions: '기간 경과 AND (관측 수 미달 OR 데이터 품질 불량)' }),
    rule('trial', 'rolled_back', ['evaluator', 'system'], { preconditions: '평가 fail 또는 즉시 중단 조건(안전성 위반·예산 초과·심각한 품질 저하)' }),
    rule('inconclusive', 'trial', ['human'], { preconditions: '재시험 승인(새 평가 계획, 연장 상한 내, trial_extensions 증가)' }),
    rule('active', 'rolled_back', ['human'], { preconditions: '확정 후 문제 발견' }),
    rule('active', 'retired', ['human']),
  ],
};

// ===== 역할 (role.lifecycle) =====
// state-machines.md 는 `proposed → trial → active → retired` 만 적고 주체는 적지 않았다.
export const ROLE_MACHINE: StateMachine<Lifecycle> = {
  name: 'role',
  states: ['proposed', 'trial', 'active', 'retired'],
  terminal: [],
  rules: [
    rule('proposed', 'trial', NON_AGENT_ACTORS),
    rule('trial', 'active', NON_AGENT_ACTORS),
    rule('active', 'retired', NON_AGENT_ACTORS, { preconditions: '삭제가 아니라 신규 배정 중단' }),
  ],
};

// ===== 전략 (strategy_version.status) =====
export const STRATEGY_MACHINE: StateMachine<StrategyStatus> = {
  name: 'strategy_version',
  states: ['proposed', 'experiment', 'active', 'retired', 'rejected'],
  terminal: [],
  rules: [
    rule('proposed', 'experiment', ['human'], { requires: ['approval'], preconditions: 'experiment_scope(범위·기간 제한) 필수' }),
    rule('proposed', 'active', ['human'], { requires: ['approval'] }),
    rule('proposed', 'rejected', NON_AGENT_ACTORS),
    rule('experiment', 'active', NON_AGENT_ACTORS),
    // A6-U16 (사용자 결정 2026-10-24): 판정 실패·활성화 거부·사람 거절로 끝난 실험이 `experiment` 에 남아 다음 실험 승인을 막지 않도록 한다.
    rule('experiment', 'rejected', NON_AGENT_ACTORS, { requires: ['reason'], preconditions: '사람(CLI) 또는 평가가 fail 일 때 시스템(평가기). 에이전트 불가' }),
    rule('active', 'retired', NON_AGENT_ACTORS, { preconditions: '교체 시 이전 버전은 retired 로 두고 롤백 지점으로 유지' }),
  ],
};

// ===== 게시 (publication.status) =====
export const PUBLICATION_MACHINE: StateMachine<PublicationStatus> = {
  name: 'publication',
  states: ['draft', 'pending_approval', 'published', 'withdrawn'],
  terminal: [],
  rules: [
    rule('draft', 'pending_approval', NON_AGENT_ACTORS),
    rule('pending_approval', 'published', NON_AGENT_ACTORS, { requires: ['approval_unless_internal'] }),
    rule('draft', 'published', NON_AGENT_ACTORS, { requires: ['approval_unless_internal'], preconditions: '게시 정책 판정 통과 (audience 가 internal 이 아니면 승인 필수)' }),
    rule('published', 'withdrawn', NON_AGENT_ACTORS),
  ],
};

// ===== 상품 등록 (product.registration_status) =====
export const PRODUCT_REGISTRATION_MACHINE: StateMachine<ProductRegistrationStatus> = {
  name: 'product.registration_status',
  states: ['candidate', 'verifying', 'pending_approval', 'registered', 'rejected'],
  terminal: [],
  rules: [
    rule('candidate', 'verifying', ['task_creator', 'policy'], { preconditions: '검증 업무 1건 생성, 읽기 전용 접근(access_scope=read)을 정책 승인 경로로 요청' }),
    rule('verifying', 'pending_approval', ['validator'], { preconditions: '검증 업무가 needs_review 에 도달 (validation.human=true)' }),
    rule('pending_approval', 'registered', ['human'], { requires: ['approval'], preconditions: '검증 업무의 읽기 전용 증거가 연결되어 있을 것' }),
    rule('verifying', 'rejected', ['validator', 'human']),
    rule('pending_approval', 'rejected', ['validator', 'human']),
  ],
};

// ===== 상품 단계 (product.lifecycle_stage) =====
export const PRODUCT_LIFECYCLE_MACHINE: StateMachine<ProductLifecycleStage> = {
  name: 'product.lifecycle_stage',
  states: ['idea', 'development', 'beta', 'live', 'maintenance', 'sunset'],
  terminal: [],
  rules: [
    rule('idea', 'development', NON_AGENT_ACTORS),
    rule('development', 'beta', NON_AGENT_ACTORS),
    rule('beta', 'live', NON_AGENT_ACTORS, { preconditions: '위험 변경 (ADR-0006): 위험 변경 승인 요건은 정책(A3)이 확인' }),
    rule('live', 'maintenance', NON_AGENT_ACTORS),
    rule('maintenance', 'sunset', NON_AGENT_ACTORS),
  ],
};

// ===== 외부 부작용 (external_effect.state) =====
// 정본은 docs/operations/recovery.md §3 의 그림과 재시도 규칙 표다. 그림의 전이에 표의 재전송·조회 경로를 더했다.
// 부작용 상태는 업무 엔진(시스템)이 도구 호출 앞뒤로 기록한다. 에이전트는 바꿀 수 없다.
export const EXTERNAL_EFFECT_MACHINE: StateMachine<ExternalEffectState> = {
  name: 'external_effect',
  states: ['planned', 'dispatched', 'confirmed', 'failed', 'unknown', 'compensated'],
  terminal: [],
  rules: [
    rule('planned', 'dispatched', ['system'], { preconditions: '전송 직전, lease 펜싱 조건 충족 (recovery §2 규칙 2)' }),
    rule('dispatched', 'confirmed', ['system']),
    rule('dispatched', 'failed', ['system'], { preconditions: '외부가 명확히 실패 응답' }),
    rule('dispatched', 'unknown', ['system'], { preconditions: '타임아웃, 응답 유실, 워커 사망' }),
    rule('unknown', 'dispatched', ['system'], { preconditions: 'supports_idempotency=1 일 때만 같은 키로 재전송 (§3 표). 미지원은 재전송 금지' }),
    rule('unknown', 'confirmed', ['system', 'human'], { preconditions: '외부 상태 조회로 전달 확인, 또는 needs_review 에서 사람 판단' }),
    rule('unknown', 'failed', ['system', 'human'], { preconditions: '외부 상태 조회로 미전달 확인, 또는 사람 판단' }),
    rule('failed', 'dispatched', ['system'], { preconditions: '재전송은 정책 허용 시 (§3 표, A3)' }),
    rule('confirmed', 'compensated', ['system', 'human'], { preconditions: '보상 작업(compensation_ref)이 실행된 경우' }),
  ],
};

export const STATE_MACHINES = {
  task: TASK_MACHINE,
  org_proposal: ORG_PROPOSAL_MACHINE,
  role: ROLE_MACHINE,
  strategy_version: STRATEGY_MACHINE,
  publication: PUBLICATION_MACHINE,
  product_registration: PRODUCT_REGISTRATION_MACHINE,
  product_lifecycle: PRODUCT_LIFECYCLE_MACHINE,
  external_effect: EXTERNAL_EFFECT_MACHINE,
} as const;
