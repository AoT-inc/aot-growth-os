// 데몬 조립 (A3, A4, A5): 정책 게이트(@aot/policy) → 업무 엔진(@aot/task-engine) 의 TaskPolicyGate 포트, 승인 엔진 → 승인 소켓,
// 검증기(@aot/evaluation) → 업무 엔진의 TaskValidator 포트, 도구 호출별 정책 판정(@aot/policy) → 도구 게이트웨이(@aot/agent-runtime)의
// ToolCallPolicy 포트. 게이트웨이는 run 마다 만들므로(허용 도구·실행기·예산이 run 별) 정책 쪽 포트를 내놓고, run 별 조립은 agent-executor.ts 가 한다.
// A5 U4: `agent` 옵션이 있으면 에이전트 실행 관리(@aot/agent-runtime 의 runAgentTask)를 업무 엔진의 TaskExecutor 포트에 연결한다(time_limit·예산 초과 취소,
// cost_progress → cost_entry). 컨테이너 어댑터(`agent.docker`)가 설정된 경우에만 시작 때 Docker 가용성 확인과 라벨 고아 정리를 한다(`prepareAgentRuntime`).
// 옵션이 없으면 기존 동작(주어진 executor)과 같다.
// task-engine·policy·evaluation 은 서로 모르며(경계 lint), 여기서만 만난다. main.ts 와 다중 프로세스 시험이 같은 조립을 쓴다.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDockerAvailable, cleanupOrphanContainers, CONTAINER_LABEL_KEY, type DockerCli, type OrphanCleanupResult } from '@aot/agent-runtime';
import type { Clock, Db, TaskPolicyGate, ToolCallPolicy } from '@aot/domain';
import { createTaskValidator, type EvaluatorDeps } from '@aot/evaluation';
import { ApprovalEngine, createPolicyGate, createToolCallPolicy, PolicyStore, startApprovalServer, TotpSecretStore, type ApprovalServer } from '@aot/policy';
import { TaskWorker, type EffectTool, type LeaseParams, type TaskExecutor, type Timers } from '@aot/task-engine';

import { createAgentExecutor, type AgentOptions } from './agent-executor.ts';

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
  /** task_run.adapter. 생략하면 `agent.adapter.name`, 둘 다 없으면 'unconfigured' */
  adapter?: string;
  /** 실행기. `agent` 와 둘 중 하나는 있어야 한다(둘 다 주면 executor 가 쓰인다) */
  executor?: TaskExecutor;
  /** 에이전트 실행 관리 (A5 U4). 어댑터·도구·타이머·run_log 저장소 */
  agent?: AgentOptions & {
    /** 컨테이너 어댑터일 때만 준다. 주면 시작 시 Docker 가용성 확인과 `aot.run` 라벨 고아 정리를 한다 */
    docker?: DockerCli;
  };
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

export interface AgentRuntimeReadiness {
  dockerVersion: string;
  orphans: OrphanCleanupResult;
}

export interface Daemon {
  store: PolicyStore;
  gate: TaskPolicyGate;
  /** 도구 게이트웨이가 호출마다 부르는 정책 재판정 (판정은 policy_decision 에 남는다) */
  toolCallPolicy: ToolCallPolicy;
  engine: ApprovalEngine;
  worker: TaskWorker;
  /**
   * 첫 tick 전에 부른다. 컨테이너 어댑터가 설정된 경우에만 Docker 가용성을 확인하고(없으면 DockerUnavailableError, 호스트 실행으로 대체하지 않는다)
   * 라벨 `aot.run` 컨테이너(이전 데몬이 남긴 고아)를 죽이고 지운다. 설정되지 않았으면 아무것도 하지 않고 null.
   */
  prepareAgentRuntime(): Promise<AgentRuntimeReadiness | null>;
  startApprovalChannel(onError?: (error: unknown) => void): Promise<ApprovalServer>;
}

export function assembleDaemon(options: AssembleOptions): Daemon {
  const store = new PolicyStore({ dir: options.paths.policyStoreDir, templates: [DEFAULT_POLICY_TEMPLATE] });
  const gate = createPolicyGate({ store });
  const engine = new ApprovalEngine({ db: options.db, clock: options.clock, store, totp: new TotpSecretStore(options.paths.totpDir) });
  const toolCallPolicy = createToolCallPolicy({ db: options.db, store });
  const executor = options.executor ?? (options.agent === undefined
    ? undefined
    : createAgentExecutor({ db: options.db, clock: options.clock, agent: options.agent, toolCallPolicy }));
  if (executor === undefined) throw new Error('assembleDaemon needs an executor or an agent');
  const worker = new TaskWorker({
    db: options.db,
    clock: options.clock,
    workerId: options.workerId,
    actorId: options.actorId,
    adapter: options.adapter ?? options.agent?.adapter.name ?? 'unconfigured',
    executor,
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
    toolCallPolicy,
    engine,
    worker,
    async prepareAgentRuntime() {
      const docker = options.agent?.docker;
      if (docker === undefined) return null;
      const dockerVersion = await checkDockerAvailable(docker);
      const orphans = await cleanupOrphanContainers({ docker, label: CONTAINER_LABEL_KEY });
      return { dockerVersion, orphans };
    },
    startApprovalChannel: (onError) => startApprovalServer({
      socketPath: options.paths.approvalSocket,
      handle: (request) => engine.handle(request),
      ...(onError === undefined ? {} : { onError }),
    }),
  };
}
