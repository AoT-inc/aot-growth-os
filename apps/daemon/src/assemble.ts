// 데몬 조립 (A3, A4): 정책 게이트(@aot/policy) → 업무 엔진(@aot/task-engine) 의 TaskPolicyGate 포트, 승인 엔진 → 승인 소켓,
// 검증기(@aot/evaluation) → 업무 엔진의 TaskValidator 포트.
// task-engine·policy·evaluation 은 서로 모르며(경계 lint), 여기서만 만난다. main.ts 와 다중 프로세스 시험이 같은 조립을 쓴다.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Clock, Db, TaskPolicyGate } from '@aot/domain';
import { createTaskValidator, type EvaluatorDeps } from '@aot/evaluation';
import { ApprovalEngine, createPolicyGate, PolicyStore, startApprovalServer, TotpSecretStore, type ApprovalServer } from '@aot/policy';
import { TaskWorker, type EffectTool, type LeaseParams, type TaskExecutor, type Timers } from '@aot/task-engine';

/** 저장소의 기본 정책 템플릿 (시드의 policy-v1 내용) */
export const DEFAULT_POLICY_TEMPLATE = fileURLToPath(new URL('../../../policies/default.yaml', import.meta.url));

export interface InstancePaths {
  /** 배포된 정책 내용 보관소 (instance/policies) */
  policyStoreDir: string;
  /** 사람별 TOTP 비밀 (instance/totp) */
  totpDir: string;
  /** 승인 소켓 (instance/run/approval.sock). 디렉터리는 0700 이어야 한다 */
  approvalSocket: string;
}

export function defaultInstancePaths(instanceDir: string): InstancePaths {
  return {
    policyStoreDir: join(instanceDir, 'policies'),
    totpDir: join(instanceDir, 'totp'),
    approvalSocket: join(instanceDir, 'run', 'approval.sock'),
  };
}

export interface AssembleOptions {
  db: Db;
  clock: Clock;
  paths: InstancePaths;
  workerId: string;
  actorId: string;
  adapter: string;
  executor: TaskExecutor;
  tools?: Readonly<Record<string, EffectTool>>;
  lease?: Partial<LeaseParams>;
  retryDelayMs?: number;
  timers?: Timers;
  /**
   * 검증·평가에 쓸 외부 포트 (출처 조회, LLM 검증기, 효과 측정). 주면 검증기를 조립해 `validating` 업무를 검증·전이한다.
   * 생략하면 validating 업무는 검증되지 않고 그대로 남는다 (실제 포트는 A5/A6 에서 게이트웨이를 거쳐 연결).
   */
  evaluation?: Omit<EvaluatorDeps, 'db' | 'clock'>;
}

export interface Daemon {
  store: PolicyStore;
  gate: TaskPolicyGate;
  engine: ApprovalEngine;
  worker: TaskWorker;
  startApprovalChannel(onError?: (error: unknown) => void): Promise<ApprovalServer>;
}

export function assembleDaemon(options: AssembleOptions): Daemon {
  const store = new PolicyStore({ dir: options.paths.policyStoreDir, templates: [DEFAULT_POLICY_TEMPLATE] });
  const gate = createPolicyGate({ store });
  const engine = new ApprovalEngine({ db: options.db, clock: options.clock, store, totp: new TotpSecretStore(options.paths.totpDir) });
  const worker = new TaskWorker({
    db: options.db,
    clock: options.clock,
    workerId: options.workerId,
    actorId: options.actorId,
    adapter: options.adapter,
    executor: options.executor,
    gate,
    ...(options.evaluation === undefined ? {} : { validator: createTaskValidator({ db: options.db, clock: options.clock, ...options.evaluation }) }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });
  return {
    store,
    gate,
    engine,
    worker,
    startApprovalChannel: (onError) => startApprovalServer({
      socketPath: options.paths.approvalSocket,
      handle: (request) => engine.handle(request),
      ...(onError === undefined ? {} : { onError }),
    }),
  };
}
