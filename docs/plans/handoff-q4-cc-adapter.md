# 인계: Q4 실측 완료 → `claude-code-cli` 어댑터 구현 (2026-10-26)

Q4 스파이크 실측과 약관 결정을 마쳤다(PR #5 머지, 커밋 `a5b7fc9`). 이 문서는 클라우드 세션이 어댑터 구현(CC1~CC5)을 이어받기 위한 인계다.

## 목표
[phase-a 스파이크 2](phase-a.md)의 구현 단위 제안 CC1~CC5를 순서대로 구현한다. 어댑터 계약은 `packages/agent-runtime/src/contract.ts`(`AgentAdapter`), 기존 구현 참고: `fake-adapter.ts`, `research-adapter.ts`, `container-adapter.ts`.

## 먼저 읽을 것 (이 순서)
1. [스파이크 Q4](../spikes/q4-claude-code-cli.md): §3(정정된 호출 모양), §4.1(실측 결과·오류 분류표·약관·"결정" 절의 가드레일 5개)
2. [ADR-0005](../adr/0005-agent-adapter-boundary.md) 2026-10-25·2026-10-26 Amendment, [open-questions Q4](../open-questions.md)
3. 이 저장소의 작업 규칙: [handoff-after-a6.md](handoff-after-a6.md) "작업 규칙" 절 (경계 lint 완화 금지, 주입 Clock, `Db.writeTx`, 커밋 `-s` 서명, 공개 저장소라 개인 경로·비밀값·실제 제품명 금지)

## 확정된 결정 (변경 금지, 사용자 결정 2026-10-26)
- 약관 회색지대 위험은 사용자가 감수. 대신 가드레일 5개를 설계 제약으로 지킨다: 토큰·로그인 정보 비접촉(앱이 `setup-token` 발급·주입 금지), 본인 PC·본인 구독·계정 공유/교대 금지, 호스팅 금지, 첫 실행 고지 동의, API 키 + `--bare` 대안 어댑터 유지.
- 호출 모양은 스파이크 §3 그대로: `--restricted --setting-sources ""`, `--tools "Read,Grep,Glob"`, `--allowedTools mcp__gateway__<tool>`, `--strict-mcp-config --mcp-config`, `--permission-mode dontAsk --permission-prompts none`, `env -i HOME USER LOGNAME PATH`. **`--safe-mode`·`--bare`는 쓰지 않는다**(게이트웨이 MCP가 꺼지거나 구독 로그인을 못 읽는다).
- 오류는 종료 코드가 아니라 JSON으로 분류한다: `is_error`·`terminal_reason`·`api_error_status`·`result` 문구·`permission_denials`·init의 `mcp_servers`. 도구 거부와 게이트웨이 연결 실패도 종료 코드 0이다.

## 이 클라우드 세션에서 하지 말 것·할 수 없는 것
- 구독 로그인이 없으므로 실제 `claude`로 모델을 호출하는 시험은 불가다. **로그인하지 말고, 토큰·키를 요청하거나 저장하지 말 것.** CC1~CC4는 가짜 `claude` 실행 파일(스텁 스크립트)과 스파이크 §4.1에 적힌 필드로 만든 고정 JSON(fixture)으로 시험한다.
- 한도 도달 실제 문구(CC3)와 데몬 계정 재시험(CC5)은 사용자의 PC에서 확인할 항목이다. 구현은 문구를 설정 가능한 목록으로 두고 "미확인" 표시를 코드 주석·테스트에 남긴다.

## 작업 순서·완료 기준
CC1 호출기 → CC2 결과 변환 → CC3 한도·로그인 처리(`needs_review` 매핑) → CC4 격리 회귀 계약 시험 → CC5(문서화만: 사용자 PC 재시험 절차). 각 단위는 단위 시험 통과 + `npm run check`(typecheck·lint·lint:boundaries·check:schema·scan:secrets) 통과로 끝. 새 브랜치에서 작업하고 단위마다 커밋, 푸시와 PR 생성은 해도 된다(머지는 하지 말고 사용자에게 보고).

## 열린 결정 (필요하면 사용자에게 질문)
- 요금제(Pro → Max 5x → API 전환 기준)는 시범 운영의 `total_cost_usd`·`rate_limit_event.utilization` 측정 후 정한다. 어댑터는 두 값을 `cost_entry`와 한도 접근 경고로 남길 것.
- `--max-budget-usd`를 추정치 기준 상한으로 쓸지, 턴 한도를 `assistant` 이벤트 계수로 강제할지는 CC1에서 제안 후 확인.
- 고지 동의(가드레일 4)를 앱 어느 화면·CLI에서 받을지.

## 진행 결과 (2026-10-26, 클라우드 세션)
- CC1~CC4 구현, CC5는 문서화: [phase-a.md 구현 기록](phase-a.md), [operations/claude-code-cli.md](../operations/claude-code-cli.md). 새 코드는 `packages/agent-runtime/src/claude-code/`, 시험은 `test/unit/claude-code-*.test.ts`·`test/integration/claude-code-*.test.ts`.
- 확인: typecheck·lint·lint:boundaries·단위(1183)·경계(3) 통과. 통합 시험의 실패 2건(소켓 권한 EACCES)은 이 컨테이너가 root라서 생기며 변경 전에도 같다. `check:schema`(sqlite3)·`scan:secrets`(gitleaks)는 이 컨테이너에 도구가 없어 실행하지 못했다. 로컬 Node는 22.22였다(저장소는 24 요구): `.ts` 직접 실행은 그대로 동작했다.
- 사용자 결정 필요(운영 문서 §5): 검토 대상 코드의 `needs_review` 연결, 비용 단위(`subscription_estimate`), 고지 동의를 받는 곳, `--max-budget-usd`·턴 한도 값.
- 사용자 PC에서 할 일(운영 문서 §4): 격리 회귀 B층 실행, 한도 도달 문구 확정, 데몬 계정 재시험.
