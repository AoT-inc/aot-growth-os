# ADR-0001 모듈형 모놀리스로 시작

상태: proposed

## Context
웹, 데몬, 도메인 모델, 실행 엔진을 동시에 설계해야 하지만 운영 모델이 아직 검증되지 않았다. 마이크로서비스는 경계가 틀렸을 때 비용이 크다.

## Decision
- 단일 저장소, 단일 배포 단위(웹 + 데몬은 같은 코드베이스의 다른 엔트리포인트)로 시작한다.
- 모듈 경계는 `packages/`로 명시하고, 의존 방향은 `domain ← task-engine/policy/evaluation ← agent-runtime ← apps` 단방향으로 강제한다(lint 규칙).
- MVP 패키지는 5개: `domain`, `task-engine`(스케줄러 포함), `policy`, `agent-runtime`, `evaluation`(경제성은 `cost_entry` 테이블로 시작).
- `memory`, `economics`, `publication`은 MVP에서 실제 필요가 생길 때 분리한다.
- 언어/런타임 기본값: TypeScript. 저장소는 SQLite로 시작하되 DDL은 Postgres 이식 가능한 범위로 작성한다.

## Consequences
- 초기 속도와 리팩터링 용이성 확보. 모듈 경계 위반은 CI에서 잡아야 한다.
- 외부 서비스 분리 시 패키지 단위로 추출한다.
