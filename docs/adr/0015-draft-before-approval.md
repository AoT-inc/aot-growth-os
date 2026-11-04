# ADR-0015 외부 부작용은 정확한 초안을 승인하고 호스트가 그대로 보낸다

상태: proposed (2026-11-04, 구현 전. 설계와 작업 순서는 [plans/draft-before-approval](../plans/draft-before-approval.md))

## Context
고객에게 나가는 일(예: 고객 메일)의 사람 승인이 **에이전트가 내용을 쓰기 전**에 일어난다. 승인 대상 해시는 명세 + 역할 + 승인 시점 정책 버전이고([ADR-0006](0006-policy-separation.md) Amendment 2026-10-19 A3 구현), 부작용 직전 재확인(`beforeEffect`)도 같은 명세 해시를 본다. 그래서 사람은 업무 목표와 대상(`mailbox:example` 같은 범위)만 보고 승인하고, 본문·받는 사람은 승인 뒤 run에서 LLM이 처음 만든다. 오너 결정(2026-11-04): 에이전트가 정확한 내용을 먼저 초안으로 쓰고, 사람은 그 초안을 승인하며, **나가는 것은 승인한 것과 같아야 한다**.

이미 있는 것: 게시(`publication`)는 내용 참조를 해시에 넣는 초안 → 승인 구조다. 전화([ADR-0014](0014-phone-capability.md) §8)는 실시간 대화라 내용을 미리 확정할 수 없어 번호 범위를 승인한다. 부작용 원장(`external_effect`, `performEffect`)과 원장에 묶인 실행기(`bindToEffectLedger`, [ADR-0005](0005-agent-adapter-boundary.md) Amendment 2026-10-25)가 있다.

## Decision
1. **승인 방식은 (도구, `action`) 선언이 정한다.** 부작용 도구 선언에 필수 필드 `approval: 'draft' | 'scope'`를 둔다. `draft`는 보낼 내용 전체를 미리 확정할 수 있는 동작(메일·메시지·외부 API 쓰기), `scope`는 그럴 수 없는 동작(전화 통화·전환·끊기)이다. 명세의 모든 `external_effect` 요청이 `draft` 동작이면 그 업무는 초안 승인 업무다. 하나라도 `scope`이거나 승인이 필요한 다른 요청(예: `customer` 범위 읽기)이 섞이면 지금처럼 범위 승인이다.
2. **run 단계를 셋으로 나눈다** (`execute` / `draft` / `dispatch`, 실행 직전 `beforeRun`이 정한다).
   - `draft`: 초안 승인 업무에 제안된 초안이 없으면 **사람 승인 없이** 에이전트 run을 시작한다. 원장에 묶인 부작용 호출은 보내지 않고 원장 입구에서 `EffectStep`(도구·action·대상·`step_id`·요청)을 그대로 `effect_draft`에 남긴다(payload = 정규화 JSON, `payload_hash` = 전송 때의 `request_hash`). 에이전트는 `{status:'drafted'}`만 받는다. 이 run은 **아무것도 보내지 않는다**: 정책이 allow인 부작용도 초안이 되고, 원장에 묶이지 않은 부작용 도구는 거부된다.
   - `dispatch`: 제안된 초안과 그 해시에 대한 유효한 사람 승인이 있으면 **호스트가** run을 연다(`adapter='host:dispatch'`). 에이전트·LLM은 부르지 않고 저장된 payload를 해시·`effect_key`를 다시 확인한 뒤 기존 `performEffect`로 보낸다. 원장 규칙(펜싱, 상태표, 재전송 창, Q14, 사람 확정)은 바뀌지 않는다.
   - `execute`: 그 밖의 경우. 지금 동작 그대로.
3. **승인은 초안에 묶인다.** 업무 승인 대상 해시에 초안이 있을 때만 초안 목록(`payload_hash`·도구·action·대상·`step_id`·만료)을 더한다. 초안이 없으면 해시는 지금과 같다. `risky_change` 절차(승인자 수·cooldown·TOTP `release`)는 그대로이며 재인증 목적이 초안 해시를 포함한다. 한 업무의 초안은 전부 함께 승인한다(건별 승인 없음).
4. **전송 직전 재확인.** `beforeEffect`는 전송 단계에서 `request_hash`가 승인된 초안의 해시인지, 초안이 만료 전인지 확인한 뒤 지금처럼 현재 정책으로 다시 판정하고 초안 해시 승인을 확인한다. 정책이 바뀌면 같은 초안을 새 정책 해시로 다시 승인받는다(다시 쓰지 않는다). 초안 단계 run의 `beforeEffect`·`beginDispatch`는 무조건 거부한다.
5. **검증 → 승인 → 전송 → 전송 검증.** 초안 run은 지금처럼 독립 검증을 받고, 통과하면 초안이 `proposed`가 되어 업무가 `needs_review`로 간다. 사람은 검증을 통과한 초안만 승인할 수 있다. 전송 run은 전송 확인(초안마다 `confirmed` + 해시 일치)과 `policy_compliance`만 검증한다.
6. **사람 명령.** `approve`/`release`/`reject`/`cancel`은 그대로이고, 새 `request-changes task <id> --comment`가 `changes_requested` 승인 행을 남기고 초안을 버린 뒤 업무를 다시 초안 단계로 보낸다.
7. **신뢰 경계.** 초안은 에이전트 출력이라 항상 신뢰하지 않는 데이터다. 호스트는 해석하지 않고 바이트로만 보낸다. 외부 입력 영향 run도 초안은 만들 수 있으며(사람이 정확한 내용을 승인하므로 지금의 "영향 run은 승인 없이 부작용 불가" 하한과 충돌하지 않는다) 초안에 표시가 남고 화면이 알린다. 저장 payload는 정확한 값이고 비밀·주소 가리기는 표시에서만 한다.
8. 응답에 의존하는 일은 초안 승인 업무 안에서 하지 않는다. 업무는 전송 확인으로 끝나고, 응답이 필요한 다음 일은 선행 결과 입력을 쓰는 후속 업무다.

## Consequences
- 사람이 보내질 내용 그대로를 보고 승인한다. 승인 뒤 LLM이 내용을 다시 만드는 길이 없다.
- 초안 run의 LLM 비용은 사람이 보기 전에 쓴다. 거절하면 그 비용은 버려진다.
- 새 테이블 `effect_draft`와 상태 기계 하나가 생긴다. 업무 상태 전이는 새로 생기지 않고 조건 문구만 넓어진다. `approval.decision='changes_requested'`를 처음 쓴다.
- 전화와 기존 범위 승인 업무는 그대로다. 승인이 필요한 읽기와 메일이 섞인 업무는 여전히 범위 승인이다(알려진 한계).
- 첫 실제 사용에는 메시지 부작용 도구가 필요하다(provider, 멱등 키, 받는 사람 범위·사생활 규칙). 별도 설계다.
- 구현할 때 ADR-0003(승인 스냅샷), ADR-0005(원장 실행기의 외부 입력 하한), ADR-0006(업무 해시), ADR-0014 §8(전화는 `scope`)에 이 ADR을 가리키는 Amendment를 단다.

## 구현 기록 (2026-11-05)
작업 W1~W10·W12를 구현했다(커밋 `c36f585` W1 스키마·domain, `568ecad` W2 선언, `f668968` W3 해시, `a032b94` W4 정책 게이트, `7e972dc` W5 단계·초안 기록, `f5ade49` W6 검증, `7a63be4` W7 전송기, `46ad26f` W8 평가, `1421872` W9 게이트웨이, `fabbe62` W10 승인 엔진·CLI, `f4a471e` 통합 시험). 상태는 `proposed` 그대로다. 아직 하지 않은 것: **W11 검토 화면**(다른 작업자), **W13 변경 요청 피드백 어댑터 계약**(선택), **W14 첫 메시지 도구**(별도 설계). 설계 문서의 불변식 I1~I6은 단계마다 시험으로 고정했다(`test/integration/daemon-draft-approval.test.ts`가 전체 경로를 본다).

설계 문서와 달라진 곳(불변식을 지키는 방향으로 정리):
- **전송 단계는 예산 정지를 하지 않는다.** 초안 run이 쓴 비용이 예산에 닿았다고 `beforeRun`의 `budgetSpent`로 막으면 사람이 승인한 초안이 영영 나가지 못한다. 전송 run은 LLM 비용이 없으므로 제안된 초안이 있으면 정책 상한(`budgetCap`)만 본다.
- **전송 단계의 `beforeEffect`는 정책 판정이 `allow`여도 초안 해시에 대한 사람 승인을 다시 확인한다.** 설계는 `require_approval`일 때만 확인한다고 했으나, `beforeRun` 규칙 2("초안이 있으면 사람 승인 없이 dispatch로 가지 않는다")와 같은 기준을 효과 직전에도 적용했다.
- **초안 기록 시점에 명세 범위를 확인한다.** `recordDraft`가 (도구, action, 대상)이 명세 `allowed_tools`의 `external_effect` 항목과 맞지 않으면 `out_of_scope`로 거부한다. 설계는 이 확인을 전송 때(`beforeEffect`)에만 두어, 범위 밖 초안이 사람 승인을 받은 뒤에야 막힐 수 있었다.
- **제출하지 못하고 끝난 run의 초안 정리**를 `closeRun`에 두었다(오류·시간 초과·킬·lease 만료 인수·효과 미확정·정책 정지 모두 그 run의 `pending` 초안을 `superseded`로). 설계의 "run이 submit 못 하고 끝남" 전이를 한 곳에서 처리한다.
- **원장 실행기의 영향 표시는 `bindToEffectLedger`가 요청에서 읽어 원장 입구에 `meta.influenced`로 넘긴다.** 설계는 실행기 본문이 `perform`에 넘기는 것으로 적었으나, 본문이 빠뜨려도 초안에 표시가 남게 했다. `ToolExecutionRequest.influencedByExternalInput`은 필수 필드다.
- **전송기 무결성 확인에 정규 JSON 확인을 더했다**(`canonicalJson(JSON.parse(payload)) === payload`). `failed`가 나오면 전송기가 뒤 초안을 보내지 않고 던진다(run 오류 → `retry_wait`).
- **`no_secret_in_outputs`는 근거 저장소 리더가 없어도 DB의 초안 payload를 먼저 훑는다**(비밀 모양이면 안전성 실패). 깨끗하면 리더가 없을 때 기존처럼 `unknown`(→ inconclusive)이므로, 이 검사를 쓰는 초안 업무는 데몬에 근거 저장소 리더가 연결돼 있어야 통과한다.
- **데몬 설정 이름은 `draft_ttl_ms`**(ms, 기본 72시간)다. 다른 기간 설정(`retry_delay_ms` 등)과 단위를 맞췄다. `assembleDaemon`은 `draftTtlMs`.
- **`show`는 초안이 없어도 `drafts: []`를 돌려주고 `list`의 업무 행에 `drafts`(제안된 초안 수)가 붙는다.** 초안이 없는 업무의 승인 대상 해시·`subject`는 그대로다(`drafts` 키 없음).
- **`request_changes`는 `needs_review`인 업무면 초안이 없어도 받는다**(승인 컬럼을 비우고 다시 큐에 넣는다). 응답에 `drafts_superseded`가 있다.

알려진 한계·남은 일: 승인 방식이 `draft`인 업무가 초안 없이 `needs_review`가 되면(예: 평가 inconclusive) `approve`는 명세 해시 승인이 되어 다시 초안 run을 시작할 뿐이다(해가 없지만 승인이 헛되다 — 사람은 `request-changes`를 쓴다). 설계 §7의 통합 시험 중 "전송 중 lease 상실 → 인수 → `unknown` → `resolve-effect` → 중복 전송 없음"은 통합이 아니라 단위 시험(`task-drafts-dispatch`: `unknown`에서 멈춤, 재전송 run의 `confirmed` 재사용)으로 고정했다. 메시지 도구 자체(W14), 검토 화면(W11), 변경 요청 사유의 다음 초안 run 전달(W13)이 남았다.

### 검토 화면(W11)이 읽는 것
`ApprovalEngine`의 `show` 응답(`kind: 'task'`): `hash`(승인에 보내는 해시), `subject.drafts`(해시에 묶인 항목: `draft_id`·`seq`·`tool`·`action`·`target`·`step_id`·`payload_hash`·`expires_at`), 그리고 `drafts[]`: `{id, seq, tool, action, target, payload_hash, expires_at, expired, influenced_by_external_input, payload}`(`payload`는 JSON으로 파싱한 원문이며 비밀·주소 가리기는 표시하는 쪽이 한다). 읽기 전용 경로는 `@aot/domain`의 `proposedDraftsOf(db, taskId)`(행: `EffectDraftRow`)와 `messagePreviewOf(payload)`(`{recipients, subject, firstLine} | null`)를 쓴다. `list`의 `tasks[].drafts`는 제안된 초안 수다. 사람 명령: `approve`(show의 해시), `reject`, `request_changes`(CLI `request-changes task <id> --comment`).

### 독립 검토 반영 (2026-11-05)
- **초안 비밀 검사는 항상 돈다.** 초안이 있는 run은 명세의 `validation.deterministic`에 `no_secret_in_outputs`가 없어도 평가기가 초안 payload를 안전성 검사(`draft_secret_scan`)로 훑는다: 값 모양(Bearer·키 접두 등)과 비밀 이름 키(`authorization`·`*token`·`cookie`·`signature` …, `isSecretKeyName`)가 걸리면 `safety='fail'`이라 업무는 `needs_review`로 가고 초안은 `proposed`가 아니라 `superseded`다(승인할 수 없다). 키 규칙은 호출 기록 가리기(`isSecretKey`)와 같은 표본으로 대조한다.
- **사람이 모든 바이트를 본다.** `show`의 초안마다 `masked_paths`(표시용 가리기가 바꾸는 값의 경로, 예 `headers.authorization`)를 낸다. 비어 있지 않은 초안이 하나라도 있으면 `approve`와 `release`를 거부한다(변경 요청으로 비밀 모양을 없애게 한다). 가리기는 데몬이 주입한 `maskSecrets`(CLI·화면과 같은 함수)이고, 주입이 없으면 키 이름만 가리는 기본값(`maskSecretKeys`)이다.
- **전송이 시작된 초안이 있으면 `request_changes`·`reject`를 거부한다.** `show`의 초안마다 `send_state`(같은 `effect_key`의 원장 상태: `none|planned|dispatched|confirmed|failed|unknown|compensated`)를 낸다. `planned` 너머(dispatched·confirmed·failed·unknown)인 초안이 있으면 두 명령은 `effects` / `resolve-effect`로 먼저 정리하라는 메시지로 거부된다. 다시 쓴 초안이 이미 나간 내용을 다른 문구로 또 보낼 수 있기 때문이다.
- **초안 단계 run이 초안을 하나도 남기지 못하면 완료하지 않는다.** `task_run.phase`(새 열, `execute|draft|dispatch`)를 기록하고, 검증기가 `draft` 단계 run이 `completed`로 가려 할 때 pending 초안이 0건이면 `needs_review`(사유 `no_drafts: …`)로 보낸다.
- **전송 run에 시간 제한이 있다.** 명세의 `constraints.time_limit`(없으면 30분, 워커 옵션 `dispatchTimeLimitMs`가 더 짧으면 그 값)을 넘기면 `RunKilledError('time_limit')`로 run을 죽인다. 전송 중이던 효과는 run이 닫힐 때 기존 규칙대로 `dispatched → unknown`이 되고(`failed`가 아니다) 뒤 초안은 보내지 않는다. 멱등이면 `retry_wait`로 같은 키 재전송, 아니면 `needs_review`다.
- **owner 결정 필요(정책 절충): 사람이 `resolve-effect`로 `failed`로 확정한 초안은 다시 승인해도 재전송되지 않는다.** `failed` 재전송은 정책 판정이 `allow`일 때만이고(승인은 한 번의 전송만 덮는다), 기본 정책은 외부 부작용을 `require_approval`로 둔다. 같은 내용을 다시 보내려면 변경 요청으로 새 초안(새 `effect_key`)을 만들어야 한다. 바꿀지는 오너가 정한다(설계 §9 Q7).
