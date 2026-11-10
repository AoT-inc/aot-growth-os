# 초안 먼저, 그다음 승인 (draft → approve → host dispatch)

상태: 구현됨 (2026-11-05, W1~W10·W12). 남은 것: W11 검토 화면, W13(선택), W14(별도 설계). 구현 기록과 설계에서 달라진 곳은 [ADR-0015 구현 기록](../adr/0015-draft-before-approval.md#구현-기록-2026-11-05)에 있다. 결정 기록은 [ADR-0015](../adr/0015-draft-before-approval.md)(proposed).

## 0. 문제

고객에게 나가는 일(예: 고객 메일)을 사람이 검토 화면([review-web](../operations/review-web.md))에서 승인한다. 지금은 승인이 **에이전트가 내용을 쓰기 전**에 일어난다. 승인 시점 DB에는 업무 목표·명세·대상(예: `mailbox:example`)만 있고 본문도 받는 사람 수도 없다. 사람은 내용을 보지 않고 승인한다.

오너 결정(2026-11-04): 에이전트가 **정확한 내용을 먼저 초안으로 쓰고**, 사람은 그 초안을 승인한다. **나가는 것은 승인한 것과 바이트까지 같아야 한다.**

## 1. 현재 흐름 (코드 기준)

### 1.1 순서

| # | 단계 | 위치 |
|---|---|---|
| 1 | 업무 생성: 역할이 있으면 `queued`. 생성 게이트(`beforeCreate`)는 deny만 거른다 | `packages/task-engine/src/create.ts:118`, `packages/policy/src/gate.ts:37-58` |
| 2 | 정책: 기본 정책은 `external_effect`·`customer`·`public`에 `require_approval` | `policies/default.yaml:30-38` |
| 3 | 스케줄러가 집으면서 `beforeRun` 호출. `require_approval`이 있고 승인이 없으면 `queued → needs_review`(by `policy`), run 없음 | `packages/task-engine/src/lease.ts:166-171`, `packages/policy/src/gate.ts:60-85`(승인 확인 72, 거부 83) |
| 4 | 승인 대상 해시 = 명세(`evidence_refs`·`approved_snapshot` 제외) + 역할·역할 버전·제품 + **승인 시점 정책 버전 id**. 본문은 없다(아직 안 썼다) | `packages/policy/src/approval.ts:114-131` |
| 5 | 사람: `show task <id>` → `approve task <id> --hash <해시>`. 외부 부작용이면 `risky_change` 절차라 승인 행 + `approved_hash`/`approved_snapshot` 기록 후 cooldown | `packages/policy/src/engine.ts:208-237`(`#approveTask`), CLI `apps/daemon/src/approve.ts:266-284` |
| 6 | cooldown 뒤 `release task <id> --totp-stdin` → TOTP 재인증(목적 `release:task:<id>:<hash>`) → `needs_review → queued` | `engine.ts:251-262`(`#releaseTask`), `165-180`(`#reauth`), `239-249`(`#queue`) |
| 7 | 다시 집힐 때 `beforeRun`이 `verifyTaskApproval`로 해시(=명세+현재 정책 버전)·역할 버전·승인자 수·cooldown·재인증을 확인 → `running` | `gate.ts:144-167` |
| 8 | 에이전트 run. 도구 게이트웨이는 호출마다 정책을 새로 판정한다(`judge`). 부작용 + 외부 입력 영향이면 allow도 `require_approval`로 올린다 | `packages/agent-runtime/src/gateway.ts:347-367`, `packages/policy/src/tool-call.ts:32-40` |
| 9 | `require_approval`은 게이트웨이에서 막힌다. 예외는 `bindToEffectLedger`로 만든 실행기뿐이고 그것도 **외부 입력 영향 run이면 막힌다**(하한) | `gateway.ts:371-377`, `packages/agent-runtime/src/effect-ledger.ts:24-51` |
| 10 | 원장에 묶인 실행기 → `RunContext.performEffect` → `performEffect`: `planned` 기록(`effect_key = hash(task_id, step_id, request)`, `request_hash = sha256(canonical(request))`) → `beginDispatch`(펜싱·heartbeat·재전송 창·`beforeEffect`) → `tool.send` → 결과 기록 | `packages/task-engine/src/worker.ts:288-298`, `effects.ts:77-119`(키 92), `135-170`(게이트 158), `200-250` |
| 11 | `beforeEffect`: 요청한 (도구, 작업, 대상)인지, 영향이 `external_effect`인지, 현재 정책 판정, `require_approval`이면 `verifyTaskApproval` **(명세 해시)**. 거부면 run을 멈추고 `running → needs_review` | `gate.ts:87-123`(승인 116-119), `effects.ts:162-166` |
| 12 | run 정산: `unknown`/다른 run의 `dispatched`가 있으면 `needs_review`, 아니면 `validating` → 검증기 | `lease.ts:287-307`, `packages/task-engine/src/validation.ts:26-46` |

요약: **승인은 명세(+대상 범위)에 묶이고, 내용은 승인 뒤 run에서 LLM이 처음 만든다.** `beforeEffect`가 확인하는 것도 명세 해시라서 run이 무엇을 쓰든 대상 범위 안이면 나간다.

### 1.2 이미 있는 비슷한 길

- **게시(`publication`)는 이미 초안 → 승인이다.** 승인 해시에 `content_ref`가 들어가고(`approval.ts:133-144`), 화면이 본문 앞 두 줄을 보여 준다(`apps/daemon/src/review-web/decisions.ts:255-278`). 하지만 게시 게이트는 업무 run·부작용 원장과 별개의 길이라 메일 같은 도구 부작용에 그대로 쓰지 못한다.
- **전화(ADR-0014 §8)는 범위 승인이다.** 사람은 명세의 번호 범위(`allowed_tools[].target`)를 승인한다(`docs/adr/0014-phone-capability.md:73-74`). 통화는 실시간 대화라 내용을 미리 확정할 수 없고, `transfer`·`hangup`은 통화 중 동작이다. **전화는 초안 승인 대상이 아니다**(하위 호환 §6).
- 승인 결정 어휘에 `changes_requested`가 이미 있고(`docs/schema/schema.sql:324`, `packages/domain/src/entities/enums.ts:77`) 쓰는 곳이 없다. 이번에 처음 쓴다.

### 1.3 검토 화면이 지금 읽는 것

`taskInfo`(`decisions.ts:152-170`)는 `task.objective`, `task.spec.allowed_tools`의 `target`·`scope`·`impact`, 마지막 전이 사유만 읽는다. 그래서 「무엇」이 `'<목표>' → mailbox:example (고객에게 전달)`에서 멈춘다(`decisions.ts:197-218`).

## 2. 새 흐름

### 2.1 개요

```
queued ─(beforeRun: phase=draft)─► running[초안 run, 에이전트]
   게이트웨이 → 원장에 묶인 실행기 → RunContext.performEffect (draft 모드)
   = 보내지 않고 effect_draft(pending) 기록, 에이전트에는 {status:'drafted', draft_id}
 ─► submitRun ─► validating ─(검증 통과 + 초안 있음)─► needs_review  [초안 pending → proposed]
사람: show task(초안 본문·해시) → approve task --hash  (해시 = 명세 + 정책 버전 + 초안 payload 해시들)
   → cooldown → release --totp-stdin → queued
 ─(beforeRun: phase=dispatch)─► running[호스트 전송 run, adapter='host:dispatch', LLM 없음]
   저장된 초안을 그대로 performEffect (planned → dispatched → confirmed/unknown, 기존 원장 그대로)
   beforeEffect: request_hash ∈ 승인된 초안 payload 해시, 만료 전, 현재 정책 + 초안 해시 승인 재확인
 ─► submitRun ─► validating(전송 프로필) ─► completed
```

### 2.2 세 가지 run 단계 (`RunPhase`)

| 단계 | 언제(`beforeRun`이 정함) | 누가 도나 | 외부 부작용 |
|---|---|---|---|
| `execute` | 지금과 같다: 승인이 필요 없거나, 범위 승인(`scope`) 업무에 유효한 명세 승인이 있음 | 에이전트 | 지금 규칙 그대로 |
| `draft` | 초안 승인 업무(§2.3)이고 제안된 초안(`proposed`)이 없음. **승인 없이 시작한다** | 에이전트 | **하나도 보내지 않는다.** 원장에 묶인 부작용 호출은 전부 초안이 된다 |
| `dispatch` | 업무에 `proposed` 초안이 있고 그 초안 해시에 대한 승인이 유효함 | 호스트(`host:dispatch`) | 승인된 초안만, 저장된 payload 그대로 |

`beforeRun` 판정 순서(새, `packages/policy/src/gate.ts`):
1. deny·예산 → `needs_review` (지금과 같다).
2. `proposed` 초안이 있으면: `verifyTaskApproval(…, drafts)`가 통과하면 `dispatch`, 아니면 `needs_review`. (정책이 지금은 승인을 요구하지 않더라도 초안이 있으면 `dispatch`로만 간다 — 사람 승인 해시 `task.approved_hash`가 초안 해시와 같아야 한다. 승인 뒤 LLM이 다시 쓰는 길을 만들지 않는다.)
3. 승인이 필요 없으면 `execute`.
4. 업무가 초안 승인 대상(`effectApproval === 'draft'`)이고 **`require_approval` 판정이 모두 `external_effect`** 이면 `draft`.
5. 그 밖에는 지금 규칙(`verifyTaskApproval` 명세 해시 → `execute` 또는 `needs_review`).

### 2.3 어떤 업무가 초안 승인 대상인가

부작용 도구의 (도구, `action`) 선언에 **필수 필드** `approval: 'draft' | 'scope'`를 더한다(`EffectActionDeclaration`, `packages/task-engine/src/idempotency.ts:17-20`).
- `draft`: 보낼 내용 전체를 보내기 전에 확정할 수 있다(메일·메시지·외부 API 쓰기).
- `scope`: 내용을 미리 확정할 수 없다(전화 통화·통화 중 전환·끊기). 지금처럼 명세 범위를 승인한다.

업무 엔진이 집을 때 계산한다(`effectApprovalOf(spec, tools)`): 명세의 `impact: external_effect` 항목마다 같은 이름의 등록된 `EffectTool`이 있고, 요청한 operation이 모두 `approval: 'draft'`로 선언돼 있으면 `draft`. 하나라도 `scope`이거나 등록되지 않았으면 `scope`(지금 동작).

### 2.4 초안 기록 (`draft` 단계)

- **어디서 가로채나: 원장 입구(`RunContext.performEffect`).** 게이트웨이 인자가 아니라, 도구 실행기(Capability)가 검증·정규화한 뒤 원장에 넘기려던 `EffectStep{stepId, action, target, request}`를 그대로 저장한다. 그래서 전송 run은 실행기를 다시 부르지 않고 같은 `EffectStep`으로 `performEffect`를 부르면 되고, `effect_key`·`request_hash`가 초안 때 계산한 값과 같다.
- 저장: 새 테이블 `effect_draft`(§3). payload는 `canonicalJson(request)` 문자열 그대로, `payload_hash = sha256(payload)` = 전송 때 `external_effect.request_hash`.
- 에이전트에 가는 결과: `{ status: 'drafted', draft_id }`. 외부 응답(메시지 id 등)은 없다.
- 같은 run에서 같은 `effect_key`의 초안은 한 번만 만든다(같은 행을 돌려준다). 한 run 최대 20건, payload 최대 256 KiB. 넘으면 그 호출은 `tool_error`.
- 초안 run에서 **원장에 묶이지 않은 부작용 도구 호출은 거부**한다(`approval_required`). 초안 run은 아무것도 보내지 않는다는 불변식을 지키려고 정책이 allow인 부작용도 초안으로 만든다.
- 게이트웨이 하한 변경: 지금은 외부 입력 영향 run이면 원장 실행기도 막힌다(`gateway.ts:373`). `draft` 단계에서는 막지 않고 초안을 만든다 — 보내지 않고 사람이 정확한 내용을 승인하므로. 초안 행에 `influenced_by_external_input=1`을 남기고 화면에 표시한다(§5). `deny`는 그대로 막힌다(초안 없음).
- `scope`로 선언된 action이 `draft` run에서 원장에 오면 던진다(일어나면 안 되는 설정 오류, 기본 거부).

### 2.5 초안의 상태와 검증

`effect_draft.state`:

```
pending ──► proposed ──► rejected     (사람 거절)
   │            └──────► superseded   (사람 변경 요청)
   └──► superseded  (검증 미통과, run이 submit 못 하고 끝남, 새 초안 run 시작)
```

- 초안 run이 `submitted` → `validating` → **검증기가 먼저 본다**(사람은 독립 평가를 통과한 초안만 본다). 평가가 `pass`·`safety pass`이고 그 run에 `pending` 초안이 있으면 `validating → needs_review`(사유 `drafts_awaiting_approval: N건`)이고 초안을 `proposed`로 바꾼다(`validation.human=true`여도 같은 한 번의 사람 단계로 합친다).
- 평가가 `fail`(재시도) → `retry_wait`이고 초안은 `superseded`. `inconclusive`·안전성 실패 → `needs_review`이지만 초안은 `superseded`(승인할 수 없다. 사람은 거절하거나 변경 요청).
- 새 `draft` run을 시작하는 claim 트랜잭션에서 그 업무의 남은 `pending`·`proposed`를 모두 `superseded`로 바꾼다.
- 초안 run의 검증 기준은 *내용*에 대한 것이다(발송 확인은 전송 run의 검증이 한다).
- 안전성 검사 `no_secret_in_outputs`(`packages/evaluation/src/checks.ts:14-16`)가 초안 payload도 훑는다. 비밀처럼 보이는 값이 있으면 `safety fail`.

### 2.6 승인

- 승인 대상 해시(`taskSubject`)에 `drafts` 키를 **초안이 있을 때만** 더한다: `[{draft_id, seq, tool, action, target, step_id, payload_hash, expires_at}]`(seq 순). 본문은 `payload_hash`로 묶인다. 초안이 없으면 키가 없어 **지금 해시와 비트 단위로 같다**.
- `show task <id>`: 지금 내용 + `drafts`(각 초안의 도구·대상·`payload_hash`·만료·외부 입력 영향·payload 원문). 비밀은 표시에서만 가린다(`maskSecrets`). 저장된 payload는 그대로다.
- `approve task <id> --hash <해시>`: 지금 절차 그대로(사람만, 자기 승인 규칙, `risky_change` → cooldown). 만료된 초안이 있으면 거부(`초안 기한 지남 — 변경 요청으로 다시 쓰게 하세요`). `approved_snapshot`은 초안 목록이 들어간 승인 대상 전체다.
- `release task <id> --totp-stdin`: 그대로. 재인증 목적 `release:task:<id>:<hash>`의 해시가 초안을 포함하므로 **TOTP가 정확한 초안 묶음에 묶인다**.
- **전부 아니면 전무.** 한 업무의 초안은 한 해시로 함께 승인한다(건별 승인은 하지 않는다, §8 결정 D3).
- `reject task <id>`: 지금처럼 `needs_review → failed`, 같은 트랜잭션에서 `proposed` → `rejected`.
- **새 명령 `request-changes task <id> --comment <사유>`**: 승인 행(`decision='changes_requested'`, 지금 해시) + `proposed` → `superseded` + `approval_id`·`approved_snapshot`·`approved_hash`를 NULL로 + `needs_review → queued`(사람, 승인 행 id). 다음 `beforeRun`은 초안이 없으니 `draft` 단계. 사유는 다음 초안 run에 사람의 피드백(`internal`)으로 전달한다(작업 W13, 선택).
- `cancel`: 그대로. cooldown 중 취소하면 승인만 무효가 되고 초안은 `proposed`로 남는다(다시 승인 가능).

### 2.7 호스트 전송 (`dispatch` 단계)

- `claimNextTask`가 `phase='dispatch'`면 `task_run.adapter = 'host:dispatch'`로 run을 만든다. 워커는 **에이전트 실행기(`options.executor`)를 부르지 않고** 내장 전송기 `dispatchApprovedDrafts`를 부른다. LLM 호출 0회.
- 전송기는 `proposed` 초안을 `seq` 순으로:
  1. `sha256(payload) === payload_hash`, `effectKeyOf(task_id, step_id, JSON.parse(payload)) === effect_key`를 확인한다. 다르면(행 변조) 보내지 않고 run을 오류로 끝낸다.
  2. `performEffect(db, clock, lease, tools[tool], {stepId, action, target, request: JSON.parse(payload)}, gate)` — 원장 규칙(펜싱, `planned`/`dispatched`/`unknown`/`failed`, 재전송 창, Q14)은 **바꾸지 않는다**.
  3. `confirmed`(새로 보냈든 재사용이든)면 다음 초안. `unknown`이나 `failed`면 멈춘다(뒤 초안은 보내지 않는다).
- 결과 `{dispatched:[{draft_id, effect_id, state}]}`로 `submitRun`. `unknown`이 있으면 기존 업무 범위 관문이 `needs_review`로 보낸다 → 사람 확정(`resolve-effect`) → `approve task`로 재큐 → 다시 `dispatch`(이미 `confirmed`인 초안은 같은 행 재사용, 전송 0회).
- `failed`는 run 오류 → `retry_wait` → 다시 `dispatch`. `failed` 재전송은 지금처럼 정책 판정이 `allow`일 때만이다(승인은 한 번의 전송만 덮는다, `gate.ts:111-115`). 그래서 기본 정책에서는 시도를 다 쓰고 `failed`가 된다 — 지금과 같은 성질.
- lease 만료·데몬 재시작: 기존 인수 규칙 그대로(`running → queued` 또는 `needs_review`) → 다시 `dispatch`.
- `beforeEffect`(새 입력 `phase`, `requestHash`):
  - `phase==='draft'`면 무조건 거부(방어. 전송기 쪽 `beginDispatch`도 `draft` lease면 던진다).
  - `phase==='dispatch'`면 (도구, action, 대상, `requestHash`)가 맞는 `proposed` 초안이 있어야 하고 만료 전이어야 한다.
  - 그 뒤 지금 규칙: 명세의 (도구, 작업, 대상) 일치, `external_effect` 선언, **현재 정책으로 재판정**(deny면 거부), `require_approval`이면 `verifyTaskApproval(…, drafts)`. 정책이 바뀌면 해시가 달라져 거부 → `needs_review` → 사람이 **같은 초안**을 새 정책 해시로 다시 승인(초안을 다시 쓰지 않는다).
- 전송 run 검증(전송 프로필): `task_run.adapter === 'host:dispatch'`면 검증기는 수용 기준을 다시 보지 않고 ① 초안 run의 평가가 `pass`·`safety pass` ② `proposed` 초안마다 같은 `effect_key`의 `external_effect`가 `confirmed`이고 `request_hash = payload_hash` ③ `policy_compliance`만 본다. 통과면 `completed`. 사람 검토(`validation.human`)는 초안 승인 때 이미 했으므로 이 run에서는 요구하지 않는다.

### 2.8 응답에 의존하는 일

초안 run의 에이전트는 외부 응답을 받지 못한다(`{status:'drafted'}`만). 그래서:
- 업무는 전송이 확인되면 끝난다(`completed`). 전송 뒤에 에이전트가 이어서 할 일은 없다.
- 응답이 필요한 다음 일(예: 만든 티켓 번호로 메일 쓰기)은 **후속 업무**로 나눈다: 선행 업무 결과 입력(`inputs[kind=task_result]`, A6-U11)과 `dependencies`. 선행 업무의 결과에 전송 결과 참조(`response_ref`)를 넣는 것은 W8에서 전송 run 결과로 남긴다.
- 한 업무 안에서 "보내고, 응답 보고, 또 보내기"는 초안 승인 업무에서 지원하지 않는다. 그런 도구는 `scope`로 선언한다.

## 3. 스키마·상태 변경

배포된 DB가 없으므로(`docs/schema/schema.sql` 머리말) `migrations/0001_init.sql`과 `schema.sql`을 함께 직접 고친다.

### 3.1 새 테이블 `effect_draft`

```sql
-- 외부 부작용 초안 (ADR-0015). 초안 run 의 에이전트가 원장에 넘기려던 요청을 보내지 않고 남긴다. 사람은 이 내용을 승인하고,
-- 호스트 전송 run 이 payload 를 그대로 보낸다. 에이전트 출력이므로 내용은 항상 신뢰하지 않는 데이터다(trust_origin 은 external_untrusted 로 고정, 컬럼 없음).
CREATE TABLE effect_draft (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  task_run_id  TEXT NOT NULL REFERENCES task_run(id),  -- 초안을 만든 run
  seq          INTEGER NOT NULL,              -- run 안 순서 (전송 순서)
  tool         TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL,
  step_id      TEXT NOT NULL,
  payload      TEXT NOT NULL,                 -- canonicalJson(EffectStep.request). 보낼 바이트 그대로
  payload_hash TEXT NOT NULL,                 -- sha256(payload) = 전송 때 external_effect.request_hash
  effect_key   TEXT NOT NULL,                 -- effectKeyOf(task_id, step_id, request) = 전송 때 external_effect.effect_key
  influenced_by_external_input INTEGER NOT NULL CHECK (influenced_by_external_input IN (0, 1)),
  state        TEXT NOT NULL CHECK (state IN ('pending','proposed','superseded','rejected')),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,                 -- 이 시각부터 승인·전송 불가 (기본 created_at + 72h)
  at           TEXT NOT NULL,                 -- 마지막 전이 시각
  UNIQUE (task_run_id, seq),
  UNIQUE (task_run_id, effect_key)
);
CREATE INDEX effect_draft_task ON effect_draft(task_id, state);
```

- 전송 결과는 `external_effect`에 있고 `effect_key`로 잇는다(초안에 `sent` 상태를 두지 않는다 — 원장이 유일한 근거).
- 바꾸지 않는 것: `task`(승인 컬럼 의미만 넓어진다: `approved_snapshot`에 초안 목록이 들어간다), `external_effect`, `approval`(`changes_requested`는 이미 있다), `task_run`(`adapter`에 `host:dispatch` 값만 새로), `evidence`.
- 본문을 근거 저장소(`blob:sha256:` 파일)가 아니라 DB 컬럼에 두는 이유: 초안 기록이 lease 펜싱과 **한 트랜잭션**이어야 하고(파일은 같이 되돌려지지 않는다), 읽기 전용 화면·승인 엔진이 같은 DB에서 해시를 다시 계산할 수 있어야 하며, task-engine이 근거 저장소(`apps/daemon`)에 의존하지 않게 하려고. 첨부는 payload 안에 근거 저장소 참조(`{name, ref:'blob:sha256:…', sha256}`)로만 넣는다(내용 주소라 해시가 내용을 묶는다). v1 메시지 도구는 첨부를 받지 않는다(§9 Q4).

### 3.2 상태표

`docs/schema/state-machines.md`와 `packages/domain/src/state/machines.ts`:
- **업무** 전이는 새로 생기지 않는다. 조건 문구만 넓힌다:
  - `queued → running`: "… 또는 초안 단계(초안 승인 업무, `require_approval`이 모두 `external_effect`, 제안된 초안 없음 — 승인 없이 시작하고 아무것도 보내지 않는다), 또는 전송 단계(제안된 초안 + 초안 해시 승인 유효)".
  - `validating → needs_review`: "… 또는 초안 승인 대기(평가 pass + 그 run의 초안 있음)".
  - `needs_review → queued`(사람): 승인 행 필수 — `approved`(승인·해제) 또는 `changes_requested`(변경 요청, 초안 다시 쓰기).
  - `running → needs_review`: 문구에 "전송 단계의 재검증 거부(초안 불일치·만료·정책 변경)" 추가.
- **새 기계 `effect_draft.state`**:

| From | To | 주체 | 조건 |
|---|---|---|---|
| (none) | pending | 스케줄러(원장 입구) | `draft` 단계 run, lease 보유 |
| pending | proposed | 검증기 | 그 run의 평가 `pass` AND `safety='pass'` |
| pending | superseded | 스케줄러/검증기 | 평가 미통과, run이 submit하지 못함, 새 초안 run 시작 |
| proposed | superseded | 사람/스케줄러 | `request-changes`, 새 초안 run 시작 |
| proposed | rejected | 사람 | `reject task` |

에이전트는 어떤 전이도 일으키지 못한다.

### 3.3 승인 대상(`trust-boundaries` §4 표의 `task` 행)

"명세 + 역할·역할 버전·제품 + 승인 시점 정책 버전 id **+ (초안 승인 업무) 제안된 초안의 `payload_hash`·도구·action·대상·`step_id`·만료 목록**". 절차·재확인 열에 "전송 단계의 `beforeEffect`가 `request_hash ∈ 초안 해시`를 확인" 추가.

## 4. 문서·ADR

- 새 [ADR-0015](../adr/0015-draft-before-approval.md)(proposed): 결정 전체. 다음 ADR에 구현 때 한 줄 포인터 Amendment를 단다: ADR-0006(2026-10-19 A3 구현 단락의 업무 해시), ADR-0005(2026-10-25 `bindToEffectLedger` — 초안 단계의 외부 입력 하한 변경), ADR-0003(승인 스냅샷), ADR-0014 §8(전화는 `scope`).
- `docs/schema/task-spec.md` "버전과 승인 스냅샷"(188-204행), `approved_snapshot` 행(21행).
- `docs/operations/recovery.md` §3 끝에 "전송 run" 단락(원장 규칙 불변, 초안 해시 확인 추가).
- `docs/security/trust-boundaries.md` §4 표, §5 위협 표에 "초안에 주입된 받는 사람" 행.
- `docs/operations/review-web.md` 화면 표.

## 5. 보안 고려

| 항목 | 처리 |
|---|---|
| 보낸 것 = 승인한 것 | 전송 run에 LLM이 없다. 전송기는 저장 payload의 해시와 `effect_key`를 다시 계산해 맞을 때만 보내고, `beforeEffect`가 `request_hash ∈ 승인된 초안 해시`를 한 번 더 확인한다(전송기와 정책 게이트 이중). 승인 해시·TOTP 목적이 초안 해시를 묶는다 |
| 승인 없이 run이 시작된다 | 초안 run은 정책이 승인 없이 허용하는 일과 초안 기록만 한다. 승인이 필요한 읽기(예: `customer` 범위 읽기)가 섞인 업무는 초안 단계로 가지 않고 지금처럼 먼저 명세를 승인받는다(§2.2 4번 조건). 비용(LLM)은 사람이 보기 전에 쓴다 — 거절하면 그 비용은 버려진다 |
| 프롬프트 주입 | 외부 입력 영향 run도 초안은 만든다. 초안은 데이터이고 호스트는 해석하지 않는다(보낼 바이트로만 쓴다). 받는 사람이 payload에 있으므로 주입된 받는 사람이 화면에 드러난다. 화면은 "외부 입력 영향 하에 작성됨 — 내용·받는 사람을 특히 확인" 배지를 단다. 도구 실행기(Capability)는 초안을 만들기 전에 받는 사람이 명세 대상 범위 안인지 검사한다(전화 번호 범위와 같은 방식, 메시지 도구 설계 때) |
| 초안이 낡음 | `expires_at`(기본 72시간, 데몬 설정 `draft_ttl`) 뒤에는 승인·해제·전송이 모두 거부된다. 정책 변경은 해시 불일치로 재승인(같은 초안). 받는 사람 목록이 바깥에서 바뀐 경우: 승인한 목록 그대로 보낸다(조용히 빼거나 더하지 않는다). 수신 거부 같은 호스트 차단 목록에 걸리면 그 초안 전체를 거부하고 `needs_review`(일부만 보내면 승인한 것과 달라진다) |
| 위험 변경 TOTP | 그대로. cooldown·`release` TOTP·`min_approvers`가 초안 해시에 묶인다 |
| 비밀값 | 저장 payload는 정확한 그대로다. 가리기는 표시(CLI `show`, 화면)에서만 한다. 검증기 `no_secret_in_outputs`가 초안을 훑어 비밀처럼 보이면 안전성 실패 → 사람에게는 승인 불가로 보인다 |
| 개인정보(받는 사람 주소) | 화면 카드에는 인원수만, 상세에는 가린 목록(`k***@example.com`)과 도메인별 수. 정확한 주소는 승인 CLI `show`에서만. `policy_decision.reason`·이벤트 payload·run_log에 받는 사람·본문을 넣지 않는다 |
| 에이전트가 초안을 고침 | 초안 행은 호스트만 쓴다(lease 펜싱 트랜잭션). 에이전트는 DB·소켓에 닿지 않는다(Q26). 같은 run에서 다시 부르면 새 초안(다른 `effect_key`)이 늘 뿐 기존 행은 바뀌지 않는다 |
| 위조된 전송 단계 | `dispatch`는 `beforeRun`만 정한다(사람 승인 해시 필요). `host:dispatch` adapter 이름은 권한이 아니다: 전송기는 `proposed` 초안만 보내고 `beforeEffect`가 다시 막는다 |

## 6. 하위 호환

- **전화**: (도구, action) 선언에 `approval: 'scope'`를 적는다. 동작·해시·시험(`phone-lifecycle`, `agent-runtime-gateway-effect-gate`)은 그대로다.
- **범위 승인 업무 전체**: 초안이 없으면 승인 대상 해시는 지금과 같다(키를 더하지 않는다). 기존 `policy-approval`·`policy-gate`·`task-spec`(해시) 시험은 그대로 통과해야 한다.
- **부작용 시험 도구**(`test/unit/task-effects*.test.ts`, `task-submit-unknown-gate`, `idempotency`, `policy-approval`)는 선언에 `approval: 'scope'`를 더한다(기계적 변경, 동작 불변).
- **기존 DB 행**: 배포된 DB가 없다. 데모 DB(`scripts/review-web-demo.ts`)는 새로 만든다.
- **혼합 업무**(초안 가능 도구 + `scope` 도구, 또는 승인이 필요한 읽기 + 메일): 지금과 같은 범위 승인으로 간다. 알려진 한계(§9 Q2).

## 7. 시험 계획

### 단위 (`test/unit/`)

| 파일(새/기존) | 고정할 것 |
|---|---|
| `domain-effect-drafts.test.ts`(새) | 초안 상태표(허용·금지 전이, 에이전트 불가), `proposedDraftsOf` 정렬·필터, `draftSubjectEntries` 형식 |
| `state-machines.test.ts`(기존) | 새 기계가 문서 표와 같다 |
| `schema-drift.test.ts`, `entity-rows.test.ts`(기존) | `effect_draft` 컬럼 |
| `idempotency.test.ts`(기존) | `approval` 누락·잘못된 값 거부(새 오류 코드), `draft`/`scope` 통과 |
| `task-spec.test.ts`, `policy-approval.test.ts`(기존+) | 초안 없으면 해시 불변(기존 기대값 그대로), 초안 하나의 `payload_hash`만 바뀌어도 해시가 바뀜, `approved_snapshot`에 초안 목록 |
| `task-drafts.test.ts`(새) | `draft` run: `tool.send` 0회, 초안 행·`payload_hash`·`effect_key`, 같은 `effect_key` 중복 없음, 20건·256 KiB 상한, lease 잃으면 행 없음, `scope` action이면 던짐, 새 초안 run이 이전 초안을 `superseded`로 |
| `task-drafts-validation.test.ts`(새) | 평가 pass + 초안 → `needs_review` + `proposed`; fail → `retry_wait` + `superseded`; inconclusive/안전성 실패 → `needs_review` + `superseded`; 초안 없는 run은 지금처럼 |
| `task-drafts-dispatch.test.ts`(새) | 전송 run에서 에이전트 실행기 호출 0회, `send`가 받은 `request`가 초안과 깊은 같음, `external_effect.effect_key/request_hash` = 초안 값; payload 변조(UPDATE) → 전송 0회·run 오류; `unknown`에서 멈추고 뒤 초안 미전송; 재전송 run이 `confirmed` 재사용(전송 0회); `failed` 재전송은 allow일 때만 |
| `policy-gate.test.ts`(기존+) | `beforeRun` 단계 표(§2.2 1~5 각각), 승인 필요한 읽기가 섞이면 `draft` 아님; `beforeEffect`: `draft` 단계 거부, 해시 불일치·만료 거부, 정책 변경 → 거부 → 같은 초안 재승인 → 통과 |
| `policy-approval.test.ts`/`approval-engine` 계열(기존+) | `show`에 초안·해시; 초안 다시 쓴 뒤 옛 해시 승인 거부; 만료 초안 승인·해제 거부; 재인증 목적 해시가 초안 포함; `reject` → 초안 `rejected`·업무 `failed`; `request-changes` → `changes_requested` 행·초안 `superseded`·승인 컬럼 NULL·`queued`; 에이전트 actor 거부; 메모 필수 |
| `agent-runtime-gateway-effect-gate.test.ts`(기존+) | draft 모드: 외부 입력 영향 run에서도 원장 실행기 도달(초안), allow 판정도 실행기로(전송 없음), 원장에 묶이지 않은 부작용 도구는 거부, deny는 그대로; send 모드는 기존 시험 그대로 |
| `evaluation-*.test.ts`(기존+) | 전송 프로필(초안 run 평가 pass 필요, 초안마다 `confirmed`+해시 일치, 빠지면 fail), `no_secret_in_outputs`가 초안 payload를 훑음 |
| `review-web-*.test.ts`(기존+) | 메시지 초안 카드「무엇」= `받는 사람 N명 · 제목 '…' · 본문 첫 줄 …`, 외부 입력 배지, 만료 초안은 승인 대신 이유 + 변경 요청 명령, 주소 가리기, 비밀 가리기 뒤 자르기, `<script>` 이스케이프 |

### 통합 (`test/integration/`)

- `daemon-draft-approval.test.ts`(새): 가짜 메시지 `EffectTool`(`approval:'draft'`) + 가짜 어댑터로 생성 → 초안 run(전송 0) → 검증 pass → `needs_review` → `show` → `approve` → cooldown(시계 전진) → `release`(TOTP) → 전송 run(`host:dispatch`, 어댑터 호출 0) → 전송 1회(정확한 payload) → 전송 프로필 검증 → `completed`.
- 같은 흐름에서 전송 중 lease 상실 → 인수 → 멱등 미지원 도구면 `unknown` → `needs_review` → `resolve-effect` → 재큐 → 중복 전송 없음.
- 선행 결과(외부 입력) 입력이 있는 업무 → 초안 `influenced_by_external_input=1`, 여전히 승인 필요.
- `phone-lifecycle`(기존) 변경 없이 통과.

## 8. 오너가 바꿀 수 있는 결정 (기본값으로 정함)

| # | 결정 | 다른 선택 |
|---|---|---|
| D1 | **초안 run은 사람 승인 없이 시작한다**(승인이 필요한 읽기가 없을 때만). LLM 비용은 사람이 보기 전에 쓴다 | 업무 시작도 승인받고(지금처럼) 초안도 승인 — 사람 단계 2번 |
| D2 | **외부 입력 영향 run도 초안을 만들 수 있다**(지금 하한은 막는다). 화면 배지로 알린다 | 영향 run은 초안도 금지(조사 결과로 쓰는 메일 불가) |
| D3 | 한 업무의 초안은 **전부 아니면 전무**로 함께 승인 | 초안별 승인·부분 전송(상태·해시 설계가 커진다) |
| D4 | 초안 run에서는 정책이 allow인 부작용도 **초안으로 만든다**(초안 run은 아무것도 안 보낸다) | allow 부작용은 바로 보냄 |
| D5 | 사람은 **독립 검증을 통과한 초안만** 본다(검증 → 승인 → 전송 → 전송 검증) | 승인 먼저, 검증은 전송 뒤(보낸 뒤라 쓸모가 적다) |
| D6 | 본문을 근거 저장소 파일이 아니라 **DB 컬럼**(`effect_draft.payload`)에 둔다 | `blob:sha256:` 파일 + 해시 (트랜잭션 밖) |
| D7 | (도구, action) 선언의 `approval`을 **필수**로 한다(빠뜨리면 데몬이 안 뜬다) | 선택 + 기본 `scope`(새 도구가 조용히 범위 승인이 된다) |
| D8 | 초안 기한 기본 **72시간**(데몬 설정) | 정책 파라미터로(정책 변경 절차를 탄다) |
| D9 | 전송 중 `unknown`/`failed`가 나면 **뒤 초안은 보내지 않고 멈춘다** | 독립 초안은 계속 보냄 |
| D10 | ~~화면은 받는 사람을 수 + 가린 목록만~~ → 2026-11-05 변경: 상세 화면(로컬·쿠키 보호)은 정확한 주소와 payload 전 필드를 보인다. 홈 카드에는 수만 | 가린 목록 |
| D11 | 전송 run의 `task_run.actor_id`는 워커의 행위자(지금 에이전트 행위자)를 쓰고 `adapter='host:dispatch'`로 구분한다 | 시스템 행위자 행을 새로 만든다 |
| D12 | 수신 거부 등에 걸린 받는 사람이 있으면 **초안 전체를 거부**(일부만 보내지 않는다) | 걸린 사람만 빼고 보냄 |

## 9. 열린 질문

- **Q1 메시지 도구가 없다.** 지금 원장에 묶인 부작용 도구는 전화뿐이다. 엔진 변경은 가짜 도구로 시험할 수 있지만 오너의 실제 용도(고객 메일)에는 메시지 도구 설계가 따로 필요하다: provider, 멱등 키 지원(스파이크 Q14), 받는 사람 범위 규칙(명세 `target`과의 관계), 고객끼리 주소가 보이지 않게 하는 규칙(한 메일 한 고객 또는 숨은 참조), 수신 거부 목록.
- **Q2 혼합 업무.** 승인이 필요한 읽기 + 메일인 업무는 지금처럼 범위 승인이다(내용을 못 보고 승인). 2단계(명세 승인 → 초안 승인)로 할지, 이런 업무를 나누게 할지.
- **Q3 정책이 초안 승인을 강제할지.** 지금은 도구 선언이 정한다. 정책(ADR-0013)에 "`customer` 범위 외부 부작용은 `draft`만" 같은 규칙을 둘지(그러면 `scope` 도구는 예외 목록).
- **Q4 첨부.** 근거 저장소 참조로 넣는 형식은 정했지만 v1에서 받을지.
- **Q5 받는 사람 수 같은 내용 제약.** 7요소의 "제약(대상 수)"을 전송 시점에 payload에서 계산해 정책에 넘길지(지금 정책은 `target` 문자열만 본다).
- **Q6 변경 요청 피드백.** 사람의 사유를 다음 초안 run 입력으로 넘기는 어댑터 계약 변경(ADR-0005) — W13.
- **Q7 `failed`로 확정한 초안의 재전송(오너 결정).** 사람이 `resolve-effect`로 `failed` 확정한 초안은, 다시 승인해도 `failed` 재전송이 `allow` 판정을 요구하는 규칙 때문에 보내지지 않는다(기본 정책은 외부 부작용이 `require_approval`). 같은 내용을 다시 보내려면 변경 요청으로 새 초안을 만든다. 승인이 *한 번의 재전송*을 덮게 할지는 정책 절충이라 구현 기록에 두고 동작은 바꾸지 않았다.

## 10. 구현 작업 순서

각 단계는 따로 커밋·시험할 수 있다. 앞 단계가 뒤 단계의 전제다. 모든 단계에서 지킬 공통 불변식:
- **I1** 초안 단계 run은 외부 부작용을 하나도 보내지 않는다(`tool.send` 0회).
- **I2** 전송 단계 run은 LLM·에이전트 실행기를 부르지 않고, `proposed` 초안의 payload만 바이트 그대로 보낸다.
- **I3** 초안이 없는 업무의 승인 대상 해시와 동작은 지금과 같다.
- **I4** 원장 규칙(펜싱, 상태표, 재전송 창, 업무 범위 관문)은 바뀌지 않는다.
- **I5** 에이전트 actor는 초안·승인 상태를 바꾸지 못한다. 모든 판정은 `policy_decision`에 남는다.
- **I6** `npm run check`가 단계마다 통과한다(무거운 부분 시험은 맥북 원격 시험 스크립트 사용 가능).

**W1 스키마·domain 기반**
- `docs/schema/schema.sql`, `migrations/0001_init.sql`: §3.1 테이블·인덱스 그대로.
- `packages/domain/src/entities/enums.ts`: `EFFECT_DRAFT_STATES = ['pending','proposed','superseded','rejected']`, `RUN_PHASES = ['execute','draft','dispatch']`, `EFFECT_APPROVAL_MODES = ['draft','scope']`.
- `packages/domain/src/entities/rows.ts`: `EffectDraftRow`.
- `packages/domain/src/state/machines.ts`: `EFFECT_DRAFT_MACHINE`(§3.2 표). `docs/schema/state-machines.md`에 같은 표.
- 새 `packages/domain/src/drafts.ts`: `HOST_DISPATCH_ADAPTER = 'host:dispatch'`, `DRAFT_LIMITS = {perRun: 20, payloadBytes: 256*1024}`, `proposedDraftsOf(db, taskId): EffectDraftRow[]`(state `proposed`, `seq` 순 — 한 업무에 `proposed`는 한 run의 것만 있다), `draftSubjectEntries(rows)`(§2.6 형식), `transitionDrafts(tx, {taskId, from: readonly state[], to, by, now, runId?})`(상태표 검사 후 UPDATE, 바뀐 행 수 반환). 메시지 모양 도우미 `messagePreviewOf(payload: unknown): {recipients: string[]; subject: string | null; firstLine: string | null} | null` — payload가 `{to: string[], cc?, bcc?, subject: string, text: string}` 모양일 때만, 아니면 null. `index.ts`에서 내보낸다.
- 시험: `domain-effect-drafts`, `state-machines`, `schema-drift`, `entity-rows`.

**W2 부작용 선언 `approval`**
- `packages/task-engine/src/idempotency.ts`: `EffectActionDeclaration.approval: 'draft' | 'scope'`(필수), `validateAction`이 누락·잘못된 값을 거부(새 코드 `approval_missing`, `approval_invalid`, `DECLARATION_ERROR_CODES`에 추가). 알 수 없는 필드 검사 목록에 `approval` 추가. `resolveActionDeclaration`이 돌려주는 선언에 포함.
- `packages/agent-runtime/src/phone/effect-tools.ts:18,62,112,145`: 타입에 필드 추가, 세 action 모두 `approval: 'scope'`.
- 시험 고정물: `grep -rn "idempotency: {" test` 의 모든 선언에 `approval: 'scope'`.
- 불변식: 동작 변화 없음(I3).

**W3 승인 대상 해시와 승인 확인**
- `packages/policy/src/approval.ts:114` `taskSubject(task, spec, policyVersionId, drafts?: readonly EffectDraftRow[])`: `drafts`가 있고 비어 있지 않을 때만 `drafts: draftSubjectEntries(drafts)` 키를 더한다.
- `packages/policy/src/gate.ts:144` `verifyTaskApproval(tx, task, spec, policy, now, drafts?)`: 해시 계산에 `drafts`를 넘기고, 초안 중 `now >= expires_at`이 있으면 `{ok:false, state:'hash_mismatch', reason:'draft expired …'}`(새 상태를 만들지 않는다).
- 시험: 초안 없을 때 기존 해시 기대값 그대로(I3), 초안 해시 민감도.

**W4 정책 게이트 포트와 판정**
- `packages/domain/src/ports/task-policy-gate.ts`: `TaskRunGateRequest.effectApproval?: 'draft' | 'scope'`(없으면 `scope`), `TaskRunVerdict`의 allow에 `phase: RunPhase`(필수로 바꾸고 기존 구현은 `'execute'`). `TaskEffectGateRequest`에 `phase: RunPhase`, `requestHash: string`. `DENY_ALL_TASK_POLICY_GATE`는 그대로 거부.
- `packages/policy/src/gate.ts:60` `beforeRun`: §2.2 판정 순서. 초안 단계 판정도 `recordDecision`으로 남기되 사유 끝에 `(draft run: nothing is sent; drafts await approval)`.
- `gate.ts:87` `beforeEffect`: §2.7의 `phase`·`requestHash` 확인을 맨 앞에. 기존 검사는 그 뒤 그대로, `require_approval`의 `verifyTaskApproval`에 `phase==='dispatch' ? proposedDraftsOf(tx, task.id) : undefined`.
- task-engine 호출자 컴파일 맞추기: `lease.ts:166`(아직 `effectApproval` 안 넘김), `effects.ts:158`(`phase: 'execute'`, `requestHash: row.request_hash` — W5에서 실제 값).
- 시험: `policy-gate` 확장(§7). 불변식 I3·I5.

**W5 task-engine: 단계와 초안 기록**
- `lease.ts:20` `Lease.phase?: RunPhase`(없으면 `execute`). `ClaimOptions.effectApprovalOf?: (spec) => 'draft' | 'scope'`. `claimNextTask`(`lease.ts:117-197`): `beforeRun`에 `effectApproval` 전달, allow의 `phase`를 `ClaimedTask.phase`와 `lease.phase`에 넣는다. `phase==='draft'`면 같은 트랜잭션에서 `transitionDrafts(tx, {taskId, from:['pending','proposed'], to:'superseded', by:'scheduler'})`. `phase==='dispatch'`면 `task_run.adapter = HOST_DISPATCH_ADAPTER`.
- 새 `packages/task-engine/src/drafts.ts`:
  - `effectApprovalOf(spec, tools)`(§2.3).
  - `recordDraft(db, clock, lease, tool, step, {ttlMs, influenced}): EffectOutcome` — 한 쓰기 트랜잭션: `assertLeaseHeld`, `lease.phase==='draft'` 확인, (도구, action) 선언이 `approval:'draft'`인지(아니면 던짐), payload = `canonicalJson(step.request)`, 바이트 상한, 같은 run·같은 `effect_key` 행이 있으면 그 행, 아니면 run 내 개수 상한 확인 뒤 INSERT(`seq` = run 내 최대+1, state `pending`). 반환 `{state:'drafted', draftId}`.
- `effects.ts`: `EffectOutcome`에 `{ state: 'drafted'; draftId: string }`. `beginDispatch`: `lease.phase==='draft'`면 던진다(I1 방어). `gate.beforeEffect`에 `phase: lease.phase ?? 'execute'`, `requestHash: row.request_hash`.
- `worker.ts`: `RunContext.phase: RunPhase`; `performEffect`(288-298)는 `phase==='draft'`면 `recordDraft`(influenced 값은 실행기가 넘김 — `performEffect(toolName, step, meta?: {influenced: boolean})` 선택 인자), 아니면 지금 그대로. `WorkerOptions.draftTtlMs`(기본 72h). 생성자에서 `effectApprovalOf`를 `tools`로 만들어 claim에 넘긴다.
- 시험: `task-drafts`(§7). 불변식 I1·I4.

**W6 검증 경로**
- `validation.ts:68` `validateTask`: 전이 트랜잭션 안에서 그 run의 `pending` 초안 수를 센다. `route.to==='completed'` 또는 (`pass`이고 `humanRequired`)인데 초안이 있으면 `to='needs_review'`, 사유 `drafts_awaiting_approval: N drafts; a person approves the exact content`, 초안 `pending → proposed`(by `validator`). 그 밖의 경로면 초안 `pending → superseded`. `routeVerdict`(순수)는 바꾸지 않는다.
- 시험: `task-drafts-validation`.

**W7 호스트 전송기**
- `drafts.ts` `dispatchApprovedDrafts(db, clock, lease, tools, gate): Promise<{dispatched: {draft_id, effect_id, state}[]}>` — §2.7의 1~3. 해시·키 불일치는 `Error`(run 오류, 전송 0).
- `worker.ts` `#execute`(235): `claimed.phase==='dispatch'`면 `options.executor` 대신 전송기를 부르고 결과로 `submitRun`. 하트비트·lease 상실 처리는 같은 틀을 쓴다.
- 시험: `task-drafts-dispatch`. 불변식 I2·I4.

**W8 평가**
- `packages/evaluation/src/validator.ts` `createTaskValidator`: run의 `adapter === HOST_DISPATCH_ADAPTER`면 새 `evaluateDispatchRun`(새 파일 `packages/evaluation/src/dispatch-checks.ts`): §2.7 전송 프로필 세 검사, `humanRequired:false`. 결과 `evaluation` 행은 기존 형식(`UNIQUE(task_id, task_run_id, evaluator)`).
- `checks.ts` `no_secret_in_outputs`: 그 run의 `effect_draft.payload`도 훑는다.
- 시험: `evaluation-*` 확장.

**W9 게이트웨이·에이전트 실행기**
- `packages/agent-runtime/src/gateway.ts`: `ToolGatewayOptions.effectMode?: 'send' | 'draft'`(기본 `send`). `draft`면 ① `require_approval`·`allow` 모두 원장 실행기는 실행(외부 입력 영향이어도) ② 원장에 묶이지 않은 `sideEffect` 도구는 `approval_required`로 거부 ③ deny는 그대로. 호출 기록 사유에 `draft mode: recorded as a draft, nothing is sent`. 머리 주석(1-17행) 갱신.
- `apps/daemon/src/agent-executor.ts:125`: `effectMode: ctx.phase === 'draft' ? 'draft' : 'send'`. `ctx.phase==='dispatch'`면 이 실행기가 불리면 안 된다(던짐).
- 원장 실행기의 영향 표시 전달: `bindToEffectLedger`의 `perform`이 게이트웨이의 `influenced`를 알 방법이 없으므로 `ToolExecutionRequest.influencedByExternalInput: boolean`(게이트웨이가 채움)을 더하고, 실행기가 `perform(tool, step)` 대신 원장 러너에 넘긴다(`RunContext.performEffect`의 W5 선택 인자).
- 시험: `agent-runtime-gateway-effect-gate` 확장. 기존 send 모드 시험 불변.

**W10 승인 엔진·CLI**
- `packages/policy/src/engine.ts`:
  - `#taskContext`(198): `drafts = proposedDraftsOf(tx, id)`, `taskSubject(…, drafts)`.
  - `#approveTask`(208): 만료 초안 거부. 그 밖은 그대로.
  - `#releaseTask`(251): 만료 초안 거부.
  - `#reject`(499): 업무면 같은 트랜잭션에서 `proposed → rejected`(by `human`).
  - 새 `#requestChanges(actor, id, comment)`: §2.6. `ApprovalCommand`에 `{cmd:'request_changes', actor, kind:'task', id, comment}`, `CMDS`에 추가, `parseCommand`(613)에서 `comment` 필수(앞뒤 공백 자른 뒤 1~500자).
  - `#show`(516): `drafts: [{id, seq, tool, action, target, payload_hash, expires_at, expired, influenced_by_external_input, payload}]`. `payload`는 JSON 파싱한 원문(가리기는 CLI가 한다 — 화면도 `show`를 쓰므로 둘 다 표시 쪽에서 가린다).
  - `#list`(563): 업무 행에 `drafts: N`.
- `packages/domain/src/state/machines.ts` 업무 `needs_review → queued` 규칙의 `requires: ['approval']`이 `changes_requested` 승인 행 id로 충족되는지 확인(`assertAllowed`).
- `apps/daemon/src/approve.ts`: 사용법 머리말, `request-changes task <id> --comment <사유>`, `show` 출력에서 초안 payload에 `maskSecrets` 적용.
- 시험: §7 승인 엔진 행, `approval-channel`(통합) 명령 추가.

**W11 검토 화면**
- `apps/daemon/src/review-web/decisions.ts`:
  - `TaskInfo`에 `drafts: {id, tool, target, preview: ReturnType<typeof messagePreviewOf>, influenced, expired, payload}[]`. `taskInfo`(152)가 `proposedDraftsOf(ctx.db, id)`로 채운다.
  - `taskDecision`(197) 「무엇」: 초안이 메시지 모양이면 `받는 사람 ${n}명 · 제목 '${clip(subject, 30)}' · 본문 첫 줄 ${clip(firstLine, 40)}`(초안이 여럿이면 `초안 ${k}건 · 받는 사람 모두 ${n}명 · 첫 제목 '…'`), 메시지 모양이 아니면 `내용 미리보기 없음 — 자세히에서 원문 확인`. 「확인할 것」 `받는 사람과 문구가 이 초안 그대로 나가도 되는지`. 외부 입력 영향이면 배지 `외부 입력 영향 하에 작성됨`. 만료면 승인 대신 이유 `초안 기한이 지났습니다` + 변경 요청 명령.
  - 상세: 초안마다 받는 사람 가린 목록·도메인별 수, 제목, 본문 전문(`<pre>`, 가리기·자르기 규칙 그대로), `payload_hash` 앞 12자, 만료 시각. 명령 상자에 승인·거절·변경 요청.
  - 초안이 없는 고객 업무(혼합 업무 등) 카드 문구는 그대로.
  - `batchDecision`(227): 묶음 키에 초안 유무를 넣는다(초안 있는 것과 없는 것을 한 장으로 묶지 않는다).
- `review-web/format.ts`: `maskAddress('kim@example.com') → 'k***@example.com'`.
- `scripts/review-web-demo.ts`: 고객 메일 3건 업무에 `proposed` 초안(가상 주소·본문, 하나는 외부 입력 영향, 하나는 만료).
- `docs/operations/review-web.md`: 화면 표 갱신.
- 시험: §7 화면 행.

**W12 문서** (완료)
- §4 목록 전부(`docs/operations/review-web.md` 화면 표는 W11과 함께). ADR-0015 구현 기록 단락. `docs/adr/README.md` 상태 그대로(proposed).

**W13 (선택) 변경 요청 피드백**
- `packages/agent-runtime/src/contract.ts` `AdapterInput.review_feedback?: {comment: string; at: string}`(사람이 쓴 것이라 `internal`, 지시가 아니라 참고 의견으로 프롬프트에 넣는다). `agent-executor.ts`가 마지막 초안 run 이후 `changes_requested` 승인 행의 `comment`를 넣는다. ADR-0005 Amendment.

**W14 (별도 설계) 첫 메시지 도구** — §9 Q1. 이 계획의 범위 밖.
