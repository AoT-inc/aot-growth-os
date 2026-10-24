# example-marketing (첫 도메인 팩)

주간 시장 조사 사이클을 담는 첫 도메인 팩이다 ([ADR-0012](../../docs/adr/0012-extension-unit-contract.md)).
값은 모두 가상이며 실제 제품·주소·정책은 `instance/` 에 둔다. 팩은 **데이터**이고 코어가 경로로 읽는다(팩 코드를 import 하지 않는다).
로더는 `apps/daemon/src/pack-loader.ts`, 데몬 설정 키는 `pack_dir`·`pack_values` ([config/daemon.config.example.json](../../config/daemon.config.example.json)).

| 위치 | 내용 | 상태 |
|---|---|---|
| `manifest.json` | 이름, 버전, 요구 코어 버전, 필요한 도구, 구성 디렉터리 | 형식 검증 있음 (`validatePackManifest`) |
| `workflows/` | 업무 템플릿 `<id>.json` (`id`, `version`, `tasks[{name, depends_on?, spec}]`; `spec` 은 [task-spec](../../docs/schema/task-spec.md) 초안 형식) | 주간 시장 조사 1개 |
| `routines/` | 루틴 선언 `<slug>.json` (`schedule`, `catch_up`, `task_template` = `<템플릿 id>@<version>`, `org_unit`, 선택 `product`) | 주간 시장 조사 1개 (월 09:00 `Asia/Seoul`, `catch_up: skip`) |
| `measurement-signals/` | 측정 신호 정의 `<id>.json` ([D2](../../docs/plans/a0-decisions.md), `validateMeasurementSignal`) | 주간 랜딩 전환 수 1개 |
| `evaluations/` | 결정론적 검사 id, LLM 검증 프롬프트 | 비어 있음 |
| `policy-examples/` | 정책 **예시** (채택은 코어의 승인 경로) | 비어 있음 |

## 자리표시자

템플릿과 루틴 선언의 문자열 값에서 `{{name}}`(소문자·숫자·밑줄) 자리표시자를 데몬 설정의 `pack_values` 로 치환한다. 이 팩이 쓰는 이름:

| 이름 | 쓰임 |
|---|---|
| `org_unit` | 루틴을 둘 부서 slug (DB 의 `org_unit.slug`) |
| `product` | 제품 slug (DB 의 `product.slug`, 등록 완료 상태여야 한다). 업무 명세의 `product`·목적 문장, 루틴의 `product_id` |
| `research_source_url` | 조사 출처 주소 (`source_url` 입력) |
| `research_host` | 업무의 `network_allowlist` 에 들어갈 호스트 (운영 상한 `research_agent.allowed_hosts` 안에 있어야 한다) |

치환은 값 안의 `{{`/`}}` 를 허용하지 않는 단일 패스이며, 치환 뒤 `validateTaskSpec` 를 통과해야 한다. 값이 없는 자리표시자는 데몬 시작 때 거부한다.

## 루틴 반영 규칙

루틴은 `enabled=0` 으로 DB 에 만들어진다(켜는 일은 실험 승인 경로의 몫). 이미 있으면 바꾸지 않고, 팩 선언이 DB 행과 다르면 `enabled=0` 인 행만 선언에 맞춰 갱신하며 켜진 행은 거부한다 ([phase-a A6-U10 기록](../../docs/plans/phase-a.md)).

팩은 정책·스키마·검증기를 바꿀 수 없고, 코어 내부 모듈을 import 하지 않는다 (`npm run lint:boundaries`가 검사).
