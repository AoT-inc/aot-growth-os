# 상품 최소 도메인 모델

ADR-0010의 구체화. MVP는 `Product`와 `Repository`만 구현하고, 첫 시장 조사·마케팅 실험이 어떤 제품에 관한 것인지 추적할 수 있으면 충분하다. 나머지는 연결 지점만 확보한다.

## MVP 범위 (스키마 있음)

| 엔터티 | 테이블 | 핵심 필드 |
|---|---|---|
| Product | `product` | `slug`, `name`, `kind`(`software\|physical\|service\|other`), `lifecycle_stage`, `registration_status`, `owner_org_unit_id` |
| Repository | `product_repo` | `local_path`, `remote_url`, `default_branch`, `stack`, `access_scope` |
| Environment | `product_environment` | `name`, `url`, `access_class` |

`task`, `event`, `cost_entry`, `memory_item`, `publication`은 선택적 `product_id`로 제품과 연결된다. 소유 부서(`owner_org_unit_id`)는 조직이 적응형이므로 조직 관리팀이 역할을 만든 뒤 지정하며, 시작 시에는 비어 있을 수 있다.

## 후속 (스키마 아직 없음, `product_id`로 연결 예정)

| 엔터티 | 목적 | 도입 시점 |
|---|---|---|
| Release | 버전, 변경 사항, 테스트·배포 기록 | 생산·개발 역할 활성화 시 |
| Capability | 제품이 실제 제공하는 기능 (마케팅 주장의 근거) | 마케팅 주장 검증 시 — 주장과 실제 기능의 일치 검사에 필요 |
| CustomerFeedback | 고객 피드백과 출처 (외부 입력, `external_untrusted`) | 고객 지원 활성화 시 |
| Incident | 장애·해결 이력 | 운영 환경 연동 시 |
| ProductDecision | 제품 방향 변경의 근거와 승인 | 전략 버전과 연계 시 (`strategy_version` 하위로 둘지 분리할지 미정) |

## 규칙

- 제품은 [절차](../products/README.md)(`candidate → verifying → pending_approval → registered`)로만 등록한다. `registered`가 아닌 제품은 업무의 `product_id`가 될 수 없다.
- 사실 필드(스택, 원격, 브랜치, 단계)는 읽기 전용 검증 업무의 증거를 사람이 승인한 뒤에만 채워진다.
- 이 저장소에는 실제 제품 데이터를 두지 않는다. 예시는 `example-product`만 사용한다 ([public-repository](../security/public-repository.md)).
- `lifecycle_stage`의 `live` 전환과 운영 환경 접근 부여는 위험 변경이다.
- 저장소 접근은 `access_scope`(`none` 기본)와 정책 판정을 모두 통과해야 한다.
- 제품 하나는 여러 저장소를 가질 수 있다(1:N). 저장소는 선택이며 0개도 허용한다(소프트웨어가 아닌 상품 등, [ADR-0012](../adr/0012-extension-unit-contract.md) §5).
- `kind`는 필수이며 기본값이 없다. 등록 시 사람이 명시한다.
- 레지스트리의 진실 원본은 내부 인스턴스 DB다 (YAML 시드 없음, ADR-0010).
