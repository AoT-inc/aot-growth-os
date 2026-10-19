# ADR-0004 이벤트·루틴은 멱등하게 업무로 변환된다

상태: proposed

## Context
이벤트는 중복 전달되고 루틴은 데몬 재시작 중 중복 발화할 수 있다. 같은 업무가 반복 생성되면 비용과 외부 부작용이 중복된다.

## Decision
- 업무 생성 입구는 하나(업무 생성 엔진)이며 루틴과 이벤트 모두 거친다.
- `event.idempotency_key`는 `(source, external_id)` 또는 내용 해시로 만들고 unique 제약을 둔다.
- 루틴 발화는 `routine_firing(routine_id, scheduled_for)` unique 제약으로 한 번만 기록한다. 놓친 발화는 정책(`catch_up: skip|run_once`)에 따른다.
- `task.dedupe_key`로 동일 트리거·동일 입력의 활성 업무 중복 생성을 막는다.
- 실패 시 상태를 보존하고 `retry_wait`로 간다. 재시도는 새 `task_run`을 만들며 업무는 같다.
- 외부 부작용이 있는 도구 호출은 호출별 idempotency token을 사용한다.

## Consequences
- 스키마 첫 버전에 키/제약을 포함해야 한다(후행 추가가 어려움).

## Amendment (2026-10-14): 실행 소유권과 부작용 멱등성
생성 멱등성만으로는 중복 부작용을 막지 못한다. 세 수준을 구분한다: 업무 생성 / 실행 소유권(lease) / 외부 부작용.
- `task_run`에 `lease_owner`, `lease_expires_at`, `heartbeat_at`, `checkpoint`를 둔다. 업무당 활성 run은 하나.
- 외부 부작용은 `external_effect`(`effect_key` UNIQUE)로 기록한다. 외부 시스템이 멱등 키를 지원하지 않고 결과가 `unknown`이면 자동 재시도하지 않고 외부 상태를 조회하거나 `needs_review`로 보낸다.
- 상세와 복구 시나리오는 [operations/recovery.md](../operations/recovery.md).
