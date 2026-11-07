# ADR-0017 첫 실제 메일 도구: 승인된 초안을 SMTP 로 바이트 그대로 보낸다

상태: proposed (2026-11-07, 구현됨 — 설계와 시험은 [plans/mail-tool](../plans/mail-tool.md), 운영 설정은 [operations/mail-domain-setup](../operations/mail-domain-setup.md). 오너 결정 M1~M8 은 기본값으로 구현했다)

## Context
[ADR-0015](0015-draft-before-approval.md)로 에이전트가 정확한 초안을 쓰고 사람이 그 초안을 승인하면 호스트가 그대로 보내는 경로가 생겼고, [ADR-0016](0016-decision-delegation.md)으로 사람이 정한 위임 안에서는 AI 가 승인할 수 있게 됐다(받는 사람 규칙 D-B11, 연락처 표). 그러나 원장에 묶인 실제 부작용 도구는 전화뿐이고 메일은 시험용 가짜(`test/support/message-tool.ts`)만 있다. 오너의 첫 실제 용도는 고객 메일이다(draft-before-approval §9 Q1).

메일이 전화와 다른 점: 내용 전체를 미리 확정할 수 있다(`approval: 'draft'`). 표준 프로토콜(SMTP)이 있어 업체에 묶이지 않을 수 있다. SMTP 는 멱등 키와 조회가 없다. 수신 거부는 법적 의무이고 반송은 비동기로 온다.

## Decision
1. **도구 `mail_send.send`** (`customer`, `external_effect`, `approval: 'draft'`). 실행기와 부작용 도구는 `@aot/agent-runtime` `src/mail/`, payload 규칙·렌더링·반송 반영은 `@aot/domain` `src/mail/`, 포트 `MailTransport` 는 `@aot/domain` `src/ports/`, SMTP 어댑터·설정·조립은 `apps/daemon` 에 둔다(ADR-0014 §2 와 같은 배치, 새 패키지·테이블 없음).
2. **포트 뒤의 provider, 기본은 SMTP 제출.** `MailTransport.send(OutboundMail)` 는 `accepted`(+업체 메시지 id) 또는 확실한 `rejected` 를 돌려주고, 결과를 알 수 없으면 던진다. 기본 어댑터는 SMTP(STARTTLS 587 또는 TLS 465, 인증서 검증 필수, AUTH 는 TLS 위에서만). 업체 HTTP API 어댑터는 같은 포트로 더한다. 멱등 키를 지원하는 어댑터만 `idempotency.supported=true` 를 선언한다.
3. **payload 는 `{from, to, cc?, subject, text}` 다섯 키뿐이다.** `from` 은 명세 target(`mail:<보내는 사람 키>`, 필수)의 설정 주소로 호스트가 채운다. `to` 1명, `cc` 는 `to` 와 같은 비무료 도메인 4명까지, 일반 글만. 검토 화면은 최상위 필드를 모두 자르지 않고 보여 주므로 사람(또는 위임)이 승인한 바이트가 내용 전부다. 렌더링은 순수 함수이고 내용을 더하지 않는다: 줄바꿈 `\n → \r\n` 과 전송 인코딩(base64, RFC 2047)만 하며, 디코드하면 payload 와 같다. 호스트가 더하는 헤더는 `Date`·`Message-ID`(effect_key 에서)·MIME·`List-Unsubscribe`·`Auto-Submitted` 뿐이다.
4. **결과 → 원장 상태.** 보내기 전 재검증(형식, 보내는 사람, 수신 거부, 하루 상한)에서 걸리거나, DATA 끝 점을 보내기 전에 거절·끊김이 나면 `failed`(보내지 않았음이 확실). RCPT 하나라도 거절되면 일부만 보내지 않고 `failed`. 끝 점 뒤 `250` 이면 `confirmed`. 끝 점 뒤 응답 전에 끊기거나 시간이 넘으면 `unknown` — SMTP 는 멱등 키가 없으므로 재전송하지 않고 사람이 `resolve-effect` 로 확정한다. 원장 규칙(ADR-0005, recovery §3)은 바뀌지 않는다.
5. **수신 거부는 누가 승인했든 보내지 않는다.** `contact.status='suppressed'` 를 초안 단계(실행기)와 전송 직전(부작용 도구)에 확인한다. 모든 메일에 mailto `List-Unsubscribe` 를 단다. RCPT 단계의 `5.1.x` 즉시 반송은 호스트 코드가 결정론적으로 그 연락처를 `suppressed` 로 좁힌다(`suppressed_by` NULL = 호스트, `event` source `mail` 감사 기록). 에이전트 출력은 이 경로의 입력이 될 수 없다. 비동기 반송·불만은 업체 webhook 이 생길 때 같은 함수로 넣고, 그 전까지는 사람이 연락처 명령으로 처리한다.
6. **비밀은 환경 변수 이름으로만 설정한다**(전화와 같음). DB·로그·오류 문자열에 자격 증명을 남기지 않고 SMTP 대화 기록을 저장하지 않는다.
7. **상한은 데몬 설정이다**: 하루 전송 수(기본 200), 전송 간격(기본 1초). 전체 전송 시간 상한(60초)은 lease(90초)보다 짧다.

## Consequences
- 첫 실제 고객 메일이 ADR-0015/0016 경로로 나갈 수 있다. 엔진(`dispatchApprovedDrafts`, 원장, 정책 게이트)은 바뀌지 않는다.
- SMTP 기본이라 응답 유실은 사람 확정이 필요하다(드물다: 끝 점과 응답 사이의 끊김). 이를 줄이려면 멱등 키를 지원하는 업체 어댑터(M1)가 필요하다.
- 일시 장애로 `failed` 가 된 초안은 다시 쓰게로 새 초안을 만들어야 한다(ADR-0015 Q7 그대로, M8).
- 연락처 표에 호스트가 쓰는 길이 하나 생긴다(좁히기만, 결정론). [trust-boundaries](../security/trust-boundaries.md)와 스키마 주석의 "사람만 쓴다"를 "사람과, 수신 거부로 좁히는 호스트 반송 처리"로 읽는다.
- 연락처 표에 없는 주소의 반송은 기록만 남는다(`contact.added_by` 가 사람 행위자를 요구한다). 같은 주소로 다시 보내면 다시 반송될 뿐이다.
- HTML·첨부·숨은 참조·회신 주소·표시 이름은 v1 에 없다. 더하려면 검토 화면이 그 내용을 전부 보여 줄 수 있는지 먼저 정한다.
