# 스파이크 Q24: SQLite 접근 계층과 마이그레이션 도구

상태: 완료 (2026-10-19) · 관련: [open-questions Q24](../open-questions.md), [ADR-0001](../adr/0001-modular-monolith.md), [recovery §2](../operations/recovery.md), [schema.sql](../schema/schema.sql), [phase-a §4](../plans/phase-a.md)

## 결론

- **접근 계층: `node:sqlite`(Node 24 내장) 위에 얇은 `Db` 인터페이스(`exec`/`run`/`get`/`all`)와 손으로 쓴 SQL.** 대체 드라이버는 `better-sqlite3` 13.0.3이며 같은 인터페이스의 어댑터 약 15줄로 교체되는 것을 확인했다.
- **마이그레이션: 순서 번호가 붙은 순수 `.sql` 파일 + 자체 러너(약 30줄).** 파일마다 `BEGIN IMMEDIATE` 트랜잭션으로 적용하고 체크섬을 기록한다. `docs/schema/schema.sql`이 `0001`로 그대로 들어간다.
- 쿼리 빌더/ORM(Kysely, Drizzle)은 채택하지 않는다. 필요해지면 아래 "도입 시 주의"를 지킨다.

## 판정 방법 (시험 전에 고정)

[open-questions](../open-questions.md): "후보를 lease 획득 트랜잭션 시나리오로 시험". [phase-a §4](../plans/phase-a.md)의 조건을 기준으로 삼았다: WAL, `busy_timeout`, 상태 전이·lease 획득은 `BEGIN IMMEDIATE`, 마이그레이션 적용, Postgres 이식성.

| # | 항목 | 통과 기준 |
|---|---|---|
| A | `schema.sql` 적용 | 오류 없이 적용, 제약(활성 run 유일 인덱스, append-only 트리거, CHECK)이 동작 |
| B | WAL·`busy_timeout`·`BEGIN IMMEDIATE` | 설정·사용 가능 |
| C | lease 획득 경쟁 | 프로세스 6개가 같은 DB 파일의 업무 100건을 동시에 잡는다. 업무마다 승자 1명, 오류 0건 |
| D | 마이그레이션 | 반복 실행 멱등, 실패 시 부분 적용 없음, 동시 실행 시 중복 적용 없음, `schema.sql` 적용 가능 |

## A. `schema.sql` 적용

```
$ sqlite3 :memory: < docs/schema/schema.sql ; echo $?
0                                                  # sqlite3 CLI 3.51.0
$ sqlite3 :memory: ".read docs/schema/schema.sql" "select count(*) ..."
tables 28 / indexes 35 (자동 생성 포함) / triggers 6
```

`node:sqlite`(SQLite 3.53.4 내장)에서도 같은 개수였고 `better-sqlite3`(`exec`)에서도 오류 없이 적용됐다. 적용 후 `PRAGMA foreign_keys=ON` 상태에서 `foreign_key_check` 0행, `integrity_check` ok. 제약 동작:

```
2nd active run for same task (task_run_single_active) -> rejected: UNIQUE constraint failed: task_run.task_id
UPDATE task_transition (append-only trigger)          -> rejected: append-only
duplicate active dedupe_key (task_active_dedupe)      -> rejected: UNIQUE constraint failed: task.dedupe_key
invalid status (CHECK)                                -> rejected: CHECK constraint failed: status IN (...)
```

## B·C. lease 획득 경쟁 (프로세스 6개 × 업무 100건)

시험 코드는 [recovery §2](../operations/recovery.md)의 획득 절차를 따른다. 만료된 run을 `lease_expired`로 닫고, `queued → running` 갱신이 0행이면 패배, 이어서 `task_run`과 `task_transition`을 삽입한다. 시각은 인자로 넘긴다. "읽기 먼저" 변형은 먼저 `SELECT status`로 확인한 뒤 갱신하는, 흔히 쓰는 확인 후 실행 형태다.

| 접근 계층 | 버전 | `BEGIN IMMEDIATE` (읽기 먼저) | 지연 `BEGIN` (읽기 먼저) |
|---|---|---|---|
| `node:sqlite` 직접 | Node 24.22.0 | 승자 100, 오류 0 | 승자 46, 오류 504 |
| `better-sqlite3` 직접 | 13.0.3 | 승자 100, 오류 0 | 승자 47, 오류 448 (`SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`) |
| Kysely + better-sqlite3 | 0.29.7 | 승자 100, 오류 0 (고정 연결에서 직접 `BEGIN IMMEDIATE`) | 승자 55, 오류 447 (`db.transaction()` 기본 동작) |
| Drizzle + better-sqlite3 | 0.45.4 | 승자 100, 오류 0 (`transaction(fn, { behavior: 'immediate' })`) | 승자 49, 오류 439 |

- 지연 `BEGIN`에서 읽기 뒤에 쓰기로 올라가는 순간, WAL 모드에서는 다른 쓰기가 끼어들면 `busy_timeout`과 상관없이 즉시 `SQLITE_BUSY_SNAPSHOT`이 난다. 승자 수가 줄어든 것은 정합성이 깨진 것이 아니라 **획득 실패(오류)** 다. 어느 경우에도 같은 업무의 활성 run이 둘 생기지 않았다(활성 run 유일 인덱스가 막음). 인덱스는 안전망이고, `BEGIN IMMEDIATE`가 정상 경로다.
- 쓰기로 시작하는 변형(읽기 먼저 아님)은 지연 `BEGIN`도 통과했다(6프로세스×50건, [Q20](q20-test-runner.md) 변이 시험 중 확인). 코드가 나중에 바뀌어 읽기가 앞에 붙어도 깨지지 않도록 항상 `BEGIN IMMEDIATE`를 쓴다.
- Node 25.9에서도 `node:sqlite` 경쟁 시험(IMMEDIATE)은 통과했다.
- 프로세스 강제 종료 후 인수 시나리오는 [Q20](q20-test-runner.md)에서 시험했다.

### 연결 규칙 (시험에서 확정)

1. **`PRAGMA busy_timeout`을 가장 먼저** 설정한다(시험 기본 5000ms). 그다음 `journal_mode=WAL`, `foreign_keys=ON`. 순서가 반대면 여러 프로세스가 동시에 열 때 WAL 전환이 `database is locked`로 실패했다. `busy_timeout=0`이면 6프로세스 중 5개가 열기에서 실패했다.
2. 상태 전이와 lease 획득·갱신은 `BEGIN IMMEDIATE`로 시작해 `COMMIT`/`ROLLBACK`으로 끝낸다. 트랜잭션은 짧게 유지하고 외부 호출을 안에 넣지 않는다.
3. 시각은 `Clock`에서 받아 SQL 파라미터로 넘긴다(시험 코드가 그렇게 했다).
4. `synchronous=NORMAL`로 시험했다. 내구성 정책(전원 손실 시 허용 손실)은 이번에 정하지 않았다.

## D. 마이그레이션

모두 `schema.sql`(`0001`)과 `ALTER TABLE task ADD COLUMN note TEXT` + 인덱스(`0002`)를 적용하고, `0003`으로 일부러 실패하는 파일(테이블 생성 뒤 없는 테이블에 `INSERT`)을 넣고, 6개 프로세스를 동시에 실행했다.

| 방식 | 버전 | `schema.sql` 그대로 적용 | 실패 시 | 6프로세스 동시 실행 | 비고 |
|---|---|---|---|---|---|
| **순수 SQL + 자체 러너** (`node:sqlite`) | 해당 없음 (약 30줄) | 가능 | 파일 단위 롤백 (`ok_table` 0개) | 마이그레이션당 정확히 1회 적용 | 체크섬 변조 감지(`checksum mismatch`). 이미 적용된 파일 재실행은 `[]` |
| Kysely `Migrator` | 0.29.7 | **불가**: 다중 문장 SQL을 거부(`The supplied SQL string contains more than one statement`). 원시 연결 `exec`로 우회해야 적용됨 | **부분 적용이 남음** (`ok_table` 1개, SQLite 어댑터가 트랜잭션 DDL을 쓰지 않음) | 1회씩 적용(이번 실행에서는 정상) | 마이그레이션은 TS/JS 모듈 |
| drizzle-kit | 0.31.11 | 조건부: `generate --custom`으로 빈 파일을 만들고 `schema.sql`을 `--> statement-breakpoint`로 35문장 분할해 넣어야 적용됨 | 대기 중인 마이그레이션 전체가 한 트랜잭션으로 롤백 | 시험하지 않음 | 일반 경로는 TS 스키마에서 DDL을 생성하므로 `schema.sql`과 이중 관리가 된다(`--custom`만 쓰면 회피) |
| dbmate (Go 실행 파일) | 2.37.0 | 가능 (`-- migrate:up` 머리말만 추가) | 롤백 (`ok_table` 0개) | **2개가 `0001`을 동시에 적용 시도해 1개가 `table org_version already exists`로 실패** (최종 상태는 정상) | 외부 실행 파일(릴리스 체크섬 확인함). SQLite용 마이그레이션 잠금 없음 |

```
$ node migrate.mjs db.sqlite migrations
["0001_init.sql","0002_task_note.sql"]
$ node migrate.mjs db.sqlite migrations        # 재실행
[]
# 0003 실패 파일 추가 후
Error: no such table: nonexistent              # ok_table 0개, schema_migration 2행 유지
# 6프로세스 동시 실행 (신규 DB)
[] [] ["0001_init.sql"] [] [] ["0002_task_note.sql"]
```

러너의 요점: 파일마다 `BEGIN IMMEDIATE` → 적용 여부와 체크섬 확인 → SQL 실행 → `schema_migration` 행 삽입 → `COMMIT`. SQLite의 DDL이 트랜잭션 안에서 롤백되고 `BEGIN IMMEDIATE`가 동시 실행을 직렬화하는 성질을 이용한다. Postgres로 옮기면 같은 구조를 `pg_advisory_lock`과 트랜잭션 DDL로 옮기거나 그때 전용 도구를 고르면 된다.

## 선택 이유

- **요구 동작을 가장 직접 표현**한다. `BEGIN IMMEDIATE`, 주입 시각, 활성 run 유일 인덱스, 트리거를 SQL에서 그대로 쓴다. 쿼리 빌더는 모두 이 동작 위에 우회가 필요했다(Kysely는 기본 트랜잭션이 지연형, Drizzle은 `behavior` 옵션).
- **`schema.sql`이 단일 원천**으로 남는다. ORM 스키마를 두면 DDL이 이중이 되고, 부분 인덱스·트리거·CHECK를 TS로 다시 표현해야 한다.
- **의존성 0.** `node:sqlite`는 Node에 포함되어 네이티브 빌드가 없다. 설치 용이성에 유리하다([a0-decisions D1](../plans/a0-decisions.md)의 전제: 단일 파일 DB라 설치·백업이 쉽다).
- **자체 러너의 동시성 안전**이 시험된 후보 중 가장 좋았다(dbmate는 동시 실행 시 오류, Kysely는 실패 시 부분 적용).

## 위험과 대응

| 위험 | 대응 |
|---|---|
| `node:sqlite`의 안정성 등급이 Node 24에서 "Release candidate"(1.2), Node 22에서는 "Active development"(1.1)이다. API가 바뀔 수 있다 | Node 24 이상으로 고정(`engines`). `Db` 인터페이스 뒤에 숨기고, `better-sqlite3` 어댑터(시험 완료)를 대체로 둔다. 업그레이드 시 경쟁 시험([Q20](q20-test-runner.md)의 T1)을 CI에서 돌린다 |
| Postgres 이식 시 SQL 직접 작성분을 다시 써야 한다 | 이식 대상은 `Db`/저장소 계층으로 한정된다. lease 획득은 어차피 `BEGIN IMMEDIATE`가 아니라 행 잠금(`FOR UPDATE SKIP LOCKED` 등)으로 바뀐다. **Postgres는 이번에 시험하지 않았다** |
| 질의가 늘면 타입 안전성이 부족하다 | 저장소 함수 단위로 타입을 선언한다. 부족해지면 아래 쿼리 빌더 도입을 재검토한다 |

### 쿼리 빌더 도입 시 주의 (Kysely/Drizzle을 나중에 쓸 때)

- Kysely `db.transaction()`은 `begin`(지연)만 발행한다. lease·상태 전이는 `db.connection().execute()`로 연결을 고정하고 직접 `BEGIN IMMEDIATE`를 발행해야 했다.
- Kysely/`better-sqlite3`의 `prepare`는 다중 문장을 거부해 `schema.sql`을 질의 계층으로 적용할 수 없다. 마이그레이션은 원시 연결의 `exec`로 한다.
- Drizzle은 `behavior: 'immediate'`가 있어 lease 획득이 자연스럽게 표현된다. 다만 `drizzle-kit`의 TS 스키마 생성 경로는 쓰지 않는다.

## A0에 반영할 것

- `migrations/0001_init.sql`은 `docs/schema/schema.sql`에서 시작한다. 이후 원천이 `migrations/`가 될지 `schema.sql`이 될지(생성 파일) 정해야 한다. 이번에는 정하지 않았다.
- 연결 열기 함수 하나에 위 규칙을 모으고, 다른 곳에서 직접 `new DatabaseSync`를 만들지 못하게 경계 lint(Q19)에 넣는다.
- `.gitignore`에 `*.db`, `*.db-wal`, `*.db-shm`이 이미 요구된다([phase-a §4](../plans/phase-a.md)).

## 사용 버전

Node 24.22.0 (내장 `node:sqlite`, SQLite 3.53.4), better-sqlite3 13.0.3 (Node 24 arm64 사전 빌드 사용), Kysely 0.29.7, drizzle-orm 0.45.4, drizzle-kit 0.31.11, dbmate 2.37.0, sqlite3 CLI 3.51.0. macOS arm64.
