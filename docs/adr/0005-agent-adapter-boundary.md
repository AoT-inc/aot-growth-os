# ADR-0005 에이전트는 어댑터 뒤에 둔다

상태: proposed

## Context
에이전트 제품(Claude Code, OpenHands, LangGraph 기반 에이전트 등)은 교체될 가능성이 크다. 업무 이력과 운영 규칙은 교체와 무관하게 남아야 한다.

## Decision
- `agent-runtime`은 단일 인터페이스를 정의한다: 입력 = `task_spec` + 허용 도구 + 근거 참조 + 예산, 출력 = `result`(구조화) + `evidence[]` + `run_log` + `cost`.
- 어댑터는 입력을 제품별 형식으로 변환할 뿐 정책을 판단하지 않는다. 정책 강제는 어댑터 바깥(도구 게이트웨이)에서 한다.
- 실행 환경은 격리한다: 파일시스템 범위, 네트워크 허용 목록, 도구 허용 목록, 시간·비용 한도. 무제한 셸/전체 네트워크 금지.
- 코드 에이전트가 대화 세션 외부(헤드리스)에서 작업하고 결과를 반환할 수 있는지는 어댑터 도입 전 스파이크로 검증한다.

## Consequences
- 어댑터마다 동일한 계약 테스트(contract test)를 둔다.
- 에이전트 제품 교체 시 업무·근거·비용 이력은 영향받지 않는다.

## Amendment (2026-10-19): 비용 진행 보고
예산 초과 중단은 실행 중에 비용을 알아야 가능하다. 어댑터 계약은 종료 시 `cost`뿐 아니라 실행 중 `cost_progress` 이벤트(누적 비용, 단위)를 주기적으로 보고해야 하며, 데몬은 이를 `cost_entry`에 기록하고 예산 초과 시 취소 신호를 보낸다. 보고하지 못하는 어댑터는 도구 게이트웨이가 호출별 비용을 계량한다.

## Amendment (2026-10-23): 근거의 신뢰 출처는 호스트가 정한다
어댑터 계약의 `EvidenceItem.trust_origin`은 필수이고 어휘만 검증하지만 *자기 신고*라서 저장 값으로 믿지 않는다. 호스트는 에이전트 출력을 `evidence` 행으로 저장할 때 어댑터가 밝힌 값과 무관하게 항상 `external_untrusted`로 쓴다(`AgentRunHost` 포트와 task-engine `recordRunOutput`이 신뢰 출처를 받지 않는다). 어댑터 출력은 신뢰 경계 밖이므로 자기 신고에 기대지 않는다: 거부 방식은 정상 어댑터의 작업을 잃게 하고, 강등은 판단 지점을 늘리며, 항상 덮어쓰기는 fail-closed이면서 가장 단순해서 택했다. 에이전트 출력이 아닌 경로가 쓰는 `internal` 근거는 영향이 없다. [trust-boundaries §2-3](../security/trust-boundaries.md), [memory-item](../schema/memory-item.md) 규칙 9.
