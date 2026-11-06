# 화면에서 바로 결정하고, 위임 안의 결정은 AI가 맡는다

상태: 트랙 A·B·C 구현됨 (2026-11-05; 남은 일은 아래 §7). 결정 기록은 [ADR-0016](../adr/0016-decision-delegation.md)(accepted 2026-11-06, D-B1 채택). 오너 결정이 필요한 곳은 §6에 기본값과 함께 모았다. 기본값으로 진행하고 오너가 나중에 바꾼다.

## 0. 문제

오너가 읽기 전용 검토 화면([review-web](../operations/review-web.md))을 보고 남긴 의견(2026-11-05):
1. 결정 명령어(`node apps/daemon/src/approve.ts reject task … --comment "사유" && …`)는 사용자에게 필요 없다.
2. 관련 이력이 짧게 요약되고 링크가 있어야 한다.
3. 거절할 때 이유를 붙일 수 있으면 좋겠다(필수 아님).
4. 사용자에게 결정을 너무 많이 요구하지 않는 것이 기본 방향이다. 핵심 의제이거나 조직 관리 AI의 권한을 벗어나는 경우만 그 권한이 있는 사용자나 AI가 판단한다.

1~3은 화면 문제(§2, 트랙 A)이고, 4는 승인 모델 문제(§3, 트랙 B)다.

## 1. 지금 (코드 기준)

| 항목 | 지금 | 위치 |
|---|---|---|
| 화면 | 읽기 전용. DB를 `readOnly`로 열고 쓰기 메서드를 막는 껍질을 씌운다. GET·HEAD만 받고 CSP는 `form-action 'none'`. 카드마다 승인 CLI 명령을 글자로 찍는다 | `apps/daemon/src/review-web/{server,read-only-db,decisions,html}.ts` |
| 화면의 엔진 사용 | 읽기 전용 DB 위에 `ApprovalEngine`을 하나 만들어 `list`·`show`만 부른다. 행위자는 "DB의 첫 human" | `review-web/context.ts` |
| 결정 경로 | 승인 CLI → Unix 소켓(0700 폴더, 0600 소켓) → 데몬의 `ApprovalEngine.handle`. 모든 명령의 첫 단계가 `requireHuman`. 상품·조직·효과 확정 명령도 같은 소켓으로 간다 | `packages/policy/src/{channel,engine}.ts`, `apps/daemon/src/assemble.ts:233-240` |
| 낡은 결정 막기 | `approve`만 해시를 받아 대조한다. `reject`·`cancel`·`request_changes`·`release`는 해시를 받지 않는다. `parseCommand`는 모르는 필드를 무시한다 | `engine.ts:222-232, 693-722` |
| 승인 계산 | `approvalStatus`는 `actor.kind='human'` 행만 센다. 외부 부작용은 `risky_change`(승인자 수·cooldown·TOTP `release`) | `packages/policy/src/approval.ts:60-111` |
| 거부 응답 | `{ok:false, error:<영어 문장>}`. 기계가 읽을 코드가 없다 | `engine.ts:113-125` |
| "조직 관리 AI" | `org-management`는 ADR-0011의 **제안 전용** 역할이다(접근·제안 불가: 정책·승인 엔진). 전이 주체 종류 `org_management`만 있고 Phase B에서도 대화 에이전트는 MVP 밖(Q12). **결정 권한을 가진 AI는 지금 없다** | ADR-0011 §2, `packages/domain/src/state/machine.ts:17`, `docs/plans/phase-b.md` Q12 |

## 2. 설계 A — 화면에서 바로 결정한다

### 2.1 보이는 것
- **명령어를 지운다.** 카드·상세·묶음 어디에도 CLI 명령을 찍지 않는다(`html.ts`의 `command`·`APPROVE_CLI` 제거). CLI는 운영 문서에만 남는다.
- **결정 상자**(상세 화면만): 질문 → 사실 2~3줄 → 이력(§2.2) → 버튼 → 접힌 "자세히".
  - `승인`. 위험 변경이면 버튼 아래 한 줄: "승인 뒤 1시간이 지나면 OTP 확인이 한 번 더 필요합니다".
  - `거절` + 접힌 "이유 남기기"(선택, 500자).
  - `다시 쓰게`(초안 승인 업무만) + 이유 입력(필수, 1~500자 — 엔진 규칙 그대로). 다음 초안 run에 전달되는 건 W13 이후다.
  - 대기 끝난 위험 변경: `OTP 확인` + 6자리 입력(`inputmode=numeric`, `autocomplete=one-time-code`). 대기 중: `취소`.
  - 효과 확정(나갔다/나가지 않았다 — 후자는 OTP), 상품 결정, 실험 승격, 조직 시험 확정도 같은 상자다. 사유가 필수인 명령은 입력이 필수로 보인다.
  - 파일이 필요한 결정(정책 배포 `--file`, 조직 재시험의 평가 계획, 새 역할 slug를 정하는 제안)은 버튼을 두지 않고 "이 결정은 화면에서 할 수 없습니다" 한 줄 + 자세히에 운영 문서 링크.
- 엔진이 거절할 결정은 지금처럼 버튼 대신 이유를 보인다(정책 거부, 가려진 값, 만료, 전송 시작됨).
- 묶음: 버튼 하나가 묶음 안 결정 가능한 업무에 차례로 보낸다(엔진에 묶음 명령은 없다). 결과는 "3건 중 2건 반영, 1건 실패: 내용이 바뀜"처럼 건별로 보인다.

### 2.2 이력 요약 (항목마다 최대 3줄 + 링크)
읽기 전용 질의로 만든다. 첫 화면에 id·해시·상태 코드·ISO 시각·엔진 영어 문장을 내지 않는다.

| 줄 | 내용 | 출처 |
|---|---|---|
| 어떻게 왔나 | "3일 전 주간 루틴이 만듦" / "오너가 직접 만듦" / "앞 업무 결과로 만듦" / "실험 ○○의 업무" | `task.trigger_kind`·`trigger_ref`·`created_at`, `strategy_version_id`, `task_dependency` |
| 앞선 결정 | "다시 쓰게 1번('인사말을 짧게'), 지금 초안이 2번째" / "한 번 거절된 뒤 다시 제안됨" / "실행 2번 중 1번 실패" | `approval`(시각순, 사람 행의 `decision`·`comment`), `effect_draft`(`superseded` 수), `task_run` |
| 링크 | 상세 · 증거 n건 · 관련 업무/상품/실험/조직 제안 · 전송 여부 카드 | 내부 경로만(`/approvals/…`, `/evidence?task=…`, `/products/…`, `/experiments/…`, `/trials/…`, `/effects`) |

- 외부 URL은 **사람이 입력한 값만** 링크로 만든다(`product_repo.remote_url`, `product_environment.url`, http/https만, `rel="noopener noreferrer"`). 에이전트·외부 입력에서 온 URL(증거 `source_url` 등)은 지금처럼 글자로만 보인다(§6 D-A3).
- 카드(첫 화면)에는 이력을 더하지 않는다. 사람이 앞서 거절·다시 쓰게 한 적이 있을 때만 사실 한 줄을 그것으로 바꾼다("이전에 1번 다시 쓰게 함").

### 2.3 쓰기 경로와 보안
화면 프로세스는 **여전히 DB에 쓸 수 없다.** 결정은 CLI와 같은 승인 소켓으로 보내고, 검증·기록은 엔진만 한다.

```
브라우저 ──POST /decide (폼)──▶ review-web (127.0.0.1, DB readOnly)
                                  │ CSRF·nonce·속도 확인
                                  └─ sendApprovalRequest(소켓) ─▶ 데몬 ApprovalEngine (유일한 쓰기·검증 주체)
브라우저 ◀──303 /result/<무작위 id>──┘
```

| 위협 | 대책 |
|---|---|
| 다른 사이트가 결정을 보내게 함(CSRF) | ① 쿠키 `SameSite=Strict`(지금 그대로). ② `POST`에서 `Origin`이 `http://127.0.0.1:<포트>` 또는 `http://localhost:<포트>`이고 Host와 같아야 한다. `Origin`이 없으면 거부. `Sec-Fetch-Site`가 있으면 `same-origin`이어야 한다. ③ 폼마다 nonce = HMAC-SHA256(세션 키, `action|kind|id|hash|발급 시각`). 세션 키는 시작 토큰에서 유도하고 메모리에만 있다. 30분 만료, 한 번 쓰면 끝(메모리 집합). ④ `Content-Type: application/x-www-form-urlencoded`만, 본문 16KB 이하, 읽기 시간 제한. ⑤ CSP `form-action 'self'`(지금 `'none'`). 스크립트는 여전히 없다 |
| 본 것과 다른 내용에 결정(낡은 화면) | 폼에 `show`의 해시를 싣는다. `approve`는 엔진이 이미 대조한다. `reject`·`cancel`·`request_changes`·`release`는 새 필드 `expected_hash`를 엔진이 대조한다(트랙 B). 트랙 B 전에도 화면은 보내기 직전에 읽기 전용 `show`로 해시를 다시 확인한다(틈은 작게 남는다) |
| 누가 결정했나 | 쓰기는 시작 인자 `--actor`(또는 `AOT_ACTOR`)가 있을 때만 켠다. "DB의 첫 human"으로 쓰지 않는다. 시작 때 소켓으로 `whoami`를 보내 사람인지 확인하고, 실패하면 읽기 전용으로 띄우고 첫 줄에 알린다. 소켓 경로는 CLI와 같은 기본값(`--socket`). 화면은 CLI가 이미 쓰는 신뢰(같은 OS 사용자 + 소켓 권한)를 넘는 권한을 만들지 않는다. 대신 브라우저라는 새 표면이 생기므로 위 CSRF 대책을 둔다. 요청에 `via:'web'`을 실어 감사에 남긴다(자기 신고 값, 감사용) |
| TOTP | 정책이 재인증을 요구할 때만(`release`, 효과 `failed` 확정) 입력을 받는다. 값은 소켓 요청에만 싣고 로그·결과 페이지·리다이렉트 주소에 남기지 않는다. 틀린 코드 잠금은 엔진의 기존 잠금(`TOTP_LOCKOUT_MS`)을 쓴다 |
| 반복·폭주 | 화면 프로세스 전체 결정 요청 분당 20건, OTP 입력 5분에 5번. 넘으면 429 안내 |
| 결과 노출 | PRG: POST 뒤 `/result/<무작위 id>`로 303. 결과는 메모리에 10분, 비밀·TOTP 없음 |

### 2.4 결정이 실패하면
결과 화면도 같은 규칙이다: 결론 한 줄 → 다음에 할 일 → 접힌 자세히(엔진 원문).

| 경우 | 첫 줄 | 다음에 할 일 |
|---|---|---|
| 내용이 바뀜(해시 불일치) | "결정이 반영되지 않았습니다. 그 사이 내용이 바뀌었습니다." | "새 내용 보기"(상세 다시 열기) |
| 이미 처리됨/상태 다름 | "이미 다른 결정이 났습니다." | 홈으로 |
| 전송이 시작됨 | "이미 보내기 시작해 거절·다시 쓰게를 할 수 없습니다." | 전송 여부 카드 |
| OTP 틀림/잠김 | "OTP 코드가 맞지 않습니다." / "잠시 뒤 다시 하세요(5분)." | 같은 폼 다시(입력 비움) |
| 데몬 꺼짐(연결 실패) | "데몬이 꺼져 있어 보내지 못했습니다. 아무것도 바뀌지 않았습니다." | 데몬 켜고 다시 |
| 응답 없음(시간 초과) | "결과를 확인하지 못했습니다." | "상태 다시 보기". 자동 재시도 없음 |
| 그 밖 | "처리하지 못했습니다." | 상세 다시 열기, 자세히에 엔진 원문 |

매핑은 엔진 응답의 `code`(트랙 B가 더한다)로 한다. 코드가 없으면 "그 밖"이다. 모든 실패 화면에 "아무것도 바뀌지 않았습니다"는 **연결 실패일 때만** 쓴다(시간 초과는 모른다).

## 3. 설계 B — 위임: 사람은 적게, 위임 밖만 결정한다

### 3.1 모델
- **위임(mandate)은 정책 안에 둔다.** 정책 YAML의 새 선택 섹션 `delegation`. 정책은 사람 승인으로만 배포되고 위임을 더하거나 넓히는 변경은 위험 변경(현재 정책의 `risky_change`, TOTP 포함)이다. 그래서 "사람이 정한 권한 안에서만 AI가 결정한다"가 정책 배포 절차로 보장된다.
- **위임받는 AI는 `org-management`가 아니다.** ADR-0011이 `org-management`를 제안 전용으로 두고 승인 엔진에서 떼어 놓았다. 제안하는 주체가 승인까지 하면 그 분리가 무너진다. 새 에이전트 행위자 `approval-delegate`(역할 `approval-delegate@v1`, 도구 없음)를 시드로 둔다. 이름에 `approv`가 들어 있어 조직 제안으로는 흉내 낼 수 없다(`org.ts` `FORBIDDEN_WORDS`). 오너가 말한 "조직의 관리 AI"는 이 행위자다.
- **AI는 좁힐 수만 있다.** 엔진이 위임 조건(§3.3)을 결정론적으로 먼저 확인하고(적격), 적격일 때만 AI가 `승인`·`다시 쓰게`·`사람에게 넘김` 중 하나를 고른다. AI 출력은 신뢰하지 않는 데이터다. 최악의 경우(AI가 무엇이든 승인) 결과는 "사람이 직접 쓴 상시 승인 규칙"과 같고, 그 범위는 위임 한도가 정한다.
- **AI는 소켓에 닿지 않는다.** 소켓은 계속 사람 전용이다(`requireHuman` 그대로). 위임 결정은 데몬 안의 호스트 주기(`delegate-cycle`)가 AI run의 출력을 받아 엔진의 새 메서드 `delegateDecide`를 프로세스 안에서 부른다. 이 메서드는 소켓 명령 목록(`CMDS`)에 없다.

### 3.2 정책 형식 (ADR-0013 Amendment로 적는다)
```yaml
delegation:
  mandates:
    - id: routine-customer-mail            # 정책 안에서 유일
      holder: approval-delegate            # 행위자 id. v1은 에이전트 행위자 하나
      subjects: [task]                     # v1: 초안 승인 업무만
      match:
        actions: ['mail.send']             # (도구.action), 업무의 모든 external_effect 초안이 여기 들어야 한다
        targets: ['mailbox:example']       # 패턴(`*` 와일드카드)
        scopes: [customer]                 # public 은 넣을 수 없다(검증 거부)
        recipients: { kind: known_contacts }   # 필수(D-B11). 또는 { kind: domains, domains: [example.com] }. 무료 메일 도메인은 거부
      limits:
        max_per_day: 5                     # 이 위임으로 한 승인 수(24시간 창)
        max_drafts_per_task: 1
        max_recipients_per_draft: 1
        max_payload_bytes: 20000
        max_task_usd: 2                    # 업무 cost_budget 상한
        max_rewrites_per_task: 1           # AI의 다시 쓰게 횟수, 넘으면 사람에게
        max_review_usd_per_day: 1          # 위임 검토 run 비용
      cooldown: 1h                         # 승인 뒤 전송까지. 이 동안 사람이 취소할 수 있다. risky_change.cooldown 이상
      guidance: '정기 안내 메일만. 가격·계약·사과 문구가 있으면 넘긴다'   # 사람이 쓴 판단 기준, 500자
      expires: 2027-01-31                  # 필수. 배포 승인 시각부터 90일 이내
```
- 검증: 모르는 키 거부, `risky_change.min_approvers`가 1이 아니면 섹션 자체를 거부(위임 승인이 승인자 한 명 몫을 채우는 규칙만 정의한다), `scopes`에 `public` 거부, 한도는 양수 정수/양수.
- 변경 등급(`change.ts`): 섹션 신설, 위임 추가, `match` 확대, 한도 상향, `cooldown` 단축, `expires` 연장, `guidance` 변경은 **위험 변경**. 위임 삭제, 한도 하향, 섹션 삭제는 일반 변경. 키가 없는 문서는 정규화 결과가 같아 정책 버전이 바뀌지 않는다.

### 3.3 언제 AI가 결정할 수 있나 (적격 — 모두 참이어야 한다)
`packages/policy/src/delegation.ts`의 순수 함수 `delegationEligibility(tx, policy, task, now)`. 하나라도 거짓이면 사람에게 남고, 거짓인 첫 조건이 "사람에게 온 이유" 한 줄이 된다.
1. 위임 섹션이 있고 전체 정지·그 위임의 정지/철회가 없고 만료 전이다.
2. 업무가 `needs_review`이고 초안 승인 업무이며 제안된 초안이 1건 이상, 모두 `match` 안이다(도구·action·대상·범위). 정책 판정이 `require_approval`이다(`deny`는 위임으로도 못 바꾼다).
3. 초안이 모두: 만료 전, `masked_paths` 비어 있음, `send_state='none'`, **`influenced_by_external_input=false`**(외부 입력이 쓴 초안은 항상 사람), 받는 사람 수·크기가 한도 안(`messagePreviewOf`).
4. 사람이 이 업무에 결정한 적이 없다(거절·다시 쓰게·취소 행이 있으면 그 뒤로 계속 사람).
5. 요청자(`taskRequester`)가 위임 보유자가 아니다.
6. 24시간 창의 이 위임 승인 수 < `max_per_day`, 업무 `cost_budget` ≤ `max_task_usd`, 오늘 위임 검토 비용 < `max_review_usd_per_day`.

**항상 사람(코드 상수, 정책으로 못 바꾼다):** 정책 배포(위임 변경 포함), 조직 변경 제안 전부와 시험 확정, 실험 전략 승인·승격, 상품 등록 결정, 효과 확정(`resolve-effect`), 게시(`publication`), 초안이 아닌 범위 승인 업무(전화·`customer` 읽기 등), 영향에 `delete`가 있는 업무, 위 적격 3·4번에 걸린 업무, 위임 정지 해제. v1의 `subjects`는 `task`만 받으므로 나머지는 형식상으로도 위임할 수 없다.

### 3.4 기록과 승인 계산
- `approval`에 열 두 개: `mandate_id`(위임 승인일 때만), `via`(`cli|web|delegate`). 위임 승인 행: `decided_by='approval-delegate'`, `subject_hash` = **그 순간 `show`의 해시(초안 목록 포함)**, `comment` = AI 사유(200자), `mandate_id`. ADR-0015의 "승인한 것 = 나간 것"은 같은 해시·같은 전송기(`host:dispatch`) 경로라 그대로 성립한다.
- 새 표 `delegate_review`(append-only): 업무·해시·위임·AI 판정(`approve|request_changes|escalate`)·사유·run·엔진 결과(`recorded` 또는 거부 코드)·시각. 사람에게 넘긴 이유와 AI 검토 비용 집계가 여기서 나온다.
- 새 표 `delegation_control`(append-only): `pause|resume|revoke`, 대상 위임(없으면 전체), 사람, 사유, 시각. 정지·철회는 **강화**라 정책 배포 없이 런타임에 한다. 해제(`resume`)는 사람 + TOTP. 철회는 다시 켤 수 없다(정책에서 지우거나 새 id로 다시 위험 변경).
- `approvalStatus`: `actor.kind='agent'` 행은 `mandate_id`가 있고 그 위임이 **지금** 정책에 있고, 정지·철회·만료가 아니고, 행위자가 위임 보유자일 때만 센다. 위임 승인이 정족수를 채우면 cooldown은 위임의 `cooldown`, 재인증은 요구하지 않는다(사람 재인증은 위임 배포 때 했다). 정족수가 끝나면 데몬 주기가 `releaseDelegated`로 `needs_review → queued`(정지 여부를 다시 확인).
- `beforeRun`·`beforeEffect`의 재확인은 같은 `approvalStatus`를 쓰므로 정지·철회·정책 변경(업무 해시에 정책 버전이 있다) 즉시 위임 승인이 효력을 잃는다.
- **사람이 위임 승인을 취소하면**(cooldown 중 `cancel`) 그 위임을 자동으로 정지한다(`delegation_control` `pause`, 사유 "사람이 위임 결정을 취소함"). 해제는 사람 + TOTP.
- AI의 `다시 쓰게`는 `changes_requested` 행(행위자 AI, `mandate_id`)으로 남고, 적격 4번(사람 결정 이력)에는 들어가지 않지만 `max_rewrites_per_task`에 센다.

### 3.5 위임 검토 run
- 데몬 주기 `delegate-cycle`: 적격 업무를 찾아 `approval-delegate` 역할 run을 연다(도구 없음, 원장 없음, 출력 형식 `{verdict, hash, reason}`). 입력: 위임의 `guidance`·한도, 초안 payload(외부 데이터 영역, 가린 값), 이력 요약.
- 출력 검사: 형식, `hash` = 지금 해시, `verdict` 셋 중 하나. 아니면 `escalate`(이유 "AI 응답 형식 오류")로 기록한다. 그 뒤 `delegateDecide`가 같은 트랜잭션에서 적격을 다시 확인하고 기록한다.
- 같은 업무·해시는 한 번만 검토한다(`delegate_review`에 같은 해시가 있으면 건너뛴다).

### 3.6 사람이 나중에 보는 것
결정이 아니라 **요약**이다(트랙 C).
- 홈 첫 줄 아래 한 줄: "AI가 지난 24시간에 3건 처리함(메일 3통). 1건은 1시간 안에 나갑니다 — 보기".
- `/delegated`: 건마다 "무엇을 · 누구에게 · 언제 나감 · AI 사유" 한 줄과 cooldown 중이면 `취소` 버튼. 위에 `위임 멈추기` 버튼(전체 정지, TOTP 없음). 7일 보관.
- 사람에게 온 카드에는 사실 한 줄: "AI가 넘긴 이유: 받는 사람 3명 — 위임 한도 1명".

## 4. 보안 분석 요약

| 위험 | 막는 것 | 남는 위험 |
|---|---|---|
| AI가 범위 밖을 승인 | 적격 함수가 결정론적으로 먼저 확인, 같은 트랜잭션에서 다시 확인. 범위는 사람이 TOTP로 배포한 정책 | 범위 **안**의 잘못된 승인(사람이 범위를 정한 만큼). cooldown 중 요약·취소, 취소 시 자동 정지 |
| 초안에 심은 지시로 AI 설득 | 외부 입력 영향 초안은 항상 사람. 받는 사람·크기 한도. AI 출력은 데이터 | 영향 표시가 없는 경로(에이전트 자체 오작동)로 쓴 범위 안 문구 |
| AI가 승인 경로를 얻음 | 소켓은 사람 전용 그대로. `delegateDecide`는 프로세스 안 호출만, 행위자는 위임 보유자로 고정 | Q26(에이전트 별도 UID)이 전제인 점은 지금과 같다 |
| 위임이 슬그머니 넓어짐 | 넓히는 변경은 전부 위험 변경, 만료 90일 필수, `min_approvers≥2`면 위임 금지 | — |
| 브라우저 CSRF·낡은 화면 | §2.3 | 같은 OS 사용자 프로세스는 소켓을 직접 쓸 수 있다(지금과 같음) |
| 위임 폭주 | 일일 수·비용 한도, 정지 버튼, 철회 | 한도 안의 반복 |

## 5. 작업 분할 (두 트랙 병렬 + 뒤에 C)

**공유 계약(먼저 고정, 두 트랙이 같이 따른다):**
- 소켓 요청 선택 필드 `expected_hash`(`reject`·`cancel`·`request_changes`·`release`), `via`(`'cli'|'web'`). 엔진은 `expected_hash`가 있으면 지금 해시와 다를 때 거부한다. 모르는 필드는 지금도 무시되므로 A가 먼저 보내도 깨지지 않는다.
- 거부 응답 `{ok:false, error, code?}`. 코드: `hash_mismatch`, `wrong_state`, `send_started`, `masked`, `expired`, `policy_denied`, `self_approval`, `cooldown`, `reauth_required`, `reauth_failed`, `reauth_locked`, `not_human`, `bad_request`.

### 트랙 A — 화면 (파일 소유: `apps/daemon/src/review-web.ts`, `apps/daemon/src/review-web/**`, `test/unit/review-web*.test.ts`, `test/integration/review-web*.test.ts`, `docs/operations/review-web.md`)
| # | 단계 | 파일 |
|---|---|---|
| A1 | 시작 인자 `--actor`·`--socket`(CLI와 같은 기본값). 쓰기 켜짐 여부를 문맥에 둔다. 시작 때 `whoami` | `review-web/config.ts`, `context.ts`, `review-web.ts` |
| A2 | 명령어 표시 제거, 결정 상자 폼(버튼·이유·OTP), 실패·결과 화면 | `decisions.ts`, `html.ts`, `pages.ts` |
| A3 | `POST /decide`: Origin·Sec-Fetch-Site·Content-Type·크기·nonce·속도 확인 → 직전 `show` 해시 확인 → 소켓 전송(`expected_hash`, `via:'web'`) → 303 `/result/<id>`. CSP `form-action 'self'` | `server.ts`, 새 `review-web/decide.ts`, 새 `review-web/nonce.ts` |
| A4 | 이력 요약 3줄 + 링크 | 새 `review-web/history.ts`, `decisions.ts`, `pages.ts` |
| A5 | 문서: 보안 모델의 "쓰기 없음"을 "DB 쓰기 없음, 결정은 소켓"으로, 실행 인자, 실패 화면 | `docs/operations/review-web.md` |

시험: 명령어 문자열이 어떤 화면에도 없음, POST 거부(Origin 없음/다름, `Sec-Fetch-Site: cross-site`, nonce 없음·재사용·만료·다른 대상, 틀린 Content-Type, 큰 본문, 속도 초과), `--actor` 없으면 POST 405, 가짜 소켓으로 요청 모양(`expected_hash`·`via`·TOTP는 로그·결과에 없음), 실패 매핑(코드별·연결 실패·시간 초과), 이력 줄(거절 이력·초안 회차·트리거 종류), 사람이 입력하지 않은 외부 URL은 링크가 아님, DB 쓰기 껍질 그대로.
완료: 위 시험 통과, `npm test` 통과, 화면에 CLI 명령이 없다, 엔진 없이(가짜 소켓) 모든 결정 흐름이 시험된다.

### 트랙 B — 엔진·정책 위임 (파일 소유: `packages/**`, `apps/daemon/src/approve.ts`, `apps/daemon/src/assemble.ts`, `apps/daemon/src/main.ts`, `apps/daemon/src/cycle.ts`, 새 `apps/daemon/src/delegate-cycle.ts`, `migrations/**`, `docs/schema/**`, `policies/**`, `test/unit/policy-*.test.ts`·새 `test/unit/policy-delegation*.test.ts`, `test/integration/approval-channel.test.ts`·새 `test/integration/daemon-delegation.test.ts`, ADR-0006·0013·0015와 `docs/security/trust-boundaries.md`의 Amendment)
| # | 단계 | 파일 |
|---|---|---|
| B1 | 엔진 공유 계약: `expected_hash` 대조, 거부 `code`, `via` 기록 | `packages/policy/src/engine.ts` |
| B2 | 스키마: `approval.mandate_id`·`via`, `delegate_review`, `delegation_control`. 저장소 관례대로 `0001_init.sql`과 `schema.sql`에 더한다(배포된 인스턴스가 생기면 그때부터 새 번호 파일) | `migrations/0001_init.sql`, `docs/schema/schema.sql`, `packages/domain/src/**` 행 타입 |
| B3 | 정책 `delegation` 섹션: 검증·정규화·변경 등급, 배포 때 만료 90일 확인 | `packages/policy/src/{document,change}.ts`, `engine.ts`(`#approvePolicy`) |
| B4 | 적격 함수와 "항상 사람" 상수 | 새 `packages/policy/src/delegation.ts` |
| B5 | 승인 계산·재확인: 위임 행 세기, 위임 cooldown, 재인증 면제, 정지·철회 확인 | `approval.ts`, `gate.ts` |
| B6 | 엔진: `delegateDecide`·`releaseDelegated`(소켓 밖), 사람 명령 `delegation status|pause|resume(TOTP)|revoke`, 위임 승인 취소 시 자동 정지. 해제 전이 `needs_review → queued`는 주체 `policy` + 위임 승인 참조로 허용표에 더한다 | `engine.ts`, `packages/domain/src/state/machine.ts`, `docs/schema/state-machines.md` |
| B7 | 시드: `approval-delegate` 행위자·역할(도구 없음) | `packages/domain/src/seed.ts` |
| B8 | 데몬 주기: 적격 업무 → 검토 run → 출력 검사 → `delegateDecide`, 비용 한도, cooldown 뒤 해제 | 새 `delegate-cycle.ts`, `cycle.ts`, `assemble.ts`, `main.ts` |
| B9 | CLI: `delegation …` 하위 명령, 요청에 `via:'cli'` | `approve.ts` |
| B10 | ADR Amendment 문구(ADR-0016 "고쳐야 할 문구") 반영 | `docs/adr/0006·0013·0015`, `docs/security/trust-boundaries.md` |

시험: 정책 검증(모르는 키, `public`, `min_approvers≥2`, 만료 누락·90일 초과), 변경 등급 표, 적격 조건 하나씩 거짓일 때 사람에게 남음과 이유, 위임 행이 지금 정책에 없으면/정지/철회/만료면 세지 않음, 소켓으로 `delegateDecide` 모양 요청 거부, 에이전트 행위자의 소켓 요청 거부(기존), 위임 승인 → cooldown → 해제 → `host:dispatch`가 승인 해시의 초안을 그대로 보냄(통합), cooldown 중 사람 취소 → 전송 없음 + 자동 정지, 정지 해제에 TOTP, 정책 바뀌면 위임 승인 무효, 일일 한도 넘으면 사람, 외부 입력 영향 초안은 사람, `expected_hash` 불일치 거부와 `code`.
완료: 시험 통과, 위임 섹션 없는 정책·DB에서 기존 시험이 모두 그대로 통과(동작·해시 불변), ADR Amendment 반영.

### 트랙 C — 둘이 끝난 뒤 (파일 소유: `review-web/decisions.ts`·`pages.ts`·`server.ts`, 새 `review-web/delegation.ts`, 새 `test/integration/review-web-decide.test.ts`, `docs/operations/review-web.md`의 위임 절)
| # | 단계 |
|---|---|
| C1 | 홈 요약 한 줄, `/delegated`(취소·위임 멈추기 버튼), 카드의 "AI가 넘긴 이유" 줄. 읽기는 `delegate_review`·`approval.mandate_id` |
| C2 | 실패 매핑을 엔진 `code` 기준으로 확정, 패턴 매핑 제거 |
| C3 | 실제 엔진 + 소켓 통합 시험: 낡은 해시 거부, 화면 결정 → 엔진 기록(`via='web'`), 위임 승인 취소 → 정지 표시 |

완료: 통합 시험 통과, 오너가 화면만으로 승인·거절·다시 쓰게·취소·정지를 할 수 있다.

## 6. 오너 결정 (기본값으로 진행, 나중에 바꿀 수 있다)

| id | 질문 | 기본값 | 다른 선택 |
|---|---|---|---|
| D-A1 | 화면 결정에 TOTP를 늘 요구할까 | 정책이 요구할 때만(`release`·효과 `failed`) | 화면의 모든 승인에 TOTP |
| D-A2 | 파일이 필요한 결정(정책 배포·재시험·새 역할 제안)을 화면에서 | 하지 않는다(CLI) | 업로드·입력 폼 |
| D-A3 | 외부 URL 링크 | 사람이 입력한 URL만 링크, 에이전트·외부 입력 URL은 글자 | 모두 링크 / 모두 글자 |
| D-B1 (결정 2026-11-06) | ADR-0006 "에이전트 actor는 어떤 경우에도 승인할 수 없다"를 고칠까 | **오너 결정: 고친다.** 위임 안의 초안 승인 업무만 예외(ADR-0016) | 고치지 않는다(트랙 B 중단, A만) |
| D-B2 | 위임 승인에 사람 재인증 | 건마다 없음. 위임 배포 때 TOTP + 건마다 cooldown(기본 1h) 동안 취소 가능 | 건마다 사람 TOTP(사실상 위임 아님) |
| D-B3 | v1 위임 대상 | 초안 승인 업무(`task`)만 | 사람 1인 승인 대상(`customer` 읽기, 내부 게시, 실험) 추가 |
| D-B4 | AI가 할 수 있는 판정 | 승인·다시 쓰게(업무당 1번)·사람에게 넘김. 거절은 없음 | 거절 허용 |
| D-B5 | 사람이 위임 승인을 취소·거절·변경 요청하면 | 그 위임 자동 정지(해제는 TOTP) | 알리기만 |
| D-B6 | 위임 보유자 | 에이전트 `approval-delegate` 하나. 사람·역할 보유자, AI→AI 상위 넘김은 v2 | 이름 있는 사람·역할에게 넘김 경로 |
| D-B7 | `min_approvers≥2`일 때 | 위임 금지(검증 거부) | 위임이 한 명 몫 |
| D-B8 | 위임 만료 상한 | 90일 | 30일 / 무기한 |
| D-B9 | 처리 요약 보관 | 7일 | 30일 |
| D-B10 | 정지·철회를 정책 배포 없이 런타임에 | 허용(강화 방향만). 해제는 TOTP | 정책 변경으로만 |
| D-B11 (결정 2026-11-06) | 위임에 받는 사람 한도를 둘까 | **오너 결정: 둔다. 모든 위임이 받는 사람 규칙을 선언해야 한다**(없으면 정책 파싱·배포 거부). `match.recipients: { kind: known_contacts }`(권장 기본) 또는 `{ kind: domains, domains: [...] }`(기업 고객용, 소문자·정확히 같은 도메인만, 와일드카드 없음, 공개 무료 메일 도메인은 거부). to·cc·bcc·reply_to 의 모든 주소를 정규화해 규칙과 `contact` 표에 대조하고, 모르거나 읽을 수 없거나 수신 거부(suppressed)된 주소가 하나라도 있으면 거절이 아니라 **사람에게 넘긴다**("처음 보는 받는 사람 1명"). 코드의 결정론 검사이며 AI 출력은 못 바꾼다 | 규칙 없이 `max_recipients_per_draft` 만 / 도메인만 |

## 7. 구현 기록
- 트랙 A(화면 결정), 트랙 B(엔진·정책 위임), 트랙 C(요약·취소·정지·실패 코드 매핑·실제 엔진 통합 시험)를 구현했다. 자세한 내용은 [ADR-0016](../adr/0016-decision-delegation.md)의 구현 기록과 [review-web.md](../operations/review-web.md).
- 트랙 C에서 설계와 달라진 곳: 홈에는 한 줄이 아니라 "AI가 처리함" 요약(최대 3건, 이유 한 줄과 취소 버튼)을 둔다. 위임 멈추기·다시 켜기는 `/delegated` 위쪽에 있고 다시 켜기는 OTP 입력을 받는다. `취소`는 엔진이 위임을 자동 정지하므로 버튼 아래에 그 사실을 적는다. 실험 승격·거절도 `expected_hash`를 대조한다(트랙 B가 남긴 구멍).
- 남은 일: 실제 AI 검토자 구현(`DelegateReviewer` 포트만 있다), 위임 철회·정책 배포의 화면 지원(D-A2), 위임 처리 요약의 보관 기간 설정(지금 7일 고정).

## 구현 기록 — 검토 반영 (2026-11-05)
검토에서 확인된 여섯 가지를 고쳤다.
1. **승인하는 사람이 나가는 내용을 전부 본다.** 초안 상세·묶음 상세는 받는 사람·참조·숨은 참조의 정확한 주소와 payload 의 모든 필드(`html` 소스 글, `reply_to`, 헤더, 첨부 정보, 모르는 키)를 결정하기 상자 위에 그대로 보인다. 다 보여 줄 수 없는 필드(5만 자 초과, 글이 아닌 값, 비밀 가림)가 있으면 승인 버튼 없이 `다시 쓰게 할까요?` 만 묻는다. 자르지 않는다. CLI `show` 는 원래 payload 전체를 JSON 으로 찍으므로(비밀 모양만 가림, `masked_paths` 포함) 같은 틈이 없다 — 시험으로 고정했다. (ADR-0015 D10 "화면에는 가린 주소" 는 이 변경으로 바뀌었다: 화면이 로컬·쿠키 보호이므로 정확한 주소를 보인다. 홈 카드에는 여전히 주소를 싣지 않는다.)
2. **정책 제안 카드가 모든 섹션을 비교한다.** `delegation`·`phone`·기억 만료까지 보고, `classifyChange` 이유를 한국어로 옮겨 첫 줄에 둔다.
3. **사람의 거절·변경 요청도 위임을 멈춘다**(엔진 `#reject`·`#requestChanges`, 응답 `delegation_paused`). 위임 승인이었던 업무의 버튼에 그 사실을 적는다.
4. **위임을 추가·확대하는 정책 변경은 항상 TOTP 로 배포한다**(지금 정책의 `reauth_before_effect` 와 무관, `policyApprovalParams`).
5. **stub 검토자는 데몬 설정으로 읽히지 않는다**(`allowStub` 플래그, 시험 전용).
6. 시험: 위임 시험의 검토 순서 의존(같은 `updated_at` 이면 uuid 순)을 시각을 못 박아 없앴다.

## 구현 기록 — 받는 사람 규칙 (D-B11, 2026-11-06)
- **정책**: `delegation.mandates[].match.recipients` 필수. `known_contacts` 또는 `domains`(소문자 정규화, 정확히 같은 도메인만, `*`·하위 도메인·`@`·IDN 거부, 공개 무료 메일 도메인 코드 상수 `FREE_MAIL_DOMAINS` 거부). 규칙을 `domains`↔`known_contacts` 로 바꾸거나 도메인을 더하면 위험 변경(TOTP 배포). 규칙 없는 옛 위임 정책은 이제 배포할 수 없다(위임은 꺼져 있던 기능이라 영향 없음).
- **적격**(`packages/policy/src/delegation.ts` `recipientRuleViolation`): 초안마다 to/cc/bcc/`reply_to`(헤더의 Reply-To 포함)를 `normalizeAddress`(앞뒤 공백, 소문자, 표시 이름 제거, 엄격 파싱 — 주소 둘 이상·코멘트·비 ASCII·표시 이름 속 `@` 는 읽을 수 없음)로 정규화해 센다. 모르는 주소·읽을 수 없는 주소는 모르는 것, `suppressed` 는 규칙 종류와 상관없이 막는다. 실패 코드 `recipient_rule`, 이유는 "처음 보는 받는 사람 N명" 등 한국어 한 줄. 엔진이 기록 트랜잭션에서 적격을 다시 확인하므로 AI 출력이 이 검사를 바꿀 수 없다. cooldown 동안 연락처가 수신 거부로 바뀌면 `releaseDelegated` 가 내보내지 않고 사람에게 넘긴 이유를 한 번 남긴다.
- **연락처 표** `contact`(주소, 이름, `active|suppressed`, 추가한 사람·시각, 정지한 사람·시각): 승인 소켓 `contacts add|import|suppress|list`(`apps/daemon/src/contacts.ts`)만 쓴다. 사람 행위자만, 에이전트·위임 보유자는 `not_human`, 검토 화면은 읽기 전용 DB, 위임 보유자 경로(`delegateDecide`)에는 쓰기가 없다. 추가·일괄·정지는 `event(source='contacts')` 로 감사한다. `suppress` 는 TOTP 없이 즉시, 되돌리는 경로는 v1 에 없다(정지된 주소는 add·import 가 건드리지 못한다). import 는 CSV 또는 줄마다 하나, 잘못된 줄이 하나라도 있으면 아무것도 넣지 않는다.
- **화면**: 정책 카드 첫 줄 `AI 위임 추가: …, 등록된 고객에게만, 하루 최대 20건`, 규칙 변경은 `받는 사람 규칙 변경`. 넘긴 카드는 기존 "AI가 넘긴 이유" 줄에 위 이유가 나온다. 화면에 CLI 명령은 없다.
- **한계**: 같은 내용(해시)으로 이미 사람에게 넘긴 업무는 연락처를 나중에 넣어도 AI가 다시 검토하지 않는다(사람이 정하거나 다시 쓰게). 연락처 관리 화면은 아직 없다(CLI 만, D-A2 와 같은 이유).
