# ADR-0014 전화는 에이전트의 직원이 아니라 Capability다

상태: proposed (구현과 함께 올린다. 아래 "사용자 결정이 필요한 항목"이 정해지기 전까지 accepted 로 올리지 않는다)

## Context
영업·지원·채용 에이전트가 실제 전화를 걸고 받아야 한다. 전화 제품(Vapi, Retell, Twilio 등)은 교체될 가능성이 크고, 통화는 길고 비동기이며, 외부 세계(고객)에 직접 영향을 준다. 이 저장소는 이미 같은 모양의 문제를 세 번 풀었다:

| 이미 있는 것 | 전화에서 재사용하는 방식 |
|---|---|
| 외부 부작용 원장 `external_effect` (ADR-0004 Amendment, recovery §3) | 발신은 `EffectTool` 한 건. 같은 키 재전송 방지, 응답 유실 시 `unknown`, 멱등 키가 없는 제공자는 **자동 재발신 금지** |
| 정책 게이트 `TaskPolicyGate.beforeEffect` (ADR-0006) | 발신 직전 `phone.call` × 대상 번호를 7요소로 재판정, 승인 해시 확인 |
| 비동기 외부 입력의 대기 조건 (A6-U13 측정 값) | 통화 종료 이벤트가 생길 때까지 후속 업무를 집지 않는다. 전이도 시도 소모도 없다 |
| 독립 평가 (ADR-0007) | 통화 사실(연결·종료·녹취)은 제공자 이벤트에서, 결과는 시스템이 보관한 기록에서 검사한다. 에이전트 보고서는 쓰지 않는다 |

## Decision

### 1. Phone 은 Capability 이고 새 패키지·새 테이블·새 워크플로 엔진이 없다
- `packages/phone` 을 만들지 않는다. ADR-0001 의 5개 패키지와 경계 규칙을 그대로 둔다.
- 새 DB 테이블을 만들지 않는다. 통화는 `event`(수명주기·녹취·결과 기록)와 `evidence`(업무에 붙는 산출물)로 표현한다. `Call` 은 이벤트를 접어(fold) 얻는 투영이다. 이벤트는 append-only 이고 `idempotency_key` 가 중복 전달을 흡수하므로 기존 보장을 그대로 쓴다.
- 새 워크플로 엔진이 없다. "발신 업무 → (통화) → 검토 업무"는 기존 업무 의존(`dependencies`)과 대기 조건으로 잇는다.

### 2. 코드 위치 (의존 방향 `domain ← task-engine/policy/evaluation ← agent-runtime ← apps`)
| 위치 | 내용 |
|---|---|
| `domain/src/phone/` | 제공자 중립 정본 모델: `Call`·`CallStatus`·상태 허용표, `CanonicalPhoneEvent`, `Transcript`, `CallOutcome`, 라우팅 규칙, **`PhoneProvider` 포트**, `PhoneCapability`, 통화 원장(event 접기), 가드(운영자 한도). 제공자 이름·SDK·페이로드 타입이 없다 |
| `task-engine` | 명세 `inputs[kind='phone_call']` 대기 조건과 근거 첨부. 제공자를 모른다(정본 이벤트 이름만 안다) |
| `evaluation` | 결정론적 검사 `call_connected`, `call_completed`, `transcript_available`, `call_outcome_valid` (`extraChecks` 주입 지점 사용, 평가기 본체 변경 없음) |
| `agent-runtime` | 제공자 어댑터(`FakePhoneProvider`, `vapi/`). `fetch_url` 과 같은 층: 외부 접근·비밀값 주입은 여기서만 |
| `apps/daemon` | 조립: 웹훅 수신 → 어댑터 파싱 → 원장, 에이전트 의도 → 캐퍼빌리티 실행 래퍼 |

에이전트 런타임·task-engine·domain 은 Vapi/Retell/Twilio 를 import 하지 않는다. 경계 lint 가 막는다.

### 3. 발신은 호스트가 한다 — 에이전트는 의도만 낸다
도구 게이트웨이는 `require_approval` 호출을 막는다(승인 경로가 없다. A6 결정). 외부 부작용은 기본 정책에서 승인이 필요하므로 샌드박스 안 에이전트가 게이트웨이로 직접 발신하는 길은 열지 않는다. 대신:

```
Task(approved_hash) → TaskExecutor(에이전트가 call 의도를 result 로 제출)
   → PhoneCapability.call → RunContext.performEffect('phone', step)   ← 정책 beforeEffect + 원장
   → PhoneProvider.placeCall → CallHandle 즉시 반환 (통화를 기다리지 않는다)
```
- 발신 대상은 명세 `allowed_tools[].target = 'tel:<E.164>'` 가 묶는다(`beforeEffect` 가 정확히 일치를 요구). 에이전트는 승인된 번호가 아닌 곳에 걸 수 없다.
- 통화 길이·허용 국가번호·차단 번호·일일 한도·이관 대상은 **운영자 설정**(`PhoneLimits`)이다. 에이전트의 `constraints` 는 그 한도를 좁히기만 한다(`min`).
- 정책 파일(ADR-0013) 형식은 바꾸지 않는다. 업무시간·비용 한도·녹취 의무는 `PhoneCallGuard` 확장 지점으로 남기고 정책 형식 변경은 사용자 결정 뒤에 한다(아래).

### 4. 통화와 업무의 분리와 상관
```
Task(place_call) ──performEffect──► Call(callKey) ──webhook──► phone.call.* 이벤트
Task(review_call, inputs[phone_call:<callKey>]) ◄── 대기: phone-call:<callKey>:ended 이벤트가 생길 때까지
```
- `callKey` 는 AoT 의 통화 식별자다(`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`). 발신은 요청자가 정한다(결정론적으로) — 그래서 통화가 생기기 전에 후속 업무가 `ref = phone-call:<callKey>` 로 기다릴 수 있고, 같은 키가 발신 멱등 키의 뿌리가 된다. 수신은 `in-<제공자>-<제공자 통화 id>` 로 시스템이 정한다.
- 업무 ↔ 통화 상관: 요청 이벤트 payload 에 `task_id`·`agent_id`·`organization_id`, 제공자 통화 id 매핑은 `phone-provider-call:<제공자>:<id>` 이벤트.
- 후속 업무는 `completed`/`failed`/`cancelled` 중 첫 종료 이벤트가 오면 집힌다. 종료 이벤트의 키는 통화당 하나(`:ended`)라 늦게 오는 상충 이벤트가 결과를 뒤집지 못한다.

### 5. 정본 이벤트와 상태
`phone.call.requested|initiated|ringing|connected|transcript.updated|completed|failed|cancelled|transferred|outcome.recorded|routed`.
상태: `queued → initiated → ringing → connected → completed`, 어느 단계에서든 `failed`/`cancelled`, `connected → transferred → completed|failed`. 제공자 상태 어휘는 어댑터 안에서만 쓰고 정본으로 번역한다. 순서가 뒤바뀌거나 중복 전달된 이벤트는 허용표에 맞지 않으면 접을 때 무시된다(감사용으로 이벤트는 남는다). 허용표는 [docs/schema/state-machines.md](../schema/state-machines.md) 에 추가했다(기존 표는 바꾸지 않았다).

### 6. 녹취(Transcript)와 결과(CallOutcome)
- `Transcript {callId, turns[{speaker: agent|customer|system, text, startedAt?, endedAt?}], language?, createdAt}`. 제공자 원본 페이로드는 저장하지 않고 정본만 `transcript.updated` 이벤트에 둔다(원본의 sha256 만 `raw_hash` 로 남겨 대조). 통화 내용은 개인정보이므로 인스턴스 DB 에만 있다 — 저장소에 실제 통화 데이터를 두지 않는다.
- 녹취와 제공자가 준 요약은 `external_untrusted` 다(고객 발화에 지시문이 있을 수 있다). 업무에 붙는 근거는 `kind='document'`, `ref='phone-transcript:<callKey>'`, `content_hash='sha256:…'`.
- `CallOutcome {callId, disposition, summary, structuredData, nextAction?}`. 어떤 필드가 필수인지는 영업 절차를 아는 쪽이 정한다: **`PhoneObjectiveRules`(목적별 허용 disposition·필수 데이터)** 를 평가기에 주입한다. 캐퍼빌리티는 형식만 검증한다. 규칙이 없는 목적은 `unknown` → 평가 `inconclusive`(fail-closed).
- 에이전트가 제출한 결과는 호스트가 검증해 `outcome.recorded` 이벤트로 **시스템 기록**이 된다. 평가기는 에이전트 보고서가 아니라 이 기록과 제공자 이벤트를 본다.

### 7. 완료 판정
`call_connected` ∧ `call_completed` ∧ `transcript_available` ∧ `call_outcome_valid` ∧ `policy_compliance`(기존) 가 모두 pass 여야 한다. 하나라도 `unknown` 이면 inconclusive → `needs_review`. "고객과 이야기했고 관심 있다고 합니다"라는 보고만으로는 어떤 검사도 통과하지 못한다.

### 8. 수신과 라우팅
수신은 별도 시스템이 아니다: 웹훅 → 정본 이벤트(`direction='inbound'`) → 원장 → **명시적 라우팅 규칙**(`PhoneRoutingRule[]`: 착신 번호·발신 번호 접두·요일/시간대, 첫 일치) → `phone.call.routed` 이벤트. 일치가 없으면 `human` 대기열이 기본이다(AI 라우터 없음). 라우팅 결과로 업무를 만드는 것은 기존 이벤트 → 업무 경로(ADR-0004)이며 이 ADR 이 새 입구를 만들지 않는다.

### 9. 인간 이관
`PhoneCapability.transfer` 는 이관 대상을 번호가 아니라 **운영자가 정의한 대기열 이름**(`PhoneLimits.transferQueues`)으로 받는다. 통화가 `allowTransfer=false` 로 요청됐으면 거부한다. 이관 결과는 `transferred` 이벤트로 Call 상태에 반영된다. 통화 중 제공자 쪽 음성 에이전트가 하는 이관은 이벤트로만 관측한다.

### 10. 제공자 선택
MVP 는 Vapi 하나(`agent-runtime/src/phone/vapi/`). Retell/Twilio 는 `PhoneProvider` 포트만 맞추면 된다. 제공자 오류는 `PhoneProviderError { code, placed: 'no'|'maybe' }` 로 번역한다: `placed:'no'`(4xx·인증·한도) → 원장 `failed`, `'maybe'`(타임아웃·5xx·응답 유실) → `unknown`. Vapi 의 `POST /call` 은 멱등 키를 문서에서 확인하지 못했으므로 `supportsIdempotency=false`: **`unknown` 이면 다시 걸지 않고** `needs_review` 로 간다(고객에게 같은 전화를 두 번 거는 사고 방지).

## Consequences
- DB 스키마와 기존 상태 허용표를 바꾸지 않는다. 대신 통화 조회가 이벤트 접기이며(통화당 이벤트 수십 건 이하), 대규모에서 느려지면 `calls` 투영 테이블을 새 마이그레이션으로 더한다(그때 결정).
- `inputs[kind='phone_call']` 는 task_spec 의 입력 종류 하나를 더한다(스키마 아님, 명세 형식). 승인 해시에 `inputs` 가 포함되므로 기다리는 통화 키가 바뀌면 재승인이 필요하다.
- 통화가 끝나지 않으면 후속 업무는 계속 대기한다. 통화 단위 만료는 이 변경에 없다(열린 항목).

## 사용자 결정이 필요한 항목 (open-questions 에도 적었다)
1. 정책 형식(ADR-0013) 확장: 업무시간·일일 통화량·비용 한도·녹취 의무를 정책 문서에 둘지(지금은 운영자 설정 `PhoneLimits` 과 `PhoneCallGuard`).
2. `calls` 투영 테이블/인덱스 필요 시점(지금은 이벤트 접기).
3. 웹훅 수신 HTTP 서버: 신뢰 경계 신설이므로 [trust-boundaries](../security/trust-boundaries.md) 갱신과 함께 별도 결정. 이 변경은 "원문+헤더 → 정본 이벤트" 함수까지만 있다.
4. 어댑터 입력에 통화 녹취를 데이터로 넘기는 계약(`AdapterInput.upstream` 은 `task:<id>` 만 받는다. ADR-0005 Amendment 필요).
5. 제공자 요약/구조화 결과(예: Vapi `analysis`)를 근거로 인정할지.
6. Vapi 서버 URL 인증 방식(문서에서 헤더 규격을 확인하지 못했다. 어댑터는 운영자가 정한 헤더 이름·비밀값의 상수시간 비교로 구현했고 실제 smoke test 에서 확정한다).
