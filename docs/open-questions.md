# 미결정 사항

| # | 질문 | 관련 | 결정 방법 | 기한 |
|---|---|---|---|---|
| Q1 | 상품 등록 절차의 검증 업무 명세(`workflows/product-registration`): 수집 항목, 비밀값 스캔 방식, 공개/내부 분류 기준 | ADR-0010 | **일부 해소**: 템플릿 작성 완료 ([workflows/product-registration.md](../workflows/product-registration.md)). 실제 수행과 템플릿 개정은 Phase A 후속, 스캐너 선택은 Q21 | Phase A 통과 후 |
| Q2 | 런타임/DB 최종 확정 (TypeScript + SQLite로 가정) | ADR-0001 | 기존 제품 스택과의 정합성 확인 | 코드 착수 전 |
| Q3 | 실행 조정: LangGraph vs Microsoft Agent Framework | ADR-0009 | 축소 시나리오 스파이크 | MVP 구현 중 |
| Q4 | OpenHands 헤드리스 실행 가능성 | ADR-0005 | 스파이크 | 에이전트 어댑터 착수 전 |
| Q5 | MVP의 "측정 신호 1개"는 무엇인가 (어느 제품의 어느 지표) | ADR-0007 | 사람 결정 | MVP 설계 확정 전 |
| Q6 | 위험 변경 승인자 구성 (1인 회사라면 2인 승인 불가 → 대안: 지연 대기 + 별도 채널 확인) | ADR-0006 | 사람 결정 | 정책 초안 전 |
| Q7 | 정책 표현 방식 (YAML + 코드 평가 vs OPA/Cedar 등) | ADR-0006 | 별도 ADR | 정책 패키지 착수 전 |
| Q8 | 기억 검색 구현 (전문 검색 / 벡터) | ADR-0008 | 별도 ADR | memory 패키지 분리 시 |
| Q9 | 고객 데이터·개인정보 분류와 보존 | 스키마 | 별도 문서 | 영업/지원 활성화 전 |
| Q10 | (해소) 레지스트리 진실 원본 = 내부 인스턴스 DB, YAML 시드 없음 | ADR-0010 | 2026-10-14 결정 | 완료 |
| Q11 | 시험 기간 기본값(14일 가정)과 시험 중 영향 범위 제한 방식 | ADR-0011 | 사람 결정 | MVP 설계 확정 전 |
| Q12 | 조직 관리팀과의 대화 채널(Desktop / 내부 웹) 및 대화 내용 중 무엇을 `memory_item`으로 남길지 | ADR-0011, ADR-0008 | 사람 결정 | 조직 관리팀 구현 전 |
| Q13 | 재편 신호의 임계값(예: 반복 실패 N회) | ADR-0011 | 초기 운영 데이터로 보정 | 시험 운영 후 |
| Q14 | 외부 부작용 도구별 멱등 키 지원 여부 조사 (이메일 발송, 게시, CRM 쓰기) | recovery | 도구 어댑터 도입 시 조사 | 어댑터 착수 전 |
| Q15 | lease 기본 만료 시간과 heartbeat 주기 | recovery | 스파이크 | Phase A 구현 중 |
| Q16 | 시험 연장 상한 횟수와 `inconclusive` 재시험 정책 | ADR-0011 | 사람 결정 | Phase B 전 |
| Q17 | 변동성 높은 기억 종류의 기본 `valid_until` | memory-item | 정책 파라미터 | memory 구현 전 |
| Q18 | `ProductDecision`을 `strategy_version` 하위로 둘지 분리할지 | product | 별도 검토 | Release/Capability 도입 시 |
| Q19 | 모듈 경계 lint 도구 선택 (의존 방향 단방향 강제, ADR-0001) | ADR-0001, phase-a | 후보를 가상 위반 사례로 시험 | 저장소 부트스트랩(A0) |
| Q20 | 테스트 러너 선택 (프로세스 종료·다중 워커 시나리오, 시간 제어 지원) | phase-a | 복구·중복 방지 테스트를 작성할 수 있는지로 판단 | 저장소 부트스트랩(A0) |
| Q21 | 비밀값 스캐너 선택 (작업 트리·이력 스캔, 값 원문을 출력하지 않는 모드, 등록 검증 업무와 CI 공용 여부) | workflows/product-registration, public-repository | 가상 비밀값이 심긴 샘플로 탐지율·오탐·출력 안전성 비교 | 저장소 부트스트랩(A0), 등록 검증 수행 전 |
| Q22 | 검증 단계 LLM 모델 등급과 검증 비용 비율 (실행 에이전트와 다른 호출·가능하면 다른 모델) | evaluation, workflows/product-registration | 등록 검증·주간 조사에서 비용 대비 검출력 비교 | A4 평가기 구현 중 |
| Q23 | 등록 검증 업무를 맡을 부서·역할을 Phase A 시드 조직에 둘지 (둘 수 없으면 `unassigned`로 생성) | workflows/product-registration, ADR-0011 | 사람 결정 | 시드 조직 확정 전 |
| Q24 | SQLite 접근 계층과 마이그레이션 도구 선택 (Postgres 이식성, 트랜잭션·유일 인덱스 활용) | ADR-0001, phase-a | 후보를 lease 획득 트랜잭션 시나리오로 시험 | 저장소 부트스트랩(A0) |
