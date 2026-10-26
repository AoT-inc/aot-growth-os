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
증거:    evidence, cost_entry, approval, human_reauth
평가:    evaluation (quality / effect / economics / safety)
기억:    memory_item (kind, validity, superseded_by)
공개:    publication
통화:    call ─ call_artifact(transcript, outcome)   (이벤트는 event, source='phone', 증거는 evidence)
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

- `approval.decided_by`는 `actor.kind='human'`만. `approval`은 승인 엔진(`@aot/policy`)만 쓰며, 취소·거절은 기존 행을 고치지 않고 새 행(`rejected`)으로 남긴다. 승인 확인은 `subject_hash`가 지금 대상의 해시와 같은 행만 센다.
- `human_reauth`(위험 변경 재인증)는 승인 엔진만 쓰고 TOTP 비밀·코드는 남기지 않는다. 같은 사람의 같은(또는 이전) 시간창은 다시 받지 않는다.
- `approval.subject_kind`: 업무 실행(`task`), 전략·정책 버전, 게시, 도구 호출, 상품 등록(`product`, `product.registration_approval_id`가 가리킴), 조직 제안(`org_proposal`, `proposed → approved`).
- `completed` 전이는 검증기 주체만, 그리고 해당 업무의 최신 `evaluation.safety='pass'`일 때만.
- `publication.audience != 'internal'`이고 `status='published'`이면 `approval_id` 필수.
- 조직 변경은 `org_proposal` 승인 없이 `org_unit`/`role`/`org_version`에 쓸 수 없다. 조직 관리팀 역할은 정책·검증기·평가기를 대상으로 하는 제안을 만들 수 없다.
- 에이전트는 `policy_version`, `approval`, `task.status`, `memory_item(kind != 'hypothesis')`에 쓰기 불가.
- `evidence.trust_origin`은 필수(NOT NULL, 기본값 없음)이고 `memory_item.trust_origin`과 같은 어휘(`internal`, `external_untrusted`)만 허용한다. 외부 페이지·문서에서 읽은 근거는 `external_untrusted`이며, 이런 근거에서 만든 기억 항목은 신뢰된 것/사실로 편입되지 않는다([memory-item](memory-item.md) 규칙 9). 에이전트(어댑터)가 낸 근거는 어댑터가 무엇을 밝히든 호스트가 `external_untrusted`로 저장한다.
- `evaluation.outcome='pass'`는 `primary_evidence_refs`가 비어 있지 않아야 하며 에이전트 보고서만으로는 불가.
- `org_trial_result`는 평가기만 쓸 수 있다. 조직 관리팀은 쓰기 불가.
- 외부 부작용은 `external_effect`를 `planned`로 기록한 뒤에만 전송한다. `planned_at`은 INSERT 때만 쓰고, `idempotency_retention_ms`는 INSERT 때 (도구, action) 선언의 스냅숏이며 강화(짧게·미지원으로)만 된다. `unknown → dispatched`(같은 키 재전송)는 `supports_idempotency=1`이고 `planned_at`부터 `idempotency_retention_ms`의 50% 이내일 때만 가능하다([recovery §3](../operations/recovery.md)).
- `call.status`는 canonical 상태이며 provider 값이 아니다. 상태는 시스템(`applyPhoneEvent`)만 바꾸고 뒤로 가는 이벤트는 기록만 한다([state-machines](state-machines.md)). 에이전트는 `call`·`call_artifact`에 쓸 수 없고, 통화 결과(`call_artifact.kind='outcome'`)는 한 번만 기록된다(같은 내용 재기록은 흡수, 다른 내용은 거부). 상대방의 말에서 나온 산출물은 `trust_origin='external_untrusted'`, 사람이 직접 기록한 결과만 `internal`이다. `call.intent_key`(번호·목적·맥락의 해시)는 같은 업무의 같은 의도 통화 중복 방지에 쓴다. `event(source='phone')` payload에는 전화번호와 발화 내용을 넣지 않는다. provider 원본 payload·녹음은 저장하지 않는다.
- append-only 테이블(`task_transition`, `cost_entry`, `policy_decision`, `human_reauth`)은 UPDATE/DELETE 금지.

## 미반영 (후속)

- 벡터/전문 검색 인덱스 (memory)
- 권한 모델 상세(RBAC/ABAC). 정책 형식은 [ADR-0013](../adr/0013-policy-format.md)
- 비용 집계 뷰, 제품별 P&L 뷰
- 개인정보/고객 데이터 분류와 보존 기간
