# ADR-0013 정책 표현: YAML + 결정론적 판정기

상태: accepted (2026-10-19, [open-questions Q7](../open-questions.md))

## Context
[ADR-0006](0006-policy-separation.md)은 권한을 7요소(주체, 행위, 대상, 범위, 영향, 제약, 승인)로 판정하고 결과를 `policy_decision`에 남기도록 정했지만 정책을 무엇으로 표현할지는 열어 두었다(Q7). 후보는 YAML + 코드 판정, OPA(Rego), Cedar였다. Phase A의 규칙은 초기 정책 v1([a0-decisions D4](../plans/a0-decisions.md))과 위험 변경 파라미터(D3) 정도로 작다. 외부 엔진은 의존성·런타임이 늘고, 판정 결과를 `policy_decision` 형식으로 맞추는 어댑터가 따로 필요하다.

## Decision
- 정책 파일은 YAML이며 스키마 검증을 통과해야 한다. 모르는 키, 범위를 벗어난 값은 거부한다.
- 판정기는 `@aot/policy`의 자체 TypeScript 코드다. 같은 정책과 같은 요청이면 항상 같은 결과를 낸다(시각·난수·외부 호출을 쓰지 않는다).
- 정책 버전은 정규화된 내용(파싱·검증한 문서를 키 정렬 JSON으로 직렬화한 것)의 SHA-256 해시다. 주석·공백·키 순서는 버전을 바꾸지 않는다. `policy_version.content_hash`가 이 값이다.
- 세부 형식(키 목록, 판정 결합 방식)은 구현과 함께 이 ADR의 Amendment로 적는다.
- 규칙이 복잡해지면(조건식, 속성 기반 조합 등) Cedar로 이식하는 것을 검토한다. 지금은 기록만 한다.

## Consequences
- 의존성 없이 판정을 시험으로 고정할 수 있다. 판정 근거가 코드에 있으므로 판정기 변경도 정책 변경과 같은 무게로 검토한다.
- 표현력이 작다. 표현할 수 없는 규칙이 필요해지면 형식을 넓히기 전에 Cedar 이식을 먼저 비교한다.

## Amendment (2026-10-19): 형식 v1 (A3 구현)
기본 템플릿은 [`policies/default.yaml`](../../policies/default.yaml)이며 시드의 `policy-v1`과 같은 내용이다(시험이 대조한다).

| 키 | 내용 | 검증 |
|---|---|---|
| `format` | `aot-policy/v1` | 필수 |
| `default` | `deny` | 필수, `deny`만 허용 |
| `limits` | `max_usd_per_task`(필수), `max_tokens_per_task` | 양수. 업무의 `cost_budget`이 넘으면 거부 |
| `rules[]` | `id`, 조건 `subject`·`action`·`resource`(`*` 와일드카드 패턴), `scope`·`impact`(열거값), `decision` | 조건이 하나도 없는 규칙 거부, id 중복 거부 |
| `risky_change` | `min_approvers`, `cooldown`, `reauth_before_effect` (자기 승인은 키가 아니라 `min_approvers == 1`일 때만 허용되는 규칙. `self_approval` 키는 사유와 함께 거부) | `min_approvers` 1~10 정수, `cooldown` 0~30d |
| `memory.default_validity` | 기억 종류 → 기본 만료 기간 ([memory-item](../schema/memory-item.md) 규칙 5) | `commitment` 제외(규칙 6), 값은 [Q17](../open-questions.md) |

- **요청 단위.** `allowed_tools`의 도구 × 작업 하나가 요청 하나다. 주체 `<role>@v<role_version>`, 행위 `<tool>.<operation>`, 대상 `target`, 범위 `scope`, 영향 `impact`, 제약은 `cost_budget`·`constraints`. `scope`·`impact`는 `task_spec` 검증에서 필수이므로 빠진 명세는 정책 판정 이전에 생성 단계에서 사유와 함께 거부된다. 판정기도 선언되지 않은 요청(저장된 옛 명세, 부작용 직전 재검증)은 거부한다(추측해 채우지 않는다). 그때 `policy_decision`의 NOT NULL 열에는 가장 넓은 값(`public`, `external_effect`)을 적고 사유에 미선언임을 남긴다.
- **승인 요건.** `require_approval` 판정의 승인 요건(`policy_decision.approval_required`)은 요청의 영향으로 정해진다: `external_effect`는 `risky_change`의 값(승인자 수·cooldown·재인증), 그 밖의 영향은 사람 1인·cooldown 0·재인증 없음. 자기 승인 허용 여부(`self_approval`)는 판정 기록에 파생 값으로 남는다(`min_approvers == 1`일 때만 true).
- **기본 템플릿의 게시 규칙.** `internal-publish` 규칙(`publication.publish` + `internal` + `write`)이 internal 게시를 승인 없이 허용한다. `*:task-own` 규칙은 게시 대상(`<channel>:<content_ref>`)에 맞지 않으므로 가장 좁은 별도 규칙으로 더했다. 외부 게시(`customer`/`public`)는 `require_approval`이다.
- **결합.** 일치한 규칙 중 가장 엄격한 결과(deny > require_approval > allow). 규칙 순서는 결과에 영향이 없다. 일치하는 규칙이 없으면 `default`(deny).
- **정규화.** 기간은 초, 집합 성격의 목록은 정렬, 규칙은 id 순으로 정렬한 뒤 키 정렬 JSON의 SHA-256이 버전 해시다. 새로 배포하는 `policy_version.id`는 `policy-<해시 앞 16자리>`.
- **YAML 부분집합.** 앵커·별칭·태그·블록 스칼라·여러 문서·중첩 흐름·탭 들여쓰기·중복 키는 받지 않는다(`packages/policy/src/yaml.ts`). 검토를 어렵게 하는 기능을 막고 의존성을 더하지 않기 위해서다. `*`로 시작하는 값은 따옴표로 감싼다.
- **내용 보관.** DB의 `policy_version`은 배포 기록이고 내용은 파일이다. 승인 엔진이 배포 승인 때 내용을 `instance/policies/<해시>.yaml`(0600)로 보관하고, 판정 때마다 해시를 다시 계산해 대조한다. 내용을 찾지 못하거나 해시가 다르면 모든 판정은 거부다.
- **변경 등급.** 강화임을 증명할 수 없는 변경은 위험 변경이다: `risky_change` 하향(`min_approvers`를 2 이상에서 1로 내리는 변경은 자기 승인이 허용으로 바뀌는 변경이기도 하다), 예산 상한 상향·삭제, `deny` 추가와 `allow` 삭제를 뺀 모든 규칙 변경(`require_approval` 추가도 기본 거부였던 요청을 승인 가능으로 바꾼다). 위험 변경은 현재 정책의 `risky_change`로 승인한다. `memory.default_validity` 변경은 일반 변경이다.

## Amendment (2026-10-25): `phone` 섹션
선택 키 `phone`(전화 정책, [ADR-0014](0014-phone-capability.md) §8): `allowed_regions`·`caller_ids`·`max_duration_seconds`·`max_calls_per_day`(인스턴스 전체의 총 상한) 필수, `max_calls_per_day_per_org_unit`(조직 단위별 상한)·`denied_numbers`·`business_hours`(`tz` 필수, 하루 안의 창)·`recording`(기본 `forbidden`)·`transfer_targets` 선택. 섹션이 없으면 모든 통화를 거부한다. 키가 없는 문서는 정규화 결과가 이전과 같아 정책 버전(내용 해시)이 바뀌지 않는다. 변경 등급: 섹션 신설, 지역·발신 번호·전환 대상 추가, 금지 번호 삭제, 통화시간·일일 통화량(총·조직 단위별) 상향·삭제, 영업시간 해제·확대, 녹취 완화는 위험 변경이고 섹션 삭제와 그 밖의 강화는 일반 변경이다.

## Amendment (2026-11-05, 채택 2026-11-06): `delegation` 섹션 ([ADR-0016](0016-decision-delegation.md))
**상태: 채택(2026-11-06, 오너 결정 D-B1).** 선택 키 `delegation`: `mandates[]` 각 항목은 `id`(정책 안에서 유일)·`holder`(위임 받는 에이전트 행위자 id)·`subjects: [task]`(v1은 초안 승인 업무만)·`match`(`actions` = `<도구>.<action>` 패턴, `targets` = 대상 패턴, `scopes` = 업무 명세가 그 도구에 선언한 범위, `public` 불가)·`limits`(`max_per_day`·`max_drafts_per_task`·`max_recipients_per_draft`·`max_payload_bytes`·`max_task_usd`·`max_rewrites_per_task`(0 허용)·`max_review_usd_per_day`, 모두 필수)·`cooldown`(`risky_change.cooldown` 이상, 30d 이하)·`guidance`(사람이 쓴 판단 기준, 1~500자)·`expires`(`YYYY-MM-DD`, 그 날 UTC 끝까지)를 모두 필수로 가진다. 모르는 키, `public` 범위, 범위 밖 한도, 날짜가 아닌 `expires`, 중복 id는 거부한다. **`risky_change.min_approvers`가 1이 아니면 위임이 있는 문서는 거부한다**(D-B7). 배포 승인 때 엔진이 추가로 확인한다: 모든 `expires`가 배포 승인 시각부터 90일 이내이고 이미 지나지 않았을 것, `holder`가 에이전트 행위자일 것(예약된 `approval-delegate`는 배포 트랜잭션에서 만들어진다).

정규화: 위임은 id 순, `match`의 목록은 정렬, 기간은 초. `mandates`가 비어 있는 섹션은 키를 지워 정규화하므로 **섹션이 없거나 비어 있는 문서의 내용 해시(정책 버전)는 이 섹션이 생기기 전과 같다.** 기본 템플릿(`policies/default.yaml`)과 시드 정책은 위임을 선언하지 않는다 — 위임은 꺼져 있다.

변경 등급: 섹션 신설, 위임 추가, `holder` 변경, `match` 확대, 한도 상향(`max_rewrites_per_task` 포함), `cooldown` 단축, `expires` 연장, `guidance` 변경은 **위험 변경**(현재 정책의 `risky_change` 절차: 승인자 수·cooldown·TOTP). 위임 삭제, 한도 하향, 섹션 삭제, `cooldown` 연장, `expires` 단축은 일반 변경. 위임 범위를 넓히는 일은 언제나 사람이 TOTP로 배포한다.
