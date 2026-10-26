# 상품 등록 절차

이 저장소는 공개 저장소다. **실제 제품의 이름, 경로, 저장소 주소, 내부 구성은 이 저장소에 두지 않는다.** 제품은 시스템이 내부 개발 환경에서 가동된 뒤 아래 절차로 등록되며, 등록 데이터는 내부 DB(`instance/`, 커밋 제외)에만 존재한다 ([ADR-0010](../adr/0010-product-registry.md), [공개 저장소 규칙](../security/public-repository.md)).

## 선행 조건

1. 내부 개발 환경에서 앱과 데몬이 구동되고 있다 (Phase A의 업무 엔진 검증 통과).
2. 정책 엔진과 승인 경로가 동작한다.

## 등록 절차

```
candidate ─► verifying ─► pending_approval ─► registered
                │                 │
                └──► rejected ◄───┘            registered ─► (단계 변경은 일반 변경, live 전환은 위험 변경)
```

| 단계 | 주체 | 내용 |
|---|---|---|
| 1. 후보 등록 (`candidate`) | 사람(오너) | 이름, 로컬 저장소 경로 또는 원격 주소만 입력. 에이전트 접근 권한 없음(`access_scope=none`) |
| 2. 검증 (`verifying`) | 등록 검증 업무 (읽기 전용 역할) | 명세 기반 업무 [`workflows/product-registration`]: 저장소 구조·스택·README·원격·기본 브랜치·활동 이력을 **읽기 전용**으로 수집. 비밀값 스캔, 라이선스 확인, 공개 가능 여부 분류. 결과는 `evidence`로 저장 |
| 3. 승인 대기 (`pending_approval`) | 평가기 + 사람 | 수집 사실과 근거를 사람이 확인. 공개/내부 분류, 소유 역할, 저장소 접근 범위 결정. 권한 부여는 정책 승인 |
| 4. 등록 (`registered`) | 사람 승인 (`approval`, `subject_kind='product'`) | `product`, `product_repo` 기록, `verified` 근거 연결, 이후 업무에서 `product_id` 사용 가능 |

## 이 절차를 수행하는 법

사람용 `product` 명령(승인 CLI, [절차서](../operations/shadow-pilot.md)): `product add`(후보 등록) → `product start`(검증 업무 생성·읽기 접근 승인) → `product status`/`evidence`(증거 확인) → `product decide approve|reject`(등록·반려). 상품 등록 도구 설정(`registration_tools`)이 있어야 켜진다.

## 규칙

- 등록 전 제품은 업무 입력 근거로 쓰지 않는다. 업무의 `product_id`는 `registered` 제품만 가리킬 수 있다.
- 검증 업무는 제품 저장소를 수정하지 않는다. 저장소 접근은 읽기 전용이며 정책 판정을 통과해야 한다.
- 등록 중 발견한 비밀값, 고객 데이터, 비공개 내용은 기억(`memory_item`)에 `restricted`로 저장하거나 저장하지 않는다.
- 이 절차 자체가 첫 번째 실제 업무(도그푸딩)로 Phase A 이후에 수행된다.
- 예시와 테스트 데이터는 가상의 `example-product`를 사용한다.
