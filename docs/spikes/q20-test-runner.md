# 스파이크 Q20: 테스트 러너

상태: 완료 (2026-10-19) · 관련: [open-questions Q20](../open-questions.md), [phase-a §3·§4](../plans/phase-a.md), [recovery §2](../operations/recovery.md)

## 결론

**`node:test`(Node 내장, 시험 버전 Node 24.22.0)** 를 쓴다. 다중 프로세스 동시 쓰기, 프로세스 강제 종료, 시간 제어, 단위/통합 구분, 임시 파일 격리를 모두 의존성 없이 실행했다. Vitest 5.0.5도 같은 시나리오를 통과했으며, 개발 경험(필터·watch·모의 객체)이 더 필요해지면 옮길 수 있다(전환 비용은 단언 문법 정도, 아래 참고).

## 판정 방법 (시험 전에 고정)

[open-questions](../open-questions.md): "복구·중복 방지 테스트를 작성할 수 있는지로 판단". [phase-a §4](../plans/phase-a.md)의 추가 조건을 기준으로 삼았다.

| # | 시나리오 | 통과 기준 |
|---|---|---|
| T1 | 프로세스 6개가 **같은 SQLite 파일**의 업무 50건을 동시에 `queued → running`으로 잡는다 | 업무마다 승자 정확히 1명, 활성 run 50건, 오류 0건 (단일 프로세스 내 동시성으로 대체하지 않음) |
| T2 | lease를 쥔 프로세스를 `SIGKILL`로 죽이고, 시계를 앞당겨 재시작한 워커가 인수한다 | 만료 전에는 인수 불가, 만료 후 attempt 2, 이전 run은 `lease_expired` |
| T3 | 시간 제어: 실제로 기다리지 않고 heartbeat 3회를 확인한다 | 가짜 타이머로 30초를 즉시 진행 |
| T4 | 단위/통합 분리 실행, 시험별 임시 파일 DB 격리 | 명령 하나로 한쪽만 실행 |

시험 대상은 [recovery §2](../operations/recovery.md)의 lease 획득을 그대로 옮긴 코드다. 실제 `docs/schema/schema.sql`을 적용한 DB에서 `BEGIN IMMEDIATE` 한 트랜잭션으로 `task` 갱신, `task_run` 삽입(활성 run 유일 인덱스), `task_transition` 기록을 수행한다. 시각은 호출자가 넘기는 값(주입된 `Clock`)이며 SQL의 `now()`는 쓰지 않는다. 자세한 접근 계층 비교는 [Q24](q24-sqlite-access-migration.md).

## 후보와 결과

| | `node:test` (Node 24.22.0) | Vitest 5.0.5 |
|---|---|---|
| T1 다중 프로세스 동시 쓰기 | 통과 (6프로세스×50건, 승자 50, 오류 0) | 통과 |
| T2 SIGKILL 후 인수 | 통과 (`fork` + `child.kill('SIGKILL')`) | 통과 |
| T3 시간 제어 | `mock.timers.enable({ apis: ['setInterval','Date'] })` + `tick(30_000)` 통과 | `vi.useFakeTimers()` + `advanceTimersByTime(30_000)` 통과 |
| T4 단위/통합 분리 | 디렉터리 글롭: `node --test "test/unit/**/*.test.ts"` / `--test-concurrency=1 "test/integration/**/*.test.ts"` | `projects: [unit, integration]`, 통합은 `fileParallelism: false`, `--project integration` |
| TypeScript | Node 24 타입 제거로 `.ts` 직접 실행. 가져오기에 `.ts` 확장자 필요 | 내장 변환 |
| 워크스페이스 패키지 이름 가져오기 (`@aot/domain`, `exports`가 `./src/index.ts`) | 통과 (심볼릭 링크라 `node_modules` 밖으로 해석됨) | 시험하지 않음 |
| 추가 의존성 | 0 | 설치 약 35MB |
| 25회 반복 실행 (통합) | 실패 0 | 실패 0 |

미시험: Jest(ESM·TypeScript 변환기 설정이 추가로 필요해 이번 비교에서 제외했다. 시험하지 않았으므로 우열 판단 없음), 커버리지, watch 모드, 스냅샷.

## 실행 기록

```
$ npm run test:unit            # node --test "test/unit/**/*.test.ts"
✔ fake timers: 3 heartbeats after advancing 30s without waiting (0.97ms)
ℹ pass 1  ℹ fail 0

$ npm run test:integration     # node --test --test-concurrency=1 "test/integration/**/*.test.ts"
✔ 6 processes race for 50 tasks on one SQLite file: exactly one winner per task (1660ms)
✔ SIGKILL a lease holder; restart after lease expiry gets attempt 2, no double run (56ms)
ℹ pass 2  ℹ fail 0

$ npx vitest run               # projects: unit, integration
 Test Files  2 passed (2)   Tests  3 passed (3)
```

시험이 실제로 위반을 잡는지 확인하려고 구현을 일부러 깨뜨렸다(변이 시험). 상태 확인 조건 `AND status='queued'`를 지우자 T1이 실패했다(`AssertionError: Expected values to be strictly deep-equal`, 중복 획득 시도가 활성 run 유일 인덱스에 막혀 오류 목록이 비어 있지 않음). 원복 후 통과.

## 시험 코드 형태 (발췌)

```ts
// 프로세스 N개를 같은 시각에 출발시키는 자식 프로세스 기동 (spin 대기로 충돌 유도)
const startAt = Date.now() + 1500;
const results = await Promise.all(
  Array.from({ length: 6 }, (_, i) => runWorker(dbPath, `w${i}`, 50, startAt, NOW)));
const won = results.flatMap((r) => r.won);
assert.equal(new Set(won).size, 50);                       // 업무마다 승자 1명
assert.deepEqual(results.flatMap((r) => r.errors), []);    // SQLITE_BUSY 누출 없음

// T2: 보유 프로세스 강제 종료 후 주입 시계로 만료 처리
child.kill('SIGKILL');
assert.equal(acquire(db, { ...args, now: '2026-10-19T00:00:10.000Z' }).ok, false);   // 만료 전
assert.deepEqual(acquire(db, { ...args, now: '2026-10-19T00:00:31.000Z' }), { ok: true, attempt: 2 });
```

## 시험 중 발견한 것

반복 실행으로 자체 코드의 결함을 찾았다. 같은 파일을 여러 프로세스가 동시에 열 때, `PRAGMA journal_mode=WAL`을 `busy_timeout`보다 먼저 실행하면 WAL 전환이 잠금을 필요로 해 `database is locked`로 즉시 실패했다(Vitest 반복 실행 중 간헐적으로 재현. 참고로 `busy_timeout=0`으로 열면 6프로세스 중 5개가 열기 단계에서 실패했다). **연결을 열 때 `busy_timeout`을 먼저 설정**하고 그다음 WAL을 설정하도록 고친 뒤 양쪽 러너 25회씩 실패 0. 이 순서는 [Q24](q24-sqlite-access-migration.md)의 연결 규칙에 반영했다.

단일 프로세스에서 비동기 호출로 동시성을 흉내 내는 방식은 이 결함(프로세스 간 잠금)을 재현하지 못한다. 다중 프로세스 시험이 필요한 이유의 실례다.

## 선택 이유

- 요구한 시나리오(T1~T4)를 전부 추가 의존성 없이 실행했다. 코드량과 의존성이 적은 쪽을 고른다는 [ADR-0009](../adr/0009-build-vs-reuse.md)의 방침과 맞는다.
- 파일 단위 실행, `--test-concurrency=1`, 글롭 필터로 통합 시험의 직렬 실행을 제어할 수 있다.
- 시험 코드가 외부 러너의 전역 API에 묶이지 않아 나중에 Vitest로 옮기기 쉽다(이번에 시험 파일을 옮길 때 바꾼 것은 단언과 정리 훅 문법뿐이다).

## 주의사항 (A0에 반영)

- Node 24에서 `node --test <디렉터리>`는 디렉터리를 파일로 취급해 실패한다. 글롭 문자열을 따옴표로 감싸 넘긴다.
- Node의 타입 제거는 타입 검사를 하지 않는다. `tsc --noEmit`을 CI에 별도 단계로 둔다. enum 같은 런타임 코드를 만드는 TypeScript 문법은 타입 제거만으로 실행되지 않는다(Node 문서 기준, 이번 시험에서 확인하지 않음). 이를 `tsconfig`의 `erasableSyntaxOnly` 옵션으로 막을 수 있는지는 A0에서 확인한다.
- 다중 프로세스 시험은 통합 시험 디렉터리에 두고 공개 CI에서도 가짜 어댑터만으로 돌 수 있게 한다([공개 저장소 규칙](../security/public-repository.md)).
- Node 버전은 24 이상으로 고정한다. 다중 프로세스 경쟁 시험(T1과 같은 코드)은 Node 25.9에서도 통과했으나 25는 LTS가 아니다.

## 사용 버전

Node 24.22.0 (`node:test`, `node:sqlite` 내장 SQLite 3.53.4), Vitest 5.0.5, TypeScript 5.9.3(경계 시험 쪽), macOS arm64. Node 24는 npm `node@24` 패키지로 격리 설치해 사용했다.
