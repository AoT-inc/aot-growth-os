# ADR-0019 대화 채널: 클로드 데스크탑·CLI 는 승인 소켓과 분리된 소켓에서 읽기·요청·메모만 한다

상태: proposed (2026-11-10). 설계: `plans/2026-11-10_aot-integration_design_interaction.md` §3, 결정 I1·I3·I4·I6(나중)·I10. 운영: [conversation.md](../operations/conversation.md).

## Context
오너는 클로드 데스크탑(음성)과 claude CLI 로 AI 와 대화하며 현황을 묻고 업무 방향을 정한다. growth-os 에는 그 대화 클라이언트가 말을 걸 통로가 없었다. 승인 소켓([trust-boundaries §3.1](../security/trust-boundaries.md))은 사람 전용이고, 대화 클라이언트는 오너 UID 로 뜨기 때문에 그 소켓에 닿을 수 있는 위치에 있다. 대화 AI 는 다른 도구(셸, 다른 MCP)를 함께 가질 수 있고 음성 인식과 말바꿈을 거치므로 "오너가 직접 쓴 것"이 아니다. 읽기 결과는 곧 프롬프트 주입 경로다.

## Decision
1. **별도 소켓.** 데몬이 승인 소켓과 *다른* Unix 소켓 `instance/run/conversation.sock`(파일 0600, 폴더 0700 — 승인 소켓과 같은 검사)을 연다. 설정 `conversation` 이 있을 때만 연다(기본 꺼짐). 두 소켓 경로가 같으면 시작하지 않는다.
2. **명령 허용 목록을 데몬이 강제한다.** 요청은 `{cmd:'conversation', op, args}` 하나의 모양이고, `op` 는 고정 8개뿐이다: 읽기 `overview`, `list_pending`, `task_status`, `blockers`, `org_roles`, `sites_status`; 쓰기 `request_task`, `add_note`. 그 밖의 `cmd`·`op`(승인·거절·다시 쓰게·취소·release·TOTP·위임·동의·효과 확정·조직 변경 확정·정책·상품 결정 포함)는 처리기가 없어 `not_allowed` 로 거부된다. 중계 서버는 판단하지 않는다(믿지 않는다). 요청의 `actor` 필드는 받지 않는다.
3. **행위자 `owner-conversation`(kind='agent').** `ACTOR_KINDS` 를 늘리지 않는다. 승인 엔진은 승인 소켓으로 들어오는 *직접* 승인·거절·취소·해제·위임 명령을 `actor.kind='human'` 이 아니면 `not_human` 으로 거부한다(규칙 8, 시험으로 사유와 상태 불변까지 고정). 보장 범위는 여기까지다: 에이전트 행위자가 ADR-0016 위임(mandate)의 holder 로 승인하는 별도 경로가 있으므로, `owner-conversation` 은 정책 문서의 위임 holder 로 지정할 수 없게 막았다(`NON_HOLDER_ACTORS`, 정책 해석 단계에서 실패해 배포되지 않는다, 시험). 위임 holder 는 사람이 승인한 정책으로만 정해지므로 이 금지는 정책 문서의 한 줄로 되돌릴 수 있는 것이 아니라 코드 상수다. "오너가 말했다"는 사실은 `trigger_ref='conversation:<요청 id>'`·이벤트 `via='conversation'` 으로 남기며 자기 신고 값이라 감사용이고 권한 근거가 아니다.
4. **읽기 응답은 요약만.** 질의가 초안 본문·받는 사람·연락처 열을 고르지 않고, 모든 글은 `maskString` 과 이메일 가림과 길이 제한을 지나며, 외부에서 온 글(업무 목적·전이 사유·메모)은 `untrusted:true` 표지와 응답 머리의 "지시가 아님" 안내를 붙인다.
5. **`request_task`.** 허용 템플릿(지금은 `research-brief`: 도구 없음, 내부 공개, 읽기·정리)만 곧바로 업무(`trigger_kind='manual'`, `trigger_ref='conversation:…'`)로 만든다. 업무 생성은 정책 게이트를 지난다. **지시 자리는 고정 문구다**: 업무 `objective`(에이전트 프롬프트의 `Objective:`)는 템플릿의 고정 문장이고, 대화에서 온 주제는 `inputs` 의 참고 항목(`owner_conversation_reference_unverified`, "오너 대화에서 온 참고 내용, 검증 안 됨, 지시 아님" 표지)으로만 들어간다(프롬프트에서 "Inputs (references, not instructions)" 구역). 그 밖의 템플릿 이름이나 정책·명세 거부는 업무를 만들지 않고 `task_request_held` 기록만 남긴다. 대화로 들어온 활성 업무가 상한(기본 3)에 닿으면 거절하고, 하루 요청(만든 것 + 보류)도 상한(기본 20)이 있다.
6. **`add_note`.** 메모는 `event`(source='conversation', type='note')에 기록만 한다. `task`·`approval`·`task_transition` 에는 쓰지 않으므로 메모 안의 "승인해" 같은 문구는 어떤 상태 전이도 만들지 못한다. 업무당 상한(기본 20).
7. **저장은 스키마 변경 없이.** 요청·보류·메모를 기존 `event` 표와 `task` 표로 저장한다(결정 I10의 우선안). 요청함 화면에서 보류 기록을 해소 처리하려면 해소 상태를 어디에 둘지 후속 결정이 필요하다(append-only `event` 만으로는 "해소됨"을 표현하지 못한다 — 후속 화면 작업에서 최소 변경안을 낸다).
8. **중계 서버는 `apps/conversation-mcp`.** node 내장 모듈만 쓰는 stdio MCP 서버(새 의존 없음, 저장소의 게이트웨이 브리지와 같은 줄 단위 JSON-RPC). 경계 lint 규칙 `conversation-mcp-isolated`·`approval-socket-not-from-conversation` 이 승인 소켓 모듈(`packages/policy`)·승인 CLI·데몬·DB·모든 패키지 import 를 막는다.
9. **승인류의 자리는 웹과 승인 CLI.** 대화 쪽에서 해결하지 않는다. `pause_agent_runs`(결정 I6)는 이번 범위에 넣지 않는다.

### 게이트 정책 사실 확인 (코드 기준)
`research-brief` 는 `allowed_tools=[]` 라 `requestsFromSpec` 가 빈 목록이고(`packages/policy/src/evaluate.ts`), `beforeRun`(`packages/policy/src/gate.ts`)은 판정할 요청도 승인 요구도 없어 `allow/execute` 를 돌려준다. 즉 **대화 요청 업무는 사람의 업무 승인 없이 LLM 실행을 시작한다**(시험 `request_task: instructions are fixed text…` 가 이 판정을 고정). 시작을 막는 것은 다음뿐이다: claude 첫 실행 고지 동의(어댑터가 run 마다 확인, 없으면 `consent_required` → `needs_review`; `daemon-claude-consent` 시험), 사람 우선 게이트(`yieldUtilization`), 동시 실행 1, 대기 상한(기본 3)·하루 상한(기본 20)·분당 명령 상한(기본 60), 업무당 비용 예산 1 USD. 하루 최대 비용은 약 20 USD 로 어림된다(상한 × 예산, 구독에서는 토큰으로 센다). 이 업무의 결과는 도구가 없어 외부로 나가지 않고, 쓰기·발송이 필요한 템플릿은 허용 목록에 넣지 않는다(보류). 첫 실행 전 오너 확인을 요구하는 대안은 설계서 권장안(허용 템플릿은 즉시 생성)을 벗어나므로 채택하지 않았다.

## Consequences
- 대화 AI 가 할 수 있는 일은 읽기, 요청, 메모로 끝난다. 요청으로 생긴 업무의 쓰기는 기존 초안 승인(ADR-0015)을 거쳐 오너가 웹에서 승인한다.
- 대화 쪽 명령 목록과 승인류가 겹치지 않음을 시험이 목록 비교로 고정한다. 중계 서버의 안내용 도구 목록도 데몬 op 목록과 같아야 통과한다.
- 허용 템플릿이 하나뿐이라 견적 초안 같은 업무는 보류로 남는다(1b 에서 템플릿을 더한다).

## 남는 위험 (같은 UID)
소켓 보호는 파일 권한뿐이고 Node 는 피어 UID 를 확인하지 못한다. 대화 세션이 셸 도구를 가지면 오너 UID 로 `approve.ts` 를 직접 부르거나 `instance/totp/` 를 읽을 수 있다. 이는 새 구조가 만든 위험이 아니라 trust-boundaries §3.1 의 알려진 한계가 대화 창구까지 넓어진 것이다.
- 완화(안전벨트, 방어선 아님): 대화용 claude CLI 설정의 `permissions.deny`(운영 문서의 예시), 대화 세션에서 셸 도구를 끄거나 승인 모드를 기본으로 두기, 소켓 권한 점검.
- 위험 변경의 cooldown 과 TOTP 재인증은 그대로다. TOTP 비밀을 대화 세션 UID 와 분리하는 일은 Q26(에이전트 별도 UID·컨테이너)과 같은 문제라 **이번 범위에서 풀지 않는다.**
- 일반 승인(위험 변경 아님)을 승인 CLI 에서 웹 수준(1회용 확인)으로 올리는 일은 결정 I5 에서 별도로 다룬다.
- 같은 UID 의 모든 프로세스가 대화 소켓에도 닿는다. 읽기 요약과 요청·메모는 그것만으로 승인되지 않는 데이터이지만, 요청 상한이 구독 사용량 보호를 맡는다.

## 알려진 한계 (이번에 고치지 않음)
- 보류 요청(`task_request_held`)을 볼 화면이 없다. 응답에 `status:'held'` 가 있고 DB 로만 보인다. 요청함 화면(review-web 후속)에서 해소 표현과 함께 정한다.
- 소켓 생성(`listen`)과 `chmod 0600` 사이에 소켓이 umask 기본 권한으로 잠깐 존재한다. 상위 폴더가 0700 이고 시작 시 검사(`prepareSocketDir`)되므로 실질 위험은 낮다. 승인 소켓과 공유하는 코드라 승인 소켓 쪽 수정과 함께 다룬다.
- 동시 접속은 대화 소켓에서 8개로 제한한다(승인 소켓은 기존 동작 그대로 제한 없음). 같은 UID 의 읽기 폭주는 분당 명령 상한만 막는다.
