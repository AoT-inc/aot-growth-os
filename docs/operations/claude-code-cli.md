# claude-code-cli 어댑터 운영

구독으로 로그인된 사용자 PC의 공식 `claude` CLI를 `claude -p`로 실행해 업무를 맡기는 어댑터다. 결정과 근거는 [ADR-0005 Amendment 2026-10-25·26](../adr/0005-agent-adapter-boundary.md), 실측은 [스파이크 Q4](../spikes/q4-claude-code-cli.md), 구현은 `packages/agent-runtime/src/claude-code/`다. 이 문서는 운영자가 알아야 할 설정·오류·재시험 절차를 모은다.

## 1. 가드레일 (설계 제약, 풀지 않는다)

| # | 가드레일 | 코드에서 |
|---|---|---|
| 1 | 토큰·로그인 정보 비접촉 | CLI 자식의 환경은 `HOME USER LOGNAME PATH` 네 개뿐이다(`buildClaudeEnv`). `setup-token`·`CLAUDE_CODE_OAUTH_TOKEN`·API 키를 만들거나 넘기는 경로가 없다. 로그인은 사용자가 직접 `claude auth login` 으로 한다 |
| 2 | 본인 PC·본인 구독·계정 공유/교대 금지 | 어댑터는 계정을 고르지 않는다(데몬 OS 계정의 로그인 하나). 동시 실행은 `maxConcurrent`(기본 1)로 제한한다 |
| 3 | 호스팅 금지 | 코드로 강제할 수 없다. **운영자가 호스팅하는 서버에서 구독으로 실행하지 않는다** |
| 4 | 첫 실행 고지 동의 | `consent` 가 없으면 CLI를 띄우지 않고 `consent_required` 로 끝낸다(→ 업무 `needs_review`). 동의는 승인 CLI `consent`로 받는다([§1.1](#11-고지-동의-받기)) |
| 5 | API 키 + `--bare` 대안 어댑터 | 이 어댑터는 `--bare` 를 쓰지 않는다. 대안 어댑터는 별도 후속 작업이다(아직 없음) |

### 1.1 고지 동의 받기

동의는 데몬 설정 파일이 아니라 **승인 CLI**로 받아 DB(`event`, source=`consent`)에 남긴다. 설정 파일에 동의를 적으면 읽지 않은 채 복사될 수 있어서다. 어댑터는 run을 시작할 때마다 이 기록을 읽으므로 동의·철회가 데몬 재시작 없이 다음 run부터 적용된다.

```bash
node apps/daemon/src/approve.ts --actor <사람 actor> consent show                       # 고지 문구와 판, 현재 동의 상태
node apps/daemon/src/approve.ts --actor <사람 actor> consent accept --version <판>      # show 가 보여 준 판을 직접 적는다
node apps/daemon/src/approve.ts --actor <사람 actor> consent revoke                      # 철회: 이후 run 은 consent_required
```

- 사람 actor만 쓸 수 있다(에이전트는 소켓이 보이지 않고, 데몬도 `actor.kind='human'`을 확인한다). TOTP는 요구하지 않는다.
- 동의는 **현재 고지 판**에만 유효하다. 고지 문구(`packages/agent-runtime/src/claude-code/consent.ts`)를 바꾸면 `version`도 바꾸고, 이전 판의 동의는 인정되지 않아 `consent_required`가 되므로 다시 `show`로 읽고 동의한다(`show`가 `stale: true`로 알려 준다).
- 가장 나중 기록이 상태다. 같은 판에 다시 `accept`하거나 동의 없이 `revoke`하면 아무것도 쓰지 않는다(`applied: false`).

## 2. 설정 (`claude_code_cli`)

데몬은 `daemon.config.json`의 `claude_code_cli`가 있을 때만 어댑터를 연결한다(예시: `config/daemon.config.example.json`). `container_agent`가 없으면 모든 업무가 이 어댑터로 가고, 있으면 `roles`(필수)에 적은 역할의 업무만 이 어댑터로, 나머지는 컨테이너 어댑터로 간다. 로그인·토큰·동의는 설정에 없다.

| 키 | 어댑터 옵션 |
|---|---|
| `claude_path`, `run_root`, `env` | `claudePath`, `runRoot`, `env` |
| `roles` | (`container_agent`와 함께일 때만) 이 어댑터로 보낼 `task_spec.role` 목록 |
| `max_turns`, `max_budget_usd`, `model`, `warn_utilization`, `yield_utilization`, `max_concurrent` | `maxTurns`, `maxBudgetUsd`, `model`, `warnUtilization`, `yieldUtilization`, `maxConcurrent` |

### 2.1 어댑터 옵션 (`createClaudeCodeCliAdapter`)

| 옵션 | 뜻 |
|---|---|
| `claudePath` | `claude` 실행 파일의 **절대 경로**. PATH 탐색 없음. 못 쓰면 `cli_unavailable` |
| `runRoot` | run 별 디렉터리(`<runRoot>/<run_id>/{work/, gateway-mcp.json, tools.json, gw.sock}`)를 만드는 절대 경로. 유닉스 소켓 경로 한계 때문에 짧게(전체 100바이트 이하). 데몬 전용 OS 계정만 쓸 수 있어야 한다. run이 끝나면 지운다(`keepRunDir` 로 남길 수 있음) |
| `env` | `{home, user, path}`: 구독 로그인이 있는 홈, OS 계정 이름(macOS는 `USER` 가 없으면 키체인 로그인을 못 읽는다), 최소 PATH |
| `consent` | 가드레일 4의 동의 기록 `{notice_version, accepted_at}` 또는 `null`, 또는 run마다 부르는 함수. 데몬은 `readClaudeCodeConsent(db)`를 넘긴다 |
| `maxTurns` | 서로 다른 assistant 메시지 수 상한(기본 40). `claude` 2.1.263에 `--max-turns` 가 없어 직접 센다. 넘으면 CLI를 멈추고 `turn_limit_exceeded` |
| `maxBudgetUsd` | `--max-budget-usd`(정가 환산 추정치 기준 상한). **기본 꺼짐**(열린 결정). 켜면 초과 시 `budget_exhausted` |
| `maxConcurrent` | 동시 실행 수(기본 1) |
| `limitPatterns`, `serverLimitPatterns` | 사용량 한도 문구 목록. 기본값은 공식 문서의 문구이고 **실제 JSON에서 어떻게 나오는지는 미확인**이다 |
| `warnUtilization` | `rate_limit_event` 사용률이 이 값 이상이면 run_log에 `usage_warning`(기본 0.8) |
| `yieldUtilization` | 사람 우선 게이트. `{five_hour: 0.7, seven_day: 0.8}`처럼 창별 임계값. 직전 run이 본 사용률이 임계값 이상이고 그 창이 리셋 전이면 새 run을 **시작하지 않고** `usage_deferred`로 끝낸다(CLI를 띄우지 않아 사용량을 쓰지 않음). 구독 풀을 사용자가 직접 쓰는 에이전트와 나눠 쓰므로 사용자 몫을 남기는 장치. 기본 꺼짐, 메모리 상태라 데몬 재시작 후 첫 run이 다시 측정, 리셋 시각을 모르면 15분 뒤 낡은 값으로 취급 |
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
| `usage_deferred` | 사람 우선 게이트가 새 run을 미룸(`yieldUtilization`). 실패가 아니라 "나중에 다시"이므로 실행기의 재시도/다음 주기에 맡긴다 | 아니오 |
| `permission_denied` | 에이전트가 허용 밖 도구를 시도(`permission_denials`). 결과를 믿지 않는다 | 아니오 |
| `isolation_violation` | init에 기대 밖 도구(Bash 등)·MCP 서버·스킬이 보임. CLI를 바로 멈춘다 | 아니오 |
| `gateway_unavailable` | 게이트웨이 MCP가 연결되지 않음(종료 코드 0이라 init에서만 드러난다) | 아니오 |
| `turn_limit_exceeded`, `budget_exhausted`, `output_limit` | 어댑터가 정한 상한 | 아니오 |
| `no_structured_output`, `invalid_structured_output`, `incomplete`, `cli_failed`, `agent_error` | 결과 형식·그 밖의 오류 | 아니오 |
| `start_rejected`, `start_failed` | 시작 전 거부(run_id·도구 이름·비밀로 보이는 입력·긴 프롬프트) 또는 준비 실패 | 아니오 |

**검토 대상 코드는 업무 상태 `needs_review`로 간다.** 데몬 실행기가 이 5개 코드를 `RunKilledError('review_required')`로 올리면 워커가 run을 `killed`로 닫고 업무를 `running → needs_review`로 옮긴다(시도를 소모하지 않는다 — 재시도해도 같은 조건이다). 사람이 로그인·한도·동의를 푼 뒤 업무를 다시 큐에 넣는다. 한도 리셋 후 자동 재큐는 없다(한도 문구 확정 후 후속). 그 밖의 코드는 이전처럼 `failed`(재시도 대상)로 흐른다. 시험: `test/integration/daemon-review-codes.test.ts`.

## 4. 사용자 PC 재시험·관찰 절차 (CC5와 CC3 확정 항목)

클라우드 세션에는 구독 로그인이 없어 실제 `claude` 로 확인하지 못한 항목이다. 사용자 PC(본인 구독)에서 한다. 토큰·키는 어디에도 적지 않는다.

1. **격리 회귀 시험(CC4 B층).** `AOT_CLAUDE_BIN=<claude 절대 경로> node --test test/integration/claude-code-isolation.test.ts`. 작은 프롬프트로 구독 사용량을 조금 쓴다. 통과 기준: `submitted`, init 요약에 Bash·Write·WebFetch 없음, `skills=0`.
2. **데몬 전용 OS 계정에서 재시험.** 개발 PC의 개인 계정이 아니라 데몬이 쓸 계정으로 `claude auth login` 후 1번을 다시 한다. 확인할 것: `HOME`·`USER`·`LOGNAME`·`PATH` 만 넘겨도 로그인이 읽히는가(macOS 키체인), `runRoot` 권한(0700), 동시 실행 수 제한.
3. **한도 도달 문구 확정.** 사용량 한도에 실제로 닿은 한 건을 `keepRunDir`·run_log로 관찰한다(일부러 소진하지 않는다). 기록할 것: `result` 문구, `terminal_reason`, `api_error_status`, 직전 `rate_limit_event` 의 `status`·`utilization` 척도(0~1인지 0~100인지). 그 값으로 `test/support/claude-stream.ts` 의 UNVERIFIED 고정 JSON과 `DEFAULT_LIMIT_PATTERNS` 를 확정한다.
   **관찰 기록 (2026-10-26, 개발 PC, `claude` 2.1.263, `haiku`, 한도 도달 아님).** 격리 회귀 B층 통과(A층 5건 + B층 1건, 약 4초에 `submitted`, init 격리 검사 통과). 정상 실행 중 `rate_limit_event`: `status=allowed`, `rateLimitType=five_hour`, `unifiedWindows` 에 `five_hour`·`seven_day` 가 각각 `utilization`·`resetsAt`(에포크 초)을 가짐(사람 우선 게이트의 창별 리셋 시각 근거). 사용률은 5시간 창 0.22, 주간 0.03 — 0.22 가 22% 인지 0.22% 인지 한 값으로는 구분되지 않아 **척도(0~1 / 0~100)는 미확정**이다(어댑터는 1을 넘으면 퍼센트로 본다; 사용률이 높을 때 한 번 더 관찰). `overageStatus=rejected`, `overageDisabledReason=org_level_disabled`, `isUsingOverage=false` — 이 계정은 추가 사용량이 꺼져 있어 한도에 닿으면 이어 쓰기가 아니라 멈출 수 있다. 데몬 전용 OS 계정 재시험과 한도 도달 문구는 아직이다.
4. **버전 변경 시.** `claude` 를 올리면 1번을 다시 한다. 특히 `--bare` 가 `-p` 의 기본이 되면 호출 모양이 구독 로그인을 못 읽을 수 있다([스파이크 §5](../spikes/q4-claude-code-cli.md)). 어댑터는 run마다 `claude --version` 을 run_log에 남긴다.
5. **본인 기록.** 약관 준수는 사용자 책임이다(가드레일 4). 제한 통보를 받으면 구독 방식을 중단하고 API 키 + `--bare` 로 전환한다([ADR-0005](../adr/0005-agent-adapter-boundary.md)).

## 5. 열린 결정

| 항목 | 현재 |
|---|---|
| 검토 대상 코드 → `needs_review` | **연결됨(2026-10-26).** 실행기(`apps/daemon/src/agent-executor.ts`)가 5개 코드를 `RunKilledError('review_required')`로 올려 `running → needs_review`(시도 소모 없음). 남은 후속: 한도 리셋 후 자동 재큐(문구 확정 뒤), `usage_deferred`는 아직 `failed`(재시도)로 흘러 시도를 소모한다 |
| 비용 기록 | 어댑터는 `cost.tokens` 만 낸다(입력+출력+캐시 토큰 합). 정가 환산 추정치(`total_cost_usd`)는 구독 소진량이 아니라 run_log에만 둔다 — `usd` 로 내면 업무 USD 예산 초과로 kill될 수 있고 `cost_entry` 스키마에 `subscription_estimate` 단위가 없다. 별도 단위·열이 필요한지 사용자 결정(스키마 변경) |
| `--max-budget-usd`, 턴 한도 | 턴 한도는 `assistant` 메시지 계수(기본 40), `--max-budget-usd` 는 기본 꺼짐. 시범 운영의 `total_cost_usd`·`utilization` 측정 후 정한다 |
| 요금제 | Pro → Max 5x → API 전환 기준은 시범 운영 측정 후 |
| 고지 동의를 받는 곳 | **결정됨(2026-10-26).** 승인 CLI `consent show\|accept\|revoke` + DB 기록, 데몬 설정 `claude_code_cli`로 어댑터 연결([§1.1](#11-고지-동의-받기)). 동의 이력을 보는 화면은 없다(승인 CLI `consent show`가 현재 상태만 보여 준다) |
| MCP 브리지 실행 | CLI가 `node packages/agent-runtime/src/claude-code/gateway-mcp-bridge.ts` 를 자식으로 띄운다(Node 24가 `.ts` 를 직접 실행). 데몬을 빌드해 배포하면 `bridgePath` 로 바꿔야 한다 |
