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
- `time_limit` 초과 시 워커에 취소 신호를 보내고, 종료 확인 전에는 lease를 해제하지 않는다.

## 6. 롤백과의 구분

- **조직 롤백**은 조직 버전과 역할 상태를 복구한다 ([state-machines](../schema/state-machines.md)).
- **업무 롤백은 존재하지 않는다.** 이미 발송된 이메일·게시물은 자동으로 되돌려지지 않는다. `external_effect`에 보상 작업(`compensation_ref`)이 정의된 경우에만 보상 실행을 업무로 생성하고, 없으면 사람의 처리를 요청한다.

## 7. 필수 테스트 (MVP)

- 프로세스 종료 후 `running` 업무가 중복 실행 없이 복구된다.
- 워커 두 개가 같은 `queued` 업무를 동시에 잡으려 해도 하나만 성공한다.
- 같은 이벤트 N회 전달 시 업무 1건, 외부 부작용 1건.
- 멱등 키 미지원 도구에서 `unknown` 상태는 자동 재전송되지 않고 `needs_review`가 된다.
- lease를 잃은 워커가 부작용을 전송하지 않는다.
