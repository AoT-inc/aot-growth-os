# ADR-0012 확장 단위 계약: 선언형 도메인 팩과 커넥터

상태: accepted (2026-10-19, [a0-decisions D7](../plans/a0-decisions.md))

## Context
여러 업종에 적용하려면 "업종별로 무엇을 더하는가"가 코어와 분리되어야 한다. 계획은 주간 마케팅 사이클을 코어처럼 다루고, `product`는 소프트웨어 저장소 중심이며, 업종별 업무·검증기·도구를 더하는 단위가 정의되어 있지 않았다. 선택지는 (A) 포크, (B) 선언형 팩만, (C) 코어 프로세스에 로드하는 코드 플러그인, (D) 선언형 팩 + 게이트웨이 계약을 따르는 커넥터였다. C는 플러그인이 DB·정책에 직접 접근해 신뢰 경계([trust-boundaries](../security/trust-boundaries.md))가 무너지고, B는 결정론적 검증기·커넥터를 만들 수 없다.

## Decision
**D를 택한다.** Phase A에서는 계약의 **경계만** 정하고 범용 플러그인 체계는 만들지 않는다.

### 1. 팩 구성
저장소의 `packs/<pack-name>/` 아래에 둔다.

| 구성 | 내용 |
|---|---|
| `manifest` | 이름, 버전, 요구 코어 버전, 필요한 도구 |
| 업무 명세 템플릿 | `workflows/` ([task-spec](../schema/task-spec.md) 형식) |
| 루틴 | `routines/` |
| 검증 규칙 | `evaluations/`: 결정론적 검사 id와 LLM 검증 프롬프트 |
| 정책 **예시** | 실제 정책은 `instance/`에서 사람이 승인한다 |
| 측정 신호 정의 | 팩이 단위를 선언한다. 정의 형식은 A1에서 정한다 |

### 2. 커넥터·검증기 코드는 별도 프로세스
도구 게이트웨이 계약으로만 호출된다. DB와 `policies/`에 접근할 수 없고, 비밀값은 게이트웨이가 주입한다 ([trust-boundaries §3](../security/trust-boundaries.md)). 코어 프로세스에 로드하지 않는다.

### 3. 팩이 할 수 없는 것
- 정책 변경
- 검증기·평가기 교체 (버전 변경은 정책 변경 절차)
- 스키마 변경

팩은 정의를 **제공**할 뿐이며, 채택과 권한은 코어의 정책·승인 경로가 정한다 ([ADR-0006](0006-policy-separation.md), [ADR-0011](0011-adaptive-organization.md)).

### 4. 검증 방법
주간 시장 조사 사이클을 코어에 넣지 않고 첫 팩 `packs/example-marketing`으로 구현한다. 코어 코드 수정 없이 두 번째 팩(예: 상품 등록 검증)을 더할 수 있으면 계약이 성립한 것으로 본다.

### 5. 업종 중립성 스키마 보강 (A1)
- `product`에 `kind`(`software|physical|service|other`)를 둔다.
- `product_repo`는 선택이다. 저장소는 1:N이므로 0개를 허용한다.
- 비용 원장은 LLM·도구 비용이 USD로 청구되므로 USD를 유지한다. 사업 성과 지표는 팩이 단위를 선언한다.

## Consequences
- **A0:** 저장소 골격에 `packs/`를 두고, 모듈 경계 lint에 "팩은 코어 내부 모듈을 참조하지 않는다"를 추가한다 ([phase-a §4](../plans/phase-a.md)). 팩은 manifest와 게이트웨이 계약으로만 코어와 만난다.
- **A1:** 위 스키마 보강을 [schema.sql](../schema/schema.sql)과 [product](../schema/product.md)에 반영한다. 이 ADR은 스키마 파일을 바꾸지 않는다.
  - 반영 완료 (2026-10-19): `product.kind` 추가, `product_repo` 0개 허용 명시. 팩 manifest 형식은 `validatePackManifest`가 검증한다. 측정 신호 정의 형식은 아직 정하지 않았다 ([Q5](../open-questions.md)와 함께).
- 주간 사이클이 코어에서 빠지므로 [overview](../00-overview.md)의 주간 사이클 서술은 "첫 팩의 내용"으로 읽는다. 문서 정리는 A0 중에 한다.
- 계약 설계 비용이 생긴다. 범용 로더·마켓플레이스·서명 체계는 범위 밖이며, 두 번째 팩이 실제로 필요해질 때 확장한다.
- 팩의 커넥터는 외부 코드이므로 [ADR-0005](0005-agent-adapter-boundary.md)의 어댑터와 같은 격리·비용 계량 요건을 받는다.
