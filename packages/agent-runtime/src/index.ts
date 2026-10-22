// @aot/agent-runtime 공개 API 진입점 (단계 A5). 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 책임: 어댑터 계약(U1), 게이트웨이 프레임, 가짜 어댑터, 도구 게이트웨이(U2). 계약 테스트 스위트는 test/support/adapter-contract.ts·gateway-contract.ts
// (node:test 의존이라 공개 API에 넣지 않는다). 컨테이너 샌드박스(U3: 인자 생성기·docker CLI·러너·고아 정리)는 아래. 실행 관리(U4: time_limit·예산 초과 취소, 비용 기록 포트 연결, run_log 저장)는 run-manager.ts. 실제 어댑터는 뒤 단위.
export {
  ADAPTER_STATUSES, COST_UNITS,
  type AdapterBudget, type AdapterContext, type AdapterCost, type AdapterError, type AdapterInput, type AdapterOutput, type AdapterStatus,
  type AgentAdapter, type AllowedTool, type CostProgressEvent, type CostUnit, type EvidenceItem, type JsonObject, type JsonValue,
  type RunLogEntry, type ToolGateway, type ToolGatewayResponse,
} from './contract.ts';
export { isClockIso, isJsonObject, isJsonValue, validateAdapterOutput, validateCostProgress } from './validate.ts';
export {
  AGENT_TO_HOST_FRAME_TYPES, encodeFrame, HOST_TO_AGENT_FRAME_TYPES, MAX_FRAME_BYTES, parseFrame,
  type CostProgressFrame, type Frame, type FrameDirection, type FrameEncode, type FrameParse, type FrameRejectCode, type FrameRejection,
  startFrameOf,
  type ResultFrame, type StartFrame, type ToolCallFrame, type ToolResultFrame,
} from './frames.ts';
export {
  createFakeAgentAdapter, DEFAULT_DENIED_TOOL, DEFAULT_FAKE_COST_STEPS,
  type FakeAdapterConfig, type FakeScenario, type FakeToolCall,
} from './fake-adapter.ts';
export {
  createToolGateway, GATEWAY_ERROR_CODES, MAX_TOOL_RESULT_BYTES, RECORD_PREVIEW_CHARS, realGatewayTimers, toolCallConstraintsOf,
  type GatewayErrorCode, type GatewayTimers, type GatewayToolSpec, type RunToolGateway, type ToolCallOutcome, type ToolCallRecord,
  type ToolCallRecorder, type ToolExecutionRequest, type ToolExecutionResult, type ToolExecutor, type ToolGatewayOptions, type ToolResultOrigin,
} from './gateway.ts';
export { isSecretKey, maskSecrets, maskString, previewJson, REDACTED } from './mask.ts';
export {
  buildContainerArgs, CONTAINER_LABEL_KEY, CONTAINER_WORKDIR, ContainerArgsError, DEFAULT_CONTAINER_USER, forbiddenFlagIn,
  type ContainerArgsErrorCode, type ContainerConfig, type ContainerLimits,
} from './container-args.ts';
export {
  checkDockerAvailable, cleanupOrphanContainers, createDockerCli, DOCKER_ENV_WHITELIST, DockerUnavailableError, nodeProcessPort, pickDockerEnv,
  type DockerCli, type DockerCliOptions, type DockerUnavailableCode, type ExecResult, type OrphanCleanupResult, type ProcessPort, type SpawnedProcess,
} from './docker.ts';
export { createLineReader, type LineEvent, type LineReader } from './line-reader.ts';
export {
  createContainerRunner,
  type ContainerEnd, type ContainerRunner, type ContainerRunnerOptions, type ContainerRunOptions, type ContainerRunReport,
} from './container-runner.ts';
export { containerAgentAdapter } from './container-adapter.ts';
export {
  createFileRunLogStore, MAX_RUN_LOG_ENTRIES, MAX_RUN_LOG_MESSAGE_CHARS, RUN_LOG_REF_PREFIX, runLogRefFor, type RunLogStore,
} from './run-log-store.ts';
export {
  DEFAULT_TERMINATION_GRACE_MS, DEFAULT_TIME_LIMIT_MS, runAgentTask,
  type AgentTaskEnd, type AgentTaskReport, type GatewayHooks, type KillReason, type ManagedGateway, type RunAgentTaskOptions,
} from './run-manager.ts';
