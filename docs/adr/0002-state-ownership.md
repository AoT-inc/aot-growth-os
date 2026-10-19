# ADR-0002 상태는 데몬과 DB가 소유한다

상태: proposed

## Context
대화 세션(Claude Desktop 등)은 종료·압축·교체된다. 조직의 기억과 예약 업무가 세션에 의존하면 유실된다.

## Decision
- 업무 상태, 예약 정보, 승인, 근거, 비용은 모두 DB에 기록한다. 세션 컨텍스트는 상태가 아니다.
- 데몬이 스케줄러와 업무 실행 조정을 소유한다. 재시작 시 DB에서 `running`/`retry_wait` 업무를 복구한다.
- Claude Desktop은 개발·감독 워크벤치이며, 시스템 API/CLI의 클라이언트일 뿐이다.
- 에이전트에게 전달하는 컨텍스트는 DB에서 조립한 업무 명세와 근거 참조로 한정한다.

## Consequences
- 재시작·승인 대기·재시도를 MVP 통과 기준으로 시험할 수 있다.
- 모든 상태 전이는 append-only 이력(`task_transition`)을 남긴다.
