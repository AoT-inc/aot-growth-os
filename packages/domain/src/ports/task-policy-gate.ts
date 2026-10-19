// 업무 엔진(task-engine)이 정책(policy, A3)을 부르는 자리. 의존 방향(policy 와 task-engine 은 서로 참조 금지)을
// 지키려고 인터페이스를 domain 에 둔다: task-engine 은 이 포트를 호출하고, policy 가 구현한다.
//
// 호출 시점 (docs/schema/task-spec.md "생성 거부 조건", state-machines.md 업무 표)
//  - beforeCreate: 업무 생성 직전. `allowed_tools` 정책 판정 deny, 정책 상한 초과 → 생성 거부
//  - beforeRun:    queued → running 직전 (같은 쓰기 트랜잭션 안). 예산 잔여, 정책 허용, 실행 인자 = approved_hash,
//                  실행 시점 재검증. 불충족이면 queued → needs_review (재승인 요청)
// 두 메서드는 동기이며 쓰기 트랜잭션 안에서 불린다. policy_decision 기록은 넘겨받은 `tx` 로 한다.
// 외부 호출을 하지 않는다.
import type { Db } from '../db/types.ts';
import type { TaskRow } from '../entities/rows.ts';
import type { TaskSpec } from '../spec/task-spec.ts';

export interface TaskCreationGateRequest {
  /** 시스템 필드(policy_version, versions)까지 채운 명세 */
  spec: TaskSpec;
  now: string;
}

export type TaskCreationVerdict = { decision: 'allow' } | { decision: 'deny'; reason: string };

export interface TaskRunGateRequest {
  task: TaskRow;
  spec: TaskSpec;
  /** 이번에 만들 task_run.attempt */
  attempt: number;
  now: string;
}

export type TaskRunVerdict = { decision: 'allow' } | { decision: 'needs_review'; reason: string };

export interface TaskPolicyGate {
  beforeCreate(tx: Db, request: TaskCreationGateRequest): TaskCreationVerdict;
  beforeRun(tx: Db, request: TaskRunGateRequest): TaskRunVerdict;
}

const NOT_CONFIGURED = 'policy gate not configured (A3): default deny';

/**
 * 정책 엔진이 연결되지 않았을 때의 기본값. 정책 v1 의 `default: deny`(a0-decisions D4)와 같은 방향으로,
 * 생성은 거부하고 실행 직전에는 needs_review 로 보낸다. 실행을 허용하는 기본값은 두지 않는다.
 */
export const DENY_ALL_TASK_POLICY_GATE: TaskPolicyGate = {
  beforeCreate: () => ({ decision: 'deny', reason: NOT_CONFIGURED }),
  beforeRun: () => ({ decision: 'needs_review', reason: NOT_CONFIGURED }),
};
