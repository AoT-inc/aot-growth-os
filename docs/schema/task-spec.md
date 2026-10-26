# 업무 명세 (task_spec)

`task.spec`에 JSON으로 저장되는 구조. 업무 생성 시 스키마 검증을 통과해야 한다.

| 필드 | 필수 | 의미 | 생성 거부 조건 |
|---|---|---|---|
| `objective` | ✔ | 달성할 목표 한 문장 | 비어 있음 |
| `department` / `role` | 조건부 | 책임 부서와 역할. 맞는 역할이 없으면 비워 `unassigned`로 생성 | 지정했는데 존재하지 않거나 `trial`/`active`가 아닌 role |
| `product` | | 대상 상품 slug | 등록되지 않은 상품 |
| `trigger` | ✔ | `{kind: event\|routine\|manual\|task, ref}` | ref 없음 |
| `inputs` | ✔ | 입력 데이터와 출처 `[{name, ref, kind}]`. `kind='source_url'`은 조사 대상 URL, `kind='task_result'`는 선행 업무의 결과(아래 "선행 업무 결과 입력"), `kind='measurement'`는 사람이 입력할 주간 측정 값(아래 "측정 값 입력", 업무당 1개), `kind='memory'`는 현재 사실인 기억 항목(아래 "기억 입력", 최대 3개) | 출처 없는 입력, `task_result`의 잘못된 형식·중복·개수 초과, `task_result`의 선행 업무가 `dependencies`에 없음, `measurement`의 잘못된 형식(없는 주·상대 주 포함)·2개 이상, `memory`의 잘못된 형식·이름 중복·3개 초과, 구체 `memory:<id>`가 없거나 현재 사실이 아님 |
| `expected_quotes` | | 출처 원문에 있어야 하는 인용문 `[{source, text}]`. `source`는 `inputs[]`에서 `kind='source_url'`인 항목의 `name`(같은 이름의 `source_url` 입력이 정확히 하나여야 한다), `text`는 그 출처에 있어야 하는 문장. 상한: 전체 200건, 출처당 10건, 한 문장 500자(앞뒤 공백 제외). 조사 에이전트는 이 목록의 *모든* 문장에 대해 found/not found를 보고하고, 검증기(`quote_in_source`)가 출처 원문에서 다시 확인한다. 승인 대상 해시에 포함된다(실행 인자) | 알 수 없거나 모호한 `source`, 빈 `text`, 상한 초과, 같은 출처의 같은 문장(공백 차이 무시) 중복, `validation.deterministic`에 `quote_in_source`가 없음 |
| `expected_call_outcome` | | 전화 업무가 남겨야 하는 구조화된 통화 결과의 형식 `{dispositions, required_fields?}` (아래 "통화 결과 기대"). 승인 대상 해시에 포함된다(실행 인자) | `dispositions` 가 비었거나 이름 형식(`[a-z][a-z0-9_]*`, 필수 필드는 `[A-Za-z][A-Za-z0-9_]*`) 위반·중복·상한(20, 30) 초과, 알 수 없는 키, `validation.deterministic` 에 `call_outcome_recorded` 가 없음 |
| `dependencies` | | 선행 업무 id 목록. 선행이 모두 `completed`가 되기 전에는 실행되지 않는다. `task_result` 입력의 선행 업무는 여기에도 있어야 한다 | 순환 |
| `allowed_tools` | ✔ | 요청하는 도구와 작업 `[{tool, operations[], scope, impact, target?}]`. `scope`·`impact`는 항목마다 필수(`target`만 선택). 최종 권한은 정책이 결정 | `scope`·`impact` 누락(스키마 검증 단계, 정책 판정 이전), 정책 판정이 deny |
| `constraints` | ✔ | `{time_limit, network_allowlist, fs_scope, publish_scope, data_classes}`. `time_limit`은 정수 + 단위 하나(`s`·`m`·`h`·`d`, 예 `"30m"`, 최대 `7d`)이며 해석할 수 없으면 생성 거부. 실행 관리가 초과 시 run을 취소하고 `killed`로 닫는다(없으면 데몬 기본 `default_time_limit`, 30분). `network_allowlist`는 명시적 도메인 목록이며 비면 네트워크 없음, `"*"`(전체 허용)은 금지 | 정책 위반, `"*"` 사용 |
| `acceptance_criteria` | ✔ | 완료 조건 목록 (검증 가능한 문장 또는 체크 id) | 비어 있음 |
| `validation` | ✔ | `{deterministic: [...], llm: {...}\|null, human: bool}` | 검증 방식 없음 |
| `policy_version` | ✔ | 적용 정책 버전 (생성 시 시스템이 채움) | 에이전트가 지정 시도 |
| `versions` | ✔ | `{org_version, role_version, task_spec_version, strategy_version, tool_contract_version}` (시스템이 채움) | 에이전트가 지정 시도 |
| `approved_snapshot` | 조건부 | 승인이 필요한 업무의 승인된 입력·실행 인자와 해시 | 해시 불일치 시 실행 차단 |
| `evidence_refs` | | 근거와 실행 기록 (실행 중 누적) | |
| `cost_budget` | ✔ | `{max_usd, max_tokens?}` | 정책 상한 초과 |

## 예시: 주간 시장 조사 (MVP)

```json
{
  "objective": "example-product 관련 시장의 지난 7일 주요 변화를 출처와 함께 정리한다",
  "department": "planning",
  "role": "market-researcher",
  "product": "example-product",
  "trigger": {"kind": "routine", "ref": "weekly-market-research@2026-W42"},
  "inputs": [{"name": "keywords", "ref": "strategy:active#research_keywords", "kind": "strategy"}],
  "dependencies": [],
  "allowed_tools": [{"tool": "web_search", "operations": ["search", "fetch"], "scope": "internal", "impact": "read"}],
  "constraints": {"time_limit": "30m", "network_allowlist": ["search.example.com", "docs.example.com"], "publish_scope": "internal"},
  "acceptance_criteria": [
    "각 주장에 접근 가능한 출처 URL이 1개 이상 있다",
    "각 인용문이 출처 원문에 존재한다",
    "불확실성 항목이 명시되어 있다",
    "동일 주장이 중복되지 않는다"
  ],
  "validation": {
    "deterministic": ["url_reachable", "quote_in_source", "dedupe", "budget"],
    "llm": {"check": "claim_supported_by_source", "isolated_context": true},
    "human": false
  },
  "cost_budget": {"max_usd": 2.0}
}
```

## 예시: 출처 인용문 확인 (조사 에이전트)

출처 페이지 두 개를 읽고, 기대하는 인용문이 각 원문에 있는지 확인하는 읽기 전용 업무. 인용문은 `inputs[]`가 아니라 `expected_quotes`에 둔다 (`inputs[]`는 입력 데이터와 출처이고, 인용문은 완료 조건에 속한다).

```json
{
  "objective": "릴리스 노트와 가격 페이지가 예상한 문장을 담고 있는지 확인한다",
  "trigger": {"kind": "manual", "ref": "actor:example-owner"},
  "inputs": [
    {"name": "release-notes", "ref": "https://docs.example.com/release-notes", "kind": "source_url"},
    {"name": "pricing", "ref": "https://docs.example.com/pricing", "kind": "source_url"}
  ],
  "expected_quotes": [
    {"source": "release-notes", "text": "supports single sign-on"},
    {"source": "pricing", "text": "billed annually"}
  ],
  "allowed_tools": [{"tool": "fetch_url", "operations": ["fetch"], "scope": "internal", "impact": "read"}],
  "constraints": {"time_limit": "10m", "network_allowlist": ["docs.example.com"], "publish_scope": "internal"},
  "acceptance_criteria": ["각 기대 인용문이 지정한 출처 원문에 존재한다"],
  "validation": {"deterministic": ["url_reachable", "quote_in_source"], "llm": null, "human": false},
  "cost_budget": {"max_usd": 1.0}
}
```

## 선행 업무 결과 입력 (`inputs[kind=task_result]`, A6-U11)

한 업무의 결과를 다음 업무의 입력으로 쓰는 방법이다. 예: 조사 업무의 결과를 받아 기획 업무가 실험안을 만든다.

```json
{
  "inputs": [{"name": "findings", "ref": "task:task-1234", "kind": "task_result"}],
  "dependencies": ["task-1234"]
}
```

- **형식.** `ref`는 `task:<선행 업무 id>`이다. 한 업무에 최대 8개, `name`·`ref`는 `task_result` 입력 안에서 유일해야 한다.
- **`dependencies`와의 관계.** 선행 업무는 `dependencies`에도 있어야 한다. 순서는 `dependencies`가 보장하고(선행이 `completed`가 된 뒤에야 집힌다), `task_result`는 그 결과를 *읽는다*는 뜻이다. 엔진이 자동으로 `dependencies`에 더하지 않고 생성 단계에서 거부한다(`upstream_not_a_dependency`). 루틴 템플릿에서는 `ref`를 `task:<템플릿 업무 name>`으로 쓰고 그 업무가 `depends_on`에 있어야 하며, 업무가 만들어질 때 생성된 id로 바뀐다.
- **무엇을 넘기는가.** 실행 시점(lease 획득 직전)에 호스트가 *선행 업무가 `completed`이고, 그 업무에 통과 평가(`outcome='pass'` AND `safety='pass'`)가 있을 때*, 그 평가가 대상으로 한 run의 `task_run.result`만 읽는다. 사람이 `completed`로 끝냈더라도 통과 평가가 없으면 넘기지 않는다. 결과는 JSON 객체여야 하고 항목당 64 KiB, 전체 256 KiB를 넘으면 자르지 않고 거부한다.
- **필수 입력이다.** 하나라도 충족되지 않으면(`upstream_not_found`·`upstream_not_completed`·`upstream_not_evaluated`·`upstream_not_passed`·`upstream_result_missing`·`upstream_result_not_object`·`upstream_result_too_large`·`upstream_total_too_large`) 업무는 실행되지 않고 `queued → needs_review`로 간다. run도 시도 소모도 없다. 사유는 `task_transition.reason`에 `upstream_unmet: <코드>: input '<name>': ...`로 남는다. 기다리지 않는 이유: 선행이 `completed`가 된 뒤에는 상태가 더 바뀌지 않으므로 기다려도 충족되지 않는다(선행이 아직 끝나지 않은 경우는 `dependencies`가 이미 막는다). 일부만 넘기고 실행하지 않는다.
- **신뢰.** 선행 결과는 다른 에이전트가 낸 산출물이므로 항상 `external_untrusted` 데이터다 ([trust-boundaries §2-3](../security/trust-boundaries.md)). 어댑터 입력의 `upstream[]` 항목은 `{name, task_ref, trust_origin: 'external_untrusted', result}`이고 `task_spec`(지시)과 분리되어 있다.

## 측정 값 입력 (`inputs[kind=measurement]`, A6-U13)

사람이 입력하는 측정 값(a0-decisions D2: 랜딩 페이지 1개의 주간 전환 수)을 기다렸다가 실행하는 업무에 쓴다. 예: 지난주 결과를 보고 다음 실험을 고르는 업무.

```json
{
  "inputs": [{"name": "conversions", "ref": "measurement:weekly-landing-conversions@2026-W43", "kind": "measurement"}]
}
```

- **형식.** `ref`는 `measurement:<신호 id>@<YYYY-Www>`이다. 신호 id는 팩의 측정 신호 정의 `id`, 주는 그 해에 있는 ISO 8601 주(월요일 시작, 신호의 `tz` 벽시계 기준)다. 주는 **명시**한다: "지난주" 같은 상대 지정은 시간이 지나면 가리키는 주가 바뀌므로 저장된 명세에 두지 않는다. 한 업무에 1개까지다(MVP의 사업 성과는 신호 1개, evaluation §5). 신호가 정의되어 있는지는 생성 단계에서 보지 않는다(정의는 팩에 있다) — 정의되지 않은 신호의 값은 입력 경로가 받지 않으므로 그 업무는 계속 기다린다.
- **대기 조건.** 같은 문자열이 사람이 입력한 측정 이벤트의 `event.idempotency_key`다. 그 이벤트(`source='measurement'`, `type='measurement.recorded'`)가 없으면 스케줄러가 업무를 *집지 않는다*: `queued`로 남고 전이·시도 소모·run이 없으며, 후보 조건(SQL)이라 다른 업무의 선택을 막지 않는다. 값이 기록되면 다음 tick에 집힌다. 기다리는 업무는 승인 CLI `measurements`(`listMeasurementWaits`)로 사유(`measurement_pending: ...`)와 함께 본다.
- **근거.** 값이 기록될 때 기다리던 업무에, 그 뒤에 만들어진 업무는 집힐 때 `evidence`(`measurement` 1줄 + 첨부 `document`, `trust_origin='internal'`)가 붙는다. 평가기는 이 근거와 이벤트를 원본 증거로 읽는다([evaluation §5.1](../operations/evaluation.md)).
- **`task_result`와의 차이.** 선행 결과 미충족은 기다려도 바뀌지 않아 `needs_review`로 보내지만, 측정 값은 사람이 나중에 넣으므로 기다린다.

## 기억 입력 (`inputs[kind=memory]`, A6-U16)

이전 실험의 결과를 다음 업무의 입력으로 붙일 때 쓴다(다음 주 기획 업무가 직전 `strategy_record`를 보는 경우).

```json
{
  "inputs": [{"name": "previous-experiment", "ref": "memory:latest#strategy_record", "kind": "memory"}]
}
```

- **형식.** `ref`는 구체 참조 `memory:<memory_item id>` 또는 선택자 `memory:latest#strategy_record`다. 한 업무에 3개까지, 이름은 유일하다.
- **해석(업무를 만드는 시점).** 선택자는 같은 상품(`product`가 없으면 상품 없는 항목)의 가장 최근 **현재 사실** `strategy_record`의 구체 참조로 바뀌고, 없으면 그 입력이 빠진다(선택 입력). 구체 참조는 항목이 있고 지금도 현재 사실이어야 한다 — 반증·만료·대체·미검증·외부 유래(`hypothesis`) 항목이면 생성을 거부한다(`memory_not_current`). 저장되는 명세에는 구체 참조만 남아 승인 해시·감사가 같은 항목을 가리킨다. 같은 트리거·같은 입력의 중복 판정(`dedupe_key`)은 작성자가 낸 입력(선택자 그대로)으로 한다.
- **내용은 명세에 복사하지 않는다.** 참조만 남는다. 항목 내용을 모델 프롬프트에 어떻게 넣는지(데이터 구획 표시)는 실제 모델 어댑터(Q22 이후)의 몫이다([phase-a A6-U16 열린 항목](../plans/phase-a.md)).

## 통화 결과 기대 (`expected_call_outcome`, ADR-0014)

전화 업무는 "통화를 했다"는 에이전트의 보고가 아니라 통화 기록·발화 기록·구조화된 결과로 완료된다. 결과의 형식(어떤 분류가 허용되는지, 어떤 필드가 필수인지)은 Phone이 아니라 명세가 정한다.

```json
{
  "allowed_tools": [{"tool": "phone_call", "operations": ["call"], "scope": "customer", "impact": "external_effect", "target": "+821000000001"}],
  "validation": {"deterministic": ["call_completed", "call_transcript_present", "call_outcome_recorded", "policy_compliance"], "llm": null, "human": false},
  "expected_call_outcome": {"dispositions": ["qualified", "not_interested", "callback_requested"], "required_fields": ["budgetKnown", "timeline"]}
}
```

- **허용 번호.** `phone_call`·`phone_transfer`의 `target`은 E.164 정확 일치 또는 끝이 `*`인 접두어(`+8210555*`)다. 사람이 승인한 명세의 범위이며(승인 해시에 포함), 이 밖의 번호는 정책을 묻기 전에 거부된다. **`phone_call`·`phone_transfer`는 `target`이 필수다**(없으면 `phone_target` 사유로 생성 거부): 번호 범위를 밝히지 않은 승인은 범위를 승인한 것이 아니다. 넓게 허용하려면 `+82*`처럼 접두어를 명시한다. 전화 정책(`phone:` 섹션)의 일반 한도는 그 위에 겹쳐 적용된다.
- **결과의 출처.** 결과는 provider 분석(`provider_analysis`), 추출기(`extractor`), 사람(`human`)이 만든다. 에이전트가 자기 통화의 결과를 기록하는 길은 없다. 상대방의 말에서 나온 값이라 사람이 직접 기록한 것 말고는 `external_untrusted`다.
- **같은 번호에 두 번.** 같은 업무에서 같은 번호·같은 목적·같은 맥락(= 같은 의도)의 재요청은 같은 통화로 합쳐진다(실패·취소한 통화는 제외). 맥락이 다르면(예: 다른 리드) 다른 통화다. 같은 의도로 다시 걸려면 이전 통화가 실패·취소되거나 맥락에 시도 식별자를 넣는다.

## 결정론적 검사 id (`validation.deterministic`)

`@aot/evaluation`(A4)이 구현한 검사 id. 목록에 없는 id는 "검증할 수 없음"으로 취급되어 평가가 `inconclusive`(업무 `needs_review`)가 된다. 검사 대상이 하나도 없는 검사도 통과가 아니라 "확인 불가"다.

| id | 검사 | 근거(원본) |
|---|---|---|
| `schema_valid` (`schema`) | 저장된 명세가 스키마를 통과하고 run 결과가 JSON | `task.spec`, `task_run.result` |
| `url_reachable` | 출처 URL(`evidence.kind='source_url'`과 보고서 주장이 든 출처)에 접근 가능 | 출처 조회 포트 |
| `quote_in_source` | 인용문이 출처 원문에 존재(공백 차이 무시, 대소문자 구분). 보고서 주장의 인용문과, 명세의 `expected_quotes` 전부를 확인한다. 기대 인용문은 (1) 검증기가 출처를 직접 읽어 원문에 있고 (2) 에이전트 보고에도 같은 출처·같은 문장의 주장으로 올라와 있어야 통과한다. 하나라도 원문에 없거나, 출처를 읽지 못했거나, 보고에서 빠졌으면 `fail`(평가 `fail`, 업무는 재시도 대기 → 소진되면 `needs_review`)이다 | 출처 조회 포트, `expected_quotes`, 보고서 주장 |
| `dedupe` | 같은 주장·같은 출처 중복 없음 | 보고서 주장, `evidence` |
| `budget` | 비용 원장 합계가 `cost_budget`(USD, 토큰) 이내 | `cost_entry` |
| `policy_compliance` | 보낸 외부 부작용마다 허용(또는 승인 대기) 정책 판정이 기록됨. 실패는 안전성 실패 | `external_effect`, `policy_decision` |
| `uncertainty_listed` | run 결과에 `uncertainties` 필드가 *존재*하고 형식이 유효함(아래). 필드 누락·형식 오류는 `fail`(사유 포함, 평가 `fail` → 재시도 대기). 명세의 `validation.deterministic`에 이 id가 있을 때만 적용된다 | `task_run.result` |
| `call_completed` | (ADR-0014) 이 업무의 통화 중 `connected`를 거쳐 `completed`된 것이 있다. 통화가 하나도 없거나 모두 연결 없이 끝났으면 `fail`, 아직 열린 통화만 있으면 확인 불가. 통화는 run을 넘어 업무에 속한다 | `call`, `evidence` |
| `call_transcript_present` | 위 기준 통화의 발화 기록에 턴이 하나 이상 있다. 기준 통화가 없으면 확인 불가 | `call_artifact` |
| `call_outcome_recorded` | 기준 통화의 구조화된 결과가 있고 명세의 `expected_call_outcome`(허용 disposition, 필수 필드)을 만족한다. 없거나 못 미치면 확인 불가(`inconclusive` → 사람 검토): 결과 추출이 부족하다고 업무를 재시도해 다시 전화하지 않는다. 자유 텍스트 요약만으로는 결과가 아니다 | `call_artifact`, 명세 |
| `experiment_candidates` | (A6-U14) 기획 업무 결과의 `candidates` 형식이 유효함(아래 "실험 후보"): id 중복 없음, 마케팅 업무 명세는 `validateTaskSpec` 통과, 각 후보의 `measurement.signal_id`가 알려진 측정 신호 정의(팩의 `measurement-signals/`)이고 주기가 같음. 위반은 `fail`(사유 포함). 신호 정의가 평가기에 주어지지 않았으면 신호를 확인할 수 없어 "확인 불가"(`inconclusive`). 이 id가 있는 업무가 곧 *기획 업무*다(데몬의 주간 사이클이 완료된 기획 업무의 후보를 비교한다) | `task_run.result`, 신호 정의 |

보고서의 주장 목록은 `{"claims": [{"id"?, "statement", "source_url", "quote"?}]}` 모양을 읽는다(어댑터 출력 계약은 A5에서 확정). 조사 에이전트는 *찾은* 기대 인용문만 주장으로 올리고, 찾지 못한 것은 `result.sources[].quotes[]`에 `found:false`로 남긴다(출처를 읽지 못했거나 이름이 맞는 출처가 없는 인용문도 `found:false`, 후자는 `result.unmatched_quotes[]`). 주장으로 올라오지 않은 기대 인용문은 검증기가 `fail`로 잡으므로, 일부만 보고한 결과가 `pass`가 될 수 없다. `expected_quotes`가 없고 보고서에 인용문도 없으면 `quote_in_source`는 "확인 불가"다(`inconclusive`). 필수 테스트 결과(`test_result`) 검사는 합격 표현 형식이 정해지지 않아 구현하지 않았다.

### 불확실성 항목 (`uncertainties`, 완료 조건 "불확실성 항목이 명시되어 있다")

결과의 `uncertainties`는 `[{"topic": string, "note": string}]`이다(최대 100개, `topic` 100자·`note` 300자 이하, 두 키 외 다른 키 거부). 조사 에이전트는 *스스로 아는* 불확실성만 싣는다: 건너뛴 입력(`skipped_inputs`), 읽지 못한 출처(오류 코드·HTTP 상태), 본문을 읽지 않았거나 잘린 출처, 찾지 못했거나 확인하지 못한 기대 인용문(`found:false`). 모두 에이전트가 이미 가진 보고에서 기계적으로 도출하고 문구는 코드에 고정되어 있다(페이지 텍스트나 임의 서술을 싣지 않는다). 상한을 넘으면 앞쪽 항목과 생략 개수를 알리는 항목 하나(`topic: "(more)"`)를 남긴다.

**빈 목록은 유효하다.** 완료 조건 문구는 "불확실성이 *명시*되어 있다"이다. 모르는 것이 없는 run에 지어낸 항목을 요구하면 "임의 서술 금지"를 어기므로, 검사 `uncertainty_listed`는 항목 수가 아니라 *필드의 존재와 형식*을 본다: `[]`는 "알려진 불확실성이 없다"는 에이전트의 명시이고, 필드가 없는 것(말하지 않음)은 `fail`이다. 이 검사는 에이전트가 불확실성을 *빠짐없이* 적었는지는 확인하지 못한다(출처·인용문 쪽은 `url_reachable`·`quote_in_source`가 원본으로 따로 본다). 보고된 불확실성이 있다고 해서 평가가 `fail`이 되지도 않는다.

### 실험 후보 (`candidates`, A6-U14)

기획 업무(generalist)는 조사 결과(`inputs[kind=task_result]`)와 기준선 측정(`inputs[kind=measurement]`)을 받아 결과에 실험 후보를 싣는다. 팩 템플릿 `weekly-experiment-planning@1`이 이 모양이다.

```json
{
  "candidates": [{
    "id": "landing-copy-a",
    "hypothesis": "첫 화면 문구를 사용 사례 중심으로 바꾸면 주간 가입이 는다",
    "expected_effect": 14,
    "est_cost_usd": 0.5,
    "task_spec": {"objective": "...", "role": "generalist", "inputs": [], "allowed_tools": [], "constraints": {}, "acceptance_criteria": ["..."], "validation": {"deterministic": ["budget"], "llm": null, "human": true}, "cost_budget": {"max_usd": 0.5}},
    "measurement": {"signal_id": "weekly-landing-conversions", "period": "iso_week"}
  }],
  "uncertainties": []
}
```

- 후보는 1~10개, `id`는 소문자·숫자·하이픈(64자 이하)이고 결과 안에서 유일하다. `hypothesis`는 500자 이하. `expected_effect`는 실험 주의 신호 값 주장(신호와 같은 단위, 유한한 수), `est_cost_usd`는 0 이상.
- 실행할 업무는 `task_template_ref`(팩 템플릿 `<id>@<version>`)와 `task_spec`(이 문서의 초안 형식, 16 KiB 이하) 중 **정확히 하나**다. `task_spec`의 `trigger`·`dependencies`는 엔진이 정하므로 넣을 수 없고, 나머지는 `validateTaskSpec`(draft)을 통과해야 한다.
- `measurement`는 `{signal_id, period}`이며 `period`는 신호 정의와 같아야 한다(`iso_week`). 실험 단위는 1주·관측 1이고(A6 결정 ②) 실험 주는 승인 때(U15) 정한다.
- 모르는 키는 거부한다. 값은 모두 에이전트의 자기 신고이므로 비교기는 기대 효과·비용을 참고로만 쓴다([evaluation §7](../operations/evaluation.md)).

## 버전과 승인 스냅샷

업무 생성 시점의 조건과 실행 시점의 조건은 다를 수 있다. 명세는 다음을 함께 기록한다.

| 항목 | 위치 |
|---|---|
| `org_version_id`, `role_version` | `task` 컬럼 |
| `task_spec_version` | `task` 컬럼 (명세 템플릿 버전) |
| `strategy_version_id`, `policy_version_id` | `task` 컬럼 |
| `tool_contract_version` | `task` 컬럼 (도구 어댑터 계약. (도구, action)별 멱등 선언 `{supported, retention_ms}` 포함. 해시는 아직 계산하지 않아 null) |
| 승인된 입력·실행 인자 스냅샷 | `task.approved_snapshot`, 해시는 `task.approved_hash`, 승인은 `approval` (`subject_hash`) |

실행 시 재검증 (`queued → running` 직전, 외부 부작용 직전):
1. 실행 인자 해시가 `approved_hash`와 같은가. 다르면 차단 후 재승인 요청.
2. 현재 정책이 승인 당시보다 엄격해졌는가. 그렇다면 **새 정책을 적용**한다. 과거 승인이 현재의 더 엄격한 정책을 무효화하지 못한다.
3. 대상 리소스의 상태가 승인 당시 전제와 같은가(저장소 브랜치, 게시 대상 페이지 버전 등).
4. 조직·전략·역할 버전 변경이 승인 범위를 벗어나는가. 벗어나면 재검토 요청 — 조용히 다른 작업을 실행하지 않는다.

## 권한 요청 (`allowed_tools`의 확장)

도구 이름 허용 목록만으로는 위험을 표현할 수 없다. `allowed_tools` 항목은 정책 판정의 **요청**이며, 최종 결정은 정책 엔진이 아래 7요소로 계산하고 도구 어댑터가 호출 시 재검증한다. 모든 판정은 `policy_decision`에 남는다.

| 요소 | 예 |
|---|---|
| 주체 | `market-researcher@v3` |
| 행위 | `publish_content` |
| 대상 | `site:staging/landing-v2` |
| 범위 | `internal` / `customer` / `public` |
| 영향 | `read` / `write` / `delete` / `external_effect` |
| 제약 | 예산, 횟수, 시간, 대상 수 상한 |
| 승인 | 필요한 승인자/채널 |

`scope`와 `impact`는 항목마다 필수다. 빠진 명세는 정책 판정에 도달하기 전에 스키마 검증에서 `scope is required`/`impact is required` 사유로 거부된다(정책이 추측해 채우지 않는다).

같은 `publish_content`라도 내부 테스트 사이트(`internal`)와 외부 고객 공개(`public`)는 다른 판정을 받는다.
