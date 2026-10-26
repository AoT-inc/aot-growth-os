# claude-code-cli 어댑터 운영

구독으로 로그인된 사용자 PC의 공식 `claude` CLI를 `claude -p`로 실행해 업무를 맡기는 어댑터다. 결정과 근거는 [ADR-0005 Amendment 2026-10-25·26](../adr/0005-agent-adapter-boundary.md), 실측은 [스파이크 Q4](../spikes/q4-claude-code-cli.md), 구현은 `packages/agent-runtime/src/claude-code/`다. 이 문서는 운영자가 알아야 할 설정·오류·재시험 절차를 모은다.

## 1. 가드레일 (설계 제약, 풀지 않는다)

| # | 가드레일 | 코드에서 |
|---|---|---|
| 1 | 토큰·로그인 정보 비접촉 | CLI 자식의 환경은 `HOME USER LOGNAME PATH` 네 개뿐이다(`buildClaudeEnv`). `setup-token`·`CLAUDE_CODE_OAUTH_TOKEN`·API 키를 만들거나 넘기는 경로가 없다. 로그인은 사용자가 직접 `claude auth login` 으로 한다 |
| 2 | 본인 PC·본인 구독·계정 공유/교대 금지 | 어댑터는 계정을 고르지 않는다(데몬 OS 계정의 로그인 하나). 동시 실행은 `maxConcurrent`(기본 1)로 제한한다 |
| 3 | 호스팅 금지 | 코드로 강제할 수 없다. **운영자가 호스팅하는 서버에서 구독으로 실행하지 않는다** |
| 4 | 첫 실행 고지 동의 | `consent` 옵션이 없으면 CLI를 띄우지 않고 `consent_required` 로 끝낸다. 동의를 받는 화면은 아직 없다([열린 결정](#5-열린-결정)) |
| 5 | API 키 + `--bare` 대안 어댑터 | 이 어댑터는 `--bare` 를 쓰지 않는다. 대안 어댑터는 별도 후속 작업이다(아직 없음) |

## 2. 설정 (`createClaudeCodeCliAdapter`)

| 옵션 | 뜻 |
|---|---|
| `claudePath` | `claude` 실행 파일의 **절대 경로**. PATH 탐색 없음. 못 쓰면 `cli_unavailable` |
| `runRoot` | run 별 디렉터리(`<runRoot>/<run_id>/{work/, gateway-mcp.json, tools.json, gw.sock}`)를 만드는 절대 경로. 유닉스 소켓 경로 한계 때문에 짧게(전체 100바이트 이하). 데몬 전용 OS 계정만 쓸 수 있어야 한다. run이 끝나면 지운다(`keepRunDir` 로 남길 수 있음) |
| `env` | `{home, user, path}`: 구독 로그인이 있는 홈, OS 계정 이름(macOS는 `USER` 가 없으면 키체인 로그인을 못 읽는다), 최소 PATH |
| `consent` | 가드레일 4의 동의 기록 `{notice_version, accepted_at}` 또는 `null` |
| `maxTurns` | 서로 다른 assistant 메시지 수 상한(기본 40). `claude` 2.1.263에 `--max-turns` 가 없어 직접 센다. 넘으면 CLI를 멈추고 `turn_limit_exceeded` |
| `maxBudgetUsd` | `--max-budget-usd`(정가 환산 추정치 기준 상한). **기본 꺼짐**(열린 결정). 켜면 초과 시 `budget_exhausted` |
| `maxConcurrent` | 동시 실행 수(기본 1) |
| `limitPatterns`, `serverLimitPatterns` | 사용량 한도 문구 목록. 기본값은 공식 문서의 문구이고 **실제 JSON에서 어떻게 나오는지는 미확인**이다 |
| `warnUtilization` | `rate_limit_event` 사용률이 이 값 이상이면 run_log에 `usage_warning`(기본 0.8) |
| `model`, `toolDescriptions` | 모델 별칭, 게이트웨이 도구 설명 |

## 3. 오류 코드와 분류

종료 코드는 쓰지 않는다. `result` 메시지의 `is_error`·`terminal_reason`·`api_error_status`·문구·`permission_denials`와 init의 `mcp_servers`·`tools`·`skills`로 분류한다.

| 코드 | 의미 | 검토 대상(`CLAUDE_CODE_REVIEW_CODES`) |
|---|---|---|
| `login_required` | 로그인 없음·401·토큰 무효 | 예 |
| `usage_limit` | 구독 사용량 한도 도달(미확인 문구) | 예 |
| `server_limited` | 서버 쪽 제한·429(미확인 문구) | 예 |
| `cli_unavailable` | `claude` 를 못 찾거나 실행 못 함 | 예 |
| `consent_required` | 고지 동의 없음 | 예 |
| `permission_denied` | 에이전트가 허용 밖 도구를 시도(`permission_denials`). 결과를 믿지 않는다 | 아니오 |
| `isolation_violation` | init에 기대 밖 도구(Bash 등)·MCP 서버·스킬이 보임. CLI를 바로 멈춘다 | 아니오 |
| `gateway_unavailable` | 게이트웨이 MCP가 연결되지 않음(종료 코드 0이라 init에서만 드러난다) | 아니오 |
| `turn_limit_exceeded`, `budget_exhausted`, `output_limit` | 어댑터가 정한 상한 | 아니오 |
| `no_structured_output`, `invalid_structured_output`, `incomplete`, `cli_failed`, `agent_error` | 결과 형식·그 밖의 오류 | 아니오 |
| `start_rejected`, `start_failed` | 시작 전 거부(run_id·도구 이름·비밀로 보이는 입력·긴 프롬프트) 또는 준비 실패 | 아니오 |

**검토 대상 코드를 업무 상태 `needs_review`로 옮기는 일은 아직 연결되어 있지 않다.** 지금은 다른 어댑터 오류처럼 `failed`(재시도 대상)로 흐른다. 연결 방식은 [열린 결정](#5-열린-결정)이다.

## 4. 사용자 PC 재시험·관찰 절차 (CC5와 CC3 확정 항목)

클라우드 세션에는 구독 로그인이 없어 실제 `claude` 로 확인하지 못한 항목이다. 사용자 PC(본인 구독)에서 한다. 토큰·키는 어디에도 적지 않는다.

1. **격리 회귀 시험(CC4 B층).** `AOT_CLAUDE_BIN=<claude 절대 경로> node --test test/integration/claude-code-isolation.test.ts`. 작은 프롬프트로 구독 사용량을 조금 쓴다. 통과 기준: `submitted`, init 요약에 Bash·Write·WebFetch 없음, `skills=0`.
2. **데몬 전용 OS 계정에서 재시험.** 개발 PC의 개인 계정이 아니라 데몬이 쓸 계정으로 `claude auth login` 후 1번을 다시 한다. 확인할 것: `HOME`·`USER`·`LOGNAME`·`PATH` 만 넘겨도 로그인이 읽히는가(macOS 키체인), `runRoot` 권한(0700), 동시 실행 수 제한.
3. **한도 도달 문구 확정.** 사용량 한도에 실제로 닿은 한 건을 `keepRunDir`·run_log로 관찰한다(일부러 소진하지 않는다). 기록할 것: `result` 문구, `terminal_reason`, `api_error_status`, 직전 `rate_limit_event` 의 `status`·`utilization` 척도(0~1인지 0~100인지). 그 값으로 `test/support/claude-stream.ts` 의 UNVERIFIED 고정 JSON과 `DEFAULT_LIMIT_PATTERNS` 를 확정한다.
4. **버전 변경 시.** `claude` 를 올리면 1번을 다시 한다. 특히 `--bare` 가 `-p` 의 기본이 되면 호출 모양이 구독 로그인을 못 읽을 수 있다([스파이크 §5](../spikes/q4-claude-code-cli.md)). 어댑터는 run마다 `claude --version` 을 run_log에 남긴다.
5. **본인 기록.** 약관 준수는 사용자 책임이다(가드레일 4). 제한 통보를 받으면 구독 방식을 중단하고 API 키 + `--bare` 로 전환한다([ADR-0005](../adr/0005-agent-adapter-boundary.md)).

## 5. 열린 결정

| 항목 | 현재 |
|---|---|
| 검토 대상 코드 → `needs_review` | 어댑터는 `error.code` 로만 알린다. 실행기(`apps/daemon/src/agent-executor.ts`)는 `failed` 를 `Error` 로 던지고 워커가 재시도/실패로 닫는다. `running → needs_review` 전이는 허용표에 이미 있다(예산 초과 kill이 쓴다). 새 오류 종류와 워커 경로를 더할지 사용자 결정 |
| 비용 기록 | 어댑터는 `cost.tokens` 만 낸다(입력+출력+캐시 토큰 합). 정가 환산 추정치(`total_cost_usd`)는 구독 소진량이 아니라 run_log에만 둔다 — `usd` 로 내면 업무 USD 예산 초과로 kill될 수 있고 `cost_entry` 스키마에 `subscription_estimate` 단위가 없다. 별도 단위·열이 필요한지 사용자 결정(스키마 변경) |
| `--max-budget-usd`, 턴 한도 | 턴 한도는 `assistant` 메시지 계수(기본 40), `--max-budget-usd` 는 기본 꺼짐. 시범 운영의 `total_cost_usd`·`utilization` 측정 후 정한다 |
| 요금제 | Pro → Max 5x → API 전환 기준은 시범 운영 측정 후 |
| 고지 동의를 받는 곳 | 어댑터는 기록을 요구할 뿐이다. 앱의 어느 화면·CLI에서 받고 어디에 저장할지 미정(데몬 설정에 `consent` 를 넣는 방식이 가장 단순) |
| MCP 브리지 실행 | CLI가 `node packages/agent-runtime/src/claude-code/gateway-mcp-bridge.ts` 를 자식으로 띄운다(Node 24가 `.ts` 를 직접 실행). 데몬을 빌드해 배포하면 `bridgePath` 로 바꿔야 한다 |
