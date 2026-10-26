# 용어집

코드, 스키마, 문서에서 아래 용어를 정의된 의미로만 사용한다.

| 용어 | English / 식별자 | 정의 | 혼동 주의 |
|---|---|---|---|
| 조직 단위 | `org_unit` | 부서 등 책임 단위. 트리 구조, 버전 관리 | 에이전트 인스턴스가 아님 |
| 조직 관리팀 | `org-management` | 사용자와 대화하며 업무·평가 신호를 근거로 조직 변경안을 제안하는 역할. 직접 적용 불가 | 인사팀이 아님. 권한 부여 주체가 아님 |
| 조직 제안 | `org_proposal` | 조직 변경 diff·근거·위험·시험 범위를 담은 객체 | |
| 조직 버전 | `org_version` | 확정된 조직 구성의 스냅샷. 업무가 생성 시점 버전을 기록 | |
| 시험 기간 | `trial` | 승인된 조직 변경이 제한 범위·기간에서 검증되는 단계(기본 최소 14일) | |
| 고정 코어 | fixed core | 검증기·평가기·정책·승인 엔진·비용 원장. 조직 관리팀이 수정 불가 | |
| 역할 | `role` | org_unit 안의 책임·권한 묶음. 에이전트나 사람이 맡음 | 사람/에이전트와 분리된 개념 |
| 행위자 | `actor` | 역할을 수행하는 사람 또는 에이전트 | |
| 상품 | `product` | 기업이 개발·운영하는 제품. 1급 객체. 절차를 거쳐 `registered`된 것만 업무가 참조 | 외부 판매 상품만이 아니라 내부 개발 제품 포함 |
| 개발 상품 | development product | `lifecycle_stage`가 개발 중인 상품 | |
| 이벤트 | `event` | 외부/내부에서 발생한 사실(문의 접수, 장애, 예산 초과). 불변 | 업무가 아님 |
| 루틴 | `routine` | 시간 기반 반복 규칙. 업무 생성 규칙의 하나 | 업무 인스턴스가 아님 |
| 트리거 | `trigger` | 업무를 만든 원인(이벤트 또는 루틴 실행) | |
| 업무 | `task` | 검증 가능한 명세를 가진 영속 객체. 상태 머신을 따름 | 프롬프트가 아님 |
| 업무 명세 | `task_spec` | objective, acceptance_criteria, validation 등을 포함한 구조체 | |
| 실행 | `task_run` | 업무 1회 시도. 재시도마다 새 run | 업무와 1:N |
| 에이전트 어댑터 | `agent_adapter` | 특정 에이전트 제품을 감싸 공통 입출력으로 변환하는 경계 | |
| 근거 | `evidence` | 결과를 뒷받침하는 출처·로그·테스트 결과 등 | 에이전트의 자기 주장은 근거가 아님 |
| 검증 | validation | 완료 조건(acceptance_criteria) 충족 여부를 시스템이 판정 | 평가와 구분 |
| 평가 | evaluation | 검증된 결과의 품질·효과·경제성·안전성 판단 | 검증 통과 ≠ 좋은 결과 |
| 안전성 거부권 | safety veto | 안전성 실패 시 다른 점수와 무관하게 실패 처리 | 가중 합산 금지 |
| 정책 | `policy` | 권한·승인·예산·공개 범위 규칙. 버전 관리, 에이전트 쓰기 불가 | 전략이 아님 |
| 전략 | `strategy` | 의사결정 방향. 버전과 근거를 가짐. 시스템이 변경 제안 가능 | 정책과 같은 방식으로 수정 금지 |
| 기억 | `memory_item` | 출처·유효성을 가진 기업 지식 | 대화 로그가 아님 |
| 기억 종류 | `memory_kind` | fact / commitment / measurement / hypothesis / strategy_record / lesson | |
| 승인 | `approval` | 사람이 특정 대상(업무·전략·게시)에 내린 판단 기록 | |
| 비용 원장 | `cost_entry` | 업무/실행 단위로 쌓이는 비용 기록 | |
| 게시 | `publication` | 외부 공개 행위와 그 공개 범위 | 내부 작업과 분리 |
| 외부 대화 | `conversation` | 에이전트가 외부 사람과 나누는 대화. 전화·이메일·채팅의 상위 개념이고 채널(phone 등) 아래에 있다. 공개 게시(`publication`)는 대화가 아니다 | 채널 중립 부분(발화 기록·결과)만 먼저 분리했다 ([ADR-0014](adr/0014-phone-capability.md) §0) |
| 통화 | `call` | 전화 통화 하나. 업무 실행 중 일어난 외부 상호작용. AoT canonical 상태(queued … completed/failed/cancelled/transferred)를 가진다 | 업무(`task`)가 아님. 업무 1 : 통화 N |
| 전화 포트 | `PhonePort` | 전화 provider(Vapi 등)가 구현하는 계약. 어댑터가 webhook·상태를 canonical 이벤트로 바꾼다 | 에이전트 어댑터(`agent_adapter`)와 다르다 |
| 발화 기록 | `transcript` | 통화 내용을 화자별 턴(agent/customer/system)으로 정규화한 산출물. 상대방의 말은 신뢰할 수 없는 데이터다 | provider 원본 transcript 가 아님(저장하지 않는다) |
| 통화 결과 | `call_outcome` | 통화 뒤 남는 구조화 결과(disposition·summary·structured_data·next_action). 필수 필드는 업무 명세가 정한다 | 에이전트의 자기 보고가 아니다 |
| 워크벤치 | workbench | Claude Desktop 등 개발·감독 도구. 상태를 소유하지 않음 | 운영 주체가 아님 |

## 상태 용어

`queued` → `running` → `validating` → `completed` (기본 경로). 보조 상태: `unassigned`(배정 가능한 역할 없음 = 조직 재편 신호), `needs_review`, `retry_wait`, `failed`, `cancelled`. 전이 규칙은 [schema/state-machines.md](schema/state-machines.md).

## 금지 용법

- "에이전트가 완료했다" 대신 "검증을 통과해 `completed`가 되었다".
- "전략을 수정한다"와 "정책을 수정한다"를 혼용하지 않는다.
- "기억"을 대화 이력의 동의어로 쓰지 않는다.
