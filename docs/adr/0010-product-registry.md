# ADR-0010 개발 상품 레지스트리와 절차적 등록

상태: proposed (2026-10-14 개정: 사전 등록 → 절차적 등록)

## Context
Growth OS는 기업이 개발·운영하는 제품을 대상으로 업무(개발·마케팅·지원·릴리스)를 생성하고 성과를 평가해야 하므로, 제품이 시스템 안에서 식별 가능한 객체여야 한다.

다만 이 저장소는 공개 저장소로 올릴 예정이다. 실제 제품명, 로컬 경로, 저장소 주소를 설계 문서나 시드 파일로 미리 넣으면 내부 정보가 공개되고, 검증되지 않은 정보가 에이전트 입력 근거가 될 위험이 있다. 또한 제품 등록은 시스템이 제공하는 절차(검증·승인)를 거쳐야 그 자체로 시스템의 첫 번째 검증 사례가 된다.

## Decision
1. `product`를 1급 엔터티로 둔다: slug, 이름, 설명, `lifecycle_stage`, `registration_status`, 책임 `org_unit`(선택), 저장소(`product_repo`), 환경(`product_environment`).
2. **제품은 저장소에 사전 등록하지 않는다.** 내부 개발 환경에서 앱과 데몬이 구동된 뒤, [등록 절차](../products/README.md)로 등록한다: `candidate → verifying → pending_approval → registered` (또는 `rejected`).
3. **진실 원본은 DB**다. 등록 데이터는 내부 인스턴스 DB에만 있고 공개 저장소에 커밋하지 않는다. YAML 시드 방식은 쓰지 않는다 (이전 Q10 해소). 이 저장소에는 스키마, 절차, 가상 예시(`example-product`)만 둔다.
4. 후보 단계에서는 사람이 이름과 위치만 입력한다. 사실 정보(스택, 단계, 원격, 브랜치)는 **검증 업무가 읽기 전용으로 수집**하고, 증거와 함께 사람이 승인한 뒤에야 `registered`가 된다. 검증되지 않은 정보를 업무 입력 근거로 쓰지 않는다.
5. `task`, `event`, `cost_entry`, `evaluation`, `memory_item`, `publication`은 선택적으로 `product_id`를 갖되, `registered` 제품만 가리킬 수 있다.
6. 저장소 접근은 `product_repo.access_scope`(기본 `none`)와 정책 판정을 모두 통과한 경우로 한정한다.
7. 제품 등록 승인과 단계 변경은 일반 변경이지만, `live` 전환과 운영 환경 접근 권한 부여는 위험 변경이다 ([ADR-0006](0006-policy-separation.md)).
8. MVP는 `Product`, `Repository`(, `Environment`)만 구현한다. Release, Capability, CustomerFeedback, Incident, ProductDecision은 후속 엔터티다 ([schema/product.md](../schema/product.md)).
9. 등록 절차를 Phase A 이후의 첫 실제 업무로 수행한다. 첫 시장 조사 사이클의 `product_id`는 등록 완료 후 연결한다 (등록 전에는 `NULL`).

## Consequences
- 공개 저장소에 내부 정보가 들어가지 않는다 ([security/public-repository.md](../security/public-repository.md)).
- 등록 절차가 검증·승인·증거 흐름의 도그푸딩이 된다.
- 레지스트리를 코드로 재현할 수 없으므로, 내부 인스턴스 백업과 마이그레이션이 필요하다.
- 제품 하나가 여러 저장소를 가질 수 있다(1:N).
