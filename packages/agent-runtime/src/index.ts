// @aot/agent-runtime 공개 API 진입점 (단계 A5). 다른 패키지는 이 파일로만 참조한다 (경계 lint: .dependency-cruiser.cjs).
// 책임: 어댑터 계약(U1), 게이트웨이 프레임, 가짜 어댑터, 도구 게이트웨이(U2). 계약 테스트 스위트는 test/support/adapter-contract.ts·gateway-contract.ts
// (node:test 의존이라 공개 API에 넣지 않는다). 실행 관리(U3)·샌드박스(U4)는 뒤 단위.
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
  type ResultFrame, type ToolCallFrame, type ToolResultFrame,
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
