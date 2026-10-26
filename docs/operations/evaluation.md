# 평가 운영 규칙

ADR-0007의 구체화. 검증(validation)과 평가(evaluation)를 분리하고, 평가의 독립성과 판정 종류를 정한다.

## 1. 세 가지 판단 층

| 층 | 무엇을 | 입력 | 판정 주체 |
|---|---|---|---|
| 결정론적 검증 | 스키마, URL 접근, 인용 존재, 중복, 예산, 권한, 필수 테스트 | 원본 증거 | 코드 |
| LLM 검증 | 주장-근거 의미 일치, 내용의 유용성, 누락된 위험 | 원본 증거 + 격리된 컨텍스트 | 실행 에이전트와 다른 호출(가능하면 다른 모델) |
| 사업 성과 평가 | 사전에 정한 기준 대비 실제 측정값 | 측정 데이터, 비용 원장, 기준선 | 평가기 |

안전성은 별도 필수 통과 조건이며 층과 무관하게 거부권을 가진다.

## 2. 판정 종류

업무 평가(`evaluation.outcome`)와 조직 시험(`org_trial_result.outcome`) 모두 세 가지다.

| 판정 | 의미 | 후속 |
|---|---|---|
| `pass` | 사전 정의한 성공 기준을 충분한 증거로 충족 | 업무 `completed` / 조직 `active` 승격 후보 |
| `fail` | 실패 기준 충족 또는 안전성 위반 | 업무 `retry_wait`/`failed` / 조직 `rolled_back` |
| `inconclusive` | 증거 부족(관측 수 미달, 데이터 품질 불량, 측정 불가, 원본 증거 없음) | 업무 `needs_review`(평가 `inconclusive` 포함, 2026-10-21 결정) / 조직 `inconclusive`(재시험 승인 전까지 종료 취급, 별도 상태 없음) |

평가기는 증거가 부족할 때 성공·실패를 억지로 결정하지 않는다. `inconclusive`는 실패도 성공도 아니며, 어느 쪽 사례로도 전략 갱신에 쓰지 않는다.

## 3. 평가 독립성

1. **원본 증거 우선.** 평가기는 `primary_evidence_refs`로 원본(게시된 콘텐츠와 게시 시각, 적용된 페이지 버전, 실제 유입·전환 수, 비용 원장, 기준선)을 직접 조회한다.
2. 실행 에이전트의 보고서(`task_run.result`)는 **참고 자료**이며 `agent_report_used=1`로 표시한다. 보고서만으로 `outcome='pass'`를 낼 수 없다.
3. 평가기는 실행 에이전트와 컨텍스트·세션·프롬프트를 공유하지 않는다.
4. 조직 변경은 조직 관리팀이 아닌 평가기가 판정한다. 평가기와 평가 기준은 고정 코어이며 변경은 정책 변경 절차를 따른다.
5. 평가기 버전을 `evaluator` 필드에 기록한다.

## 4. 조직 시험(trial) 종료 조건

시간 경과만으로는 시험이 끝나지 않는다. 제안(`org_proposal.evaluation_plan`)에 `trial` 진입 **전에** 다음을 확정한다.

| 항목 | 내용 |
|---|---|
| 성공 기준 | 측정 지표와 임계값 (예: 보고서 검증 통과율 ≥ X%, 업무당 사람 개입 ≤ Y분) |
| 실패 기준 | 위 반대 방향 임계값 |
| 즉시 중단 조건 | 안전성 위반, 예산 초과, 심각한 품질 저하 |
| 허용 비용 | 시험 기간 총 비용 상한 |
| 최소 관측 횟수 | 시험 범위 업무가 최소 N건 실행되어야 판정 가능 |
| 데이터 품질 조건 | 측정 누락률 상한 등 |
| 비교 기준선 | 변경 전 동일 지표 (동일 기준으로 전후 비교) |
| 평가 기간 | 최소 기간 (기본 14일) |

종료 판정

```
즉시 중단 조건 충족           → fail  (abort_reason 기록) → rolled_back
기간 경과 AND 관측 수 ≥ N     → 성공/실패 기준과 비교 → pass | fail
기간 경과 AND 관측 수 < N 또는 품질 불량 → inconclusive
```

- 새 역할이 시험 기간 동안 업무를 한 건도 받지 못하면 `inconclusive`다.
- `active` 승격 조건: 독립 평가 `pass` + 필수 성공 조건 충족 + 사람 확인.
- **`trial` 연장은 자동 허용하지 않는다.** 연장은 사람 승인이 필요하고(`trial_extensions` 증가), 원래의 비용 상한과 영향 범위를 유지한다. 연장 횟수 상한은 정책이 정한다.
- `inconclusive`는 재시험 승인 전까지 **종료로 취급**한다. 별도 상태를 추가하지 않는다([state-machines](../schema/state-machines.md)). 선택지: 재시험 승인(새 평가 계획으로 `trial` 재진입) / 제안 폐기(조직에 반영된 적이 없으므로 `inconclusive` 상태로 종료 기록만 유지).

## 5. 업무 평가의 4축

`quality`, `effect`, `economics`, `safety` (ADR-0007). `safety='fail'`이면 다른 점수와 무관하게 `outcome='fail'`. 사업 성과(`effect`)는 MVP에서 측정 신호 1개로 한정한다.

### 5.1 사람이 입력한 측정 값 (A6-U13, a0-decisions D2)

Phase A의 사업 성과 신호는 랜딩 페이지 1개의 주간 목표 행동 전환 수이고 사람이 값을 넣는다.

- **입력.** 사람용 CLI `approve.ts measure <신호 id> <값> --observations N --quality good|poor --attach <파일> [--week YYYY-Www] [--minutes M]` → 승인 소켓의 `measure` 명령 → task-engine `recordMeasurement`. 인증 경계는 승인 CLI와 같다(소켓 파일 권한 + `actor.kind='human'`). 값 입력은 외부 부작용이 아니므로 TOTP 재인증은 요구하지 않는다. 첨부 파일은 CLI가 읽어 sha256과 로컬 참조(`file:<절대 경로>`)만 보내며 내용은 DB에 들어가지 않는다. 신호 정의가 첨부를 요구하면(Phase A는 항상) 첨부 없는 값은 거부한다.
- **기록.** 한 쓰기 트랜잭션에서 `event`(멱등 키 `measurement:<신호 id>@<ISO 주>`, payload: 값·관측 수·데이터 품질·측정 구간·첨부 해시·입력한 사람), 그 측정을 기다리는 업무마다 `evidence`(`measurement` 1줄 + 첨부마다 `document` 1줄, 모두 `trust_origin='internal'`), 분을 주면 `human_time` 비용 1줄. 같은 신호·주의 같은 값은 몇 번 와도 1건이고, 다른 값은 덮어쓰지 않고 거부한다(정정 절차는 열린 항목).
- **주.** ISO 8601 주(월요일 시작)를 신호의 `tz` 벽시계로 센다. `--week`를 생략하면 데몬 시계 기준 *지난주*이고, 아직 끝나지 않은 주의 값은 받지 않는다.
- **대기.** `inputs[kind=measurement]`가 있는 업무는 값이 기록될 때까지 실행되지 않는다([task-spec](../schema/task-spec.md) "측정 값 입력").
- **평가.** 신호 조회기가 값 1개(1주 = 관측 단위 1), 사람이 밝힌 관측 수, 정의의 `min_observations`·`pass_threshold`로 효과를 만든다. 사람이 품질을 `poor`로 밝혔거나 첨부 근거가 업무에 없으면 데이터 품질 불량, 관측 수가 모자라면 관측 수 부족이며 둘 다 `inconclusive`다. 합격선이 없으면 효과는 기록만 한다.

## 6. 필수 테스트

- 실행 에이전트의 보고서만 있는 입력으로는 `pass`가 나오지 않는다.
- 관측 수가 부족하면 `inconclusive`가 나온다.
- 안전성 위반이 있으면 효과 점수가 높아도 `fail`이다.
- 시험 중 즉시 중단 조건이 충족되면 기간 경과를 기다리지 않고 중단된다.
- `inconclusive` 결과가 전략·기억의 성공 사례로 기록되지 않는다.

## 7. 실험 후보 비교 (A6-U14, 주간 사이클 5단계)

완료된 기획 업무(명세에 검사 `experiment_candidates`가 있는 업무)마다 한 번, 데몬의 주간 사이클(`apps/daemon/src/cycle.ts`, 설정 `experiment_cycle`)이 후보를 비교한다. 비교기는 `@aot/evaluation`의 `compareCandidates`(순수 함수, 같은 입력이면 같은 기록)다.

- **입력.** 후보([task-spec "실험 후보"](../schema/task-spec.md)), 기준선 = 기획 업무의 측정 입력(§5.1 신호 조회기), 신호 정의, 위험 판정 함수, 예산 상한(`experiment_cycle.budget_usd`). 결과는 업무 간 결과 전달과 같은 규칙으로 *통과 평가가 있는 완료 업무*의 run 결과만 읽는다.
- **위험 판정은 주입이다.** evaluation 은 정책을 모르므로(경계 lint) 데몬이 정책(`evaluateRequest`)으로 후보가 실행할 업무의 요청(도구 × 작업)을 판정해 가장 엄격한 값을 넘긴다. 배포된 정책 내용이 없거나 모르는 템플릿이면 `deny`. 비교용 사전 판정이라 `policy_decision`에 남기지 않는다(실제 판정은 승인 뒤 업무 생성 때 정책 게이트가 한다).
- **inconclusive.** 기준선이 없거나 측정 불가·관측 수 부족·데이터 품질 불량이면(§4·§5.1과 같은 규칙) 비교 자체가 `inconclusive`이고 후보를 고르지 않는다.
- **제외(사유를 모두 기록).** 위험 `deny`(`risk_denied`), 정의에 없는 신호(`unknown_signal`)·기준선과 다른 신호(`signal_mismatch`)·주기 불일치(`period_mismatch`), 예산 초과(`over_budget`: 추정 비용 또는 마케팅 업무 명세의 `cost_budget.max_usd`가 상한 초과), 합격선 미달(`below_pass_line`).
- **합격선.** 기준선 + max(최소 절대 상승, 기준선 × 최소 상대 상승). 기본 1과 0.1(설정 `min_absolute_lift`·`min_relative_lift`). 비교기가 기준선 대비로 정하고 제안의 `experiment_scope.measurement.pass_at_least`에 남는다.
- **정렬.** ① 위험 `allow`가 `require_approval`보다 먼저 ② 비용당 상승(상승 ÷ max(추정 비용, 0.01 USD)) 큰 순 ③ 상승 큰 순 ④ 추정 비용 작은 순 ⑤ id 순. 상승 = 기대 효과 − 기준선. 1위가 추천이다. 남은 후보가 없으면 `no_candidate`.
- **평가기 독립.** 기대 효과·추정 비용과 그로부터 계산한 상승·비용당 상승은 후보마다 `agent_claim` 아래에만 둔다. 비교기가 확인한 사실(위험 판정, 신호·예산 대조, 기준선, 합격선)과 섞지 않는다. 주장은 순서를 정하는 참고일 뿐이고, 효과는 실험 주의 실제 측정 값으로 따로 평가한다.
- **기록과 제안.** 한 쓰기 트랜잭션에서 비교 기록(`event`, source `experiment-cycle`, type `experiment.compared`, 멱등 키 `experiment-comparison:<기획 업무 id>`)을 남기고, 추천이 있으면 `strategy_version`을 `proposed`로 만든다(id 는 (기획 업무 id, 후보 id)의 해시라 다시 돌려도 늘지 않는다, `created_by`는 기획 run 의 행위자). 추천이 없으면(`inconclusive`, `no_candidate`) 제안 없이 비교 기록의 `review_required`가 참이 되어 사람 검토 목록(`listStrategyReviews`)에 오른다. 새 상태는 없다.

## 8. 실험 결과 검토와 기록 (A6-U16, 주간 사이클 7단계)

실험(`strategy_version.status='experiment'`)의 실제 결과를 비용과 함께 기억에 남기고 다음 주 전략에 반영한다. 평가기의 판정 규칙(§1~§5)은 바뀌지 않는다 — 아래는 평가기를 *언제 어떤 입력으로 부르고*, 그 판정으로 *무엇을 기록하는가*다. 구현은 `apps/daemon/src/cycle.ts`(사이클), `packages/evaluation/src/experiment-result.ts`(기록), `packages/domain/src/strategy.ts`(승격·거절).

- **실험 주.** 1주·관측 1(A6 결정 ②). 활성화 시각 *이후에 시작하는* 첫 ISO 주(신호의 `tz` 벽시계)다: 활성화가 월요일 00:00 정각이면 그 주, 아니면 다음 주. 측정 구간 전체가 활성화 뒤에 있어야 그 주의 값이 실험의 효과다. 그 주의 구간 끝이 지나면 사이클이 **결과 검토 업무**를 한 번 만든다(팩 템플릿 `experiment-result-review@1`; 입력은 조사·기획 업무의 결과(`task_result`)와 그 주의 측정 값(`measurement`, U13 대기 조건), `task.strategy_version_id`로 실험에 묶임). 같은 트랜잭션에서 검토 기록(event `experiment-review:<전략 id>`: 판정 대상 주, 기준선, **합격선**)을 고정하고 실험 루틴을 끈다(`endExperiment`).
- **평가.** 검토 업무는 기존 평가기(`task-evaluator`)가 평가한다. 효과의 입력은 U13 측정 신호 조회기이고, 그 업무의 합격선은 신호 정의의 정적 `pass_threshold`가 아니라 U14 비교 기록이 기준선 대비로 정해 검토 기록에 고정해 둔 값(`pass_at_least`)이다. 값이 합격선 이상이면 `pass`, 미만이면 `fail`, 관측 수 부족·품질 불량·측정 불가는 `inconclusive`다(§5.1). 원본 증거 우선·`safety fail → fail`도 그대로다.
- **결정되는 평가.** 가장 최근 평가가 `pass`이면 바로, `fail`이면 업무가 더 시도하지 않을 때(`needs_review`·`failed`·`cancelled`; 재시도가 남은 동안은 기다림)만 결과를 정한다. `inconclusive`는 결과를 정하지 않는다.
- **기록(`pass` 또는 `fail`).** 한 쓰기 트랜잭션에서 `measurement`와 `strategy_record` 기억 항목, 결과 event(`experiment-result:<전략 id>`, 전략당 한 번이라 같은 평가로 두 번 기록하지 않는다). 절차와 필드는 [memory-item "실험 결과 기록"](../schema/memory-item.md). **실험 총비용**은 그 전략의 업무들(실험 업무와 검토 업무)의 `cost_entry` 합계(`tool`·`llm`·`human_time` 등 모든 범주, 사람 시간 분 포함)에, 업무에 붙지 못한 측정 입력의 사람 시간을 더한 값이고 원장 합계와 같다.
- **`inconclusive`.** `lesson`/`strategy_record`/`measurement`를 만들지 않고(규칙 8, `inconclusive_not_learnable`) 사람 검토 목록에 남는다(승인 CLI `reviews`의 `needsHuman`). 승격은 불가이고, 사람은 사유와 함께 거절(`reject`)한다. 재검토(새 측정·새 업무)는 정의하지 않았다(열린 항목).
- **전략 상태.** `fail` → 시스템(평가기)이 `experiment → rejected` + 종료를 같은 트랜잭션에서 한다(허용표 전이 `experiment → rejected`, 사유 필수). `pass` → **자동 승격 없음**: 사람이 승인 CLI `promote strategy <id> --comment <사유>`로 `experiment → active` 하며, 이전 `active`는 같은 트랜잭션에서 `retired`(롤백 지점). 에이전트는 어느 쪽도 못 한다. `inconclusive`·활성화가 거부된 실험·그 밖의 이유는 사람이 `reject strategy <id> --comment <사유>`(`experiment → rejected`). 승격·거절은 결정 기록(event `experiment-decision:<전략 id>`, 사유·주체)을 남긴다. 승격·거절·종료는 TOTP 재인증이 필요 없다(사람 1인, A6 결정 ③과 같은 신뢰 수준).
- **다음 주 반영.** 다음 기획 업무에는 업무 생성이 현재 `active` 전략을 `task.strategy_version_id`로 붙이고, 템플릿의 기억 입력(`memory:latest#strategy_record`)이 같은 상품의 가장 최근 *현재 사실* `strategy_record`로 바뀐다. 반증·만료·대체·미검증·외부 유래 항목은 현재 사실이 아니므로 빠진다. 기준선 주는 `{{last_week}}`(루틴 발화 시각 기준 지난주, 신호 tz)로 채운다.


## 9. 상품 등록 검증: 로컬 근거와 `VerifierUnavailableError` (Q22 결정 이행 1단계)

[상품 등록 검증 업무](../../workflows/product-registration.md)의 근거는 URL이 아니라 호스트가 저장한 로컬 사실(저장소 구조·README·스캔 요약)이다. 평가기가 그 본문을 *원본*으로 직접 읽는다. 실행 에이전트의 보고서는 근거를 **가리킬 뿐**이다.

- **포트 `EvidenceReader`.** `evidence` 행(`id`·`kind`·`ref`·`content_hash`)을 받아 UTF-8 본문을 돌려준다. 평가기는 본문의 sha256을 다시 계산해 `content_hash`와 대조한다(`sha256:` 접두는 무시). 해시가 없거나 다르거나 읽을 수 없으면 그 근거는 원본으로 인정하지 않는다. 포트가 없으면 본문을 읽어야 하는 검사는 `unknown`(→ `inconclusive`)이고 근거 주장은 LLM 검증에 넘기지 않는다. 호스트 저장소(`apps/daemon/src/evidence-store.ts`)와 도구([registration-tools](registration-tools.md))가 구현돼 있다.
- **보고서 형식 `registration-report@1`.** `claims[{id?, statement, evidence_id}]`, `collection[]`(수집 항목 9개 각각 `collected`+`evidence_ids` 또는 `unavailable`+`reason`), `classification{proposal, rationale_evidence_ids}`, `uncertainties`. 모양이 틀린 곳은 사유를 모아 검사가 `fail`로 보고한다. 형식의 정본은 `packages/evaluation/src/registration-report.ts`다.
- **스캔 요약 `secret_scan_summary@1`.** 도구가 스캐너 출력에서 *필드를 골라* 만드는 근거 본문(`scope` tree|history, `complete`, 범위 수치, 위치·종류·신뢰도뿐인 `findings`). 허용 키 목록이 닫혀 있어 `Secret`·`Match` 같은 필드가 딸려 오면 거부한다(`secret-scan-summary.ts`).
- **결정론적 검사 5개.** `evidence_refs_resolvable`(참조가 이 업무의 행이고 본문이 읽히고 해시가 맞는다; 수집 항목마다 근거 또는 "수집 불가" 사유), `no_secret_in_outputs`(**안전성**; run 결과와 저장된 본문에서 비밀값 모양을 찾는다. 종류·개수만 보고하고 값은 보고하지 않는다. 읽지 못한 본문이 있으면 `unknown`), `read_only_calls_only`(**안전성**; 이 run의 판정에 읽기 아닌 영향이 있거나 외부 부작용이 있으면 실패 — 거부된 쓰기 시도도 위반), `scan_coverage_complete`(보고서의 `secret_scan` 근거에 트리·이력 요약이 각각 있고 `complete`), `classification_present`(분류 제안과 근거 행이 있고, 스캔 후보가 있는데 `public_candidate`로 완화하면 실패). 비밀값 모양 목록은 호출 기록 마스킹(`agent-runtime/src/mask.ts`)과 같은 집합이며 시험이 같은 표본으로 대조한다. 이 목록에 없는 비밀은 못 잡는다 — 1차는 스캐너다.
- **LLM 검증의 근거 주장.** `claims[].evidence_id`가 가리키는 근거 행의 본문이 `SourceText`(`ref=evidence:<id>`)로 격리 입력에 들어간다. 신뢰 출처는 근거 행이 밝힌 값 그대로(README 유래는 `external_untrusted`)이고 본문을 읽지 못하면 `text=null`이다. 입력의 모양(`check`·`criteria`·`claims`·`sources`)은 그대로다.
- **`VerifierUnavailableError`.** 검증기가 *지금은* 일을 못 한다(사용량 한도·로그인 만료·미룸). 모델이 판단하지 못한 것(`unclear`)과 달라서, 평가기는 이를 `unclear`로 바꾸지 않고 위로 던진다: 평가 행도 근거 갱신도 쓰지 않고(쓰기 전에 던진다) 업무는 `validating`에 남아 다음 tick에 다시 검증된다(워커의 `validationFailed`). 그 밖의 오류는 이전처럼 `unclear` → `inconclusive` → 사람 검토다. 검증기 구현은 매 tick(기본 5초) 불리므로 스스로 호출을 조절해야 한다(미룬 동안은 안쪽 호출 없이 던진다).
- **구독 검증기와 토큰 비용 (3단계).** `claude-code-cli` 도구 없는 별도 호출이 `LlmVerifier`를 구현한다([claude-code-cli §6](claude-code-cli.md)). `LlmVerdict.tokens`가 있으면 평가기가 검증 단계 `cost_entry`에 `units.tokens`만 남기고(`amount_usd=0`, 구독이라 USD로 세지 않는다) 평가 메모에 실행 토큰 대비 비율을 적는다. 비율 상한(시작값 20%)은 강제하지 않고 파일럿이 정한다. `costUsd`·`tokens` 모두 없거나 유효하지 않으면(0·음수·NaN) 원장에 아무것도 남기지 않는다.
- **평가기 버전.** `task-evaluator@v1`을 올리지 않았다: 기존 입력의 결과가 바뀌지 않는다(새 검사 id, 새 포트, 새 오류 클래스는 쓰는 쪽이 있을 때만 작동). Q27(평가기 교체의 정책 연결)이 정해지면 그 절차를 따른다.
