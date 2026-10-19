# Architecture Decision Records

형식: Context / Decision / Consequences. 상태: `proposed` → `accepted` → `superseded`.
모든 ADR은 현재 `proposed`이며, 사람이 검토 후 `accepted`로 바꾼다.

| # | 제목 | 상태 |
|---|---|---|
| [0001](0001-modular-monolith.md) | 모듈형 모놀리스로 시작 | proposed |
| [0002](0002-state-ownership.md) | 상태는 데몬과 DB가 소유한다 | proposed |
| [0003](0003-task-spec-and-state-machine.md) | 업무는 검증 가능한 명세와 상태 머신이다 | proposed |
| [0004](0004-events-routines-idempotency.md) | 이벤트·루틴은 멱등하게 업무로 변환된다 | proposed |
| [0005](0005-agent-adapter-boundary.md) | 에이전트는 어댑터 뒤에 둔다 | proposed |
| [0006](0006-policy-separation.md) | 정책은 에이전트 쓰기 경로 밖에 둔다 | proposed |
| [0007](0007-independent-evaluation.md) | 독립 평가와 안전성 거부권 | proposed |
| [0008](0008-memory-and-strategy.md) | 기억과 전략의 분리 | proposed |
| [0009](0009-build-vs-reuse.md) | 실행 엔진·업무 시스템은 재사용을 우선 평가한다 | proposed |
| [0010](0010-product-registry.md) | 개발 상품 레지스트리와 절차적 등록 | proposed |
| [0011](0011-adaptive-organization.md) | 적응형 조직 구성 (조직 관리팀) | proposed |
