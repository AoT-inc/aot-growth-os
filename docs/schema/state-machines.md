# 상태 머신

## 업무 (`task.status`)

```
queued ──► running ──► validating ──► completed
  ▲           │            │
  │           ├─► retry_wait ◄─┤ (검증 실패, 재시도 가능)
  │           │      │
  │           │      └──► queued (next_run_at 도달)
  │           ├─► needs_review ◄── validating (사람 검토 필요 / 승인 대기)
  │           └─► failed
  └── cancelled (queued/running/retry_wait/needs_review 어디서나)
```

| From | To | 일으킬 수 있는 주체 | 조건 |
|---|---|---|---|
| (none) | queued | 업무 생성 엔진 | 명세 검증 통과, 의존 업무 존재, 배정 가능한 `trial`/`active` 역할 있음 |
| (none) | unassigned | 업무 생성 엔진 | 맞는 역할 없음 → 조직 관리팀의 재편 신호 |
| unassigned | queued | 스케줄러 | 역할 배정됨(기존 역할 확장 또는 새 역할 `trial` 시작) |
| queued | running | 스케줄러 | 선행 업무 `completed`, 예산 잔여, 정책 허용 |
| running | validating | 스케줄러 | `task_run.outcome='submitted'` |
| running | retry_wait | 스케줄러 | error/timeout, `attempts < max_attempts` |
| running | failed | 스케줄러 | `attempts >= max_attempts` 또는 치명적 정책 위반 |
| validating | completed | **검증기만** | 모든 acceptance_criteria 충족 AND `safety != fail` |
| validating | retry_wait | 검증기 | 기준 미충족, 재시도 가능 |
| validating | needs_review | 검증기/정책 | `validation.human=true` 또는 승인 필요 |
| needs_review | queued / completed / failed | 사람(approval 기록 필수) | |
| retry_wait | queued | 스케줄러 | `next_run_at` 도달 |
| * (비종료) | cancelled | 사람 또는 정책 | 사유 필수 |

규칙
- 에이전트(`actor.kind='agent'`)는 상태를 직접 바꿀 수 없다. 결과만 제출한다.
- 모든 전이는 `task_transition`에 `caused_by`와 함께 기록한다.
- 데몬 재시작 시: `running` 업무는 해당 `task_run`을 `killed`로 닫고 `retry_wait`로 보낸다(재시도 횟수 소모 여부는 정책 파라미터, 기본 소모하지 않음). 외부 부작용이 있던 run은 멱등 토큰으로 중복 방지.
- 종료 상태: `completed`, `failed`, `cancelled`.
- 실행 소유권(lease)과 부작용 복구 규칙은 [recovery](../operations/recovery.md)를 따른다. 외부 부작용이 `unknown`인 run은 `retry_wait`가 아니라 `needs_review`로 간다.
- `queued → running`은 task_run 생성(lease 획득)과 한 트랜잭션이다. 실행 인자가 `approved_hash`와 다르면 `running`으로 가지 못하고 `needs_review`(재승인)로 간다.
- 실행 시작 시 현재 `policy_version`이 생성 시점보다 엄격하면 새 정책으로 재검증한다.

## 조직 제안 (`org_proposal.status`)

```
proposed ──► rejected
   │  └──► expired / superseded (기준 버전 충돌, 만료)
   ▼
approved ──► trial ──► active ──► retired
               │  └──► inconclusive ──► trial (재시험 승인)
               │            └─────────► (종료)
               └──► rolled_back ◄── active (확정 후 문제 발견)
```

| From | To | 주체 | 조건 |
|---|---|---|---|
| proposed | approved | 사람 | 승인 시점에 `base_org_version_id` = 현재 활성 조직 버전. 다르면 충돌 → `superseded`, 최신 기준으로 재제안. `change_class='risky'`면 ADR-0006 위험 변경 승인자 요건 |
| proposed | rejected / expired | 사람 / 시스템 | `expires_at` 경과 시 `expired` |
| approved | trial | 시스템 | `evaluation_plan`·`rollback_plan` 완비. **`approved`는 변경안 승인이지 무조건적인 실행 허가가 아니다** |
| trial | active | 시스템 | 독립 평가 `pass` + 필수 성공 조건 충족 + 사람 확인. 새 `org_version` 생성 |
| trial | inconclusive | 평가기 | 기간 경과 AND (관측 수 미달 OR 데이터 품질 불량) |
| trial | rolled_back | 평가기/시스템 | 평가 `fail` 또는 즉시 중단 조건(안전성 위반·예산 초과·심각한 품질 저하) |
| inconclusive | trial | 사람 | 재시험 승인(새 평가 계획, 연장 상한 내, 비용·영향 범위 제한 유지) |
| active | rolled_back | 사람 | 확정 후 문제 발견 |
| active | retired | 사람 | 역할/구성 종료 (아래 규칙) |

규칙
- `trial`은 제안의 `trial_scope`(업무 유형)와 `scope`(영향 역할)만 허용한다. 범위 밖 업무는 기존 조직으로 라우팅된다.
- **시험 연장은 자동 허용하지 않는다.** `inconclusive` → `trial` 재진입 시에도 사람 승인과 `trial_extensions` 증가가 필요하다.
- 조직 변경은 JSON 덮어쓰기가 아니라 승인된 diff를 기준 버전에 적용해 **새 `org_version`을 만드는 작업**이다.
- 조직 관리팀은 정책·검증기·평가기·승인 엔진을 대상으로 하는 제안을 만들 수 없다.
- 조직 관리팀은 `org_trial_result`를 쓸 수 없다 (평가기만).

### 롤백 처리 (`rolled_back`)

조직 롤백은 조직 버전만 복구하는 것이 아니다. `rollback_plan`에 아래를 모두 정의해야 `trial`에 진입할 수 있다.

| 대상 | 처리 |
|---|---|
| 조직 버전 | 직전 `org_version`을 활성으로 복구, 새 역할은 `retired`(삭제 아님) |
| 새 역할이 만든 예약 루틴 | 비활성화 (`routine.enabled=0`), 이력 보존 |
| `queued`·`unassigned` 업무 | 기존 역할로 재라우팅하거나 `unassigned`로 복귀 |
| `running` 업무 | 완료까지 허용할지 취소할지 계획에 명시. 기본은 취소하지 않고 안전한 지점에서 종료 |
| 이미 발생한 외부 부작용(발송 이메일, 게시물) | **자동 복구되지 않는다.** `external_effect.compensation_ref`가 있으면 보상 업무 생성, 없으면 사람의 처리를 요청 |

조직 롤백과 업무 롤백은 다르다. 업무 롤백이라는 상태는 없다 ([recovery](../operations/recovery.md) §6).

### 역할 폐지
역할 폐지(`retired`)는 삭제가 아니다. 과거 업무의 `role_id`·`role_version`·`org_version_id`가 가리키는 기록과 책임 이력은 보존된다.

## 역할 (`role.lifecycle`)

`proposed → trial → active → retired`. 업무 배정은 `trial`·`active`만 가능하며 `trial`은 `trial_scope` 업무만. `retired`는 삭제가 아니라 신규 배정 중단이다.

## 전략 (`strategy_version.status`)

`proposed → experiment → active → retired`, `proposed → rejected`.
- `proposed → experiment/active`: 사람 승인 필수. `experiment`는 범위·기간 제한 필수.
- `active` 교체 시 이전 버전은 `retired`로 두고 롤백 지점으로 유지한다.

## 게시 (`publication.status`)

`draft → pending_approval → published → withdrawn`. `audience`가 `internal`이 아니면 `published` 전환에 승인(`approval`)이 필수다.

## 상품 등록 (`product.registration_status`)

`candidate → verifying → pending_approval → registered`, 검증/승인 단계에서 `rejected`. `registered`로의 전이는 사람 승인(`approval`)이 필수이며, 검증 업무의 읽기 전용 증거가 연결되어야 한다. `registered` 전 제품은 업무의 `product_id`가 될 수 없다 ([절차](../products/README.md)).

## 상품 단계 (`product.lifecycle_stage`)

`idea → development → beta → live → maintenance → sunset`. `live` 전환은 위험 변경(ADR-0006).

## 금지된 전이

| 전이 | 이유 |
|---|---|
| 에이전트에 의한 모든 상태 전이 | 에이전트는 결과만 제출 |
| `running → completed` (validating 생략) | 완료는 검증 결과로만 |
| `failed`/`completed`/`cancelled` → 다른 상태 | 종료 상태. 재시도는 새 업무로 |
| `unassigned → running` | 역할 배정 후 `queued`를 거침 |
| `needs_review → completed` (approval 없이) | 사람 판단 기록 필수 |
| `org_proposal`: `proposed → trial`, `proposed → active`, `trial → active`(평가 pass 없이) | 승인·평가 단계 생략 금지 |
| `org_proposal`: `inconclusive → active` | 증거 부족은 승격 사유가 아님 |
| `org_proposal`: 조직 관리팀에 의한 `approved`/`trial`/`active`/`rolled_back` 전이 | 제안자는 제안만 |
| `strategy_version`: `proposed → active`(사람 승인 없이) | |
| `publication`: `draft → published`(audience≠internal, 승인 없이) | |
