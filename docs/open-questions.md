# 미결정 사항

A0 착수 전에 사람이 정할 항목(Q2·Q5·Q6·Q23·Q25, 라이선스, 확장 단위)의 선택지와 권장안: [A0 결정 초안](plans/a0-decisions.md). 2026-10-19 현재 Q2·Q6·Q23·Q25·라이선스·확장 단위는 결정, Q5는 대기

| # | 질문 | 관련 | 결정 방법 | 기한 |
|---|---|---|---|---|
| Q1 | 상품 등록 절차의 검증 업무 명세(`workflows/product-registration`): 수집 항목, 비밀값 스캔 방식, 공개/내부 분류 기준 | ADR-0010 | **일부 해소**: 템플릿 작성 완료 ([workflows/product-registration.md](../workflows/product-registration.md)). 실제 수행과 템플릿 개정은 Phase A 후속, 스캐너 선택은 Q21 | Phase A 통과 후 |
| Q2 | (해소) 런타임/DB = TypeScript(Node LTS) + SQLite, DDL은 Postgres 이식 가능 범위 | ADR-0001 | 2026-10-19 결정 ([a0-decisions D1](plans/a0-decisions.md)) | 완료 |
| Q3 | 실행 조정: LangGraph vs Microsoft Agent Framework | ADR-0009 | 축소 시나리오 스파이크 | Phase A 후속 (A5 선행 아님) |
| Q4 | 실행 에이전트 = Claude Code CLI(유료 구독 로그인)의 헤드리스 실행 가능성. 2026-10-25 사용자 결정으로 후보가 OpenHands에서 바뀜: 에이전트 실행은 Claude Code로 한정, 구독 사용량 모델(USD 예산 대신 턴·시간·동시성 제한), 호스트 OS 수준 격리. 스파이크 판정 기준에 도구 허용 목록 강제, 개인 설정·스킬 유입 차단, 사용량 한도 오류 구분, 종료 코드·JSON 출력 파싱을 추가. 구독 인증의 자동 실행 허용 범위는 사람이 Anthropic 약관에서 확인(미확인). 2026-10-26 정적 확인 수행([q4](spikes/q4-claude-code-cli.md)): 필요한 옵션은 있으나 `--bare`는 OAuth를 읽지 않아 구독과 양립 불가(격리가 `--restricted`+`--safe-mode` 조합으로 약해짐), `--max-turns` 없음(어댑터가 대체). 판정 (1)~(6)은 사무실 PC 실측 대기 | ADR-0005 Amendment (2026-10-25) | 스파이크 ([phase-a 스파이크 2](plans/phase-a.md), [q4 기록](spikes/q4-claude-code-cli.md) §4 실측 절차) + 약관 확인 | 정적 확인 완료, 실측은 사무실 PC에서 (`claude-code-cli` 어댑터 착수 전) |
| Q5 | (해소) 측정 신호 1개 = 랜딩 페이지 1개의 주간 목표 행동 전환 수. Phase A는 사람이 값을 입력하고 근거(화면·내보내기)를 `evidence`로 첨부하며, 읽기 전용 분석 API 연결은 후속. 실제 제품·페이지는 `instance/`에만 기록 | ADR-0007 | 2026-10-24 결정 ([a0-decisions D2](plans/a0-decisions.md)) | 완료 (정의 형식은 A6-U10 구현, 값 입력·조회는 U13) |
| Q6 | (해소) 위험 변경(외부 부작용·정책 변경) 승인 = 1인 승인 + 대기(기본 1h, 대기 중 취소) + 실행 직전 재인증. 자기 승인은 `min_approvers`가 1일 때만 허용, 2 이상이면 금지. 값은 정책 파라미터(`risky_change`)로 인스턴스에서 변경 가능, 보안 하향 변경은 그 자체가 위험 변경 | ADR-0006 | 2026-10-19 결정 ([a0-decisions D3](plans/a0-decisions.md), ADR-0006 Amendment) | 완료 |
| Q7 | (해소) 정책 표현 = YAML(스키마 검증) + 자체 결정론적 TS 판정기. 정책 버전은 정규화된 내용 해시. 규칙이 복잡해지면 Cedar 이식 검토 | ADR-0006 | 2026-10-19 결정 ([ADR-0013](adr/0013-policy-format.md)) | 완료 |
| Q8 | 기억 검색 구현 (전문 검색 / 벡터) | ADR-0008 | 별도 ADR | memory 패키지 분리 시 |
| Q9 | 고객 데이터·개인정보 분류와 보존 | 스키마 | 별도 문서 | 영업/지원 활성화 전 |
| Q10 | (해소) 레지스트리 진실 원본 = 내부 인스턴스 DB, YAML 시드 없음 | ADR-0010 | 2026-10-14 결정 | 완료 |
| Q11 | 시험 기간 기본값(14일 가정)과 시험 중 영향 범위 제한 방식 | ADR-0011 | 사람 결정 | MVP 설계 확정 전 |
| Q12 | 조직 관리팀과의 대화 채널(Desktop / 내부 웹) 및 대화 내용 중 무엇을 `memory_item`으로 남길지 | ADR-0011, ADR-0008 | 사람 결정 | 조직 관리팀 구현 전 |
| Q13 | 재편 신호의 임계값(예: 반복 실패 N회) | ADR-0011 | 초기 운영 데이터로 보정 | 시험 운영 후 |
| Q14 | (해소, 엔진 구현 완료) 외부 부작용 도구별 멱등 키 지원. 후보 13개를 문서로만 조사: 키 확인 2개(Resend 발송 24시간, Mastodon 게시 1시간), 조회로 전달 확인 7개, 키도 조회도 없어 승인 필수·자동 재시도 금지 4개(SES·SendGrid·Mailgun·Salesforce). 문서에 없으면 `false`. 2026-10-25 사용자 승인: 선언은 (도구, `action`) 단위 `{supported, retention_ms}`, 같은 키 재전송은 보존 기간의 50% 안에서만, 조회형은 `effect_key` 전달 방식을 선언(`none`은 "찾음"만 근거), 공개 게시물에는 키를 싣지 않음. 자연 멱등(upsert)은 인정하지 않고 첫 CRM 쓰기 어댑터 때 재검토. 구현(2026-10-25, 7fc4b02·fc84679): 재전송 창 기준은 `external_effect.planned_at`(경계 50% 포함, 시계 역행은 닫힘), 닫힘 판정은 행에 남김. 실제 어댑터·어댑터 계약 시험(A5)·오류 매핑 적용·`tool_contract_version` 해시는 아직 없음 | recovery | 2026-10-25 문서 조사 ([q14](spikes/q14-idempotency-support.md), 실제 호출 없음) + 결정 ([recovery §3](operations/recovery.md), ADR-0004·0005 Amendment) | 완료 (엔진 구현 2026-10-25. 어댑터 쪽은 첫 부작용 어댑터 때) |
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
| Q26 | (해소) 에이전트 격리 = 컨테이너(Docker, 2026-10-22 사용자 결정). 통신 = stdio 파이프(`docker run -i`, 줄 단위 JSON). 허용 목록 = `--network none` + 바인드 마운트 0개 + 읽기 전용 루트·tmpfs 작업 디렉터리, 외부 접근은 전부 게이트웨이 경유. Docker 전제 = 데몬 호스트에 Docker Engine·CLI, 데몬은 CLI를 `child_process`로 호출(의존성 없음), 없으면 에이전트 업무를 실행하지 않음. Linux 배포 = rootful Docker로 진행(2026-10-22 사용자 결정), `docker` 그룹은 사실상 root 권한이라는 위험을 스파이크 §남은 위험 3·trust-boundaries §3.1에 기록, rootless Docker/Podman은 후속 검토. Linux는 미실측 | trust-boundaries §3.1, ADR-0005 | 2026-10-22 스파이크: macOS Docker Desktop에서 기준 7개 실측 통과, 소켓 마운트(ENOTSUP)·호스트 TCP(호스트 127.0.0.1 도달) 탈락 ([q26](spikes/q26-agent-container-isolation.md)) | 완료 (구현은 A5) |
| Q27 | 검증기·평가기 교체(버전 변경)를 정책 변경 절차에 연결하는 방법: 정책 형식(ADR-0013)에 허용 평가기 버전 고정 키(예: `evaluation.evaluators`)를 두고 `change.ts`가 위험 변경으로 분류할지, 코드 변경(리뷰)만으로 둘지. 정하기 전까지 평가기는 코드 상수이고 모든 평가가 `evaluator`에 `id@version`을 남긴다 | ADR-0007, ADR-0012 §3, ADR-0013 | 사람 결정 (정책 형식 v2 Amendment) | A6 전 |
| Q28 | 전화 provider 선택과 확장: 첫 구현은 Vapi(문서 조사 기준). Retell·Twilio를 같은 `PhonePort`로 더할지, 한국 번호 발신·수신 가능 범위와 비용, 호출 생성 멱등 키 지원 여부(문서에 없어 `supports_idempotency=false`) | ADR-0014 §10 | 실제 계정으로 수동 smoke ([phone-capability 계획](plans/phone-capability.md)) 후 사람 결정 | 실제 통화 도입 전 |
| Q29 | 녹취·통화 고지·동의의 법적 요건(국가별; 한국 적용 여부). 구현은 `phone.recording`(기본 `forbidden`)을 provider 설정에 넘길 뿐 법적 판단을 하지 않는다. 통화 시작 고지 문구와 AI 통화임을 알리는 방식은 provider 쪽 음성 에이전트 설정이다 | ADR-0014 §10, trust-boundaries | 사람(법무) 결정 | 실제 고객 통화 전 |
| Q30 | webhook 노출: 수신 엔드포인트는 외부에 열리는 새 표면이다. 리스너는 설정이 있을 때만 열리고 기본 127.0.0.1에 묶이며(루프백이 아니면 `allow_insecure`로 TLS 종료를 인정해야 시작), 크기·요청 시간 제한이 있다. IP 제한·속도 제한·HMAC 서명 검증은 없다(Vapi는 비밀 헤더만 구현; HMAC은 문서에 계산 방법이 없어 보류). 역방향 프록시/터널, 허용 IP, HMAC 사용 여부 | ADR-0014 §10, trust-boundaries | 배포 결정 | 인바운드 도입 전 |
| Q31 | 수신거부(DNC)·연락처 관리와 고객 식별: 지금은 정책의 `denied_numbers`뿐이다. 연락처의 동의 상태, 인바운드 발신자 식별(CRM 조회)은 개인정보 분류(Q9)와 함께 정한다 | ADR-0014 §10, Q9 | 별도 문서 | 영업/지원 활성화 전 |
| Q32 | 두 번째 대화 채널(이메일 등)을 만들 때 `conversation` 계층으로 승격할 범위: 통화 테이블·이벤트 이름(`phone.call.*`)·검사 id(`call_*`)를 일반화할지, 패키지를 분리할지(ADR-0001 "필요가 생길 때 분리") | ADR-0014 §0 | 이메일 채널 설계 때 결정 | 두 번째 채널 착수 시 |
