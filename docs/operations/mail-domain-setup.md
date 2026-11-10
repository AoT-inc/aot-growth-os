# 메일 보내기 준비 (보내는 도메인 설정)

설계: [plans/mail-tool](../plans/mail-tool.md), 결정: [ADR-0017](../adr/0017-mail-tool.md).

## 먼저 할 일 (요약)

1. **보낼 도메인을 정한다.** 회사 도메인(예: `example.com`) 또는 메일 전용 하위 도메인(예: `mail.example.com`). 무료 메일(gmail.com 등)은 쓸 수 없다.
2. **메일 업체의 SMTP 제출 계정을 만든다.** 어느 업체든 된다(업체에 묶이지 않는다). 받을 것: 서버 주소, 포트(587 또는 465), 사용자 이름, 비밀번호.
3. **DNS 에 SPF·DKIM·DMARC 를 넣는다** (아래 체크리스트). 업체 화면이 DKIM 값을 준다.
4. **수신 거부 메일함을 만든다** (예: `unsubscribe@example.com`). 여기로 온 요청은 사람이 연락처에서 수신 거부로 바꾼다(§4).
5. **데몬 설정에 `mail` 을 넣고, 비밀번호는 환경 변수로만 준다.**
6. 자기 주소로 시험 메일을 한 통 보내 받은 메일의 인증 결과가 모두 `pass` 인지 본다.

여기까지 끝나기 전에는 데몬에 `mail` 설정을 넣지 않는다. 설정이 없으면 메일 도구는 조립되지 않는다.

---

## 1. DNS 체크리스트

`example.com` 과 업체 값은 자리 표시다. 실제 값은 업체 안내를 따른다.

| 항목 | 레코드 | 예시 값 | 확인 |
|---|---|---|---|
| SPF | `example.com` TXT | `v=spf1 include:<업체가 준 값> -all` | 도메인당 SPF 레코드는 **하나만**. 이미 있으면 `include:` 만 더한다. DNS 조회 10회 한도 |
| DKIM | `<선택자>._domainkey.example.com` TXT 또는 CNAME | 업체가 준 공개 키(2048비트 이상) | 업체 화면에서 "확인됨" |
| DMARC | `_dmarc.example.com` TXT | 처음: `v=DMARC1; p=none; rua=mailto:dmarc@example.com` | 2~4주 보고서를 본 뒤 `p=quarantine` → `p=reject` |
| 반송 주소(선택) | 업체 안내(보통 `bounce.example.com` CNAME/MX) | — | envelope-from 도메인이 보내는 도메인과 정렬(DMARC SPF 정렬) |
| 역방향 DNS | 업체 몫 | — | 공유 IP 업체면 할 일 없음 |

- **정렬:** DMARC 는 `From` 도메인과 DKIM 서명 도메인(`d=`) 또는 SPF 도메인(envelope-from)이 같아야 통과한다. 데몬 설정의 보내는 사람 주소 도메인 = DKIM 도메인이 되게 업체를 설정한다.
- 하위 도메인으로 보내면 본 도메인의 평판과 분리된다. 처음 시작하는 발송에는 하위 도메인을 권한다.
- 새 도메인은 하루 수십 통부터 천천히 늘린다. 데몬의 하루 상한 기본값(200)이 그 상한이다.

## 2. 데몬 설정

```yaml
mail:
  provider: smtp
  smtp:
    host: smtp.example.com
    port: 587
    security: starttls          # 587 = starttls, 465 = tls. none 은 루프백(로컬 릴레이)만
    username_env: MAIL_SMTP_USERNAME
    password_env: MAIL_SMTP_PASSWORD
  senders:
    support:                    # 명세의 target 이 mail:support 일 때 이 주소로 보낸다
      address: support@example.com
  unsubscribe_mailto: unsubscribe@example.com
  # bounce_address: bounce@example.com   (없으면 보내는 사람 주소)
  # message_id_domain: example.com       (없으면 보내는 사람 도메인)
  # max_per_day: 200
  # min_interval_ms: 1000
```

- 설정 파일에는 **환경 변수의 이름만** 쓴다. 값(비밀번호)은 데몬을 띄우는 환경에만 둔다. 데몬은 시작할 때 값이 없으면 시작하지 않는다.
- 비밀번호는 DB·로그·오류 메시지에 남지 않는다. 업체 계정은 "메일 보내기"만 할 수 있는 최소 권한으로 만든다(업체 관리 API 키를 쓰지 않는다).
- 비밀번호를 바꿀 때: 업체에서 새 값을 만들고 → 환경 변수를 바꾸고 → 데몬을 다시 띄운 뒤 → 옛 값을 업체에서 지운다.
- 업무 명세에서는 `allowed_tools` 에 `{tool: mail_send, operations: [send], scope: customer, impact: external_effect, target: "mail:support"}` 처럼 보내는 사람 키를 밝힌다. 사람이 승인 화면의 "보내는 방법"에서 이것을 본다.

## 3. 보내지는 메일

- 내용은 사람이 승인한 그대로다: 보내는 사람, 받는 사람(1명, 같은 회사 참조 4명까지), 제목, 본문(일반 글).
- 호스트가 더하는 헤더: `Date`, `Message-ID`, MIME 헤더, `List-Unsubscribe: <mailto:수신거부주소?subject=unsubscribe>`, `Auto-Submitted: auto-generated`. 본문에는 아무것도 더하지 않는다.
- 광고성 메일이면 법이 정한 표시(예: 제목의 "(광고)", 본문의 수신 거부 방법·보내는 사람 정보)는 **초안에 들어 있어야 한다.** 호스트가 붙이지 않는다. 승인하는 사람이 확인한다.

## 4. 수신 거부·반송 처리

| 일 | 누가 | 어떻게 |
|---|---|---|
| 수신 거부 요청(수신 거부 메일함, 답장) | 사람 | 승인 CLI 의 연락처 명령(`contacts suppress <주소>`)으로 그 주소를 수신 거부로 바꾼다. 법정 기한 안에 빠르게. (화면 버튼은 아직 없다) |
| 받는 사람 주소 없음(보낼 때 바로 거절, `5.1.x`) | 호스트 자동 | 연락처에 있으면 수신 거부로 바뀌고 기록이 남는다 |
| 나중에 돌아온 반송 메일(반송 주소 메일함) | 사람 | 영구 반송이면 수신 거부로 바꾼다. 일시 반송은 둔다 |
| 스팸 신고(업체 화면) | 사람 | 그 주소를 수신 거부로 바꾼다 |

수신 거부된 주소에는 누가 승인했든 메일이 나가지 않는다. 되돌리는 방법은 지금 없다.

## 5. 문제가 생겼을 때

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| 업무가 "확인 필요", 효과 상태 `unknown` | 메일 서버가 받았는지 응답 전에 연결이 끊겼다 | 업체의 발송 기록에서 `Message-ID` 로 찾는다. 있으면 "보냄", 없으면 "안 보냄"으로 확정한다([recovery](recovery.md)). 자동으로 다시 보내지 않는다 |
| 효과 상태 `failed` | 보내지 않았음이 확실하다(연결·인증 실패, 거절, 수신 거부, 하루 상한) | 원인을 고친 뒤 "다시 쓰게"로 새 초안을 만든다. 같은 초안은 다시 나가지 않는다 |
| 인증 실패가 계속됨 | 비밀번호·사용자 이름이 틀렸거나 계정이 막혔다 | 환경 변수와 업체 계정을 확인한다 |
| 받은 메일이 스팸함으로 감 | SPF·DKIM·DMARC 정렬 문제이거나 새 도메인 평판 | 받은 메일의 인증 결과 헤더를 보고 §1 을 다시 확인한다. 발송량을 줄인다 |
