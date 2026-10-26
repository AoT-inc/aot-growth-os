# example-marketing (첫 도메인 팩)

주간 시장 조사 사이클을 담는 첫 도메인 팩이다 ([ADR-0012](../../docs/adr/0012-extension-unit-contract.md)).
값은 모두 가상이며 실제 제품·주소·정책은 `instance/` 에 둔다. 팩은 **데이터**이고 코어가 경로로 읽는다(팩 코드를 import 하지 않는다).
로더는 `apps/daemon/src/pack-loader.ts`, 데몬 설정 키는 `pack_dir`·`pack_values` ([config/daemon.config.example.json](../../config/daemon.config.example.json)).

| 위치 | 내용 | 상태 |
|---|---|---|
| `manifest.json` | 이름, 버전, 요구 코어 버전, 필요한 도구, 구성 디렉터리 | 형식 검증 있음 (`validatePackManifest`) |
| `workflows/` | 업무 템플릿 `<id>.json` (`id`, `version`, `tasks[{name, depends_on?, spec}]`; `spec` 은 [task-spec](../../docs/schema/task-spec.md) 초안 형식) | 주간 시장 조사 1개, 주간 실험 기획 1개(조사 → 기획: 조사 결과와 지난주 기준선 측정과 직전 `strategy_record` 를 받아 `candidates` 를 낸다, 검사 `experiment_candidates`. 루틴 `weekly-experiment-planning` 이 가리킨다), 실험 결과 검토 1개(`experiment-result-review`: 데몬 사이클이 실험 주가 끝난 뒤 만든다) |
| `routines/` | 루틴 선언 `<slug>.json` (`schedule`, `catch_up`, `task_template` = `<템플릿 id>@<version>`, `org_unit`, 선택 `product`) | 주간 실험 기획 1개(`weekly-experiment-planning`: 한 슬롯에서 조사 → 기획 업무, 주간 사이클의 입구), 주간 시장 조사 1개(조사 업무만, 템플릿 실험의 대상). 둘 다 월 09:00 `Asia/Seoul`, `catch_up: skip` |
| `measurement-signals/` | 측정 신호 정의 `<id>.json` ([D2](../../docs/plans/a0-decisions.md), `validateMeasurementSignal`) | 주간 랜딩 전환 수 1개 |
| `evaluations/` | 결정론적 검사 id, LLM 검증 프롬프트 | 비어 있음 |
| `policy-examples/` | 정책 **예시** (채택은 코어의 승인 경로) | 비어 있음 |

조사 업무 명세에는 `expected_quotes` 가 없고 `validation.llm` 은 `null` 이다. 읽기 전용 실제 조사 에이전트(컨테이너)는 기대 인용문만 확인해 주장을 만들므로, 이 템플릿 그대로 실제 에이전트로 돌리면 주장이 없어 평가가 `inconclusive` → `needs_review` 가 된다(자동 완료는 없다). 통합 시험은 팩 사본에 두 필드를 더해 돈다 ([phase-a A6 완료 기록](../../docs/plans/phase-a.md) 열린 항목 ①).

## 자리표시자

템플릿과 루틴 선언의 문자열 값에서 `{{name}}`(소문자·숫자·밑줄) 자리표시자를 데몬 설정의 `pack_values` 로 치환한다. 이 팩이 쓰는 이름:

| 이름 | 쓰임 |
|---|---|
| `org_unit` | 루틴을 둘 부서 slug (DB 의 `org_unit.slug`) |
| `product` | 제품 slug (DB 의 `product.slug`, 등록 완료 상태여야 한다). 업무 명세의 `product`·목적 문장, 루틴의 `product_id` |
| `research_source_url` | 조사 출처 주소 (`source_url` 입력) |
| `research_host` | 업무의 `network_allowlist` 에 들어갈 호스트 (운영 상한 `research_agent.allowed_hosts` 안에 있어야 한다) |

### 동적 자리표시자 (해석할 때 채운다, `pack_values` 로 줄 수 없다)

| 이름 | 값 |
|---|---|
| `last_week` | 루틴 발화 슬롯이 속한 ISO 주의 바로 앞 주 (측정 신호 `tz` 벽시계). `measurement:<신호 id>@{{last_week}}` 전체 모양으로만 쓴다. 기획 템플릿의 기준선 측정 주 (A6-U16. 이전의 `baseline_week` pack_values 를 대체한다) |
| `experiment_week` | 실험 주 (활성화 뒤 처음 *시작하는* ISO 주). 결과 검토 템플릿의 측정 입력. 사이클이 채운다 |
| `planning_task`, `research_task` | 그 실험을 낳은 기획·조사 업무 id (결과 검토 템플릿의 `task_result` 입력 `task:{{...}}`). 사이클이 채운다 |

기획 템플릿의 `previous-experiment` 입력(`memory:latest#strategy_record`)은 업무를 만들 때 같은 상품의 가장 최근 현재 사실 `strategy_record` 로 바뀐다(없으면 빠진다, [task-spec](../../docs/schema/task-spec.md) "기억 입력").

치환은 값 안의 `{{`/`}}` 를 허용하지 않는 단일 패스이며, 치환 뒤 `validateTaskSpec` 를 통과해야 한다. 값이 없는 자리표시자는 데몬 시작 때 거부한다.

## 루틴 반영 규칙

루틴은 `enabled=0` 으로 DB 에 만들어진다(켜는 일은 실험 승인 경로의 몫. 주간 기획 루틴처럼 실험 밖에서 켤 루틴의 운영 경로는 아직 없다 — [phase-a A6 완료 기록](../../docs/plans/phase-a.md) 열린 항목 ②). 이미 있으면 바꾸지 않고, 팩 선언이 DB 행과 다르면 `enabled=0` 인 행만 선언에 맞춰 갱신하며 켜진 행은 거부한다 ([phase-a A6-U10 기록](../../docs/plans/phase-a.md)).

팩은 정책·스키마·검증기를 바꿀 수 없고, 코어 내부 모듈을 import 하지 않는다 (`npm run lint:boundaries`가 검사).
