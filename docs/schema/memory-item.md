# 기억 항목 (memory_item)

ADR-0008의 구체화. 기억은 대화 로그가 아니라 **출처, 신뢰 상태, 유효 기간**을 가진 기업 지식이다.

## 속성

| 속성 | 목적 | 값 |
|---|---|---|
| `kind` | 주장의 성격 | `fact`(검증된 사실·공식 문서), `commitment`(고객 약속), `measurement`(실험·측정 결과), `hypothesis`(미검증 가설·추론), `strategy_record`(과거 전략과 성과), `lesson`(실패와 수정된 교훈) |
| `source_ref` | 원본 문서·이벤트·증거 참조 | 필수. 없으면 저장 거부 |
| `observed_at` | 실제로 관측한 시점 | 필수. `created_at`(기록 시점)과 구분 |
| `verification_status` | 검증 여부 | `unverified`, `verified`, `refuted` |
| `validity` | 현재 유효성 | `valid`, `stale`, `superseded`, `refuted` |
| `valid_until` | 유효 기간/재검토 시점 | 경과하면 `validity='stale'`로 전환 |
| `superseded_by` | 이 항목을 대체하는 항목 | 이전 항목은 삭제하지 않음. 대체 관계의 역방향(`supersedes`)은 조회로 도출 |
| `sensitivity` | 공개 범위·민감도 | `public`, `internal`, `confidential`, `restricted` |
| `trust_origin` | 출처의 신뢰 | `internal`, `external_untrusted`. 같은 어휘를 `evidence.trust_origin`(근거 행, 필수·기본값 없음)도 쓴다 |
| `product_id`, `policy_version_id`, `strategy_version_id` | 관련 객체 | |

`verification_status`(검증을 했는가)와 `validity`(지금도 유효한가)는 독립이다. 검증된 사실도 시간이 지나면 `stale`이 된다.

## 규칙

1. **현재 사실로 취급하는 조건**: `validity='valid'` AND `verification_status='verified'` AND (`valid_until` 없음 또는 미경과). 반증(`refuted`)된 항목과 만료된 항목은 현재 사실로 조회되지 않는다. 과거 관측으로는 조회 가능하다.
2. **삭제하지 않고 대체한다.** 경쟁사 가격이 바뀌면 새 항목을 만들고 이전 항목의 `superseded_by`를 연결한다. "그때는 사실이었다"는 이력이 남는다.
3. **외부 입력에서 온 정보는 `kind='hypothesis'`, `verification_status='unverified'`, `trust_origin='external_untrusted'`로 시작한다.** 승격은 검증 업무(출처 교차 확인 등)를 거쳐야 하며, 에이전트가 직접 `fact`를 쓸 수 없다.
4. **외부 콘텐츠 안의 지시문은 기억이 아니다.** 지시로 읽힐 수 있는 문장은 인용 데이터로만 저장하고 어떤 업무 입력에서도 지시로 전달되지 않는다 ([trust-boundaries](../security/trust-boundaries.md)).
5. `valid_until`이 없는 `fact`는 허용하지만, `measurement`·가격·정책 해석·시장 데이터 같은 변동성 높은 종류는 기본 만료 기간을 둔다(정책 파라미터).
6. `commitment`는 만료로 `stale`이 되지 않고, 이행/취소로만 종료된다.
7. `sensitivity`가 `confidential` 이상인 항목은 `publication`의 입력으로 사용할 때 정책 승인이 필요하다.
8. `inconclusive` 평가 결과는 `lesson`/`strategy_record`의 성공 사례로 저장하지 않는다 ([evaluation](../operations/evaluation.md)). 구현(A4): `source_ref`가 `evaluation:<id>`이고 그 평가가 `inconclusive`이면 `createMemoryItem`이 `lesson`/`strategy_record` 저장을 거부한다(`inconclusive_not_learnable`). 성공·실패 어느 쪽 사례도 아니므로 "성공 사례만"이 아니라 두 종류 모두에서 막는다. 존재하지 않는 평가 참조도 거부한다.

9. **외부 입력 유래 근거에서 온 항목은 신뢰된 것으로 편입되지 않는다.** `source_ref`가 `evidence:<id>`이면 그 근거의 `evidence.trust_origin`을 확인한다(존재하지 않는 근거 참조는 거부). 근거가 `external_untrusted`이면 항목도 `external_untrusted`다: `trust_origin`을 생략하면 근거의 값을 물려받고, `internal`로 적으면 거부한다(`untrusted_evidence_origin`). 그러면 규칙 3이 `hypothesis`/`unverified`로만 저장하게 하므로 외부 근거는 기억으로 들어와도 현재 사실이 되지 못한다. **에이전트가 낸 근거는 항상 `external_untrusted`다**: 어댑터 계약의 `EvidenceItem.trust_origin`은 참고용 자기 신고(어휘만 검증)이고, 호스트가 에이전트 출력을 `evidence` 행으로 저장할 때 어댑터가 `internal`이라 밝혀도 `external_untrusted`로 쓴다(A5-U8). 그래서 에이전트 경로의 근거로는 규칙 9의 `internal` 편입 길이 열리지 않는다. `internal` 근거는 에이전트 출력이 아닌 경로(시드, 사람·데몬 내부가 쓰는 행)에서만 생긴다. 검증(`evidence.verified`)은 신뢰 출처를 바꾸지 않는다.

## 실험 결과 기록 (A6-U16)

주간 사이클 7단계가 실험 한 건의 결과를 기억에 남기는 절차다([evaluation §8](../operations/evaluation.md)). 기록은 전략(`strategy_version`)당 한 번(event `experiment-result:<전략 id>`)이고 기억 항목 둘과 결과 event가 한 쓰기 트랜잭션에 묶인다.

| 항목 | `kind` | `source_ref` | `verification_status` | 내용 |
|---|---|---|---|---|
| 측정 | `measurement` | `evidence:<검토 업무의 측정 근거 id>` (규칙 9: 근거의 신뢰 출처를 물려받는다) | 평가가 효과를 측정했으면 `verified`, 아니면 `unverified` | 신호·주·측정 구간·값·관측 수·데이터 품질·기준선·합격선·효과(기준선 대비 상승, 합격선 충족 여부)·입력한 사람. 값은 사람이 입력한 측정 이벤트(원본)에서 읽는다 |
| 전략 기록 | `strategy_record` | `evaluation:<id>` (규칙 8) | `verified` | 전략 id·결론(`pass`/`fail`)·평가 id·측정 값·기준선·합격선·**실험 총비용**(총 USD, 범주별 USD, 토큰, 사람 시간 분, 업무 목록) |

- **만들어지는 때.** 결과 검토 업무의 평가가 `pass`일 때, 그리고 `fail`이면서 업무가 더 시도하지 않을 때. **`inconclusive`는 `strategy_record`·`lesson`·`measurement` 어느 것도 만들지 않는다**(규칙 8, `inconclusive_not_learnable`; 사람 검토 대기).
- **신뢰.** 두 항목은 시스템이 계산한 값과 사람이 입력한 값만 담으므로 `internal`이다. 기획·검토 에이전트의 문장(가설, 보고서)은 복사하지 않는다 — 다음 주 입력으로 읽혀도 지시가 될 수 없다(규칙 4). 측정의 근거 행이 `external_untrusted`이면 규칙 9·3에 따라 `kind='hypothesis'`, `unverified`, `external_untrusted`로만 쓴다.
- **행위자.** `created_by`는 그 측정 값을 입력한 사람(`actor.kind='human'`)이다. 결론은 평가기가 도출한 것이지 그 사람의 판단이 아니다(`source_ref`가 평가). 에이전트는 이 종류를 쓸 수 없다(규칙 3의 에이전트 제한 그대로).
- **관측 시점.** `observed_at`은 실험 주가 끝난 순간(측정 구간 끝)이고 기록 시점(`created_at`)과 다르다.
- **실험 총비용.** 그 전략을 `task.strategy_version_id`로 가진 업무들(실험 업무, 결과 검토 업무)의 `cost_entry` 합계(모든 범주)에, 업무에 붙지 못한 측정 입력의 사람 시간(`task_id` 없음, `units.measurement` = 그 측정 키)을 더한다. 같은 줄을 두 번 세지 않으며 기록 시점의 원장 합계와 같다.
- **만료.** 정책 파라미터 `memory.default_validity`(규칙 5)로만 정한다. 값이 비어 있으면(Q17은 열려 있다) 만료 없음이다.
- **다음 주 입력.** 업무 명세의 `inputs[kind='memory']`: `memory:<id>`(그 항목이 *지금 현재 사실*이어야 한다, 아니면 생성 거부 `memory_not_current`) 또는 선택자 `memory:latest#strategy_record`(같은 상품의 가장 최근 현재 사실로 바뀌고 없으면 입력이 빠진다). 반증·만료·대체·미검증·외부 유래(`hypothesis`) 항목은 현재 사실이 아니므로 입력에 들어가지 않는다. 항목 내용은 명세에 복사하지 않고 참조만 남긴다.

## 필수 테스트

- 반증된/만료된 항목이 현재 사실 조회에서 제외된다.
- 대체된 항목이 삭제되지 않고 과거 관측으로 조회된다.
- 에이전트가 `fact`를 직접 생성할 수 없다.
- 외부 입력 유래 항목이 `unverified`/`external_untrusted`로 저장된다.
- `external_untrusted` 근거(`evidence:<id>`)에서 온 항목은 `internal`/`fact`/`verified`로 저장되지 않고 현재 사실 조회에 나오지 않는다. `evidence.trust_origin`은 NOT NULL·기본값 없음·어휘 CHECK다. 어댑터가 근거를 `internal`로 밝혀도 저장 값은 `external_untrusted`이고 그 근거로 `internal` 기억을 만들 수 없다.
- `inconclusive` 평가를 근거로 한 `lesson`/`strategy_record`가 저장되지 않는다.
- 실험 결과 기록: `pass`·`fail`이면 `measurement`와 `strategy_record`가 만들어지고 기록된 비용이 원장 합계와 같다. `inconclusive`는 아무 항목도 만들지 않는다. 같은 평가로 두 번 기록하지 않는다.
- `memory:latest#strategy_record` 입력은 반증·만료·외부 유래 항목을 빼고, 구체 참조가 현재 사실이 아니면 생성이 거부된다.

