# PR #17 보안 검토 체크리스트 (기반 PR #16 포함)

검토자용. 결론부터, 코드 줄 번호는 `e293eb0` 기준이다. 설계 문서는 믿지 말고 코드로 확인한다.

**무엇이 바뀌었나.** (1) 검토 화면(`apps/daemon/src/review-web/`)이 `POST /decide` 로 승인 소켓에 결정을 보낸다(DB는 계속 읽기 전용). (2) 초안 먼저 승인(ADR-0015): 사람이 승인한 초안 바이트만 `host:dispatch` 로 나간다. (3) 결정 위임(ADR-0016): 정책이 정한 범위 안에서 AI 보유자가 초안 승인 업무를 대신 승인한다.

**확인할 보장 두 가지.**
1. 유효한 사람 결정, 또는 위임 범위 안의 유효한 위임 결정 없이는 외부 효과가 없다.
2. 승인한 바이트 == 보낸 바이트 (`payload_hash` == `request_hash`).

준비: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`. 아래 `node --test` 묶음은 이 브랜치에서 모두 통과를 확인했다(구역 1: 56, 2: 78, 3: 36, 4: 25건).

## 1. 화면 결정 경로 `POST /decide`

**지켜야 할 것**
- 다른 출처가 결정을 보낼 수 없다: 쿠키(HttpOnly, SameSite=Strict) + `Origin` 필수·동일 호스트 + `Sec-Fetch-Site`(있으면 same-origin) + 폼 Content-Type.
- 폼은 1회용이다: nonce = HMAC(세션 키; 버튼|결정 키|지문|발급 시각), 30분, 재사용 불가, 다른 서버 실행의 것은 무효.
- 무엇을 보낼지는 서버가 DB에서 다시 만든다. 폼 값은 요청 내용을 정하지 못하고, 지문이 다르면 보내지 않는다.
- 행위자는 시작 인자 `--actor`(시작 때 `whoami` 로 사람 확인)뿐이다. 폼으로 바꿀 수 없다.
- 결정 분당 20건, OTP 5분에 5번. 화면 프로세스는 DB에 쓰는 길이 없다.

**어디를 보나**
- `apps/daemon/src/review-web/server.ts:100-103` Host 허용(421), `:125-129` Origin 검사, `:159-162` POST 관문 순서, `:183-190` 메서드·쿠키, `:228` 127.0.0.1 외 거부.
- `apps/daemon/src/review-web/nonce.ts:18-22` HMAC 발급, `:29-38` 검증(상수 시간), `:41` 소비. 키는 `server.ts:234` 에서 접근 토큰에서 유도.
- `apps/daemon/src/review-web/decide.ts:104-146` 본체(429 → 필드 길이 → nonce → `resolveDecision` → 사유·OTP 형식 → 지문 대조 → 소비 → 전송). `:68-74` 요청 조립(`actor`·`via:'web'` 은 서버 값, `expected_hash`).
- `apps/daemon/src/review-web/read-only-db.ts:12-28` 쓰기 메서드가 던진다. `write-state.ts:47-54` `whoami`, `:136-137` 속도 제한.
- 엔진 쪽: `packages/policy/src/engine.ts:227` 첫 단계 `requireHuman`, `:276-278` `expected_hash` 대조, `:1125` 소켓 명령 목록, `packages/policy/src/channel.ts:26-31` 소켓 디렉터리 0700 강제, `:56` 소켓 0600.

**확인 방법**
```
node --test --test-concurrency=1 test/unit/review-web.test.ts test/unit/review-web-write.test.ts \
  test/integration/review-web-write.test.ts test/integration/review-web-decide.test.ts test/unit/policy-expected-hash.test.ts
```
수동 (데모 DB: `node scripts/review-web-demo.ts`, 서버를 `--actor` 와 소켓으로 띄우고 터미널에 찍힌 토큰을 `$T`, 포트를 `$P` 로):
- 위조 Origin: `curl -si -X POST http://127.0.0.1:$P/decide -H "Cookie: aot_review=$T" -H "Origin: http://evil.example" -H "Content-Type: application/x-www-form-urlencoded" -d "key=x&verb=approve&hash=0&issued=0&nonce=0"` → 403. Origin 을 빼도, 맞는 Origin + `Sec-Fetch-Site: cross-site` 여도 403. 쿠키를 빼면 401, `Host: evil.example` 이면 421.
- nonce 재사용: 결정 상세 페이지의 hidden 필드(`key verb hash issued nonce`)를 복사해 같은 요청을 두 번 보낸다. 두 번째는 첫 결과로 303 이거나 409 이어야 하고, `approval` 행이 늘지 않는다. `verb` 나 `hash` 를 한 글자 바꾸면 403(invalid form token).
- 낡은 지문: 폼을 받은 뒤 업무 초안/정책을 바꾸고 보낸다 → "그 사이 내용이 바뀌었습니다", 엔진에 아무것도 안 간다(`sqlite3 -readonly <db> "select count(*) from approval"` 불변).

**위험 신호**
- 위 관문 중 하나가 "있으면 검사"로 바뀐 곳(특히 `Origin` 을 선택으로 만든 곳). `Sec-Fetch-Site` 는 있으면 same-origin 이어야 하며 없다고 통과해도 `Origin` 이 막는다.
- `decide.ts` 가 폼의 `actor`/`via`/요청 모양을 그대로 쓰는 곳. `review-web/` 에서 `db.run/exec/writeTx` 호출(현재 `read-only-db.ts` 밖에는 없다: `grep -rnE "\.(run|exec|writeTx)\(" apps/daemon/src/review-web/`).
- 엔진의 `expected_hash` 는 **선택** 필드다(`engine.ts:276`: 안 보내면 대조 안 함). 화면은 `reject/cancel/request_changes/release/promote` 에 항상 싣는지(`decide.ts:22,71`) 확인.
- nonce 를 소비하기 전에 `await` 로 소켓 전송이 끼는 틈(`decide.ts:144` 는 전송 전 소비).

## 2. 위임 적격과 승인 계산

**지켜야 할 것**
- 위임 결정은 소켓이 아니라 프로세스 안 메서드 `delegateDecide` 로만 들어온다. 소켓(`CMDS`)은 사람 전용이다.
- 적격은 결정론이고 AI 출력은 영향이 없다. 항상 사람인 것(삭제 영향, `public` 범위, 초안 아닌 범위 승인, 외부 입력이 영향 준 초안, 사람이 이미 결정한 업무)은 위임되지 않는다.
- `min_approvers != 1` 이면 위임이 꺼진다. 위임 승인은 `task` 에서만, 요청자가 보유자가 아닐 때만, 사람 승인이 없을 때만 정족수가 된다.
- cooldown = max(정책, 위임). 위임 승인은 per-item TOTP 대신 위임 cooldown 을 지난다. pause/revoke/만료/정책 변경은 승인 뒤에도 즉시 효력을 없앤다.
- D-B11: 받는 사람(to·cc·bcc·reply_to)이 모두 활성 연락처이거나 허용 도메인이어야 하고, 수신 거부 주소는 항상 막는다. 연락처 표를 쓰는 길은 사람 소켓 명령뿐이다.

**어디를 보나**
- `packages/policy/src/delegation.ts:15-27` `ALWAYS_HUMAN`(상수), `:53-59` `mandateStop`(`sinceAt` 규칙), `:64-72` 사용 가능 판정(`:65` min_approvers), `:75-87` `delegationAuthority`, `:151-165` 일반 조건, `:172-196` 받는 사람 규칙, `:199-247` 위임별 조건.
- `packages/policy/src/approval.ts:95-130` 에이전트 행 계산(`:98` mandate_id 없으면 무시, `:100-101` authority·min_approvers, `:105` 요청자=보유자), `:142-151` cooldown·재인증 대체.
- `packages/policy/src/engine.ts:849-899` `delegateDecide`(같은 트랜잭션에서 적격 재확인, 해시 대조), `:907-946` `releaseDelegated`(cooldown 중 연락처 변경 재확인 `:929-941`), `:950-983` pause/revoke/resume, `:426` 위임이면 release 재인증 생략, `:1125` `CMDS`.
- `packages/policy/src/gate.ts:211-216` 전송 직전에도 같은 `authority` 로 다시 센다. `apps/daemon/src/delegate-cycle.ts:105-137` 적격하지 않으면 AI를 부르지 않고, AI 출력은 `parseReviewOutput` 으로 검증하며 틀리면 `escalate`.
- 연락처: `apps/daemon/src/contacts.ts:51-137`(사람만, `:103` 정지 주소는 add/import 로 못 되돌림, 감사 `event`), `packages/domain/src/contacts.ts:31` 주소 정규화.

**확인 방법**
```
node --test --test-concurrency=1 test/unit/policy-delegation.test.ts test/unit/policy-delegation-recipients.test.ts \
  test/unit/review-web-delegation.test.ts test/unit/daemon-contacts.test.ts test/integration/daemon-delegation.test.ts
```
수동 (시험 하네스 또는 데모 DB 위에서 `approve.ts` CLI 사용):
- 소켓으로 위임 보유자(에이전트 행위자) id 를 `actor` 로 `approve` 를 보낸다 → `not_human`. `{"cmd":"delegateDecide"}` 를 보낸다 → `bad_request`(명령 목록에 없음).
- `delegation pause` 를 한 뒤 풀어도, 정지 전에 기록된 위임 승인이 `status` 에서 다시 살아나지 않는지(`mandateStop` 의 `sinceAt`). `resume` 은 TOTP 를 요구한다.
- 초안 받는 사람에 `Bob@Example.com`, 유니코드 점, `reply_to` 로 처음 보는 주소를 넣고 `delegationScan` 의 적격이 거부되는지. 연락처를 `suppress` 한 뒤 cooldown 중에 `releaseDelegated` 가 내보내지 않는지.

**위험 신호**
- `ALWAYS_HUMAN` 은 상수 목록일 뿐 코드가 조회하지 않는다. 실제 강제는 구조(위임 결정이 `task` 전용, `authority` 를 `task` 계산에만 넘김: `engine.ts:343,366,423,895,925,1011`, `gate.ts:215`)이므로, 다른 대상 종류에 `authority` 를 넘기는 변경이 없는지 본다.
- `approval.ts` 에서 `row.actor_kind === 'agent'` 분기가 `mandate_id`/`authority` 검사를 건너뛰는 경로. 두 개 이상 위임 중 하나로 다른 위임의 한도를 우회하는 경로.
- 적격 검사와 기록 사이에 트랜잭션이 갈라지는 곳(`delegateDecide` 는 하나의 `writeTx`).
- 연락처 `add`/`import` 는 TOTP 가 없다(소켓 권한이 경계). 위임 범위를 넓히는 경로이므로 감사 `event` 가 항상 남는지 본다.

## 3. 전송은 승인한 초안 바이트 그대로

**지켜야 할 것**
- 초안은 `canonicalJson(요청)` 문자열 그대로 저장되고 `payload_hash = sha256(payload)`. 승인 해시에 초안의 해시·대상·만료가 들어간다.
- 전송 단계는 `host:dispatch` 어댑터만, LLM·에이전트 실행기를 부르지 않는다. 보내기 전에 모든 초안의 해시·정규형·`effect_key` 를 다시 확인한다(어긋나면 전송 0건).
- 전송 직전 게이트가 `(도구, action, 대상, request_hash)` 가 제안된 초안과 맞고 만료 전인지, 승인이 지금도 유효한지 다시 본다. draft 단계 run 은 아무것도 못 보낸다.
- `unknown` 은 자동 재전송하지 않는다(멱등 지원 + 창 안일 때만 같은 키). 확정 후 일치 여부는 평가가 `request_hash == payload_hash` 로 대조한다.

**어디를 보나**
- `packages/task-engine/src/drafts.ts:131-161` 전송기(`:138` sha256, `:145` 정규형, `:146` effect_key, `:153` 원장 규칙으로 전송, `:156` confirmed 아니면 중단).
- `packages/task-engine/src/lease.ts:193` dispatch 단계에서 어댑터 고정. `packages/task-engine/src/effects.ts:137-185` `beginDispatch`(펜싱, 재조회, 정책 재검증, draft 단계 금지 `:140`, `unknown` 재전송 조건).
- `packages/policy/src/gate.ts:105-128` 전송 단계 초안 대조·만료, `:155-157` 승인 재확인, `:187-218` `verifyTaskApproval`(해시·정책 버전·초안 만료).
- 정지 전환: `packages/task-engine/src/lease.ts:259-264`(워커 사망 시 `dispatched → unknown`). 사후 대조: `packages/evaluation/src/dispatch-checks.ts:43`.
- 승인 쪽 초안 거부: `engine.ts:381-396`(가려진 값·만료 초안은 승인·release 불가).

**확인 방법**
```
node --test --test-concurrency=1 test/unit/task-drafts-dispatch.test.ts test/unit/policy-gate-draft.test.ts \
  test/unit/evaluation-dispatch.test.ts test/integration/daemon-draft-approval.test.ts
```
수동: 시험 DB에서 `effect_draft.payload` 한 글자를 바꾸고 전송 run 을 돌린다 → `DraftIntegrityError`, `external_effect` 행 0. 만료 시각을 지나서 돌리면 게이트가 거부한다. 승인 뒤 정책 버전을 바꾸면 `hash_mismatch`.

**위험 신호**
- 전송 경로가 `effect_draft.payload` 가 아니라 다시 만든 요청·에이전트 출력을 쓰는 곳. `request_hash` 대조 없이 도구를 호출하는 곳.
- `unknown`/`failed` 재전송이 승인을 재사용하는 곳(`gate.ts:149-153`: `failed` 재전송은 allow 판정일 때만).
- 초안 만료 검사가 승인 시점에만 있고 전송 시점에는 없는 변경.

## 4. 정책 배포

**지켜야 할 것**
- 위임을 추가·넓히는 변경은 현재 정책이 재인증을 꺼 두었어도 **항상** TOTP 가 필요하다(위험 변경 + 재인증 강제). 위임 삭제·축소만 일반 변경이다.
- 배포 승인은 사람만, *변경 전* 정책의 `risky_change` 로 판정한다. 위임 만료는 승인 시각부터 90일 이내, 보유자는 에이전트 행위자.
- 모든 위임이 `recipients` 규칙을 선언해야 파싱을 통과한다. 정책이 없거나(`no policy_version`) 내용이 없거나 어긋나면 기본 거부다.
- stub 검토자는 시험 전용이다. 데몬 설정에 `delegate_reviewer: {kind: stub}` 가 있으면 시작을 거부한다.

**어디를 보나**
- `packages/policy/src/change.ts:88-124` 위임 확대 판정(섹션 신설, 위임 추가, 보유자, match, recipients, 한도, cooldown, expires). `engine.ts:1104-1109` `policyApprovalParams`(TOTP 강제), `:591-633` 배포 승인·release, `:643-657` 만료·보유자 점검.
- `packages/policy/src/document.ts:494-538` 위임 파싱(`recipients` 필수). `packages/policy/src/gate.ts:26-31` 정책 없음·내용 불일치 → default deny.
- `apps/daemon/src/delegate-cycle.ts:143-170` stub 거부(`allowStub` 는 시험에서만), `apps/daemon/src/main.ts:94` 운영 조립은 `allowStub` 를 주지 않는다.
- TOTP 재사용 거부·잠금: `engine.ts:296-310`.

**확인 방법**
```
node --test --test-concurrency=1 test/unit/policy-deploy.test.ts test/unit/policy-totp.test.ts \
  test/unit/policy-delegation-document.test.ts test/unit/daemon-delegate-cycle.test.ts
```
수동: (a) `reauth_before_effect: false` 인 정책에 `delegation` 섹션을 넣어 `approve policy` → cooldown 뒤 `release` 에 TOTP 없이 하면 `reauth_required`. (b) `recipients` 를 뺀 위임 YAML 은 거부. (c) 데몬 설정에 `"delegate_reviewer":{"kind":"stub","verdict":"approve"}` 를 넣고 시작 → 시작 실패. (d) 활성 정책 파일을 지우거나 한 글자 바꾼 뒤 업무 생성·전송이 `default deny`.

**위험 신호**
- `change.ts` 에서 새 위임 필드가 `mandateWidenings` 비교에서 빠진 것(비교하지 않은 필드는 조용히 넓어진다).
- 정책 해시가 아니라 파일 이름·id 로 정책을 찾는 곳. `allowStub: true` 가 시험 밖에 나타나는 곳(`grep -rn allowStub apps packages`).

---

## 받아들인 위험과 알려진 한계

- `via` 는 자기 신고 값이고 감사용이다(`engine.ts:47`, `:1141`). 권한 판단에 쓰지 않는다. 소켓에 닿는 프로세스는 어떤 사람 행위자 id 든 댈 수 있다. 경계는 소켓 파일 권한(0600)과 사용자 계정이다.
- 위임 승인은 건별 재인증 대신 "배포 때 TOTP + 위임 cooldown(정책의 `risky_change.cooldown` 이상, `document.ts:136`)"으로 대체한다(`approval.ts:148`, `engine.ts:426`). 사람이 cooldown 안에 취소하면 위임이 자동 정지된다.
- 실제 AI 검토자와 실제 메일 도구는 아직 없다. 운영에서 위임을 선언해도 AI 승인은 일어나지 않고, 검토자 포트와 stub 만 있다. 이 PR이 검증하는 것은 엔진 경계이지 AI 판단의 질이 아니다.
- 수신 거부(suppress)는 되돌릴 수 없다(`contacts.ts:4,103`). 잘못 막으면 DB 직접 수정밖에 없다. 좁히는 일이라 TOTP 도 없다(pause/revoke 도 같다).
- 접근 토큰 쿠키는 `Secure` 가 아니다(127.0.0.1 http). 같은 PC의 다른 사용자는 토큰이 없으면 못 보지만, 같은 사용자의 악성 프로세스는 소켓을 직접 쓸 수 있다.
- 알려진 macOS 통합 시험 실패 2건(Linux CI에서는 통과, `docs/plans/handoff-mvp.md`). 이 체크리스트의 시험 묶음에는 들어 있지 않다.

## 범위 밖

- 에이전트 샌드박스(컨테이너) 격리, 외부 입력 주입 방어 일반(기존 PR 범위).
- 전화(phone) 정책, 조직 변경·실험 전략 승인 흐름, 게시(publication) 흐름의 변경 없는 부분.
- SQLite 파일·정책 디렉터리·TOTP 비밀 저장소의 OS 권한, 백업.
- 실제 메일 공급자 연동과 멱등 키 지원 범위.

## 서명 전 확인 (☐)

☐ 구역 1~4 시험 묶음 통과, 위조 Origin·Sec-Fetch-Site·Host·쿠키 없음 프로브 모두 거부.
☐ nonce 재사용과 낡은 지문에서 `approval` 행이 늘지 않았다.
☐ `review-web/` 에 DB 쓰기 호출이 없고, 폼이 행위자·요청 모양을 정하지 못한다.
☐ 소켓에서 에이전트 id 와 `delegateDecide` 가 거부되고, `authority` 는 `task` 계산에만 전달된다.
☐ 받는 사람 규칙(reply_to·정규화·수신 거부)과 cooldown 중 재확인을 확인했다.
☐ 전송기가 저장된 초안 바이트만 쓰고, 어긋나면 전송 0건이다.
☐ 위임 추가·확대 배포는 현재 정책과 무관하게 TOTP 를 요구한다.
☐ stub 검토자가 운영 조립에서 로드되지 않고, 정책 없음·손상은 default deny 이다.
☐ 받아들인 위험 목록에 동의하거나 별도 이슈로 분리했다.
