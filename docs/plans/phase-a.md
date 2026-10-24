# Phase A 구현 계획

[overview §6](../00-overview.md)의 Phase A(실행 기반 검증, 고정된 최소 조직)를 구현하는 순서와 완료 기준. 코드는 아직 없으며, 이 문서는 착수 전 계획이다. 결정되지 않은 선택은 [open-questions](../open-questions.md)로 연결한다.

## 1. 원칙

- 패키지는 5개(`domain`, `task-engine`, `policy`, `agent-runtime`, `evaluation`)이며 의존 방향은 `domain ← task-engine/policy/evaluation ← agent-runtime ← apps` 단방향이다 ([ADR-0001](../adr/0001-modular-monolith.md)).
- 각 단계는 **그 단계의 필수 테스트가 통과해야** 끝난다. 다음 단계는 앞 단계 통과 후에 시작한다.
- 실제 에이전트 제품에 의존하지 않는다. 단계 A5 전까지는 결정적으로 동작하는 가짜 어댑터와 가짜 외부 도구로 검증한다.
- 테스트 데이터는 가상 값(`example-product` 등)만 쓴다 ([공개 저장소 규칙](../security/public-repository.md)).
- Phase B 항목(조직 관리팀, `org_proposal`, 시험 운영)은 범위 밖이다.

## 2. 구현 순서

| 단계 | 패키지 | 내용 | 선행 |
|---|---|---|---|
| A0 | (저장소) | §4 부트스트랩 체크리스트 | 없음 |
| A1 | `domain` | 엔터티 타입, 상태 전이 허용표, `task_spec` 스키마 검증, 마이그레이션(스키마 DDL 적용), 시드 데이터(조직·역할·`actor`·초기 `policy_version` — `task.policy_version_id`가 NOT NULL이므로 업무 생성 전에 필요), `memory_item` 신뢰·만료 규칙 | A0, [Q23](../open-questions.md)(시드 조직의 등록 검증 역할) |
| A2 | `task-engine` | 업무 생성(멱등), 스케줄러·폴링 데몬, `task_run` lease와 heartbeat, `external_effect` 상태 머신, 데몬 재시작 복구. 스파이크 Q15(lease 파라미터)는 lease 구현 직후 수행하며 결과 기록이 A2 완료 조건에 포함된다 | A1 |
| A3 | `policy` | 7요소 판정과 `policy_decision` 기록, 정책 버전, 승인 엔진(`approved_hash`), 사람 승인 채널([trust-boundaries §3.1](../security/trust-boundaries.md)), 실행 시점 재검증, 게시 게이트 | A1, A2의 전이 훅, [Q6](../open-questions.md)(승인자 구성), [Q7](../open-questions.md)(정책 표현), [Q25](../open-questions.md)(승인 채널 인증) |
| A4 | `evaluation` | 결정론적 검증기, 컨텍스트 분리 LLM 검증 인터페이스, 평가기(원본 증거 우선, `pass`/`fail`/`inconclusive`), 비용 원장(`cost_entry`) 집계 | A1, A2, A3 |
| A5 | `agent-runtime` | 어댑터 계약(입력=`task_spec`+허용 도구+근거+예산, 출력=`result`+`evidence`+`run_log`+`cost`, 실행 중 `cost_progress` 보고 — [ADR-0005](../adr/0005-agent-adapter-boundary.md) Amendment), 도구 게이트웨이와 게이트웨이 계약 테스트, 샌드박스·OS 수준 분리 검증([trust-boundaries §3.1](../security/trust-boundaries.md)), 어댑터 계약 테스트, 가짜 어댑터 → 실제 어댑터 1개(읽기 전용 조사 에이전트) | A2~A4, 스파이크 Q14, [Q26](../open-questions.md)(에이전트 격리 방식) |
| A6 | `apps/daemon` 통합 | 주간 사이클 1~7단계를 가짜·실제 어댑터로 끝까지 실행하고 §3의 모든 항목을 통합 시나리오로 재확인 | A5, [Q5](../open-questions.md)(측정 신호) |

의존 근거: `policy`는 `task-engine`의 `queued → running` 전이에서 호출되므로 전이 훅 인터페이스만 A2에서 먼저 정의한다. `evaluation`의 비용 집계는 `task_run`이 있어야 하므로 A2 뒤에 둔다.

스파이크 Q3(오케스트레이션)·Q4(헤드리스 코드 에이전트)는 A5의 선행 조건이 아니다. Phase A의 실제 어댑터는 읽기 전용 조사 에이전트 1개이고 실행 조정은 자체 상태 머신으로 충분하므로, 두 스파이크는 Phase A 후속으로 둔다(§5).

### A1 완료 기록 (2026-10-19)

- [x] 엔터티 타입: `packages/domain/src/entities/` (열거형은 `schema.sql` CHECK 목록과, 행 타입은 실제 열과 시험으로 대조)
- [x] 상태 전이 허용표: `src/state/` — `state-machines.md`의 업무·조직 제안·역할·전략·게시·상품 등록·상품 단계. 문서에 없는 전이와 에이전트의 모든 전이 거부
- [x] `task_spec` 스키마 검증(`validateTaskSpec`, draft/stored 두 단계)과 참조 검증(`checkTaskSpecReferences`: 역할·부서·상품·선행 업무). 정책 상한·정책 판정·의존 순환은 A2/A3
- [x] 마이그레이션: `migrations/0001_init.sql`(= `schema.sql` 복사본), 드리프트 시험 `test/unit/schema-drift.test.ts`
- [x] 시드(D4): `seedPhaseA` — 오너 1 + 부서 `core` + `generalist@v1` + 읽기 전용 `registration-verifier@v1` + `policy_version` v1(기본 거부). 시드 후 `policy_version` 존재를 시험으로 확인 (SQL 파일이 아니라 코드인 이유: 시각을 Clock 으로 받고 오너 이름을 인스턴스 값으로 넘기기 위해)
- [x] `memory_item` 신뢰·만료 규칙(`src/memory.ts`): 현재 사실 조회에서 `refuted`/만료 제외, 외부 입력 유래는 `hypothesis`/`unverified`로만 저장, 에이전트는 `hypothesis`만 작성
- [x] ADR-0012 §5 스키마 보강: `product.kind`, `product_repo` 0개 허용. 팩 manifest 형식 검증(`validatePackManifest`)
- [ ] 측정 신호 정의 형식: 필드가 문서에 정의되어 있지 않아 구현하지 않음 ([Q5](../open-questions.md), D2와 함께 정한다)
- 이월: `memory-item` 규칙 5(변동성 높은 종류의 기본 만료, 정책 파라미터)·7(`confidential` 이상 게시 입력의 승인)은 A3, 규칙 8(`inconclusive`는 성공 사례 불가)은 A4. 정책 형식(Q7)이 정해지면 시드의 `policy_version.content_hash` 입력을 새 정책 버전으로 교체

### A2 완료 기록 (2026-10-19)

- [x] 업무 생성(멱등): `packages/task-engine/src/create.ts` — `createTask`(활성 `dedupe_key` = 동일 트리거·입력 해시), `recordEvent`(`event.idempotency_key`, 이벤트와 업무를 한 트랜잭션), `fireRoutine`(`routine_firing` PK). 생성 거부는 스키마·참조 검증, 의존 순환(A1 이월분, 자기 의존과 저장된 순환 모두), 정책 훅. 시스템 필드(`policy_version`, `versions`)는 엔진이 채운다
- [x] `task_run` lease와 heartbeat: `src/lease.ts` — `queued → running`과 run 생성을 한 트랜잭션, run id를 펜싱 토큰으로 heartbeat·checkpoint·결과 제출·부작용 기록을 모두 `lease_owner = 나 AND lease_expires_at > now AND outcome IS NULL` 조건부로 쓴다. 만료 인수는 `lease_expired`로 닫고 `queued`(시도 미소모 기본, 소모는 옵션). 전이는 domain 허용표 + 비교 후 갱신
- [x] `external_effect` 상태 머신: domain `EXTERNAL_EFFECT_MACHINE`(recovery §3 그림 + 재시도 표), `src/effects.ts` — `planned` 기록 → 펜싱·heartbeat·`dispatched`를 한 트랜잭션 → 전송 → 결과. 멱등 지원 도구는 조회 또는 같은 키 재전송, 미지원 도구의 `unknown`은 재전송 없이 `effect_unknown` → `needs_review`
- [x] 스케줄러·폴링 데몬과 재시작 복구: `TaskWorker.tick`(만료 인수 → `retry_wait` 해제 → 선택·lease → 실행), `runPolling`, `apps/daemon/src/main.ts`. 재시작한 데몬의 첫 tick이 만료 lease를 인수한다. 실행기는 포트(`TaskExecutor`)로 두고 A5가 구현
- [x] A3 전이 훅: domain `TaskPolicyGate`(`beforeCreate`, `beforeRun`, 쓰기 트랜잭션 안 동기 호출). 연결 전 기본값은 거부(`DENY_ALL_TASK_POLICY_GATE`: 생성 거부, 실행 직전 `needs_review`)
- [x] 스파이크 Q15: lease 90초, heartbeat 30초, 폴링 5초 ([q15](../spikes/q15-lease-parameters.md)). 복구 지연 목표 120초는 잠정값
- [x] 시험: 단위(`test/unit/task-create`·`task-lease`·`task-effects`), 다중 프로세스(`test/integration/task-engine-multiprocess.test.ts`: 두 데몬 경쟁, SIGKILL 후 인수, 같은 id 재시작, 멱등 지원/미지원 부작용 복구, lease 잃은 데몬의 무전송). 가짜 시계를 IPC로 넘겨 결정적으로 돌리며 5회 반복 무실패
- [x] 루틴 발화 시각 계산(`routine.schedule`의 cron + tz 해석, `catch_up`): A6-U9 에서 구현했다 ([A6-U9 기록](#a6-u9-기록-2026-10-24)). `routine.schedule` 형식은 [ADR-0004 Amendment (2026-10-24)](../adr/0004-events-routines-idempotency.md)가 정한다. `fireRoutine`은 호출자가 `scheduledFor`를 넘기고, 시각 계산은 `schedule.ts`, tick 의 발화 단계는 `routine.ts`가 맡는다
- [x] `time_limit` 초과 취소(`killed`)와 도구 호출 타임아웃 (A5 완료): 도구 호출 타임아웃은 게이트웨이(U2, `AbortSignal`로 진행 중 호출을 멈추고 늦은 결과를 버린다), `time_limit` 감시는 실행 관리(U4, `runAgentTask`: 주입 타이머가 지나면 어댑터를 abort → 컨테이너는 `docker kill`, run 은 `killed`, 업무는 `retry_wait`이며 시도 1회 소모). [A5 완료 기록](#a5-완료-기록-2026-10-23) 참고
- [ ] `failed` 부작용 재전송("정책 허용 시"): 정책 훅이 정해지는 A3. 지금은 재전송하지 않는다
- 해석: 인수 시 멱등 지원 도구의 `unknown`은 `needs_review`가 아니라 `queued`로 돌려 같은 키로 재전송한다(recovery §3 표가 정본이라는 state-machines 업무 규칙에 따름). 멱등 미지원 도구는 조회로 전달이 확인되지 않으면 `unknown`으로 둔다

### A3 완료 기록 (2026-10-19)

- [x] 정책 형식 v1과 정책 버전 (Q7, [ADR-0013](../adr/0013-policy-format.md) Amendment): `packages/policy/src/yaml.ts`(YAML 부분집합)·`document.ts`(스키마 검증·정규화·내용 해시). 기본 템플릿 `policies/default.yaml` = 시드 `policy-v1`(A1 이월: 임시 `content_hash`를 실제 형식 v1의 해시로 교체, 기본 거부). 내용은 `instance/policies/<해시>.yaml`에 보관하고 판정 때마다 해시를 대조한다(`store.ts`)
- [x] 7요소 판정과 `policy_decision` 기록: `evaluate.ts`(결정론적, 가장 엄격한 결과, 기본 거부, 범위·영향 미선언 거부, 예산 상한), `decisions.ts`. `policy_decision.reason` 열 추가. 생성 거부 판정은 롤백 뒤 새 트랜잭션에서 남긴다
- [x] `TaskPolicyGate` 실제 연결 (A2 이월): `gate.ts`가 구현하고 `apps/daemon/src/assemble.ts`가 조립한다. 포트에 `beforeEffect`(부작용 직전 재검증)를 더했다. 데몬은 더 이상 모든 업무를 `needs_review`로 보내지 않고 정책 판정대로 실행·검토 대기를 나눈다
- [x] 승인 엔진(`approved_hash`)과 실행 시점 재검증: `approval.ts`·`engine.ts`. 승인은 대상 해시(명세 + 승인 시점 정책 버전)에 묶이고, 실행 직전·부작용 직전에 해시·정책 버전·역할 버전·승인자 수·자기 승인·취소·cooldown·재인증을 다시 확인한다. 정책이 강화되면 새 정책으로 재판정되고 과거 승인은 무효
- [x] 위험 변경 승인 구성 (D3): `risky_change` 파라미터(기본 1인, 1h, 재인증). 자기 승인은 파라미터가 아니라 `min_approvers == 1`일 때만 허용(아래 "사용자 결정 반영"). 보안 하향 정책 변경은 현재 정책의 위험 변경 절차를 거친다(`change.ts`). 대기 중 `cancel`로 취소
- [x] 사람 승인 채널 (D5): Unix 소켓(`channel.ts`) + 승인 CLI(`apps/daemon/src/approve.ts`), TOTP(RFC 6238, `totp.ts`) 재인증, 같은 시간창 재사용 거부(`human_reauth`), 연속 실패 제한. **편차:** 피어 UID 확인 대신 소켓 파일 권한(0700/0600) — [trust-boundaries §3.1](../security/trust-boundaries.md)
- [x] 게시 게이트: `publication.ts` — 승인 없는 `public`/`customer` 게시 거부, internal 이상 입력의 `public` 게시 거부, `confidential` 이상 입력은 승인 필요(A1 이월: memory 규칙 7)
- [x] memory 규칙 5 (A1 이월): 기본 만료 기간을 정책 파라미터(`memory.default_validity`)로, domain `MemoryContext.defaultValiditySeconds`에 연결. 값은 비워 두었다([Q17](../open-questions.md))
- [x] `failed` 부작용 재전송 (A2 이월): 정책 판정이 `allow`일 때만 재전송. 승인(`require_approval`)은 한 번의 전송에 대한 것이므로 재전송을 덮지 않는다
- [x] 시험: 단위 `test/unit/policy-*.test.ts`·`publication-gate.test.ts`(7요소 각각의 거부, 기본 거부, 해시 불일치·정책 강화·cooldown·취소·자기 승인·에이전트 승인 거부, TOTP 벡터·오답·재사용·시간창 경계, 보안 하향 배포의 위험 변경 절차), 통합 `test/integration/approval-channel.test.ts`(소켓 권한, 권한 없는 접속 EACCES), `policy-approval-multiprocess.test.ts`(데몬 + 승인 CLI 별도 프로세스로 승인 → 대기 → TOTP 해제 → 실행·부작용 1건, 실제 엔트리포인트 소켓). 통합 5회 반복 무실패
- [x] 별도 UID에서의 접근 실패 시험 → 컨테이너 시험으로 대체 (A5 U3, 완료): 실제 Docker 에서 컨테이너 안에서 `instance/run/` 소켓·`totp/`·DB·`policies/`가 없고(ENOENT) 외부 네트워크가 막히며 `docker inspect`의 `Mounts`가 비어 있음을 본다 (`test/integration/container-sandbox.test.ts`, 데몬 경로의 같은 확인은 `daemon-research-pipeline.test.ts`). Docker 가 없으면 이유를 출력하고 skip 한다. 실측은 macOS Docker Desktop 뿐이며 Linux 는 미실측이다 ([q26](../spikes/q26-agent-container-isolation.md))
- [x] 외부 입력 영향 호출 표시(trust-boundaries §2-3)와 호출별 게이트웨이 재판정 (A5 완료): 도구 게이트웨이(U2)가 호출마다 `ToolCallPolicy`로 재판정해 `policy_decision`을 남기고, 외부 출처 결과를 전달한 뒤의 호출을 `influenced_by_external_input`으로 표시한다. 주입 시나리오는 U5(`research-agent-injection.test.ts`)와 데몬 경로 U6(`daemon-research-pipeline.test.ts`)
- [ ] 열린 항목 (A5-U2, 2026-10-23): 도구 게이트웨이는 정책이 `require_approval`을 주는 호출을 항상 막는다(에이전트가 승인을 대신하지 못함). 업무 승인(`approved_hash`)이 있는 업무가 호출 시점에 `verifyTaskApproval`로 그 도구를 쓸 수 있게 할지는 정하지 않았다. 지금은 "막힘 유지"가 기본이며 승인이 필요한 부작용 도구는 Phase A 실제 어댑터(읽기 전용)에 없으므로 A6 전에 다시 본다
- 해석: D4의 "write는 업무 범위 내"는 `*:task-own` 대상 패턴으로 표현했다. 정책 규칙 변경은 강화임을 증명할 수 없으면 위험 변경으로 분류한다. (구현 당시 해석 "외부 부작용이 아닌 `require_approval`도 같은 `risky_change` 절차"는 아래 결정 2로 대체되었다)

#### A3 사용자 결정 반영 (2026-10-19)

1. **자기 승인.** `self_approval` 파라미터를 없애고 `min_approvers`에서 정한다: 1이면 오너(사람 actor)의 자기 승인을 허용하되 cooldown·TOTP는 그대로, 2 이상이면 자동 금지, 에이전트 actor는 항상 불가. 보안 하향 판정과 모순이 없다 — 자기 승인이 허용으로 바뀌는 변경은 `min_approvers`를 2 이상에서 1로 내리는 변경뿐이고 이미 위험 변경이며, 사유에 "self-approval becomes allowed"를 남긴다. 정책 배포는 제안과 첫 승인이 한 번의 승인 명령이라 요청자 기록이 없어 자기 승인 검사를 하지 않았다: 1인에서는 규칙상 검사할 것이 없고, 2인 이상에서는 서로 다른 사람 승인이 승인자 수를 채우는 것으로 충분하다(제안자가 첫 승인자로 센다). 제안자를 승인자 수에서 빼는 엄격한 해석은 제안 기록을 따로 두어야 하므로 열린 질문이다.
2. **승인 절차 범위.** cooldown·TOTP·승인자 수는 외부 부작용(`external_effect`)과 정책 변경에만 적용한다. 그 밖의 `require_approval`(예: `customer` 범위 읽기, `internal` 게시의 `confidential` 입력)은 사람 1인 승인만 받는다(`humanApprovalParams`). 업무에 외부 부작용 요청이 하나라도 있으면 위험 변경 절차다. 승인 요건은 `policy_decision.approval_required`에 요청별로 남는다.
3. **`scope`·`impact` 필수.** 이전에는 `task_spec` 검증이 선택으로 받고 정책 판정에서 거부했다. 이제 `validateTaskSpec`이 항목마다 필수로 요구해 생성 단계(정책 판정 이전)에서 사유와 함께 거부한다. `docs/schema/task-spec.md`의 주간 조사 예시와 시험용 기본 명세에 `internal`/`read`를 넣었다. 판정기의 미선언 거부는 저장된 옛 명세·부작용 직전 재검증을 위한 방어로 남긴다.
4. **기본 정책 internal 게시.** `policies/default.yaml`(시드 `policy-v1`)에 `internal-publish`(`publication.publish` + `internal` + `write` → allow)를 더했다. 게시 대상(`<channel>:<content_ref>`)이 `*:task-own`에 맞지 않아 가장 좁은 별도 규칙을 썼다. 외부 게시는 그대로 `require_approval`. 시드의 `policy_version.content_hash`가 바뀌었다(`POLICY_V1_DOCUMENT`에서 계산하므로 마이그레이션 SQL에는 해시가 없고, 0001 직접 수정은 없었다). 시드·드리프트 시험(`seed.test.ts`, `policy-document.test.ts`)은 새 내용에 맞췄다.

### A4 완료 기록 (2026-10-21)

- [x] 결정론적 검증기: `packages/evaluation/src/checks.ts` — `schema_valid`(`schema`)·`url_reachable`·`quote_in_source`·`dedupe`·`budget`·`policy_compliance`(안전성 검사). id 목록은 [task-spec](../schema/task-spec.md) "결정론적 검사 id". 출처 접근은 `SourceFetcher` 포트이고 시험은 가짜만 쓴다(실제 네트워크 없음). `evidence.verified`/`verification_note`는 `applyEvidenceVerification`이 `Db.writeTx` 안에서 갱신하며, 한 줄의 `verified`는 그 줄에 기여한 모든 검사가 통과일 때만 1이다. 등록되지 않은 id와 검사 대상이 없는 검사는 통과가 아니라 "확인 불가"(`unknown`)다
- [x] 컨텍스트 분리 LLM 검증 인터페이스: `LlmVerifier` 포트와 `buildIsolatedInput`(`ports.ts`·`isolation.ts`). 입력은 원본 출처 본문·내용 해시, 검증 대상 주장 문장(길이 제한), 명세의 완료 조건뿐이며 프롬프트·세션·보고서 전문이 들어갈 자리가 타입에 없다. 시험이 `@ts-expect-error`(tsc)와 실행(보고서에 심은 표식이 입력에 없음, 키 집합 고정, 캐스트로 끼워 넣은 속성은 복사되지 않음)으로 고정한다. 결정론적 검사가 모두 통과한 뒤에만 호출하고, 검증기가 없거나 던지거나 `isolated_context=false`이면 `inconclusive`. 실제 모델 호출은 구현하지 않았다
- [x] 평가기(`evaluation` 행): `evaluator.ts` — 판정 순서는 안전성 거부권 → 결정론적 검사 실패(`fail`) → 증거 부족(`inconclusive`: 확인 불가 검사, 원본 증거 없음, LLM 판단 불가, 관측 수 부족, 데이터 품질 불량, 측정 불가) → LLM 불지지·효과 미달(`fail`) → `pass`. 원본 증거 = 확인된 `evidence` 행 + 비용 원장 + 주입된 측정 값(`primary_evidence_refs`), 에이전트 보고서는 `agent_report_used=1`로만 표시하고 `evidence_refs`에 별도 항목으로 남는다. 불변식(원본 증거 없는 `pass`, `safety='fail'`인 `pass` 금지)은 기록 전에 한 번 더 확인한다. 4축은 별도 필드(`quality`=통과한 검사 비율, `effect`=주입된 관측 평균, `economics`=1−지출/예산, `safety`), `evaluator`는 `task-evaluator@v1`. 같은 (업무, run, 평가기)의 재검증은 처음 기록된 행을 돌려준다(UNIQUE 흡수, 재조회 없음)
- [x] 효과 측정 신호: 정의 형식은 구현하지 않고 "외부에서 주입된 관측 값 목록(`EffectSignal`: 값, 최소 관측 수, 데이터 품질, 선택적 합격선)"을 받는 포트(`EffectSignalSource`)만 둔다
- [x] 비용 원장 집계: `cost.ts` — `recordCost`(append-only), `costForTask`/`costForRun`/`costForProduct`(카테고리·토큰·사람 시간 포함). 실행 중 `cost_progress`는 `reportCostProgress`가 누적값과 이미 기록한 어댑터 보고분의 차액만 원장에 더하고(같은 값 재보고는 두 번 세지 않음, 줄어드는 누적값은 거부), 업무 전체 누적이 예산(USD, 토큰)을 *초과*하면 `CancelSignal`(이유·상세)을 돌려준다. 실제 취소 실행은 A5
- [x] 규칙 8 (A1 이월): `createMemoryItem`이 `source_ref = evaluation:<id>`가 `inconclusive` 평가이면 `lesson`/`strategy_record` 저장을 거부한다(`inconclusive_not_learnable`). `packages/evaluation`은 `isSuccessCase`(pass AND safety pass)를 제공한다
- [x] 판정 → 업무 전이 연결: `task-engine/src/validation.ts`. `pass`+`safety pass` → `completed`(`validation.human=true`면 `needs_review`), `fail` → `retry_wait`(시도 1회 소모), `inconclusive`(**사용자 결정 2026-10-21**)·`safety fail`·재시도 소진 → `needs_review`. 전이는 `transitionTask`(`by='validator'`)이며, 검증기가 돌려준 판정을 기록된 `evaluation`과 대조한 뒤에만 옮긴다. `TaskWorker.tick`이 검증기가 연결된 경우 `validating` 업무를 검증·전이한다(오류는 업무별로 보고하고 다음 tick에 재시도)
  - **연결 방식과 이유:** evaluation → task-engine 직접 참조는 경계 lint(`mid-layer-peers-isolated`)가 막으므로 완화하지 않고, A3의 `TaskPolicyGate`와 같은 방식으로 domain에 `TaskValidator` 포트를 두었다. evaluation이 구현하고 task-engine이 호출하며 `apps/daemon/src/assemble.ts`가 조립한다. 반대 방향(task-engine이 쓰는 `transitionTask`를 evaluation이 받는 포트)도 가능했지만, 업무 상태 갱신의 유일한 경로를 task-engine에 두고 재시도 가능 여부(`attempts`)도 거기서 판단하게 하려고 "evaluation은 판정만, 전이는 task-engine"으로 나눴다. 평가 기록과 전이는 별개 트랜잭션이다(검증에 외부 접근이 있음). 그 사이에 죽어도 평가는 UNIQUE로 흡수되므로 다음 tick이 같은 평가로 전이만 이어서 한다
- [x] 시험: 단위 `test/unit/evaluation-{validator,llm,evaluator,cost,memory-rule}.test.ts`·`task-validation.test.ts`(§3 "평가 독립성"·"비용" 행의 완료 기준 문장을 시험 이름에 그대로 대응: 보고서만으로 `pass` 불가, 관측 수 부족 `inconclusive`, `safety='fail'`이면 효과 점수와 무관하게 `fail`, `inconclusive`는 성공 사례로 기록되지 않음, 가짜 어댑터 비용의 `task`·`task_run` 합산, `cost_progress` 기록과 예산 초과 판정), 통합 `test/integration/evaluation-pipeline.test.ts`(데몬 조립으로 실행 → 검증 → 전이, 증거 없는 보고서는 `needs_review`, 재시도 후 통과와 run별 비용, 평가만 기록된 채 재시작). 통합 5회 반복 무실패
- [ ] 측정 신호 정의 형식: 문서에 정의가 없어 구현하지 않음 ([Q5](../open-questions.md), D2와 함께). 효과 점수는 주입된 관측 값의 평균이며 단위·기준선은 해석하지 않는다
- [ ] 필수 테스트 결과(`test_result`) 검사: 합격 표현 형식이 문서에 없어 구현하지 않았다. `extraChecks`로 주입할 수 있고, 명세가 `required_tests` 등 미등록 id를 요구하면 `inconclusive`가 된다
- [x] 실제 출처 조회기 (A5 U5·U6, 완료): `createSourceFetcher`(`fetch_url`과 같은 SSRF·허용 호스트 규칙)를 데몬 설정의 `research_agent`가 있을 때 `evaluation.fetcher`로 연결한다. 설정이 없으면 평가 포트를 넘기지 않으므로 `validating` 업무는 검증되지 않고 그대로 남는다(자동 완료 없음, 이전 동작 유지)
- [ ] LLM 검증기·측정 값 조회기: A4 에서는 연결하지 않았다. 실제 모델 호출은 [Q22](../open-questions.md)(검증 모델 선택) 후속으로 남는다. 그 사이 모델 호출 없는 가짜 검증기(`createStubLlmVerifier`)를 데몬 설정 `llm_verifier: {kind: "stub"}` 로 켤 수 있다 (A6-U12, [기록](#a6-u12-기록-2026-10-24)). 측정 값 조회기는 A6-U13 에서 연결했다(`createMeasurementSignalSource`, [기록](#a6-u13-기록-2026-10-24))
- [x] 예산 초과 시 실제 실행 취소와 `cost_progress` 이벤트 수신 경로 (A5 U4, 완료): 어댑터의 `cost_progress`와 게이트웨이가 계량한 도구 비용을 각각 단조 증가 누적으로 거른 뒤 `reportCostProgress`로 `cost_entry`에 차액만 더하고, 업무 전체 예산을 *초과*하면 즉시 abort → run `killed`, 업무 `needs_review`(시도 소모 없음). 초과 시점까지의 비용은 원장에 남는다
- [ ] 검증기·평가기 교체의 정책 변경 절차 연결 (ADR-0012 §3, ADR-0007 §5): 정책 형식 v1에 허용 평가기 버전을 고정하는 키가 없다. 키를 추가하면 정규화 문서와 시드의 `content_hash`가 바뀌고 변경 등급 규칙도 정해야 하므로 이번에는 연결하지 않고 [Q27](../open-questions.md)로 남겼다. 현재: 평가기·검증기 로직은 코드이고 팩은 교체할 수 없다(팩은 선언형이며 평가기 등록 경로가 없다). 모든 평가는 `evaluator`에 `id@version`을 남기며, 로직을 바꾸면 `EVALUATOR_VERSION`을 올려 새 행이 생기게 한다
- 해석: ① `acceptance_criteria` 문장과 검사의 대응 형식이 문서에 없어, `validation` 명세의 검사(과 LLM 검증)가 모두 통과한 것을 "모든 acceptance_criteria 충족"으로 해석했다. ② `validating → failed` 전이가 없으므로 기준 미충족 + 재시도 소진은 `needs_review`로 보낸다. `safety='fail'`도 자동 재시도·완료 대신 `needs_review`(사람이 `failed`/재시도를 정한다). (사용자 확인 2026-10-22: 이대로 유지, `validating → failed` 전이는 추가하지 않는다) ③ 예산 "초과"는 한도를 넘은 경우다(같으면 넘지 않음). 업무 예산은 모든 시도의 합계에 적용한다. ④ 검증용 LLM 호출 비용은 같은 run에 `units.source='validation'`으로 별도 `cost_entry`에 남는다(실행/검증 비용 분리, product-registration §7). ⑤ 조직 제안의 `inconclusive`는 재시험 승인 전까지 종료로 취급하고 상태를 더하지 않는다는 결정(2026-10-21)은 [state-machines](../schema/state-machines.md)·[ADR-0007](../adr/0007-independent-evaluation.md) Amendment에 반영했다(스키마·CHECK·마이그레이션 변경 없음). 조직 시험(`org_trial_result`) 판정 코드는 Phase B

### A5 완료 기록 (2026-10-23)

- [x] 어댑터 계약 (U1): `packages/agent-runtime/src/contract.ts`(입력 `task_spec`+허용 도구+근거+예산, 출력 `result`+`evidence`+`run_log`+`cost`, 취소 `AbortSignal`)·`frames.ts`(tool_call/tool_result/cost_progress/result 프레임, 크기 상한)·`validate.ts`·`fake-adapter.ts`. 어댑터 계약 테스트는 재사용 함수 `test/support/adapter-contract.ts`이고 가짜 어댑터와 컨테이너 안 실제 어댑터가 같은 스위트를 통과한다
- [x] 도구 게이트웨이 (U2): `gateway.ts`(`createToolGateway`) — 허용 도구 목록, 호출마다 정책 재판정(`ToolCallPolicy` 포트를 policy 가 구현, `policy_decision` 기록), 외부 입력 영향 호출 표시, 도구 호출 타임아웃, 호출별 비용 계량, 거부까지 기록하는 호출 기록(`ToolCallRecord`)과 비밀값 가리기, 결과 크기 상한. 계약 테스트 `test/support/gateway-contract.ts`
- [x] 컨테이너 샌드박스 (U3): `container-args.ts`(고정 템플릿 인자 생성기: 마운트·권한·네트워크·환경 변수 플래그와 태그 이미지 거부), `docker.ts`(절대 경로 `docker` CLI, 환경 변수 화이트리스트, Docker 가 없으면 호스트 실행으로 대체하지 않고 실패), `container-runner.ts`(stdio 프레임 검증, 위반·취소·시간 제한은 `docker kill`), 고아 정리
- [x] 실행 관리 (U4): `run-manager.ts`(`runAgentTask`) — `time_limit`·예산 초과 취소, `cost_progress` → `cost_entry`, 첫 취소 사유 우선, 취소 뒤 도착한 결과 폐기, `run_log`는 파일(`<run_log_dir>/<run id>.jsonl`, 한 줄에 `{at, message}`)로 저장하고 `task_run.run_log_ref`는 `run-log:<run id>`. domain `AgentRunHost` 포트와 task-engine `killRun`이 run 종료·전이를 맡는다(에이전트는 상태를 바꾸지 않는다)
- [x] 실제 어댑터 1개 — 읽기 전용 조사 (U5): 컨테이너 안 조사 에이전트(`container/research-agent`, 의존성 없음, 도구는 `fetch_url` 하나, 페이지 텍스트는 데이터로만 쓴다)와 호스트 어댑터 `research-adapter.ts`, 호스트 쪽 `fetch_url` 실행기·검증기용 출처 조회기 `fetch-url.ts`(스킴·호스트 허용 목록 + 업무 `network_allowlist`, 해석한 *모든* 주소가 공인 주소일 것, 검사한 주소로 고정 연결, 리다이렉트 매 홉 재검사, 본문 크기·content-type 상한)
- [x] 데몬 연결 (U6): `apps/daemon/src/runtime-config.ts`(설정 → 조립)·`assemble.ts`·`main.ts`. 설정 키 `container_agent`(Docker 경로·자원 상한), `research_agent`(조사 에이전트 이미지 ID + `allowed_hosts`, 기본 비어 있음 = 모두 거부), `instance_id`, `run_log_dir`, `default_time_limit`은 `config/daemon.config.example.json`에 설명했다(비밀값은 설정에 없다). `research_agent`가 있으면 `fetch_url` 도구 선언·실행기와 조사 어댑터를 `agent` 옵션에, 같은 허용 호스트의 출처 조회기를 `evaluation.fetcher`에 연결한다 — `validating` 업무가 실제 출처 조회 검증을 받는다. 설정이 없으면 이전과 같다(실행기 없음, 평가 포트 없음 → `validating` 업무는 그대로 남음). `AgentOptions.recorder`는 게이트웨이의 `ToolCallRecord`를 구조화된 채로 받는 훅이다(`run_log` 파일 형식은 바꾸지 않았다)
- [x] 시험: 단위 `test/unit/agent-runtime-{contract,gateway,frames,container-args,container-runner,run-manager,fetch-url,ip-address}.test.ts`·`research-agent-{core,image}.test.ts`·`policy-tool-call.test.ts`·`task-run-kill.test.ts`·`daemon-runtime-config.test.ts`. 통합(실제 Docker, 없으면 이유를 출력하고 skip) `container-sandbox`(OS 수준: `Mounts` 비어 있음, `instance/`·DB·`policies/` ENOENT, 네트워크 차단, `docker kill`, 인스턴스별 고아 정리)·`research-agent-contract`·`research-agent-injection`·`agent-run-docker`·`daemon-research-pipeline`(아래), Docker 없는 통합 `agent-run-management`·`fetch-url`(로컬 HTTP·HTTPS 서버). 통합 5회 반복 무실패
  - `daemon-research-pipeline`: 데몬 설정 → 조립 → 업무 생성(정책 게이트 allow) → 컨테이너 조사 → `validating` → 설정에서 만든 출처 조회기로 검증 → 전이. pass → `completed`, 검사 실패(검증 시점에 인용이 사라짐/출처 500) → `retry_wait`, 보고된 인용이 없음 → `inconclusive` → `needs_review`(A4 규칙 그대로). `cost_entry`(`tool` 범주)·`evidence`(해시, `verified`)·`policy_decision`(호출마다)·구조화된 호출 기록을 확인하고 컨테이너 `Mounts` 비어 있음·종료 뒤 `aot.run` 컨테이너 0개를 본다. 주입 페이지(HTML, 프레임 흉내 text/plain)의 데몬 경로 결과가 대조와 같다. 빈 `allowed_hosts`는 에이전트와 검증기 모두 거부한다
  - https: 시험 중에 `node:crypto`로 만든 자체서명 인증서(`test/support/test-cert.ts`; 저장소에 키·인증서 파일이 없다)를 시험 전용 주입점(`FetchUrlHooks.ca`, 공개 API·운영 설정 아님)으로 신뢰해 정상 경로를 보고, 만료·호스트 이름 불일치·미신뢰 인증서는 거부되며 서버에 요청이 닿지 않음을 본다
- 결정 요약: ① **Q26** — 에이전트 격리는 Docker 컨테이너, 통신은 stdio 줄 단위 JSON, 마운트 0개, Docker 가 없으면 실행하지 않는다(호스트 실행 대체 없음). Linux 배포는 **rootful Docker**(2026-10-22 사용자 결정; `docker` 그룹 위험은 [q26 스파이크](../spikes/q26-agent-container-isolation.md)에 기록, rootless/Podman 은 후속 검토). ② **`require_approval` 막힘 유지** — 게이트웨이는 정책이 `require_approval`을 주는 호출을 항상 막는다(위 A3 항목 "열린 항목 (A5-U2)"은 그대로 열려 있다). ③ **`time_limit` 초과** → run `killed`, 업무 `retry_wait`(시도 1회 소모); **예산 초과** → run `killed`, 업무 `needs_review`(시도 소모 없음). 허용표에 전이를 추가하지 않았고 `validating → failed`도 없다. ④ 인스턴스 라벨: 컨테이너에 `aot.run=<run>`과 `aot.instance=<인스턴스 ID>`를 붙이고 시작 시 고아 정리는 두 라벨의 AND 로만 고른다(한 Docker 호스트의 다른 데몬 컨테이너를 지우지 않음)
- [x] **U7 — 인용문 필드와 `evidence.trust_origin`** (사용자 결정 2026-10-23, 완료): 스키마 변경 단위. 첫 공개 릴리스 전이라 `migrations/0001_init.sql`과 `docs/schema/schema.sql`을 함께 직접 고쳤다(드리프트 시험 유지). ① **인용문 필드**: `task_spec`의 선택 최상위 필드 `expected_quotes: [{source, text}]`(`source` = `inputs[]`에서 `kind='source_url'`인 항목의 `name`). 도메인 검증은 형식·알 수 없는/모호한 출처·빈 문장·상한(전체 200, 출처당 10, 500자)·중복·`validation.deterministic`에 `quote_in_source` 필수를 본다. 조사 에이전트는 이 필드만 읽고(`inputs[]`의 임시 `quote` 종류 관례는 없앴다) 기대 인용문 *전부*에 대해 `sources[].quotes[]`로 found/not found 를 낸다(출처를 못 읽은 경우도 `found:false`, 이름이 맞는 출처가 없으면 `unmatched_quotes[]`). 긴 문장·상한 초과는 잘라 읽지 않고 `skipped_inputs`에 사유 코드로 남긴다. ② **KNOWN GAP 해소**: 검증기 `quote_in_source`가 `expected_quotes` 전부를 (a) 검증기가 출처에서 직접 읽은 원문과 (b) 에이전트 보고의 주장 양쪽에서 확인한다. 하나라도 원문에 없거나 출처를 못 읽었거나 보고에서 빠지면 `fail`(평가 순서는 그대로: 안전 거부권 → 결정론적 검사 실패 → …), 업무는 재시도 대기(소진 시 `needs_review`)다. `daemon-research-pipeline.test.ts`의 `KNOWN GAP (U7)` 시험은 기대값을 `retry_wait`/`fail`로 뒤집었다. 기대 인용문도 보고된 주장도 없으면 이전처럼 `inconclusive`다. ③ **`evidence.trust_origin`**: `NOT NULL`, 기본값 없음(쓰는 쪽이 밝힌다. 기본값이 있으면 빠뜨린 쓰기가 신뢰됨/아님으로 조용히 읽힌다), `CHECK`는 `memory_item.trust_origin`과 같은 어휘(`internal`, `external_untrusted`). 어댑터 계약 `EvidenceItem.trust_origin`(필수, 형식 검증)·`EvidenceRow.trust_origin`으로 다루고(U7 당시에는 `AgentEvidenceInput.trustOrigin`·`RunEvidence.trustOrigin`으로 어댑터가 밝힌 값을 그대로 저장했으나 U8에서 호스트 강제로 바뀌어 두 필드는 없다), 조사 에이전트의 외부 페이지 근거는 `external_untrusted`다. 검증(`verified`)은 신뢰 출처를 바꾸지 않는다. 검증기가 LLM 검증에 넘기는 출처 본문(`SourceText.trustOrigin`)은 검증기가 바깥에서 직접 읽은 것이므로 항상 `external_untrusted`다. ④ **불변식**: `createMemoryItem`이 `source_ref = evidence:<id>`인 항목에 근거의 신뢰 출처를 물려주고(생략 시), `external_untrusted` 근거에서 온 항목을 `internal`로 적으면 `untrusted_evidence_origin`으로 거부한다. 규칙 3과 합쳐 외부 근거는 `hypothesis`/`unverified`로만 편입되어 현재 사실 조회에 나오지 않는다(memory-item 규칙 9, `test/unit/evidence-trust.test.ts`). 존재하지 않는 `evidence:` 참조는 거부한다. ⑤ **발췌 위치**: `evidence`에는 발췌·본문을 둘 열이 없고(`ref`=URL, `content_hash`, `verification_note`) 새 열을 만들지 않기로 했으므로, 발췌(`excerpt`)·인용 주변 문맥은 `result.sources[]`에 그대로 둔다. 그곳의 `trust_origin` 표시도 그대로 남아 있다(결과 JSON 안의 표시이고 근거 행과 중복이지만 소비자가 `result`만 읽을 때 쓰인다). ADR-0003·ADR-0008에 Amendment 한 단락씩
- [x] **U8 — 에이전트가 낸 근거의 `trust_origin`을 호스트가 강제** (사용자 결정 2026-10-23, 완료): U7에서 어댑터의 자기 신고에 맡겨 둔 틈(악의적/오작동 어댑터가 외부 근거를 `internal`로 적어도 호스트가 어휘만 보고 막지 못함)을 닫았다. 에이전트 출력 → `evidence` 행의 유일한 저장 경로인 `recordRunOutput`(task-engine `lease.ts`)이 신뢰 출처를 인자로 받지 않고 항상 `external_untrusted`로 쓴다. `AgentEvidenceInput`(domain `AgentRunHost` 포트)·`RunEvidence`에서 `trustOrigin`을 없애 어댑터가 밝힌 값이 포트를 지나지 않게 했고, 실행 관리(`run-manager.ts`)도 옮기지 않는다. 어댑터 계약의 `EvidenceItem.trust_origin`은 필수·어휘 검증을 그대로 두되 참고용 자기 신고로 문서화했다(어휘 밖 값은 계약 위반으로 run 이 `error`). 거부·강등 대신 덮어쓰기를 택한 근거: 어댑터 출력은 신뢰 경계 밖이라 자기 신고에 기대지 않고, 거부는 정상 어댑터의 작업을 잃게 하며, 무시는 fail-closed 이면서 판단 지점이 없다. 에이전트 출력이 아닌 경로(시드, 사람·데몬 내부가 직접 쓰는 `internal` 근거)는 바뀌지 않는다. 스키마(열·CHECK)는 그대로다. 시험: `agent-run-management`(악의적 어댑터가 `internal`로 밝혀도 DB 는 `external_untrusted`, 어휘 밖 값은 거부, 그 근거를 `evidence:<id>`로 `internal` 편입하면 `untrusted_evidence_origin`, `hypothesis`/`unverified`로만 들어가고 현재 사실 조회에 안 나옴), `task-run-kill`(저장 함수가 몰래 실린 `trustOrigin`도 무시), `agent-runtime-run-manager`(포트에 신뢰 출처가 없음), `evidence-trust`(에이전트 경로가 아닌 근거는 기존 값 유지). ADR-0005 Amendment, [trust-boundaries §2-3](../security/trust-boundaries.md), [memory-item 규칙 9](../schema/memory-item.md) 반영
- [ ] `require_approval` 호출의 처리: 위 "열린 항목 (A5-U2)"과 같다. 승인이 필요한 부작용 도구는 Phase A 실제 어댑터(읽기 전용)에 없으므로 A6 전에 다시 본다
- [ ] LLM 검증기·측정 값 조회기 연결(Q22, Q5/D2): LLM 검증기는 가짜 구현을 설정으로 연결했다(A6-U12, 실제 모델은 Q22 후속). 측정 값 조회기는 A6-U13 에서 연결했다(팩에 측정 신호가 있고 평가 포트가 있을 때)
- [ ] Linux 실측: OS 수준 시험은 macOS Docker Desktop 에서만 돌렸다. Linux 에서는 바인드 마운트 권한·소켓 동작이 다르므로 CI(Linux)에서 같은 시험을 돌려 확인한다. 조사 에이전트 이미지는 시험이 빌드(`docker build`)하고 운영 이미지의 빌드·배포 절차는 정하지 않았다
- 해석: ① 데몬 설정의 `research_agent.allowed_hosts`는 운영 상한이고, 에이전트의 `fetch_url`은 업무의 `constraints.network_allowlist`와 *둘 다* 만족해야 한다. 검증기의 출처 조회기는 업무 단위 목록이 없어 운영 상한만 적용한다. ② 검증기가 출처를 다시 읽을 때 `fetch_url`과 같은 SSRF 규칙을 쓰므로 사설 주소의 출처는 검증도 할 수 없다. ③ `task_run.adapter`는 어댑터 이름(`research-agent`)이다

### A6 시작 결정 (2026-10-24)

- **Q5(D2) 해소:** 측정 신호는 랜딩 페이지 1개의 주간 목표 행동 전환 수. Phase A는 사람이 값을 입력하고 근거를 `evidence`로 첨부한다(평가기는 입력된 값과 근거를 원본 증거로 읽는다). 읽기 전용 분석 API 연결은 후속이다.
- **`require_approval` 호출:** 막힘 유지로 닫는다. 승인이 필요한 부작용 도구는 Phase A 실제 어댑터(읽기 전용)에 없다. 승인 후 재개 경로는 Phase A 후속에서 설계한다(A3·A5의 열린 항목은 이 결정으로 "의도적 유지"가 된다).
- **LLM 검증기(Q22):** A6은 `LlmVerifier` 포트의 가짜 구현으로 통합 시나리오를 확인한다. 실제 모델 연결과 모델 등급·비용 비율은 Q22 후속이다.

#### A6 단위 분해와 추가 결정 (2026-10-24)

결정: ① 측정 값은 **대기 조건**으로 붙인다(`inputs[kind=measurement]`가 채워질 때까지 해당 업무는 실행하지 않음). ② 실험 판정 단위는 **1주, 관측 1**(합격선은 후보 비교기가 기준선 대비로 정함). ③ 실험(`strategy_version`) 승인은 **사람 1인 승인**(cooldown·TOTP 없음, 외부 부작용은 업무 승인에서 위험 변경 절차). 스키마 변경 없음, 기획·마케팅 업무는 generalist 가 맡고 실제 어댑터는 1~3단계에만 쓴다.

| 단위 | 내용 | 선행 |
|---|---|---|
| U9 | 루틴 발화 시각 계산(cron 부분집합 + IANA tz, `catch_up`), 템플릿 포트 `RoutineTemplateSource`, 템플릿 하나에서 업무 여러 개 발화(템플릿 안 이름으로 의존) | 없음 |
| U10 | 측정 신호 정의 형식(D2), 팩의 루틴·템플릿 선언, 팩 로더 (완료, [기록](#a6-u10-기록-2026-10-24)) | U9 |
| U11 | 업무 간 결과 전달(`inputs[kind=task_result]` → `AdapterInput.upstream`, `external_untrusted`), 업무별 어댑터 선택 (완료, [기록](#a6-u11-기록-2026-10-24)) | U10 |
| U12 | 조사 결과 `uncertainties[]`·`uncertainty_listed` 검사, 가짜 LLM 검증기 연결 (완료, [기록](#a6-u12-기록-2026-10-24)) | U10 |
| U13 | 측정 값 입력(소켓 `measure` → `recordMeasurement`, 사람만), 대기 조건, `createMeasurementSignalSource` (완료, [기록](#a6-u13-기록-2026-10-24)) | U10 |
| U14 | 후보 형식 검사, `compareCandidates`, `strategy_version` proposed 생성 | U11, U13 |
| U15 | `strategy_version` 승인(사람 1인) → experiment 전이와 루틴 활성화(event 멱등) | U14, U9 |
| U16 | 결과 검토 → `measurement`·`strategy_record` 기억, 다음 주 입력 반영, 승격·퇴역 | U15 |
| U17 | 통합 시나리오(가짜/Docker)와 §3 8개 영역 재확인, A6 완료 기록 | 전부 |


#### A6-U9 기록 (2026-10-24)

- 구현: `packages/task-engine/src/schedule.ts`(순수 함수: `parseSchedule`, `nextSlot`, `slotsBetween`, `latestSlot`, `planFirings`, `missedSlots`), `routine.ts`(포트 `RoutineTemplateSource`, `RoutineFirer`), `create.ts`의 `fireRoutineTasks`(템플릿 하나로 업무 여러 개를 한 트랜잭션에 발화), `TaskWorker` 옵션 `routines`(포트가 주입된 경우에만 tick 이 도래한 슬롯을 발화, 보고는 `TickReport.routines`).
- 일정 형식, 시간대 경계(건너뛴 시각은 건너뛴 길이만큼 뒤로, 겹친 시각은 앞선 쪽 한 번), `catch_up`, 기준점, 허용 지연의 정의는 ADR-0004 Amendment.
- 시험: 단위 `task-schedule`(표 시험·잘못된 일정 거부·catch_up), `task-routine`(워커 통합: 업무 여러 개와 이름 의존, 거부, 재시도), 다중 프로세스 `task-engine-routine-multiprocess`(두 데몬이 같은 슬롯을 동시에 tick → 발화 1건·템플릿 1벌, 3주 정지 후 `run_once`/`skip`).
- 열린 항목: 한 번도 발화하지 않은 루틴의 기준 시각은 `routine` 행에 켠 시각이 없어 `activatedAt` 주입이 없으면 "프로세스가 처음 본 시각"이다. 루틴 활성화(U15)가 활성화 event 의 시각을 `activatedAt` 으로 넘긴다. 템플릿 포트의 실제 구현(팩 로더)은 U10 에서 했다 ([A6-U10 기록](#a6-u10-기록-2026-10-24)).

#### A6-U10 기록 (2026-10-24)

- 구현: ① 측정 신호 정의 형식(D2): `packages/domain/src/spec/measurement-signal.ts`의 `validateMeasurementSignal`. 필드 `id`, `description`, `page_ref`(별칭 키 `<종류>:<이름>`, 주소 금지), `action`, `period`(`iso_week`만), `tz`(IANA), `min_observations`(정수 ≥ 1), `attachment_required`(`true`만, 생략도 거부), 선택 `pass_threshold`(유한한 수, 단위 없음). 알 수 없는 키·URL 모양 문자열을 거부하고 사유 코드를 모아 돌려준다. ② 팩 선언: `packs/example-marketing/`에 루틴 1개(주간 시장 조사, `0 9 * * 1 Asia/Seoul`, `catch_up: skip`), 업무 템플릿 1개(조사 업무 1건, `fetch_url` 읽기), 측정 신호 1개(`landing:example-product`, `signup`). manifest 에 `required_tools: ["fetch_url"]`와 새 구성 디렉터리 `contents.measurement_signals`를 더했다(`PACK_CONTENT_KEYS`, [ADR-0012 Amendment](../adr/0012-extension-unit-contract.md)). ③ 팩 로더 `apps/daemon/src/pack-loader.ts`: 디렉터리를 데이터로 읽고(코드 import 없음) 전부 검증(`loadPack`, 문제는 파일·경로·코드와 함께 모아 `PackLoadError`), 루틴을 DB 에 반영(`syncPackRoutines`), 포트 `RoutineTemplateSource` 구현(`templateSource`), 측정 신호 목록(`signals`)을 돌려준다. ④ 데몬: 설정 키 `pack_dir`·`pack_values`(`packOptionsFromConfig`), `assembleDaemon({pack})`이 로드·반영하고 워커 `routines.source`에 연결한다. 설정이 없으면 이전 동작이다(`Daemon.pack`·`packSync`는 null).
- 해석·결정:
  - **루틴 반영 규칙(한 트랜잭션, 멱등).** 루틴은 항상 `enabled=0`으로 만든다(켜는 것은 U15 의 실험 승인). 없으면 만들고(id = `routine-<slug>`), 같으면 아무것도 쓰지 않고(켜진 상태도 건드리지 않음), 선언이 DB 행과 다르면 **`enabled=0`인 행만 선언에 맞춰 갱신**하고 `enabled=1`인 행은 `routine_enabled_conflict`로 거부한다(켜진 루틴의 일정·템플릿을 팩 파일 수정으로 바꾸면 실험 승인 경로를 우회한다). 팩에서 사라진 루틴은 지우지도 끄지도 않는다. `org_unit`·`product`는 slug 로 DB 행을 찾고, 없거나 `registered`가 아닌 product 는 거부한다(schema.sql 의 "registered가 아닌 product 는 product_id 가 가리킬 수 없다"). 하나라도 거부되면 아무것도 쓰지 않으며 조립이 던진다(데몬이 시작하지 못한다).
  - **치환.** 템플릿·루틴 선언의 *문자열 값*에서 `{{name}}`(소문자·숫자·밑줄)을 `pack_values`로 바꾼다. JSON 을 파싱한 뒤 값만 바꾸는 단일 패스라 값이 구조를 바꾸거나 다른 자리표시자를 끌어올 수 없다(값 안의 `{{`·`}}` 거부, 키 안의 자리표시자 거부). 값이 없는 자리표시자·모양이 틀린 중괄호는 거부하고, 치환한 명세는 `validateTaskSpec`(draft, trigger 를 붙여서)을 통과해야 한다. 검증은 시작 때 모든 템플릿에 대해 한 번 하고(빠진 값이 있는 팩은 시작하지 못함), 해석할 때(`resolve`)도 다시 한다(결정적 거부는 `TaskCreationError`라 RoutineFirer 가 같은 슬롯을 다시 시도하지 않는다). 템플릿의 `trigger`·`dependencies`는 엔진이 정하므로 거부한다. 호출마다 명세 복사본을 돌려준다.
  - **파일 규칙.** 파일 이름(확장자 제외)은 `id`/`slug`와 같아야 한다. 심볼릭 링크·1 MiB 초과·`.json` 아닌 파일(무시)을 다룬다. 템플릿은 파일당 버전 하나이고 `routine.task_template`(`<id>@<version>`)이 가리키는 템플릿이 팩에 없으면 거부한다.
  - **U9 의 남은 문제**(첫 발화 전 루틴의 기준점 `activatedAt`)는 U15 몫이라 건드리지 않았다. 루틴이 모두 꺼져 있어 이 단계에서는 발화가 일어나지 않는다.
- 시험: 단위 `measurement-signal`(표 시험: 정상, 알 수 없는 키, 잘못된 period·tz, `min_observations` 0·소수·문자, `attachment_required` false·생략·문자, `pass_threshold`, URL 거부, 팩 안 정의 파일 전부), `pack-loader`(예제 팩 전체 검증, 치환 결과가 `validateTaskSpec` 통과, 미치환 자리표시자·값 검증·잘못된 중괄호 거부, 파일 형식 위반 전부 수집, `syncPackRoutines` 멱등·비활성·갱신 규칙·켜진 행 거부·없는 부서/제품·미등록 제품), `daemon-pack`(조립 시 설정 유무 두 경우, 재조립 무변화, 비활성 동안 발화 없음, 켜면 팩 템플릿으로 업무가 생김).
- 열린 항목: ① 팩 `required_tools`가 실제 도구 선언과 맞는지는 확인하지 않는다(데몬의 도구 목록이 없는 조립도 있다). ② 템플릿에 날짜·주차 같은 슬롯 값을 넣는 내장 자리표시자는 없다(필요해지면 U11 이후). ③ 측정 신호 정의는 읽어 두기만 한다(값 입력·대기 조건은 U13 에서 구현, [기록](#a6-u13-기록-2026-10-24)).

#### A6-U11 기록 (2026-10-24)

- 구현: ① **업무 간 결과 전달.** domain `task-spec.ts`: `inputs[kind='task_result']`(`ref = task:<id>`, 한 업무 8개, 이름·참조 유일) 형식 검증과 상한 상수(`MAX_TASK_RESULT_*`: 항목 64 KiB, 전체 256 KiB). task-engine `upstream.ts`(`resolveUpstream`): *선행 업무가 `completed`이고 통과 평가(`pass` AND `safety='pass'`, 가장 최근 것)가 있을 때*, 그 평가가 가리키는 run 의 `task_run.result`(JSON 객체)만 읽는다. `claimNextTask`가 lease 획득 전에 읽어 `ClaimedTask.upstream`·`RunContext.upstream`으로 넘긴다. 생성 단계(`createTaskInTx`)는 `task_result`의 선행 업무가 `dependencies`에도 있는지 확인하고, `fireRoutineTasks`는 템플릿 안의 `task:<name>`을 생성된 id 로 바꾼다(`depends_on`에 있어야 함, 팩 로더도 같은 규칙을 시작 때 확인). agent-runtime: `AdapterInput.upstream?: UpstreamResult[]`(`{name, task_ref, trust_origin: 'external_untrusted', result}`), `validateUpstream`(`validate.ts`; 표시가 `external_untrusted`가 아니거나 모르는 키·잘못된 `task_ref`·중복·상한 초과를 거부), `start` 프레임에 `upstream`(받는 쪽도 같은 검사), 실행 관리가 어댑터를 띄우기 전에 한 번 더 검사(`invalid_upstream`이면 시작하지 않음). apps/daemon `agent-executor.ts`가 `external_untrusted`를 붙여 어댑터 입력을 만들고 게이트웨이를 `externalInput`으로 연다. ② **업무별 어댑터.** task-engine `AdapterSelector`(명세 → 이름 또는 null) 포트를 `WorkerOptions.adapterFor`/`ClaimOptions.adapterFor`로 받아 `task_run.adapter`에 고른 이름을 남기고 `RunContext.adapter`로 알린다. apps/daemon: `AgentOptions.adapters`(이름 → 어댑터, 키 = `adapter.name`), `selectAdapter`(`adapterByRole`이 역할 slug 기준 해석기), 조립이 등록 여부를 확인하고(등록되지 않은 이름이면 던져 업무가 `needs_review`) 실행기는 `ctx.adapter` 이름의 어댑터로 실행한다. 생략하면 단일 어댑터(이전 동작). task-engine 은 agent-runtime 을 참조하지 않는다(이름 문자열만 오간다).
- 결정·해석:
  - **선행 입력은 필수이며 미충족이면 "거부"다(기다림 아님).** 미완료는 `dependencies`가 이미 막는다(후속은 집히지 않고 `queued`로 남는다). 완료인데 통과 평가가 없거나(평가 없음, fail, inconclusive, safety fail, 사람이 끝낸 업무) 결과가 없음·객체 아님·상한 초과이면 상태가 더 바뀌지 않으므로 기다려도 소용이 없어 `queued → needs_review`(`by=scheduler`, run 도 시도 소모도 없음)로 보내고 사유 코드(`upstream_unmet: <code>: input '<name>': ...`)를 `task_transition.reason`에 남긴다. 일부만 넘기고 실행하거나 `skipped_inputs`로 알리고 실행하는 방식은 택하지 않았다: 조용히 모자란 입력으로 도는 일이 없고, 선택 입력(`required:false`)이 필요해지면 그때 더한다. 허용표에 새 전이는 없다(`queued → needs_review`의 전제 설명만 늘었다, [state-machines](../schema/state-machines.md)). 어댑터를 고를 수 없는 업무(`adapter_unresolved`)도 같은 방식이다.
  - **통과 평가가 있는 완료 업무만.** `completed`만으로는 부족하다: 사람이 `needs_review → completed`로 끝낸 업무는 평가가 fail/inconclusive/없음일 수 있고, 사람의 완료 판단이 에이전트 보고를 검증된 결과로 바꾸지 않는다. 평가가 가리키는 run 의 결과만 읽는다(같은 업무의 다른 run 이 아니다).
  - **신뢰 표시는 구조이며 호스트가 정한다.** `upstream[]`은 지시가 있는 `task_spec`과 별도 필드이고 항목마다 `trust_origin: 'external_untrusted'`가 필수다(리터럴 타입 + 검증). 값은 실행기 코드가 붙인다(DB 값이나 선행 어댑터 자기 신고가 아니다). 그 run 은 외부 입력이 들어 있으므로 도구 게이트웨이가 처음부터 모든 호출을 `influenced_by_external_input`으로 표시하고 부작용 호출은 승인을 요구한다. 데이터가 지시로 읽히는 길을 막는 것은 어댑터 몫이며(가짜 어댑터는 받은 사실의 참조·표시만 결과에 남기고 내용을 되풀이하지 않는다), 시험이 도구 호출·정책 판정이 `upstream` 없는 대조와 같음을 고정한다. 조사 에이전트(컨테이너)는 `upstream`을 읽지 않는다(모르는 `start` 필드는 무시, 이미지 변경 없음); 비밀로 보이는 값이 결과에 있으면 `start` 프레임이 거부해 컨테이너로 들어가지 않는다.
  - **어댑터 선택은 권한이 아니다.** 어떤 어댑터가 실행하든 도구는 명세 `allowed_tools` ∩ 게이트웨이 도구 선언 ∩ 정책 판정이다. 역할 기준 해석기를 기본 제공한다(명세에 새 필드를 만들지 않았다). 데몬 설정 파일의 역할 → 어댑터 키는 아직 없다(`assembleDaemon`의 옵션으로만 연결하며, 기획·마케팅용 어댑터가 가짜뿐이라 설정 키는 실제 어댑터가 둘 이상이 될 때 더한다).
- 시험: 단위 `task-upstream`(`resolveUpstream`·claim: 통과 평가가 있는 완료 업무의 결과만, 평가 없음/fail/inconclusive/safety fail/결과 없음·객체 아님·상한 초과는 `needs_review`, 미완료는 집히지 않음, 하나라도 미충족이면 부분 전달 없음, 생성 단계 `dependencies` 확인, 형식, 템플릿 이름 바인딩, 어댑터 선택·해석 불가), `agent-runtime-contract`(`validateUpstream` 표: 신뢰 표시 필수), `agent-runtime-frames`(`start` 프레임), `agent-runtime-run-manager`(잘못된 upstream 이면 어댑터를 시작하지 않음), `pack-loader`. 어댑터 계약 스위트(`test/support/adapter-contract.ts`)에 upstream 항목을 더해 가짜 어댑터와 컨테이너 안 조사 어댑터(실제 Docker, 없으면 skip)가 함께 통과한다: 지시문이 심어진 `upstream`이 있어도 도구 호출이 같고 입력은 변형되지 않는다. 통합 `daemon-upstream`(데몬 조립: 조사 업무 → 통과 평가 → 후속 업무가 `external_untrusted`로 받음, 주입 문장이 도구 호출·정책 판정을 바꾸지 못함, 평가 없는 완료·fail 이면 후속 어댑터가 시작되지 않음, 두 업무가 서로 다른 어댑터로 실행되고 `task_run.adapter`가 각각 맞음, 등록되지 않은 어댑터 이름은 `needs_review`, 단일 어댑터 구성은 그대로).
- 열린 항목: ① 선택 입력(`required:false`)과 `skipped_inputs` 알림은 두지 않았다. ② 선행 결과를 모델 프롬프트에 어떻게 구분해 넣는지(데이터 구획 표시)는 실제 모델 어댑터(Q22 이후)의 몫이다. ③ 한 업무가 받는 선행 결과 총량(256 KiB)과 `start` 프레임(1 MiB) 사이의 여유는 명세 크기에 기대므로 큰 명세에서 프레임 초과가 나면 실행 시 거부된다.

#### A6-U12 기록 (2026-10-24)

- 구현: ① **조사 결과 `uncertainties`.** 컨테이너 안 `core.ts`의 `uncertaintiesOf`가 결과에 `uncertainties: [{topic, note}]`를 항상 낸다. 에이전트가 이미 가진 사실에서만 기계적으로 도출한다: `skipped_inputs`(`input skipped: <reason>`), 읽지 못한 출처(`source could not be read: <오류 코드>`; 코드 모양이 아닌 오류 문자열은 `error`), HTTP 상태가 정상이 아닌 출처, 본문을 읽지 않았거나 잘린 출처, 인용문 `found:false`(출처를 읽은 경우 "찾지 못함", 읽지 못한 경우 "확인하지 못함"), 짝 없는 인용문. 문구는 코드에 고정이고 페이지 텍스트·임의 서술이 없다. 최대 100개(`topic` 100자·`note` 300자), 넘으면 앞 99개 + `(more)` 항목. 호스트 어댑터(`research-adapter.ts`)는 컨테이너 출력을 그대로 넘기며 바꾸지 않았다: 결과 형식 확인은 에이전트 자기 신고를 믿지 않는 평가기의 몫이다. 이미지 의존성은 늘지 않았다(상한 값 3개를 복사했고 시험이 `@aot/evaluation`의 값과 대조한다). ② **검사 `uncertainty_listed`.** `packages/evaluation/src/checks.ts`·`uncertainties.ts`. 결과에 `uncertainties`가 있고 형식이 유효하면 `pass`, 누락·형식 오류는 `fail`(사유 포함). 명세의 `validation.deterministic`에 있을 때만 적용되고 등록되지 않은 id가 "확인 불가"인 규칙은 그대로다. 팩 조사 템플릿(`packs/example-marketing/workflows/weekly-market-research.json`)의 `deterministic`과 `acceptance_criteria`에 추가했다. ③ **가짜 LLM 검증기.** `createStubLlmVerifier`(`packages/evaluation/src/stub-verifier.ts`, 모델 호출 없음): 주입된 판정표(`verdicts`, 주장 id → 판정) 또는 규칙(`rule`), 둘 다 없으면 기본 규칙(주장 문장이 출처 원문에 공백 차이를 무시한 부분 문자열로 있으면 `supported`, 없으면 `unsupported`, 출처를 읽지 못했으면 `unclear`)으로 주장마다 판정하고 하나라도 `unsupported`면 `unsupported`, 아니면 하나라도 `unclear`면(주장이 없는 경우 포함) `unclear`다. 입력 키가 `buildIsolatedInput`이 만든 모양(`check`·`claims`·`criteria`·`sources`)이 아니면 `IsolationError`로 거부한다. 비용은 기본 0, 설정 `cost_usd`가 0보다 크면 기존 규칙대로 `units.source='validation'` 원장 항목이 된다. 데몬 설정 `llm_verifier: {kind: "stub", cost_usd?}`(`runtime-config.ts`의 `parseLlmVerifierConfig`)가 평가 포트의 `llm`에 연결한다. ④ 평가 순서·판정 규칙·`Db.writeTx`·주입 Clock·스키마는 바뀌지 않았다.
- 해석·결정:
  - **`uncertainties`가 빈 배열이어도 유효하다.** task-spec의 완료 조건 문구는 "불확실성 항목이 명시되어 있다"이지만, 모르는 것이 없는 run에 항목을 지어내게 하면 "임의 서술 금지"를 어긴다. 검사는 항목 수가 아니라 *필드의 존재와 형식*을 본다(`[]` = 알려진 불확실성 없음의 명시, 필드 없음 = `fail`). 한계: 에이전트가 아는 불확실성을 빠짐없이 적었는지는 이 검사로 알 수 없다. 출처·인용문 쪽은 `url_reachable`·`quote_in_source`가 원본으로 따로 확인한다. 불확실성이 보고되었다는 이유로 `fail`이 되지는 않는다.
  - **`llm_verifier`는 `research_agent`와 함께만 받는다.** 평가 포트(출처 조회기)가 `research_agent`와 함께 조립되기 때문이다. `kind`는 `stub`만 허용하고 다른 값·모르는 키·음수 비용은 시작 때 거부한다(실제 모델 연결은 Q22 후속이므로 새 kind 는 그때 더한다). 설정이 없으면 이전 동작이다: `validation.llm`이 있는 업무는 검증기가 없어 `inconclusive` → `needs_review`.
  - **기본 규칙은 조사 에이전트의 주장 문장과 맞지 않는다.** 에이전트가 올리는 주장 문장은 `The source "<name>" contains the quotation.`이라 원문의 부분 문자열이 아니므로 설정이 만든 그대로의 스텁은 이 주장을 `unsupported`로 본다(시험이 이를 고정한다). 조사 에이전트 결과를 스텁으로 `supported` 처리하는 시나리오(U17)는 판정표·규칙을 주입하는 코드 쪽 주입점(`AgentRuntimeOverrides.createLlmVerifier`)으로 한다. 설정 파일로는 판정표를 주지 않는다. 에이전트의 주장 문장은 `dedupe`가 비교하는 값이라 바꾸지 않았다.
  - **LLM 검증은 결정론적 검사가 모두 통과한 뒤에만 돈다**(기존 규칙). 그래서 `uncertainties`가 없으면 `fail`이고 검증기는 호출되지 않는다.
- 시험: 단위 `evaluation-uncertainty`(형식 표, 검사 표, 평가 `fail`, 명세에 없으면 미적용, 등록되지 않은 id 는 여전히 `inconclusive`), `evaluation-stub-verifier`(기본 규칙·판정표·규칙, 결정성, 격리 키 위반 거부, 평가기 연결과 비용 기록), `daemon-runtime-config`(`llm_verifier` 없음·null = 이전 동작, `stub` 연결, 다른 kind·모르는 키·잘못된 비용·`research_agent` 없음 거부), `research-agent-core`(`uncertainties` 도출 표, 상한, 값 대조), `pack-loader`(템플릿의 검사 id 가 모두 등록됨). 통합 `daemon-llm-verification`(가짜 어댑터 + 설정에서 만든 스텁: supported → pass → completed, unsupported → fail → retry_wait, 검증기 예외 → inconclusive → needs_review, `uncertainties` 누락·형식 오류 → fail(검증기 미호출), 설정 없음 → 이전 동작, 격리 입력, 비용 기록), `daemon-research-pipeline`(실제 Docker 의 컨테이너 결과로 같은 supported/unsupported/예외 경로와 `uncertainty_listed` 통과), `research-agent-contract`·`research-agent-injection`(컨테이너가 필드를 내고, 적대적 페이지가 고정 문구 밖의 문장을 `uncertainties`에 넣지 못함).
- 열린 항목: ① 실제 모델 검증기(Q22 후속)와 설정의 모델 등급·비용 비율. ② 에이전트가 불확실성을 빠짐없이 적었는지의 검증은 없다(위 한계). ③ 조사 외 업무(기획·마케팅 어댑터)가 `uncertainties`를 내는지는 각 어댑터의 몫이며 팩 템플릿이 `uncertainty_listed`를 요구할 때만 강제된다.

#### A6-U13 기록 (2026-10-24)

- 구현: ① **측정 값 입력.** task-engine `measurement.ts`의 `recordMeasurement`(사람 actor id 를 받아 `actor.kind='human'`이 아니면 `not_human`, 모르는 actor 는 `unknown_actor`로 거부). 한 `Db.writeTx`에서 `event`(source `measurement`, type `measurement.recorded`, `external_id`=`<신호 id>@<주>`, 멱등 키 `measurement:<신호 id>@<ISO 주>`, `occurred_at`=그 주의 끝, payload: 값·관측 수·데이터 품질·측정 구간 `{start, end, tz}`·첨부 `{ref, sha256}`·입력한 사람) → 그 측정을 기다리는(끝나지 않은) 업무마다 `evidence` 2줄 이상(`measurement` 1줄: `ref`=멱등 키, `content_hash`=내용 해시 / 첨부마다 `document` 1줄: `ref`=로컬 참조, `content_hash`=`sha256:<파일 해시>`, 모두 `trust_origin='internal'`, `task_run_id` 없음) → 분을 주면 `human_time` 1줄(금액 0, `units.minutes`). 거부는 `MeasurementRefusedError`(사유 코드: `attachment_required`, `conflict`, `week_not_ended`, `invalid_week`·`invalid_value`·`invalid_observations`·`invalid_quality`·`invalid_attachment`·`invalid_minutes`·`invalid_signal`). ② **대기 조건.** domain `validateTaskSpec`이 `inputs[kind=measurement]`(`measurement:<신호 id>@<YYYY-Www>`, 있는 주만, 업무당 1개)를 검증한다(U11 의 `task_result`와 같은 자리). `claimNextTask`의 후보 SQL 에 "측정 입력의 이벤트가 모두 있음" 조건(`MEASUREMENTS_RECORDED_SQL`, `json_each`)을 더했다. 집힐 때 아직 측정 근거가 없는 업무(측정 뒤에 만들어진 업무)에는 같은 트랜잭션에서 붙인다. 기다리는 업무는 `listMeasurementWaits`(사유 `measurement_pending: ...`). ③ **신호 조회기.** evaluation `createMeasurementSignalSource({db, signals})`(`EffectSignalSource` 구현, 읽기 전용): 업무 명세의 측정 입력 → 이벤트·근거 → `EffectSignal{name: <신호>@<주>, values: [값], observations, minObservations: min_observations, dataQualityOk, passAtLeast: pass_threshold}`. 포트에 선택 필드 `observations`·`qualityNote`를 더했다(생략 시 기존 동작). 신호 미정의·이벤트 없음·payload 이상은 "측정 불가". ④ **입력 경로.** apps/daemon `measure.ts`(`createMeasurementHandler`, `measure`·`measurements` 명령)와 승인 CLI `approve.ts measure <신호> <값> --observations N --quality good|poor --attach <파일> [--attach …] [--week YYYY-Www] [--minutes M]`·`measurements`. `assembleDaemon`이 소켓 처리기를 조합해 두 명령만 측정 채널로, 나머지는 `engine.handle`로 보낸다(`Daemon.handleChannelRequest`). 신호 정의는 팩(`pack.signals`) 또는 새 옵션 `measurementSignals`(둘 다 주면 거부)에서 오고, 평가 포트가 있고 `effect`를 따로 주지 않았으면 신호 조회기를 연결한다. 스키마·허용표·경계 lint·sql-guard 는 바뀌지 않았다.
- 해석·결정:
  - **주 키.** ISO 8601 주(월요일 00:00 시작, 그 해 첫 목요일이 든 주가 W01)를 신호 정의의 `tz` 벽시계로 센다(domain `iso-week.ts`는 달력만, 순간 ↔ 벽시계는 task-engine 이 `schedule.ts`의 시간대 산술을 재사용). 명세에는 **명시 주만** 둔다: 상대 지정을 저장하면 같은 업무가 시간이 지나 다른 주를 기다리게 된다. 입력할 때 주를 생략하면 주입된 Clock 의 지금이 속한 주의 바로 앞 주(끝난 마지막 주)이고, 구간 끝이 지금보다 뒤인 주(끝나지 않은 주)는 `week_not_ended`로 거부한다. 루틴 템플릿이 "지난주"를 명세에 넣는 내장 자리표시자는 아직 없다(U15/U16 에서 발화 시각으로 주를 계산해 넣는다).
  - **같은 입력의 판정.** 값·관측 수·품질·첨부 해시 *집합*이 같으면 같은 입력이다(첨부 경로 문자열·입력한 사람·분은 비교하지 않는다). 같으면 아무것도 쓰지 않고 첫 기록을 돌려주며(근거·비용도 더하지 않음), 다르면 `conflict`로 거부한다.
  - **대기 조건 구현.** 후보 선택 SQL 의 WHERE 에 넣었다(LIMIT 앞): 기다리는 업무가 한 번의 claim 이 보는 후보 수(20)보다 많아도 다른 업무가 굶지 않는다. 상태를 바꾸지 않으므로 허용표에 전이를 더하지 않았고 시도도 소모하지 않는다. `task_result`(U11)는 기다려도 충족되지 않아 `needs_review`로 보내지만, 측정은 사람이 나중에 넣으므로 기다린다.
  - **인증 경계.** 승인 CLI 와 같은 Unix 소켓(0700 디렉터리·0600 소켓) + 요청 actor 의 `actor.kind='human'` 확인을 채널에서 한 번, `recordMeasurement`에서 한 번 더 한다. TOTP 재인증은 요구하지 않는다(값 입력은 외부 부작용·정책 변경이 아니다, A6 결정 ③과 같은 "사람 1인 확인"). 에이전트는 컨테이너 안에서 돌아 소켓이 보이지 않는다(Q26). 첨부 파일은 CLI 가 읽어 해시를 내고 데몬은 파일을 읽지 않는다 — 소켓에 접속할 수 있는 사람의 자기 신고이며, 값 자체와 같은 신뢰 수준이다.
  - **근거와 비용의 귀속.** `evidence.task_id`가 NOT NULL 이라 근거는 업무별로 붙는다(측정 1건을 여러 업무가 기다리면 업무마다 한 벌). `human_time` 비용은 한 번만 세려고 가장 먼저 만든 대기 업무에 붙이고, 대기 업무가 없으면 업무 없이 남긴다(`units.event_id`·`units.measurement`로 추적). 분을 주지 않으면 비용 줄은 없다.
  - **효과 판정의 관측 수.** "1주 = 관측 단위 1"(A6 결정 ②)이므로 값은 1개이고, 사람이 밝힌 `observations`(그 주 값이 모은 관측 수)를 신호의 `min_observations`와 비교한다. 첨부 근거는 데이터 품질 조건으로 다룬다(없거나 업무의 `internal` 근거 행과 해시가 맞지 않으면 `poor_quality`).
- 시험: 단위 `task-measurement`(ISO 주 표·53주 해·연 경계·DST 주 구간, 명세 형식, 에이전트·모르는 actor 거부와 무기록, 첨부 없음 거부, 형식 오류, 기본 주·끝나지 않은 주, 같은 입력 N회 → event 1·근거 1벌·비용 1줄, 다른 값·관측 수·품질·첨부 → `conflict`·첫 값 유지, 대기: 전이·run·시도 없음과 사유 목록, 대기 업무 25개가 있어도 다른 업무 선택, 입력 뒤 다음 claim 과 측정 뒤 생성 업무의 근거, 다른 주·다른 신호는 풀지 않음), `evaluation-measurement-source`(met → pass, below → fail, insufficient·poor(사람 표시)·첨부 없음·첨부 근거 불일치 → inconclusive, 미정의 신호, 측정 입력 없음 → null, 조회는 쓰기 0, 상수 대조), `daemon-measure`(처리기 조합: 에이전트 거부, 입력·목록·충돌, 나머지는 승인 엔진, 신호 없음, 조립에서 대기 → 입력 → 실행 → 평가에 효과 반영). 통합 `daemon-measurement`(같은 DB 를 여는 데몬 두 프로세스 + 실제 CLI: 소켓 권한 없음 EACCES, 에이전트 거부, 첨부 없음 거부, 입력 반영·반복 1건·다른 값 거부, 파일 내용 미저장, 대기 중 다른 업무 1회 실행, 입력 뒤 두 데몬의 동시 tick 에서 1회 실행).
- 열린 항목: ① **정정 절차.** 잘못 넣은 값을 바로잡는 경로가 없다(덮어쓰기 거부만). 정정은 원래 이벤트를 남긴 채 새 기록(예: `measurement-correction`)과 사람 승인을 두는 방식이 후보이며, 이미 그 값으로 평가된 업무의 처리도 함께 정해야 한다. ② 정의되지 않은 신호를 기다리는 업무는 생성 단계에서 거부되지 않고 계속 기다린다(대기 목록에는 보인다). ③ 첨부 파일이 나중에 바뀌었는지(해시 재확인)는 보지 않는다 — 평가기는 근거 행의 해시와 이벤트의 해시만 대조한다. ④ 한 업무의 측정 입력은 1개다(여러 주·여러 신호의 비교는 U14 의 후보 비교기 몫). ⑤ 측정 대기 업무에 만료·알림은 없다.

## 3. 필수 테스트 매핑

[overview §6 필수 테스트 표](../00-overview.md) 중 Phase A 항목. "주 패키지"는 테스트를 소유하는 곳이고, A6에서 통합 시나리오로 한 번 더 확인한다.

| 영역 | 필수 테스트 | 주 패키지 | 단계 | 완료 기준 |
|---|---|---|---|---|
| 데몬 복구 | 업무 실행 중 프로세스 종료 후 상태 복구 | `task-engine` | A2 | `running` 중 프로세스를 강제 종료 후 재시작하면 lease 만료를 거쳐 새 attempt로 이어지고 중복 실행이 없다. `dispatched`/`unknown` 부작용이 있으면 재전송 없이 [recovery §3](../operations/recovery.md) 규칙대로 처리 |
| 중복 방지 | 동일 이벤트 N회 전달 시 업무 1건·부작용 1건, 동시 워커 중 하나만 실행 | `task-engine` | A2 | 같은 `idempotency_key` N회 → `task` 1건, 외부 부작용 1건. 워커 두 개가 같은 `queued` 업무를 잡아도 하나만 성공. 멱등 키 미지원 도구의 `unknown`은 자동 재전송되지 않고 `needs_review`. lease를 잃은 워커는 부작용을 보내지 않는다 |
| 승인 | 승인된 내용과 실행 인자가 다르면 실행 차단 | `policy` | A3 | `approved_hash` 불일치 시 `running` 진입이 막히고 `needs_review`(재승인)로 간다. 승인(`approval`)은 `actor.kind='human'`만 기록 가능. 에이전트 프로세스가 사람 승인 채널로 승인을 시도하면 인증 단계에서 실패한다 ([trust-boundaries §3.1](../security/trust-boundaries.md)) |
| 권한(정책) | 역할 생성·라우팅 변경만으로 권한 확대 불가 (Phase A는 정책 측만) | `policy` / `agent-runtime` | A3 (판정) + A5 (게이트웨이·OS 수준) | A3: 역할/라우팅 데이터를 바꿔도 같은 요청 7요소의 `policy_decision`이 allow로 바뀌지 않는다. A5: 에이전트 프로세스가 도구 게이트웨이를 거치지 않고 정책 저장소·상태 전이 API·DB 파일에 접근할 수 없다(OS 수준 분리). 역할 생성 경로는 Phase B 소관이므로 B에서 재확인 |
| 정책 변경 | 실행 전에 정책이 강화되면 재검증 | `policy` | A3 | 승인 후 정책 버전을 강화하면 실행 직전 새 정책으로 재판정되어 거부된다. 과거 승인이 더 엄격해진 정책을 무효화하지 못한다 |
| 평가 독립성 | 실행 에이전트 보고서만으로 성과 확정 불가 | `evaluation` | A4 | 보고서만 있는 입력은 `pass`가 나오지 않는다. 관측 수 부족은 `inconclusive`. `safety='fail'`이면 효과 점수와 무관하게 `fail`. `inconclusive`가 성공 사례로 기록되지 않는다 |
| 비용 | 모델 호출·도구 사용 비용을 업무·실행별로 집계 | `evaluation` | A4 (기록은 A5) | 가짜 어댑터가 보고한 비용이 `task`·`task_run` 단위로 합산된다. 실행 중 `cost_progress`(또는 게이트웨이 호출별 계량)로 누적 비용을 기록하고, 예산을 넘으면 종료를 기다리지 않고 실행을 취소한다 ([ADR-0005](../adr/0005-agent-adapter-boundary.md) Amendment, [ADR-0007](../adr/0007-independent-evaluation.md)) |
| 외부 게시 | 승인 없는 콘텐츠와 내부 전용 데이터의 공개 차단 | `policy` / `agent-runtime` | A3 (판정) + A5 (게이트웨이·OS 수준) | A3: 승인 없는 `public`/`customer` 게시 요청은 거부. `sensitivity`가 내부 이상인 데이터를 `public` 대상에 쓰려는 호출은 거부. A5: 에이전트가 게이트웨이를 우회해 외부로 직접 게시할 경로(허용 목록 밖 네트워크 등)가 없다 ([trust-boundaries §3.1·§6](../security/trust-boundaries.md)) |
| 기억 | 반증·만료 정보를 현재 사실로 취급하지 않음, 외부 입력 지시문 무효 | `domain` / `agent-runtime` | A1 (신뢰·만료) + A5 (지시문) | A1: 현재 사실 조회에서 `refuted`/만료 항목이 제외되고, 외부 입력 유래 항목은 `hypothesis`/`unverified`로만 들어간다 ([memory-item](../schema/memory-item.md)). A5: 외부 입력에 지시문을 넣은 주입 시나리오에서 도구 호출·권한이 바뀌지 않는다. `memory` 패키지는 분리하지 않는다 |

추가로 A5에서 어댑터 계약 테스트(모든 어댑터가 동일 계약을 만족)와 도구 게이트웨이 계약 테스트(허용 도구 외 호출 거부, 호출별 정책 판정·비용 계량 기록)를 통과해야 하며, 이는 표의 항목은 아니지만 A6의 선행 조건이다.

## 4. 저장소 부트스트랩 체크리스트 (A0)

선택이 필요한 항목은 open-questions를 가리킨다. 선택 전에는 가정만 적고 코드를 시작하지 않는다. 사람이 정할 항목의 선택지와 권장안은 [A0 결정 초안](a0-decisions.md)에 있다.

- [x] 런타임과 DB 확정: TypeScript(Node LTS), SQLite (DDL은 Postgres 이식 가능 범위) — [Q2](../open-questions.md) 해소 (2026-10-19)
- [x] 패키지 구조: `packages/` 아래 5개 패키지와 `apps/daemon` 엔트리포인트의 빈 골격, 패키지별 공개 API 진입점 하나
- [x] `packs/` 골격: 첫 팩 `packs/example-marketing`(manifest, `workflows/`, `routines/`, `evaluations/`)의 빈 골격 ([ADR-0012](../adr/0012-extension-unit-contract.md))
- [x] 팩 경계 lint: 팩은 코어 내부 모듈(`packages/*`의 공개 API 밖)을 참조하지 않는다. 위반이 CI에서 실패 — [Q19](../open-questions.md)
- [x] 모듈 경계 lint: 의존 방향 위반(`domain`이 상위를 참조, `agent-runtime`이 `domain` 외 하위 내부 모듈을 직접 참조 등)이 CI에서 실패 — [Q19](../open-questions.md). `npm run lint:boundaries`, 규칙은 `test/boundaries`가 위반 주입으로 고정 시험(워크스페이스 `exports` 해석 누락도 잡는다). `task-engine`/`policy`/`evaluation` 상호 참조는 막아 두었고 A1 이후 필요 시 조정
- [x] 테스트 러너: 단위·통합 구분, SQLite 인메모리 또는 임시 파일 격리, 프로세스 종료 시나리오를 실행할 수 있을 것. 동시 워커 테스트는 같은 DB 파일을 여는 다중 프로세스로 수행한다(단일 프로세스 내 동시성으로 대체하지 않음) — [Q20](../open-questions.md). `node:test`: `npm run test:unit`/`test:integration`/`test:boundaries`, 예제는 `test/integration/multiprocess-write.test.ts`(6프로세스 경쟁 + SIGKILL)
- [x] 마이그레이션 적용 방식과 SQLite 접근 계층: WAL 모드, `busy_timeout` 설정, 상태 전이·lease 획득은 `BEGIN IMMEDIATE` 트랜잭션 — [Q24](../open-questions.md). `packages/domain/src/db/`: `openDb`(busy_timeout 먼저, WAL), `Db.writeTx`(IMMEDIATE 전용, 쓰기는 이 안에서만), 순수 SQL 러너 `applyMigrations`. `migrations/0001`의 원천은 A1에서 결정(2026-10-19, 관리자): `docs/schema/schema.sql`이 설계 기준(단일 원천)이고 `migrations/0001_init.sql`은 그 복사본이다. 이후 변경은 새 마이그레이션과 `schema.sql`을 동시에 고치며, 드리프트 시험(`test/unit/schema-drift.test.ts`)이 빈 DB에 마이그레이션 전부를 적용한 결과와 `schema.sql` 적용 결과의 `sqlite_master`(정규화)를 비교해 다르면 실패시킨다. 보완(2026-10-19, 관리자): 첫 공개 릴리스 전까지는 배포된 DB가 없으므로 `migrations/0001_init.sql`을 `schema.sql`과 함께 직접 수정한다(드리프트 시험 유지). 첫 릴리스 이후에는 새 마이그레이션만 추가한다
- [x] 비밀값 스캔과 금지어 스캔을 CI(및 커밋 전)에 연결 — [Q21](../open-questions.md), [공개 전 검사](../security/public-repository.md). gitleaks 8.30.1 `--redact`: `.gitleaks.toml`, `npm run scan:secrets`/`scan:history`, `.githooks/pre-commit`(`npm run hooks:install`). 인스턴스별 금지어 목록은 저장소 밖(`instance/gitleaks-banned.toml` 또는 `AOT_BANNED_CONFIG`)
- [x] 설정 분리 (`.env.example`, `config/daemon.config.example.json`): 저장소에는 `*.example`만, 실제 값은 `instance/`·환경 변수. `.gitignore`에 `instance/`·`*.db`·`*.db-*`·`*.sqlite*`·`*-wal`·`*-shm`·`*-journal`·`plans/` 포함 확인 ([공개 저장소 규칙](../security/public-repository.md))
- [x] 시계 주입: lease 판정·heartbeat·만료 계산은 주입된 `Clock`이 준 시각을 SQL 파라미터로 넘긴다. SQL의 `now()`/`CURRENT_TIMESTAMP`는 쓰지 않는다 ([recovery §2](../operations/recovery.md)). `Clock`/`FakeClock`(`@aot/domain`), 세 겹 강제: `Db`가 SQL 문자열을 거부, ESLint 규칙 `aot/no-sql-clock`, `.sql` 파일 스캔 시험
- [x] 가짜 어댑터·가짜 외부 도구(멱등 키 지원/미지원 두 종류) 골격 — `test/support/fake-tool.ts`(멱등 지원/미지원), `fake-adapter.ts`(A5 U4에서 `packages/agent-runtime/src/fake-adapter.ts`로 대체). 어댑터 계약 자체는 A5에서 정의
- [x] 스파이크 결과 기록 위치 `docs/spikes/` 생성 ([ADR-0009](../adr/0009-build-vs-reuse.md))
- [x] CI 필수 통과 항목 정의: 타입 검사, lint(경계 포함), 테스트, 스캔 — `.github/workflows/ci.yml`(스키마 적용 `sqlite3 :memory: < docs/schema/schema.sql` 포함). 원격 실행은 첫 push 후 확인

## 5. 스파이크

스파이크는 결과가 구현 방향을 바꿀 수 있는 질문에 대해 **시간을 정해** 수행하고, 산출물은 `docs/spikes/`에 기록한 뒤 관련 ADR·open-questions를 갱신한다. 판정 기준은 시작 전에 고정하며, 결과를 보고 바꾸지 않는다. 외부 서비스 호출이 필요한 스파이크는 사람의 사전 승인 아래 별도 환경에서만 수행한다.

### 스파이크 1: Q3 오케스트레이션 (LangGraph vs Microsoft Agent Framework) — Phase A 후속

| 항목 | 내용 |
|---|---|
| 목적 | 실행 조정 계층 후보 중 **하나**를 고른다 ([ADR-0009](../adr/0009-build-vs-reuse.md)). 둘 다 도입하지 않는다 |
| 시점 | Phase A 종료 후 (A5 선행 아님. Phase A는 자체 상태 머신으로 진행) |
| 시나리오 | 주간 사이클 축소판: 조사 → 검증 → 사람 승인 대기 → 재개 (가짜 모델 사용) |
| 산출물 | 후보별 축소 구현, 비교표, 결정 기록(ADR-0009 갱신) |
| 판정 기준 | (1) 프로세스 재시작 후 승인 대기 상태에서 재개된다 (2) 비용·근거를 `agent-runtime` 출력 계약으로 추출할 수 있다 (3) `domain` 모델·DB를 소유하지 않고 어댑터 뒤에 숨길 수 있다 (4) 정책 게이트웨이를 우회하는 도구 호출 경로가 없다. 네 기준을 모두 만족한 후보 중 코드량과 의존성이 적은 쪽. 둘 다 불충족이면 도입하지 않고 자체 상태 머신만 사용 |

### 스파이크 2: Q4 헤드리스 코드 에이전트 (OpenHands) — Phase A 후속

| 항목 | 내용 |
|---|---|
| 목적 | 코드 에이전트가 대화 세션 밖에서 작업하고 구조화된 결과를 반환할 수 있는지 확인 ([ADR-0005](../adr/0005-agent-adapter-boundary.md)) |
| 시점 | Phase A 종료 후 (코드 작업 역할은 Phase A 후속이며, Phase A의 실제 어댑터는 읽기 전용 조사 에이전트) |
| 시나리오 | 가상 저장소에서 읽기 전용 작업 1건 → 이후 격리된 쓰기 작업 1건 |
| 산출물 | 실행 방법 기록, 어댑터 계약 매핑표(입력·출력·비용·로그), 격리 한계 목록 |
| 판정 기준 | (1) 사람 개입 없이 시작·종료되고 종료 코드로 성공/실패를 알 수 있다 (2) 결과가 `result`/`evidence`/`run_log`/`cost` 형태로 변환 가능하다 (3) 파일시스템 범위·네트워크 허용 목록·시간 한도를 강제할 수 있다 (4) 비밀 값을 컨텍스트에 넣지 않고 동작한다. (3) 또는 (4) 불충족이면 어댑터 후보에서 제외 |

### 스파이크 3: Q14 멱등 키 지원 조사

| 항목 | 내용 |
|---|---|
| 목적 | 외부 부작용 도구(이메일 발송, 게시, CRM 쓰기)별 멱등 키 지원 여부를 파악해 `supports_idempotency` 계약 값을 정한다 ([recovery §3](../operations/recovery.md)) |
| 시점 | 실제 도구 어댑터 착수 전. A2의 부작용 로직은 지원/미지원 두 종류의 가짜 도구로 먼저 검증 |
| 방법 | 후보 도구의 공식 문서 조사. 실제 발송·게시는 하지 않는다 |
| 산출물 | 도구별 표: 멱등 키 지원 여부, 키 보존 기간, 상태 조회 API 유무, 보상 작업 가능 여부 |
| 판정 기준 | 도구마다 `supports_idempotency=true/false`와 "재전송 전 상태 조회 가능 여부"가 문서 근거와 함께 채워진다. 미지원이면서 조회도 불가한 도구는 Phase A에서 승인 필수·자동 재시도 금지로 분류 |

### 스파이크 4: Q15 lease 파라미터

| 항목 | 내용 |
|---|---|
| 목적 | lease 만료 시간과 heartbeat 주기의 기본값 결정 ([recovery §2](../operations/recovery.md)) |
| 시점 | A2 중간 (lease 구현 직후). 결과 기록은 A2 완료 조건 |
| 방법 | 시간 제어 가능한 테스트 환경에서 파라미터 조합별로 워커 종료·지연·SQLite 쓰기 경합을 시뮬레이션 |
| 산출물 | 파라미터 조합별 결과표(오탐 인수 횟수, 복구 지연, 쓰기 부하), 권장 기본값 |
| 판정 기준 | 정상 워커가 지연 상황(예: 장시간 도구 호출 중 heartbeat 지연)과 SQLite 쓰기 경합(다중 프로세스 워커가 동시에 heartbeat·전이를 쓰며 `busy_timeout` 대기 발생)에서 lease를 잃는 오탐이 0건이고, 종료한 워커의 업무가 복구 지연 목표 내에 인수된다. 목표값(복구 지연)은 스파이크 시작 시 사람이 정한다. 기준을 만족하는 조합 중 heartbeat 쓰기 부하가 가장 작은 것 |

## 6. Phase A 종료 조건

1. §3 표의 모든 테스트가 CI에서 통과한다.
2. 주간 사이클 1~7단계가 가짜 어댑터로 끝까지 실행되고, 실제 어댑터 1개(읽기 전용 조사 에이전트)로 최소 1회 실행된다.
3. 스파이크 3(Q14)·4(Q15)의 결과가 `docs/spikes/`에 기록되고 관련 ADR·open-questions가 갱신된다. 스파이크 1(Q3)·2(Q4)는 Phase A 후속이므로 종료 조건이 아니다.
4. 이 결과를 근거로 [상품 등록 검증 업무](../../workflows/product-registration.md)를 첫 실제 업무로 수행할 수 있는 상태가 된다 ([products](../products/README.md)).
