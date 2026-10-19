# 업무 명세 (task_spec)

`task.spec`에 JSON으로 저장되는 구조. 업무 생성 시 스키마 검증을 통과해야 한다.

| 필드 | 필수 | 의미 | 생성 거부 조건 |
|---|---|---|---|
| `objective` | ✔ | 달성할 목표 한 문장 | 비어 있음 |
| `department` / `role` | 조건부 | 책임 부서와 역할. 맞는 역할이 없으면 비워 `unassigned`로 생성 | 지정했는데 존재하지 않거나 `trial`/`active`가 아닌 role |
| `product` | | 대상 상품 slug | 등록되지 않은 상품 |
| `trigger` | ✔ | `{kind: event\|routine\|manual\|task, ref}` | ref 없음 |
| `inputs` | ✔ | 입력 데이터와 출처 `[{name, ref, kind}]` | 출처 없는 입력 |
| `dependencies` | | 선행 업무 id 목록 | 순환 |
| `allowed_tools` | ✔ | 요청하는 도구와 작업 `[{tool, operations[], scope, impact, target}]`. 최종 권한은 정책이 결정 | 정책 판정이 deny |
| `constraints` | ✔ | `{time_limit, network_allowlist, fs_scope, publish_scope, data_classes}`. `network_allowlist`는 명시적 도메인 목록이며 비면 네트워크 없음, `"*"`(전체 허용)은 금지 | 정책 위반, `"*"` 사용 |
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
  "allowed_tools": [{"tool": "web_search", "operations": ["search", "fetch"]}],
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

## 버전과 승인 스냅샷

업무 생성 시점의 조건과 실행 시점의 조건은 다를 수 있다. 명세는 다음을 함께 기록한다.

| 항목 | 위치 |
|---|---|
| `org_version_id`, `role_version` | `task` 컬럼 |
| `task_spec_version` | `task` 컬럼 (명세 템플릿 버전) |
| `strategy_version_id`, `policy_version_id` | `task` 컬럼 |
| `tool_contract_version` | `task` 컬럼 (도구 어댑터 계약. `supports_idempotency` 포함) |
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

같은 `publish_content`라도 내부 테스트 사이트(`internal`)와 외부 고객 공개(`public`)는 다른 판정을 받는다.
