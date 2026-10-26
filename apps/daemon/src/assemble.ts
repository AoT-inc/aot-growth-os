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
// A6 U13: 측정 신호 정의(팩의 `signals` 또는 `measurementSignals`)가 있으면 승인 소켓에 `measure`·`measurements` 명령을 얹고(measure.ts, 같은 인증 경계),
// 평가 포트가 있으면 효과 측정 조회기(`createMeasurementSignalSource`)를 연결한다. 측정 대기 조건 자체는 task-engine 의 claim 이 본다.
// A6 U14: 측정 신호 정의를 평가기에도 넘겨 검사 `experiment_candidates` 가 후보의 신호를 대조한다. `cycle` 옵션이 있으면 주간 사이클 4·5단계(cycle.ts:
// 완료된 기획 업무의 후보 비교 → strategy_version 제안)를 만든다. 위험 판정은 여기서 정책으로 만들어 주입한다(evaluation 은 policy 를 모른다).
// A6 U15: 사이클에 6단계(승인된 실험 활성화)를 연결한다 — 일회성 마케팅 업무의 생성 게이트는 같은 정책 게이트, 활성화 직전 승인 확인은 policy `verifyStrategyApproval`.
// 승인 자체(`strategy_version` 의 show/approve/reject/cancel)는 승인 엔진이 같은 소켓에서 받는다.
// A6 U16: 사이클에 7단계(실험 주가 끝난 뒤 결과 검토 업무 생성 → 평가 → 결과 기록)를 연결한다 — 팩이 있으면 팩 템플릿 `experiment-result-review@1` 을 풀어 검토 업무를 만들고(생성 게이트는 같은 정책 게이트),
// 결과 기억의 기본 만료는 현재 정책의 `memory.default_validity` 다. 승격(`promote`)·`experiment` 상태 전략의 `reject`·`reviews` 는 승인 소켓의 같은 인증 경계에서 experiment-review.ts 가 받는다.
// 효과 해소: 응답을 잃어 `unknown` 이 된 external_effect 를 사람이 confirmed / failed 로 확정하는 `effects`·`resolve-effect` 명령은 항상 승인 소켓에 있다(effect-resolve.ts,
// 같은 인증 경계, failed 는 승인 엔진의 `reauthenticateInTx` 로 TOTP 재인증 — release 와 같은 잠금을 공유). 소켓 처리기에서 가장 먼저 걸러진다.
// 옵션이 없으면 기존 동작(주어진 executor)과 같다.
// task-engine·policy·evaluation 은 서로 모르며(경계 lint), 여기서만 만난다. main.ts 와 다중 프로세스 시험이 같은 조립을 쓴다.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDockerAvailable, cleanupOrphanContainers, isValidInstanceId, type DockerCli, type OrphanCleanupResult } from '@aot/agent-runtime';
import type { Clock, Db, MeasurementSignal, TaskPolicyGate, ToolCallPolicy } from '@aot/domain';
import { createMeasurementSignalSource, createTaskValidator, type EvaluatorDeps } from '@aot/evaluation';
import {
  ApprovalEngine, createPolicyGate, createToolCallPolicy, memoryDefaultValidity, PolicyStore, startApprovalServer, TotpSecretStore, verifyStrategyApproval, type ApprovalServer,
} from '@aot/policy';
import { TaskWorker, type AdapterSelector, type EffectTool, type LeaseParams, type TaskExecutor, type Timers } from '@aot/task-engine';

import { createAgentExecutor, registeredAdapterNames, type AgentOptions } from './agent-executor.ts';
import { createPhoneRuntime, type PhoneOptions, type PhoneRuntime } from './phone.ts';
import { createExperimentCycle, createPolicyRiskJudge, type ExperimentCycle, type ExperimentCycleOptions } from './cycle.ts';
import { createConsentHandler, isConsentCommand } from './consent.ts';
import { createProductChannel, isProductCommand } from './product-channel.ts';
import { createEffectResolutionHandler, isEffectResolutionCommand } from './effect-resolve.ts';
import { createExperimentDecisionHandler, isExperimentDecisionCommand } from './experiment-review.ts';
import { createMeasurementHandler, isMeasurementCommand } from './measure.ts';
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
  /** 어댑터가 미룬 run 의 retry_wait 대기 시간 (시도 소모 없음). 기본 15분 */
  deferDelayMs?: number;
  timers?: Timers;
  /**
   * 검증·평가에 쓸 외부 포트 (출처 조회, LLM 검증기, 효과 측정). 주면 검증기를 조립해 `validating` 업무를 검증·전이한다.
   * 생략하면 validating 업무는 검증되지 않고 그대로 남는다. 데몬 설정에 `research_agent` 가 있으면 출처 조회기(`createSourceFetcher`, `fetch_url` 과 같은 허용 호스트·SSRF 규칙)가
   * 여기에 연결된다(runtime-config.ts). 설정 `llm_verifier: {kind: "stub"}` 가 있으면 가짜 LLM 검증기(`llm`)도 함께 연결된다(A6-U12; 실제 모델은 Q22 후속).
   * `effect` 를 주지 않았고 측정 신호 정의가 있으면 사람이 입력한 측정 값의 조회기(`createMeasurementSignalSource`, 읽기 전용)를 연결한다(A6-U13).
   */
  evaluation?: Omit<EvaluatorDeps, 'db' | 'clock'>;
  /**
   * 상품 등록 채널(`product` 명령, product-channel.ts)을 승인 소켓에 얹는다. 주면 사람이 후보 상품을 올리고 검증 업무를 시작하고 등록·반려를 결정할 수 있다.
   * `forbiddenRoots`: 저장소 경로가 겹치면 안 되는 디렉터리(데몬 인스턴스·근거 저장소). 증거 본문은 `evaluation.evidenceReader` 로 읽는다.
   */
  productChannel?: { forbiddenRoots: readonly string[] };
  /**
   * 도메인 팩 (A6 U10). 주면 조립할 때 팩을 읽고 검증해 루틴을 `enabled=0` 으로 DB 에 반영하고(없으면 만들고, 같으면 그대로, 다르면 꺼진 행만 갱신·켜진 행은 거부),
   * 팩의 템플릿 포트를 워커에 연결한다. 생략하면 워커는 루틴을 보지 않는다(기존 동작).
   */
  pack?: PackOptions;
  /**
   * 측정 신호 정의를 팩 없이 직접 줄 때 (A6-U13; 시험·팩 없는 구성). `pack` 과 함께 주면 거부한다(정의의 원천은 하나).
   * 정의가 있으면 승인 소켓에 `measure`·`measurements` 명령이 생긴다.
   */
  measurementSignals?: readonly MeasurementSignal[];
  /**
   * 주간 사이클 4·5단계 (A6-U14). 주면 `Daemon.cycle` 이 생기고, main 루프가 worker tick 뒤에 `cycle.advance()` 를 부른다.
   * 생략하면 null(이전 동작). 위험 판정은 현재 정책(이 조립의 정책 보관소)과 팩 템플릿으로 한다.
   */
  cycle?: ExperimentCycleOptions;
  /**
   * 전화 Capability (ADR-0014). 주면 전화 부작용 도구가 워커의 `tools` 에 합쳐지고, 에이전트 실행기가 있으면 게이트웨이에 전화 도구(phone_call 등)가 열린다.
   * 도구가 열려도 명세의 `allowed_tools`, 도구 호출별 정책 판정, 전화 정책(`phone:` 섹션; 없으면 모든 통화 거부)이 모두 통과해야 통화가 일어난다.
   */
  phone?: PhoneOptions;
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

/** 전화 도구 선언과 run 별 실행기를 에이전트 옵션에 더한다. 같은 이름의 도구가 이미 있으면 거부한다 */
function withPhone(agent: NonNullable<AssembleOptions['agent']>, phone: PhoneRuntime): NonNullable<AssembleOptions['agent']> {
  const existing = agent.tools ?? [];
  for (const spec of phone.toolSpecs) {
    if (existing.some((tool) => tool.tool === spec.tool)) throw new Error(`tool '${spec.tool}' is already configured; the phone capability provides it`);
  }
  const previous = agent.runExecutors;
  return {
    ...agent,
    tools: [...existing, ...phone.toolSpecs],
    runExecutors: (context) => new Map([...(previous?.(context) ?? []), ...phone.executorsFor(context)]),
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
  /** 측정 값 입력을 받는 신호 정의 (팩 또는 `measurementSignals`, 없으면 빈 목록) */
  measurementSignals: readonly MeasurementSignal[];
  /** 주간 사이클 4·5단계 (후보 비교 → strategy_version 제안). `cycle` 옵션이 없으면 null */
  cycle: ExperimentCycle | null;
  /** 전화 런타임 (webhook 수신, 마감 확인). `phone` 옵션이 없으면 null */
  phone: PhoneRuntime | null;
  /** 승인 소켓의 요청 하나를 처리한다: `effects`·`resolve-effect` 는 효과 해소 채널, `consent` 는 claude-code-cli 고지 동의 채널, `measure`·`measurements` 는 측정 채널, 나머지는 승인 엔진 (소켓 서버와 같은 함수) */
  handleChannelRequest(request: unknown): unknown;
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
  const phone = options.phone === undefined ? null : createPhoneRuntime({ db: options.db, clock: options.clock, store, options: options.phone });
  const agentOptions = options.agent === undefined || phone === null ? options.agent : withPhone(options.agent, phone);
  const tools = phone === null ? options.tools : { ...(options.tools ?? {}), ...phone.effectTools };
  const executor = options.executor ?? (agentOptions === undefined
    ? undefined
    : createAgentExecutor({ db: options.db, clock: options.clock, agent: agentOptions, toolCallPolicy }));
  if (executor === undefined) throw new Error('assembleDaemon needs an executor or an agent');
  const defaultAdapter = options.adapter ?? options.agent?.adapter.name ?? 'unconfigured';
  const adapterFor = options.agent === undefined ? undefined : adapterSelectorOf(options.agent, defaultAdapter);
  if (options.pack !== undefined && options.measurementSignals !== undefined) {
    throw new Error('give measurement signals either through the pack or through measurementSignals, not both');
  }
  const pack = options.pack === undefined ? null : loadPack(options.pack);
  const packSync = pack === null ? null : syncPackRoutines(options.db, pack);
  const measurementSignals = pack?.signals ?? options.measurementSignals ?? [];
  const evaluation = options.evaluation === undefined ? undefined : {
    ...options.evaluation,
    ...(options.evaluation.signals === undefined && measurementSignals.length > 0 ? { signals: measurementSignals } : {}),
    ...(options.evaluation.effect === undefined && measurementSignals.length > 0
      ? { effect: createMeasurementSignalSource({ db: options.db, signals: measurementSignals }) }
      : {}),
  };
  const measure = measurementSignals.length === 0 ? null : createMeasurementHandler({ db: options.db, clock: options.clock, signals: measurementSignals });
  const resolveEffects = createEffectResolutionHandler({ db: options.db, clock: options.clock, reauth: (tx, actorId, code, purpose) => engine.reauthenticateInTx(tx, actorId, code, purpose) });
  const decide = createExperimentDecisionHandler({ db: options.db, clock: options.clock });
  const consent = createConsentHandler({ db: options.db, clock: options.clock });
  const productChannel = options.productChannel === undefined ? null : createProductChannel({
    db: options.db, clock: options.clock, gate, forbiddenRoots: options.productChannel.forbiddenRoots,
    ...(options.evaluation?.evidenceReader === undefined ? {} : { evidenceReader: options.evaluation.evidenceReader }),
  });
  const handleChannelRequest = (request: unknown): unknown => {
    if (isEffectResolutionCommand(request)) return resolveEffects(request);
    if (isConsentCommand(request)) return consent(request);
    if (isProductCommand(request)) return productChannel === null ? { ok: false, error: 'the product channel is not configured (set registration_tools)' } : productChannel(request);
    if (isMeasurementCommand(request)) return measure === null ? { ok: false, error: 'no measurement signal is defined (configure a pack with measurement_signals)' } : measure(request);
    if (isExperimentDecisionCommand(options.db, request)) return decide(request);
    return engine.handle(request);
  };
  const cycle = options.cycle === undefined ? null : createExperimentCycle({
    db: options.db, clock: options.clock, options: options.cycle, signals: measurementSignals,
    riskOf: createPolicyRiskJudge({ db: options.db, store, templates: pack?.templates ?? [] }),
    activation: { gate, verifyApproval: (tx, id) => verifyStrategyApproval(tx, id) },
    ...(pack === null ? {} : { review: { gate, instantiate: (ref, instantiateOptions) => pack.templateSource.instantiate(ref, instantiateOptions) } }),
    defaultValidity: () => {
      const active = store.active(options.db);
      return active === null || active.policy === null ? undefined : memoryDefaultValidity(active.policy.document);
    },
  });
  const worker = new TaskWorker({
    db: options.db,
    clock: options.clock,
    workerId: options.workerId,
    actorId: options.actorId,
    adapter: defaultAdapter,
    ...(adapterFor === undefined ? {} : { adapterFor }),
    executor,
    gate,
    ...(evaluation === undefined ? {} : { validator: createTaskValidator({ db: options.db, clock: options.clock, ...evaluation }) }),
    ...(tools === undefined ? {} : { tools }),
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.deferDelayMs === undefined ? {} : { deferDelayMs: options.deferDelayMs }),
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
    measurementSignals,
    cycle,
    phone,
    handleChannelRequest,
    async prepareAgentRuntime() {
      const docker = options.agent?.docker;
      if (docker === undefined) return null;
      const dockerVersion = await checkDockerAvailable(docker);
      const orphans = await cleanupOrphanContainers({ docker, instance: options.agent!.instanceId! });
      return { dockerVersion, orphans };
    },
    startApprovalChannel: (onError) => startApprovalServer({
      socketPath: options.paths.approvalSocket,
      handle: handleChannelRequest,
      ...(onError === undefined ? {} : { onError }),
    }),
  };
}
