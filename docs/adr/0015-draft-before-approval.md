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
