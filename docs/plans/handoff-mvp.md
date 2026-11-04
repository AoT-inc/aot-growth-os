# 인계: MVP 코드 완료 후 (2026-11-04)

Phase A(A0~A6)와 Phase B(B1~B6, [phase-b](phase-b.md))의 코드가 PR #16에 모두 있다. 남은 것은 **사용자 PC에서만 할 수 있는 검증**과 **사용자 결정**이다.

## 코드 상태
- 검사: typecheck, lint, 경계 lint, 단위 1374, 경계 3, 통합 299(macOS 환경 실패 2건은 Linux CI에서 통과), 비밀값 스캔.
- 병합은 사용자 지시 후. 병합 전: 승인 엔진·권한 경로(`packages/policy/src/engine.ts`의 org_proposal, `packages/domain/src/org.ts`)의 **독립 보안 리뷰**.

## 사용자 PC에서 할 일 (MVP 종료 조건)
1. `npm ci`(Node 24) 후 `npm run preflight -- <데몬 설정>` — 실제 `claude`·`gitleaks`·DB로 점검, 문제 해결.
2. 섀도 파일럿 5건 — [shadow-pilot 절차서](../operations/shadow-pilot.md). 기준: "지원됐는데 사람이 거부" = 0.
3. 검증기 전체 옵션 모양 호출 확인, 구독 사용률 척도·한도 문구 관찰 → [claude-code-cli §4](../operations/claude-code-cli.md) 기록.
4. 결과를 받아 Q22·phase-a §6 종료 조건 4번 문서 개정(이 저장소에서).
5. 조직 변경 첫 실사용: `org signals` → `org propose` ([운영 절차](../operations/org-change.md)).

## 열린 사용자 결정
- Phase B 잠정 결정 Q11·Q12·Q13·Q16과 업무 유형 파생, 제안 연산 범위 ([phase-b](phase-b.md) 맨 위 표).
- 시험 중 제안을 사람이 중단하는 경로(상태표 개정 필요), 루틴이 아닌 업무의 유형 구분(스키마 필드).
- 이전부터 열림: 주간 루틴을 켜는 운영 경로, 출하 템플릿 `expected_quotes`, Q27, Q17, Q14 후속, WP3·WP4(승인 시 수집 사실 반영, 검증 중 반려), WP6(라이선스 수집).
- 오래된 브랜치 정리.
