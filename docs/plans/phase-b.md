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
| 업무 유형(task type) | 루틴이 만든 업무 = `routine.task_template`에서 `@버전`을 뺀 이름. 그 밖의 업무 = `manual`. 스키마·업무 명세는 바꾸지 않는다 | 새 필드를 만들지 않기 위한 파생값 |
| 제안 diff 연산 | `add_role`, `retire_role`(추가로 `add_unit`은 `add_role`이 새 부서를 가리킬 때만). `allowed_tools` 확대·외부 효과 도구 포함은 `risky` | MVP는 "역할 신설/폐지"가 `unassigned`·반복 실패 신호의 직접 대응 |
| 위험 변경 | `change_class='risky'` = 승인에 정책의 `risky_change` 파라미터(대기·TOTP 재인증)를 쓴다. 분류는 제안 생성 시 코드가 정하고 제안자가 낮출 수 없다 | ADR-0011 §2 |
| 시험 판정 | 비교 기준선 = 시험 전 같은 업무 유형의 완료 업무(없으면 `inconclusive`). 성공 = 평가 `pass` 비율과 안전성; 즉시 중단 = 안전성 실패 1건 또는 비용이 허용치 초과 | evaluation.md 규칙 |
| `active` 승격 | 평가 `pass` 후에도 **사람 확인**(`org confirm`)이 있어야 한다. 사람 확인 없이는 `trial`에 머문다 | 상태표 |

## 단위

| 단위 | 내용 | 위치 | 완료 기준 |
|---|---|---|---|
| B1 | 조직 제안 모델: 생성(검증·해시·위험 분류·금지 대상 거부), 전이(`transitionOrgProposal`), diff 적용으로 새 `org_version` 생성, 롤백 | `packages/domain/src/org/` | 단위 시험: 금지 대상·권한 확대 분류·해시 불변·충돌→`superseded`·만료·롤백 계획 필수 |
| B2 | 승인 엔진에 `org_proposal` 대상: approve/reject/cancel/show/release(위험은 대기+TOTP), 승인 해시 = 제안 해시 | `packages/policy/` | 에이전트 거부·해시 불일치·자기 승인·위험 변경 대기·충돌 시 `superseded` |
| B3 | 업무 라우팅: `trial` 역할은 `trial_scope` 업무 유형만 받는다. 시험 업무에 `org_version_id`·`role_version` 기록 | `packages/domain/src/spec/`, `task-engine` | 범위 밖 업무 거부(`unassigned`), `retired` 역할 배정 거부 |
| B4 | 시험 평가기: 시험 vs 기준선 비교, `org_trial_result` 기록(평가기만), 즉시 중단 | `packages/evaluation/` | pass/fail/inconclusive, 관측 부족=inconclusive, 안전성 1건=즉시 중단 |
| B5 | 데몬: `org` 채널(propose·signals·status·confirm·retrial·rollback), 주기 진행(`approved→trial`, 만료, 평가, 롤백 처리) | `apps/daemon/` | 승인 CLI `org ...`, 사람 전용, 알 수 없는 필드 거부 |
| B6 | 통합 시험: 신호→제안→승인→시험→평가→확정, 실패→롤백(루틴 끔·진행 업무 처리), 충돌, 위험 변경, 권한 확대 불가 | `test/integration/` | overview §6 Phase B 필수 테스트 3행 |

## 하지 않는 것 (MVP 밖)
- 조직 관리팀 대화 에이전트(Q12), 신호 기반 *자동* 제안 생성.
- `update_role`/부서 분할·병합 같은 복잡한 diff, 예산 상향·외부 게시 범위 확대 diff(분류 규칙만 있고 연산은 없다).
- 정책·검증기·평가기·승인 엔진을 대상으로 하는 제안: 항상 거부(ADR-0011 §2).
