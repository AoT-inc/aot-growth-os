# 스파이크 Q14: 외부 부작용 도구별 멱등 키 지원

상태: 조사 완료, 결정 3건 승인·1건 보류 (2026-10-25). 구현 전 · 관련: [open-questions Q14](../open-questions.md), [phase-a §5 스파이크 3](../plans/phase-a.md), [recovery §3](../operations/recovery.md), [ADR-0004 Amendment](../adr/0004-events-routines-idempotency.md)

문서 조사만 했다. 계정을 만들거나 로그인하지 않았고, 발송·게시·API 호출은 하지 않았다. 확인한 것은 공개 문서 페이지뿐이다.

## 결론

후보 13개 중 **멱등 키를 문서로 확인한 도구는 2개**(Resend 이메일 발송, Mastodon 게시)뿐이다. 나머지 11개는 키가 없거나 문서에 언급이 없다. 문서에서 확인하지 못한 것은 "지원"으로 보지 않는다(`supports_idempotency=false`, fail-closed).

| 등급 | 조건 | 도구 | Phase A 처리 |
|---|---|---|---|
| 재전송형 | `supports_idempotency=true` | Resend(발송), Mastodon(게시) | `unknown` → `queued`, 같은 키로 재전송 (recovery §3 표). 단 **키 보존 기간 안에서만 안전**하다([결정 1·3](#결정-2026-10-25-사용자-승인)) |
| 조회형 | `false` + 조회 가능 | Postmark, WordPress, HubSpot(연락처), X, LinkedIn, Facebook Pages, Slack | 재전송 금지. 조회로 전달을 확인하고, 확인 못 하면 `needs_review` (recovery §3 표 그대로) |
| 승인형 | `false` + 조회 불가 | Amazon SES, SendGrid, Mailgun, Salesforce | **승인 필수·자동 재시도 금지** (phase-a §5 판정 기준) |

"조회 가능"의 정도가 도구마다 다르다. 우리 `effect_key`로 정확히 찾을 수 있는 도구는 Postmark(`Metadata`), WordPress(`slug`), HubSpot(고유 속성 검색)뿐이다. X·LinkedIn·Facebook·Slack은 최근 글 목록을 가져와 내용을 대조하는 근사 조회라서, "찾지 못함"이 "보내지 않았음"을 뜻하지 않는다. 그래서 조회형은 전달 확인에만 쓰고 "없음"을 근거로 재전송하지 않는다(미지원 도구는 어차피 재전송하지 않는다).

설계를 바꿀 수 있는 결과 네 가지는 [결정](#결정-2026-10-25-사용자-승인)에서 정했다(사용자 승인, 구현 전).

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

## 결정 (2026-10-25, 사용자 승인)

조사 때는 아래 네 가지를 계약·스키마·엔진에 닿는다는 이유로 반영하지 않고 권장안과 함께 올렸고, 사용자가 권장안대로 승인했다. 계약 문서에는 반영했고 **코드·스키마는 아직 바꾸지 않았다.**

1. **키 보존 기간 — 선언에 포함하고 재전송을 보존 기간의 50% 안으로 제한한다.** Mastodon은 최대 1시간, Resend·Stripe는 24시간이다. 재시도 대기나 사람 응답으로 시간이 지나 키가 지워진 뒤 같은 키를 보내면 새 요청이 되어 부작용이 중복된다. 한계를 넘으면 그 부작용을 미지원 도구처럼 다룬다(조회, 확인 안 되면 `needs_review`). 50%는 서버가 요청을 받은 시각이 `planned`보다 늦고 시계 오차가 있다는 여유다. 예: Resend 12시간, Mastodon 30분.
2. **자연 멱등(upsert) — 인정하지 않는다(보류).** 키가 없으면 `supported=false`다. 재전송해도 결과가 같다는 것이 안전과 같지 않다(그 사이 사람이 고친 값을 덮어쓸 수 있다). 첫 CRM 쓰기 어댑터를 만들 때 다시 정한다. 인정하게 되면 조건: ① 요청에 `effect_key` 파생 고정 외부 ID 사용 ② 여러 건 일치는 `needs_review` ③ 보존 기간 "없음".
3. **선언 단위 — (도구, `action`) 단위.** `external_effect`는 이미 `tool`과 `action`을 기록한다. 도구 단위로 선언하면 가장 약한 동작에 맞춰야 한다. 형식은 `{supported: true, retention_ms}` | `{supported: false}`다. 결정 1과 하나의 계약 변경이다.
4. **조회형의 `effect_key` 전달 — 전달 방식을 선언한다.** `metadata`(Postmark) / `slug`(WordPress) / `property`(HubSpot) / `none`(X, LinkedIn, Facebook, Slack). `none`은 내용 대조라서 "찾음"만 `confirmed` 근거이고 "못 찾음"은 재전송 근거가 아니다(엔진은 이미 그렇게 동작한다). 내용 대조의 시간 범위는 `dispatched` 이후로 제한하고, 공개 게시물 본문에는 `effect_key`를 싣지 않는다.

구현할 때 정해야 하는 것: 기준 시각이다. `external_effect.at`은 전이마다 덮어써져(`transitions.ts`의 `UPDATE ... SET at = ?`) 최초 `planned` 시각이 남지 않는다. 컬럼 추가는 스키마 변경이라 별도 승인이 필요하다.

어댑터를 쓸 때 알아 둘 점(결정 4의 오류 매핑으로 계약에 반영): LinkedIn은 409·500·503에 "재시도하라"고 안내하고 Slack은 `internal_error`에서 일부 동작이 성공했을 수 있다고 경고한다. 이런 응답은 [recovery §3](../operations/recovery.md)의 `failed`가 아니라 `unknown`으로 매핑한다. SES의 `MessageId`는 수락 시점에 발급되므로 발송 확인이 아니다.

첫 어댑터 후보(문서 조사 기준): 이메일은 Resend(키 확인) 또는 Postmark(`Metadata`로 정확한 조회), 사이트 게시는 WordPress(`slug` 조회와 삭제). SES·SendGrid·Mailgun은 응답을 잃으면 조회할 방법이 없어 승인 필수 경로로만 쓴다.

## 반영

- [open-questions](../open-questions.md) Q14: 해소(결정 3건, 보류 1건)로 갱신.
- [recovery §3](../operations/recovery.md): 멱등 선언과 재전송 조건 절 추가. 위 재시도 표는 그대로이고 "같은 키 재전송은 보존 기간 안에서만"이 그 아래에서 덧붙는다.
- [ADR-0004](../adr/0004-events-routines-idempotency.md) Amendment, [ADR-0005](../adr/0005-agent-adapter-boundary.md) Amendment(2026-10-25).
- [phase-a](../plans/phase-a.md) §6 종료 조건 3과 A6 완료 기록의 해당 줄.
- **구현 대기(별도 승인 후):** `EffectTool`을 동작 단위 `{supported, retention_ms}`로, 기준 시각 컬럼(스키마 변경), 재전송 전 만료 확인, 어댑터 계약 시험. 이 스파이크는 스키마·시험·코드를 건드리지 않았다.
