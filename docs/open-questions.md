# 미결정 사항

A0 착수 전에 사람이 정할 항목(Q2·Q5·Q6·Q23·Q25, 라이선스, 확장 단위)의 선택지와 권장안: [A0 결정 초안](plans/a0-decisions.md). 2026-10-19 현재 Q2·Q6·Q23·Q25·라이선스·확장 단위는 결정, Q5는 대기

| # | 질문 | 관련 | 결정 방법 | 기한 |
|---|---|---|---|---|
| Q1 | 상품 등록 절차의 검증 업무 명세(`workflows/product-registration`): 수집 항목, 비밀값 스캔 방식, 공개/내부 분류 기준 | ADR-0010 | **일부 해소**: 템플릿 작성 완료 ([workflows/product-registration.md](../workflows/product-registration.md)). 실제 수행과 템플릿 개정은 Phase A 후속, 스캐너 선택은 Q21 | Phase A 통과 후 |
| Q2 | (해소) 런타임/DB = TypeScript(Node LTS) + SQLite, DDL은 Postgres 이식 가능 범위 | ADR-0001 | 2026-10-19 결정 ([a0-decisions D1](plans/a0-decisions.md)) | 완료 |
| Q3 | 실행 조정: LangGraph vs Microsoft Agent Framework | ADR-0009 | 축소 시나리오 스파이크 | Phase A 후속 (A5 선행 아님) |
| Q4 | OpenHands 헤드리스 실행 가능성 | ADR-0005 | 스파이크 | Phase A 후속 (코드 작업 어댑터 착수 전) |
| Q5 | MVP의 "측정 신호 1개"는 무엇인가 (어느 제품의 어느 지표) | ADR-0007 | 사람 결정 | MVP 설계 확정 전 |
| Q6 | (해소) 위험 변경(외부 부작용·정책 변경) 승인 = 1인 승인 + 대기(기본 1h, 대기 중 취소) + 실행 직전 재인증. 자기 승인은 `min_approvers`가 1일 때만 허용, 2 이상이면 금지. 값은 정책 파라미터(`risky_change`)로 인스턴스에서 변경 가능, 보안 하향 변경은 그 자체가 위험 변경 | ADR-0006 | 2026-10-19 결정 ([a0-decisions D3](plans/a0-decisions.md), ADR-0006 Amendment) | 완료 |
| Q7 | (해소) 정책 표현 = YAML(스키마 검증) + 자체 결정론적 TS 판정기. 정책 버전은 정규화된 내용 해시. 규칙이 복잡해지면 Cedar 이식 검토 | ADR-0006 | 2026-10-19 결정 ([ADR-0013](adr/0013-policy-format.md)) | 완료 |
| Q8 | 기억 검색 구현 (전문 검색 / 벡터) | ADR-0008 | 별도 ADR | memory 패키지 분리 시 |
| Q9 | 고객 데이터·개인정보 분류와 보존 | 스키마 | 별도 문서 | 영업/지원 활성화 전 |
| Q10 | (해소) 레지스트리 진실 원본 = 내부 인스턴스 DB, YAML 시드 없음 | ADR-0010 | 2026-10-14 결정 | 완료 |
| Q11 | 시험 기간 기본값(14일 가정)과 시험 중 영향 범위 제한 방식 | ADR-0011 | 사람 결정 | MVP 설계 확정 전 |
| Q12 | 조직 관리팀과의 대화 채널(Desktop / 내부 웹) 및 대화 내용 중 무엇을 `memory_item`으로 남길지 | ADR-0011, ADR-0008 | 사람 결정 | 조직 관리팀 구현 전 |
| Q13 | 재편 신호의 임계값(예: 반복 실패 N회) | ADR-0011 | 초기 운영 데이터로 보정 | 시험 운영 후 |
| Q14 | 외부 부작용 도구별 멱등 키 지원 여부 조사 (이메일 발송, 게시, CRM 쓰기) | recovery | 도구 어댑터 도입 시 조사 | 어댑터 착수 전 |
| Q15 | (해소) lease 90초, heartbeat 30초, 데몬 폴링 5초. 복구 지연 목표 120초(2026-10-19 사람 확인) | recovery | 2026-10-19 스파이크: 쓰기 경합 실측 + 가짜 시계 모의에서 오탐 인수 0 ([q15](spikes/q15-lease-parameters.md)) | 완료 |
| Q16 | 시험 연장 상한 횟수와 `inconclusive` 재시험 정책. (2026-10-21 일부 결정: 조직 제안의 `inconclusive`는 재시험 승인 전까지 종료로 취급하고 별도 상태는 추가하지 않는다. 연장 상한 횟수와 재시험 조건은 미결정) | ADR-0011, ADR-0007 | 사람 결정 | Phase B 전 |
| Q17 | 변동성 높은 기억 종류의 기본 `valid_until` | memory-item | 정책 파라미터 | memory 구현 전 |
| Q18 | `ProductDecision`을 `strategy_version` 하위로 둘지 분리할지 | product | 별도 검토 | Release/Capability 도입 시 |
| Q19 | (해소) 모듈 경계 lint = dependency-cruiser 18.6.0 (의존 방향·공개 API 전용 참조·순환·팩 경계를 한 설정으로 표현) | ADR-0001, phase-a | 2026-10-19 스파이크: 가상 위반 10건 전부 검출 ([q19](spikes/q19-boundary-lint.md)) | 완료 (설정 반영은 A0) |
| Q20 | (해소) 테스트 러너 = `node:test` (Node 24 내장). 다중 프로세스 동시 쓰기·SIGKILL 후 인수·가짜 타이머 시험 통과, Vitest 5.0.5는 대안 | phase-a | 2026-10-19 스파이크: 복구·중복 방지 시나리오 실행 ([q20](spikes/q20-test-runner.md)) | 완료 (설정 반영은 A0) |
| Q21 | (해소) 비밀값 스캐너 = gitleaks 8.30.1 (`--redact`, 작업 트리·이력, 업무·CI 공용). 접속 URL 비밀번호·금지어는 사용자 규칙으로 보완 | workflows/product-registration, public-repository | 2026-10-19 스파이크: 4개 후보 비교 ([q21](spikes/q21-secret-scanner.md)) | 완료 (CI 설치 방법은 A0) |
| Q22 | 검증 단계 LLM 모델 등급과 검증 비용 비율 (실행 에이전트와 다른 호출·가능하면 다른 모델) | evaluation, workflows/product-registration | 등록 검증·주간 조사에서 비용 대비 검출력 비교 | A5 (실제 검증 모델을 연결하기 전). A4에서는 `LlmVerifier` 포트와 가짜 구현만 있다 |
| Q23 | (해소) Phase A 시드 조직 = 오너 1 + `generalist` 1 + 읽기 전용 `registration-verifier` 1 + 정책 v1(기본 거부) | workflows/product-registration, ADR-0011 | 2026-10-19 결정 ([a0-decisions D4](plans/a0-decisions.md), ADR-0011 Amendment) | 완료 |
| Q24 | (해소) 접근 계층 = `node:sqlite` + 얇은 `Db` 인터페이스(대체: better-sqlite3), 마이그레이션 = 순수 SQL 파일 + 자체 러너. Postgres 이식은 미시험 | ADR-0001, phase-a | 2026-10-19 스파이크: lease 획득 경쟁·`schema.sql` 적용 ([q24](spikes/q24-sqlite-access-migration.md)) | 완료 (설정 반영은 A0) |
| Q25 | (해소) 승인 채널 = Unix 도메인 소켓 + 피어 자격 증명(UID) 확인, 위험 변경 재인증 = TOTP(RFC 6238, `node:crypto` 자체 구현, 비밀은 `instance/`에만). 피어 UID를 확인할 수 없으면 소켓 파일 권한으로 대신하고 편차로 기록 | trust-boundaries §3.1 | 2026-10-19 결정 ([a0-decisions D5](plans/a0-decisions.md)) | 완료 |
| Q26 | 에이전트 격리 방식과 게이트웨이 통신 방식. **일부 결정(2026-10-22, 사용자): 격리 방식 = 컨테이너(Docker)**. 남은 것: 게이트웨이 통신 방식(소켓 마운트 등), 파일시스템·네트워크 허용 목록 강제 방법, 데몬 실행 환경의 Docker 전제 | trust-boundaries §3.1, ADR-0005 | 스파이크 (격리 방식은 결정, 통신·허용 목록은 A5 초반 스파이크) | A5 착수 전 |
| Q27 | 검증기·평가기 교체(버전 변경)를 정책 변경 절차에 연결하는 방법: 정책 형식(ADR-0013)에 허용 평가기 버전 고정 키(예: `evaluation.evaluators`)를 두고 `change.ts`가 위험 변경으로 분류할지, 코드 변경(리뷰)만으로 둘지. 정하기 전까지 평가기는 코드 상수이고 모든 평가가 `evaluator`에 `id@version`을 남긴다 | ADR-0007, ADR-0012 §3, ADR-0013 | 사람 결정 (정책 형식 v2 Amendment) | A6 전 |
