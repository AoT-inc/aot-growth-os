# 상태 머신

## 업무 (`task.status`)

```
queued ──► running ──► validating ──► completed
  ▲           │            │
  │           ├─► retry_wait ◄─┤ (검증 실패, 재시도 가능)
  │           │      │
  │           │      └──► queued (next_run_at 도달)
  │           ├─► needs_review ◄── validating (사람 검토 필요 / 승인 대기 / 평가 inconclusive)
  │           └─► failed
  └── cancelled (queued/running/retry_wait/needs_review 어디서나)
```

| From | To | 일으킬 수 있는 주체 | 조건 |
|---|---|---|---|
| (none) | queued | 업무 생성 엔진 | 명세 검증 통과, 의존 업무 존재, 배정 가능한 `trial`/`active` 역할 있음 |
| (none) | unassigned | 업무 생성 엔진 | 맞는 역할 없음 → 조직 관리팀의 재편 신호 |
| unassigned | queued | 스케줄러 | 역할 배정됨(기존 역할 확장 또는 새 역할 `trial` 시작) |
| queued | running | 스케줄러 | 선행 업무 `completed`, 예산 잔여, 정책 허용, 실행 인자 = `approved_hash`, lease 획득 |
| queued | needs_review | 스케줄러/정책 | `approved_hash` 불일치(재승인 요청), 실행 직전 재검증에서 승인 범위 이탈, 또는 (A6-U11) 명세의 선행 결과 입력(`inputs[kind=task_result]`)이 충족되지 않았거나(통과 평가가 있는 완료 업무가 아님) 업무별 어댑터를 고를 수 없음. run 을 만들지 않고 시도도 소모하지 않는다. 사유는 `upstream_unmet: <code>` / `adapter_unresolved` |
| running | validating | 스케줄러 | `task_run.outcome='submitted'` |
| running | queued | 스케줄러 | lease 만료로 run을 `lease_expired`로 닫음, 미확정 부작용 없음 ([recovery §4](../operations/recovery.md)) |
| running | needs_review | 스케줄러 | run `effect_unknown`, 또는 실행 중 재검증에서 정책이 거부/승인 범위 이탈 |
| running | retry_wait | 스케줄러 | error/timeout, `attempts < max_attempts` |
| running | failed | 스케줄러 | `attempts >= max_attempts` 또는 치명적 정책 위반 |
| running | retry_wait / failed | 스케줄러 | 실행 관리가 `time_limit` 초과로 취소해 run을 `killed`로 닫음 — `error/timeout`과 같은 규칙(시도 1회 소모, `attempts < max_attempts`면 `retry_wait`, 아니면 `failed`). 허용표에 새 전이는 없다 (A5 U4) |
| running | needs_review | 스케줄러 | 실행 관리가 업무 예산 초과로 취소해 run을 `killed`로 닫음. 같은 예산으로 재시도해도 소용이 없으므로 시도를 소모하지 않고 사람이 예산·명세를 정한다. 허용표에 새 전이는 없다 (A5 U4) |
| validating | completed | **검증기만** | 모든 acceptance_criteria 충족 AND `safety != fail` |
| validating | retry_wait | 검증기 | 기준 미충족, 재시도 가능 (`attempts + 1 < max_attempts`, 시도 1회 소모). 소진되면 `needs_review` — `validating → failed` 전이는 없으므로 사람이 정한다 |
| validating | needs_review | 검증기/정책 | `validation.human=true`, 승인 필요, **평가 `inconclusive`**(증거 부족: 관측 수 미달·데이터 품질 불량·측정 불가·원본 증거 없음), 또는 `safety='fail'`(자동 재시도·완료 금지, 사람이 정한다) |
| needs_review | queued / completed / failed | 사람(approval 기록 필수) | |
| retry_wait | queued | 스케줄러 | `next_run_at` 도달 |
| * (비종료) | cancelled | 사람 또는 정책 | 사유 필수 |

규칙
- 에이전트(`actor.kind='agent'`)는 상태를 직접 바꿀 수 없다. 결과만 제출한다.
- 모든 전이는 `task_transition`에 `caused_by`와 함께 기록한다.
- 데몬 재시작·워커 사망 시 복구 규칙은 [recovery §2·§4](../operations/recovery.md)가 정본이다: lease가 만료된 `running` 업무의 run은 `outcome='lease_expired'`로 닫고(`killed`는 `time_limit` 초과 등으로 시스템이 강제 종료한 경우에만 쓴다), 업무는 `running → queued`로 돌아가 새 `attempt`로 인수된다(재시도 횟수 소모 여부는 정책 파라미터, 기본 소모하지 않음). `dispatched`/`unknown` 부작용이 남은 run은 `queued`가 아니라 `needs_review`로 간다.
- 종료 상태: `completed`, `failed`, `cancelled`.
- 검증 판정과 전이 (A4): 평가(`evaluation`)는 판정만 기록하고, 전이는 업무 엔진이 `validating` 행의 조건대로 한다. `completed`는 같은 run 의 `evaluation.outcome='pass'` AND `safety='pass'`가 기록되어 있을 때만 가능하다. `inconclusive`는 `retry_wait`가 아니라 `needs_review`다(증거 부족을 재시도로 덮지 않고 사람이 확인한다, 2026-10-21 결정).
- 실행 소유권(lease)과 부작용 복구 규칙은 [recovery](../operations/recovery.md)를 따른다. 외부 부작용이 `unknown`인 run은 `retry_wait`가 아니라 `needs_review`로 간다.
- `queued → running`은 task_run 생성(lease 획득)과 한 트랜잭션이다. 실행 인자가 `approved_hash`와 다르면 `running`으로 가지 못하고 `queued → needs_review`(재승인)로 간다.
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
| proposed | approved | 사람 (`approval`, `subject_kind='org_proposal'`) | 승인 시점에 `base_org_version_id` = 현재 활성 조직 버전. 다르면 충돌 → `superseded`, 최신 기준으로 재제안. `change_class='risky'`면 ADR-0006 위험 변경 승인자 요건 |
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
- **`inconclusive`는 재시험 승인(`inconclusive → trial`) 전까지 종료로 취급하는 상태다** (2026-10-21 결정). 조직에 반영된 적이 없으므로 자동으로 다음 상태로 가지 않고, 시험 연장도 자동 허용하지 않으며, 별도 상태(예: `closed`)를 추가하지 않는다. 사람이 재시험을 승인하지 않으면 그대로 종료 기록으로 남는다. 스키마·CHECK·마이그레이션은 바꾸지 않는다. 허용표 정의의 `terminal` 목록은 비워 둔다(나가는 전이 `inconclusive → trial`이 있으므로 기계적으로는 종료가 아니고, 의미상 "재시험 승인이 없으면 끝"이라는 취급이다).

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
- (A6-U14) `proposed` 행의 *생성*은 전이가 아니다(허용표에 `(none) → proposed` 행이 없고 더하지 않았다). 주간 사이클의 비교 단계가 비교 기록이 추천한 후보로만 만들며, 쓰는 주체는 시스템이고 에이전트가 아니다(`created_by`는 후보를 낸 기획 run 의 행위자). 전이는 domain `transitionStrategyVersion`이 이 표를 따르고, `human` 주체는 행위자가 실제 사람이어야 하며 승인이 필요한 전이는 그 행을 가리키는 `approved` 승인 기록이 있어야 한다.
- (A6-U15) `proposed → experiment`는 policy 승인 엔진이 사람 1인 승인(cooldown·TOTP 없음)과 **같은 트랜잭션**에서 일으킨다. 승인 해시 = 본문 + `experiment_scope` + 승인 시점 정책 버전. `experiment` 상태이고 승인이 취소되지 않은 전략이 있으면 두 번째 승인은 거부한다(한 번에 실험 하나). `proposed → rejected`는 승인 채널의 `reject`(사람). 허용표에 전이를 더하지 않았다.
- (A6-U15) 활성화·종료는 상태 전이가 아니라 기록이다. 활성화(task-engine `activateExperiment`, 승인 트랜잭션 밖, 주간 사이클)는 event `experiment-activate:<id>`(멱등, `occurred_at` = 활성화 시각 = 켠 루틴의 발화 기준점)와 함께 실험 루틴을 `enabled=1`로 켜거나 일회성 마케팅 업무(`task.strategy_version_id`)를 만든다. 활성화 직전에 승인을 다시 확인해, 활성화 전에 `cancel`된 승인이나 승인 뒤 바뀐 내용이면 켜지 않는다(상태는 `experiment`로 남는다 — 아래 열린 문제). 종료(`endExperiment`)는 루틴을 `enabled=0`으로 끄고 event `experiment-end:<id>`를 남기며 상태는 바꾸지 않는다(판정과 `experiment → active` 등은 A6-U16).
- (A6-U15, 열린 문제) `experiment`에서 나가는 전이는 `experiment → active`뿐이다. 판정이 실패한 실험, 활성화 전에 취소된 실험, 활성화가 거부된 실험은 갈 곳이 없어 `experiment`로 남는다(취소된 것은 진행 중으로 세지 않는다). `experiment → rejected/retired`를 더할지는 U16 에서 정한다.

## 게시 (`publication.status`)

`draft → pending_approval → published → withdrawn`. `audience`가 `internal`이 아니면 `published` 전환에 승인(`approval`)이 필수다.

## 상품 등록 (`product.registration_status`)

`candidate → verifying → pending_approval → registered`, 검증/승인 단계에서 `rejected`. `registered`로의 전이는 사람 승인(`approval`, `subject_kind='product'`, `product.registration_approval_id`가 가리킴)이 필수이며, 검증 업무의 읽기 전용 증거가 연결되어야 한다. `registered` 전 제품은 업무의 `product_id`가 될 수 없다 ([절차](../products/README.md)).

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
