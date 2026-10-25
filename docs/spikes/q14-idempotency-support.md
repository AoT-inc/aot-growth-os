# 스파이크 Q14: 외부 부작용 도구별 멱등 키 지원

상태: 조사 완료, 후속 결정 4건 대기 (2026-10-25) · 관련: [open-questions Q14](../open-questions.md), [phase-a §5 스파이크 3](../plans/phase-a.md), [recovery §3](../operations/recovery.md), [ADR-0004 Amendment](../adr/0004-events-routines-idempotency.md)

문서 조사만 했다. 계정을 만들거나 로그인하지 않았고, 발송·게시·API 호출은 하지 않았다. 확인한 것은 공개 문서 페이지뿐이다.

## 결론

후보 13개 중 **멱등 키를 문서로 확인한 도구는 2개**(Resend 이메일 발송, Mastodon 게시)뿐이다. 나머지 11개는 키가 없거나 문서에 언급이 없다. 문서에서 확인하지 못한 것은 "지원"으로 보지 않는다(`supports_idempotency=false`, fail-closed).

| 등급 | 조건 | 도구 | Phase A 처리 |
|---|---|---|---|
| 재전송형 | `supports_idempotency=true` | Resend(발송), Mastodon(게시) | `unknown` → `queued`, 같은 키로 재전송 (recovery §3 표). 단 **키 보존 기간 안에서만 안전**하다(아래 결정 1) |
| 조회형 | `false` + 조회 가능 | Postmark, WordPress, HubSpot(연락처), X, LinkedIn, Facebook Pages, Slack | 재전송 금지. 조회로 전달을 확인하고, 확인 못 하면 `needs_review` (recovery §3 표 그대로) |
| 승인형 | `false` + 조회 불가 | Amazon SES, SendGrid, Mailgun, Salesforce | **승인 필수·자동 재시도 금지** (phase-a §5 판정 기준) |

"조회 가능"의 정도가 도구마다 다르다. 우리 `effect_key`로 정확히 찾을 수 있는 도구는 Postmark(`Metadata`), WordPress(`slug`), HubSpot(고유 속성 검색)뿐이다. X·LinkedIn·Facebook·Slack은 최근 글 목록을 가져와 내용을 대조하는 근사 조회라서, "찾지 못함"이 "보내지 않았음"을 뜻하지 않는다. 그래서 조회형은 전달 확인에만 쓰고 "없음"을 근거로 재전송하지 않는다(미지원 도구는 어차피 재전송하지 않는다).

설계를 바꿀 수 있는 결과는 문서에 적용하지 않고 [사용자 결정 필요](#사용자-결정-필요)에 모았다.

## 판정 방법 (시작 전에 고정)

[phase-a §5 스파이크 3](../plans/phase-a.md)의 문구를 그대로 썼다.

- **방법:** 후보 도구의 공식 문서 조사. 실제 발송·게시는 하지 않는다.
- **산출물:** 도구별 표 — 멱등 키 지원 여부, 키 보존 기간, 상태 조회 API 유무, 보상 작업 가능 여부.
- **판정 기준:** 도구마다 `supports_idempotency=true/false`와 "재전송 전 상태 조회 가능 여부"가 문서 근거와 함께 채워진다. 미지원이면서 조회도 불가한 도구는 Phase A에서 승인 필수·자동 재시도 금지로 분류한다.

기준 문구는 바꾸지 않았다. 문구를 적용하려고 아래 세 가지를 정했다. 이 해석은 자료를 모은 뒤에 문서에 적었다는 점을 밝혀 둔다.

1. **`supports_idempotency=true`** = 문서가 요청에 실어 보내는 **멱등 키**와 중복 요청 처리 규칙을 밝힌 경우만. 문서에 언급이 없으면 `false`다(없다고 단정한 것이 아니라 근거가 없다는 뜻). upsert처럼 키 없이 결과가 같아지는 **자연 멱등**은 `false`로 두고 따로 적는다.
2. **"재전송 전 상태 조회 가능"** = 응답을 못 받은 `unknown` 상태에서 쓸 수 있는 조회. 응답에 있던 제공사 ID가 있어야만 조회되는 API는 `unknown`에서 ID를 모르므로 "ID만"으로 적고 조회 불가로 센다. 우리 값으로 찾을 수 있으면 "키", 최근 목록을 가져와 내용을 비교해야 하면 "내용 대조"로 적고 둘 다 조회 가능으로 센다.
3. **보상 가능** = 문서에서 삭제·취소 API를 확인한 경우만 "가능". 확인하지 못한 것은 "확인 못 함"이다.

## 후보 도구와 선정 근거

[recovery §3](../operations/recovery.md)이 부작용 예시로 든 이메일·게시·외부 API 쓰기와, 이 질문이 직접 가리킨 이메일 발송·게시·CRM 쓰기를 분야별로 나눴다. 분야마다 공개 문서가 있고 서로 성격이 다른 서비스를 골랐다.

| 분야 | 도구 | 고른 이유 |
|---|---|---|
| 이메일 | Amazon SES(v2), SendGrid, Postmark, Mailgun, Resend | 거래·마케팅 메일 API로 널리 쓰이는 다섯. 키 지원 서비스(Resend)와 명시적 미지원(Postmark)을 둘 다 포함 |
| 게시 | Mastodon, X, LinkedIn, Facebook Pages, Slack, WordPress(REST) | 마케팅 업무의 공개 게시 대상(소셜, 사이트)과 사내 알림. 키가 있는 서비스(Mastodon)와 없는 서비스를 함께 보려고 |
| CRM 쓰기 | HubSpot, Salesforce | 가장 널리 쓰이는 두 CRM. 둘 다 생성은 키가 없고 upsert 경로가 있다 |
| 기준선(후보 아님) | Stripe | 결제는 Phase A 후보가 아니다. 키 지원의 일반적인 형태(보존 기간·충돌 규칙)를 비교하는 기준으로만 읽었다 |

고르지 않은 것: 결제·청구, 광고 집행, 문자·푸시 알림, 캘린더. Phase A 주간 사이클(조사·기획·측정)이 쓰지 않는다. 필요해지면 같은 표에 행을 더한다.

## 결과

근거 수준: **◎** 공식 문서 본문을 가져와 확인(요약 도구를 거쳤으므로 핵심 문장은 적용 전 원문 대조 권장), **○** 검색 결과에 실린 공식 문서 발췌만 확인(본문 열람 실패), **△** 해당 문서에서 언급을 찾지 못함(부재 근거).

### 이메일 발송

| 도구(작업) | 멱등 키 | 키 보존 | 상태 조회 | 보상 | `supports_idempotency` | 등급 | 근거 |
|---|---|---|---|---|---|---|---|
| Resend: 발송·일괄 발송 | **있음.** `Idempotency-Key` 헤더(SMTP는 `Resend-Idempotency-Key`), 1~256자. 같은 키·다른 내용 → 409, 진행 중 동일 키 → 409 | **24시간** | 발송 ID로 조회(`last_event` 포함). 키로는 조회 불가, 보존 기간 문서 없음 | 확인 못 함 | **true** | 재전송형 | ◎ [1][2] |
| Amazon SES v2: SendEmail | 요청 본문에 없음 | — | `GetMessageInsights`가 `MessageId`로만 조회(초당 1회). 응답 유실 시 ID 모름. 문서는 "수락했지만 발송하지 않을 수 있다"고 밝혀 `MessageId`가 곧 발송 확인은 아님 | 확인 못 함 | false | 승인형 | ◎ [3][4] |
| SendGrid: Mail Send v3 | 문서에 언급 없음. 응답은 "Accepted"뿐 | — | 이메일 활동 피드에서 메시지 ID로 검색, 추가 저장소 사용 시 최대 30일. 발송 응답에 ID가 없어 `unknown`에서 쓰기 어려움 | 확인 못 함 | false | 승인형 | ◎ △ [5][6] |
| Postmark: 발송 | **명시적 미지원.** "Postmark does not currently support an idempotency key feature" | — | **키로 가능.** 요청 `Metadata`에 `effect_key`를 싣고 `metadata_<필드>` 필터로 검색(한 번에 필드 하나). 보존 기본 45일(7~365일 설정) | 확인 못 함 | false | 조회형 | ◎ [7][8][9] |
| Mailgun: 메시지 발송 | 발송에는 없음. 멱등 키는 수신함 배치 시험 전용 `o:inbox-placement-test-key`뿐 | — | 로그·이벤트를 메시지 ID로 검색(ID 필요). 이벤트 API는 로그 API로 대체 중이며 보존은 플랜별 1~30일로 자료가 엇갈림 | 확인 못 함 | false | 승인형 | ◎ ○ [10][11] |

### 게시

| 도구(작업) | 멱등 키 | 키 보존 | 상태 조회 | 보상 | `supports_idempotency` | 등급 | 근거 |
|---|---|---|---|---|---|---|---|
| Mastodon: 글 작성 | **있음.** `Idempotency-Key` 헤더("to prevent duplicate submissions") | **최대 1시간** | 글 ID로 `GET`. 키로는 조회 불가 | **가능**(본인 글 `DELETE`, 삭제한 본문을 반환) | **true** | 재전송형 | ◎ [12] |
| X: 글 작성 | 문서에 언급 없음. 중복 내용 처리도 미기재 | — | 사용자 타임라인(최근 최대 3,200건, 시간·ID 필터)으로 **내용 대조** | **가능**(본인 글 `DELETE`) | false | 조회형 | ◎ △ ○ [13][14][15] |
| LinkedIn: Posts 작성 | 문서에 언급 없음. 쓰기 충돌(409)·500·503은 "재시도하라"고 안내 | — | 작성자별 목록(`q=author`, 최대 100건)으로 **내용 대조**. 생성 응답 헤더 `x-restli-id`가 ID | **가능**(`DELETE`, 이미 지운 글도 204로 멱등) | false | 조회형 | ◎ [16] |
| Facebook Pages: 피드 게시 | 문서에 언급 없음(재시도 시 글이 두 번 생길 수 있다는 것은 이 조사의 추론이지 문서의 문장이 아니다) | — | `/page_id/feed` 목록으로 **내용 대조** | **가능**(`DELETE`) | false | 조회형 | ◎ [17] |
| Slack: `chat.postMessage` | 인자에 없음. `client_msg_id`는 오류 설명에만 나오고 사용법 미기재. `internal_error` 등은 "일부 동작이 이미 성공했을 수 있다"고 경고 | — | `conversations.history`로 시간 범위·커서 조회(**내용 대조**) | **가능**(봇 토큰은 자기 메시지만 `chat.delete`) | false | 조회형 | ◎ [18][19][20] |
| WordPress REST: 글 작성 | 문서에 언급 없음 | — | **키로 가능.** `slug` 필터·`search`로 조회. `slug`에 `effect_key` 파생값을 쓴다. 슬러그 중복 시 서버 동작은 문서에 없음(조회 후 전송 필요) | **가능**(`DELETE`, `force`로 휴지통 우회) | false | 조회형 | ◎ △ [21] |

### CRM 쓰기

| 도구(작업) | 멱등 키 | 키 보존 | 상태 조회 | 보상 | `supports_idempotency` | 등급 | 근거 |
|---|---|---|---|---|---|---|---|
| HubSpot: 연락처 생성·upsert | 생성에 키 없음(문서에 언급 없음). **자연 멱등:** 일괄 upsert(`idProperty` = 이메일 또는 고유 속성)는 있으면 갱신, 없으면 생성 | — | 검색 API로 속성값 조회(문서가 가리킴). `effect_key`를 담을 고유 속성을 따로 설계해야 한다 | **일부.** `DELETE`는 휴지통으로 가고 복원은 화면에서만 문서에 있음(복원 API 확인 못 함) | false | 조회형 | ◎ △ [22] |
| Salesforce: 레코드 쓰기 | 생성에 키 없음. **자연 멱등:** 외부 ID 필드 기준 `PATCH` upsert는 있으면 갱신, 없으면 생성, 여러 건 일치하면 300 오류로 아무것도 바꾸지 않음 | — | 외부 ID 조회 문서는 본문을 열지 못해 확인 못 함 | 확인 못 함 | false | 승인형(조회 근거 없음) | ○ [23] |

### 기준선 (후보 아님)

| 도구(작업) | 멱등 키 | 키 보존 | 상태 조회 | 보상 | 근거 |
|---|---|---|---|---|---|
| Stripe: 모든 `POST` (API v1) | `Idempotency-Key`, 최대 255자. 같은 키는 첫 요청의 상태 코드·본문(500 포함)을 돌려주고, 파라미터가 다르면 오류. 검증 실패·동시 충돌은 결과를 저장하지 않아 재시도 가능 | **24시간 이상 지나면 삭제될 수 있다.** 삭제 뒤 같은 키를 쓰면 새 요청으로 처리 | `GET`·`DELETE`는 정의상 멱등이라 키를 보내지 않는다 | — | ◎ [24] |

이 행은 판정에 쓰지 않았다. 다만 두 가지가 아래 결정 1·4의 근거가 된다. 키가 보존 기간이 지나면 사라진다는 것, 그리고 같은 서비스 안에서도 동작에 따라 멱등 성질이 다르다는 것이다.

## 출처

조회일 2026-10-25. 문서는 버전이 바뀐다(LinkedIn Posts는 월 단위 버전 헤더, Mailgun 이벤트 API는 대체 중). 어댑터를 쓸 때 다시 확인한다.

1. Resend, 멱등 키: https://resend.com/docs/dashboard/emails/idempotency-keys
2. Resend, 이메일 조회: https://resend.com/docs/api-reference/emails/retrieve-email
3. Amazon SES v2 `SendEmail`: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
4. Amazon SES v2 `GetMessageInsights`: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetMessageInsights.html
5. SendGrid Mail Send: https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
6. SendGrid 이메일 활동 피드: https://www.twilio.com/docs/sendgrid/ui/analytics-and-reporting/email-activity-feed
7. Postmark, 멱등 키 지원 안내: https://postmarkapp.com/support/article/what-is-an-idempotency-key
8. Postmark Email API: https://postmarkapp.com/developer/api/email-api
9. Postmark Messages API: https://postmarkapp.com/developer/api/messages-api
10. Mailgun 메시지 발송: https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages
11. Mailgun 로그·보존(검색 결과 발췌): https://help.mailgun.com/hc/en-us/articles/32010244893211-Logs
12. Mastodon 글 API: https://docs.joinmastodon.org/methods/statuses/
13. X 글 작성: https://docs.x.com/x-api/posts/creation-of-a-post
14. X 글 관리 소개: https://docs.x.com/x-api/posts/manage-tweets/introduction
15. X 글 삭제·타임라인(검색 결과 발췌): https://docs.x.com/x-api/posts/delete-post, https://docs.x.com/x-api/posts/timelines/introduction
16. LinkedIn Posts API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
17. Facebook Pages 게시: https://developers.facebook.com/docs/pages-api/posts
18. Slack `chat.postMessage`: https://docs.slack.dev/reference/methods/chat.postMessage
19. Slack `chat.delete`: https://docs.slack.dev/reference/methods/chat.delete
20. Slack `conversations.history`: https://docs.slack.dev/reference/methods/conversations.history
21. WordPress REST, 글: https://developer.wordpress.org/rest-api/reference/posts/
22. HubSpot 연락처 가이드: https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide
23. Salesforce 외부 ID upsert(검색 결과 발췌, 본문 열람은 403): https://developer.salesforce.com/docs/atlas.en-us.264.0.api_rest.meta/api_rest/resources_sobject_upsert_patch.htm
24. Stripe 멱등 요청: https://docs.stripe.com/api/idempotent_requests

## 한계

- **"언급 없음"은 "미지원 확정"이 아니다.** △ 표시 행은 해당 페이지에서 찾지 못한 것이다. 규칙(fail-closed)에 따라 `false`로 두었을 뿐이며, 제공사가 다른 페이지나 비공개 계약으로 지원할 수 있다.
- 본문을 가져올 때 요약 도구를 거쳤다. Resend·Mastodon·Postmark·Stripe의 핵심 문장은 원문 인용 형태로 받았지만, 어댑터를 구현할 때는 원문을 다시 대조한다.
- Salesforce는 공식 문서 본문을 열지 못했다(403). 근거는 검색 결과에 실린 발췌뿐이라 가장 약한 행이다.
- 요청 한도, 요금제별 차이, 계정 종류(무료·유료)에 따른 보존 기간 차이는 조사하지 않았다. Mailgun 보존 기간은 자료가 서로 달라 숫자를 확정하지 않았다.
- 서버 쪽 일시적 지연(방금 보낸 글이 목록에 늦게 나타남)은 문서로 확인하지 못했다. 내용 대조 조회의 "찾지 못함"을 믿지 않는 이유 중 하나다.
- 실제 호출이 없어서 문서와 실제 동작이 다른 경우는 잡지 못한다.

## 사용자 결정 필요

아래 네 가지는 계약·스키마·엔진 동작에 닿는 내용이라 문서에 반영하지 않았다. 판정에 따른 갱신은 (값 확정 + 링크)까지만 했다.

1. **키 보존 기간.** Mastodon은 최대 1시간, Resend·Stripe는 24시간이다. 현재 `supports_idempotency`는 참/거짓 하나이고 엔진은 보존 기간을 모른다([`EffectTool`](../../packages/task-engine/src/effects.ts)에도 필드가 없다). `unknown`이 된 업무는 `queued`로 돌아가 같은 키로 재전송되는데, 재시도 대기나 사람 응답으로 시간이 지나면 키가 이미 지워져 있을 수 있고, 그러면 같은 키가 새 요청이 되어 **중복 부작용**이 생긴다(Stripe 문서가 이 동작을 밝힌다). 선택지: (a) 도구 계약에 보존 기간 값을 두고, 첫 `dispatched` 뒤 그 시간(여유 포함)이 지났으면 미지원 도구처럼 다룬다(계약·엔진 변경), (b) 보존 기간이 짧은 도구는 `false`로 선언해 조회형으로 쓴다(변경 없음, 대신 Mastodon을 재전송형으로 못 쓴다). 권장: (a). 결정 전에는 Mastodon·Resend 어댑터를 쓰지 않거나 (b)로 선언한다.
2. **자연 멱등을 `true`로 볼지.** HubSpot의 일괄 upsert와 Salesforce의 외부 ID `PATCH`는 키는 없지만 같은 요청을 다시 보내도 결과가 같다. 지금 계약의 문구는 "외부 시스템의 멱등 키 지원 여부"라서 `false`로 두었다. 자연 멱등 동작(고정 외부 ID로 upsert)을 `true`로 인정하면 CRM 쓰기 상당수가 재전송형이 되지만, 인정 조건(고정 ID를 반드시 쓸 것, 여러 건 일치 오류 처리)을 계약에 적어야 한다.
3. **도구 단위인가 동작 단위인가.** `external_effect`는 도구와 동작(`action`)을 함께 기록하므로 스키마는 동작 단위 선언을 담을 수 있다. 반면 `EffectTool`과 [recovery §3](../operations/recovery.md) 문구는 도구 단위처럼 읽힌다. Stripe는 `POST`만 키를 받고 `GET`·`DELETE`는 정의상 멱등이며, 같은 서비스에서도 동작마다 다르다. 어디에서 선언할지 정해야 한다.
4. **조회형의 `effect_key` 전달 규칙.** `lookup(effectKey)`로 정확히 찾으려면 보내기 전에 `effect_key`를 제공사가 검색할 수 있는 자리에 실어야 한다(Postmark `Metadata`, WordPress `slug`, HubSpot 사용자 지정 속성). 그런 자리가 없는 X·LinkedIn·Facebook·Slack은 내용 대조라서 "없음"이 확정이 아니다. 어댑터 계약(A5)에 이 규칙과 "내용 대조 조회는 `confirmed` 확인에만 쓴다"는 한계를 적을지 결정해야 한다.

결정이 필요하진 않지만 어댑터를 쓸 때 알아 둘 점: LinkedIn은 409·500·503에 "재시도하라"고 안내하고 Slack은 `internal_error`에서 일부 동작이 성공했을 수 있다고 경고한다. 이런 응답은 [recovery §3](../operations/recovery.md)의 `failed`(외부가 명확히 실패 응답)가 아니라 `unknown`으로 매핑해야 한다. SES의 `MessageId`는 수락 시점에 발급되므로 발송 확인이 아니다.

## 반영

- [open-questions](../open-questions.md) Q14: 조사 완료와 위 결정 대기로 갱신.
- [recovery §3](../operations/recovery.md): 이 스파이크로 가는 링크 한 줄. 규칙 문구와 표는 그대로.
- [ADR-0005](../adr/0005-agent-adapter-boundary.md): Amendment(2026-10-25)로 초기 선언 값의 위치만 적었다.
- [phase-a](../plans/phase-a.md) §6 종료 조건 3과 A6 완료 기록의 해당 줄을 실제 결과에 맞게 고쳤다.
- 스키마·시험·코드는 건드리지 않았다.
