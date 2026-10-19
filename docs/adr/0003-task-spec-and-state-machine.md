# ADR-0003 업무는 검증 가능한 명세와 상태 머신이다

상태: proposed

## Context
자유 프롬프트로 지시한 업무는 완료 여부를 판정할 수 없고, 재현·감사가 어렵다.

## Decision
- 모든 업무는 [task-spec](../schema/task-spec.md)의 필수 필드를 가진다. `acceptance_criteria`와 `validation`이 비어 있으면 생성 거부.
- 기본 경로 `queued → running → validating → completed`; 보조 상태 `unassigned`(맞는 역할 없음, [ADR-0011](0011-adaptive-organization.md)), `needs_review`, `retry_wait`, `failed`, `cancelled`.
- `completed`로의 전이는 **오직 검증기(validator)** 만 일으킬 수 있다. 에이전트의 자기 보고는 `validating` 진입 조건일 뿐이다.
- 전이는 [state-machines.md](../schema/state-machines.md)의 허용표로 제한하고, 모든 전이를 `task_transition`에 남긴다.
- 업무에는 `product_id`(선택)를 연결해 어떤 상품에 대한 작업인지 추적한다.

## Consequences
- 명세 작성 비용이 늘지만 검증·감사·재시도가 가능해진다.
- 명세 템플릿은 `workflows/`에서 버전 관리한다.

## Amendment (2026-10-14): 버전·승인 스냅샷
- 업무는 생성 시점의 `org_version`, `role_version`, `task_spec_version`, `strategy_version`, `policy_version`, `tool_contract_version`과 승인된 입력·실행 인자 스냅샷(해시)을 기록한다.
- 실행 직전과 부작용 직전에 재검증한다. 현재 정책이 더 엄격하면 새 정책을 적용하고, 실행 인자가 승인 스냅샷과 다르면 차단하여 재승인을 요청한다. 상세는 [task-spec](../schema/task-spec.md).
- 금지된 전이를 [state-machines](../schema/state-machines.md)에 명시한다.
