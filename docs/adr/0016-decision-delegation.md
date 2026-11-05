# ADR-0016 화면에서 결정하고, 사람이 정한 위임 안에서는 AI가 결정한다

상태: accepted (2026-11-06, 오너 결정 D-B1로 원칙 변경 채택. 병합 전 사람의 보안 리뷰는 남음. 2026-11-05 proposed. 설계와 작업 분할은 [plans/decision-delegation](../plans/decision-delegation.md))

## Context
오너 의견(2026-11-05, 읽기 전용 검토 화면을 본 뒤): 결정 명령어는 사용자에게 필요 없다. 관련 이력은 짧게 요약하고 링크를 준다. 거절 이유는 선택으로 받는다. **사용자에게 결정을 많이 요구하지 않는 것이 기본이며, 핵심 의제이거나 조직 관리 AI의 권한을 벗어날 때만 그 권한이 있는 사람이나 AI가 판단한다.**

지금은 모든 승인을 사람이 한다. 승인 엔진은 `actor.kind='human'` 행만 세고([ADR-0006](0006-policy-separation.md) Amendment 2026-10-19), 검토 화면은 쓰기 경로가 없어 명령어를 글자로 보여 준다. 결정 권한을 가진 AI는 없다. ADR-0011의 `org-management`는 제안 전용이고 승인 엔진에 접근할 수 없다.

## Decision
1. **화면에서 결정한다.** 검토 화면이 승인·거절(이유 선택)·다시 쓰게(이유 필수)·취소·OTP 확인을 폼으로 받는다. 화면 프로세스는 계속 DB를 읽기 전용으로 열고, 결정은 승인 CLI와 같은 Unix 소켓으로 엔진에 보낸다. 엔진이 유일한 기록·검증 주체다. CSRF는 `SameSite=Strict` + `Origin`/`Sec-Fetch-Site` 확인 + 세션에 묶인 1회용 폼 nonce로 막고, 폼은 본 내용의 해시를 실어 엔진이 다르면 거부한다(`approve`는 지금도, `reject`·`cancel`·`request_changes`·`release`는 새 `expected_hash`). 쓰기는 시작 인자로 정한 사람 행위자가 있을 때만 켠다. 첫 화면에 명령어를 보이지 않는다.
2. **위임은 정책 안에 둔다.** 정책의 새 섹션 `delegation.mandates[]`가 보유자·대상·범위(도구.action, 대상, scope)·한도(일일 수, 초안·받는 사람 수, 크기, 업무 예산, AI 다시 쓰게 횟수, 검토 비용)·cooldown·판단 기준 글·만료(90일 이내)를 정한다. 위임을 더하거나 넓히는 정책 변경은 위험 변경이다. 그래서 위임 범위는 사람이 TOTP로 배포한 범위다.
3. **위임받는 AI는 새 행위자 `approval-delegate`다.** `org-management`(제안 전용)와 분리한다. 도구가 없고 소켓에 닿지 않는다. 데몬의 호스트 주기가 AI run 출력(`approve|request_changes|escalate`, 해시, 사유)을 받아 엔진의 프로세스 안 메서드로 기록한다. 소켓 채널은 계속 사람 전용이다.
4. **AI는 좁힐 수만 있다.** 엔진이 결정론적 적격 검사(위임 유효, 초안 승인 업무, 모든 초안이 범위·한도 안, 외부 입력 영향 없음, 가린 값·전송 시작·만료 없음, 사람이 이 업무에 결정한 적 없음, 요청자 ≠ 보유자, 일일·비용 한도)를 통과한 업무에만 AI 판정을 받고, 기록 트랜잭션에서 다시 검사한다. AI 출력은 신뢰하지 않는 데이터다.
5. **항상 사람.** 정책 배포(위임 변경 포함), 조직 변경 제안과 시험 확정, 실험 전략, 상품 등록 결정, 효과 확정, 게시, 범위 승인 업무(전화 등), `delete` 영향, 외부 입력 영향 초안, 사람이 한 번 결정한 업무, 위임 정지 해제. 코드 상수이며 정책으로 바꾸지 못한다. v1 위임 대상은 초안 승인 업무(ADR-0015)뿐이다.
6. **승인한 것 = 나간 것.** 위임 승인 행은 `decided_by='approval-delegate'`, `mandate_id`, 그 순간 `show` 해시(초안 목록 포함), AI 사유를 남긴다. 전송은 ADR-0015의 호스트 전송기 그대로다. `approvalStatus`는 위임 행을 지금 정책에 그 위임이 있고 정지·철회·만료가 아닐 때만 센다. 정족수가 위임 승인이면 위임 cooldown을 쓰고 건마다 재인증은 없다(배포 때 재인증했다). 정책이 바뀌면 업무 해시가 바뀌어 위임 승인도 무효다.
7. **정지와 철회는 런타임 강화다.** 사람이 전체·위임별로 정지·철회할 수 있다(append-only 기록). 정지 해제는 사람 + TOTP. 사람이 위임 승인을 cooldown 중 취소하면 그 위임은 자동 정지된다.
8. **사람은 결정 대신 요약을 본다.** "AI가 처리함" 한 줄과 목록(취소 가능 시간 포함), 사람에게 온 카드에는 "AI가 넘긴 이유" 한 줄.
9. `risky_change.min_approvers`가 2 이상이면 위임 섹션을 거부한다.

## 고쳐야 할 문구 (오너 결정, 이 ADR이 accepted 될 때 각 문서에 Amendment로 단다)
| 문서 | 지금 문구 | 바꿀 내용 |
|---|---|---|
| ADR-0006 Amendment 2026-10-19 "자기 승인" | "에이전트 actor는 어떤 경우에도 승인할 수 없다." | "에이전트 actor는 승인할 수 없다. 예외: ADR-0016의 위임 보유자가 사람이 배포한 정책의 위임 범위 안에서 승인 엔진을 통해 기록한 초안 승인 업무의 위임 승인." |
| ADR-0006 Amendment 2026-10-19 `reauth_before_effect` 주석 | "실행 직전 사람 재인증" | 위임 승인이 정족수인 업무는 위임 배포 때의 재인증 + 위임 cooldown으로 갈음한다 |
| ADR-0006 본문 | "런타임 API로 정책을 바꾸는 경로를 만들지 않는다." | 강화 방향(위임 정지·철회)은 정책 변경이 아니며 런타임에 할 수 있다. 완화(정지 해제)는 사람 + TOTP |
| ADR-0006 Amendment 2026-10-14 | "에이전트가 자신의 실행 권한을 결정하는 구조를 금지한다." | 유지. 위임 보유자는 자기 또는 자기 역할이 요청한 업무를 승인할 수 없고 자기 run에 도구가 없다는 점을 덧붙인다 |
| ADR-0015 Decision 2·5, 구현 기록 | "유효한 사람 승인이 있으면 호스트가 run을 연다", "사람은 검증을 통과한 초안만 승인할 수 있다" | "사람 승인 또는 ADR-0016 위임 승인" |
| ADR-0013 | (없음) | `delegation` 섹션 형식과 변경 등급 Amendment |
| trust-boundaries §1 규칙 8 | "`approval`은 `actor.kind='human'`만." | "사람, 또는 위임 범위 안에서 승인 엔진이 기록한 위임 승인." §3.1 "에이전트 actor가 보낸 승인 요청은 어떤 경우에도 거부한다"는 **소켓 채널에 대해 유지**한다 |
| `docs/schema/schema.sql` `approval.decided_by` 주석 | "kind='human'만 허용" | "human, 또는 `mandate_id`가 있는 위임 보유자" |

ADR-0011(§2·§3 "`approved`는 사람의 `approval` 기록으로만")과 ADR-0006 Amendment 2026-10-24(실험 전략 "에이전트는 항상 불가")는 조직 제안과 실험 전략이 "항상 사람"이라 고치지 않는다.

## Consequences
- 오너가 보는 결정은 위임 밖의 것뿐이다. 위임 안의 일은 cooldown 동안 취소할 수 있는 요약으로 바뀐다.
- 범위 안의 잘못된 AI 승인은 막지 못한다. 그 크기는 사람이 정한 한도이고 요약·취소·자동 정지로 줄인다.
- 브라우저라는 쓰기 표면이 생긴다. 같은 OS 사용자 프로세스가 소켓을 쓸 수 있다는 기존 한계(Q26 전제)는 그대로다.
- 위임 검토 run의 LLM 비용이 생긴다(위임별 일일 한도).
- 위임 섹션이 없는 정책은 동작과 정책 버전 해시가 지금과 같다.

## 구현 기록 — 트랙 B 엔진·정책 (2026-11-05, 상태는 proposed 그대로)
작업 B1~B10을 구현했다. 위임은 **꺼져 있다**: 기본 템플릿·시드 정책에 `delegation`이 없고, 위임이 없는 정책·DB에서는 정책 해시와 승인 계산이 지금과 같다(기존 시험이 그대로 통과한다). 오너 결정 D-B1에 따라 이 ADR이 accepted 되기 전에는 ADR-0006·0013·0015·trust-boundaries의 Amendment가 모두 "제안"으로 표시돼 있다.

- 공유 계약(§5): 소켓 요청의 선택 필드 `expected_hash`(`reject`·`cancel`·`request_changes`·`release`, 64자 소문자 16진수가 아니면 `bad_request`)와 `via`(`cli|web`, 그 밖의 값은 `bad_request`)를 엔진이 받는다. 거부 응답은 `{ok:false, error, code?}`이고 코드는 `hash_mismatch wrong_state send_started masked expired policy_denied self_approval cooldown reauth_required reauth_failed reauth_locked not_human bad_request`다(코드 없는 거부가 남을 수 있다 — 화면은 "그 밖"으로 안내). 상태를 먼저 확인하고 해시를 그 다음에 대조한다(이미 다른 결정이 난 업무는 `wrong_state`).
- 계산: `approvalStatus`가 `DelegationAuthority`를 받아 위임 행을 센다(delegation.ts). 사람 승인이 하나라도 유효하면 사람 행이 정족수 행이다. 위임 승인 행이 정족수면 cooldown은 `max(risky_change.cooldown, 위임 cooldown)`이고 재인증은 요구하지 않는다. **정지 뒤 풀어도 정지 전의 위임 승인은 되살아나지 않는다**(정지·철회가 승인 시각 이후에 한 번이라도 있었으면 무효, 사람이 다시 결정한다).
- 엔진 프로세스 내 메서드: `delegationScan()`(읽기 전용 적격 후보), `delegateDecide()`(같은 트랜잭션에서 적격 재확인, 결과를 `delegate_review`에 남김), `releaseDelegated()`(`needs_review → queued`, 주체 `policy`). 사람 소켓 명령: `delegation status|pause|resume|revoke`(resume만 TOTP). `delegate_decide` 모양의 소켓 요청은 `bad_request`로 거부된다.
- 데몬: `apps/daemon/src/delegate-cycle.ts`(풀어 주기 → 적격 업무 검토 → 출력 검사 → `delegateDecide`), `assembleDaemon`의 `delegate.reviewer` 옵션, `Daemon.delegation.advance()`를 main 루프가 tick마다 부른다. 업무마다 적격을 다시 읽어 한도를 넘은 뒤에는 AI를 부르지 않는다. 검토자를 쓸 수 없으면(`DelegateReviewerUnavailableError`) 기록 없이 다음 tick에 다시 한다.

설계 문서(plans/decision-delegation.md)와 달라진 곳:
- **`approval-delegate` 시드는 `seedPhaseA`가 아니라 요청형이다.** `ensureApprovalDelegate`(domain)가 행위자와 도구 없는 역할을 멱등으로 만들고, 위임 보유자가 예약 id `approval-delegate`인 정책을 사람이 배포하는 같은 트랜잭션에서 승인 엔진이 호출한다. 이유: 시드를 바꾸면 위임이 없는 DB(행위자·역할 수)가 달라져 "위임이 없으면 지금과 같다"가 깨진다. 이미 시드된 인스턴스도 그대로 쓸 수 있다. org_version 스냅샷은 바꾸지 않는다.
- **위임 검토자(AI 호출)는 포트(`DelegateReviewer`)로만 연결했고 실제 모델 검토자는 만들지 않았다.** 데몬 설정 `delegate_reviewer`는 `{"kind":"stub"}`(점검·시험용, 기본 판정은 사람에게 넘김)만 받는다. `claude_code_cli` 검토자는 후속 작업이다. 그러므로 지금 실제 운영에서 위임을 선언해도 AI 승인은 일어나지 않는다(풀어 주기만 돈다). `delegate_review`에 AI run id 열은 두지 않았다(별도 task_run을 만들지 않는 호출이라 비용·판정·사유만 남긴다).
- **정지·철회·만료 때문에 적격하지 않을 때는 `delegate_review`를 남기지 않는다**(풀리면 다시 본다). 그 밖의 적격 실패(한도·범위·외부 입력 등)는 `escalate` 행으로 남아 그 해시는 사람에게 남고, 이 행의 `reason`이 화면의 "AI가 넘긴 이유"가 된다(한국어 한 줄).
- **`revoke`를 위임 id 없이 보내면 지금 정책의 모든 위임에 대해 위임마다 한 행을 남긴다**(테이블의 `revoke`는 `mandate_id`가 필수). 전체 정지는 `pause`다.
- **위임 보유자의 `다시 쓰게`로 초안을 `superseded`로 버리는 전이 주체는 `scheduler`다**(초안 상태표가 `policy`를 받지 않는다). 업무 쪽 전이(`needs_review → queued`)는 주체 `policy` + 승인 참조.
- 기존 시험 세 곳을 계약에 맞게 고쳤다: `state-machines.test.ts`(`needs_review → queued`를 `policy`도 승인 참조와 함께 허용), `daemon-effect-resolve.test.ts`(모르는 명령의 거부가 이제 `code: bad_request`), `entity-rows.test.ts`(새 열·표).
- 진행 중인 실험을 거절하는 경로(`experiment-review.ts`, 승인 엔진이 아니라 결과 채널이 처리)는 `via`·`expected_hash` 필드를 받아들이지만 해시를 대조하지 않았다 — 트랙 C에서 대조하도록 고쳤다(아래 트랙 C 기록).

## 구현 기록 — 트랙 C 화면 (2026-11-05, 상태는 proposed 그대로)
작업 C1~C3을 구현했다. 화면 프로세스는 DB에 여전히 쓰지 않고, 위임 관련 쓰기도 모두 사람 소켓 명령이다. 화면은 AI 결정 요청을 보낼 길이 없다.

- **위임된 일은 결정이 아니다.** 엔진 `show`가 지금도 위임 승인을 유효로 세는 업무(`approval.mandate_id`)는 결정 카드·묶음에서 빠지고 `/delegated`와 홈의 "AI가 처리함" 요약에만 나온다(건마다 한 줄 AI 이유와 나가기 전까지의 `취소` 버튼). 정지·철회·만료·정책 변경으로 효력을 잃으면 다시 결정 카드로 돌아오고 「확인할 것」 자리에 "AI가 넘긴 이유"(`delegate_review.reason`, 정지 때는 고정 문구)가 나온다.
- **버튼**: `취소`(`cancel` + `expected_hash`, 눌러 두면 엔진이 그 위임을 자동 정지하므로 완료 문구에 그 사실을 말한다), `위임 멈추기`(`delegation pause`, TOTP 없음), `위임 다시 켜기`(`delegation resume`, OTP, 전체 정지면 전체·개별 정지면 위임마다 한 버튼). 모두 기존 `POST /decide` 폼(nonce·지문·속도 제한)을 그대로 쓰고 서버가 키(`delegated:<업무>`, `delegation:control`)로 요청을 다시 만든다.
- **실패 문구는 엔진 `code` 로만 정한다.** 트랙 A의 임시 영어 문장 패턴 매핑(`inferCode`)을 지웠다. 코드가 없거나 모르는 코드면 "처리하지 못했습니다" 한 줄이고 영어 원문은 접힌 자세히에만 보인다.
- **실험 승격·거절도 `expected_hash`를 대조한다.** `experiment-review.ts`가 `expected_hash`가 있으면 승인 엔진 `show`의 전략 해시(`subjectHash` 옵션, `assembleDaemon`이 연결)와 비교하고 다르면 `hash_mismatch`, 형식이 틀리면 `bad_request`로 거부한다. 화면은 이제 이 두 버튼에도 해시를 싣는다. 이 채널의 거부에도 `code`(`not_human` 포함)가 붙는다.
- **시험**: `test/integration/review-web-decide.test.ts`가 실제 `ApprovalEngine` + 진짜 Unix 소켓 + 파일 DB(화면은 읽기 전용 연결)로 승인·거절(이유 있음/없음)·다시 쓰게·낡은 해시(`hash_mismatch`)·이미 결정됨(`wrong_state`, 화면 쪽 `gone`)·위임 승인 취소 → 자동 정지 → OTP로 해제·위임 멈추기·"AI가 넘긴 이유" 카드를 확인한다. 순수 규칙(요약 상태·시간 문구·실패 매핑)은 `test/unit/review-web-delegation.test.ts`, `review-web-write.test.ts`.
- **남은 일**: 실제 AI 검토자(`claude_code_cli`)가 없어 운영에서는 아직 AI 승인이 일어나지 않는다(트랙 B의 남은 일). 위임 철회와 정책 배포는 파일/CLI 일이다.

## 구현 기록 — 검토 반영 (2026-11-05, 상태는 proposed 그대로)
- 사람의 `reject`·`request_changes` 도 취소처럼 지금 유효한 위임 승인의 위임을 자동 정지한다(D-B5 확장, 응답 `delegation_paused`).
- 위임을 추가·확대하는 정책 변경(`classifyChange` 이유가 `delegation ...`)은 지금 정책의 `reauth_before_effect` 가 꺼져 있어도 배포에 TOTP 가 필요하다.
- 가짜 검토자(stub)는 시험 전용이다. 데몬 설정 `delegate_reviewer` 로는 읽히지 않고(`parseDelegateReviewerConfig` 가 `allowStub: true` 없이는 거부), 운영 조립은 플래그를 주지 않는다.
- 승인 화면(ADR-0015)은 정확한 주소와 payload 의 모든 필드를 보이고, 다 볼 수 없으면 승인 버튼을 내지 않는다. 정책 제안 카드는 위임·전화 섹션 변경을 첫 줄에 말한다.
- **열린 오너 결정**: 위임에 받는 사람 도메인 한도(`recipient_domains` 같은 허용 목록)를 둘지. 구현하지 않았다.
