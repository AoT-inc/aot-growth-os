# Phone Capability 구현 기록과 수동 smoke 절차

설계 근거: [ADR-0014](../adr/0014-phone-capability.md). 이 문서는 구현 단위, 정의 완료(DoD) 대응, 실제 provider 호출(수동 smoke) 절차를 모은다.

## 구현 단위 (2026-10-25)

| 단위 | 내용 | 시험 |
|---|---|---|
| P1 | 설계: 위치·Call/Task 분리·저장·정책·평가 (ADR-0014) | — |
| P2 | domain: 채널 중립 발화·결과 모듈, 전화 canonical 모델·이벤트·상태 허용표, `call`·`call_artifact` 테이블, 통화 저장과 이벤트 적용, 인바운드 라우팅, `expected_call_outcome` | `phone-model`, `phone-calls`, `entity-*`, `schema-drift` |
| P3 | 포트: `PhonePort`, `PhoneCallPolicy` | `phone-port-fake`, `phone-vapi`(계약) |
| P4 | Fake provider (자기 나름의 webhook 형식 → canonical 변환) | `phone-port-fake`, `phone-lifecycle` |
| P5 | 정책: `phone:` 섹션, 변경 등급, `PhoneCallPolicy` 구현 | `policy-phone` |
| P6 | task-engine: 열린 통화가 있으면 `validating` 보류 | `task-call-wait` |
| P7 | evaluation: `call_*` 검사 3개 | `evaluation-call` |
| P8 | agent-runtime: Capability, 부작용 도구, 게이트웨이 도구, webhook 수신, 인바운드, 마감 조회, `approvalViaEffectGate` | `phone-capability`, `agent-runtime-gateway-effect-gate`, `phone-lifecycle` |
| P9 | Vapi 어댑터, 데몬 조립(`phone` 설정, webhook 리스너, 마감 조회 루프) | `phone-vapi`, `phone-config`, `phone-webhook-server` |

## DoD 대응

| 정의 완료 항목 | 어디서 |
|---|---|
| Phone이 Agent가 쓰는 Capability | `PhoneCapability`(domain 인터페이스) + 게이트웨이 도구 `phone_call`·`phone_transfer`·`phone_hangup` |
| Core domain이 provider에 종속되지 않음 | domain·task-engine·policy·evaluation에 provider 이름 없음. 어댑터는 `apps/daemon`(Vapi)과 시험용 Fake뿐. 경계 lint 통과 |
| Outbound lifecycle | `phone-lifecycle` 첫 시험: 요청 → 원장 → 접수 → webhook → 완료 → 검증 → `completed` |
| Inbound lifecycle 구조 | webhook → `initiated`(inbound) → 라우팅 → 업무 생성·연결 → 지시 응답 (`phone-lifecycle` inbound 4개) |
| Provider event → canonical event | 어댑터 `parseWebhook`; 계약 시험이 모든 어댑터에 검증·이름·id 안정성·비밀 비노출을 요구 |
| Call과 Task 분리, 상관 | `call.task_id`·`task_run_id`·`effect_key`; 인바운드는 `linkCallToTask` |
| Transcript를 artifact로 | `call_artifact(transcript)` + `evidence` |
| Structured outcome | `call_artifact(outcome)`, `recordCallOutcome`(에이전트 불가, 한 번만) |
| Evaluation이 Call 결과를 검증 | `call_completed`·`call_transcript_present`·`call_outcome_recorded` |
| 자기 보고만으로 완료되지 않음 | `phone-lifecycle`(webhook 없이 마감 → fail), `evaluation-call`(통화 없는 보고 → fail) |
| Policy boundary | `phone:` 섹션(없으면 거부), 명세 대상 범위, 게이트웨이 정책, 원장 직전 승인 재검증 |
| Human transfer/escalation | `phone_transfer` → `transferred` 상태 (`phone-lifecycle`) |
| Fake provider 테스트 | 위 전부 |
| 실제 secret이 저장소에 없음 | 설정은 환경 변수 *이름*만, 시험은 `*-not-real` 값과 예약 번호 |
| dependency boundary | `npm run lint:boundaries` |
| 기존 task-engine/workflow 재사용 | 새 엔진 없음. 원장·워커·검증기·게이트웨이를 그대로 사용 |

## 수동 smoke 절차 (실제 Vapi, 사람이 비공개 환경에서만)

단위·통합 시험은 실제 전화를 걸지 않는다. 아래는 어댑터가 문서와 어긋나지 않는지 확인하는 절차이며 **공개 CI에서 돌리지 않는다**([public-repository](../security/public-repository.md)). 확인되지 않은 항목은 어댑터 주석의 `UNVERIFIED`로 표시했다.

1. 준비: 테스트용 Vapi 계정, 발신 번호 1개(`phoneNumberId`), 테스트 assistant 1개(첫 멘트에 AI 통화임을 알린다), 본인 휴대전화. `instance/daemon.config.json`의 `phone`에 환경 변수 이름만 적고 값은 환경에 주입한다. 정책 `phone:` 섹션에 본인 번호의 지역·발신 번호·`max_calls_per_day: 2`·`recording: forbidden`을 두고 승인 CLI로 배포한다.
2. **호출 생성 필드 확인** (UNVERIFIED): `assistantOverrides.variableValues`, `assistantOverrides.metadata`, `assistantOverrides.artifactPlan.recordingEnabled`가 Vapi에서 400 없이 받아들여지는지, 녹음이 실제로 꺼지는지. 400이면 어댑터의 `startCall` 본문을 문서에 맞게 고친다(시험의 기대 본문도 함께).
3. **발신 1회:** 명세의 `allowed_tools[].target`에 본인 번호를 적은 업무를 만들고 사람 승인·해제 후 실행한다. 통화가 걸리는지, `call` 행이 `initiated → ringing → connected`로 가는지 본다. 받은 뒤 이야기하고 끊는다.
4. **webhook:** Vapi의 Server URL을 역방향 프록시/터널 뒤 리스너로 향하게 하고(TLS는 앞단에서 종료) Custom Credential을 `webhook_secret_env`의 값과 맞춘다. `end-of-call-report`가 transcript(시스템 프롬프트 제외)·분석을 담아 도착하는지, `analysis.structuredData.disposition` 같은 필드를 assistant의 분석 계획으로 만들 수 있는지 확인한다. 잘못된 비밀로 보낸 요청이 401인지 확인한다.
5. **평가:** 통화가 끝난 뒤 다음 tick에 업무가 검증되어 `completed`가 되는지, outcome이 없으면 `needs_review`가 되는지 본다.
6. **끊기·전환:** 통화 중 `phone_hangup`/`phone_transfer`가 `monitor.controlUrl`로 동작하는지(UNVERIFIED: `GET /call/{id}`가 `monitor.controlUrl`을 주는지 포함). 전환 대상은 `transfer_targets`의 본인 두 번째 번호로 한다.
7. **복구:** webhook 리스너를 끈 채 통화를 끝내고 마감 뒤 `reconcile`이 `GET /call/{id}`로 종료를 가져오는지 본다.
8. 결과(확인된 필드 이름, 달라진 점)를 이 문서에 정제해서 기록하고 어댑터·시험을 고친다. 비용과 개인정보(번호, 녹취)는 기록하지 않는다.

## 이월 (이 구현에 없음)

- Retell·Twilio 어댑터 ([Q28](../open-questions.md)), HMAC webhook 서명 검증 ([Q30](../open-questions.md))
- 에이전트 대상 인바운드의 업무 생성: 라우팅 규칙은 설정에 있고 업무 생성기는 코드에서 주입한다. 데몬 설정으로 팩 템플릿을 연결하는 부분은 실제 인바운드 업무 템플릿이 정해진 뒤에 한다.
- 요약↔transcript 의미 검증(`LlmVerifier` 연결, [Q22](../open-questions.md))과 CRM 갱신 같은 후속 외부 상태 도구([Q14](../open-questions.md))
- 녹음 파일 저장, 법적 고지 ([Q29](../open-questions.md)), 수신거부 목록 ([Q31](../open-questions.md))
- 두 번째 채널과 `conversation` 계층 승격 ([Q32](../open-questions.md))
