# Phase B 구현 계획 (적응형 조직 검증 = MVP의 마지막 단계)

작성 2026-11-04. 근거: [overview §6](../00-overview.md), [ADR-0011](../adr/0011-adaptive-organization.md), [state-machines](../schema/state-machines.md), [evaluation](../operations/evaluation.md).
Phase A(실행 기반)는 끝났다. 이 문서의 단위(B1~B6)가 끝나면 overview §6의 MVP 필수 테스트(조직 변경·시험 평가·롤백 + 권한 확대 불가)가 통합 시험으로 닫힌다.

## 사용자 부재 중 정한 잠정 결정 (사용자가 바로잡을 수 있다)

사용자가 "MVP까지 자동 진행"을 지시했다(2026-11-04). 아래는 그때 사람 결정이 비어 있던 항목을 **보수적인 쪽으로** 정한 것이다. 코드는 정책 파라미터·상수 한 곳에 두어 바꾸기 쉽게 한다.

| 항목 | 잠정 결정 | 이유 |
|---|---|---|
| Q11 시험 기간 | 기본 최소 14일(`trial_min_days`, 제안마다 지정), 시험 중 영향 범위 = 제안의 `trial_scope.task_types`에 든 업무 유형만 | ADR 가정값 그대로 |
| Q16 연장 상한 | `inconclusive → trial` 재시험은 제안당 **1회**(`trial_extensions ≤ 1`), 사람 승인·새 평가 계획 필수 | 자동 연장 금지 원칙의 가장 좁은 해석 |
| Q12 조직 관리팀 대화 채널 | **MVP 밖.** 제안은 승인 채널 명령(`org propose`, 파일로 받은 JSON)으로만 낸다. 재편 신호 보고(`org signals`)는 결정론적 집계이며 모델 호출이 없다 | 대화형 에이전트는 MVP 검증 변수를 늘린다 |
| Q13 재편 신호 임계값 | `unassigned` 업무 ≥ 3건, 역할별 `needs_review`+`failed` ≥ 3건(최근 30일) 이상일 때 후보로 표시 (상수 `ORG_SIGNAL_THRESHOLDS`) | 초기값, 운영 데이터로 보정 |
| 업무 유형(task type) | 루틴이 만든 업무 = 트리거 ref 의 `@` 앞 이름(루틴 slug), 그 밖의 업무 = `manual` (`taskTypeOf`). 스키마·업무 명세는 바꾸지 않는다 | 새 필드를 만들지 않기 위한 파생값 |
| 제안 diff 연산 | `add_role` 하나(새 부서는 `add_role`이 새 부서를 가리킬 때만 만들어진다). 역할 폐지는 확정된 제안의 `active → retired`(사람)로 한다. 새 역할이 요청하는 (도구, 작업)이 지금 active 역할 어디에도 없으면 `risky` | `unassigned` 신호의 직접 대응. 폐지 연산을 따로 두면 시험 의미(무엇을 평가하나)가 불분명해진다 |
| 위험 변경 | `change_class='risky'` = 승인에 정책의 `risky_change` 파라미터(대기·TOTP 재인증)를 쓴다. 분류는 제안 생성 시 코드가 정하고 제안자가 낮출 수 없다 | ADR-0011 §2 |
| 시험 판정 | 기준선 = 시험 전 같은 업무 유형의 끝난 업무(없으면 최소 통과율만으로 판정: 새 역할이 필요한 업무는 원래 실행자가 없던 업무라 기준선이 없는 것이 흔하다). 성공 = 평가 `pass` 비율; 즉시 중단 = 안전성 실패 1건 또는 비용 초과 | evaluation.md 규칙 |
| `active` 승격 | 평가 `pass` 후에도 **사람 확인**(`org confirm`)이 있어야 한다. 사람 확인 없이는 `trial`에 머문다 | 상태표 |

## 단위

| 단위 | 내용 | 위치 | 완료 기준 |
|---|---|---|---|
| B1 (완료) | 조직 제안 모델: 생성(검증·해시·위험 분류·금지 대상 거부), 전이(`transitionOrgProposal`), diff 적용으로 새 `org_version` 생성, 롤백 | `packages/domain/src/org/` | 단위 시험: 금지 대상·권한 확대 분류·해시 불변·충돌→`superseded`·만료·롤백 계획 필수 |
| B2 (완료) | 승인 엔진에 `org_proposal` 대상: approve/reject/cancel/show/release(위험은 대기+TOTP), 승인 해시 = 제안 해시 | `packages/policy/` | 에이전트 거부·해시 불일치·자기 승인·위험 변경 대기·충돌 시 `superseded` |
| B3 (완료) | 업무 라우팅: `trial` 역할은 `trial_scope` 업무 유형만 받는다. 범위 안 `unassigned` 업무를 시험·활성 역할에 배정(`unassigned → queued`, scheduler) | `packages/domain/src/spec/`, `task-engine` | 범위 밖 업무 거부(`unassigned`), `retired` 역할 배정 거부 |
| B4 (완료) | 시험 평가기: 시험 vs 기준선 비교, `org_trial_result` 기록(평가기만), 즉시 중단 | `packages/evaluation/` | pass/fail/inconclusive, 관측 부족=inconclusive, 안전성 1건=즉시 중단 |
| B5 (완료) | 데몬: `org` 채널(propose·signals·status·confirm·retrial·rollback), 주기 진행(`approved→trial`, 만료, 평가, 롤백 처리) | `apps/daemon/` | 승인 CLI `org ...`, 사람 전용, 알 수 없는 필드 거부 |
| B6 (완료) | 통합 시험: 신호→제안→승인→시험→평가→확정, 실패→롤백(루틴 끔·진행 업무 처리), 충돌, 위험 변경, 권한 확대 불가 | `test/integration/` | overview §6 Phase B 필수 테스트 3행 |

## 하지 않는 것 (MVP 밖)
- 조직 관리팀 대화 에이전트(Q12), 신호 기반 *자동* 제안 생성.
- `update_role`/부서 분할·병합 같은 복잡한 diff, 예산 상향·외부 게시 범위 확대 diff(분류 규칙만 있고 연산은 없다).
- 정책·검증기·평가기·승인 엔진을 대상으로 하는 제안: 항상 거부(ADR-0011 §2).

## 구현 기록 (2026-11-04)

| 단위 | 코드 | 시험 |
|---|---|---|
| B1 | `packages/domain/src/org.ts` | `test/unit/org-proposal.test.ts` |
| B2 | `packages/policy/src/engine.ts` (`org_proposal` 대상: approve·release·cancel·reject·show·list) | `test/unit/policy-org-approval.test.ts` |
| B3 | `packages/domain/src/spec/spec-references.ts`, `packages/task-engine/src/org-routing.ts` | `test/unit/org-routing.test.ts`, `test/unit/seed.test.ts` |
| B4 | `packages/evaluation/src/org-trial.ts` | `test/unit/evaluation-org-trial.test.ts` |
| B5 | `apps/daemon/src/org-cycle.ts`, `org-channel.ts`, `assemble.ts`, `main.ts`, `approve.ts` (`org ...`) | `test/integration/daemon-org-channel.test.ts` |
| B6 | — | `test/integration/daemon-org-lifecycle.test.ts` |

### 사용법 (승인 CLI, 사람 전용)
```
org signals                                  재편 신호 (unassigned 업무 유형별 건수, 역할별 반복 문제)
org propose --file proposal.json             제안 등록 → 응답의 proposal_id
show org <id> / approve org <id> --hash H    승인 (일반 변경: 즉시 approved; 위험 변경: 대기 후 `release org <id> --totp-stdin`)
(데몬 주기)                                    approved → trial, 범위 안 unassigned 업무 배정, 시험 평가, 실패 시 롤백
org status [<id>]                            제안 상태와 시험 판정 기록
org confirm <id> --comment 사유              평가 pass 뒤 사람 확인 → active (자동 승격 없음)
org retrial <id> --file plan.json --comment  inconclusive → trial (1회)
org rollback <id> --comment 사유 / org retire <id> --comment 사유   확정된 변경 되돌리기 / 폐지
```
제안 파일 형식은 `docs/operations/org-change.md`.

### MVP 통과 기준 대응 (overview §6)
| 필수 테스트 | 시험 |
|---|---|
| 권한: 역할 생성이나 라우팅 변경만으로 권한 확대 불가 | `daemon-org-lifecycle` (정책 불변·외부 효과 업무 여전히 승인 필요·위험 변경은 대기+TOTP 없이 시험 불가), `org-proposal` (금지 대상) |
| 조직 변경: 오래된 기준 버전의 제안은 충돌 검출 | `daemon-org-lifecycle` (superseded), `policy-org-approval`, `org-proposal` |
| 시험 평가: 증거 부족 시 `inconclusive`, 즉시 중단 조건 | `evaluation-org-trial`, `daemon-org-lifecycle` |
| 롤백: 조직 버전 복구, 예약 루틴·진행 업무 처리 | `daemon-org-lifecycle`, `org-proposal` |

### 알려진 한계 (MVP 밖으로 둔 것)
- 조직 관리팀 대화 에이전트·자동 제안 생성, `add_role` 외 연산(부서 분할·병합, 예산 상향, 외부 게시 범위 확대 연산)은 없다.
- 시험 중인 제안을 사람이 중단하는 경로는 없다(상태표에 `trial → rolled_back` 주체가 평가기/시스템뿐). 필요하면 상태표 개정을 사용자와 정한다.
- `inconclusive`가 되면 새 역할은 `retired`가 되지만 이미 그 역할에 배정된 대기 업무는 그대로 실행된다(롤백만 대기 업무를 기존 역할로 옮긴다).
- 롤백이 대기 업무를 옮길 때 업무 승인 해시(역할·버전 포함)가 달라져 승인된 업무는 다음 실행 때 재승인 요청(`needs_review`)이 된다.
- 업무 유형은 루틴 slug 에서 파생한다(`manual` 포함). 루틴이 아닌 업무를 유형으로 나누려면 업무 명세에 필드가 필요하다(스키마 결정 필요).
- 시험 평가는 데몬 tick 마다 실행된다. 실제 운영 데이터로 임계값(Q13)·평가 기준을 보정해야 한다.
