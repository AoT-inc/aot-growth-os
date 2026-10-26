// 게이트웨이 프레임의 의존성 없는 기초 (한 줄 JSON 프레임의 크기 상한과 프레임 종류 이름).
// 컨테이너 안 에이전트(packages/agent-runtime/container/*)도 이 파일을 이미지에 그대로 COPY 해서 쓴다: 컨테이너에는 node_modules 가 없으므로
// 이 파일은 `node:` 내장 모듈 말고 어떤 것도 import 하지 않는다(시험 test/unit/research-agent-image.test.ts 가 고정한다).
// 프레임의 형식 검증(frames.ts)은 domain 에 의존하므로 호스트 쪽에만 있다. 상한 값이 호스트와 에이전트에서 어긋나지 않게 여기 한 곳에 둔다.

/** 한 프레임(개행 제외, UTF-8 바이트)의 최대 크기: 1 MiB */
export const MAX_FRAME_BYTES = 1024 * 1024;

export const AGENT_TO_HOST_FRAME_TYPES = ['tool_call', 'cost_progress', 'result'] as const;
export const HOST_TO_AGENT_FRAME_TYPES = ['start', 'tool_result'] as const;
