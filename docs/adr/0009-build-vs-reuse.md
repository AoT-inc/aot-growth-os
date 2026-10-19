# ADR-0009 실행 엔진·업무 시스템은 재사용을 우선 평가한다

상태: proposed

## Context
MetaGPT, LangGraph, Microsoft Agent Framework, OpenHands, Odoo, n8n, Temporal이 각각 일부 기능을 제공한다. 모두 대체하려 하면 범위가 폭주한다.

## Decision
- AoT 자체 개발은 [overview §2](../00-overview.md)의 통합 계층으로 한정한다.
- 선택 절차: 동일 시나리오(MVP 주간 사이클의 축소판)로 후보를 시험한 뒤 **하나**를 고른다. 기준: 재시작 복구, 승인 대기·재개, 비용/근거 추출 용이성, 어댑터 뒤에 숨길 수 있는가.
  - 실행 조정: LangGraph vs Microsoft Agent Framework (둘 다 도입 금지).
  - 코드 작업: OpenHands 헤드리스 실행 스파이크.
  - 지속 실행: SQLite 상태 머신 + 폴링 데몬으로 시작, 한계(장기 타이머·대규모 동시성·복잡한 보상 로직)가 확인되면 Temporal 도입.
  - 업무 데이터: Odoo(CRM·회계), n8n(외부 연동)은 연동 우선, 재구현 금지.
- 어떤 후보도 `domain` 모델과 DB 스키마를 소유하지 못한다. 후보는 어댑터/커넥터로만 붙는다.

## Consequences
- 스파이크 결과는 `docs/spikes/`에 기록하고 이 ADR을 갱신한다(미결정 항목은 [open-questions](../open-questions.md)).
