# 조직 변경 운영 (Phase B)

설계는 [ADR-0011](../adr/0011-adaptive-organization.md)과 [phase-b 계획](../plans/phase-b.md). 이 문서는 사람이 쓰는 절차만 적는다. 모든 명령은 승인 CLI(`apps/daemon/src/approve.ts`)이며 사람 actor 전용이다.

## 1. 신호 보기
`org signals` — 최근 30일 `unassigned` 업무를 유형별로 세고(임계값 3건 이상이면 `candidate`), 역할별 `needs_review`·`failed` 반복을 보여 준다. 모델을 부르지 않는다.

## 2. 제안 만들기
**보통은 JSON을 쓰지 않는다.** 신호에서 초안을 자동으로 만든다:
```
org propose --type weekly-market-research --role market-researcher [--unit research]
```
- `--type`은 `org signals`에 나온 업무 유형. 그 유형의 `unassigned` 업무가 최근 30일에 있어야 한다(근거).
- 새 역할의 도구는 지금 `generalist`와 같다(권한 확대 없음 = 일반 변경). 평가·롤백 계획은 기본값(통과율 0.8, 최소 3건, 비용 $5, 14일; 롤백은 `generalist`로 재배정).
- `--unit`을 생략하면 `core`. 기존에 없는 slug를 주면 새 부서를 함께 만든다.
- 응답의 `proposal_id`를 `show org <id>`로 확인하고 승인한다(§3).

기본값과 다른 제안(권한이 다른 역할, 다른 평가 기준 등)만 아래 JSON 파일로 직접 쓴다.

### 직접 쓰는 제안서
`org propose --file proposal.json` — `proposal.json` (모든 필드 필수, 모르는 필드는 거부):
```json
{
  "diff": {"ops": [{"op": "add_role", "role": {
    "slug": "market-researcher",
    "description": "시장 조사 전담",
    "allowed_tools": [{"tool": "web_search", "operations": ["search"]}],
    "unit": {"slug": "research", "name": "research", "responsibility": "시장 조사"}
  }}]},
  "rationale": "unassigned 시장 조사 업무가 반복된다 (org signals)",
  "evidence_refs": ["signals:unassigned"],
  "expected_effect": "시장 조사 업무가 처리된다",
  "risk_assessment": {"risks": ["새 역할의 품질"], "mitigations": ["시험은 조사 업무로 제한"]},
  "evaluation_plan": {"min_pass_rate": 0.8, "min_observations": 3, "max_cost_usd": 5, "baseline_window_days": 30, "evaluation_days": 14},
  "rollback_plan": {"org_version": "restore_parent", "routines": "disable", "queued_tasks": {"reroute_to": "generalist"}, "running_tasks": "finish", "external_effects": "human"},
  "trial_scope": {"task_types": ["weekly-market-research"]}
}
```
- `unit`은 기존 부서의 slug 문자열이거나, 새 부서 `{slug, name, responsibility}`.
- 선택: `trial_min_days`(기본 14, 7~90), `ttl_days`(승인 만료까지, 기본 14).
- `evaluation_days`는 `trial_min_days` 이상이어야 한다. `rollback_plan`의 값은 지원하는 처리 하나뿐이고, `reroute_to`는 active 역할이어야 한다.
- 정책·검증기·평가기·승인 엔진을 가리키는 연산·도구·이름은 거부된다. 새 역할이 지금 어느 active 역할도 요청하지 않는 (도구, 작업)을 요청하면 `risky`(권한 확대)로 분류된다 — 등급은 입력하지 않는다.

응답: `proposal_id`, `change_class`, 위험 사유.

## 3. 승인
`show org <id>`로 내용과 `hash`를 본 뒤 `approve org <id> --hash <hash>`. 일반 변경은 바로 `approved`. 위험 변경은 대기(정책 `risky_change.cooldown`) 뒤 `release org <id> --totp-stdin`. 대기 중에는 `cancel org <id>`로 철회할 수 있다. 거절은 `reject org <id> --comment 사유`. 승인 전에 조직 버전이 바뀌었거나 만료되면 `superseded`/`expired`로 기록되고 새로 제안해야 한다.

## 4. 시험과 판정 (데몬이 한다)
승인된 제안은 다음 데몬 주기에 시험(`trial`)이 된다: 새 역할·부서가 `trial`로 생기고, 범위 안 `unassigned` 업무가 그 역할에 배정된다. 판정은 `org status <id>`의 `results`로 본다.
- `fail`(안전성 실패 1건, 비용 초과, 통과율 미달) → 자동 롤백: 새 역할·부서 `retired`, 새 부서의 루틴 끔, 새 역할의 대기 업무는 `reroute_to` 역할로 이동, 직전 조직 버전 유지. 이미 나간 외부 부작용은 되돌리지 않는다 — `effects` 등으로 사람이 처리.
- `inconclusive`(기간이 끝났는데 관측 부족) → 새 역할은 업무를 더 받지 않는다. `org retrial <id> --file plan.json --comment 사유`로 1회 다시 시험할 수 있다.
- `pass` → 데몬이 "사람 확인 대기"를 로그에 남긴다. 자동 승격은 없다.

## 5. 확정과 되돌리기
`org confirm <id> --comment 사유` — 평가 `pass`가 있을 때만. 새 조직 버전이 `active`가 되고 이전 버전은 `retired`. 확정 뒤 문제가 보이면 `org rollback <id> --comment 사유`(직전 버전 복구, 새 역할 폐지), 역할을 접으려면 `org retire <id> --comment 사유`. 둘 다 사유 필수, 삭제가 아니라 기록이 남는다.
