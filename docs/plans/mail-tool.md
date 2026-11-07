# 첫 실제 고객 메일 도구 (mail_send) 설계

상태: 설계 + 구현 (2026-11-07). 결정은 [ADR-0017](../adr/0017-mail-tool.md). 앞선 설계: [draft-before-approval](draft-before-approval.md) §9 Q1·Q7, [ADR-0015](../adr/0015-draft-before-approval.md), [ADR-0016](../adr/0016-decision-delegation.md). 참고 어댑터: 전화([ADR-0014](../adr/0014-phone-capability.md)). 운영 설정: [operations/mail-domain-setup](../operations/mail-domain-setup.md).

## 0. 결론 (먼저 읽을 것)

- 에이전트가 쓴 메일 초안을 사람(또는 위임 AI)이 승인하면, **호스트가 승인된 payload 를 그대로 메일로 만들어** SMTP 로 보낸다. LLM 은 전송 경로에 없다.
- 기본 provider 는 **SMTP 제출(587 STARTTLS 또는 465 TLS)**이다. 어느 메일 업체든 SMTP 를 받으므로 업체에 묶이지 않는다. 업체 HTTP API 어댑터는 같은 포트 뒤에 나중에 붙인다(오너 결정 M1).
- SMTP 는 멱등 키가 없다. 그래서 **응답을 잃으면 `unknown` → 사람이 확정**하고 자동 재전송은 하지 않는다(같은 메일 두 번이 더 나쁘다).
- 수신 거부(`contact.status='suppressed'`) 주소에는 **누가 승인했든 보내지 않는다**. 초안을 만들 때 한 번, 보내기 직전에 한 번 더 확인한다.
- 받는 사람 주소가 존재하지 않는다는 즉시 거절(SMTP `5.1.x`)은 호스트 코드가 결정론적으로 그 연락처를 수신 거부로 바꾼다. 에이전트는 이 경로에 닿지 않는다.
- payload 필드는 `from`(호스트가 채움)·`to`(1명)·`cc`(선택)·`subject`·`text` 다섯 개뿐이다. 검토 화면은 최상위 필드를 모두 그대로 보여 주므로 **사람이 본 것 = 보낸 내용**이다. HTML·첨부·숨은 참조·회신 주소·표시 이름은 v1 에 없다.

## 1. 범위

| 한다 | 하지 않는다 (후속) |
|---|---|
| 초안 승인 업무(ADR-0015)에서 고객 한 명에게 일반 글 메일 한 통 보내기 | HTML 본문, 첨부(Q4), 대량 발송·뉴스레터 |
| SMTP 어댑터, 가짜 transport, 시험용 가짜 SMTP 서버 | 업체 HTTP API 어댑터(M1), 비동기 반송·불만 webhook 수신 |
| 보내기 직전 재검증(형식·보내는 사람·수신 거부·하루 상한) | 받은 메일 읽기(답장 처리) — 응답이 필요한 일은 후속 업무(ADR-0015 D8) |
| 즉시 반송(5.1.x) → 결정론적 수신 거부 | 원클릭 https 수신 거부 엔드포인트(M6) |
| 도메인 설정 운영 문서(SPF·DKIM·DMARC) | 수신 거부 해제(v1 에 없음, 연락처 표 규칙 그대로) |

## 2. 구성과 위치 (전화와 같은 방식, ADR-0014 §2)

```
에이전트 → 게이트웨이(mail_send.send, 호출마다 정책 판정)
        → 메일 실행기(agent-runtime, bindToEffectLedger): 인자 검증 + from 채움 + 수신 거부 확인 → RunContext.performEffect
        → [초안 단계] effect_draft 에 그대로 저장 → 검증 → 사람/위임 승인
        → [전송 단계] host:dispatch → dispatchApprovedDrafts → performEffect(펜싱, planned→dispatched)
        → 메일 부작용 도구(agent-runtime): 재검증 + 렌더링(domain, 순수) → MailTransport 포트
        → SMTP 어댑터(apps/daemon) → 메일 서버
```

| 조각 | 위치 | 이유 |
|---|---|---|
| payload 형식·검증(`validateMailPayload`), 상한(`MAIL_LIMITS`), MIME 렌더링(`renderMailMessage`, 순수), 반송 반영(`applyMailFeedback`) | `@aot/domain` `src/mail/` | 전화의 `src/phone/` 와 같다. provider 타입 없음 |
| `MailTransport` 포트 | `@aot/domain` `src/ports/mail-transport.ts` | 포트는 domain 에 둔다(PhonePort 와 같음) |
| 게이트웨이 선언·실행기, 부작용 도구, 가짜 transport | `@aot/agent-runtime` `src/mail/` | 호스트 쪽 도구. domain 포트만 쓴다 |
| SMTP 어댑터, 설정 해석, 조립 | `apps/daemon` (`mail-smtp.ts`, `mail-config.ts`, `mail.ts`) | 비밀값을 가진 인프라 코드는 조립 지점에 둔다 |
| 메일 도구의 명세 `target` 필수 규칙 | `@aot/domain` `spec/task-spec.ts` | 전화의 `phone_target` 과 같은 자리 |

코어 패키지는 업체 이름을 모른다. 새 패키지·새 테이블은 만들지 않는다.

## 3. 도구 선언

- 이름 `mail_send`, operation `send`, `scope: 'customer'`, `impact: 'external_effect'`, `approval: 'draft'`.
- 멱등 선언: transport 가 멱등 키를 지원하지 않으면(SMTP) `{supported: false}`. 지원하는 어댑터는 `{supported: true, retention_ms: <업체 보존 기간>}` 을 선언한다. `lookup` 은 v1 에 없다(따라서 `effect_key_carrier` 도 선언하지 않는다).
- **명세 `target` 필수:** `mail_send` 를 요청하는 `allowed_tools` 항목은 `target: 'mail:<보내는 사람 키>'`(키는 `^[a-z0-9][a-z0-9-]{0,31}$`)를 반드시 밝힌다. 없으면 명세 생성이 거부된다(`mail_target`). 보내는 사람 키는 데몬 설정 `mail.senders` 의 키다. 사람이 승인 화면의 "보내는 방법"(`mail_send · send · mail:support`)에서 어느 주소로 보내는지 본다.
- 명세에 `mail_send` 항목이 여러 개라 대상이 둘 이상이면 실행기가 거부한다(`ambiguous_sender`). 한 업무는 한 보내는 사람으로 보낸다.

## 4. payload (사람이 승인하는 바이트)

정규 JSON(`canonicalJson`)으로 저장되는 객체. **이 다섯 키 밖은 모두 거부한다.**

| 키 | 필수 | 누가 채움 | 규칙 |
|---|---|---|---|
| `from` | 예 | **호스트(실행기)** | 명세 target 의 보내는 사람 주소. 에이전트가 넘기면 거부(`from_not_allowed`). 보낼 때 설정의 주소와 다르면 보내지 않는다 |
| `to` | 예 | 에이전트 | 주소 **정확히 1개**. `normalizeAddress(x) === x`(소문자, 표시 이름 없음)여야 한다 |
| `cc` | 아니오 | 에이전트 | 0~4개. 같은 규칙 + **모두 `to` 와 같은 도메인**이고 그 도메인이 공개 무료 메일(`FREE_MAIL_DOMAINS`)이 아니어야 한다(다른 고객끼리 주소가 보이지 않게). 빈 배열은 키를 빼라고 거부한다 |
| `subject` | 예 | 에이전트 | 1~200자, 앞뒤 공백만인 제목 거부, 제어 문자·줄바꿈 금지(헤더 주입 방지) |
| `text` | 예 | 에이전트 | 1~50,000자(= 검토 화면의 조각 상한 `CHUNK_MAX`), `\r` 금지(줄바꿈은 `\n`), 탭·`\n` 밖의 제어 문자, 짝 없는 서로게이트, `U+FFFD` 금지 |

- 받는 사람 수 합계(to + cc)는 최대 5다. 위임의 `max_recipients_per_draft` 는 그 위에 겹친다.
- 검토 화면(`payload-view.ts`)은 최상위 필드마다 조각 하나를 자르지 않고 보여 주고, 너무 크거나 글이 아니거나 비밀처럼 보이면 승인 버튼을 내지 않는다. 위 규칙은 그 조건보다 좁다: 실행기는 `maskString` 이 바꾸는 `subject`/`text` 도 초안 단계에서 거부한다(승인할 수 없는 초안을 만들지 않는다).
- `messagePreviewOf`(목록 미리보기)와 `recipientAddressesOf`(위임 받는 사람 규칙)는 이 모양을 그대로 읽는다. `bcc`·`reply_to`·`headers` 는 없으므로 위임 규칙이 보지 못하는 받는 사람이 생기지 않는다.

## 5. 렌더링 (payload → RFC 5322 메시지, 결정론)

`renderMailMessage({payload, messageId, date, listUnsubscribe})` 는 순수 함수다. 내용을 바꾸거나 더하지 않는다. 호스트가 더하는 헤더는 내용이 없는 전송 헤더뿐이다.

```
From: <payload.from>
To: <payload.to[0]>
Cc: <payload.cc 를 ", " 로>              (있을 때만)
Subject: <ASCII 70자 이하면 그대로, 아니면 RFC 2047 =?UTF-8?B?…?= 조각(문자 경계에서 자름, 줄 접기)>
Date: <RFC 5322 날짜, 시계 기준>
Message-ID: <effect_key 앞 32자@message_id_domain>
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: base64
List-Unsubscribe: <mailto:수신거부주소?subject=unsubscribe>
Auto-Submitted: auto-generated

<base64(UTF-8(text 의 \n 을 \r\n 으로)), 76자 줄>
```

- **유일한 변환은 줄바꿈 `\n → \r\n`(SMTP 규칙)과 전송 인코딩(base64·RFC 2047)이다.** 받는 쪽이 디코드하면 `subject`·`text` 와 정확히 같다. 시험은 가짜 SMTP 서버가 받은 DATA 를 디코드해 승인된 payload 와 바이트 비교한다.
- base64 본문이라 점 하나로 시작하는 줄·긴 줄 문제가 없다. 그래도 SMTP 전송부는 점 채우기(dot-stuffing)를 한다.
- `Message-ID` 는 effect_key 에서 정해진다. 같은 효과를 다시 보내는 일이 생기면(멱등 지원 어댑터) 같은 Message-ID 가 되어 받는 쪽 중복 제거에 걸린다. effect_key 는 내용 해시라 비밀·개인정보가 아니다.
- `Date` 만 전송 시각이다(내용 아님).

## 6. 보내기 직전 재검증과 결과 → 원장 상태

메일 부작용 도구의 `send` 는 원장이 `planned → dispatched` 를 펜싱·정책 재판정과 함께 기록한 **뒤에** 불린다. 순서:

1. `validateMailPayload` 다시 (저장 payload 가 형식에 맞는가).
2. `from` 이 지금 설정의 target 보내는 사람 주소와 같은가.
3. 받는 사람 중 `suppressed` 가 있는가 (연락처 표, 승인 뒤 수신 거부가 들어왔을 수 있다).
4. 하루 상한: 최근 24시간 `mail_send` 원장 행 중 `dispatched|confirmed|unknown` 수(자기 자신 제외) ≥ `max_per_day` 인가.
5. 최소 간격: 같은 프로세스에서 직전 전송 뒤 `min_interval_ms` 가 지나지 않았으면 그만큼 기다린다(거부하지 않는다).
6. 렌더링 → `MailTransport.send`.

| 상황 | 결과 | 원장 |
|---|---|---|
| 1~4 중 하나라도 걸림 (아무것도 연결하지 않음) | `failed` | `failed` (보내지 않았음이 확실) |
| 연결 실패·TLS 실패·STARTTLS 미제공·인증 실패·인사/MAIL 단계 거절 | transport `rejected` | `failed` |
| RCPT 하나라도 거절 (RSET 후 끊음, **일부만 보내지 않는다**) | `rejected` + 5.1.x 주소 목록 | `failed` (+ §7 수신 거부) |
| DATA 끝(`.`)을 보내기 전 어디서든 끊김·시간 초과 | `rejected` | `failed` (RFC 5321: 끝 점 전에는 메시지가 성립하지 않는다) |
| 끝 점 뒤 `250` | `accepted` | `confirmed`, `response_ref` = Message-ID (업체 id 가 있으면 그것) |
| 끝 점 뒤 `4xx`/`5xx` | `rejected` | `failed` |
| **끝 점 뒤 응답 전에 끊김·시간 초과** | 예외(던짐) | **`unknown`** → 멱등 미지원이라 재전송 없음 → 업무 `needs_review` → 사람이 `resolve-effect` |
| 그 밖의 예상하지 못한 예외 | 예외 | `unknown` (보수적) |

- `failed` 는 ADR-0015 규칙대로 뒤 초안을 보내지 않고 run 오류가 된다. 일시 장애로 `failed` 가 된 초안은 다시 승인해도 재전송되지 않는다(Q7, 오너 결정 M8). 같은 내용은 "다시 쓰게"로 새 초안을 만든다.
- 시간 상한: 연결 10초, 명령 응답 30초, 전체 전송 60초(설정 가능, 60초 이하). lease 기본 90초보다 짧아 전송 중 lease 를 잃지 않는다. 잃으면 인수한 run 이 `dispatched → unknown` 으로 처리한다(기존 규칙).

## 7. 수신 거부·반송·불만

- **수신 거부 목록 = `contact` 표의 `suppressed`.** 초안 단계(실행기)와 전송 직전(부작용 도구) 두 번 확인한다. 사람이 승인한 초안이라도 보내지 않는다(M2). 연락처 표에 없는 주소는 "모르는 주소"일 뿐 거부 대상은 아니다(사람은 보낼 수 있고, 위임은 받는 사람 규칙이 막는다).
- **수신 거부 요청 경로:** 모든 메일에 `List-Unsubscribe: <mailto:…>` 헤더를 단다(설정 `unsubscribe_mailto` 필수). 그 주소로 온 요청은 사람이 처리한다(`contacts suppress`, 화면의 기존 경로). 원클릭 https(RFC 8058)는 공개 리스너가 필요해 v1 에 없다(M6).
- **즉시 반송(결정론):** RCPT 단계에서 `5.1.x`(받는 사람 주소 없음·도메인 없음 등) 확장 상태로 거절된 주소는 부작용 도구가 `applyMailFeedback(db, clock, {kind:'hard_bounce', address, detail})` 로 반영한다: 연락처 표에 있으면 `suppressed`(`suppressed_by` NULL = 호스트), 없으면 기록만. 둘 다 `event`(`source='mail'`, `type='mail.feedback.hard_bounce'`)로 감사 기록을 남긴다. 좁히기만 한다(`active` 로 되돌리지 않는다). 그 밖의 거절(`5.7.x` 정책, `4xx`)은 수신 거부로 바꾸지 않는다.
- **비동기 반송·불만:** SMTP 에는 없다(반송 메일이 envelope-from 으로 돌아온다). 업체 HTTP 어댑터가 webhook 을 줄 때 같은 `applyMailFeedback`(`complaint`·`hard_bounce`)으로 넣는다. 그 전까지는 반송 메일함을 사람이 보고 `contacts suppress` 한다(운영 문서).
- 에이전트는 이 경로 어디에도 닿지 않는다. 에이전트 출력은 `applyMailFeedback` 의 입력이 될 수 없다(입력은 transport 결과뿐).

## 8. 보내는 사람과 도메인

- 설정 `mail.senders`: `{ <키>: { address } }`. 주소는 `normalizeAddress` 를 통과해야 하고, 그 도메인의 SPF·DKIM·DMARC 가 준비돼 있어야 한다(운영 문서 체크리스트). envelope-from(반송 주소)은 `mail.bounce_address`(없으면 보내는 사람 주소).
- 공개 무료 메일 도메인을 보내는 사람으로 쓰는 설정은 거부한다(DMARC 정렬이 깨진다).
- `message_id_domain` 기본값은 보내는 사람 주소의 도메인.

## 9. 비밀값

- 설정은 비밀이 아니라 **비밀이 든 환경 변수의 이름**만 갖는다(`smtp.username_env`, `smtp.password_env`) — 전화의 `api_key_env` 와 같다. 시작할 때 읽어 어댑터 안에만 두고, 없으면 시작을 거부한다.
- DB 에 넣지 않는다: 원장에는 `response_ref`(Message-ID)만, 초안 payload 에는 메일 내용만 있다.
- 로그에 넣지 않는다: SMTP 대화 기록을 남기지 않는다. 어댑터의 오류 메시지는 단계·응답 코드·확장 상태만 담고(서버 응답 원문·AUTH 줄·자격 증명 없음), `toString` 이 설정 객체를 드러내지 않는다. 시험이 오류 문자열에 비밀번호가 없음을 확인한다.
- AUTH 는 TLS 위에서만 한다(PLAIN). `security: 'none'` 은 루프백 호스트에만 허용하고(로컬 릴레이·시험) 그때는 자격 증명 설정을 거부한다(평문 AUTH 가 나갈 길이 없다). 인증서 검증은 끄지 않는다(시험용 `ca_file` 만 있다).

## 10. 하루 상한·간격

- `mail.max_per_day`(기본 200, 이 인스턴스 전체), `mail.min_interval_ms`(기본 1000). 데몬 설정이다(에이전트가 쓸 수 없다). 정책 섹션 `mail:` 로 옮겨 위험 변경 등급을 받을지는 M7.
- 위임의 일일 수 한도(ADR-0016)는 결정 수이고, 이 상한은 전송 수다. 둘 다 적용된다.

## 11. 오너 결정 (기본값으로 이미 구현함 — 다르게 원할 때만 답하면 된다)

| # | 질문 | 기본값 (구현됨) | 다른 선택 |
|---|---|---|---|
| M1 | 어떤 provider 로 보내나 | SMTP 제출(업체 무관) | 업체 HTTP API 어댑터 추가: 멱등 키로 `unknown` 자동 해소, webhook 반송·불만 |
| M2 | 수신 거부 주소에 사람이 승인하면 보내나 | 보내지 않는다 | 사람 승인만 예외 |
| M3 | 즉시 반송(5.1.x)을 자동으로 수신 거부하나 | 한다(호스트, 결정론) | 기록만 하고 사람이 정한다 |
| M4 | 받는 사람 범위 | to 1명, cc 는 같은 회사 도메인 4명까지, 숨은 참조 없음 | 숨은 참조 허용, 받는 사람 수 늘리기 |
| M5 | HTML·첨부·표시 이름 | 없음(일반 글) | HTML(사람이 볼 렌더링 확정 필요), 첨부(Q4) |
| M6 | 수신 거부 방법 | mailto 헤더 + 사람 처리 | 원클릭 https 엔드포인트(공개 리스너), 본문 문구 의무화 |
| M7 | 상한 위치 | 데몬 설정(하루 200, 1초 간격) | 정책 `mail:` 섹션(배포 승인 대상) |
| M8 | 일시 장애로 `failed` 된 초안 | 다시 쓰게로 새 초안(Q7 그대로) | 승인이 한 번의 재전송을 덮게(엔진 변경) |

## 12. 시험

- 단위: payload 검증(키·주소·cc 도메인·길이·제어 문자), 렌더링 왕복(디코드 = payload, 한글 제목 조각 경계, `\n→\r\n`), 설정 해석(모르는 키·비밀 환경 변수·루프백 규칙·무료 메일 보내는 사람), 부작용 도구 결과 매핑(표 §6 각 행), 수신 거부·하루 상한, 반송 반영, 명세 `mail_target`, 오류 문자열에 비밀 없음.
- 통합(가짜 SMTP 서버, `node:net`, 루프백만): 초안 run → 승인 → 전송 → 서버가 받은 바이트가 승인 payload 와 같음; RCPT 5.1.1 → `failed` + 수신 거부 + 아무 메시지도 성립 안 함; 끝 점 뒤 끊김 → `unknown` → `needs_review`, 재전송 0; 승인 뒤 수신 거부 → 전송 0; STARTTLS 를 내세우지 않는 서버 → 인증 전에 `failed`; AUTH PLAIN 이 TLS 없이 나가지 않음. STARTTLS 왕복은 `openssl` 이 있으면 임시 자체 서명 인증서로 시험하고 없으면 건너뛴다. 실제 네트워크는 쓰지 않는다.
