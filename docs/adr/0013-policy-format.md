# ADR-0013 정책 표현: YAML + 결정론적 판정기

상태: accepted (2026-10-19, [open-questions Q7](../open-questions.md))

## Context
[ADR-0006](0006-policy-separation.md)은 권한을 7요소(주체, 행위, 대상, 범위, 영향, 제약, 승인)로 판정하고 결과를 `policy_decision`에 남기도록 정했지만 정책을 무엇으로 표현할지는 열어 두었다(Q7). 후보는 YAML + 코드 판정, OPA(Rego), Cedar였다. Phase A의 규칙은 초기 정책 v1([a0-decisions D4](../plans/a0-decisions.md))과 위험 변경 파라미터(D3) 정도로 작다. 외부 엔진은 의존성·런타임이 늘고, 판정 결과를 `policy_decision` 형식으로 맞추는 어댑터가 따로 필요하다.

## Decision
- 정책 파일은 YAML이며 스키마 검증을 통과해야 한다. 모르는 키, 범위를 벗어난 값은 거부한다.
- 판정기는 `@aot/policy`의 자체 TypeScript 코드다. 같은 정책과 같은 요청이면 항상 같은 결과를 낸다(시각·난수·외부 호출을 쓰지 않는다).
- 정책 버전은 정규화된 내용(파싱·검증한 문서를 키 정렬 JSON으로 직렬화한 것)의 SHA-256 해시다. 주석·공백·키 순서는 버전을 바꾸지 않는다. `policy_version.content_hash`가 이 값이다.
- 세부 형식(키 목록, 판정 결합 방식)은 구현과 함께 이 ADR의 Amendment로 적는다.
- 규칙이 복잡해지면(조건식, 속성 기반 조합 등) Cedar로 이식하는 것을 검토한다. 지금은 기록만 한다.

## Consequences
- 의존성 없이 판정을 시험으로 고정할 수 있다. 판정 근거가 코드에 있으므로 판정기 변경도 정책 변경과 같은 무게로 검토한다.
- 표현력이 작다. 표현할 수 없는 규칙이 필요해지면 형식을 넓히기 전에 Cedar 이식을 먼저 비교한다.
