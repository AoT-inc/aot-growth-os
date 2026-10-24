# ADR-0006 정책은 에이전트 쓰기 경로 밖에 둔다

상태: proposed

## Context
에이전트가 자기 권한·예산·승인 규칙을 바꿀 수 있으면 다른 모든 통제가 무의미해진다.

## Decision
- 정책(`policies/`, `policy_version`)은 에이전트 작업 디렉터리와 도구 권한에서 **읽기·쓰기 모두 접근 불가**(필요한 결과는 정책 엔진이 판정값으로만 제공)한다.
- 정책 변경은 사람 승인 PR → 리뷰 → 배포 절차로만 가능하다. 런타임 API로 정책을 바꾸는 경로를 만들지 않는다.
- 변경을 두 등급으로 나눈다.
  - 일반 설정: 부서 업무 정의, 루틴 주기, 알림 등.
  - **위험 변경**: 권한 상승, 보안 규칙 완화, 예산 한도 상향, 공개 범위 확대, 승인 요건 삭제. 별도 승인자(2인 이상 또는 지정 역할)와 별도 PR 라벨을 요구한다.
- 모든 업무는 적용된 `policy_version`을 기록한다.
- 도구 호출은 정책 게이트웨이를 통과한다: allow / deny / require_approval.

- 조직 재편(ADR-0011)으로 만들어진 역할은 그 자체로 권한을 갖지 않는다. 도구·예산·공개 범위는 정책이 결정한다.

## Consequences
- 정책 변경 속도는 느려지지만 감사 가능하다.
- 전략은 시스템이 변경을 제안할 수 있으나 정책은 제안 객체만 만들 수 있고 적용은 사람 몫이다([ADR-0008](0008-memory-and-strategy.md)).

## Amendment (2026-10-14): 권한은 도구 이름이 아니라 7요소로 판정한다
- 판정 입력: 주체, 행위, 대상, 범위(internal/customer/public), 영향(read/write/delete/external_effect), 제약(예산·횟수·시간·대상 수), 승인 요건. 결과: allow / deny / require_approval.
- 정책 엔진이 계산하고 도구 어댑터가 호출 시 재검증한다. 판정은 `policy_decision`에 append-only로 남는다.
- 정책 엔진·검증기·평가기는 일반 에이전트와 별도 권한으로 운영한다. 에이전트가 자신의 실행 권한을 결정하는 구조를 금지한다.
- 외부 입력(웹, 고객 문서)은 데이터이며 정책·권한을 바꾸지 못한다. 신뢰 경계 전체는 [security/trust-boundaries.md](../security/trust-boundaries.md).

## Amendment (2026-10-19): 위험 변경 승인 구성과 정책 표현 (Q6·Q7 해소)
- **승인 구성(Q6, [a0-decisions D3](../plans/a0-decisions.md)).** 본문의 "2인 이상 또는 지정 역할"은 1인 운영에서 불가능하므로 Phase A 기본값을 1인 승인 + 짧은 대기 + 실행 직전 재인증으로 둔다. 값은 정책 파라미터다. 자기 승인은 파라미터가 아니라 `min_approvers`에서 정해진다(아래).
  ```yaml
  risky_change:
    min_approvers: 1             # 1 이상의 정수. 2인 체제가 되면 올린다
    cooldown: 1h                 # 승인 후 실행 가능까지 대기. 대기 중 취소 가능
    reauth_before_effect: true   # 실행 직전 사람 재인증 (TOTP, trust-boundaries §3.1)
  ```
  - 저장소의 기본 템플릿 값이 기본값이고, 인스턴스 정책(`instance/`)에서 바꿀 수 있다. 값 범위를 벗어나면 배포되지 않는다.
  - **자기 승인(2026-10-19 후속 결정).** `min_approvers == 1`이면 오너(사람 actor)의 자기 승인을 허용하되 cooldown과 TOTP 재인증은 그대로 거친다. `min_approvers ≥ 2`이면 자동으로 금지한다. 에이전트 actor는 어떤 경우에도 승인할 수 없다. 별도 `self_approval` 키는 없고, 문서에 쓰면 사유와 함께 거부한다.
  - **적용 범위(2026-10-19 후속 결정).** 위 절차(승인자 수·cooldown·TOTP)는 외부 부작용(`external_effect`)과 정책 변경에만 쓴다. 외부 부작용이 아닌 `require_approval`(예: `customer` 범위 읽기)은 사람 1인 승인만 받고 cooldown·TOTP는 없다.
  - 보안을 낮추는 변경(`min_approvers` 감소(2 이상에서 1로 내리면 자기 승인이 허용으로 바뀌는 변경이기도 하다), `cooldown` 단축, `reauth_before_effect` 끄기)은 그 자체가 위험 변경이며, 변경 **전** 정책의 `risky_change` 절차로 승인한다. 새 정책의 값으로 자기 자신을 승인할 수 없다.
- **정책 표현(Q7).** YAML(스키마 검증) + 자체 결정론적 TS 판정기. 정책 버전은 정규화된 내용의 해시다. 형식은 [ADR-0013](0013-policy-format.md).
- **구현(A3, 2026-10-19).** 승인은 대상의 정규화 해시(`approval.subject_hash`, 업무는 `task.approved_hash`)에 묶이며, 업무 해시에는 승인 시점의 정책 버전이 들어간다. 그래서 정책이 바뀌면(강화든 완화든) 과거 승인은 실행 직전 재검증에서 무효가 되고 재승인을 요구한다. 위험 변경 절차(`risky_change` 값)는 외부 부작용(`external_effect`)이 `require_approval` 판정을 받은 업무·게시와 위험 등급의 정책 배포에 쓴다. 그 밖의 `require_approval`(예: `customer` 범위 읽기, `internal` 게시의 `confidential` 입력)은 사람 1인 승인만 받고 cooldown·재인증이 없다. 정책 배포의 승인은 요청자 기록이 따로 없다(제안과 첫 승인이 한 번의 승인 명령이다). 그래서 자기 승인 검사를 하지 않고, 승인자 수가 서로 다른 사람의 승인으로 채워지는 것만 요구한다. 정책 배포는 사람 승인 채널(승인 CLI)로만 하며 에이전트에게는 경로가 없다.
- **Phase A 편차.** 승인 채널은 피어 UID 대신 소켓 파일 권한(0700 디렉터리, 0600 소켓)으로 접근을 제한한다. 같은 UID의 프로세스는 막지 못하므로 Q26(에이전트 별도 UID·컨테이너)이 전제다 ([trust-boundaries §3.1](../security/trust-boundaries.md)).

## Amendment (2026-10-24): 실험 전략 승인 (A6-U15)
실험(`strategy_version`) 승인은 외부 부작용도 정책 변경도 아니므로 **사람 1인 승인**(`humanApprovalParams`: cooldown·TOTP 없음)이고, 자기 승인은 다른 승인과 같이 `risky_change.min_approvers`에서 정한다(1이면 허용, 2 이상이면 제안자 본인은 불가, 에이전트는 항상 불가). 승인 해시는 제안 본문(제목·가설·근거 참조·부모·제안자) + `experiment_scope`(마케팅 업무 명세 또는 팩 템플릿 참조, 측정 신호, 주, 비교 요약) + 승인 시점 정책 버전(id·내용 해시)이며 업무 승인 해시와 같은 방식이다. 승인과 같은 트랜잭션에서 `proposed → experiment`로 옮기고(허용표에 전이 추가 없음), `experiment` 상태이며 승인이 취소되지 않은 전략이 있으면 두 번째 승인은 거부한다(한 번에 실험 하나). 루틴 활성화는 승인 트랜잭션 밖에서 한 번만 한다(event 멱등 키 `experiment-activate:<id>`). 활성화 직전에 마지막 승인 기록이 사람의 `approved`인지와 해시가 지금 내용 + 배포된 어느 정책 버전과 맞는지 다시 확인한다 — 승인 뒤 본문·범위가 바뀌었거나 활성화 전에 `cancel`했으면 켜지 않는다. 정책 변경만으로 실험 승인을 무효로 하지 않는 이유: 실험 승인은 *실험 내용*에 대한 것이고, 마케팅 업무는 생성 게이트와 실행 직전(`beforeRun`)에 *새* 정책으로 다시 판정되므로(위 A3 구현 단락의 규칙) 강화된 정책이 그대로 적용된다. **실험 승인은 마케팅 업무의 외부 부작용 승인을 대신하지 않는다**: 그 업무에 `external_effect` 요청이 있으면 업무가 `needs_review`로 가서 이 ADR의 `risky_change` 절차(승인자 수·cooldown·TOTP)를 따로 거친다.
