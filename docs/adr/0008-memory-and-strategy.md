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

## Amendment (2026-10-23): 근거의 신뢰 출처
`evidence`에도 `trust_origin`(필수, 기본값 없음, `memory_item`과 같은 어휘)을 둔다. 외부 입력에서 만든 근거(`external_untrusted`)를 `source_ref = evidence:<id>`로 가리키는 기억 항목은 같은 신뢰 출처를 물려받고 `internal`로 적을 수 없으므로, 기존 규칙(외부 입력 유래는 `hypothesis`/`unverified`)에 따라 근거를 거쳐도 현재 사실이 되지 않는다. 규칙 9, [memory-item](../schema/memory-item.md).

## Amendment (2026-10-24): 실험 결과의 기억과 전략 상태 (A6-U16)
- 실험의 실제 결과는 `measurement`(측정 값·기준선·효과)와 `strategy_record`(전략·결론·실험 총비용)로 기억에 남는다. 값은 시스템이 계산한 것과 사람이 입력한 원본만 담고 기획·검토 에이전트의 문장은 복사하지 않는다(다음 주 입력으로 읽혀도 지시가 될 수 없다). 다음 주 기획 업무는 현재 `active` 전략과 가장 최근 *현재 사실* `strategy_record`를 입력으로 받는다(반증·만료·대체·외부 유래 항목은 제외). 전략 상태 허용표에 `experiment → rejected`(사람 또는 평가 `fail`일 때 시스템, 사유 필수, 에이전트 불가)를 더했다: 판정에 실패했거나 활성화가 거부된 실험이 `experiment`에 남아 다음 실험 승인을 막지 않게 한다. `experiment → active` 승격은 기록된 결과가 `pass`일 때 사람만 하고 이전 `active`는 `retired`로 둔다. 절차는 [memory-item "실험 결과 기록"](../schema/memory-item.md), [state-machines](../schema/state-machines.md).

