# ADR-0008 기억과 전략의 분리

상태: proposed

## Context
대화 로그를 기억으로 쓰면 사실·추측·약속이 섞이고 출처가 사라진다. 전략과 기억을 같은 방식으로 갱신하면 잘못된 추론이 방향을 바꾼다.

## Decision
**기억(memory_item)**
- 종류: `fact`(검증된 사실·공식 문서), `commitment`(고객 약속), `measurement`(실험·측정), `hypothesis`(미검증), `strategy_record`(과거 전략과 성과), `lesson`(실패와 수정된 교훈).
- 필수: `source_ref`, `created_at`, `validity`(`valid | stale | superseded | refuted`), `valid_until`(선택), 관련 `policy_version`/`strategy_version`.
- `hypothesis`는 검증 업무를 거쳐야 `fact`로 승격한다. 에이전트는 `hypothesis`까지만 직접 작성할 수 있다.
- 갱신은 덮어쓰기가 아니라 `superseded_by` 연결.

**전략(strategy_version)**
- 버전과 근거(`evidence_refs`, `evaluation_refs`)를 가진 의사결정 방향.
- 시스템은 **변경안(`strategy_proposal`)** 을 만들 수 있고, 적용에는 사람 승인과 롤백 지점이 필요하다. 실험은 제한된 범위·기간으로 시작한다.
- 보안 정책과 권한 체계는 전략이 아니며 같은 경로로 수정할 수 없다([ADR-0006](0006-policy-separation.md)).

## Consequences
- 검색 시 `validity`와 종류에 따라 필터·가중이 가능하다.
- 벡터 검색 등 구현 방식은 이 ADR의 범위 밖(별도 ADR).

## Amendment (2026-10-14): 기억 항목 속성
`memory_item`에 `observed_at`, `verification_status`, `sensitivity`, `trust_origin`을 추가하고 `valid_until`을 재검토 시점으로 쓴다. 외부 입력 유래 정보는 `hypothesis`/`unverified`로 시작하며 외부 콘텐츠 안의 지시는 기억이 아니라 데이터다. 상세는 [schema/memory-item.md](../schema/memory-item.md).
