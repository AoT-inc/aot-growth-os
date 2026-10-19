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
- **승인 구성(Q6, [a0-decisions D3](../plans/a0-decisions.md)).** 본문의 "2인 이상 또는 지정 역할"은 1인 운영에서 불가능하므로 Phase A 기본값을 1인 승인 + 짧은 대기 + 실행 직전 재인증 + 자기 승인 금지로 둔다. 값은 정책 파라미터다.
  ```yaml
  risky_change:
    min_approvers: 1             # 1 이상의 정수. 2인 체제가 되면 올린다
    cooldown: 1h                 # 승인 후 실행 가능까지 대기. 대기 중 취소 가능
    reauth_before_effect: true   # 실행 직전 사람 재인증 (TOTP, trust-boundaries §3.1)
    self_approval: false         # 요청자와 승인자가 같은 actor면 거부 (에이전트 요청은 해당 없음)
  ```
  - 저장소의 기본 템플릿 값이 기본값이고, 인스턴스 정책(`instance/`)에서 바꿀 수 있다. 값 범위를 벗어나면 배포되지 않는다.
  - 보안을 낮추는 변경(`min_approvers` 감소, `cooldown` 단축, `reauth_before_effect` 끄기, `self_approval` 허용)은 그 자체가 위험 변경이며, 변경 **전** 정책의 `risky_change` 절차로 승인한다. 새 정책의 값으로 자기 자신을 승인할 수 없다.
- **정책 표현(Q7).** YAML(스키마 검증) + 자체 결정론적 TS 판정기. 정책 버전은 정규화된 내용의 해시다. 형식은 [ADR-0013](0013-policy-format.md).
