# 복구와 중복 실행 방지

ADR-0004(생성 멱등성)를 **실행 소유권**과 **부작용 멱등성**으로 확장한다. SQLite + 폴링 데몬으로 시작해도 이 계약은 처음부터 적용한다.

## 1. 세 가지 멱등성

| 수준 | 막는 것 | 수단 |
|---|---|---|
| 업무 생성 | 같은 이벤트/루틴이 같은 업무를 중복 생성 | `event.idempotency_key`, `routine_firing` PK, `task` 활성 dedupe 인덱스 |
| 실행 소유권 | 두 워커가 같은 업무를 동시에 실행 | `task_run` lease (`lease_owner`, `lease_expires_at`), 활성 run 유일 인덱스 |
| 부작용 | 재시도 시 이메일·게시·API 호출이 두 번 실행 | `external_effect.effect_key` UNIQUE, 외부 시스템의 멱등 키 |

## 2. 실행 소유권(lease)

| 필드 | 의미 |
|---|---|
| `run_id` (`task_run.id`) | 실행 시도 식별 |
| `attempt` | 시도 번호 (`UNIQUE(task_id, attempt)`) |
| `lease_owner` | 현재 실행을 소유한 워커 |
| `lease_expires_at` | 소유권 만료. 워커는 만료 전에 `heartbeat_at`과 함께 갱신 |
| `checkpoint` | 복구에 필요한 진행 상태 (JSON) |

규칙
1. `queued → running` 전이와 run 생성은 **한 트랜잭션**에서 수행한다. 활성 run 유일 인덱스가 두 번째 워커의 진입을 막는다.
2. **펜싱.** 확인과 전송 사이에 lease가 만료될 수 있으므로 "확인 후 전송"만으로는 안전하지 않다. 부작용 전송 직전의 `external_effect` 상태 갱신(`planned → dispatched`)과 `heartbeat` 갱신은 모두 하나의 트랜잭션에서 아래 조건을 만족할 때만 성공한다.
   - `task_run.lease_owner = 나` AND `lease_expires_at > now` AND `outcome IS NULL`
   - 조건 불충족(갱신 행 0건)이면 부작용을 보내지 않고 즉시 중단한다. 전송 후에 lease를 잃은 경우는 이미 `dispatched`로 기록돼 있으므로 인수한 워커가 §3 절차로 처리한다.
   - 외부 호출의 최대 소요 시간은 lease 만료 시간보다 짧게 두거나, 호출 중에도 heartbeat가 갱신되도록 한다.
3. lease가 만료된 run은 다른 워커(또는 재시작한 데몬)가 인수할 수 있다. 인수 시 기존 run은 `outcome='lease_expired'`로 닫고 새 `attempt`를 만든다.
4. 인수한 run은 `checkpoint`부터 이어 가되, **이미 `dispatched`/`unknown` 상태인 부작용은 §3 절차를 먼저 거친다.**
5. 시각은 **주입되는 단일 `Clock`** 에서 얻어 쿼리 파라미터(`now`)로 넘긴다. Phase A는 단일 호스트의 SQLite만 지원하므로 모든 워커가 같은 호스트 시계를 쓴다. SQL 내부의 `now()`/`datetime('now')`는 lease 판정에 쓰지 않는다(테스트에서 시간을 제어할 수 없기 때문). 다중 호스트·Postgres로 옮길 때는 DB 시각을 `Clock` 구현으로 교체한다.
6. 기본값은 lease 90초, heartbeat 30초다([스파이크 Q15](../spikes/q15-lease-parameters.md)). heartbeat 주기는 lease보다 짧아야 하고, heartbeat가 lease 상실이 아닌 이유(쓰기 대기 초과 등)로 실패하면 다음 주기에 다시 쓴다.

## 3. 부작용 멱등성

모든 외부 부작용(이메일, 게시, 결제, 외부 API 쓰기)은 호출 전에 `external_effect`를 `planned`로 기록한다.

`effect_key = hash(task_id, step_id, canonical(request))` — 재시도해도 같은 키가 나온다.

```
planned → dispatched → confirmed
                    ↘ failed        (외부가 명확히 실패 응답)
                    ↘ unknown       (타임아웃, 응답 유실, 워커 사망)
confirmed → compensated (보상 작업이 실행된 경우)
```

재시도 규칙

| 상태 | 외부 시스템이 멱등 키를 지원 | 지원하지 않음 |
|---|---|---|
| `planned` | 전송 | 전송 |
| `dispatched`/`unknown` | 같은 키로 재전송 허용 | **재전송 금지.** 외부 상태를 조회해 확인. 조회 불가면 `needs_review`로 보내 사람이 판단 |
| `confirmed` | 재전송하지 않고 결과 재사용 | 동일 |
| `failed` | 재전송 가능(정책 허용 시) | 동일 |

- 상태가 `unknown`인 부작용이 있는 run은 `outcome='effect_unknown'`으로 닫는다. 멱등 키 미지원 도구면 업무는 `retry_wait`가 아니라 `needs_review`로 간다. 멱등 키 지원 도구면 업무를 `queued`로 돌려 같은 키로 재전송한다(위 표, 2026-10-19 사람 확인).
- 외부 부작용 도구를 쓰는 어댑터는 `supports_idempotency`를 계약에 선언해야 한다 (`tool_contract_version`에 포함).
- 후보 도구 13개의 지원 여부(문서 조사, 2026-10-25)는 [스파이크 Q14](../spikes/q14-idempotency-support.md)에 있다. 문서로 확인하지 못한 도구는 `false`로 선언한다.

멱등 선언과 재전송 조건 (2026-10-25 사용자 승인. **엔진에 구현됨** — 커밋 7fc4b02, fc84679. 실제 어댑터와 어댑터 계약 시험은 아직 없다)

- **선언 단위는 (도구, `action`)이다.** 형식은 `{supported: true, retention_ms}` 또는 `{supported: false}`이고 `supported=true`면 `retention_ms`(키 보존 기간)가 필수다. 선언은 `tool_contract_version`에 포함되는 계약 데이터다(해시 계산은 아직 안 한다. `create.ts`는 null을 쓴다). `EffectTool.actions`로 선언하고, 검증은 순수 함수(`validateEffectToolDeclaration`)이며 `retention_ms`는 양의 안전 정수(상한 없음)다. `TaskWorker` 생성자가 잘못된 선언을 `EffectDeclarationError`로 거부한다. 같은 서비스도 동작마다 다르다(예: 어떤 서비스는 쓰기 요청만 키를 받고 조회·삭제는 정의상 멱등).
- **위 표의 "같은 키로 재전송"은 보존 기간 안에서만 한다.** `unknown`에서 재전송하기 전에, 최초 전송 준비(`planned`) 시각부터 경과한 시간이 `retention_ms`의 50%를 넘었으면 그 부작용을 "지원하지 않음" 열처럼 다룬다: `lookup`이 있으면 조회하고, 확인되지 않으면 `unknown`이 남아 run은 `effect_unknown`, 업무는 `needs_review`가 된다. 키가 지워진 뒤 같은 키를 쓰면 외부는 새 요청으로 처리해 부작용이 중복될 수 있기 때문이다.
- **기준 시각은 `external_effect.planned_at`이다.** 최초 `planned` INSERT 때만 쓰고 `transitionEffect`는 바꾸지 못한다(`at`은 전이마다 덮어써져 쓸 수 없다). 보존 기간은 INSERT 때 `idempotency_retention_ms`로 스냅숏하고 이후에는 강화(짧게·미지원으로)만 한다. 컬럼은 사전 출시 규칙대로 `migrations/0001_init.sql`과 `docs/schema/schema.sql`에 직접 넣었다.
- **판정 술어는 하나다.** `resendAllowed`(행의 스냅숏만 본다): 경과 ≤ `floor(retention_ms / 2)`이면 열림(경계 포함). 경과가 음수(시계 역행)거나 `planned_at`·현재 시각이 정규 ISO가 아니면 닫힘(fail closed). `performEffect`, `beginDispatch`(쓰기 트랜잭션 안에서 행을 다시 읽고 정책 관문 앞에서 판정, 코드 `not_resendable`), run 정산(`submitRun`/`failRun`/`killRun`/`stopRunForReview`), 만료 run 인수가 같은 술어를 쓴다. 인수도 직접 판정한다(재큐 없음, 시도 소모 없음).
- **닫힘 판정은 행에 남긴다.** 닫힌 것으로 판정한 `unknown` 행은 `(supports_idempotency=0, idempotency_retention_ms=NULL)`로 강화한다. 시계가 뒤로 가도 다시 열리지 않는다. `planned_at`은 그대로다. 새 상태·결과값·상태표 변경은 없다.
- **자연 멱등(고정 외부 ID로 upsert)은 인정하지 않는다.** 키가 없으면 `supported=false`다. 재전송해도 결과가 같다는 것이 "재전송해도 안전"과 같지 않다(그 사이 사람이 고친 값을 덮어쓸 수 있다). 첫 CRM 쓰기 어댑터를 만들 때 다시 정한다. 인정하게 되면 조건은 ① 요청에 `effect_key` 파생 고정 외부 ID를 반드시 쓴다 ② 여러 건 일치는 `failed`가 아니라 `needs_review`로 보낸다 ③ 보존 기간은 "없음"으로 선언한다.
- **조회형(`supported=false`이고 조회 가능)의 `effect_key` 전달.** 어댑터는 `effect_key`를 외부가 검색할 수 있는 자리에 싣는지 선언한다(`metadata` / `slug` / `property` / `none`). `none`이면 `lookup`은 최근 항목의 내용 대조이며, "찾음"만 `confirmed`의 근거가 된다. "못 찾음"은 정보가 없다는 뜻이라 재전송이나 `failed` 판정의 근거로 쓰지 않는다. 내용 대조의 시간 범위는 `dispatched` 시각 이후로 제한한다. **공개 게시물 본문에는 `effect_key`를 싣지 않는다.**
- **오류 매핑(어댑터를 쓸 때 적용, 아직 없음).** 외부가 "재시도하라"고 안내하거나 일부 동작이 성공했을 수 있다고 밝히는 응답(예: 쓰기 충돌 409, 서버 오류 5xx)은 `failed`(명확한 실패)가 아니라 `unknown`으로 기록한다.
- 위 규칙의 ① 보존 기간 초과 시 재전송 안 함 ② 내용 대조 조회의 "못 찾음"이 재전송을 일으키지 않음 ③ "찾음"이 `confirmed`가 됨은 가짜 도구를 쓴 엔진 시험으로 고정했다. 실제 어댑터에 대한 계약 시험(A5)은 어댑터를 쓸 때 넣는다.
- **`submitRun`의 업무 범위 관문 (2026-10-25, 커밋 4e7238a, c69454e).** run 정산 뒤 이 업무(`task_id`) 전체의 `unknown`(어느 run의 것이든)과 다른 run에 남은 `dispatched`를 훑는다. 하나라도 있으면 run은 `effect_unknown`, 업무는 `running → needs_review`이고 `validating`으로 가지 않는다. 재전송할 수 없는 `unknown`(미지원·창 닫힘)은 업무 범위에서도 `(0, NULL)`로 강화한다. 창 안 재전송 가능 `unknown`도 막지만(fail closed) 행은 바꾸지 않는다. 다른 run에 남은 `dispatched`는 정상 경로로는 생기지 않으며, 막고 행은 바꾸지 않는다. `failed`·`confirmed`·`compensated` 행은 막지 않는다. 이유 문구는 이 run의 재전송 불가 / 이전 run이 남긴 재전송 불가 / 다른 run의 `dispatched` / 재전송 가능하지만 미확인으로 구분한다. `failRun`·`killRun`·`stopRunForReview`·인수는 그대로다(창 안 멱등 `unknown`은 `retry_wait`/`queued`로 가 같은 키로 재전송하는 의도된 복구 경로). 상태·결과값·스키마 변경은 없다.
- **닫힘:** 앞 판의 알려진 틈 둘(창 안 멱등 `unknown`이 `validating`으로 감, 이전 run의 `unknown`이 정산에 안 보임)은 위 관문으로 닫았다.
- **닫힘:** 새 run이 다시 계획하지 않는 `unknown`을 사람이 `confirmed`/`failed`로 확정하는 경로를 만들었다(커밋 62056a6). 아래 "사람 확정 절차"를 따른다. 상태표·결과값·스키마 변경은 없다(상태표가 이미 허용한 `unknown → confirmed/failed`(사람)를 처음으로 코드로 낸 것이다).

**사람 확정 절차 (`unknown` 외부 효과).** 승인 CLI(`apps/daemon/src/approve.ts`, 승인 소켓)의 두 명령이다. 사람 actor만 쓴다(소켓 파일 권한 + `actor.kind='human'`을 채널과 트랜잭션 안에서 각각 확인).

1. `effects` — `unknown`인 외부 효과 목록(읽기 전용). 효과 id, 업무 id·상태, run id, 도구·action·대상, `request_hash`, `planned_at`, 마지막 전이 시각(`external_effect.at`), `supports_idempotency`, `resend_window_open`(`resendAllowed`의 순수 판정), `run_active`, `resolved_before`를 보여 준다. 요청 본문·`effect_key`·`response_ref`·메모·TOTP는 나오지 않는다.
2. 사람이 바깥 시스템(수신함, 외부 서비스 화면 등)에서 실제로 나갔는지 확인한다. 엔진은 이를 대신하지 못한다.
3. `resolve-effect <효과 id> --outcome confirmed|failed --note <사유> [--totp-stdin]` — 메모는 필수이고 앞뒤 공백을 자른 뒤 1000자 이하다. 보냈으면 `confirmed`, 보내지 않았으면 `failed`다.
   - `confirmed`: 사람 1인 + 메모. TOTP는 요구하지 않는다(보내도 보지 않는다). `response_ref`는 `human:<해소 이벤트 id>`로 채워진다.
   - `failed`: TOTP 재인증을 항상 요구한다(`--totp-stdin`, 코드는 표준 입력 한 줄). 다시 보내도 된다는 결정이라 되돌리기 어렵기 때문이다. `risky_change.reauth_before_effect`와는 무관하다(그 플래그는 승인 → cooldown → release 흐름의 것). 재인증은 `release`와 같은 연속 실패 잠금·같은 시간창 재사용 거부를 공유하고, 목적은 `effect-resolve:<효과 id>:failed`다.
   - 한 `Db.writeTx`에서 (failed만: `human_reauth` 행) + `external_effect` `unknown → confirmed|failed`(by `human`) + 이벤트(source `effect-resolution`, type `external_effect.resolved`, 멱등 키 `effect-resolve:<효과 id>`, payload: 효과·업무·run·도구·action·대상·`request_hash`·이전 `response_ref`·결과·`actor_id`·메모·시각·`reauth`)가 전부 되거나 전혀 안 된다. `task`·`task_transition`·`task_run`·`approval`·`policy_decision`·`cost_entry`는 쓰지 않는다. TOTP 코드·시간창·요청 본문·`effect_key`는 이벤트에 남지 않는다.
   - 거부 코드(`{ok:false, code, error}`): `invalid_request`, `unknown_actor`, `not_human`, `invalid_outcome`, `note_required`, `note_too_long`, `not_found`, `key_in_use`, `resolved_before`, `outcome_conflict`, `not_unknown`, `run_active`, `reauth_required`, `reauth_failed`, `reauth_locked`, `reauth_reused`(이미 쓴 시간창), `reauth_unavailable`(TOTP 비밀 미등록).
   - 같은 결과를 되풀이하면 아무것도 쓰지 않고 처음 기록을 돌려준다(`applied:false`, TOTP도 다시 쓰지 않는다). 다른 결과면 `outcome_conflict`다. 업무에 끝나지 않은 run이 있으면 `run_active`로 거부한다(실행 중인 쪽이 행을 다시 쓸 수 있다).
4. 업무 상태는 바뀌지 않는다. 업무가 `needs_review`에 있으면 다시 `queued`로 올리는 것은 기존 승인 경로(`show task <id>` → `approve task <id> --hash <보여 준 해시>`)다. 코드가 하는 일(`ApprovalEngine` 의 업무 승인): 상태가 `needs_review`이고 현재 정책이 deny하지 않으며 해시가 맞아야 하고, 요청자 본인 승인 금지 규칙(`self_approval` 파라미터)이 그대로 적용된다. 승인 행이 새로 쓰이고, 정책 판정에 `require_approval`이 없으면 바로 `queued`가 된다. 있으면 승인 상태 판정(`approvalStatus`: 정족수·cooldown·재인증)을 다시 거쳐 통과하면 `queued`, 아니면 그 상태(`cooldown`, `reauth_required` 등)를 돌려주고 `release`가 필요하다. 해소 자체는 승인 행을 만들지 않는다.
5. 다음 run의 동작(시험으로 고정): `confirmed`인 효과를 다시 계획하면 같은 행을 재사용하고 전송은 0회다(`response_ref`는 `human:<해소 이벤트 id>`). 다시 계획하지 않으면 `submitRun`의 업무 범위 관문이 더는 막지 않아 검증으로 간다. `failed`인 효과를 다시 계획하면 `resend_failed` 판정으로 정책 게이트(`beforeEffect`)를 거쳐야만 재전송하고, 거부되면 전송 없이 `failed`로 재사용된다.

위험 등급 결정: `confirmed`는 사람 1인 + 메모, `failed`는 TOTP 항상. `risky_change`의 cooldown·`min_approvers`를 `failed`에 적용하지 않은 이유는 그것이 `approval` 행을 필요로 하는데 `approval.subject_kind`에 `external_effect`가 없고(스키마 변경) 대기/release 단계도 더해야 하기 때문이다. 실제 재전송은 어차피 정책 게이트의 `resend_failed` 허용을 거친다. 알려진 한계: `min_approvers`가 2 이상이어도 한 사람이 `failed`로 확정할 수 있다.

- **남은 열린 항목.** ① 해소한 뒤 재전송이 또 `unknown`이 되면 두 번째 사람 해소는 `resolved_before`로 거부된다(키가 효과마다 하나). 다른 키 방식이 필요하며 사용자 결정 사항이다. ② `failed`의 다중 승인자·cooldown은 스키마 변경이 필요해 사용자 결정 사항이다. ③ TOTP 연속 실패 잠금 기록은 프로세스 메모리에만 있어 재시작하면 초기화된다(기존 한계). 참고: 같은 커밋에서 `#reauth`가 재사용된 유효 코드(이미 쓴 시간창)를 거부하기 전에 실패 횟수를 지우던 기존 약점을 고쳤다(기록이 먼저이고 성공했을 때만 횟수를 지운다).

## 4. 데몬 재시작 시나리오

| 시점 | 복구 동작 |
|---|---|
| `queued`에서 종료 | 변화 없음. 재시작 후 정상 선택 |
| `running`, 부작용 없음 | lease 만료 대기 → run `lease_expired` → 새 attempt (`retry_wait` 거치지 않고 `queued`로) |
| `running`, `planned`만 있음 | 위와 동일. `planned`는 미전송으로 간주하되 `effect_key`로 재사용 |
| `running`, `dispatched`/`unknown` 있음 | §3 표 적용 |
| `validating` | 검증은 재실행 가능해야 한다(읽기 전용). 중복 평가 기록은 `evaluation`의 `UNIQUE(task_id, task_run_id, evaluator)`로 흡수 |
| `retry_wait` | `next_run_at`부터 정상 재개 |
| `needs_review` | 사람 응답 대기. 데몬 재시작과 무관 |

## 5. 타임아웃

- 업무 단위 `time_limit`과 도구 호출 단위 타임아웃을 구분한다.
- 도구 호출 타임아웃 후에는 해당 부작용이 `unknown`이다. "실패"로 간주하지 않는다.
- `time_limit` 초과 시 워커에 취소 신호를 보내고, 종료 확인 전에는 lease를 해제하지 않는다. 구현(A5 U4, `agent-runtime`의 `runAgentTask`): 주입 타이머가 AbortSignal을 보내 어댑터(컨테이너는 `docker kill`)를 멈추고, run은 `killed`로 닫힌다. 취소를 무시하는 어댑터는 유예(기본 10초) 뒤에 포기하고 `terminationConfirmed=false`로 표시하며 그 뒤 도착한 결과·비용 보고는 버린다. 업무 예산 초과도 같은 경로로 `killed`(사유 `budget_exceeded`)가 된다.

## 6. 롤백과의 구분

- **조직 롤백**은 조직 버전과 역할 상태를 복구한다 ([state-machines](../schema/state-machines.md)).
- **업무 롤백은 존재하지 않는다.** 이미 발송된 이메일·게시물은 자동으로 되돌려지지 않는다. `external_effect`에 보상 작업(`compensation_ref`)이 정의된 경우에만 보상 실행을 업무로 생성하고, 없으면 사람의 처리를 요청한다.

## 7. 필수 테스트 (MVP)

- 프로세스 종료 후 `running` 업무가 중복 실행 없이 복구된다.
- 워커 두 개가 같은 `queued` 업무를 동시에 잡으려 해도 하나만 성공한다.
- 같은 이벤트 N회 전달 시 업무 1건, 외부 부작용 1건.
- 멱등 키 미지원 도구에서 `unknown` 상태는 자동 재전송되지 않고 `needs_review`가 된다.
- lease를 잃은 워커가 부작용을 전송하지 않는다.
