# Phase B 구현 계획 — 적응형 조직 검증

[overview §6](../00-overview.md)의 Phase B(조직 관리팀이 데이터 신호로 조직을 키우는 적응형 조직, [ADR-0011](../adr/0011-adaptive-organization.md))를 구현하는 순서와 완료 기준. 정본은 [phase-a.md](phase-a.md)(A1~A6 완료 기록)와 [handoff-after-a6.md](handoff-after-a6.md)이며, 이 문서는 **A6까지 구현된 것 위에서** Phase B를 단계로 나눈 설계다. 착수 전 설계이므로 각 단계의 실제 구현·편차는 단계마다 완료 기록을 이 문서에 덧붙인다(Phase A와 같은 방식).

작성 시점(2026-11-21)에 코드로 확인한 사실과 문서만으로 아는 것을 구분해 적었다. 확정하지 못한 것은 §9에 "추정"으로 모았다.

## 1. 원칙과 범위

- Phase A의 원칙을 그대로 잇는다: 완료는 검증 결과로만, 안전성은 거부권, 에이전트는 상태를 바꾸지 못하고 결과만 제출, 시각은 주입 `Clock`, 쓰기는 `Db.writeTx`, 공개 저장소에 실제 값 금지.
- **조직 변경은 권한 변경이 아니다.** 역할·라우팅이 바뀌어도 `policy_decision`은 바뀌지 않는다([trust-boundaries §2-7](../security/trust-boundaries.md)). Phase B는 이것을 제안→승인→시험 경로로 **다시** 확인한다(overview §6 "권한" 행의 B 몫).
- 고정 코어(검증기·평가기·정책·승인 엔진·비용 원장)는 조직 관리팀의 제안 대상이 아니다. Phase B는 이 금지를 코드로 강제한다.
- 실제 모델에 의존하지 않는다. 조직 관리팀 어댑터는 가짜(결정적)이며, 계약은 A5의 어댑터 계약을 그대로 쓴다.
- 범위 밖: 실제 LLM 어댑터([Q22](../open-questions.md)), 상품 등록 업무 수행(Phase A 후속), 부서 8개의 사전 정의(ADR-0011 §1), 내부 웹.

## 2. 착수 결정 (2026-11-21 사용자 결정)

| # | 결정 | 내용 | 영향 |
|---|---|---|---|
| B-D1 | **업무 유형 = 템플릿 참조** | `task`에 nullable 열 `template_ref` 하나를 더하고 업무 유형 = `<템플릿 id>@<버전>#<템플릿 안 업무 이름>`. 팩 템플릿이 값의 유일한 출처이므로 지어낸 유형이 생기지 않는다. 라우팅·`trial_scope`·신호 집계가 같은 값을 쓴다. 수동·조직 생성 업무는 `null`이고 시험 범위 밖(fail-closed) | 스키마 열 1개 추가(§4) |
| B-D2 | **trial은 lifecycle로만** | 시험 변경은 `role`·`org_unit` 행의 `lifecycle='trial'`로 현재 `active` `org_version` 아래에서 살고, 새 `org_version` 스냅샷은 `active` 확정 때 한 번만 만든다. `org_version.status='trial'`은 쓰지 않는 값으로 남긴다 | ADR-0011 §3·state-machines 문구와 일치. 스키마 변경 없음 |
| B-D3 | **제안은 가짜 조직 관리팀 어댑터가 만든다** | 호스트가 계산한 신호를 업무 입력으로 받아 결정적으로 후보 diff를 내는 가짜 어댑터. A6이 가짜 LLM 검증기·가짜 기획 어댑터로 주간 사이클을 검증한 것과 같은 방식이고, 실제 모델은 Q22 뒤에 어댑터만 바꿔 끼운다 | "사용자와 대화하며 만든다"(ADR-0011 §5)는 Phase B에서 검증되지 않는다(§8 한계) |
| B-D4 | **시험 기본값 = 14일 / 관측 6건 / 연장 1회** | `trial_min_days=14`(스키마 기본값 그대로), `min_observations=6`, `max_extensions=1`. 모두 정책 파라미터로 두고 인스턴스에서 바꾼다. 기간·관측 둘 중 하나라도 미달이면 `inconclusive` | [Q11](../open-questions.md)·[Q16](../open-questions.md) 해소, 정책 형식 v2 키 추가(§4) |

### 설계 해석 (사용자 결정이 아닌, 이 문서가 정하는 것)

1. **조직 시험과 전략 실험은 동시에 진행할 수 있다.** 금지하면 조직 변경 한 건마다 주간 사이클(이 시스템의 주된 산출)이 2주 이상 멈춘다. 대신 조직 시험의 판정 지표는 **과정 지표만** 쓰고(아래 2), 겹친 기간의 `strategy_version` id를 `org_trial_result.metrics`에 남겨 귀속이 섞였음을 기록한다.
2. **조직 시험 지표 = 과정 지표 5개.** ① 검증 통과율(`evaluation.outcome='pass'` ÷ 판정된 업무) ② 업무당 사람 개입 시간(`cost_entry.category='human_time'`의 분 ÷ 업무) ③ 업무당 비용(USD) ④ 안전성 실패 수(`evaluation.safety='fail'`) ⑤ 재시도율(`attempts>1` 비율). 사업 성과 신호(랜딩 전환, Q5)는 **쓰지 않는다** — 같은 기간의 전략 실험과 교란되고, 조직 변경의 효과는 1주 전환 수로 나타나지 않는다.
3. **위험 등급별 승인 절차.** `change_class='risky'` 제안은 ADR-0006의 위험 변경 절차(`risky_change`: 승인자 수·cooldown·TOTP)를, `normal`은 사람 1인 승인(`humanApprovalParams`)을 쓴다. A3의 "위험 변경 절차는 외부 부작용과 정책 변경에만"(ADR-0006 Amendment)은 정책 *판정*의 `require_approval`에 대한 범위 제한이고, 조직 제안의 등급은 ADR-0011 §2 표가 정한다. ADR-0006에 Amendment 한 단락으로 적는다.
4. **조직 제안은 루틴을 새로 선언하지 않는다.** 루틴·업무 템플릿의 선언은 팩이 유일한 출처다(ADR-0012). 제안은 역할·부서·라우팅을 바꾸고 **이미 선언된 루틴을 켜거나 끄는 것**까지만 할 수 있다. 팩 로더의 "켜진 루틴은 파일 수정으로 못 바꾼다"(A6-U10) 규칙과 충돌하지 않는다.
5. **신호는 호스트가 계산해 업무 입력으로 넣는다.** 조직 관리팀 역할에게 DB 읽기 도구를 주지 않는다. U13의 측정 값, U11의 선행 결과와 같은 방식이고, 그래서 고정 코어는 "접근 불가"가 아니라 "접근 경로가 없음"이 된다.

## 3. ADR-0011 ↔ A6 구현: 연결점과 충돌

| 항목 | ADR-0011·스키마·문서 | A6까지의 구현 (확인) | 판정 | Phase B 처리 |
|---|---|---|---|---|
| 조직 제안 객체 | `org_proposal` 17열(diff·근거·`base_org_version_id`·`proposal_hash`·`evaluation_plan`·`rollback_plan`·`change_class`·`trial_*`·`expires_at`) | 테이블·행 타입(`OrgProposalRow`)·열거형만 있고 읽고 쓰는 코드 없음 | **연결** (스키마 그대로 쓸 수 있다) | B2에서 `domain/src/org.ts`가 생성·전이 |
| 상태 허용표 | `ORG_PROPOSAL_MACHINE` 11전이, 금지 전이 3줄, 역할 `ROLE_MACHINE` | 허용표와 금지 전이 시험이 이미 있음(`state-machines.test.ts`) | **연결** | 전이 함수만 더한다. 허용표 변경 없음 |
| 승인 엔진 | `approval.subject_kind`에 `org_proposal` 허용(스키마 CHECK·`APPROVAL_SUBJECT_KINDS`) | 승인 엔진의 `ApprovalSubject` = `task|publication|policy_version|strategy_version`. `org_proposal`·`product`는 **처리 경로 없음** | **빈틈** | B3에서 subject·해시·CLI 추가(A6-U15의 `strategy_version` 추가와 같은 모양). 스키마 변경 없음 |
| 두 개의 해시 | `org_proposal.proposal_hash`(diff+기준 버전)와 `approval.subject_hash` | 전략은 `strategySubjectHash`(본문+범위+승인 시점 정책 버전) 하나만 씀 | **모호** | `proposal_hash` = 내용 동일성(중복 제안·충돌 판정용), `approval.subject_hash` = `proposal_hash` + 승인 시점 정책 버전 id·내용 해시. 전략과 같은 구성 |
| 업무 유형·`trial_scope` | §7 "`trial` 역할은 제안에 명시된 업무 유형만 받는다" | 역할 참조 검증은 `lifecycle ∈ {trial, active}`만 본다(`spec-references.ts`). 정책 게이트 `beforeRun`은 역할 버전·lifecycle을 다시 본다. **`trial_scope`를 보는 코드가 없고, 업무 유형을 담은 열·필드도 없다** | **충돌(미구현 규칙)** | B-D1의 `template_ref`로 유형을 만들고 B4에서 생성 단계·`beforeRun` 양쪽에서 강제 |
| `unassigned` | §5 첫 신호. 허용표에 `(none) → unassigned`, `unassigned → queued`(scheduler) | 생성은 있다(`create.ts`: 역할이 비면 `unassigned`). **`unassigned → queued` 구현 없음.** 역할 이름을 적었는데 없거나 배정 불가면 생성이 *거부*된다(`unknown_role`/`not_assignable`) | **빈틈** | B1에서 라우팅(유형 → 역할)을 두어 "맞는 역할 없음"이 거부가 아니라 `unassigned`가 되게 하고, B4에서 배정 경로를 만든다. 이름을 적었는데 없는 역할은 지금처럼 거부(오타를 조용히 삼키지 않는다) |
| 조직 버전 | §6 업무는 생성 시점 `org_version_id`·`role_version`을 기록. "확정마다 `org_version`" | 시드가 v1(`active`) 1건을 만들고 `create.ts`가 활성 버전을 읽어 업무에 기록한다. **새 버전을 만드는 코드 없음** | **연결 + 빈틈** | B6에서 diff 적용 → 새 `org_version`(스냅샷·`parent_id`·`proposal_id`) |
| 시드 조직 | §1 시작 조직 = 오너 + 조직 관리팀 + 범용 역할 | 시드는 오너 + `core` + `generalist@v1` + `registration-verifier@v1`. **`org-management` 역할이 없다**(Phase A Amendment가 의도적으로 뺐다) | **빈틈(의도된 것)** | B2에서 `org-management@v1`(도구 요청 없음)과 에이전트 actor를 시드에 더한다. 시드 내용 변경 → 시드·드리프트 시험 갱신 |
| 시험 판정 | §4 평가기가 판정, `org_trial_result`(outcome·abort_reason·observations·metrics) | 테이블만 있음. 업무 평가기(`task-evaluator@v1`)·비용 집계(`experimentCost` 선례)·측정 신호 조회기는 있다 | **연결** | B5에서 `evaluation/src/org-trial.ts`. 업무 평가기의 판정 규칙은 건드리지 않는다 |
| 즉시 중단 | Amendment 1·evaluation §4 (안전성 위반·예산 초과·심각한 품질 저하는 기간 무관) | 업무 단위 예산 초과 취소는 있다(A4·A5). **시험 단위 비용 상한 감시는 없음** | **빈틈** | B5에서 시험 범위 업무의 원장 합계를 매 advance 에 보고 `evaluation_plan.cost_cap`을 넘으면 중단 |
| 롤백 | Amendment 4·state-machines 롤백 표(버전·루틴·대기 업무·진행 업무·외부 부작용) | 조립 요소는 있다: 루틴 `enabled=0`(`endExperiment` 선례), 업무 전이(`transitionTask`), 외부 부작용의 사람 확정(`resolve-effect`, 62056a6), `compensation_ref` 열 | **연결 + 빈틈** | B6에서 `rollback_plan` 형식 검증(없으면 `trial` 진입 거부)과 집행기 |
| `inconclusive` | 2026-10-21 결정: 재시험 승인 전까지 종료 취급, 상태 추가 없음 | 허용표·문서에 반영됨. 전략 실험의 `inconclusive` 처리(사람이 `reject`)가 선례 | **연결** | B5에서 같은 모양(재시험 승인 = `inconclusive → trial`, `trial_extensions` 증가, 상한 B-D4) |
| 만료·충돌 | `expires_at` 경과 → `expired`, 승인 시점 기준 버전 불일치 → `superseded` | 구현 없음. `routine`·`retry_wait` 쓸기(sweep)가 데몬 tick에 있는 선례 | **빈틈** | B3에서 승인 트랜잭션 안의 충돌 검사 + 사이클의 만료 쓸기 |
| 재편 신호 | §5 신호 5개 | 데이터는 모두 있다: `task.status`·`role_id`, `task_transition`, `evaluation`, `cost_entry`(`human_time`). 집계 코드는 없음 | **연결** | B1에서 읽기 전용 집계 |
| 신호 임계값 | [Q13](../open-questions.md) 초기 운영 데이터로 보정 | 없음 | **열림** | B1에서 데몬 설정 `org_cycle`의 기본값으로 두고 Q13은 운영 데이터 뒤로 남긴다(제안 생성 수만 좌우하므로 정책 등급이 아니다) |

## 4. 선행 조건

### Phase B를 막는 것 (B 착수와 함께 닫는다)

| 항목 | 이유 | 닫는 단계 |
|---|---|---|
| 스키마 열 `task.template_ref` (B-D1) | 업무 유형이 없으면 `trial_scope`·라우팅·유형별 신호를 만들 수 없다 | B1. `docs/schema/schema.sql`과 `migrations/0001_init.sql`을 함께 고친다(첫 공개 릴리스 전 규칙, 드리프트 시험 유지) |
| 정책 형식 v2 키 `org_trial.{min_days, min_observations, max_extensions, cost_cap_usd}` (B-D4) | 시험 기간·연장 상한은 정책이 정한다([evaluation §4](../operations/evaluation.md)) | B1. 정규화 문서가 바뀌므로 시드 `policy_version.content_hash`와 `policy-document`·`seed` 시험을 함께 고친다([ADR-0013](../adr/0013-policy-format.md) Amendment) |
| 루틴을 켜고 끄는 운영 경로 ([phase-a 열린 항목 ②](phase-a.md#남은-열린-항목-phase-a-전체)) | 조직 관리팀 루틴을 켜야 신호·제안이 돌고, 롤백이 루틴을 끌 수 있어야 한다. 지금은 실험 승인 경로뿐이고 시험은 DB를 직접 고친다 | B1. 승인 CLI `enable-routine`/`disable-routine`(사람 1인 + event 기록) |
| 시드에 `org-management@v1` | ADR-0011 §1 시작 조직 | B2 |
| 승인 엔진의 `org_proposal` subject | 승인 없는 적용 경로를 만들지 않으려면 승인 엔진을 지나야 한다 | B3 |

### Phase B를 막지 않는 것 (열린 채로 둔다)

- [Q22](../open-questions.md) 실제 검증·실행 모델: 가짜 어댑터·가짜 LLM 검증기로 진행한다(B-D3, A6과 같다).
- Phase A 종료 조건 4(상품 등록 업무 수행 준비)와 열린 팩 템플릿 문제(`expected_quotes`·`validation.llm`, 열린 항목 ①): 조직 흐름과 무관하고 시험은 팩 사본을 쓴다.
- Q14 후속(실제 부작용 어댑터), Q17(기억 기본 만료), Q27(평가기 교체 절차), Linux 운영 실측: Phase B의 선행이 아니다. 단 Q27은 B5가 "평가기가 판정한다"를 구현하면서 다시 보게 되므로 결정 시점을 B5로 당기는 것이 좋다(제안).
- [Q12](../open-questions.md) 대화 채널: B-D3로 **일부 해소**한다 — Phase B의 채널은 승인 CLI(소켓)이고, 대화 내용은 저장하지 않는다. 남는 것은 제안의 `rationale`·근거 참조(호스트가 확인한 신호)와 사람의 승인·거절 사유, 그리고 시험 결과에서 나온 `lesson` 기억 항목뿐이다(`memory_kind` 추가 없음).

## 5. 단계 분할

| 단계 | 주 패키지 | 내용 | 선행 |
|---|---|---|---|
| B1 | `domain`·`task-engine`·`evaluation`·`apps` | 선행 조건 닫기(스키마 열, 정책 v2 키, 루틴 on/off CLI), 업무 유형(`template_ref`) 채우기, 유형 → 역할 **라우팅**과 `unassigned` 생성, 재편 **신호** 읽기 전용 집계 | 없음 |
| B2 | `domain`·`agent-runtime`·`evaluation`·`packs` | 시드 `org-management@v1`, 가짜 조직 관리팀 어댑터, 검사 `org_change_candidates`, 신호를 입력으로 받는 팩 템플릿·루틴, 제안 객체 생성(`org_proposal` `proposed`) | B1 |
| B3 | `policy`·`apps` | 승인 대상 `org_proposal`(해시·등급별 절차), 기준 버전 **충돌 검사**(`superseded`), 만료 쓸기(`expired`), 거절·취소, 승인 CLI 명령 | B2 |
| B4 | `task-engine`·`policy`·`apps` | `approved → trial` 적용(diff → `lifecycle='trial'` 행·라우팅 반영·루틴 켜기), `trial_scope` 강제(생성 단계 + `beforeRun`), `unassigned → queued` 배정 | B3 |
| B5 | `evaluation`·`domain`·`apps` | 기준선·관측·데이터 품질, 즉시 중단 감시, `org_trial_result` 기록, `trial → active`(사람 확인) / `rolled_back` / `inconclusive`, 재시험 승인 | B4 |
| B6 | `domain`·`task-engine`·`apps` | 확정: diff 적용 → 새 `org_version`. 롤백: 버전 복구·루틴 끄기·대기 업무 재라우팅·진행 업무 처리·외부 부작용 보상 경로 | B5 |
| B7 | 전부 | 되먹임(`lesson` 기억 → 다음 주 업무·전략), 통합 시나리오(가짜·다중 프로세스), §6 필수 테스트 재확인, CI 통과, Phase B 완료 기록 | B1~B6 |

의존 근거: 신호(B1)가 없으면 제안의 근거가 대화 인상이 된다(ADR-0011 §5 위반). 승인(B3)이 없으면 적용 경로를 만들 수 없다(승인 없는 적용 경로를 두지 않는다). 판정(B5)이 없으면 확정(B6)의 전제인 "평가 pass"가 없다.

경계는 Phase A와 같다: `domain`이 제안 객체·전이·조직 버전을 소유하고, 판정은 `evaluation`이 하고, 업무·루틴 상태 변경은 `task-engine`이 하고, 승인은 `policy`가 하며, 조립과 순서는 `apps/daemon`이 한다. `task-engine`·`policy`·`evaluation` 상호 참조는 그대로 막아 둔다(필요하면 A4의 `TaskValidator`처럼 domain 포트를 둔다).

### B1 — 업무 유형·라우팅·신호

- 산출물: `migrations/0001_init.sql`·`schema.sql`의 `task.template_ref`, 정책 v2 `org_trial` 키와 `policies/default.yaml` 기본값, 승인 CLI `enable-routine`/`disable-routine`, `packages/task-engine/src/routing.ts`(유형 → 역할 해석, 맞는 역할 없으면 `unassigned`), `packages/evaluation/src/org-signals.ts`(신호 5개, 읽기 전용), 데몬 설정 `org_cycle`(임계값), 문서: ADR-0011 §5 신호 정의 표에 쿼리 기준 한 줄씩.
- 라우팅 규칙: 라우팅 표는 `org_version.snapshot` 안에 둔다(새 테이블 없음, 제안 diff가 바꿀 수 있는 대상이며 ADR-0011 §2의 "업무 라우팅"이 일반 승인인 것과 맞는다). 명세가 역할을 적었으면 그대로 쓰고(없는 역할은 지금처럼 거부), 비었으면 유형으로 라우팅하고, 맞는 역할이 없으면 `unassigned`.
- 필수 시험: 유형별·역할별 신호 집계 표 시험(같은 입력 → 같은 값), 신호 조회가 쓰기 0건, 라우팅 표 변경만으로 `policy_decision`이 allow로 바뀌지 않음, 라우팅 실패 → `unassigned`(run·시도 없음), 드리프트·시드 해시 시험 갱신, 루틴 on/off의 사람 1인 확인·에이전트 거부·멱등.
- 완료 기준: 위 시험 통과 + 팩 템플릿이 낸 업무에 `template_ref`가 채워지고 기존 통합 시나리오가 그대로 통과.

### B2 — 조직 관리팀과 제안 생성

- 산출물: 시드 `org-management@v1`(`allowed_tools: []`, `lifecycle='active'`, 조직 관리팀 전용 에이전트 actor), `packages/agent-runtime`의 가짜 조직 관리팀 어댑터(A5 어댑터 계약·계약 시험 스위트 통과), `packages/evaluation/src/org-candidates.ts`의 결정론적 검사 `org_change_candidates`, `packs/example-marketing/workflows/org-change-proposal.json`과 루틴(주 1회, `enabled=0`), `packages/domain/src/org.ts`의 `proposeOrgChange`.
- 후보 형식(검사 대상): `{id, kind: 'role'|'org_unit'|'routing'|'routine_toggle', diff, rationale, evidence_refs[], expected_effect, risk_assessment, evaluation_plan, rollback_plan, trial_scope[], change_class}`. 검사가 보는 것 — diff가 **고정 코어·정책·검증기·평가기를 건드리지 않음**(건드리면 `fail`), `evidence_refs`가 실제 신호 기록·`evaluation`·`task` 통계를 가리킴, `trial_scope`의 유형이 알려진 템플릿 유형임, 새 역할의 `allowed_tools`가 정책 판정 없이는 아무 권한도 아니라는 표시가 들어감, `evaluation_plan`·`rollback_plan` 필수 항목 완비. 위반은 `fail`(에이전트 보고를 믿지 않는다).
- 호스트가 정하는 값(어댑터가 못 정함): `base_org_version_id`(현재 활성 버전), `proposal_hash`, `expires_at`(기본 14일), `proposed_by`, `change_class`의 최종 등급(정책 판정으로 재계산해 어댑터 신고보다 엄격한 쪽을 택한다), 멱등 키(제안 생성 업무 id + 후보 id의 결정적 해시 — A6-U14의 전략 제안과 같은 방식).
- 필수 시험: 고정 코어를 건드리는 후보는 `fail`, 지어낸 근거 참조는 `fail`, 어댑터가 `change_class='normal'`로 신고해도 권한 확대 diff면 호스트가 `risky`로 올림, 같은 기획 업무를 다시 돌려도 제안이 늘지 않음, 신호가 임계값 아래면 후보 0개·제안 없음, 어댑터 계약 스위트 통과(주입 문장이 든 신호가 와도 도구 호출·정책 판정이 대조와 같음).

### B3 — 승인과 충돌 검사

- 산출물: `policy/src/approval.ts`의 `orgProposalSubject`·`orgProposalSubjectHash`·`verifyOrgProposalApproval`, `engine.ts`의 `kind: 'org_proposal'`(show/approve/reject/cancel/list), 등급별 파라미터 선택(해석 3), `apps/daemon/src/approve.ts`의 `proposals`·`org-signals` 목록과 `approve org <id>`, 사이클의 만료 쓸기.
- 규칙: 승인은 사람만(`actor.kind='human'`), 에이전트의 승인 시도는 인증 단계에서 실패. 승인 **트랜잭션 안에서** `base_org_version_id`를 현재 활성 버전과 대조해 다르면 `proposed → superseded`로 옮기고 승인을 남기지 않는다. `expires_at` 경과는 시스템이 `expired`. `approved`는 실행 허가가 아니다(`trial` 진입은 B4의 별도 단계).
- 필수 시험(overview §6 "조직 변경" 행): 오래된 기준 버전의 제안이 승인 시점에 충돌로 검출되고 `approval` 행이 남지 않음, 내용이 바뀌면 해시 불일치로 승인 무효, `risky` 제안은 cooldown·TOTP·승인자 수를 거치고 `normal`은 1인, 자기 승인은 `min_approvers` 규칙, 만료 제안은 승인 불가, 에이전트의 모든 명령 거부(기록 없음), 두 데몬이 동시에 쓸기를 돌려도 전이 1회.

### B4 — 시험 적용과 범위 제한

- 산출물: `task-engine/src/org-apply.ts`(`approved → trial`: diff를 `lifecycle='trial'` 행과 라우팅으로 적용, 제안이 지정한 루틴 켜기, 활성화 event `org-trial-start:<제안 id>` 멱등), `trial_scope` 강제(생성 단계 참조 검증 + `policy/src/gate.ts`의 `beforeRun` — 역할 lifecycle·버전을 이미 보는 자리), `unassigned → queued` 배정(라우팅 재해석 또는 사람 CLI), 사이클 연결.
- 규칙: `trial` 역할은 제안의 `trial_scope` 유형만 받고, 범위 밖 업무는 기존 조직으로 라우팅된다(state-machines 규칙). `trial` 진입 전에 `evaluation_plan`·`rollback_plan`이 완비되어야 한다(없으면 거부, 상태는 `approved`로 남는다). 적용은 승인 트랜잭션 밖에서 한 번만 하고(A6-U15의 활성화와 같은 복구 구조: "승인됐으나 적용 기록 없음"을 매 advance가 본다) 적용 직전에 승인을 다시 확인한다.
- 필수 시험(overview §6 "권한" 행의 B 몫): 제안으로 만든 `trial` 역할이 요청한 도구가 정책 없이는 deny, `trial_scope` 밖 유형의 업무는 그 역할에 배정되지 않음, `template_ref`가 `null`인 업무는 시험 범위에 들어가지 않음, 적용 멱등(두 데몬 동시 advance → 1회), 적용 직전에 취소된 승인은 적용되지 않음, 정책이 강화되면 범위 내 업무가 실행 직전 재판정으로 막힘.

### B5 — 독립 평가와 판정

- 산출물: `evaluation/src/org-trial.ts` — 기준선(변경 전 같은 지표, 같은 유형·같은 기간 길이), 관측 수(시험 범위에서 판정까지 간 업무 수), 데이터 품질 조건, 과정 지표 5개(해석 2), 즉시 중단 감시(안전성 실패 1건 이상·`cost_cap` 초과·품질 급락), `org_trial_result` 기록, 판정 `pass|fail|inconclusive`. `domain/src/org.ts`의 전이(`trial → active`는 사람 확인 필요, `rolled_back`·`inconclusive`는 평가기·시스템), 재시험 승인(`inconclusive → trial`, `trial_extensions` 증가, 상한 1회), 승인 CLI `org-reviews`·`promote org <id>`·`reject org <id>`.
- 규칙: 조직 관리팀은 `org_trial_result`를 쓸 수 없다(쓰기 주체 검사). 판정은 평가기(고정 코어)가 하고, 전이는 판정 기록을 대조한 뒤에만 한다(A4의 "evaluation은 판정만, 전이는 엔진" 구조). 기간 경과 + 관측 ≥ 6이 아니면 `inconclusive`, 즉시 중단 조건은 기간과 무관하게 `fail`(+`abort_reason`). `active` 승격은 자동이 아니고 사람이 사유와 함께 한다(전략 승격과 같은 신뢰 수준, TOTP 없음).
- 필수 시험(overview §6 "시험 평가" 행): 관측 수 미달 → `inconclusive`(승격 불가), 데이터 품질 불량 → `inconclusive`, 안전성 실패 → 기간 무관 `fail`·`abort_reason='safety'`, 시험 비용이 상한을 넘으면 즉시 중단, `inconclusive`가 성공 사례(`lesson`/`strategy_record`)로 기록되지 않음(규칙 8), 조직 관리팀 actor의 판정 기록 시도 거부, 재시험 승인이 상한을 넘으면 거부, 기준선이 없으면 `inconclusive`.

### B6 — 확정과 롤백

- 산출물: `domain/src/org.ts`의 `confirmOrgChange`(diff를 기준 버전에 적용해 새 `org_version` 행 + 스냅샷 + `parent_id` + `proposal_id`, `trial` 행 → `active`), `task-engine/src/org-rollback.ts`(롤백 집행: 직전 버전 복구, 새 역할 `retired`, 그 역할이 켠 루틴 `enabled=0`, `queued`·`unassigned` 업무 재라우팅, `running` 업무는 계획대로(기본은 안전한 지점에서 종료), `external_effect`는 `compensation_ref`가 있으면 보상 업무 생성·없으면 사람 처리 요청), 사이클 연결, 롤백 기록 event.
- 규칙: 조직 변경은 JSON 덮어쓰기가 아니라 **승인된 diff를 기준 버전에 적용**하는 것이다. 역할 폐지는 삭제가 아니다(과거 업무의 `role_id`·`role_version`·`org_version_id`가 가리키는 기록 보존). 이미 발생한 외부 부작용은 자동 복구되지 않는다.
- 필수 시험(overview §6 "롤백" 행): 롤백 후 활성 버전이 직전 버전이고 새 역할이 `retired`(행은 남음), 그 역할이 켠 루틴이 꺼지고 다음 tick에 발화 없음, 대기 업무가 기존 역할로 재라우팅되거나 `unassigned`로 돌아감, 진행 중 업무가 계획대로 처리됨, 이미 보낸 외부 부작용은 되돌아가지 않고 보상 업무 또는 사람 처리 요청으로 남음(둘을 구분해 기록), 과거 업무의 조직·역할 버전 참조가 롤백 뒤에도 그대로 조회됨, `rollback_plan`이 없으면 `trial` 진입 자체가 거부됨.

### B7 — 되먹임과 통합 시나리오

- 산출물: 시험 결과 → `memory_item`(`kind='lesson'`, `source_ref=org_trial_result:<id>`, `trust_origin='internal'`, 시스템이 계산한 지표와 사람의 결정 사유만 담고 에이전트 문장은 복사하지 않음), 다음 주 조직 관리팀 업무의 입력에 직전 `lesson` 참조(U16의 `memory:latest#...`와 같은 방식), 통합 시나리오 2개(가짜 어댑터 전 구간, 다중 프로세스 복구·중복), Phase B 완료 기록.
- 통합 시나리오가 봐야 하는 것: 신호 → 제안 → 승인 → 적용 → 범위 내 업무 실행 → 판정 → (a) 승격 경로와 (b) 롤백 경로, 그리고 조직 시험과 전략 실험이 겹친 주에 `org_trial_result.metrics`에 겹친 전략이 기록되는 것.
- 완료 기준: §6 표 통과 + 원격 CI 성공 + 기존 Phase A 시험(단위·통합·경계) 무회귀.

## 6. 필수 테스트 매핑 (overview §6의 Phase B 행)

| 영역 | 필수 테스트 | 주 패키지 | 단계 | 완료 기준 |
|---|---|---|---|---|
| 조직 변경 | 오래된 기준 버전의 제안은 충돌 검출 | `policy`·`domain` | B3 | 승인 시점에 `base_org_version_id` ≠ 현재 활성 버전이면 `superseded`로 가고 `approval` 행이 남지 않는다. 내용이 바뀌면 해시 불일치로 승인이 무효가 된다 |
| 시험 평가 | 증거가 부족하면 `inconclusive`, 즉시 중단 조건 | `evaluation` | B5 | 기간 경과 + 관측 < 6 또는 품질 불량이면 `inconclusive`이고 승격이 불가하다. 안전성 위반·비용 상한 초과는 기간을 기다리지 않고 `fail`(`abort_reason`)이다 |
| 롤백 | 조직 버전 복구와 이미 발생한 부작용을 구분, 예약 루틴·진행 업무 처리 | `domain`·`task-engine` | B6 | 버전·역할·루틴·대기 업무는 복구되고, 이미 발생한 외부 부작용은 보상 업무 또는 사람 처리 요청으로 남는다(자동 복구 없음). 과거 업무의 책임 이력이 보존된다 |
| 권한(정책) | 역할 생성·라우팅 변경만으로 권한 확대 불가 (B: 역할 생성 경로) | `policy` | B4 | 제안으로 만들어진 `trial` 역할이 요청한 도구가 정책 없이는 deny이고, `trial_scope` 밖 업무는 배정되지 않는다 |

추가로 B7에서 Phase A의 §3 표(9개 영역)가 조직 변경 뒤에도 그대로 통과하는 것을 통합 시나리오로 확인한다(조직이 바뀌어도 복구·중복 방지·승인·평가 독립성·비용·게시·기억 규칙은 같다).

## 7. Phase B 종료 조건

1. §6 표의 테스트가 모두 CI에서 통과하고, Phase A의 §3 표가 무회귀로 통과한다.
2. 신호 → 제안 → 승인 → 시험 → 판정 → 확정 사이클이 가짜 어댑터로 끝까지 1회, **롤백 경로가 1회** 실행된다(둘 다 다중 프로세스 복구 포함).
3. Q11·Q12·Q13·Q16의 결정·범위가 `open-questions`와 ADR-0011·ADR-0006·ADR-0013·`operations/evaluation.md`·`schema/state-machines.md`에 반영된다.
4. 조직 변경이 권한을 늘리지 못함이 **제안 경로로** 재확인된다(overview §6 "권한" 행의 B 몫).

## 8. 가장 약한 부분 3가지와 먼저 드러나는 곳

1. **기준선 데이터가 거의 없다.** 조직 시험의 판정은 "변경 전 같은 지표"와의 비교인데, 시드 이후 쌓인 업무 이력이 짧고 주당 업무가 몇 건뿐이라 기준선이 통계적으로 빈약하다. 거의 모든 시험이 `inconclusive`로 끝날 수 있다. → **B5의 판정 시험과 B7 통합 시나리오에서 먼저 드러난다**(관측 6건을 모으는 데 몇 주가 걸리는지, `inconclusive` 비율). 대비: 시나리오는 가짜 시계로 주를 앞당기고, 실제 운영에서는 `min_observations`를 인스턴스 정책으로 낮출 수 있게 둔다.
2. **업무 유형이 팩 템플릿에 묶여 있다.** `template_ref`를 유형으로 쓰면 조직 관리팀이 만든 새 역할이 받을 **새 유형**을 표현할 길이 없다(템플릿 선언은 팩만 한다, 해석 4). 새 역할은 기존 유형을 나눠 받는 변경만 시험할 수 있다. → **B4에서 `trial_scope`에 넣을 유형이 없는 제안을 만들 때 드러난다.** 대비: B2의 검사가 "알려진 유형만"을 요구하므로 이런 제안은 `fail`로 걸러지고, 새 유형이 필요한 변경은 팩 변경(사람의 코드 리뷰)과 묶인다는 것을 문서에 남긴다.
3. **조직 시험과 전략 실험의 귀속이 섞인다.** 과정 지표만 쓰더라도 사람 개입 시간·비용은 두 변경이 공유한다(해석 1). 조직 변경이 좋았는지 전략이 좋았는지 구분하지 못한 채 `pass`가 날 수 있다. → **B5의 지표 대조와 B7의 "겹친 주" 시나리오에서 드러난다.** 대비: 겹친 전략 id를 `metrics`에 남기고, 승격은 사람이 사유와 함께 하도록 둔다(자동 승격 없음).

같은 성격의 알려진 한계: B-D3을 택했으므로 "조직 관리팀이 사용자와 대화하며 제안을 만든다"(ADR-0011 §5)는 Phase B에서 검증되지 않는다. 검증되는 것은 제안 객체·근거·승인·시험·판정·롤백의 기계적 흐름이다.

## 9. 확정하지 못한 것 (추정 표시)

- **(추정) 주당 관측 수.** B-D4의 `min_observations=6`은 출하 팩의 루틴 선언(주간 기획 루틴이 조사·기획 2건, 주간 시장 조사 1건, 결과 검토 업무가 간헐적으로 1건)에서 "주 2~3건"을 읽어 2주분으로 잡은 값이다. 인스턴스에서 켠 루틴이 다르면 값이 달라지므로 정책 파라미터로 둔다. 실제 분포는 B7 통합 시나리오에서 처음 측정된다.
- **(추정) 즉시 중단의 "심각한 품질 저하" 기준.** evaluation §4는 항목만 적고 임계값이 없다. B5에서 "시험 범위 업무의 검증 통과율이 기준선의 절반 이하"를 기본값으로 제안하되, Q13과 함께 운영 데이터로 보정한다.
- **(미확인) Postgres 이식.** 조직 쪽 쿼리(스냅샷 JSON, `json_each` 기반 집계)도 Phase A와 같이 SQLite에서만 확인한다.
- **열린 채로 두는 것:** Q13(신호 임계값, 운영 데이터 뒤), Q22, Q17, Q27(B5에서 다시 볼 것을 제안), Q14 후속, Linux 운영 실측.
