// 업무 엔진(task-engine)이 정책(policy, A3)을 부르는 자리. 의존 방향(policy 와 task-engine 은 서로 참조 금지)을
// 지키려고 인터페이스를 domain 에 둔다: task-engine 은 이 포트를 호출하고, policy 가 구현하며, apps/daemon 이 조립한다.
//
// 호출 시점 (docs/schema/task-spec.md "생성 거부 조건"·"실행 시 재검증", state-machines.md 업무 표)
//  - beforeCreate: 업무 생성 중 (task 행 INSERT 직후, 같은 쓰기 트랜잭션). `allowed_tools` 정책 판정 deny,
//                  정책 상한 초과 → 생성 거부 (트랜잭션 전체가 되돌려진다)
//  - beforeRun:    queued → running 직전 (같은 쓰기 트랜잭션 안). 예산 잔여, 정책 허용, 실행 인자 = approved_hash,
//                  실행 시점 재검증. 불충족이면 queued → needs_review (재승인 요청)
//  - beforeEffect: 외부 부작용 전송 직전 (펜싱·heartbeat 와 같은 쓰기 트랜잭션). 거부되면 보내지 않는다.
//                  처음 전송·같은 키 재전송이 거부되면 run 을 멈추고 running → needs_review,
//                  `failed` 재전송(recovery §3 "정책 허용 시")이 거부되면 재전송만 하지 않는다
// 세 메서드는 동기이며 쓰기 트랜잭션 안에서 불린다. policy_decision 기록은 넘겨받은 `tx` 로 한다. 외부 호출을 하지 않는다.
import type { Db } from '../db/types.ts';
import type { TaskRow } from '../entities/rows.ts';
import type { TaskSpec } from '../spec/task-spec.ts';

export interface TaskCreationGateRequest {
  /** 시스템 필드(policy_version, versions)까지 채운 명세 */
  spec: TaskSpec;
  /** 방금 INSERT 한 업무 id (거부되면 트랜잭션과 함께 사라진다) */
  taskId: string;
  now: string;
}

export type TaskCreationVerdict =
  | { decision: 'allow' }
  | {
    decision: 'deny';
    reason: string;
    /**
     * 거부 판정의 기록. 생성 트랜잭션은 되돌려지므로 업무 엔진이 롤백 뒤 새 쓰기 트랜잭션에서 부른다
     * ("모든 판정은 policy_decision 에 남는다", ADR-0006). 업무는 없으므로 task_id 없이 남긴다.
     */
    recordRefusal?: (tx: Db) => void;
  };

export interface TaskRunGateRequest {
  task: TaskRow;
  spec: TaskSpec;
  /** 이번에 만들 task_run.attempt */
  attempt: number;
  now: string;
}

export type TaskRunVerdict = { decision: 'allow' } | { decision: 'needs_review'; reason: string };

/** 'first': 처음 전송, 'retry_unknown': 멱등 지원 도구의 같은 키 재전송, 'resend_failed': `failed` 부작용의 재전송 */
export type EffectDispatchKind = 'first' | 'retry_unknown' | 'resend_failed';

export interface TaskEffectGateRequest {
  task: TaskRow;
  spec: TaskSpec;
  runId: string;
  tool: string;
  action: string;
  target: string;
  dispatch: EffectDispatchKind;
  now: string;
}

export type TaskEffectVerdict = { decision: 'allow' } | { decision: 'refuse'; reason: string };

export interface TaskPolicyGate {
  beforeCreate(tx: Db, request: TaskCreationGateRequest): TaskCreationVerdict;
  beforeRun(tx: Db, request: TaskRunGateRequest): TaskRunVerdict;
  beforeEffect(tx: Db, request: TaskEffectGateRequest): TaskEffectVerdict;
}

const NOT_CONFIGURED = 'policy gate not configured: default deny';

/**
 * 정책 엔진이 연결되지 않았을 때의 기본값. 정책 v1 의 `default: deny`(a0-decisions D4)와 같은 방향으로,
 * 생성은 거부하고 실행 직전에는 needs_review 로 보내며 부작용은 보내지 않는다. 허용하는 기본값은 두지 않는다.
 */
export const DENY_ALL_TASK_POLICY_GATE: TaskPolicyGate = {
  beforeCreate: () => ({ decision: 'deny', reason: NOT_CONFIGURED }),
  beforeRun: () => ({ decision: 'needs_review', reason: NOT_CONFIGURED }),
  beforeEffect: () => ({ decision: 'refuse', reason: NOT_CONFIGURED }),
};
