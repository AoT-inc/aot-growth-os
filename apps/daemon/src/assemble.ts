// 데몬 조립 (A3, A4, A5): 정책 게이트(@aot/policy) → 업무 엔진(@aot/task-engine) 의 TaskPolicyGate 포트, 승인 엔진 → 승인 소켓,
// 검증기(@aot/evaluation) → 업무 엔진의 TaskValidator 포트, 도구 호출별 정책 판정(@aot/policy) → 도구 게이트웨이(@aot/agent-runtime)의
// ToolCallPolicy 포트. 게이트웨이는 run 마다 만들므로(허용 도구·실행기·예산이 run 별) 정책 쪽 포트를 내놓고, run 별 조립은 agent-executor.ts 가 한다.
// A5 U4: `agent` 옵션이 있으면 에이전트 실행 관리(@aot/agent-runtime 의 runAgentTask)를 업무 엔진의 TaskExecutor 포트에 연결한다(time_limit·예산 초과 취소,
// cost_progress → cost_entry). 컨테이너 어댑터(`agent.docker`)가 설정된 경우에만 시작 때 Docker 가용성 확인과 이 인스턴스의 고아 컨테이너 정리(`aot.run` AND
// `aot.instance=<instanceId>`)를 한다(`prepareAgentRuntime`). 설정 → 조립(조사 에이전트 도구·출처 조회기 포함)은 runtime-config.ts, 엔트리포인트는 main.ts.
// A6 U10: `pack` 옵션이 있으면 팩(packs/<name>/, 데이터)을 읽고 검증해(pack-loader.ts) 루틴을 DB 에 `enabled=0` 으로 멱등 반영하고, 팩의 템플릿 포트를
// TaskWorker 의 `routines` 옵션에 연결한다. 루틴이 모두 꺼져 있으므로 켜기 전(U15)에는 발화가 일어나지 않는다. 팩이 잘못되었거나 반영할 수 없으면 조립이 던진다.
// A6 U11: `agent.adapters`/`agent.selectAdapter` 가 있으면 업무마다 어댑터를 고른다(이름만 task-engine 의 워커로 넘기고 `task_run.adapter` 에 남는다. 등록되지 않은 이름은 그 업무를 needs_review 로 보낸다).
// 선행 업무 결과(`inputs[kind=task_result]`)는 task-engine 이 읽고 agent-executor.ts 가 `external_untrusted` 로 표시해 어댑터 입력에 넣는다.
// 옵션이 없으면 기존 동작(주어진 executor)과 같다.
// task-engine·policy·evaluation 은 서로 모르며(경계 lint), 여기서만 만난다. main.ts 와 다중 프로세스 시험이 같은 조립을 쓴다.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDockerAvailable, cleanupOrphanContainers, isValidInstanceId, type DockerCli, type OrphanCleanupResult } from '@aot/agent-runtime';
import type { Clock, Db, TaskPolicyGate, ToolCallPolicy } from '@aot/domain';
import { createTaskValidator, type EvaluatorDeps } from '@aot/evaluation';
import { ApprovalEngine, createPolicyGate, createToolCallPolicy, PolicyStore, startApprovalServer, TotpSecretStore, type ApprovalServer } from '@aot/policy';
import { TaskWorker, type AdapterSelector, type EffectTool, type LeaseParams, type TaskExecutor, type Timers } from '@aot/task-engine';

import { createAgentExecutor, registeredAdapterNames, type AgentOptions } from './agent-executor.ts';
import { loadPack, syncPackRoutines, type LoadedPack, type PackOptions, type PackSyncResult } from './pack-loader.ts';

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
    /** 컨테이너 어댑터일 때만 준다. 주면 시작 시 Docker 가용성 확인과 고아 컨테이너 정리를 한다. 이때 `instanceId` 도 필요하다 */
    docker?: DockerCli;
    /**
     * 이 데몬 인스턴스의 ID (컨테이너 라벨 `aot.instance` 의 값, 컨테이너 러너의 `instance` 옵션과 같아야 한다). 고아 정리는 `aot.run` AND `aot.instance=<이 값>` 인
     * 컨테이너만 지운다 — 같은 Docker 호스트의 다른 데몬 컨테이너를 지우지 않는다.
     */
    instanceId?: string;
  };
  tools?: Readonly<Record<string, EffectTool>>;
  lease?: Partial<LeaseParams>;
  retryDelayMs?: number;
  timers?: Timers;
  /**
   * 검증·평가에 쓸 외부 포트 (출처 조회, LLM 검증기, 효과 측정). 주면 검증기를 조립해 `validating` 업무를 검증·전이한다.
   * 생략하면 validating 업무는 검증되지 않고 그대로 남는다. 데몬 설정에 `research_agent` 가 있으면 출처 조회기(`createSourceFetcher`, `fetch_url` 과 같은 허용 호스트·SSRF 규칙)가
   * 여기에 연결된다(runtime-config.ts). 설정 `llm_verifier: {kind: "stub"}` 가 있으면 가짜 LLM 검증기(`llm`)도 함께 연결된다(A6-U12; 실제 모델은 Q22 후속). 효과 측정 값 조회기는 A6-U13 에서 연결한다.
   */
  evaluation?: Omit<EvaluatorDeps, 'db' | 'clock'>;
  /**
   * 도메인 팩 (A6 U10). 주면 조립할 때 팩을 읽고 검증해 루틴을 `enabled=0` 으로 DB 에 반영하고(없으면 만들고, 같으면 그대로, 다르면 꺼진 행만 갱신·켜진 행은 거부),
   * 팩의 템플릿 포트를 워커에 연결한다. 생략하면 워커는 루틴을 보지 않는다(기존 동작).
   */
  pack?: PackOptions;
}

/**
 * 업무별 어댑터 선택 (A6-U11). `agent.selectAdapter` 가 있을 때만 워커에 연결한다. 등록된 이름(기본 어댑터 + `agent.adapters`)이 아닌 이름은 던진다 —
 * 워커가 그 업무를 실행하지 않고 `needs_review` 로 보낸다(없는 어댑터 대신 다른 어댑터로 조용히 실행하지 않는다). 등록 검사는 조립할 때 한 번 한다.
 */
function adapterSelectorOf(agent: NonNullable<AssembleOptions['agent']>, defaultAdapter: string): AdapterSelector | undefined {
  const registered = registeredAdapterNames(agent);
  const select = agent.selectAdapter;
  if (select === undefined) return undefined;
  return (spec) => {
    const name = select(spec);
    if (name === null) return null;
    if (name !== defaultAdapter && !registered.has(name)) throw new Error(`adapter '${String(name)}' is not registered`);
    return name;
  };
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
  /** 읽은 팩 (측정 신호 정의 포함). `pack` 옵션이 없으면 null */
  pack: LoadedPack | null;
  /** 팩 루틴의 DB 반영 결과. `pack` 옵션이 없으면 null */
  packSync: PackSyncResult | null;
  /**
   * 첫 tick 전에 부른다. 컨테이너 어댑터가 설정된 경우에만 Docker 가용성을 확인하고(없으면 DockerUnavailableError, 호스트 실행으로 대체하지 않는다)
   * 라벨 `aot.run` AND `aot.instance=<이 인스턴스>` 컨테이너(이전 데몬이 남긴 고아)만 죽이고 지운다. 설정되지 않았으면 아무것도 하지 않고 null.
   */
  prepareAgentRuntime(): Promise<AgentRuntimeReadiness | null>;
  startApprovalChannel(onError?: (error: unknown) => void): Promise<ApprovalServer>;
}

export function assembleDaemon(options: AssembleOptions): Daemon {
  if (options.agent?.docker !== undefined && !isValidInstanceId(options.agent.instanceId)) {
    throw new Error('agent.docker needs a valid agent.instanceId (it scopes the orphan container cleanup to this daemon instance)');
  }
  const store = new PolicyStore({ dir: options.paths.policyStoreDir, templates: [DEFAULT_POLICY_TEMPLATE] });
  const gate = createPolicyGate({ store });
  const engine = new ApprovalEngine({ db: options.db, clock: options.clock, store, totp: new TotpSecretStore(options.paths.totpDir) });
  const toolCallPolicy = createToolCallPolicy({ db: options.db, store });
  const executor = options.executor ?? (options.agent === undefined
    ? undefined
    : createAgentExecutor({ db: options.db, clock: options.clock, agent: options.agent, toolCallPolicy }));
  if (executor === undefined) throw new Error('assembleDaemon needs an executor or an agent');
  const defaultAdapter = options.adapter ?? options.agent?.adapter.name ?? 'unconfigured';
  const adapterFor = options.agent === undefined ? undefined : adapterSelectorOf(options.agent, defaultAdapter);
  const pack = options.pack === undefined ? null : loadPack(options.pack);
  const packSync = pack === null ? null : syncPackRoutines(options.db, pack);
  const worker = new TaskWorker({
    db: options.db,
    clock: options.clock,
    workerId: options.workerId,
    actorId: options.actorId,
    adapter: defaultAdapter,
    ...(adapterFor === undefined ? {} : { adapterFor }),
    executor,
    gate,
    ...(options.evaluation === undefined ? {} : { validator: createTaskValidator({ db: options.db, clock: options.clock, ...options.evaluation }) }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(pack === null ? {} : { routines: { source: pack.templateSource } }),
  });
  return {
    store,
    gate,
    toolCallPolicy,
    engine,
    worker,
    pack,
    packSync,
    async prepareAgentRuntime() {
      const docker = options.agent?.docker;
      if (docker === undefined) return null;
      const dockerVersion = await checkDockerAvailable(docker);
      const orphans = await cleanupOrphanContainers({ docker, instance: options.agent!.instanceId! });
      return { dockerVersion, orphans };
    },
    startApprovalChannel: (onError) => startApprovalServer({
      socketPath: options.paths.approvalSocket,
      handle: (request) => engine.handle(request),
      ...(onError === undefined ? {} : { onError }),
    }),
  };
}
