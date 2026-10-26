// @aot/agent-runtime 공개 API 진입점 (단계 A5). 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 책임: 어댑터 계약(U1), 게이트웨이 프레임, 가짜 어댑터, 도구 게이트웨이(U2). 계약 테스트 스위트는 test/support/adapter-contract.ts·gateway-contract.ts
// (node:test 의존이라 공개 API에 넣지 않는다). 컨테이너 샌드박스(U3: 인자 생성기·docker CLI·러너·고아 정리)는 아래. 실행 관리(U4: time_limit·예산 초과 취소, 비용 기록 포트 연결, run_log 저장)는 run-manager.ts. 실제 어댑터(읽기 전용 조사, U5)는 research-adapter.ts·fetch-url.ts.
export {
  ADAPTER_STATUSES, COST_UNITS,
  type AdapterBudget, type AdapterContext, type AdapterCost, type AdapterError, type AdapterInput, type AdapterOutput, type AdapterStatus,
  type AgentAdapter, type AllowedTool, type CostProgressEvent, type CostUnit, type EvidenceItem, type JsonObject, type JsonValue,
  type RunLogEntry, type ToolGateway, type ToolGatewayResponse, type UpstreamResult,
} from './contract.ts';
export { isClockIso, isJsonObject, isJsonValue, validateAdapterOutput, validateCostProgress, validateUpstream } from './validate.ts';
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
  buildContainerArgs, CONTAINER_LABEL_KEY, CONTAINER_WORKDIR, ContainerArgsError, DEFAULT_CONTAINER_USER, forbiddenFlagIn, INSTANCE_LABEL_KEY, isValidInstanceId,
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
// 읽기 전용 조사 에이전트(U5): 컨테이너 안 에이전트의 호스트 쪽 어댑터와 게이트웨이 도구 `fetch_url`(SSRF 방지), 검증기용 출처 조회기.
// 시험용 주입점이 있는 `*WithHooks` 생성기는 내보내지 않는다(사설 주소 규칙을 푸는 길을 운영 설정으로 노출하지 않는다).
export { createResearchAgentAdapter, RESEARCH_AGENT_LIMITS, RESEARCH_AGENT_NAME, type ResearchAgentAdapterOptions } from './research-adapter.ts';
export {
  createFetchUrlTool, createSourceFetcher, DEFAULT_ALLOWED_CONTENT_TYPES, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_REDIRECTS, DEFAULT_SOURCE_FETCH_TIMEOUT_MS,
  FETCH_URL_OPERATION, FETCH_URL_TOOL, fetchUrlToolSpec, FetchUrlError, hostMatches, htmlToText, MAX_BODY_BYTES_LIMIT, MAX_REDIRECTS_LIMIT, MAX_URL_CHARS,
  type FetchedPage, type FetchedRedirect, type FetchUrlErrorCode, type FetchUrlTool, type FetchUrlToolOptions, type SourceFetcherOptions,
} from './fetch-url.ts';
export { addressFamily, isPublicAddress, isPublicIPv4, isPublicIPv6, parseIPv4, parseIPv6 } from './ip-address.ts';
export {
  createFileRunLogStore, MAX_RUN_LOG_ENTRIES, MAX_RUN_LOG_MESSAGE_CHARS, RUN_LOG_REF_PREFIX, runLogRefFor, type RunLogStore,
} from './run-log-store.ts';
export {
  DEFAULT_TERMINATION_GRACE_MS, DEFAULT_TIME_LIMIT_MS, runAgentTask,
  type AgentTaskEnd, type AgentTaskReport, type GatewayHooks, type KillReason, type ManagedGateway, type RunAgentTaskOptions,
} from './run-manager.ts';
// 전화 Capability (단계: ADR-0014). 에이전트가 쓰는 PhoneCapability 구현, 게이트웨이 도구, 부작용 도구, webhook 수신, 인바운드 처리, 마감 보완, 가짜 provider.
// provider 어댑터(Vapi 등)는 이 패키지에 없다 — 비밀값을 가진 인프라 코드라 apps/daemon 이 PhonePort 로 주입한다.
export { bindToEffectLedger, isEffectLedgerBound, type EffectLedgerRunner, type LedgerPerform } from './effect-ledger.ts';
export * from './phone/index.ts';
// claude-code-cli 어댑터 (Q4 후속, CC1~CC3): 구독 로그인된 사용자 PC 의 공식 `claude -p` 를 격리된 호출 모양으로 실행한다 (스파이크 Q4, ADR-0005 Amendment 2026-10-25·26).
export { serveGatewaySocket, type GatewaySocket } from './claude-code/gateway-socket.ts';
export { CLAUDE_CODE_ADAPTER_NAME, createClaudeCodeCliAdapter, type ClaudeCodeCliOptions, type ClaudeCodeConsent } from './claude-code/adapter.ts';
export { CLAUDE_CODE_NOTICE, type ClaudeCodeNotice } from './claude-code/consent.ts';
export {
  BUILTIN_TOOLS as CLAUDE_CODE_BUILTIN_TOOLS, buildBridgeTools, buildClaudeArgs, buildClaudeEnv, buildMcpConfig, buildPrompt, CLAUDE_ENV_NAMES, FORBIDDEN_CLAUDE_FLAGS, GATEWAY_SERVER_NAME,
  buildWorkdirFiles, mcpToolName, TASK_INSTRUCTIONS, upstreamFileOf, type BridgeTool, type ClaudeArgsInput, type ClaudeEnvInput,
} from './claude-code/invocation.ts';
export {
  applyStreamEvent, checkInit, CLAUDE_CODE_DEFERRED_CODE, CLAUDE_CODE_REVIEW_CODES, classifyRun, newStreamState, parseStreamLine, parseStructuredOutput, summarizeStreamEvent, DEFAULT_LIMIT_PATTERNS, DEFAULT_SERVER_LIMIT_PATTERNS, isClaudeCodeDeferredCode, isClaudeCodeReviewCode, resultJsonSchema,
  type ClaudeCodeReviewCode, type ClassifiedRun, type ExpectedInit, type StreamState,
} from './claude-code/stream.ts';
