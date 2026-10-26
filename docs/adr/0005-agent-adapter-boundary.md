# ADR-0005 에이전트는 어댑터 뒤에 둔다

상태: proposed

## Context
에이전트 제품(Claude Code, OpenHands, LangGraph 기반 에이전트 등)은 교체될 가능성이 크다. 업무 이력과 운영 규칙은 교체와 무관하게 남아야 한다.

## Decision
- `agent-runtime`은 단일 인터페이스를 정의한다: 입력 = `task_spec` + 허용 도구 + 근거 참조 + 예산, 출력 = `result`(구조화) + `evidence[]` + `run_log` + `cost`.
- 어댑터는 입력을 제품별 형식으로 변환할 뿐 정책을 판단하지 않는다. 정책 강제는 어댑터 바깥(도구 게이트웨이)에서 한다.
- 실행 환경은 격리한다: 파일시스템 범위, 네트워크 허용 목록, 도구 허용 목록, 시간·비용 한도. 무제한 셸/전체 네트워크 금지.
- 코드 에이전트가 대화 세션 외부(헤드리스)에서 작업하고 결과를 반환할 수 있는지는 어댑터 도입 전 스파이크로 검증한다.

## Consequences
- 어댑터마다 동일한 계약 테스트(contract test)를 둔다.
- 에이전트 제품 교체 시 업무·근거·비용 이력은 영향받지 않는다.

## Amendment (2026-10-19): 비용 진행 보고
예산 초과 중단은 실행 중에 비용을 알아야 가능하다. 어댑터 계약은 종료 시 `cost`뿐 아니라 실행 중 `cost_progress` 이벤트(누적 비용, 단위)를 주기적으로 보고해야 하며, 데몬은 이를 `cost_entry`에 기록하고 예산 초과 시 취소 신호를 보낸다. 보고하지 못하는 어댑터는 도구 게이트웨이가 호출별 비용을 계량한다.

## Amendment (2026-10-23): 근거의 신뢰 출처는 호스트가 정한다
어댑터 계약의 `EvidenceItem.trust_origin`은 필수이고 어휘만 검증하지만 *자기 신고*라서 저장 값으로 믿지 않는다. 호스트는 에이전트 출력을 `evidence` 행으로 저장할 때 어댑터가 밝힌 값과 무관하게 항상 `external_untrusted`로 쓴다(`AgentRunHost` 포트와 task-engine `recordRunOutput`이 신뢰 출처를 받지 않는다). 어댑터 출력은 신뢰 경계 밖이므로 자기 신고에 기대지 않는다: 거부 방식은 정상 어댑터의 작업을 잃게 하고, 강등은 판단 지점을 늘리며, 항상 덮어쓰기는 fail-closed이면서 가장 단순해서 택했다. 에이전트 출력이 아닌 경로가 쓰는 `internal` 근거는 영향이 없다. [trust-boundaries §2-3](../security/trust-boundaries.md), [memory-item](../schema/memory-item.md) 규칙 9.

## Amendment (2026-10-24): 선행 업무 결과 입력과 업무별 어댑터
어댑터 입력에 선택 필드 `upstream: [{name, task_ref, trust_origin, result}]`를 더했다. 호스트가 명세 `inputs[kind=task_result]`를 실행 직전에 읽어 *완료이고 통과 평가(pass, safety pass)가 있는 업무*의 결과만 넣는다. 항목은 항상 `trust_origin='external_untrusted'` 데이터이며(지시는 `task_spec`에만 있다) 계약 검증과 `start` 프레임 검증이 다른 값을 거부한다. 입력이 충족되지 않으면 어댑터를 시작하지 않고 업무를 `needs_review`로 보낸다. 컨테이너 안 에이전트는 `start` 프레임으로 같은 값을 받으며 모르는 필드는 무시한다(조사 에이전트는 읽지 않는다). 또 어댑터 선택은 워커의 포트(명세 → 어댑터 이름)가 하고 `task_run.adapter`에 실제 쓴 이름이 남는다. 어댑터 선택은 권한이 아니다: 도구는 어댑터와 무관하게 명세와 정책이 정한다. 상세는 [phase-a A6-U11 기록](../plans/phase-a.md).

## Amendment (2026-10-25): 부작용 도구의 `supports_idempotency` 선언
외부 부작용 도구를 쓰는 어댑터가 계약에 선언할 `supports_idempotency`([recovery §3](../operations/recovery.md))의 후보 도구별 초기 값은 [스파이크 Q14](../spikes/q14-idempotency-support.md)에 문서 근거와 함께 있다. 문서로 확인하지 못한 도구는 `false`다. 이 Amendment는 값의 출처를 가리킬 뿐 계약을 바꾸지 않는다. 키 보존 기간, 자연 멱등(upsert)의 취급, 선언 단위(도구/동작), 조회형 도구의 `effect_key` 전달 규칙은 계약에 닿으므로 사용자 결정 뒤에 이 ADR에 적는다.

## Amendment (2026-10-25): 승인을 부작용 원장에 넘기는 실행기 (`bindToEffectLedger`)
게이트웨이는 호출별 정책 판정이 `require_approval`이면 호출을 막는다(게이트웨이에는 승인 경로가 없다). 유일한 예외는 `bindToEffectLedger`(`packages/agent-runtime/src/effect-ledger.ts`)로 만든 실행기다: 부작용을 부작용 원장(`performEffect`)으로만 보내는 실행기는 원장이 전송 직전마다 정책과 *사람의 업무 승인*(`approved_hash`·cooldown·재인증)을 다시 확인하므로(`TaskPolicyGate.beforeEffect`), 게이트웨이가 승인 판정을 원장에 넘겨도 승인 없이 전송되지 않는다. 승인이 없으면 원장이 보내지 않고 run을 멈춘다(`needs_review`).

이 예외를 스펙의 불리언 선언으로 두었던 첫 구현은 **승인 우회 수단이 될 수 있어** 구조로 바꿨다(PR 리뷰 지적):
- **위조 불가:** 표시는 실행기 함수 자체에 붙고 모듈 비공개 `WeakSet`에만 등록된다. 스펙·설정·JSON 필드, 같은 모양의 속성을 가진 함수, 묶인 실행기를 감싼 래퍼는 인정되지 않는다.
- **원장을 거치지 않으면 오류:** 실행기 본문은 `perform`(원장 호출)을 인자로 받고, `perform`도 `perform.noEffect(이유)`(provider에 닿지 않은 통화의 로컬 취소처럼 외부 부작용이 없는 길을 명시)도 부르지 않고 끝나면 성공이 아니라 `tool_error`다.
- **적용 범위 제한:** 묶인 실행기는 `sideEffect=true`이고 영향이 `external_effect`인 도구에만 받는다(그 밖은 게이트웨이 시작 때 거부).
- **하한 유지:** `deny`와 외부 입력의 영향을 받은 run의 부작용 호출(승인 없이 불가)은 이 예외와 무관하게 막힌다. 호출 기록에는 정책의 `require_approval`과 "원장이 재확인한다"는 사유가 남는다.
- **한계:** 본문이 `perform` 없이 직접 외부에 접근하는 것까지 막지는 못한다. 실행기는 호스트가 조립하는 신뢰된 코드(에이전트는 닿지 못한다)이고, 이 구조는 설정 오류와 실수를 잡는다. 첫 사용처는 전화 도구([ADR-0014](0014-phone-capability.md) §8). 시험: `agent-runtime-gateway-effect-gate`, `phone-lifecycle`(승인 뒤 정책이 바뀌면 원장이 거부).

외부 부작용 도구를 쓰는 어댑터가 계약에 선언할 `supports_idempotency`([recovery §3](../operations/recovery.md))의 후보 도구별 초기 값은 [스파이크 Q14](../spikes/q14-idempotency-support.md)에 문서 근거와 함께 있다. 문서로 확인하지 못한 도구는 `false`다. 사용자 승인(2026-10-25)으로 어댑터 계약에 다음을 더한다(구현은 첫 부작용 어댑터 전).
- **선언 단위와 보존 기간.** 멱등 선언은 (도구, `action`) 단위의 `{supported, retention_ms}`다. 재전송 규칙은 [ADR-0004 Amendment](0004-events-routines-idempotency.md)와 [recovery §3](../operations/recovery.md).
- **조회형 어댑터는 `effect_key`를 어디에 싣는지 선언한다**(`metadata` / `slug` / `property` / `none`). `none`의 `lookup`은 내용 대조이며 "찾음"만 `confirmed` 근거다. 공개 게시물 본문에는 `effect_key`를 싣지 않는다.
- 외부가 재시도를 안내하거나 일부 성공을 경고하는 응답은 `failed`가 아니라 `unknown`으로 매핑한다.
- 자연 멱등(upsert)은 인정하지 않는다(`supported=false`). 첫 CRM 쓰기 어댑터 때 재검토한다.
- 어댑터 계약 시험(위 Consequences)에 보존 기간 초과·내용 대조 조회의 한계를 넣는다.

(2026-10-25 구현) 선언 단위·보존 기간·`effect_key` 전달 선언의 검증은 엔진에 구현했다(커밋 7fc4b02, fc84679). 오류 매핑과 실제 어댑터에 대한 계약 시험은 어댑터를 쓸 때 적용한다. "구현은 첫 부작용 어댑터 전"은 당시 기록이다.

## Amendment (2026-10-25): 실행 에이전트는 Claude Code CLI(구독)로 한정
소규모 사무실에서 적은 비용으로 높은 효율을 얻기 위해, 업무를 실제로 수행하는 에이전트는 유료 구독으로 로그인한 Claude Code CLI로 한정한다(사용자 결정). 이미 갖춘 도구·스킬을 쓰므로 에이전트별 개발량이 줄어든다. 앱은 상태를 UI로 보여주고 업무를 할당·검증하며 실행은 `claude-code-cli` 어댑터가 `claude -p`로 한다. 기존 `research-agent` 컨테이너 어댑터는 이번에 바꾸지 않는다. 구현은 스파이크 Q4 통과 후다.
- **데스크톱 앱은 실행 경로가 아니다.** GUI라서 데몬이 할당·수거할 수 없다. 사람이 대화하는 보조 창구로만 쓴다.
- **개인 환경 권한을 물려받지 않는다.** 업무마다 전용 작업 디렉터리와 설정(허용·거부 도구, 엄격한 MCP 설정, 권한 모드)을 명세에서 생성해 주입한다. 사용자 전역 설정·스킬·MCP는 쓰지 않고 필요한 스킬은 읽기 전용으로 복사한다. 부작용 도구는 도구 게이트웨이를 MCP로 노출한 것만 열고 내장 Bash는 기본 거부한다. 정책 강제는 여전히 어댑터 바깥이다.
- **격리는 호스트 OS 수준이다.** 구독 로그인 정보를 컨테이너에 넣지 않기 위해 데몬 전용 OS 계정과 작업 디렉터리 격리를 쓴다. 컨테이너 방식보다 약하므로 한계 목록을 스파이크 산출물에 남긴다. 데몬은 로그인된 사무실 PC에서 돈다.
- **예산 모델이 바뀐다.** USD 예산 초과 중단(2026-10-19 Amendment)은 이 어댑터에 적용되지 않는다. 최대 턴 수, 시간 제한, 동시 실행 수로 제한하고 비용은 `subscription_estimate` 단위의 추정치로 `cost_entry`에 기록한다. 구독 사용량 한도 도달·로그인 만료는 실패가 아니라 `needs_review`(재시도 대상)다.
- **인증 토큰을 꺼내 쓰지 않는다.** 공식 CLI를 그대로 실행하는 방식만 쓴다. 자동 실행 허용 범위는 사람이 약관에서 확인한다(미확인).
- 신뢰 경계는 그대로다: 출력은 항상 `external_untrusted`로 저장한다(2026-10-23 Amendment).
