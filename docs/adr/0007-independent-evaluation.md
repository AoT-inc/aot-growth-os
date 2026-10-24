# ADR-0007 독립 평가와 안전성 거부권

상태: proposed

## Context
에이전트 시스템은 수행에 초점을 두고, 결과 평가가 다음 업무에 영향을 주지 못하는 경우가 많다. "다른 에이전트가 검토"만으로는 독립적이지 않다.

## Decision
**검증(validation)과 평가(evaluation)를 분리한다.**

1. 검증 = 완료 조건 충족 판정. 순서를 고정한다.
   1. 결정론적 검사: 출처 URL 접근, 인용문 원문 존재, 중복, 예산, 정책 준수, 스키마.
   2. LLM 검증: 실행 에이전트와 컨텍스트·프롬프트·세션을 공유하지 않는 별도 호출. 가능하면 다른 모델.
   3. 필요 시 사람 검토(`needs_review`).
2. 평가 = 네 축을 **별도 필드**로 기록한다.
   - `quality` 결과 품질, `effect` 업무 효과, `economics` 경제성(총비용·사람 개입 시간 포함), `safety` 안전성.
3. **안전성은 합산 불가 필수 조건**이다. `safety = fail`이면 다른 점수와 무관하게 결과는 실패이며, 이후 전략 갱신에서 성공 사례로 쓰지 않는다 (예: 승인 없이 계약을 확정하면 매출이 커도 실패).
4. 평가 결과는 `evaluation` 테이블에 근거와 함께 저장되고, 전략 개선 제안의 입력이 된다.
5. 평가기 자체도 버전 관리하며, 평가 기준 변경은 정책 변경 절차에 준한다.

## Consequences
- 평가기 구축이 에이전트 구축만큼의 비용이 든다. 이것이 차별화 지점이다.
- 효과 측정은 MVP에서 측정 신호 1개로 한정한다.

## Amendment (2026-10-14): 판정 3종과 원본 증거
- 평가 판정은 `pass` / `fail` / `inconclusive`. 증거가 부족하면 억지로 결정하지 않는다. `inconclusive`는 성공·실패 사례로 학습에 쓰지 않는다.
- 평가기는 에이전트 보고서가 아니라 **원본 증거**(게시 콘텐츠·시각, 적용 페이지 버전, 실제 유입·전환, 비용 원장, 기준선)를 직접 조회한다. 보고서만으로 `pass` 불가.
- 판단 층: 결정론적 검증 / LLM 검증 / 사업 성과 평가를 구분한다.
- 상세는 [operations/evaluation.md](../operations/evaluation.md).

## Amendment (2026-10-21): 판정의 후속과 구현 경계 (A4)
- 업무: 평가 `inconclusive`는 `validating → needs_review`다(`retry_wait`가 아님). 증거 부족을 재시도로 덮지 않고 사람이 확인한다. 조직 제안: `inconclusive`는 재시험 승인 전까지 종료로 취급하며 별도 상태를 추가하지 않는다 ([state-machines](../schema/state-machines.md)).
- 검증기·평가기는 `@aot/evaluation`이 구현하고 업무 상태 전이는 하지 않는다. 판정은 domain 의 `TaskValidator` 포트로 `task-engine`에 전달되고, 전이는 `task-engine`이 허용표대로 한다(경계 lint 유지, 조립은 `apps/daemon`).
- LLM 검증은 인터페이스(`LlmVerifier`)만 정의한다. 입력은 원본 출처와 검증 대상 주장 문장, 명세의 완료 조건뿐이며 프롬프트·세션·보고서 전문은 타입에 자리가 없다. 실제 모델 선택은 [Q22](../open-questions.md).
- 평가기 고정 코어: 평가기 로직은 코드이며 `evaluation.evaluator`에 `id@version`을 남긴다. 버전 변경을 정책 변경 절차에 연결하는 방법(정책 형식에 고정 키를 둘지)은 [Q27](../open-questions.md)로 남긴다.

## Amendment (2026-10-24): 측정 신호 정의 형식 (D2, A6-U10)
- 사업 성과(`effect`)의 측정 신호 1개는 정의 형식을 따른다: `id`, `description`, `page_ref`(별칭 키만, 실제 주소·제품명은 `instance/`), `action`, `period`(`iso_week`), `tz`(IANA), `min_observations`(정수 ≥ 1), `attachment_required`(`true` 고정), 선택 `pass_threshold`(단위 없음). 형식 검증은 `@aot/domain`의 `validateMeasurementSignal`이 하고, 정의는 도메인 팩이 선언한다([ADR-0012](0012-extension-unit-contract.md)).
- Phase A 의 "원본 증거"는 사람이 입력한 값과, 값마다 첨부한 `evidence`(화면·내보내기 파일)다. 근거 없는 값(`attachment_required`를 끈 정의)은 형식 검증이 거부한다. 에이전트 보고서는 여전히 원본 증거가 아니다. 읽기 전용 분석 API 연결과 `min_observations` 판정 규칙의 사용은 후속(U13 이후)이다.

## Amendment (2026-10-24): 사람이 입력한 측정 값의 조회 (A6-U13)
- 평가기는 사람이 입력한 측정 값을 `EffectSignalSource` 포트로만 읽는다(`createMeasurementSignalSource`, 읽기 전용). 값은 사람 채널(승인 소켓의 `measure`, `actor.kind='human'`만)로 들어온 `event`(`measurement:<신호 id>@<ISO 주>`)이고, 원본 증거로 인정되는 조건은 데이터 품질 판정에 넣었다: 사람이 품질을 `good`으로 밝혔고, 첨부(파일 sha256)가 하나 이상이며 그 전부가 업무의 `internal` 근거 행으로 남아 있을 것. 어느 하나라도 아니면 `poor_quality`, 사람이 밝힌 관측 수가 `min_observations`보다 적으면 `insufficient`이고, 둘 다 기존 규칙대로 `inconclusive`다. 포트의 `EffectSignal`에 선택 필드 `observations`(값 1개가 모은 관측 수; 생략하면 `values.length`)와 `qualityNote`(기록용)를 더했다. 판정 순서·규칙은 바뀌지 않았다.


## Amendment (2026-10-24): 실험 후보 비교 (A6-U14)
- 주간 사이클 5단계의 후보 비교기(`compareCandidates`)는 평가기와 같은 독립 원칙을 따른다: 에이전트가 낸 기대 효과·추정 비용은 *참고*로 순서를 정하는 데만 쓰고 비교 기록의 `agent_claim` 아래에만 둔다. 비교기가 스스로 확인한 사실(정책 위험 판정, 신호 정의·예산 대조, 기준선, 합격선)과 섞지 않으며, 기준선이 관측 수 부족·데이터 품질 불량·측정 불가면 평가와 같이 `inconclusive`(후보를 고르지 않음)다. 합격선은 기준선 대비로 비교기가 정한다. 위험 판정은 함수로 주입되므로 evaluation 은 policy 를 참조하지 않는다. 규칙의 정본은 [evaluation §7](../operations/evaluation.md).
