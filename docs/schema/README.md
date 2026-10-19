# 데이터 모델 초안

| 파일 | 내용 |
|---|---|
| [schema.sql](schema.sql) | 전체 테이블 DDL 초안 (SQLite, Postgres 이식 가능) |
| [task-spec.md](task-spec.md) | 업무 명세 필드와 예시 |
| [state-machines.md](state-machines.md) | 업무·조직 제안·역할·전략·게시·상품 단계 상태 전이, 금지된 전이 |
| [memory-item.md](memory-item.md) | 기억 항목 속성과 규칙 |
| [product.md](product.md) | 상품·저장소 최소 도메인 모델 |

## 엔터티 그룹

```
조직:    org_unit ─ role ─ role_assignment ─ actor(human|agent)
         org_version, org_proposal  (적응형 조직, ADR-0011)
상품:    product ─ product_repo, product_environment
버전:    policy_version, strategy_version
입구:    event, routine ─ routine_firing
업무:    task ─ task_dependency, task_transition, task_run
증거:    evidence, cost_entry, approval
평가:    evaluation (quality / effect / economics / safety)
기억:    memory_item (kind, validity, superseded_by)
공개:    publication
```

## 첫날부터 넣어야 하는 것 (후행 추가 곤란)

- `event.idempotency_key` UNIQUE, `routine_firing` PK, `task` 활성 dedupe 인덱스
- `task.policy_version_id`, `task.strategy_version_id`, `task.org_version_id`/`role_version`
- `cost_entry` 원장 (업무·실행·상품 단위)
- `task_transition` append-only
- `product_id` 연결 (task, event, cost_entry, memory_item, publication)
- 실행 소유권: `task_run.lease_*`, 활성 run 유일 인덱스, `external_effect.effect_key` UNIQUE
- 승인 스냅샷: `task.approved_hash`, `approval.subject_hash`
- `policy_decision` 판정 기록 (append-only)
- `org_proposal.base_org_version_id`, `org_trial_result`

## 애플리케이션에서 강제할 규칙 (SQL로 표현하지 않은 것)

- `approval.decided_by`는 `actor.kind='human'`만.
- `completed` 전이는 검증기 주체만, 그리고 해당 업무의 최신 `evaluation.safety='pass'`일 때만.
- `publication.audience != 'internal'`이고 `status='published'`이면 `approval_id` 필수.
- 조직 변경은 `org_proposal` 승인 없이 `org_unit`/`role`/`org_version`에 쓸 수 없다. 조직 관리팀 역할은 정책·검증기·평가기를 대상으로 하는 제안을 만들 수 없다.
- 에이전트는 `policy_version`, `approval`, `task.status`, `memory_item(kind != 'hypothesis')`에 쓰기 불가.
- `evaluation.outcome='pass'`는 `primary_evidence_refs`가 비어 있지 않아야 하며 에이전트 보고서만으로는 불가.
- `org_trial_result`는 평가기만 쓸 수 있다. 조직 관리팀은 쓰기 불가.
- 외부 부작용은 `external_effect`를 `planned`로 기록한 뒤에만 전송한다.
- append-only 테이블(`task_transition`, `cost_entry`, `policy_decision`)은 UPDATE/DELETE 금지.

## 미반영 (후속)

- 벡터/전문 검색 인덱스 (memory)
- 권한 모델 상세(RBAC/ABAC)와 정책 DSL
- 비용 집계 뷰, 제품별 P&L 뷰
- 개인정보/고객 데이터 분류와 보존 기간
