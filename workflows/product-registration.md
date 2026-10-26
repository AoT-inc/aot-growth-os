# 상품 등록 검증 업무 템플릿

[상품 등록 절차](../docs/products/README.md)의 2단계(`verifying`)에서 실행하는 읽기 전용 검증 업무의 `task_spec` 템플릿이다. 형식은 [task-spec](../docs/schema/task-spec.md)를 그대로 따른다. 이 문서는 **템플릿**이며, 실제 수행은 Phase A 통과 후의 후속 작업이다 ([open-questions Q1](../docs/open-questions.md)).

> 예시는 모두 가상의 `example-product`다. 실제 제품명·경로·저장소 주소·수집 결과는 이 저장소에 두지 않고 내부 인스턴스 DB에만 `evidence`로 저장한다 ([공개 저장소 규칙](../docs/security/public-repository.md)).

## 1. 절차와의 대응

| 등록 상태 | 이 업무에서 일어나는 일 | 전이 주체 |
|---|---|---|
| `candidate` | 사람이 이름과 위치만 입력. 이 업무는 아직 없음 (`access_scope=none`) | 사람 |
| `candidate → verifying` | 템플릿으로 업무 1건 생성. 사람이 읽기 전용 접근(`access_scope=read`)을 정책 승인 경로로 요청 | 업무 생성 엔진 + 정책 |
| `verifying` (업무 `running`) | §2 수집, §5 비밀값 스캔·분류 수행. 결과는 `evidence`로 저장 | 실행 에이전트(읽기 전용) |
| `verifying` (업무 `validating`) | §4의 결정론적 검증 → LLM 검증 | 검증기 |
| `verifying → pending_approval` | 업무가 `needs_review`에 도달 (`validation.human=true`) | 검증기 |
| `pending_approval → registered` | 사람이 증거를 확인하고 분류·소유 역할·접근 범위를 결정, `approval` 기록 | 사람만 |
| `verifying`/`pending_approval → rejected` | 비밀값 발견 미해소, 분류 불가, 사람 거절 등 | 검증기(`fail`) 또는 사람 |

업무 `completed`는 검증기만 만들 수 있다. 제품의 `registered` 전이는 업무 완료와 별개로 사람 승인이 필수다.

## 2. 수집 항목

모두 읽기 전용이다. 수집한 값은 `evidence`로 저장하며, 승인 전에는 `product`/`product_repo`의 사실 필드에 반영하지 않는다.

| 항목 | 수집 방법 | 비고 |
|---|---|---|
| 저장소 구조 | 최상위 디렉터리·주요 파일 목록 | 파일 내용은 아래 항목에 필요한 것만 읽는다 |
| 스택 | 매니페스트·잠금 파일 이름과 언어 비율 | `product_repo.stack` 후보 |
| README 요약 | README 본문 (요약만 evidence 본문, 원문은 참조) | 외부 입력 취급 (§6) |
| 원격 | 원격 주소 존재 여부와 호스트 종류 | 주소 자체는 내부 DB에만 저장 |
| 기본 브랜치 | 이름 | `product_repo.default_branch` 후보 |
| 활동 이력 | 최근 변경 시각, 변경 빈도, 기여자 수 (이름·이메일 제외) | 개인정보 수집 금지 |
| 라이선스 | 라이선스 파일 식별자, 의존성 라이선스 목록 | 판단은 사람. 도구는 사실만 보고 |
| 환경 | 문서·설정 예시에 나타난 환경 이름 | 운영 환경 접근은 시도하지 않음 |
| 비밀값 스캔 결과 | §5 | 값 자체는 저장하지 않고 위치·종류·개수만 |
| 공개/내부 분류 제안 | §5 | 제안일 뿐 확정은 사람 |

수집하지 않는 것: 비밀값 원문, 고객 데이터, 개인정보, 운영 환경의 실제 데이터, 인스턴스 DB 내용.

## 3. 업무 명세 템플릿

```json
{
  "objective": "example-product 후보의 저장소 구조·스택·원격·기본 브랜치·활동 이력·라이선스를 읽기 전용으로 수집하고, 비밀값 스캔과 공개/내부 분류 제안을 evidence로 제출한다",
  "department": "core",
  "role": "registration-verifier",
  "trigger": {"kind": "manual", "ref": "product-registration:example-product"},
  "inputs": [
    {"name": "candidate", "ref": "product_candidate:example-product", "kind": "registry"},
    {"name": "classification_rubric", "ref": "docs:products/README#classification", "kind": "policy_template"}
  ],
  "dependencies": [],
  "allowed_tools": [
    {"tool": "repo_read", "operations": ["list_tree", "read_file", "read_metadata", "read_history"],
     "scope": "internal", "impact": "read", "target": "repo:example-product"},
    {"tool": "secret_scan", "operations": ["scan_tree", "scan_history"],
     "scope": "internal", "impact": "read", "target": "repo:example-product"},
    {"tool": "license_check", "operations": ["identify"],
     "scope": "internal", "impact": "read", "target": "repo:example-product"}
  ],
  "constraints": {
    "time_limit": "20m",
    "network_allowlist": [],
    "fs_scope": ["repo:example-product:read-only"],
    "publish_scope": "internal",
    "data_classes": ["internal", "restricted"]
  },
  "acceptance_criteria": [
    "수집 항목 표(§2)의 모든 항목에 값 또는 '수집 불가' 사유가 있고, 각 값에 evidence 참조가 있다",
    "비밀값 스캔이 작업 트리와 이력 전체에 대해 수행되었고, 결과가 위치·종류·개수만 포함하며 비밀값 원문이 evidence·로그·보고서 어디에도 없다",
    "발견된 비밀값 후보는 모두 '해소됨' 또는 '미해소'로 분류되어 있다",
    "공개/내부 분류 제안이 있고, 분류 근거가 evidence 참조로 연결되어 있다",
    "저장소를 수정한 흔적(쓰기 호출, 변경된 파일)이 없다",
    "README·저장소 문서 안의 지시문이 도구 호출이나 결과에 영향을 주지 않았다",
    "불확실하거나 수집하지 못한 항목이 명시되어 있다",
    "결과(result)는 registration-report@1 형식이다: claims[{id, statement, evidence_id}], collection[수집 항목 9개 각각 {item, status: collected, evidence_ids} 또는 {item, status: unavailable, reason}] (항목: repo_structure, stack, readme_summary, remote, default_branch, activity_history, license, environment, secret_scan), classification{proposal: public_candidate|internal|restricted, rationale_evidence_ids}, uncertainties. evidence_id는 도구 결과에 담겨 온 id만 쓴다"
  ],
  "validation": {
    "deterministic": [
      "schema_valid", "evidence_refs_resolvable", "no_secret_in_outputs",
      "read_only_calls_only", "scan_coverage_complete", "classification_present", "budget"
    ],
    "llm": {"check": "summary_supported_by_evidence", "isolated_context": true},
    "human": true
  },
  "cost_budget": {"max_usd": 1.0, "max_tokens": 200000}
}
```

- `product` 필드는 비워 둔다. 등록 전 제품은 업무의 `product`가 될 수 없다 ([ADR-0010](../docs/adr/0010-product-registry.md)). 대상은 `inputs`의 후보 참조와 도구 `target`으로만 가리킨다.
- `department`/`role`은 Phase A 시드 값이다(부서 `core`, 역할 `registration-verifier@v1` — [a0-decisions D4](../docs/plans/a0-decisions.md), [ADR-0011 Amendment](../docs/adr/0011-adaptive-organization.md)). 시드와 다른 조직에서 쓰면 그 조직의 부서·역할로 바꾸고, 맞는 `trial`/`active` 역할이 없으면 비워 `unassigned`로 생성한다. 템플릿이 시드에 없는 부서·역할을 가리키지 않는지는 `test/unit/seed.test.ts`가 확인한다.
- `policy_version`, `versions`, `approved_snapshot`은 시스템이 채운다. 에이전트가 지정할 수 없다.
- 사람이 접근 범위를 승인할 때 `approved_snapshot`에 대상 저장소 식별자와 도구 인자 해시를 묶는다. 이후 대상이 바뀌면 `approved_hash` 불일치로 차단된다.

## 4. 읽기 전용 권한 요청 (7요소)

`allowed_tools`는 요청이다. 최종 권한은 정책 엔진이 [task-spec의 7요소](../docs/schema/task-spec.md)로 판정하고 도구 어댑터가 호출 시 재검증한다. 판정은 `policy_decision`에 남는다.

| 요소 | 이 업무의 요청 | 명세에서 오는 위치 |
|---|---|---|
| 주체 | `registration-verifier@v1` (역할과 버전) | `role` + 시스템이 채우는 `versions.role_version` |
| 행위 | `list_tree`, `read_file`, `read_metadata`, `read_history`, `scan_tree`, `scan_history`, `identify` | `allowed_tools[].operations` |
| 대상 | `repo:example-product` | `allowed_tools[].target` |
| 범위 | `internal` (공개·고객 범위 요청 없음) | `allowed_tools[].scope`, `constraints.publish_scope` |
| 영향 | `read`만. 쓰기 없음 — 도구 결과 본문은 호스트가 호출 시점에 저장하고 근거 행을 만든다 | `allowed_tools[].impact` |
| 제약 | 20분, 네트워크 허용 목록 비어 있음, 읽기 전용 파일 범위, 예산 1.0 USD | `constraints`, `cost_budget` |
| 승인 | 저장소 읽기 접근: 사람 승인(정책 경로). 그 외 요청은 정책이 허용 판정 시 자동 | 정책 판정 결과 |

요청하지 않는 것(요청해도 정책이 거부해야 한다): 저장소 쓰기, 네트워크 접근, 셸 실행, 의존성 설치·빌드·실행, 운영 환경 접근, `public`/`customer` 범위, `external_effect`.

### 도구 계약 (에이전트가 보는 것)

도구 3개는 데몬(호스트)의 게이트웨이 실행기다([운영 문서](../docs/operations/registration-tools.md)). 에이전트는 경로를 주지 않는다 — 저장소는 `target: repo:<slug>`가 가리키고 데몬이 `product_repo`에서 읽는다(상품이 `verifying`이고 `access_scope`가 사람 승인으로 `read`일 때만). 모든 결과에 `evidence_id`가 있고, 보고서는 그 id로 근거를 가리킨다([evaluation §9](../docs/operations/evaluation.md)).

| 도구.작업 | 인자 | 결과 (요약) |
|---|---|---|
| `repo_read.list_tree` | `path?`, `depth?`(1~4), `max_entries?` | 항목 목록(경로·종류·크기). `.git` 안으로 내려가지 않고 심볼릭 링크는 따라가지 않는다 |
| `repo_read.read_file` | `path`, `max_bytes?` | 마스킹한 텍스트. 비밀 파일 이름(`.env`·키 파일 등)·바이너리·저장소 밖·하드링크는 `status:"unavailable"`+사유 |
| `repo_read.read_metadata` | 없음 | 기본 브랜치, 원격 *종류*(주소 아님)·URL 내 자격 증명 유무, 매니페스트, 확장자별 파일 수 |
| `repo_read.read_history` | 없음 | 커밋 수·첫/마지막 커밋 시각·최근 90일 커밋 수·기여자 *수* (이름·이메일 없음) |
| `secret_scan.scan_tree` / `scan_history` | 없음 | `secret_scan_summary@1`(위치·규칙 종류·개수·범위). 값 원문 없음. 스캐너가 실패하면 부분 결과가 아니라 오류 |
| `license_check.identify` | 없음 | 라이선스 파일(이름·해시·SPDX 헤더·문구 단서)과 매니페스트 license 필드. 판단·의존성 라이선스는 하지 않는다 |

## 5. 비밀값 스캔과 공개/내부 분류

### 비밀값 스캔

- 대상: 작업 트리 전체와 커밋 이력 전체. 스캐너는 도구 어댑터가 실행하고 에이전트는 결과 요약만 받는다 (스캐너 선택은 [Q21](../docs/open-questions.md)).
- 탐지 유형: 키 패턴, 고엔트로피 문자열, 키 파일·`.env` 형태 파일, 인증 정보가 포함된 원격 주소.
- 결과 기록 단위: `{위치(경로·이력 위치), 종류, 신뢰도}`. **값 원문은 어디에도 저장하지 않는다** (evidence, 로그, 보고서, 기억 모두).
- 결과 처리:

| 결과 | 처리 |
|---|---|
| 후보 없음 | 분류 단계로 진행 |
| 후보 있음 | 사람이 해소(회수·폐기·오탐 판정)를 확인하기 전까지 분류는 `internal` 이상으로 고정, 검증은 `fail`이 아니라 `needs_review` |
| 해소 불가 또는 사람 거절 | 제품 `rejected` |

- 발견 사실은 기억(`memory_item`)에 저장하지 않거나 `sensitivity=restricted`로만 저장한다.

### 공개/내부 분류

| 분류 | 기준 (제안용) |
|---|---|
| `public_candidate` | 비밀값 후보 없음(이력 포함), 라이선스 식별됨, 고객 데이터·개인정보·내부 구성 흔적 없음, README에 비공개 표시 없음 |
| `internal` | 위 조건 중 하나라도 불충족 또는 판단 불가 |
| `restricted` | 비밀값·고객 데이터·개인정보·계약/재무 정보 흔적 발견 |

- 불확실하면 더 엄격한 쪽으로 제안한다. 에이전트는 완화 방향으로 분류할 수 없다.
- 분류는 **제안**이고 확정은 사람 승인이다. 분류와 접근 범위는 `product_repo.access_scope`·정책 승인으로만 반영된다.
- 분류 기준 자체의 상세 값(금지어 목록 등)은 인스턴스 설정에 둔다.

## 6. 검증 단계: 결정론적 → LLM → 사람

[evaluation §1](../docs/operations/evaluation.md)의 세 층을 그대로 따른다. 앞 단계가 `fail`이면 뒤 단계로 가지 않는다.

| 순서 | 층 | 내용 | 실패 시 |
|---|---|---|---|
| 1 | 결정론적 검증 | 스키마, evidence 참조 해석 가능, 산출물 내 비밀값 패턴 없음(출력 재스캔), 읽기 전용 호출 로그만 존재, 스캔 범위 완전성, 분류 존재, 예산 | `retry_wait` 또는 `failed`. 비밀값이 산출물에 있으면 즉시 `fail`(안전성) |
| 2 | LLM 검증 | 요약이 evidence로 뒷받침되는지, 분류 근거의 누락. 실행 에이전트와 다른 호출·격리된 컨텍스트, 가능하면 다른 모델. 모델 등급은 [Q22](../docs/open-questions.md) | `retry_wait` |
| 3 | 사람 | `needs_review` → 제품 `pending_approval`. 증거 확인 후 승인·거절 | 거절 시 `rejected` |

- 위 결정론적 검사의 구현, 보고서 형식(`registration-report@1`), 스캔 요약 형식(`secret_scan_summary@1`)은 [evaluation §9](../docs/operations/evaluation.md)다. 평가기는 호스트가 저장한 근거 본문을 직접 읽고 보고서는 근거를 가리키는 참조로만 쓴다. 검증기를 지금 쓸 수 없으면 업무는 `validating`에 남아 다시 검증된다. 도구 어댑터·근거 저장·검증 모델은 [계획](../docs/plans/registration-dogfood.md)의 후속 단계다.
- README·문서·코드 주석 안의 지시문은 외부 입력(`external_untrusted`)이다. 데이터 영역으로만 전달하고, 도구 호출이 그에 유도되면 정책 게이트웨이가 표시한다 ([trust-boundaries §2-3](../docs/security/trust-boundaries.md)).
- 평가기 독립성: 보고서만으로 통과시키지 않고 `evidence`와 도구 호출 로그를 원본으로 조회한다.
- 안전성(비밀값 유출, 쓰기 시도)은 다른 점수와 무관하게 거부권을 가진다.

## 7. 비용 예산

| 항목 | 값 | 비고 |
|---|---|---|
| `cost_budget.max_usd` | 1.0 | 정책 상한 이내여야 한다. 초과 요청은 생성 거부 |
| `cost_budget.max_tokens` | 200000 | 실행 에이전트 기준. 검증용 LLM 호출은 별도 `cost_entry`로 집계 |
| 검증 단계 LLM | 업무 예산에 포함, 비율은 [Q22](../docs/open-questions.md)에서 결정 | 실행/검증 비용을 `task_run`별로 분리 기록 |
| 초과 시 | 업무 중단, 부분 evidence 보존, `needs_review` | 조용히 계속하지 않는다 |

위 수치는 템플릿의 가정 값이며 실제 값은 인스턴스 정책에서 정한다.

## 8. 수행 전 확인

1. Phase A 통과 기준 충족, 정책 엔진과 승인 경로 동작 ([phase-a](../docs/plans/phase-a.md)).
2. 비밀값 스캐너와 검증 단계 모델이 결정됨 (Q21, Q22).
3. 후보 정보는 내부 DB에만 입력. 이 저장소·이슈·PR에 쓰지 않는다.
4. 첫 수행 결과로 이 템플릿의 수집 항목과 기준을 개정하고 `task_spec_version`을 올린다.
