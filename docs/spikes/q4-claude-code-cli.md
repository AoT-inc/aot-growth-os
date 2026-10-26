# 스파이크 Q4: Claude Code CLI(구독) 헤드리스 실행

상태: **실측 완료 (2026-10-26)** — 판정 (1)~(5) 통과(호출 모양은 §3대로 *정정*), (6)은 로그인 구분만 통과·한도 도달은 미수행. **약관 허용 범위는 확인 못 함 → 사용자가 위험을 감수하고 진행하기로 결정(§4.1 "결정")** · 관련: [open-questions Q4](../open-questions.md), [ADR-0005 Amendment 2026-10-25](../adr/0005-agent-adapter-boundary.md), [phase-a 스파이크 2](../plans/phase-a.md)

## 이 스파이크가 확인한 것과 못 한 것

| 구분 | 내용 |
|---|---|
| 확인함 | `claude` 2.1.310의 `--help`와 하위 명령을 읽어 판정 기준 (1)~(6)에 필요한 옵션이 있는지 본 것(정적 확인) |
| 확인 못 함 | 실제 업무 실행. 이 클라우드 세션의 `claude`는 호스트가 관리하는 인증을 쓰므로 *구독 로그인*의 동작(한도 도달, 로그인 만료, 오류 형식)을 대변하지 못하고, 모델 호출은 이 세션의 사용량을 쓴다. 그래서 모델 호출 시험은 하지 않았다 |
| 실측(2026-10-26) | 구독(claude.ai) 로그인된 개발 PC(macOS, `claude` 2.1.263)에서 §4를 수행했다. 결과는 아래 §4.1. 사무실 PC·데몬 전용 OS 계정에서의 재확인은 하지 않았다 |
| 사람이 할 일 | 한도 도달 시 실제 메시지 확인(관찰되면), 데몬 계정에서 같은 호출 모양 재시험. 약관 허용 범위는 미확인이며 사용자가 위험을 감수하기로 결정(§4.1 "결정") |

판정 기준 (1)~(6)은 [phase-a 스파이크 2](../plans/phase-a.md)에서 시험 전에 고정한 것이며 여기서 바꾸지 않았다.

## 1. 결론 (정적 확인 기준 — 실측으로 정정된 부분은 §3·§4.1 참조)

- **(3) 도구 허용 목록 강제는 옵션이 충분히 있다.** `--tools`(내장 도구 집합 지정, `""`면 전부 끔), `--allowedTools`/`--disallowedTools`, `--strict-mcp-config` + `--mcp-config`(지정한 MCP만), `--restricted`(Bash·코드 실행 도구·WebFetch 제거, 사용자·프로젝트·로컬 설정 무시, 파일 도구를 작업 디렉터리로 제한, `bypassPermissions` 거부, 설정·git·도구 설정 파일 쓰기는 사람 또는 지정 핸들러만 승인), `--permission-prompts none`(묻는 것은 전부 자동 거부), `--permission-mode dontAsk`.
- **(5) 개인 설정 유입 차단 옵션도 있다.** `--setting-sources`, `--settings`, `--disable-slash-commands`(스킬·명령 끔), `--safe-mode`(CLAUDE.md·스킬·플러그인·훅·MCP 등 전부 끔, 인증·모델·내장 도구·권한은 정상), `--strict-mcp-config`. 이 옵션들이 *조합되어* 개인 환경이 새지 않는지는 실측해야 한다. **→ 실측 결과 `--safe-mode`는 `--mcp-config`의 게이트웨이 MCP까지 끄므로 호출 모양에서 뺐다(§3, §4.1).**
- **⚠ `--bare`는 쓸 수 없다.** `--bare`는 훅·플러그인·CLAUDE.md 탐색·키체인 읽기를 끄는 가장 강한 격리지만 인증을 `ANTHROPIC_API_KEY` 또는 `apiKeyHelper`로만 받고 *OAuth와 키체인은 읽지 않는다*. 구독 로그인과 양립하지 않는다. 구독 방식의 격리는 `--restricted` + `--safe-mode`/`--setting-sources` 계열 조합으로 해야 하며, 이 때문에 API 키 방식보다 격리가 약해진다. ADR-0005 Amendment가 "컨테이너보다 약하다"고 적은 한계에 더해지는 한계다.
- **(1) 종료 코드·구조화 출력.** `-p/--print`, `--output-format json|stream-json`(`--verbose`와 함께 쓰는 실시간 스트림), `--json-schema`(구조화 결과 검증), `--no-session-persistence`(디스크에 세션을 남기지 않음), `--session-id`가 있다. 종료 코드의 의미는 실측해야 한다.
- **(2) 비용·로그 매핑.** `stream-json`의 최종 결과 메시지에서 비용·토큰을 읽어 `cost`로 매핑하는 설계다. 필드 이름은 실측해야 한다. 구독에서 비용 필드가 추정치인지, 아예 없는지도 실측 대상이다.
- **한도 항목.** `--max-turns` 옵션은 이 버전(2.1.310)의 도움말에 *없다*. 턴 수 제한은 어댑터가 `stream-json`에서 턴을 세어 `AbortSignal`로 프로세스를 종료하는 방식으로 대체한다(시간 제한은 이미 실행 관리가 강제한다). `--max-budget-usd`는 있으나 구독 모델에서는 의미가 없어 쓰지 않는다.
- **(4) 비밀값.** CLI 쪽에서 막을 수 있는 옵션은 없다. 기존 원칙대로 비밀값은 도구 게이트웨이(MCP 서버)의 실행기가 안에서 주입하고, CLI 프로세스 환경에는 넣지 않는다.
- **인증.** `claude auth login/status/logout`과 `claude setup-token`("장기 인증 토큰 설정, 구독 필요")이 있다. 데몬 전용 OS 계정에서 쓸 때 `setup-token` 경로가 대상이 될 수 있으나, 약관상 허용 범위와 토큰 주입 방식은 미확인이다. [ADR-0005 Amendment](../adr/0005-agent-adapter-boundary.md)의 "공식 CLI를 그대로 실행하는 방식만" 원칙은 유지한다.

## 2. 판정 기준별 현황

| # | 기준 | 정적 확인 | 실측 필요 항목 | 판정 | 근거 (실측, 상세는 §4.1) |
|---|---|---|---|---|---|
| 1 | 사람 개입 없이 시작·종료, 종료 코드와 JSON으로 성공/실패 | 옵션 있음 | 성공·실패·거부·타임아웃 종료 코드, `json` 결과 필드 | **통과** | 정상 종료 코드 0·`is_error:false`·`terminal_reason:"completed"`. 인증 실패·예산 초과·잘못된 옵션·없는 MCP 파일은 종료 코드 1, `timeout` 종료는 124, SIGTERM은 143. **주의: 오류 종류는 종료 코드가 아니라 JSON(`result`·`terminal_reason`·`api_error_status`)으로 구분해야 한다.** |
| 2 | `result`/`evidence`/`run_log`/`cost` 변환 | 옵션 있음 | `stream-json` 이벤트 형식, 비용 필드의 존재·의미 | **통과** | `stream-json --verbose` 이벤트: `system/init`, `rate_limit_event`, `system/thinking_tokens`, `assistant`, `user`, `result`. 결과 메시지에 `total_cost_usd`·`usage`·`modelUsage`·`num_turns`·`duration_ms`가 채워지고 `modelUsage.*.costBasis:"list"`(정가 환산 추정치, 실제 청구 아님). `--json-schema` 사용 시 `structured_output`. |
| 3 | 도구 허용 목록·작업 범위·시간·턴 한도 강제, 내장 Bash 기본 거부 | 옵션 있음 (`--max-turns` 없음 → 어댑터가 대체) | 거부한 도구 호출이 실제로 실패하는지, 작업 디렉터리 밖 읽기·쓰기 실패 | **통과** (정정된 호출 모양 기준) | 작업 디렉터리 밖 Read·Grep, 심볼릭 링크 경유 읽기, `/etc/hosts`·`~/.claude/settings.json` 읽기 모두 `permission_denials`로 거부. Write·Bash·WebFetch는 `--tools`에서 빼면 도구 자체가 없고, 넣어도 `dontAsk`에서 거부되어 파일이 생기지 않음. `--max-turns`는 2.1.263에도 없음. **거부돼도 종료 코드는 0** → 어댑터가 `permission_denials`를 검사해야 함. |
| 4 | 비밀값을 컨텍스트에 넣지 않고 동작 | 설계상 가능 | 환경 변수·MCP 응답에 비밀값이 없는지 | **통과** (조건부) | 부모 환경의 가짜 비밀값은 Bash를 허용하면 에이전트가 그대로 읽음(새어 나감). `env -i`로 비운 환경에서는 읽지 못함. Bash 없는 호출 모양에서는 환경 변수를 읽을 도구가 없음. **조건: 내장 Bash 미허용 + 데몬이 `env -i`로 환경을 구성.** |
| 5 | 전역 설정·스킬·MCP 유입 차단 | 옵션 있음 (`--bare`는 구독과 양립 불가) | 조합 옵션으로 사용자 전역 스킬·MCP·CLAUDE.md가 실제로 안 보이는지 | **통과** (정정된 호출 모양 기준) | 옵션 없이는 전역 CLAUDE.md·스킬·MCP(`~/.claude.json`의 서버, claude.ai 커넥터)와 프로젝트의 훅·`.mcp.json`·스킬이 모두 유입됨. `--restricted --setting-sources "" --disable-slash-commands --strict-mcp-config`면 모두 차단. **단 §3 초안의 `--safe-mode`는 `--mcp-config`로 준 게이트웨이 MCP까지 끄므로 쓸 수 없다.** |
| 6 | 사용량 한도·로그인 만료를 다른 오류와 구분 | 정적으로는 확인 불가 | 한도 도달·로그아웃 상태의 종료 코드와 오류 메시지 | **일부 통과 / 한도는 미수행** | 로그인 없음: 종료 코드 1, `is_error:true`, `terminal_reason:"api_error"`, `result:"Not logged in · Please run /login"`, `api_error_status:null`. 무효 토큰: `api_error_status:401`, `result:"Failed to authenticate. API Error: 401 OAuth access token is invalid."`, `api_retry`(`authentication_failed`). 종료 코드는 모두 1이라 **메시지·`api_error_status`로 구분해야 함**. 한도 도달은 소진하지 않았으므로 미수행(공식 문서 메시지만 확인, §4.1). |

(3)·(4)·(5) 중 하나라도 실측에서 불충족이면 이 어댑터 후보는 제외한다(판정 기준 원문). 이 경우 대안은 API 키 + `--bare`(격리는 강해지나 구독 이점이 사라짐)다. **실측 결과 셋 모두 통과(정정된 호출 모양 기준)이므로 후보는 유지한다.** 단 (4)는 조건부이고, 약관 허용 범위는 확인하지 못했다.

## 3. 어댑터가 쓸 호출 모양 (2026-10-26 실측으로 정정, 게이트웨이 도구 이름은 예시)

업무 명세에서 작업 디렉터리와 설정 파일을 생성한 뒤 아래 모양으로 호출한다. 실측으로 동작을 확인한 모양이다(`haiku` 모델, 가상 저장소, 가짜 게이트웨이 MCP로 확인. 최종 모양 전체를 한 번에 실행해 `structured_output`·게이트웨이 호출·`permission_denials: []`를 확인함).

```sh
cd "$WORKDIR"
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="$SAFE_PATH" \
claude -p "$PROMPT" \
  --output-format stream-json --verbose \
  --no-session-persistence \
  --restricted --setting-sources "" \
  --tools "Read,Grep,Glob" \
  --allowedTools "mcp__gateway__<tool>" \
  --strict-mcp-config --mcp-config gateway-mcp.json \
  --disable-slash-commands \
  --permission-mode dontAsk --permission-prompts none \
  --json-schema "$RESULT_SCHEMA" \
  --append-system-prompt "$TASK_INSTRUCTIONS"
```

초안(`--restricted --safe-mode ...`)과 달라진 점:

| 변경 | 이유 (실측) |
|---|---|
| `--safe-mode` 제거, `--setting-sources ""` 추가 | `--safe-mode`는 `--mcp-config`로 지정한 MCP까지 모두 끈다(`mcp_servers: []`, 게이트웨이 도구가 안 보임). 게이트웨이를 쓸 수 없으므로 부적합. `--restricted`와 `--setting-sources ""`는 각각 단독으로도 전역·프로젝트의 CLAUDE.md를 컨텍스트에서 막고, 게이트웨이 MCP는 연결된다. |
| `--allowedTools "mcp__gateway__<tool>"` 추가 | `dontAsk`에서는 허용 목록에 없는 MCP 도구 호출이 거부된다(`permission_denials`). `--tools`는 내장 도구만 제한하고 MCP 도구는 연결되면 목록에 나타난다. 와일드카드(`mcp__gateway__*`)는 시험하지 않았다. |
| `env -i HOME USER LOGNAME PATH`로 감싸기 | 비밀값 차단(4). 이 macOS에서는 `USER`가 없으면 키체인의 구독 로그인을 못 읽어 "Not logged in"이 된다(`HOME`만으로는 부족). |
| (`--json-schema` 사용 시) 허용 도구에 `StructuredOutput`이 자동 추가됨 | init 이벤트에서 확인. 어댑터는 이 도구를 허용 목록 계산에서 제외하지 말 것. |

`$WORKDIR`는 업무 전용 빈 디렉터리이고 읽기 전용으로 복사한 스킬·근거 파일만 둔다. `--tools`는 명세 `allowed_tools`에서 계산하고, `gateway-mcp.json`은 도구 게이트웨이 MCP 서버만 가리킨다.

어댑터 계약 매핑: 입력 `task_spec`·허용 도구·근거 → 프롬프트와 `--tools`/`--allowedTools`/MCP 설정, 예산 → 시간 제한과 턴 수(구독이므로 USD 아님), 출력 `result` → `structured_output`(`--json-schema` 검증), `run_log` → `stream-json` 전체, `cost` → 결과 메시지의 `total_cost_usd`·`modelUsage`(`subscription_estimate`, 정가 환산 추정치), 오류 분류 → `is_error`·`terminal_reason`·`api_error_status`·`result` 문구·`permission_denials`(종료 코드는 거의 1 아니면 0이라 구분력이 없다), 취소 → SIGTERM(종료 코드 143, 결과 없음). 정책 판단은 어댑터가 아니라 게이트웨이가 한다.

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

## 4.1 실측 결과 (2026-10-26)

### 시험 환경

| 항목 | 값 |
|---|---|
| OS | macOS 26.4.1 (Darwin 25.4.0), arm64 |
| `claude` | 2.1.263 (`/opt/homebrew/bin/claude`). 같은 PC의 `~/.local/bin/claude`는 2.1.114로 시험하지 않음. **문서 초안이 본 2.1.310과 다르다.** `--restricted`, `--safe-mode`, `--permission-prompts`는 2.1.263에도 있고 `--max-turns`는 없다. |
| 인증 | `claude auth status`: `loggedIn: true`, `authMethod: claude.ai`(구독 로그인). 계정·토큰 정보는 기록하지 않는다. |
| 모델 | 모든 시험을 `--model haiku`로 수행(사용량 절약). 도구 강제는 모델이 아니라 CLI가 하지만, 모델 응답을 판단 근거로 쓴 항목은 한계(§5)에 적었다. |
| 호출 환경 | 기본은 `env -i HOME USER LOGNAME PATH`로 비운 환경(세션에 주입된 인증 변수 배제). 프롬프트는 짧게, 한도를 소진하는 반복 호출은 하지 않았다. |
| 대상 | 임시 폴더의 가상 저장소(파일 2개)와 별도의 "프로젝트 설정 유입" 시험용 폴더(`CLAUDE.md`·`.claude/settings.json` 훅·`.mcp.json`·`.claude/skills`). 이 저장소의 코드·실제 데이터·실제 키는 쓰지 않았다. 비밀값은 `FAKE_SECRET_FOR_TEST=not-a-real-secret`, 게이트웨이는 직접 만든 가짜 stdio MCP 서버(도구 `ping_gw`). |
| 전역 설정 | 시험용 항목을 일시 추가했다가 모두 원복(아래 "원복"). |

### (1) 종료 코드와 JSON 필드

| 상황 | 명령 요지 | 종료 코드 | 관찰 |
|---|---|---|---|
| 정상 | `-p "2+2 만 답해" --output-format json --no-session-persistence` | 0 | `is_error:false`, `subtype:"success"`, `terminal_reason:"completed"`, `stop_reason:"end_turn"` |
| 잘못된 옵션 값 | `--output-format bogus` | 1 | stderr에 `error: option ... argument 'bogus' is invalid. Allowed choices are text, json, stream-json.` stdout 없음 |
| 잘못된 `--json-schema` | `--json-schema '{"type":5}'` | 1 | stderr `Error: --json-schema is not a valid JSON Schema: ...` |
| 없는 `--mcp-config` 파일 | `--mcp-config /nonexistent.json --strict-mcp-config` | 1 | stderr `Error: Invalid MCP configuration: MCP config file not found` |
| 시작 못 하는 MCP 서버(없는 실행 파일) | `--mcp-config`에 존재하지 않는 `command` | **0** | 실행은 성공하고 서버만 목록에서 빠짐. **게이트웨이 연결 실패가 종료 코드로 드러나지 않는다 → 어댑터가 init 이벤트의 `mcp_servers`를 확인해야 함** |
| 시간 제한 | `timeout 5 claude -p "(긴 출력)"` | 124(`timeout`의 코드) | stdout 비어 있음. 결과 없음 |
| SIGTERM 직접 전송 | 4초 후 `kill -TERM` | 143 | 결과 없음(공식 문서 `headless`의 "Stop a run with SIGTERM"과 일치) |
| 예산 상한 | `--max-budget-usd 0.001` | 1 | `subtype:"error_max_budget_usd"`, `terminal_reason:"budget_exhausted"`, `is_error:true`. 구독에서도 동작(정가 환산 추정치 기준). 초안 문서의 "구독에서는 의미 없다"와 달리 *상한으로는 쓸 수 있다*. 쓸지는 설계 판단 |
| 로그인 없음 | 인증 없는 환경에서 `-p` | 1 | §(6) |

`--output-format json` 결과 객체의 필드: `type`, `subtype`, `is_error`, `result`, `structured_output`(`--json-schema` 시), `terminal_reason`, `stop_reason`, `api_error_status`, `num_turns`, `total_cost_usd`, `usage`, `modelUsage`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `permission_denials`, `session_id`, `uuid`, `subagent_stats`, `fast_mode_state` 등. **오류여도 `subtype`은 `"success"`일 수 있으므로(인증 실패 포함) `is_error`와 `terminal_reason`을 봐야 한다.**

### (2) 스트림 형식과 비용

- `--output-format stream-json --verbose` 이벤트: `system/init`(모델·도구·`mcp_servers`·`skills`·`slash_commands`·`permissionMode`·`apiKeySource`), `rate_limit_event`, `system/thinking_tokens`, `assistant`, `user`(도구 결과), `result`. 재시도 시 `system/api_retry`(`error`·`error_status`).
- 최종 `result` 메시지: `total_cost_usd`(예: 0.011~0.021), `usage`(`input_tokens`·`output_tokens`·`cache_creation_input_tokens`·`cache_read_input_tokens`), `modelUsage.<모델>.costUSD`·`costBasis:"list"`, `num_turns`. 구독 로그인에서도 값이 채워지며 **정가 환산 추정치**다(공식 문서 `headless`: "client-side estimates ... can differ from your actual bill"). 실제 구독 소진량과 무관하다.
- 사용량 정보: `rate_limit_event.rate_limit_info`에 `status`(시험 중 `allowed`), `rateLimitType`(`five_hour`), `resetsAt`, `unifiedWindows.five_hour/seven_day.utilization`이 들어온다. 한도 접근을 사전에 감지하는 데 쓸 수 있다(값은 이 문서에 적지 않는다).
- 일반 대화 한 번의 컨텍스트가 약 2~3만 토큰(전역 설정·MCP 포함)이었고, 격리 호출 모양에서는 줄어든다(캐시 생성 약 7천 토큰).
- `-p`가 stdin을 3초 기다리며 경고를 stderr에 낸다(`< /dev/null` 필요). 어댑터는 stdin을 명시적으로 닫을 것.

### (3) 도구 강제 (작업 디렉터리 밖 읽기·쓰기·셸·웹)

모두 `--model haiku`, 모델에게 해당 도구로 시도하게 하고 `permission_denials`와 부수 효과(파일 생성 여부)를 확인했다.

| 조합 | 밖 읽기 | 심볼릭 링크 밖 읽기 | 쓰기 | 셸 | 웹 |
|---|---|---|---|---|---|
| `--restricted --safe-mode --tools Read` + `dontAsk` + `--permission-prompts none` | 거부(`permission_denials: Read`) | — | 도구 없음 | 도구 없음 | 도구 없음 |
| `--restricted` + `--tools Read,Write,Bash,WebFetch` + `dontAsk` + `prompts none` | 거부 | 거부 | 거부, 파일 없음 | 거부(`Bash`), 파일 없음 | 거부 |
| (`--restricted` 없이) 동일 | 거부 | 거부 | 거부 | 거부 | 거부 |
| `--tools`만 (권한 옵션 없음) | 거부 | 거부 | 거부 | **읽기 전용 명령(`whoami`)은 실행됨**, 리다이렉션 쓰기는 거부 | 거부 |
| `--restricted`만 / `--safe-mode`만 (+tools) | 거부 | 거부 | 거부 | 거부(읽기 전용 명령 실행 여부는 시험 안 함) | 거부 |
| 호출 모양(`--tools Read,Grep,Glob`)에서 Grep 밖 경로·`/etc/hosts`·`~/.claude/settings.json` | Grep·Read 모두 `permission_denials`에 기록 | — | — | — | — |

해석:
- `-p`는 권한 모드를 정하지 않으면 승인할 사람이 없어 거부하는 쪽으로 동작하므로(공식 문서 `headless`), 위 거부의 상당 부분은 `--restricted`가 아니라 `-p`의 기본 동작이다. 이 시험으로는 `--restricted`의 독자적 효과를 분리하지 못했다(`--restricted` 없이도 거부됨. 도움말은 파일 도구를 작업 디렉터리로 제한한다고 적는다). 방어를 한 겹으로 두지 않도록 `--restricted`와 `dontAsk`·`--permission-prompts none`을 함께 쓰고, `Bash`·`WebFetch`는 `--tools`에서 빼는 것이 가장 확실한 차단이다.
- **내장 Bash가 열려 있으면 읽기 전용 명령은 허가 없이 실행된다**(`whoami`). "Bash 기본 거부"는 `--tools`에 넣지 않는 것으로 달성하라.
- **거부돼도 종료 코드 0, `is_error:false`**다. 어댑터는 `permission_denials`를 검사해 `needs_review`/실패로 올려야 한다.
- 턴 한도: `--max-turns`는 없다(2.1.263). 대체 수단은 시간 제한(`timeout`/SIGTERM)과 `stream-json`의 `assistant` 이벤트 계수. `--max-budget-usd`는 추정치 기준 상한으로 동작함을 확인했다.
- 못 한 것: `Glob "../outside/*.txt"`는 거부 기록 없이 실패(결과 없음)로 응답했으며 내용 유출은 없었다. 쓰기 가능한 작업 디렉터리 안에서의 `Write` 허용(`acceptEdits`)은 시험하지 않았다(이 스파이크는 읽기 전용 작업 기준).

### (5) 유입 차단

사용자 전역에 시험용 항목을 두고(시험 후 제거) `system/init`의 `skills`·`mcp_servers`·`tools`와 행동 시험으로 확인했다. 전역 MCP는 기존에 있던 `~/.claude.json`의 서버(이름 `nas-filesystem` 등)와 claude.ai 커넥터를 그대로 사용했다(추가하지 않음). CLAUDE.md는 "특정 단어를 보면 특정 답을 하라"는 한 줄을 전역 `~/.claude/CLAUDE.md`와 시험 프로젝트의 `CLAUDE.md`에 두고, 도구 없이(`--tools ""`) 컨텍스트에 있는 문장을 인용하게 해서 확인했다(도구가 있으면 모델이 `CLAUDE.md` 파일을 직접 읽어 결과를 오염시킨다).

| 호출 | 전역 CLAUDE.md | 프로젝트 CLAUDE.md | 전역 스킬 | 전역 MCP·커넥터 | 프로젝트 훅·`.mcp.json`·스킬 |
|---|---|---|---|---|---|
| 옵션 없음 | **보임** | **보임** | **보임** | **보임** (전역 서버 + claude.ai 커넥터) | **실행/연결/보임** (훅이 실행됨) |
| `--strict-mcp-config`만 | — | — | 보임 | 차단 | — |
| `--disable-slash-commands`만 | — | — | 차단 | 보임 | — |
| `--setting-sources ""`만 | 차단 | 차단 | 차단(init `skills`에서 사라짐) | 전역 서버 차단, claude.ai 커넥터는 남음 | — |
| `--restricted`만 | 차단 | 차단 | 차단 | 차단 | 훅 미실행, `.mcp.json`·프로젝트 스킬 미적용 |
| `--safe-mode`만 | 차단 | 차단 | 차단 | 차단 (**`--mcp-config`로 준 서버도 차단**) | 훅 미실행 |
| **정정된 호출 모양** (`--restricted --setting-sources "" --disable-slash-commands --strict-mcp-config --mcp-config gw`) | 차단 | 차단 | 차단 | **게이트웨이만 연결** | 훅 미실행, 프로젝트 스킬·MCP 없음 |

따라서 어떤 옵션을 더하면 사라지나: 전역 CLAUDE.md·스킬·MCP는 `--restricted` 하나로도 사라지고, 게이트웨이 MCP만 남기려면 `--restricted`(또는 `--setting-sources ""`) + `--strict-mcp-config --mcp-config`이다. `--safe-mode`는 게이트웨이까지 끄므로 이 용도에 쓸 수 없다. 작업 디렉터리의 `CLAUDE.md`는 컨텍스트에는 들어가지 않지만 그 파일 자체는 읽기 도구로 읽을 수 있다(일반 파일이므로 당연함).

### (4) 비밀값

| 시험 | 결과 |
|---|---|
| 부모에 `FAKE_SECRET_FOR_TEST` 설정, `claude`를 그대로 실행, `--tools Bash --allowedTools Bash` | 에이전트가 `printenv`로 **값을 읽음**(새어 나감) |
| `env -i HOME USER LOGNAME PATH FAKE_SECRET_FOR_TEST=...`로 비밀값을 명시적으로 넘김 | 읽음 (당연) |
| 부모에 비밀값이 있지만 `env -i`(비밀값 미포함)로 실행 | `EMPTY` — 읽지 못함 |
| 호출 모양(Bash 없음)에서 부모 환경에 비밀값 두고 "환경 변수를 알아내라" | 도구가 없어 불가, `permission_denials` 없음 |

결론: 데몬이 `env -i`로 환경을 구성하고 내장 Bash를 열지 않으면 비밀값이 에이전트에 닿지 않는다. 비밀값은 계속 게이트웨이(MCP 서버)의 실행기가 안에서 주입한다. 이 macOS에서는 `env -i`에 `USER`(및 `LOGNAME`)를 넘겨야 구독 로그인을 읽는다.

### (6) 오류 구분

| 상황 | 종료 코드 | `is_error` / `terminal_reason` / `api_error_status` | `result` 문구 |
|---|---|---|---|
| 로그인 정보 없음(빈 `HOME`) | 1 | true / `api_error` / `null` | `Not logged in · Please run /login` |
| 무효한 OAuth 토큰(가짜 값) | 1 | true / `api_error` / `401` | `Failed to authenticate. API Error: 401 OAuth access token is invalid.` (`system/api_retry`에 `authentication_failed`, 401이 먼저 나옴) |
| 무효한 API 키(가짜 값) | 1 | true / `api_error` / `401` | `Invalid API key · Fix external API key` |
| 예산 초과 | 1 | true / `budget_exhausted` | `subtype:"error_max_budget_usd"`, `result: null` |
| 잘못된 옵션·없는 MCP 파일 | 1 | JSON 없음, stderr에 오류 | — |

- 로그아웃 시험(`claude auth logout`)은 하지 않았다. 이 PC의 로그인을 지우지 않기 위해 빈 `HOME`과 가짜 토큰으로 대체했다(문서 지시에 따른 대안).
- 종료 코드는 모두 1이라 구분력이 없다. **JSON의 `result` 문구와 `api_error_status`, `terminal_reason`으로 분류**해야 한다. `subtype`은 오류에도 `"success"`인 경우가 있다.
- **한도 도달은 관찰하지 못했다(미수행, 소진 금지 규칙).** 공식 문서 `https://code.claude.com/docs/en/errors`의 "Usage limits" 절은 메시지를 `You've hit your session limit` / `You've hit your weekly limit` / `You've hit your Opus limit` / `You've hit your Sonnet limit`, 서버 쪽 제한은 `Server is temporarily limiting requests`·`Request rejected (429)`로 적는다. 이 메시지가 headless JSON에서 어떤 `terminal_reason`·`api_error_status`로 나오는지는 확인하지 못했다. 사전 감지용으로는 `rate_limit_event`의 `status`·`utilization`을 쓸 수 있을 것으로 보이나 `rejected` 상태 값은 관찰하지 못했다. 어댑터는 (a) `rate_limit_event.status`가 `allowed`가 아닐 때, (b) `result` 문구가 위 메시지와 일치할 때 `needs_review`로 보내되, 실제 한도 도달 한 건을 관찰한 뒤 문구를 확정할 것.

### 약관 (Anthropic 공식 문서, 2026-10-26 조회)

판단하지 못한 항목은 "확인 못 함"으로 적는다. 아래는 문구 그대로의 요약이며 허용 여부의 결론이 아니다.

| 출처 | 내용 |
|---|---|
| `code.claude.com/docs/en/legal-and-compliance` › "Usage policy › Authentication and credential use" | OAuth 인증은 "Free, Pro, Max, Team, Enterprise 구독 구매자 전용이며 Claude Code 등 네이티브 앱의 *일반적인 사용*을 지원하도록" 설계되었다고 한다. 제품·서비스를 만드는 개발자는(Agent SDK 사용자 포함) **API 키 인증을 써야 한다**고 한다. 제3자가 사용자를 대신해 Free/Pro/Max 자격으로 요청을 중계하는 것, Claude.ai 자격 증명·세션 토큰을 수집·저장·중계하는 것을 허용하지 않는다고 한다. 최종 사용자가 *수정되지 않은 Claude Code 바이너리*에 자신의 구독으로 로그인하는 것은 막지 않는다고 한다. |
| 같은 문서 › "Usage policy › Acceptable use" | Pro·Max의 광고된 사용량 한도는 "Claude Code와 Agent SDK의 *평범한 개인 사용*"을 전제로 한다. |
| 같은 문서 › "License" | Free/Pro/Max는 Consumer Terms of Service, Team/Enterprise/API는 Commercial Terms of Service가 적용된다(**원문 약관 본문은 읽지 못했다**). |
| 같은 문서 › "Can customers offer Claude Code in their products?" | 바이너리를 수정하지 않고, 최종 사용자가 각자의 자격으로 인증해야 하며, 고객이 최종 사용자 몫의 Claude 사용을 대신 결제·재판매·중개하면 안 된다고 한다. |
| `code.claude.com/docs/en/authentication` › "Generate a long-lived token" | `claude setup-token`은 "CI 파이프라인, 스크립트 등 대화형 브라우저 로그인이 불가능한 환경"을 위한 1년짜리 토큰을 만들고, `CLAUDE_CODE_OAUTH_TOKEN`으로 쓴다. 구독(Pro/Max/Team/Enterprise)이 필요하다. 인증 우선순위 표에서도 5번에 "CI 파이프라인과 스크립트"용으로 적혀 있다. |
| Consumer Terms of Service (`anthropic.com/legal/consumer-terms`, 한국어판 발췌 조회) › 3절 "당사 서비스 사용" 3.7항 | 봇·스크립트 등 자동화된 비인간적 방식의 접근을 금지하되 "Anthropic API 키를 통해 접속하거나 당사가 이를 명시적으로 허용하는 경우"는 예외다. 공식 Claude Code CLI의 `-p`·`setup-token`이 이 "명시적 허용"에 들어가는지는 약관 문장만으로 판단하지 못했다. (조회 결과는 요약 발췌이며 조항 번호·원문은 사람이 한 번 대조할 것) |
| 같은 약관 › 2절 "계정 생성 및 접속" | 계정 로그인 정보·자격 증명을 타인과 공유하거나 계정을 타인에게 넘기는 것을 금지한다. |
| `code.claude.com/docs/en/headless` | `claude -p`는 Agent SDK를 CLI로 쓰는 방식이며, `--bare`는 구독 로그인(OAuth·키체인)을 읽지 않고 API 키를 쓴다. 스크립트·SDK 호출에는 `--bare`를 권장하며 향후 `-p`의 기본이 될 수 있다고 한다(**이 변경이 오면 구독 인증으로 격리하는 호출 모양에 영향이 있을 수 있다**). |

**확인 못 함:**
1. "구독 로그인된 PC에서 *조직 내부 시스템(데몬)이* `claude -p`를 자동 반복 실행하는 것"이 "일반적인 개인 사용"의 범위인지. 위 문서에는 이 경우를 명시한 문장이 없다. Agent SDK(= `claude -p`)에는 API 키를 쓰라는 문구가 있어 해석이 갈린다.
2. `claude setup-token` 경로가 *데몬 전용 OS 계정*의 자동 실행이라는 이 용도에 허용되는지. 문서는 CI·스크립트용이라고만 적었고, 위 "제품·서비스 개발자는 API 키" 문구와의 관계는 확인하지 못했다.
3. Consumer Terms of Service 원문의 해당 조항(자동화·접근 방식 제한). 읽지 못했다.
4. 이 시스템이 "개발자가 제품이나 서비스를 만든다"에 해당하는지(내부 도구인지 여부).
→ 필요하면 문서가 안내하는 영업팀 문의로 확인한다. 이 문서는 허용을 추정하지 않는다.

**2차 자료로 본 시장 상황 (Anthropic 공식 발표가 아니라 보도·블로그이므로 참고용):** 구독 OAuth 토큰을 꺼내 다른 도구(OpenCode, Cline, Roo Code, OpenClaw 등)에서 쓰는 방식은 2026-01-09경 서버 쪽에서 차단되고 2026-02 문서에 명문화되었으며, 2026-04-04부터 서드파티 하네스는 구독 한도 대신 별도 과금으로 처리된다고 보도되었다. 반면 공식 `claude` 바이너리를 서브프로세스로 실행하는 래퍼·MCP 서버는 다수 존재하고, 이 방식으로 계정이 제한됐다는 보고는 이번 검색에서 찾지 못했다(없다는 것이 안전하다는 증거는 아니다). 무인 데몬의 장시간 자동 실행은 어느 자료도 해소하지 못한 회색지대다.

### 결정 (2026-10-26, 사용자)

약관의 회색지대 위험은 사용자가 **감수하고 진행**한다(소규모·1인 창업자 용도, 경고를 받으면 중단). 근거와 한계: 공식 문서에는 "Anthropic은 사전 통지 없이 제한 조치를 할 수 있다"고 적혀 있어 사전 경고를 보장하지 않는다. 위험을 키우지 않기 위해 다음 가드레일은 유지한다.

1. 앱이 토큰·로그인 정보를 저장하거나 전달하지 않는다. `setup-token`/`CLAUDE_CODE_OAUTH_TOKEN`을 앱이 발급·주입하지 않고, 사용자가 직접 `claude auth login`을 한다.
2. 사용자 본인 PC에서, 사용자 본인 구독으로만 실행한다. 한 구독을 여러 사람이 공유하지 않고, 한도를 피하려고 여러 계정을 번갈아 쓰는 설계를 하지 않는다.
3. 운영자가 호스팅하는 서버에서 구독으로 실행하지 않는다.
4. 첫 실행 때 "자동 실행은 본인 구독으로 본인 PC에서 이뤄지며 약관 준수는 본인 책임"이라는 고지에 동의를 받는다(이 레포는 Anthropic과의 약관 문제에 책임지지 않는다는 문구 포함. 단 사용자가 Anthropic 약관의 당사자라는 사실은 이 고지로 바뀌지 않는다).
5. API 키 + `--bare` 어댑터를 대안 설정으로 남긴다.


### 원복한 전역 설정

시험 전 `~/.claude`의 `CLAUDE.md`·`settings.json`·`hooks`·`.claude.json`을 백업했다.

| 일시 추가한 것 | 원복 |
|---|---|
| `~/.claude/skills/q4-test-skill/SKILL.md` (시험용 스킬; `~/.claude/skills`는 원래 없었음) | 디렉터리 삭제. `~/.claude/skills` 부재 확인 |
| `~/.claude/CLAUDE.md` 끝에 `Q4_SPIKE_TEMP` 블록 | 백업에서 복원, SHA-1 일치 확인, 잔여 마커 0 |
| 전역 MCP | 추가하지 않음(기존 서버 사용) |

참고: `~/.claude/settings.json`은 시험 도중 외부 요인(앱·로그인)으로 바뀌었다(`defaultMode` 등). 이 스파이크가 수정한 것이 아니므로 되돌리지 않았다. `claude auth logout`은 실행하지 않았고 이 PC의 로그인 상태는 유지된다.

## 5. 한계

- 관찰한 버전은 2.1.263 하나다(초안은 2.1.310을 봄). CLI는 빠르게 바뀌므로 어댑터는 시작 시 버전을 기록하고, 계약 시험으로 옵션 동작(§4.1의 (3)·(5): 밖 읽기 거부, 훅 미실행, 게이트웨이 MCP 연결, 전역 항목 미노출)을 회귀 확인해야 한다. 특히 `--bare`가 `-p`의 기본이 되면 호출 모양을 다시 확인해야 한다.
- 모든 모델 시험을 `haiku`로 했다. 도구 허용·거부와 init 목록은 CLI의 동작이라 모델과 무관하지만, "모델이 이 문장을 인용하는가" 같은 행동 확인은 모델에 따라 달라질 수 있다.
- 개발 PC(개인 로그인 계정)에서 수행했다. 사무실 PC의 데몬 전용 OS 계정, 호스트 OS 격리(계정·디렉터리 권한), 동시 실행, 쓰기 작업(`acceptEdits`)은 시험하지 않았다.
- 게이트웨이는 직접 만든 가짜 stdio MCP 서버로 시험했다. 실제 게이트웨이의 연결 시간·`--allowedTools` 와일드카드·MCP 서버가 자식 프로세스로 물려받는 환경은 확인하지 않았다.
- 부모 디렉터리에 `CLAUDE.md`가 있는 경우의 상위 탐색은 별도로 시험하지 않았다(`--restricted`/`--setting-sources ""`가 전역·작업 디렉터리의 CLAUDE.md를 막는 것은 확인). 작업 디렉터리는 상위에 `CLAUDE.md`가 없는 위치에 둘 것.
- 사용량 한도 도달은 관찰하지 못했고(소진 금지), 약관의 허용 범위는 확인하지 못했다(§4.1 약관).
