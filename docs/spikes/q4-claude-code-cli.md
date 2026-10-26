# 스파이크 Q4: Claude Code CLI(구독) 헤드리스 실행

상태: **부분 수행 (2026-10-26)** — CLI 인터페이스 정적 확인 완료, 실제 실행 시험은 사무실 PC에서 사람이 수행해야 함 · 관련: [open-questions Q4](../open-questions.md), [ADR-0005 Amendment 2026-10-25](../adr/0005-agent-adapter-boundary.md), [phase-a 스파이크 2](../plans/phase-a.md)

## 이 스파이크가 확인한 것과 못 한 것

| 구분 | 내용 |
|---|---|
| 확인함 | `claude` 2.1.310의 `--help`와 하위 명령을 읽어 판정 기준 (1)~(6)에 필요한 옵션이 있는지 본 것(정적 확인) |
| 확인 못 함 | 실제 업무 실행. 이 클라우드 세션의 `claude`는 호스트가 관리하는 인증을 쓰므로 *구독 로그인*의 동작(한도 도달, 로그인 만료, 오류 형식)을 대변하지 못하고, 모델 호출은 이 세션의 사용량을 쓴다. 그래서 모델 호출 시험은 하지 않았다 |
| 사람이 할 일 | 아래 §4의 실측 절차를 사무실 PC(구독 로그인된 계정)에서 수행하고 결과를 이 문서에 기록. 약관 확인 포함 |

판정 기준 (1)~(6)은 [phase-a 스파이크 2](../plans/phase-a.md)에서 시험 전에 고정한 것이며 여기서 바꾸지 않았다.

## 1. 결론 (정적 확인 기준)

- **(3) 도구 허용 목록 강제는 옵션이 충분히 있다.** `--tools`(내장 도구 집합 지정, `""`면 전부 끔), `--allowedTools`/`--disallowedTools`, `--strict-mcp-config` + `--mcp-config`(지정한 MCP만), `--restricted`(Bash·코드 실행 도구·WebFetch 제거, 사용자·프로젝트·로컬 설정 무시, 파일 도구를 작업 디렉터리로 제한, `bypassPermissions` 거부, 설정·git·도구 설정 파일 쓰기는 사람 또는 지정 핸들러만 승인), `--permission-prompts none`(묻는 것은 전부 자동 거부), `--permission-mode dontAsk`.
- **(5) 개인 설정 유입 차단 옵션도 있다.** `--setting-sources`, `--settings`, `--disable-slash-commands`(스킬·명령 끔), `--safe-mode`(CLAUDE.md·스킬·플러그인·훅·MCP 등 전부 끔, 인증·모델·내장 도구·권한은 정상), `--strict-mcp-config`. 이 옵션들이 *조합되어* 개인 환경이 새지 않는지는 실측해야 한다.
- **⚠ `--bare`는 쓸 수 없다.** `--bare`는 훅·플러그인·CLAUDE.md 탐색·키체인 읽기를 끄는 가장 강한 격리지만 인증을 `ANTHROPIC_API_KEY` 또는 `apiKeyHelper`로만 받고 *OAuth와 키체인은 읽지 않는다*. 구독 로그인과 양립하지 않는다. 구독 방식의 격리는 `--restricted` + `--safe-mode`/`--setting-sources` 계열 조합으로 해야 하며, 이 때문에 API 키 방식보다 격리가 약해진다. ADR-0005 Amendment가 "컨테이너보다 약하다"고 적은 한계에 더해지는 한계다.
- **(1) 종료 코드·구조화 출력.** `-p/--print`, `--output-format json|stream-json`(`--verbose`와 함께 쓰는 실시간 스트림), `--json-schema`(구조화 결과 검증), `--no-session-persistence`(디스크에 세션을 남기지 않음), `--session-id`가 있다. 종료 코드의 의미는 실측해야 한다.
- **(2) 비용·로그 매핑.** `stream-json`의 최종 결과 메시지에서 비용·토큰을 읽어 `cost`로 매핑하는 설계다. 필드 이름은 실측해야 한다. 구독에서 비용 필드가 추정치인지, 아예 없는지도 실측 대상이다.
- **한도 항목.** `--max-turns` 옵션은 이 버전(2.1.310)의 도움말에 *없다*. 턴 수 제한은 어댑터가 `stream-json`에서 턴을 세어 `AbortSignal`로 프로세스를 종료하는 방식으로 대체한다(시간 제한은 이미 실행 관리가 강제한다). `--max-budget-usd`는 있으나 구독 모델에서는 의미가 없어 쓰지 않는다.
- **(4) 비밀값.** CLI 쪽에서 막을 수 있는 옵션은 없다. 기존 원칙대로 비밀값은 도구 게이트웨이(MCP 서버)의 실행기가 안에서 주입하고, CLI 프로세스 환경에는 넣지 않는다.
- **인증.** `claude auth login/status/logout`과 `claude setup-token`("장기 인증 토큰 설정, 구독 필요")이 있다. 데몬 전용 OS 계정에서 쓸 때 `setup-token` 경로가 대상이 될 수 있으나, 약관상 허용 범위와 토큰 주입 방식은 미확인이다. [ADR-0005 Amendment](../adr/0005-agent-adapter-boundary.md)의 "공식 CLI를 그대로 실행하는 방식만" 원칙은 유지한다.

## 2. 판정 기준별 현황

| # | 기준 | 정적 확인 | 실측 필요 항목 | 판정 |
|---|---|---|---|---|
| 1 | 사람 개입 없이 시작·종료, 종료 코드와 JSON으로 성공/실패 | 옵션 있음 | 성공·실패·거부·타임아웃 종료 코드, `json` 결과 필드 | 대기 |
| 2 | `result`/`evidence`/`run_log`/`cost` 변환 | 옵션 있음 | `stream-json` 이벤트 형식, 비용 필드의 존재·의미 | 대기 |
| 3 | 도구 허용 목록·작업 범위·시간·턴 한도 강제, 내장 Bash 기본 거부 | 옵션 있음 (`--max-turns` 없음 → 어댑터가 대체) | 거부한 도구 호출이 실제로 실패하는지, 작업 디렉터리 밖 읽기·쓰기 실패 | 대기 |
| 4 | 비밀값을 컨텍스트에 넣지 않고 동작 | 설계상 가능 | 환경 변수·MCP 응답에 비밀값이 없는지 | 대기 |
| 5 | 전역 설정·스킬·MCP 유입 차단 | 옵션 있음 (`--bare`는 구독과 양립 불가) | 조합 옵션으로 사용자 전역 스킬·MCP·CLAUDE.md가 실제로 안 보이는지 | 대기 |
| 6 | 사용량 한도·로그인 만료를 다른 오류와 구분 | 정적으로는 확인 불가 | 한도 도달·로그아웃 상태의 종료 코드와 오류 메시지 | 대기 |

(3)·(4)·(5) 중 하나라도 실측에서 불충족이면 이 어댑터 후보는 제외한다(판정 기준 원문). 이 경우 대안은 API 키 + `--bare`(격리는 강해지나 구독 이점이 사라짐)다.

## 3. 어댑터가 쓸 호출 모양 (실측 전 초안, 확정 아님)

업무 명세에서 작업 디렉터리와 설정 파일을 생성한 뒤 아래 모양으로 호출한다. 각 옵션이 의도대로 동작하는지는 §4에서 확인한다.

```sh
cd "$WORKDIR"
claude -p "$PROMPT" \
  --output-format stream-json --verbose \
  --no-session-persistence \
  --restricted --safe-mode \
  --tools "Read,Grep,Glob" \
  --strict-mcp-config --mcp-config gateway-mcp.json \
  --disable-slash-commands \
  --permission-mode dontAsk --permission-prompts none \
  --json-schema "$RESULT_SCHEMA" \
  --append-system-prompt "$TASK_INSTRUCTIONS"
```

`$WORKDIR`는 업무 전용 빈 디렉터리이고 읽기 전용으로 복사한 스킬·근거 파일만 둔다. `--tools`는 명세 `allowed_tools`에서 계산하고, `gateway-mcp.json`은 도구 게이트웨이 MCP 서버만 가리킨다.

어댑터 계약 매핑(초안): 입력 `task_spec`·허용 도구·근거 → 프롬프트와 `--tools`/MCP 설정, 예산 → 시간 제한과 턴 수(구독이므로 USD 아님), 출력 `result` → `--json-schema` 검증을 통과한 최종 메시지, `run_log` → `stream-json` 전체, `cost` → 결과 메시지의 비용 필드(`subscription_estimate`), 취소 → 프로세스 종료. 정책 판단은 어댑터가 아니라 게이트웨이가 한다.

## 4. 사무실 PC 실측 절차

전제: 구독 로그인된 `claude`가 있는 PC, 데몬 전용 OS 계정(또는 개인 계정에서 먼저 시험). 시험은 가상 저장소에서만 하고 실제 업무 데이터와 비밀값은 쓰지 않는다. 모델 호출은 사용량을 쓰므로 짧은 프롬프트로 한다.

1. **버전·인증 상태.** `claude --version`, `claude auth status`를 기록한다.
2. **(1) 종료 코드.** 아래를 각각 실행해 종료 코드와 `json` 출력을 기록한다.
   - 정상: `claude -p "2+2 만 답해" --output-format json --no-session-persistence`
   - 잘못된 옵션 값, 존재하지 않는 `--mcp-config` 파일
   - 시간 제한: `timeout 5 claude -p "긴 글을 써라" ...`
3. **(2) 스트림 형식.** `--output-format stream-json --verbose`의 이벤트 종류, 최종 결과 메시지의 비용·토큰·턴 수 필드 이름과 값(구독에서 비어 있는지)을 기록한다.
4. **(3) 도구 강제.** 가상 저장소에서 `--restricted --tools "Read"`로 실행하고, 프롬프트로 (a) 작업 디렉터리 밖 파일 읽기, (b) 파일 쓰기, (c) 셸 명령, (d) 웹 가져오기를 시도시켜 모두 실패하는지 확인한다. `--disallowedTools`·`--permission-prompts none`도 같은 방식으로 본다.
5. **(5) 유입 차단.** 사용자 전역에 시험용 스킬·MCP·CLAUDE.md 항목을 하나씩 두고(시험 후 제거), §3의 호출 모양에서 에이전트가 이를 인식하는지 확인한다. 인식하면 어떤 옵션을 더해야 사라지는지 기록한다.
6. **(4) 비밀값.** 시험 환경 변수에 가짜 비밀값을 두고 에이전트가 읽을 수 있는지 확인한다. 읽을 수 있으면 데몬이 CLI 프로세스에 넘기는 환경을 비우는 방식(`env -i` 등)이 필요하다.
7. **(6) 오류 구분.** `claude auth logout` 상태에서 실행한 오류, 가능하면 사용량 한도 도달 시의 종료 코드·메시지를 기록한다(한도는 일부러 소진하지 않고, 관찰된 사례나 공식 문서가 있으면 그것을 근거로 적는다).
8. **약관.** 구독 인증으로 `claude -p`를 자동 실행하는 사용이 현재 약관상 허용되는지, `setup-token` 경로가 이 용도에 맞는지 Anthropic의 최신 약관·문서에서 확인하고 인용 위치를 적는다.
9. 결과를 §2 표의 판정 열에 채우고, (3)·(4)·(5)가 불충족이면 [ADR-0005](../adr/0005-agent-adapter-boundary.md)와 [open-questions Q4](../open-questions.md)를 "후보 제외 → API 키 + `--bare` 재검토"로 갱신한다. 전부 통과하면 `claude-code-cli` 어댑터 구현 단위를 [phase-a](../plans/phase-a.md)에 추가한다.

## 5. 한계

- 이 문서의 정적 확인은 도움말 문구에 근거한다. 옵션이 있다는 것과 의도대로 강제된다는 것은 다르므로, 판정은 모두 "대기"다.
- 관찰한 버전은 2.1.310 하나다. CLI는 빠르게 바뀌므로 어댑터는 시작 시 버전을 기록하고, 계약 시험으로 옵션 동작(§4의 3·5)을 회귀 확인해야 한다.
