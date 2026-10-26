# Phase A 인계: A6 완료 후 (2026-10-24)

Phase A의 A6(주간 사이클 1~7단계 통합)까지 구현·검증을 마쳤다. 이 문서는 이어서 할 일과 주의사항이다. 단계별 상세와 Phase A 종료 조건 충족 현황은 [phase-a.md](phase-a.md)의 "A6 완료 기록"이 정본이다.

## 현재 상태
- 브랜치 `art/phase-a-review-fixes-ee5e6e` (origin 에 push 됨, PR 열림). 모든 커밋 `-s` 서명.
- 원격 CI(`ubuntu-latest`)가 A6 커밋 `3eda59c`에서 성공: 단위 889, 통합 168건 중 167 통과·1 skip(의도적 `denied_tool`), 경계 3. Linux 러너에서 Docker 시험이 돌았다.
- 로컬 확인(macOS Docker Desktop): typecheck·lint·lint:boundaries·check:schema·scan:secrets 통과, 통합 5회 반복 무실패.

## 남은 일
1. **종료 조건 미충족** ([phase-a.md §6](phase-a.md) 현황 참고)
   - 스파이크 Q14(외부 부작용 도구별 멱등 키 지원 조사)는 2026-10-25 문서 조사로 기록했고 계약 결정(동작 단위 `{supported, retention_ms}`, 재전송은 보존 기간의 50% 안, 조회형 `effect_key` 전달 선언)을 승인받았다([q14](../spikes/q14-idempotency-support.md)). 엔진 구현은 같은 날 끝났다(커밋 7fc4b02, fc84679: 동작 단위 선언, `planned_at`·`idempotency_retention_ms`, 재전송 창 판정). 남은 것: 실제 부작용 어댑터, 어댑터 계약 시험(A5), 오류 매핑 적용, `tool_contract_version` 해시 계산. 알려진 틈 둘은 닫혔다(4e7238a, c69454e). 사람이 `unknown` 효과를 `confirmed`/`failed`로 확정하는 경로는 만들었다(커밋 62056a6: 승인 CLI `effects`·`resolve-effect`; 확정 뒤 `needs_review` 업무는 기존 `approve`로 재큐). 열린 것(사용자 결정): 해소 뒤 재전송이 다시 `unknown`이 되면 두 번째 해소 불가(`resolved_before`), `failed`의 다중 승인자·cooldown은 스키마 변경 필요. TOTP 잠금은 프로세스 메모리(기존). [recovery §3](../operations/recovery.md).
   - 상품 등록 업무 수행 준비: Q22(검증 모델 등급·비용 비율)와 저장소 읽기·비밀값 스캐너 도구 어댑터가 없다.
2. **설계 결정이 필요한 틈** (사용자 결정 후 진행)
   - 출하된 조사 템플릿(`packs/example-marketing/workflows/`)에 `expected_quotes`가 없고 `validation.llm`이 `null`이라, 실제 조사 에이전트로는 항상 `inconclusive`가 된다(시험은 팩 사본에 두 필드를 더해 돌린다).
   - 주간 기획 루틴을 켜는 운영 경로가 없다(시험은 DB를 직접 수정).
3. **열린 항목:** Q17 `memory.default_validity`, Q22, Q27(평가기 교체 절차), 측정 값 정정 절차, 기억 입력 내용의 어댑터 전달, 거절·승격 뒤 이미 만든 업무의 취소 없음, `inconclusive` 뒤 재측정 절차 없음. rootless Docker/Podman은 후속 검토(Linux는 rootful Docker로 결정).

## 확정된 결정 (A6, 2026-10-24)
- Q5 측정 신호 = 랜딩 페이지 1개의 주간 전환 수. Phase A는 사람이 값을 입력하고 근거를 `evidence`로 첨부(분석 API 연결은 후속).
- `require_approval` 호출은 게이트웨이에서 막힘 유지. LLM 검증기는 `kind:"stub"`와 `kind:"claude_code_cli"`(2026-10-26, Q22; PC 구독 로그인 확인과 섀도 파일럿은 남음).
- 측정 값은 대기 조건(입력 전에는 업무를 집지 않음). 실험 판정 단위 = 1주·관측 1. 실험(`strategy_version`) 승인 = 사람 1인, 상태 허용표에 `experiment → rejected` 추가.

## 작업 규칙
- Node 24 필수(`npm ci`). 검사: `npm run typecheck`, `lint`, `lint:boundaries`, `check:schema`, `scan:secrets`, `test:unit`, `test:integration`(Docker 필요, 없으면 skip+사유 출력). 통합 시험은 같은 호스트에서 동시에 두 번 돌리지 않는다.
- 공개 저장소: 개인 경로·비밀값·실제 제품명 금지(`example-product`, `example.com`). 경계 lint·sql-guard 완화 금지, 시간은 주입 Clock, 쓰기는 `Db.writeTx`. 스키마·상태 허용표 변경은 사용자 결정 후.
- 서브에이전트 보고는 믿지 말고 검사를 다시 돌린다. 커밋은 `-s` 서명.
