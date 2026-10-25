# ADR-0014 외부 대화 계층과 첫 채널: 전화 (Phone Capability)

상태: proposed (2026-10-25, 구현은 같은 날 `phone-capability` 브랜치. 사람 확인이 필요한 항목은 §10)

## Context
영업·고객지원·채용 에이전트가 실제 전화를 걸고 받아야 한다. 전화는 (1) 외부 세계에 직접 영향을 주고(`external_effect`, `customer` 범위), (2) 몇 분씩 걸리며, (3) 결과(통화 내용)가 상대방이 한 말이라 신뢰할 수 없고, (4) provider(Vapi, Retell, Twilio)가 바뀔 수 있다. 이 저장소에는 이미 외부 부작용 원장(`external_effect`, `performEffect`), 도구 게이트웨이, 정책 판정, 독립 평가기, 측정 값 대기 조건이 있다. 새 workflow engine이나 독립 서비스는 필요 없다.

## Decision

### 0. 외부 대화(Conversation)가 상위 계층이고 전화는 첫 채널이다 (2026-10-25 사용자 제안 반영)
전화·이메일·채팅·SNS 답글은 모두 "에이전트가 외부 사람과 나누는 대화"다. 공통점: 업무(Task)와의 상관, 발화 기록(transcript), 구조화된 결과(outcome), 인바운드 라우팅, 채널별 정책, 신뢰할 수 없는 상대 입력, 증거 기반 평가. 이 계층을 **Conversation**이라 부르고 채널(phone, 후속: email·chat)이 그 아래에 있다. 에이전트 쪽 모습은 "채널별 Capability + 채널별 Port + provider 어댑터"이다.

- **지금 채널 중립으로 두는 것** (`@aot/domain` `src/conversation/`): `Transcript`/`TranscriptTurn`(speaker = agent|customer|system), `ConversationOutcome`(disposition·summary·structuredData·nextAction), 주소(E.164 같은 채널별 형식은 채널 쪽 검증), 신뢰 출처 규칙(상대의 말에서 나온 것은 `external_untrusted`).
- **채널 전용으로 두는 것** (`src/phone/`): 통화 생명주기(ringing·connected·transferred), `call` 테이블, 음성 provider 계약, 영업시간·통화량 같은 전화 정책.
- **일반화를 미루는 것:** 이벤트 이름(`phone.call.*`), 저장 테이블(`call`, `call_artifact`), 평가 검사 id(`call_*`)는 전화 이름 그대로 둔다. 전화 하나만 보고 `conversation` 테이블이나 `channel` 컬럼을 만들면 이메일(스레드·비동기·수신 확인)에서 틀릴 위험이 크다. **두 번째 채널을 구현할 때** 공통 부분을 `conversation`으로 승격하고(필요하면 패키지 분리, ADR-0001의 "필요가 생길 때 분리"), 그 전까지는 채널 중립 모듈 경계만 지킨다. 첫 릴리스 전이라 `0001_init.sql`을 직접 고칠 수 있어 승격 비용이 낮다.
- **SNS:** 공개 게시는 대화가 아니라 이미 있는 `publication`(승인 필요)이다. 답글·DM만 대화 채널이 된다.

### 1. Phone은 Capability이지 직원이 아니다
에이전트는 "전화를 걸어라"라는 **업무 의도**(`to`, `objective`, `context`, `constraints`)만 표현한다. provider 선택·인증·API 호출·webhook 해석·상태 변환은 capability/adapter 계층의 책임이다. 에이전트(컨테이너)는 provider SDK도 비밀값도 모른다. 호출 경로는 기존과 같다.

```
Task → 에이전트 어댑터 → 도구 게이트웨이(phone_call 등, 호출마다 정책 재판정)
     → PhoneCapability(입력 검증, PhoneCallPolicy, Call 기록)
     → 부작용 원장(performEffect: planned→dispatched→confirmed/unknown, lease 펜싱)
     → PhonePort(provider 계약) → 어댑터(Vapi | Fake | …) → PSTN
```

### 2. 위치: 새 패키지를 만들지 않는다 (ADR-0001)
MVP 패키지는 5개이고 `memory`/`publication` 같은 분리는 "실제 필요가 생길 때"로 정했다. 전화가 만드는 새 의존은 없다(기존 포트로 충분하다). 따라서:

| 조각 | 위치 | 이유 |
|---|---|---|
| Call·이벤트·Transcript·CallOutcome 모델, 상태 허용표, 입력 검증, `call` 저장 함수, 인바운드 라우팅 규칙 | `@aot/domain` (`src/phone/`) | `strategy.ts`·`memory.ts`처럼 Db를 쓰는 도메인 규칙. provider 타입은 없다 |
| `PhonePort`(provider 계약), `PhoneCallPolicy`(정책 포트) | `@aot/domain` (`src/ports/`) | 포트를 domain에 두는 기존 방식(TaskPolicyGate·ToolCallPolicy). policy·task-engine·agent-runtime이 서로 몰라도 만난다 |
| 전화 정책 구현(`phone:` 정책 섹션, 하루 통화량 집계) | `@aot/policy` | 정책은 에이전트 쓰기 경로 밖(ADR-0006). 정책 변경 등급 분류도 같은 패키지 |
| 통화 증거 검사(`call_completed` 등) | `@aot/evaluation` | 완료 판정은 평가기만 |
| 통화 중 검증 보류(열린 Call이 있으면 `validating` 업무를 집지 않음) | `@aot/task-engine` | 측정 값 대기(A6-U13)와 같은 방식. Call 테이블만 알고 provider는 모른다 |
| `PhoneCapability` 구현, 게이트웨이 도구, 부작용 도구, webhook 수신, 인바운드 처리, Fake provider | `@aot/agent-runtime` (`src/phone/`) | `fetch_url`처럼 호스트 쪽 도구. domain 포트만 쓴다 |
| Vapi 어댑터, 데몬 조립 | `apps/daemon` | 비밀값을 가진 인프라 코드는 조립 지점에 둔다. 코어 패키지는 provider 이름을 모른다 |

### 3. Call과 Task는 다르다
`Task`는 검증 가능한 업무이고 `Call`은 그 실행 중 일어난 **외부 상호작용 하나**다. 업무 1 : Call N(재시도, 재다이얼)이고, 인바운드 Call은 업무 없이 먼저 생기고 나중에 업무와 연결된다(`task_id` NULL 허용). Call 상태는 업무 상태를 바꾸지 않는다. 업무 전이는 이전처럼 task-engine 허용표와 검증기만 한다.

### 4. 저장: 테이블 2개, 이벤트·증거는 기존 모델을 재사용
- `call` (새): 현재 상태 + 상관 키(`task_id`, `provider_call_id`, `effect_key`). 상태 머신이 있고 `provider_call_id`·`task_id`로 조회해야 하므로 `event`의 JSON을 뒤지는 것으로는 부족하다.
- `call_artifact` (새): 통화 산출물의 본문(`transcript`, `outcome`) 하나씩. 본문은 `evidence`가 담지 못한다(`evidence`는 참조·해시만).
- canonical 이벤트: 기존 `event` 테이블(`source='phone'`, `type='phone.call.*'`, 멱등 키 `phone:<provider>:<eventId>`). 새 `call_events` 테이블은 만들지 않는다.
- 업무에 연결된 Call은 통화 기록과 산출물을 `evidence`(`trust_origin='external_untrusted'`)로도 남겨 평가기가 기존 방식으로 원본 증거를 센다.
- 비용: provider가 알려 준 통화 비용은 `cost_entry`(`external`)에 한 번만 남는다(이벤트 멱등성으로 보장).
- **저장하지 않는 것:** provider 원본 payload, 녹음 파일. 어댑터가 canonical로 바꾼 뒤 버린다(비밀·개인정보가 DB에 들어가는 것을 막는다). 필요해지면 `raw_ref`로 별도 저장소를 가리키는 방식을 정한다.
- 전화번호는 개인정보다. 코드·테스트·문서에는 예약 번호 대역(`+8210000xxxx`, `+1555…`)만 쓴다. 정책 판정 기록에는 마스킹한 번호만 남는다.

### 5. 상태와 이벤트 (provider 값은 밖으로 나오지 않는다)
Call 상태: `queued → initiated → ringing → connected → completed`, 종료 `failed`·`cancelled`, 상담 연결 `transferred`(이후 `completed`/`failed`). 인바운드는 `initiated`/`ringing`에서 시작한다. 허용표는 [state-machines](../schema/state-machines.md).
canonical 이벤트: `phone.call.requested|initiated|ringing|connected|transcript.updated|completed|failed|cancelled|transferred`. provider webhook은 어댑터가 `PhoneEvent`로 바꾸고(서명/비밀 검증 포함), 코어는 `PhoneEvent`만 본다. 이벤트는 중복·역순으로 온다: 같은 이벤트는 멱등 키로 흡수하고, 이미 지나간 상태로 되돌리는 이벤트는 기록만 하고 상태는 바꾸지 않는다(`stale`).

### 6. 전화가 에이전트 실행을 막지 않는다
`phone_call`은 `CallHandle{callId, status}`를 바로 돌려준다(통화가 끝나길 기다리지 않는다). 에이전트 run은 정상적으로 `submitted → validating`으로 간다. 열린 Call(종료 상태가 아닌 것)이 있는 `validating` 업무는 검증기가 **집지 않는다**(전이 없음, 시도 소모 없음 — 측정 값 대기와 같은 성격). webhook이 Call을 종료시키면 다음 tick에 검증된다. webhook이 영영 오지 않는 경우를 위해 마감(`max_duration + 유예`)을 넘긴 Call은 provider에 조회(`reconcile`)하고, 그래도 확인되지 않으면 `failed`(`deadline_exceeded`)로 닫는다 — 그러면 평가기가 증거 부족으로 `needs_review`를 낸다. 새 workflow engine은 만들지 않았다.

### 7. 완료는 시스템이 판정한다
평가기에 결정론적 검사 3개를 더한다(업무 명세 `validation.deterministic`에 적은 것만 실행).

| id | 확인 | 실패 시 |
|---|---|---|
| `call_completed` | 이 run이 만든 Call 중 `connected`를 거쳐 `completed`된 것이 있다 | 종료됐으나 연결 없음 → `fail`, 열린 Call/없음 → `unknown` |
| `call_transcript_present` | 그 Call의 transcript가 있고 비어 있지 않다 | `fail` |
| `call_outcome_recorded` | 구조화된 outcome이 있고, `disposition`이 명세가 허용한 값이며, 명세가 요구한 `required_fields`가 `structured_data`에 있다. 에이전트의 자기 보고는 outcome이 아니다 | `fail` |

필수 필드·허용 disposition은 업무 명세의 새 선택 필드 `expected_call_outcome: {dispositions, required_fields?}`가 정한다(`expected_quotes`와 같은 방식, ADR-0003 Amendment). Phone이 영업 절차를 하드코딩하지 않는다. 외부 시스템 갱신(CRM)은 별도 부작용 도구의 `external_effect`(`confirmed`)와 `policy_compliance`가 확인한다. 통화 원본(Call 기록·transcript)이 `evidence`로 연결되므로 보고서만으로는 `pass`가 나오지 않는다.
outcome은 상대방과의 대화에서 나온 요약이라 `external_untrusted`다(provider 분석이든 추출기든). 사람이 직접 기록한 outcome만 `internal`이다. LLM 검증(요약이 transcript로 뒷받침되는가)은 기존 `LlmVerifier` 포트에 연결할 수 있다 — 실제 모델은 Q22 이후.

### 8. 정책 경계
1. 게이트웨이가 호출마다 7요소 판정(`phone_call.call`, `customer`, `external_effect`)을 한다. 기본 정책의 `external-effect-needs-approval` 규칙 때문에 기본값은 막힘이다(게이트웨이에는 승인 경로가 없다). 전화를 쓰려면 인스턴스 정책에서 해당 규칙을 사람 승인으로 바꿔야 하고 이는 위험 변경이다.
2. 전화 전용 제약은 새 정책 섹션 `phone:`이 정한다(없으면 모든 통화 거부): `allowed_regions`, `denied_numbers`, `caller_ids`, `max_duration_seconds`, `max_calls_per_day`, `business_hours`, `recording`, `transfer_targets`. 판정기는 `PhoneCallPolicy` 포트를 구현한 `@aot/policy`이고 판정은 `policy_decision`에 남는다. 에이전트는 이 섹션을 쓸 수 없다(정책 변경 경로는 승인 CLI뿐). 이 섹션의 변경은 강화임을 증명할 수 없으면 위험 변경이다.
3. 통화량·비용 한도는 같은 섹션에서 확장한다(비용은 provider가 통화 후에만 알려 주므로 사전 한도가 아니라 `cost_entry`를 쓰는 사후 검사/예산으로 다룬다).
4. 부작용 직전 `beforeEffect` 재검증(승인 해시, 정책 강화)은 기존 `performEffect`가 한다.

### 9. 인바운드·전환
- 인바운드도 같은 Capability와 같은 `call` 테이블이다. provider webhook → 어댑터 → `PhoneEvent` → 알 수 없는 `provider_call_id`의 `initiated`(inbound)이면 Call 생성 → **명시적 라우팅 규칙**(수신 번호, 발신 번호, 영업시간; 첫 일치, 기본 거부) → 에이전트(`org_unit`·`role`·업무 명세 생성기) / 사람 / 거절. 라우팅은 권한을 바꾸지 않는다(trust-boundaries §2-7): 업무 생성과 도구 권한은 여전히 정책이 정한다. 라우팅 규칙은 인스턴스 설정이며 AI 라우터는 만들지 않는다.
- 전환: `phone_transfer`는 정책의 `transfer_targets`에 있는 번호로만, 그리고 Call 생성 시 `allow_transfer`가 참일 때만 된다. 부작용이므로 `performEffect`를 거치고 결과는 `phone.call.transferred`로 Call 상태에 반영된다.

### 10. 사람 확인이 필요한 가정 (open-questions Q28~Q31)
- **provider = Vapi 먼저.** Retell·Twilio는 `PhonePort` 구현만 더하면 된다(코어 변경 없음).
- **멱등 키:** Vapi가 호출 생성의 멱등 키를 문서로 확인되지 않아 `supports_idempotency=false`로 선언한다(Q14 규칙). 따라서 응답 유실(`unknown`)은 자동 재다이얼하지 않고 `needs_review`다. 전화를 두 번 거는 것이 더 나쁘다는 판단이다.
- **녹취·통화 고지 동의:** 법적 요건(국가별)은 이 구현이 판단하지 않는다. `recording` 정책 값을 provider 설정에 넘기고 기본은 `forbidden`이다. 한국 적용 여부는 사람이 검토한다.
- **webhook 공개:** 수신 엔드포인트는 외부에 노출되는 새 표면이다. 이 구현은 검증·변환 함수(`ingestPhoneWebhook`)까지 만들고 HTTP 리스너 노출·TLS·IP 제한은 배포 결정으로 남긴다.
- **수신거부(DNC) 목록:** `denied_numbers`로 시작하고 별도 연락처 관리는 Q9(개인정보 분류)과 함께 정한다.

## Consequences
- 새 패키지·서비스·workflow engine 없이 기존 원장·게이트웨이·평가기를 재사용한다. 코어는 provider 이름을 모르고, 새 provider는 어댑터 하나다.
- 스키마가 늘어난다(`call`, `call_artifact`). 첫 릴리스 전이므로 `0001_init.sql`과 `schema.sql`을 함께 고친다.
- 정책 문서 형식에 선택 키(`phone`)가 생긴다. 키가 없는 문서의 내용 해시(정책 버전)는 변하지 않는다.
- webhook이 없거나 늦으면 업무가 `validating`에 머문다. 마감·조회 보완이 있지만 provider 장애 시에는 사람이 본다.
- 실제 통화는 단위·통합 테스트에서 일어나지 않는다. 실제 provider 호출은 수동 smoke 절차로만 한다([phone-capability 계획](../plans/phone-capability.md)).
