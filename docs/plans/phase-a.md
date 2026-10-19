# Phase A 구현 계획

[overview §6](../00-overview.md)의 Phase A(실행 기반 검증, 고정된 최소 조직)를 구현하는 순서와 완료 기준. 코드는 아직 없으며, 이 문서는 착수 전 계획이다. 결정되지 않은 선택은 [open-questions](../open-questions.md)로 연결한다.

## 1. 원칙

- 패키지는 5개(`domain`, `task-engine`, `policy`, `agent-runtime`, `evaluation`)이며 의존 방향은 `domain ← task-engine/policy/evaluation ← agent-runtime ← apps` 단방향이다 ([ADR-0001](../adr/0001-modular-monolith.md)).
- 각 단계는 **그 단계의 필수 테스트가 통과해야** 끝난다. 다음 단계는 앞 단계 통과 후에 시작한다.
- 실제 에이전트 제품에 의존하지 않는다. 단계 A5 전까지는 결정적으로 동작하는 가짜 어댑터와 가짜 외부 도구로 검증한다.
- 테스트 데이터는 가상 값(`example-product` 등)만 쓴다 ([공개 저장소 규칙](../security/public-repository.md)).
- Phase B 항목(조직 관리팀, `org_proposal`, 시험 운영)은 범위 밖이다.

## 2. 구현 순서

| 단계 | 패키지 | 내용 | 선행 |
|---|---|---|---|
| A0 | (저장소) | §4 부트스트랩 체크리스트 | 없음 |
| A1 | `domain` | 엔터티 타입, 상태 전이 허용표, `task_spec` 스키마 검증, 마이그레이션(스키마 DDL 적용), 시드 데이터(조직·역할·`actor`·초기 `policy_version` — `task.policy_version_id`가 NOT NULL이므로 업무 생성 전에 필요), `memory_item` 신뢰·만료 규칙 | A0, [Q23](../open-questions.md)(시드 조직의 등록 검증 역할) |
| A2 | `task-engine` | 업무 생성(멱등), 스케줄러·폴링 데몬, `task_run` lease와 heartbeat, `external_effect` 상태 머신, 데몬 재시작 복구. 스파이크 Q15(lease 파라미터)는 lease 구현 직후 수행하며 결과 기록이 A2 완료 조건에 포함된다 | A1 |
| A3 | `policy` | 7요소 판정과 `policy_decision` 기록, 정책 버전, 승인 엔진(`approved_hash`), 사람 승인 채널([trust-boundaries §3.1](../security/trust-boundaries.md)), 실행 시점 재검증, 게시 게이트 | A1, A2의 전이 훅, [Q6](../open-questions.md)(승인자 구성), [Q7](../open-questions.md)(정책 표현), [Q25](../open-questions.md)(승인 채널 인증) |
| A4 | `evaluation` | 결정론적 검증기, 컨텍스트 분리 LLM 검증 인터페이스, 평가기(원본 증거 우선, `pass`/`fail`/`inconclusive`), 비용 원장(`cost_entry`) 집계 | A1, A2, A3 |
| A5 | `agent-runtime` | 어댑터 계약(입력=`task_spec`+허용 도구+근거+예산, 출력=`result`+`evidence`+`run_log`+`cost`, 실행 중 `cost_progress` 보고 — [ADR-0005](../adr/0005-agent-adapter-boundary.md) Amendment), 도구 게이트웨이와 게이트웨이 계약 테스트, 샌드박스·OS 수준 분리 검증([trust-boundaries §3.1](../security/trust-boundaries.md)), 어댑터 계약 테스트, 가짜 어댑터 → 실제 어댑터 1개(읽기 전용 조사 에이전트) | A2~A4, 스파이크 Q14, [Q26](../open-questions.md)(에이전트 격리 방식) |
| A6 | `apps/daemon` 통합 | 주간 사이클 1~7단계를 가짜·실제 어댑터로 끝까지 실행하고 §3의 모든 항목을 통합 시나리오로 재확인 | A5, [Q5](../open-questions.md)(측정 신호) |

의존 근거: `policy`는 `task-engine`의 `queued → running` 전이에서 호출되므로 전이 훅 인터페이스만 A2에서 먼저 정의한다. `evaluation`의 비용 집계는 `task_run`이 있어야 하므로 A2 뒤에 둔다.

스파이크 Q3(오케스트레이션)·Q4(헤드리스 코드 에이전트)는 A5의 선행 조건이 아니다. Phase A의 실제 어댑터는 읽기 전용 조사 에이전트 1개이고 실행 조정은 자체 상태 머신으로 충분하므로, 두 스파이크는 Phase A 후속으로 둔다(§5).

## 3. 필수 테스트 매핑

[overview §6 필수 테스트 표](../00-overview.md) 중 Phase A 항목. "주 패키지"는 테스트를 소유하는 곳이고, A6에서 통합 시나리오로 한 번 더 확인한다.

| 영역 | 필수 테스트 | 주 패키지 | 단계 | 완료 기준 |
|---|---|---|---|---|
| 데몬 복구 | 업무 실행 중 프로세스 종료 후 상태 복구 | `task-engine` | A2 | `running` 중 프로세스를 강제 종료 후 재시작하면 lease 만료를 거쳐 새 attempt로 이어지고 중복 실행이 없다. `dispatched`/`unknown` 부작용이 있으면 재전송 없이 [recovery §3](../operations/recovery.md) 규칙대로 처리 |
| 중복 방지 | 동일 이벤트 N회 전달 시 업무 1건·부작용 1건, 동시 워커 중 하나만 실행 | `task-engine` | A2 | 같은 `idempotency_key` N회 → `task` 1건, 외부 부작용 1건. 워커 두 개가 같은 `queued` 업무를 잡아도 하나만 성공. 멱등 키 미지원 도구의 `unknown`은 자동 재전송되지 않고 `needs_review`. lease를 잃은 워커는 부작용을 보내지 않는다 |
| 승인 | 승인된 내용과 실행 인자가 다르면 실행 차단 | `policy` | A3 | `approved_hash` 불일치 시 `running` 진입이 막히고 `needs_review`(재승인)로 간다. 승인(`approval`)은 `actor.kind='human'`만 기록 가능. 에이전트 프로세스가 사람 승인 채널로 승인을 시도하면 인증 단계에서 실패한다 ([trust-boundaries §3.1](../security/trust-boundaries.md)) |
| 권한(정책) | 역할 생성·라우팅 변경만으로 권한 확대 불가 (Phase A는 정책 측만) | `policy` / `agent-runtime` | A3 (판정) + A5 (게이트웨이·OS 수준) | A3: 역할/라우팅 데이터를 바꿔도 같은 요청 7요소의 `policy_decision`이 allow로 바뀌지 않는다. A5: 에이전트 프로세스가 도구 게이트웨이를 거치지 않고 정책 저장소·상태 전이 API·DB 파일에 접근할 수 없다(OS 수준 분리). 역할 생성 경로는 Phase B 소관이므로 B에서 재확인 |
| 정책 변경 | 실행 전에 정책이 강화되면 재검증 | `policy` | A3 | 승인 후 정책 버전을 강화하면 실행 직전 새 정책으로 재판정되어 거부된다. 과거 승인이 더 엄격해진 정책을 무효화하지 못한다 |
| 평가 독립성 | 실행 에이전트 보고서만으로 성과 확정 불가 | `evaluation` | A4 | 보고서만 있는 입력은 `pass`가 나오지 않는다. 관측 수 부족은 `inconclusive`. `safety='fail'`이면 효과 점수와 무관하게 `fail`. `inconclusive`가 성공 사례로 기록되지 않는다 |
| 비용 | 모델 호출·도구 사용 비용을 업무·실행별로 집계 | `evaluation` | A4 (기록은 A5) | 가짜 어댑터가 보고한 비용이 `task`·`task_run` 단위로 합산된다. 실행 중 `cost_progress`(또는 게이트웨이 호출별 계량)로 누적 비용을 기록하고, 예산을 넘으면 종료를 기다리지 않고 실행을 취소한다 ([ADR-0005](../adr/0005-agent-adapter-boundary.md) Amendment, [ADR-0007](../adr/0007-independent-evaluation.md)) |
| 외부 게시 | 승인 없는 콘텐츠와 내부 전용 데이터의 공개 차단 | `policy` / `agent-runtime` | A3 (판정) + A5 (게이트웨이·OS 수준) | A3: 승인 없는 `public`/`customer` 게시 요청은 거부. `sensitivity`가 내부 이상인 데이터를 `public` 대상에 쓰려는 호출은 거부. A5: 에이전트가 게이트웨이를 우회해 외부로 직접 게시할 경로(허용 목록 밖 네트워크 등)가 없다 ([trust-boundaries §3.1·§6](../security/trust-boundaries.md)) |
| 기억 | 반증·만료 정보를 현재 사실로 취급하지 않음, 외부 입력 지시문 무효 | `domain` / `agent-runtime` | A1 (신뢰·만료) + A5 (지시문) | A1: 현재 사실 조회에서 `refuted`/만료 항목이 제외되고, 외부 입력 유래 항목은 `hypothesis`/`unverified`로만 들어간다 ([memory-item](../schema/memory-item.md)). A5: 외부 입력에 지시문을 넣은 주입 시나리오에서 도구 호출·권한이 바뀌지 않는다. `memory` 패키지는 분리하지 않는다 |

추가로 A5에서 어댑터 계약 테스트(모든 어댑터가 동일 계약을 만족)와 도구 게이트웨이 계약 테스트(허용 도구 외 호출 거부, 호출별 정책 판정·비용 계량 기록)를 통과해야 하며, 이는 표의 항목은 아니지만 A6의 선행 조건이다.

## 4. 저장소 부트스트랩 체크리스트 (A0)

선택이 필요한 항목은 open-questions를 가리킨다. 선택 전에는 가정만 적고 코드를 시작하지 않는다. 사람이 정할 항목의 선택지와 권장안은 [A0 결정 초안](a0-decisions.md)에 있다.

- [x] 런타임과 DB 확정: TypeScript(Node LTS), SQLite (DDL은 Postgres 이식 가능 범위) — [Q2](../open-questions.md) 해소 (2026-10-19)
- [x] 패키지 구조: `packages/` 아래 5개 패키지와 `apps/daemon` 엔트리포인트의 빈 골격, 패키지별 공개 API 진입점 하나
- [x] `packs/` 골격: 첫 팩 `packs/example-marketing`(manifest, `workflows/`, `routines/`, `evaluations/`)의 빈 골격 ([ADR-0012](../adr/0012-extension-unit-contract.md))
- [x] 팩 경계 lint: 팩은 코어 내부 모듈(`packages/*`의 공개 API 밖)을 참조하지 않는다. 위반이 CI에서 실패 — [Q19](../open-questions.md)
- [x] 모듈 경계 lint: 의존 방향 위반(`domain`이 상위를 참조, `agent-runtime`이 `domain` 외 하위 내부 모듈을 직접 참조 등)이 CI에서 실패 — [Q19](../open-questions.md). `npm run lint:boundaries`, 규칙은 `test/boundaries`가 위반 주입으로 고정 시험(워크스페이스 `exports` 해석 누락도 잡는다). `task-engine`/`policy`/`evaluation` 상호 참조는 막아 두었고 A1 이후 필요 시 조정
- [x] 테스트 러너: 단위·통합 구분, SQLite 인메모리 또는 임시 파일 격리, 프로세스 종료 시나리오를 실행할 수 있을 것. 동시 워커 테스트는 같은 DB 파일을 여는 다중 프로세스로 수행한다(단일 프로세스 내 동시성으로 대체하지 않음) — [Q20](../open-questions.md). `node:test`: `npm run test:unit`/`test:integration`/`test:boundaries`, 예제는 `test/integration/multiprocess-write.test.ts`(6프로세스 경쟁 + SIGKILL)
- [x] 마이그레이션 적용 방식과 SQLite 접근 계층: WAL 모드, `busy_timeout` 설정, 상태 전이·lease 획득은 `BEGIN IMMEDIATE` 트랜잭션 — [Q24](../open-questions.md). `packages/domain/src/db/`: `openDb`(busy_timeout 먼저, WAL), `Db.writeTx`(IMMEDIATE 전용, 쓰기는 이 안에서만), 순수 SQL 러너 `applyMigrations`. `migrations/0001`의 원천은 A1에서 결정(2026-10-19, 관리자): `docs/schema/schema.sql`이 설계 기준(단일 원천)이고 `migrations/0001_init.sql`은 그 복사본이다. 이후 변경은 새 마이그레이션과 `schema.sql`을 동시에 고치며, 드리프트 시험(`test/unit/schema-drift.test.ts`)이 빈 DB에 마이그레이션 전부를 적용한 결과와 `schema.sql` 적용 결과의 `sqlite_master`(정규화)를 비교해 다르면 실패시킨다
- [x] 비밀값 스캔과 금지어 스캔을 CI(및 커밋 전)에 연결 — [Q21](../open-questions.md), [공개 전 검사](../security/public-repository.md). gitleaks 8.30.1 `--redact`: `.gitleaks.toml`, `npm run scan:secrets`/`scan:history`, `.githooks/pre-commit`(`npm run hooks:install`). 인스턴스별 금지어 목록은 저장소 밖(`instance/gitleaks-banned.toml` 또는 `AOT_BANNED_CONFIG`)
- [x] 설정 분리 (`.env.example`, `config/daemon.config.example.json`): 저장소에는 `*.example`만, 실제 값은 `instance/`·환경 변수. `.gitignore`에 `instance/`·`*.db`·`*.db-*`·`*.sqlite*`·`*-wal`·`*-shm`·`*-journal`·`plans/` 포함 확인 ([공개 저장소 규칙](../security/public-repository.md))
- [x] 시계 주입: lease 판정·heartbeat·만료 계산은 주입된 `Clock`이 준 시각을 SQL 파라미터로 넘긴다. SQL의 `now()`/`CURRENT_TIMESTAMP`는 쓰지 않는다 ([recovery §2](../operations/recovery.md)). `Clock`/`FakeClock`(`@aot/domain`), 세 겹 강제: `Db`가 SQL 문자열을 거부, ESLint 규칙 `aot/no-sql-clock`, `.sql` 파일 스캔 시험
- [x] 가짜 어댑터·가짜 외부 도구(멱등 키 지원/미지원 두 종류) 골격 — `test/support/fake-tool.ts`(멱등 지원/미지원), `fake-adapter.ts`. 어댑터 계약 자체는 A5에서 정의
- [x] 스파이크 결과 기록 위치 `docs/spikes/` 생성 ([ADR-0009](../adr/0009-build-vs-reuse.md))
- [x] CI 필수 통과 항목 정의: 타입 검사, lint(경계 포함), 테스트, 스캔 — `.github/workflows/ci.yml`(스키마 적용 `sqlite3 :memory: < docs/schema/schema.sql` 포함). 원격 실행은 첫 push 후 확인

## 5. 스파이크

스파이크는 결과가 구현 방향을 바꿀 수 있는 질문에 대해 **시간을 정해** 수행하고, 산출물은 `docs/spikes/`에 기록한 뒤 관련 ADR·open-questions를 갱신한다. 판정 기준은 시작 전에 고정하며, 결과를 보고 바꾸지 않는다. 외부 서비스 호출이 필요한 스파이크는 사람의 사전 승인 아래 별도 환경에서만 수행한다.

### 스파이크 1: Q3 오케스트레이션 (LangGraph vs Microsoft Agent Framework) — Phase A 후속

| 항목 | 내용 |
|---|---|
| 목적 | 실행 조정 계층 후보 중 **하나**를 고른다 ([ADR-0009](../adr/0009-build-vs-reuse.md)). 둘 다 도입하지 않는다 |
| 시점 | Phase A 종료 후 (A5 선행 아님. Phase A는 자체 상태 머신으로 진행) |
| 시나리오 | 주간 사이클 축소판: 조사 → 검증 → 사람 승인 대기 → 재개 (가짜 모델 사용) |
| 산출물 | 후보별 축소 구현, 비교표, 결정 기록(ADR-0009 갱신) |
| 판정 기준 | (1) 프로세스 재시작 후 승인 대기 상태에서 재개된다 (2) 비용·근거를 `agent-runtime` 출력 계약으로 추출할 수 있다 (3) `domain` 모델·DB를 소유하지 않고 어댑터 뒤에 숨길 수 있다 (4) 정책 게이트웨이를 우회하는 도구 호출 경로가 없다. 네 기준을 모두 만족한 후보 중 코드량과 의존성이 적은 쪽. 둘 다 불충족이면 도입하지 않고 자체 상태 머신만 사용 |

### 스파이크 2: Q4 헤드리스 코드 에이전트 (OpenHands) — Phase A 후속

| 항목 | 내용 |
|---|---|
| 목적 | 코드 에이전트가 대화 세션 밖에서 작업하고 구조화된 결과를 반환할 수 있는지 확인 ([ADR-0005](../adr/0005-agent-adapter-boundary.md)) |
| 시점 | Phase A 종료 후 (코드 작업 역할은 Phase A 후속이며, Phase A의 실제 어댑터는 읽기 전용 조사 에이전트) |
| 시나리오 | 가상 저장소에서 읽기 전용 작업 1건 → 이후 격리된 쓰기 작업 1건 |
| 산출물 | 실행 방법 기록, 어댑터 계약 매핑표(입력·출력·비용·로그), 격리 한계 목록 |
| 판정 기준 | (1) 사람 개입 없이 시작·종료되고 종료 코드로 성공/실패를 알 수 있다 (2) 결과가 `result`/`evidence`/`run_log`/`cost` 형태로 변환 가능하다 (3) 파일시스템 범위·네트워크 허용 목록·시간 한도를 강제할 수 있다 (4) 비밀 값을 컨텍스트에 넣지 않고 동작한다. (3) 또는 (4) 불충족이면 어댑터 후보에서 제외 |

### 스파이크 3: Q14 멱등 키 지원 조사

| 항목 | 내용 |
|---|---|
| 목적 | 외부 부작용 도구(이메일 발송, 게시, CRM 쓰기)별 멱등 키 지원 여부를 파악해 `supports_idempotency` 계약 값을 정한다 ([recovery §3](../operations/recovery.md)) |
| 시점 | 실제 도구 어댑터 착수 전. A2의 부작용 로직은 지원/미지원 두 종류의 가짜 도구로 먼저 검증 |
| 방법 | 후보 도구의 공식 문서 조사. 실제 발송·게시는 하지 않는다 |
| 산출물 | 도구별 표: 멱등 키 지원 여부, 키 보존 기간, 상태 조회 API 유무, 보상 작업 가능 여부 |
| 판정 기준 | 도구마다 `supports_idempotency=true/false`와 "재전송 전 상태 조회 가능 여부"가 문서 근거와 함께 채워진다. 미지원이면서 조회도 불가한 도구는 Phase A에서 승인 필수·자동 재시도 금지로 분류 |

### 스파이크 4: Q15 lease 파라미터

| 항목 | 내용 |
|---|---|
| 목적 | lease 만료 시간과 heartbeat 주기의 기본값 결정 ([recovery §2](../operations/recovery.md)) |
| 시점 | A2 중간 (lease 구현 직후). 결과 기록은 A2 완료 조건 |
| 방법 | 시간 제어 가능한 테스트 환경에서 파라미터 조합별로 워커 종료·지연·SQLite 쓰기 경합을 시뮬레이션 |
| 산출물 | 파라미터 조합별 결과표(오탐 인수 횟수, 복구 지연, 쓰기 부하), 권장 기본값 |
| 판정 기준 | 정상 워커가 지연 상황(예: 장시간 도구 호출 중 heartbeat 지연)과 SQLite 쓰기 경합(다중 프로세스 워커가 동시에 heartbeat·전이를 쓰며 `busy_timeout` 대기 발생)에서 lease를 잃는 오탐이 0건이고, 종료한 워커의 업무가 복구 지연 목표 내에 인수된다. 목표값(복구 지연)은 스파이크 시작 시 사람이 정한다. 기준을 만족하는 조합 중 heartbeat 쓰기 부하가 가장 작은 것 |

## 6. Phase A 종료 조건

1. §3 표의 모든 테스트가 CI에서 통과한다.
2. 주간 사이클 1~7단계가 가짜 어댑터로 끝까지 실행되고, 실제 어댑터 1개(읽기 전용 조사 에이전트)로 최소 1회 실행된다.
3. 스파이크 3(Q14)·4(Q15)의 결과가 `docs/spikes/`에 기록되고 관련 ADR·open-questions가 갱신된다. 스파이크 1(Q3)·2(Q4)는 Phase A 후속이므로 종료 조건이 아니다.
4. 이 결과를 근거로 [상품 등록 검증 업무](../../workflows/product-registration.md)를 첫 실제 업무로 수행할 수 있는 상태가 된다 ([products](../products/README.md)).
