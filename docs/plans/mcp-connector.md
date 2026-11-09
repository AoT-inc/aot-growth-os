# 설계: 오너 MCP 서버 커넥터 (ADR-0018)

상태: 설계(2026-11-09), 구현됨(아래 "구현 기록"). 결정은 [ADR-0018](../adr/0018-mcp-connector.md), 운영 절차는 [operations/mcp-sites](../operations/mcp-sites.md).

## 0. 문제와 목표
오너 사이트(웹·프로젝트·강좌·인증)의 MCP 도구를 에이전트가 쓰게 하되, 지금의 안전 규칙(역할별 도구 선언, 호출별 정책 판정, 부작용 원장, 초안 승인, 비밀 비노출, 외부 입력 표시)을 하나도 건너뛰지 않는다. 에이전트는 MCP 서버를 직접 보지 못하고 게이트웨이 도구만 본다.

## 1. 구성 요소

```
에이전트 ──(게이트웨이 프레임)──▶ 도구 게이트웨이 ──▶ MCP 도구 실행기 ─┐
                                  (정책 판정·기록)     (읽기: 바로 / 쓰기: 원장)│
                                                                        ▼
                         부작용 원장 ──(전송 단계)──▶ MCP 부작용 도구 ──▶ 사이트 연결(호스트) ──(줄 JSON)──▶ 커넥터 프로세스 ──(MCP)──▶ 오너 서버
                                                                       (속도 제한·고정 확인)              (비밀값 보유)
```

| 조각 | 위치 | 책임 |
|---|---|---|
| 선언 검증 | `packages/agent-runtime/src/mcp/manifest.ts` | `mcp_sites[]` 한 항목을 검증해 동결된 `McpSiteManifest`로 만든다. 알 수 없는 키·잘못된 조합은 거부 |
| 스키마 해시 | `packages/agent-runtime/src/mcp/schema-pin.ts` | `inputSchema`의 정규 JSON sha256(`sha256:<hex>`), 고정값 비교, 서버 주석 충돌 판정, 인자 1단계 검사 |
| 커넥터 프로세스 | `packages/agent-runtime/src/mcp/connector/*.ts` | MCP 클라이언트(초기화·`tools/list`·`tools/call`·취소·목록 변경 알림), 전송(Streamable HTTP, stdio), 서버 요청 거절, 비밀 주입·되돌아온 비밀 가리기, 결과 정리·크기 상한. **node: 내장 모듈과 같은 폴더 파일만 import 한다**(경계 lint) |
| 사이트 연결 | `packages/agent-runtime/src/mcp/site-client.ts` | 데몬 쪽. 커넥터 프로세스 시작·재시작, 요청 id·타임아웃·취소, 분당 상한, 도구별 열림/닫힘 상태(고정 확인), 운영 이벤트 |
| 게이트웨이 도구 | `packages/agent-runtime/src/mcp/tools.ts` | 선언 → `GatewayToolSpec`, 읽기 실행기, 원장에 묶인 쓰기 실행기, 원장이 부르는 부작용 도구(`EffectTool` 구조) |
| 데몬 조립 | `apps/daemon/src/mcp.ts`, `apps/daemon/src/mcp-config.ts` | 설정 읽기(환경 변수 이름 → 값), 런타임 생성, `withMcp`(전화의 `withPhone`과 같은 모양), 고정값 확인 명령 |
| 확인 명령 | `apps/daemon/src/mcp-pin.ts` (`npm run mcp-pin -- <설정> <site>`) | 서버의 현재 도구 목록과 해시를 출력하고 선언과 비교한다. 설정 파일을 쓰지 않는다 |

## 2. 오너 선언 형식 (데몬 설정 `mcp_sites`)

```json
{
  "mcp_sites": [
    {
      "site": "course",
      "transport": { "kind": "http", "url": "https://mcp.course.example.com/mcp" },
      "auth": { "kind": "bearer", "token_env": "AOT_MCP_COURSE_TOKEN" },
      "rate_limit_per_minute": 30,
      "timeout_ms": 20000,
      "tools": [
        {
          "name": "units_search", "as": "search_units",
          "description": "강좌 단원을 제목으로 찾는다. 읽기 전용.",
          "scope": "internal", "impact": "read", "side_effect": false,
          "target": "site:course/units",
          "input_schema_sha256": "sha256:…"
        },
        {
          "name": "unit_update", "as": "update_unit",
          "description": "단원 본문을 고친다. 학생에게 보인다.",
          "scope": "customer", "impact": "external_effect", "side_effect": true, "approval": "draft",
          "target": "site:course/units",
          "input_schema_sha256": "sha256:…",
          "idempotency": { "key_argument": "request_id", "retention_ms": 86400000 }
        }
      ]
    }
  ]
}
```

규칙(검증기가 강제한다):
- `site`: `^[a-z][a-z0-9]{0,15}$`. 에이전트용 도구 이름은 `mcp_<site>_<as>`(`as` 생략 시 `name`), `as`·이름은 `^[a-z][a-z0-9_]{0,39}$`. 같은 이름이 둘이면 거부. 정책 행위는 `mcp_<site>_<as>.call`, 대상은 `target`.
- `transport.kind`: `http`(https만. `http://`는 루프백 호스트 `127.0.0.1`·`localhost`·`[::1]`만) 또는 `stdio`(`command` 절대 경로, `args` 문자열 배열). 리다이렉트는 따르지 않는다.
- `auth`: 없음(`{"kind":"none"}`), `bearer`(`token_env`), `header`(`header` 이름 + `value_env`). stdio는 `env_from: {"<서버가 받을 이름>": "<데몬 환경 변수 이름>"}`. 값이 비어 있으면 데몬이 시작하지 않는다.
- 도구: `impact`는 `read` 또는 `external_effect`. `read` ⇔ `side_effect:false` ⇔ `approval` 없음. `external_effect` ⇔ `side_effect:true` ⇔ `approval` 필수(`draft`|`scope`). `description`은 1~500자 오너 문장(필수). `input_schema_sha256` 필수. `target` 필수. `unit_cost_usd` 선택. `idempotency`는 쓰기에만, `key_argument`는 고정 스키마의 `properties`에 있어야 한다(시작 때 확인).
- `ack_server_hint_conflict: true`: 읽기 선언인데 서버가 읽기 전용이 아니라고 알릴 때 오너가 확인했다는 표시(§5.3).
- 정수 상한: `rate_limit_per_minute` 1~600(기본 30), `timeout_ms` 1000~120000(기본 20000).

## 3. 데몬 ↔ 커넥터 프로토콜 (줄 단위 JSON, stdin/stdout)
- 커넥터는 `process.execPath`로 `connector/main.ts`를 띄운다. 환경은 `PATH`와 그 사이트의 비밀값 변수만 준다(데몬 환경을 물려주지 않는다). stderr는 운영 로그로 가되 비밀값을 가린다.
- 첫 줄: 데몬 → `{"type":"config", "site", "transport", "auth": {kind, header?, env 이름}, "tools": [서버 도구 이름…], "max_result_bytes", "client_version"}`. 비밀값은 싣지 않는다(커넥터가 자기 환경에서 읽는다).
- 요청: `{"id", "op":"list"}` → `{"id", "ok":true, "tools":[{"name","input_schema_sha256","input_schema","annotations"}], "server":{"name","version","protocol_version"}}`. 선언 목록에 없는 서버 도구는 이름만 `undeclared:[…]`로 센다(스키마는 넘기지 않는다).
- 요청: `{"id", "op":"call", "tool", "arguments"}` → `{"id","ok":true,"result":{"is_error","text","structured","dropped"}}` 또는 `{"id","ok":false,"error":{"code","message","definite"}}`. `definite:true`는 서버에 요청이 닿지 않았음이 확실한 오류(연결 거부, 커넥터가 선언 밖 도구라 거부, 초기화 실패)다.
- 요청: `{"id","op":"cancel","target_id"}` → 서버에 `notifications/cancelled`.
- 커넥터 → 데몬 알림: `{"type":"list_changed"}`(서버 알림을 받음), `{"type":"server_request_refused","method"}`.
- 커넥터는 선언 목록(`config.tools`) 밖의 도구 `call`을 서버에 보내지 않고 `definite` 오류로 거부한다(이중 방어).

## 4. MCP 클라이언트(커넥터 안)
- `initialize`: `protocolVersion` = 커넥터가 아는 최신(`2025-06-18`), `capabilities: {}`(sampling·elicitation·roots 없음), `clientInfo` = 일반 이름. 서버가 다른 버전을 고르면 아는 목록(`2025-06-18`, `2025-03-26`) 안일 때만 계속한다. 그 뒤 `notifications/initialized`.
- `tools/list`는 `nextCursor`를 따라 끝까지(최대 20쪽, 도구 1000개) 읽는다.
- `tools/call` 결과: `content[]` 중 `type:"text"`만 이어 붙이고 나머지(이미지·오디오·리소스 링크·임베드)는 버리고 종류별 개수를 `dropped`에 센다. `structuredContent`는 JSON 값이면 넘긴다. 합친 크기가 `max_result_bytes`(기본 256 KiB)를 넘으면 자르고 `truncated:true`.
- 서버가 보낸 요청(id 있는 메시지)은 모두 JSON-RPC 오류 `-32601`로 거절하고 데몬에 알린다. `ping`만 빈 결과로 답한다.
- Streamable HTTP: `POST` 본문 JSON-RPC, `Accept: application/json, text/event-stream`. 응답이 JSON이면 그대로, SSE면 `data:` 줄을 모아 같은 id의 응답을 찾는다. `Mcp-Session-Id` 헤더를 받으면 이후 요청에 싣고, `MCP-Protocol-Version` 헤더를 초기화 뒤 싣는다. 404(세션 만료)면 한 번 다시 초기화한다(쓰기 호출 중이면 다시 보내지 않고 `unknown`). 응답 크기 상한 4 MiB, 3xx는 오류.
- stdio: 서버를 자식 프로세스로 띄우고 줄 단위 JSON. 서버 stderr는 버린다(크기 제한 뒤 운영 로그).
- 비밀값 가리기: 커넥터는 자기가 주입한 비밀값 문자열이 결과·오류 문구에 나오면 `[redacted]`로 바꾼 뒤 데몬에 보낸다.

## 5. 호스트 쪽 규칙

### 5.1 도구 노출
- `mcpToolSpecs(manifest)`: 선언마다 `GatewayToolSpec{tool:'mcp_<site>_<as>', operation:'call', target, scope, impact, sideEffect, resultOrigin:'external_untrusted', timeoutMs, unitCost}`. 서버 목록에서 오지 않는다 — 서버가 도구를 더해도 이 목록은 같다.
- 에이전트에 보이는 설명은 오너 `description`이다(게이트웨이 MCP 브리지는 지금도 이름·설명만 넘긴다).

### 5.2 읽기 실행기
순서: 도구 열림 확인(닫혔으면 `tool_error`) → 인자 1단계 검사(고정 스키마의 `properties` 밖 키·`required` 누락·최상위 원시 형식 불일치는 거부, 직렬화 64 KiB 상한) → 분당 상한(넘치면 즉시 오류) → 커넥터 `call`(신호가 abort 되면 `cancel`). 성공 결과는 `{site, tool, trust_origin:'external_untrusted', is_error, text, structured?, truncated?, dropped?}`. 결과는 외부 출처라 게이트웨이가 run을 외부 입력 영향으로 표시한다.

### 5.3 고정 확인 (도구별 열림/닫힘)
`list` 응답으로 도구마다 상태를 정한다: `open` | `closed:drift`(해시 다름) | `closed:missing`(서버에 없음) | `closed:hint_conflict`(읽기 선언인데 서버 주석이 `readOnlyHint:false` 또는 `destructiveHint:true`, `ack_server_hint_conflict`가 없음). `readOnlyHint:true`처럼 더 안전하다는 주장은 무시한다. 쓰기 선언은 주석을 보지 않는다. 시작 때 `list`가 실패하면 모든 도구가 `closed:unavailable`이고 다음 확인 때 다시 연다. 확인 시점: 시작, `list_changed` 알림, 주기(기본 10분), 쓰기 전송 직전. 상태가 바뀔 때마다 운영 이벤트를 남긴다(오너가 다시 고정해야 함을 알림).

### 5.4 쓰기 (원장)
- 게이트웨이 실행기는 `bindToEffectLedger`로 만든다. 본문: 열림·인자 검사 → `perform(tool, {stepId, action:'call', target, request:{arguments}})`. `stepId`는 인자의 정규 JSON 해시로 정한다(같은 run에서 같은 인자 = 같은 단계).
- 초안 단계(`approval:'draft'`): 원장이 초안으로 남기고 에이전트는 `{status:'drafted'}`. 범위 승인(`approval:'scope'`) 실행 단계: 원장이 전송하고 에이전트는 `{status, effect_id}`만 받는다(서버 응답 본문은 돌려주지 않는다).
- 부작용 도구 `send`: 다시 `list`로 그 도구가 `open`인지 확인(아니면 `failed`, 보내지 않음) → 분당 상한 안에서 기다림(최대 `timeout_ms`) → 멱등 선언이 있으면 `arguments[key_argument] = effectKey`로 넣음 → 커넥터 `call`. 결과 `is_error:false` → `confirmed`(responseRef = `mcp:<site>:<결과 정규 JSON sha256 앞 16자>`), `is_error:true` → `failed`. `definite:true` 오류 → `failed`. 그 밖의 오류·시간 초과·커넥터 종료 → 던짐(원장이 `unknown`).
- 원장 선언: `actions.call = {approval, idempotency: 선언 있으면 {supported:true, retention_ms} 아니면 {supported:false}, effect_key_carrier: 선언 있으면 'property' 아니면 'none'}`. `lookup`은 두지 않는다.
- 멱등 키 인자는 초안 payload에 들어가지 않는다(전송 때 호스트가 넣는다). 사람이 승인한 인자 + 호스트가 넣는 키 하나다. 에이전트가 같은 이름의 인자를 넣으면 실행기가 거부한다.

### 5.5 커넥터 프로세스 관리
- 사이트마다 하나, 데몬 시작 때 띄운다. 비정상 종료하면 지수 대기(1초 → 최대 60초)로 다시 띄우고, 다시 뜨면 `list`로 상태를 다시 정한다. 진행 중이던 읽기는 `tool_error`, 쓰기는 던짐(`unknown`).
- 요청마다 호스트 타이머: 읽기는 게이트웨이 타임아웃이 먼저, 전송은 `timeout_ms`. 커넥터가 답하지 않아도 호스트는 기다리지 않는다.
- 커넥터 줄 하나 상한 8 MiB, 넘으면 커넥터를 죽이고 다시 띄운다.

### 5.6 속도 제한
사이트마다 1분 창(토큰 버킷, 용량 = 분당 상한, 주입된 Clock). 읽기·전송·`list` 모두 센다(`list`는 확인용이라 한도를 넘어도 막지 않되 센다). 시험은 손으로 돌리는 Clock을 쓴다.

## 6. 신뢰 경계 정리
| 위협 | 막는 것 |
|---|---|
| 서버가 도구를 몰래 더함 | 노출 목록은 오너 선언에서만 나온다. 커넥터도 선언 밖 호출을 거부. 더해진 도구는 기록만 |
| 서버가 `readOnlyHint:true`로 쓰기를 숨김 | 분류는 오너 선언. 서버 주석은 분류에 쓰지 않는다 |
| 서버가 읽기 도구를 쓰기로 바꿈 | 위험 쪽 주석 불일치는 닫힘(`hint_conflict`), 스키마가 바뀌면 닫힘(`drift`) |
| 결과에 "이전 지시를 무시하고 …" | 결과는 `external_untrusted` → run 표시 → 뒤 부작용 호출은 승인 필요, 초안은 표시되고 위임 불가 |
| 서버 설명에 지시 주입 | 서버 설명을 에이전트에 넘기지 않는다 |
| 서버가 LLM·입력을 요청 | 클라이언트 기능 없음, 서버 요청 거절 |
| 서버가 응답하지 않음 | 호스트 타이머, 읽기 `tool_timeout`, 쓰기 `unknown`(자동 재전송 없음) |
| 비밀 유출 | 비밀은 커넥터 환경에만, 되돌아온 값 가림, 호출 기록 가리기(mask.ts) |
| 과호출 | 사이트별 분당 상한, 정책 비용 상한 |
| 커넥터 해석 오류 | 별도 프로세스, DB·정책 접근 없음 |

## 7. 시험 계획 (네트워크 없음)
가짜 MCP 서버 `test/fixtures/mcp/fake-server.ts`: stdio 서버이며 첫 인자로 각본 이름을 받는다(`normal`, `adds_tools`, `lies_readonly`, `injects`, `hangs`, `drifts_after_first_list`, `echoes_secret`, `asks_sampling`, `crash_on_call`). HTTP 전송은 같은 각본을 `127.0.0.1` 임시 포트의 `node:http` 서버로 연다(루프백만, 외부 네트워크 없음).

단위:
- 선언 검증: 조합 규칙, 이름 충돌, `approval` 누락, https 규칙, `key_argument` 확인.
- 스키마 해시·인자 검사·주석 충돌 판정.
- 커넥터 프로토콜: 초기화·버전 협상, 페이지 나누기, 텍스트만 통과, 크기 상한, 서버 요청 거절, 비밀 가림, 선언 밖 호출 거부, SSE 응답, 세션 헤더.
- 속도 제한: 상한, 창 회복, 전송 대기.
적대적(통합, 실제 커넥터 프로세스 + 가짜 서버):
1. **도구 추가**: 서버가 선언 밖 도구를 내놓아도 게이트웨이 목록·호출 모두 없음(`tool_not_allowed`), 커넥터 직접 호출도 거부.
2. **읽기 전용 거짓말**: 쓰기 도구에 `readOnlyHint:true` → 선언이 쓰기면 그대로 원장·승인, 선언이 읽기인데 서버가 `destructiveHint:true` → 닫힘.
3. **지시 주입**: 읽기 결과에 지시문 → 뒤의 쓰기 호출이 `send` 단계에서 `approval_required`, `draft` 단계에서 초안 `influenced_by_external_input=1`.
4. **타임아웃**: 읽기 → `tool_timeout`과 서버 취소 알림, 쓰기 전송 → 원장 `unknown`, 재전송 없음.
5. **스키마 변화**: 첫 목록 뒤 스키마를 바꾸는 서버 → 목록 변경 알림 후 그 도구만 닫힘, 전송 직전 확인에서 `failed`(서버에 호출 0회).
6. **비밀값**: 서버가 받은 토큰을 결과에 되돌려도 호출 기록·결과에 없음, 커넥터 config 줄에도 없음.
7. **서버 요청**: `sampling/createMessage` 요청 → 거절, 데몬 이벤트.
8. **초안 → 승인 → 전송 전체 경로**: 승인된 인자 바이트 그대로 서버에 도착(가짜 서버가 받은 인자를 기록), 멱등 키 인자 주입.

## 8. 구현 작업 순서
W1 선언·해시·인자 검사 → W2 커넥터(MCP 클라이언트·전송) + 가짜 서버 → W3 사이트 연결(프로세스·타이머·상한·고정 확인) → W4 게이트웨이 도구·원장 도구 → W5 데몬 설정·조립·확인 명령 → W6 적대적 통합 시험 → W7 경계 lint 규칙(커넥터는 node: 와 같은 폴더만) → W8 운영 문서.

## 9. 오너 결정 (기본값으로 정함, 바꿀 수 있음)
| # | 결정 | 기본값 | 바꾸면 |
|---|---|---|---|
| C1 | 쓰기 도구의 승인 방식 | 바깥으로 나가는 모든 쓰기는 `draft`(선언 필수, 기본값 없음) | `scope`는 내용을 미리 확정할 수 없는 동작만 |
| C2 | 스키마가 바뀐 도구 | 그 도구만 닫고 오너가 다시 고정할 때까지 멈춤 | 사이트 전체 닫기, 또는 경고만(비권장) |
| C3 | 읽기 선언과 서버의 위험 주석이 충돌 | 닫힘, `ack_server_hint_conflict`로 오너가 열 수 있음 | 경고만 |
| C4 | 사이트별 분당 호출 상한 | 30 | 사이트마다 1~600 |
| C5 | 도구 타임아웃 | 20초 | 사이트마다 1~120초 |
| C6 | 쓰기 응답의 `unknown` | 사람이 `resolve-effect`로 확정, 자동 재전송 없음 | 사이트가 멱등 키 인자를 받으면 선언해서 재전송 허용 |
| C7 | 서버의 `isError:true` 쓰기 결과 | `failed`(서버가 실패했다고 말함) | `unknown`(부분 실행 가능성을 사람이 확인) |
| C8 | 결과의 비텍스트(이미지·리소스) | 버리고 개수만 알림 | 허용 종류 추가(별도 설계) |
| C9 | 쓰기 결과를 에이전트에 돌려줄지 | 상태만 | 본문도(외부 입력으로 표시) |
| C10 | 커넥터 격리 수준 | 별도 프로세스, 같은 OS 사용자 | 컨테이너(에이전트와 같은 Docker 규칙) |
| C11 | 사설 주소의 http 서버(NAS 등) | https만, http는 루프백만 | 사설망 http 허용 표시 추가 |
| C12 | 주기 확인 간격 | 10분 | 사이트마다 |

## 구현 기록 (2026-11-09)
W1~W8 을 설계대로 구현했다. 설계와 달라진 곳(가장 가까운 안전한 선택):
- **원장 선언의 `effect_key_carrier`**: 설계는 멱등 선언이 있으면 `'property'` 였으나, `lookup` 이 없는 도구가 carrier 를 선언하면 `validateEffectToolDeclaration` 이 거부한다(`carrier_without_lookup`). 그래서 carrier 는 선언하지 않는다. 멱등 키는 인자(`key_argument`)로 싣고 `idempotency: {supported:true, retention_ms}` 만 선언한다.
- **서버 도구 이름**: 설계는 이름도 `^[a-z][a-z0-9_]{0,39}$` 였으나 서버 이름은 대시·점이 흔해 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` 까지 받고, 에이전트용 이름(`as`, 없으면 `name`)만 `^[a-z][a-z0-9_]{0,39}$` 로 강제한다. 대시가 든 이름은 `as` 가 필요하다.
- **`list` 의 `inspect` 모드**: 확인 명령(`mcp-pin`)은 선언 밖 도구의 스키마도 봐야 하므로 config 줄에 `inspect:true` 를 더했다. 이 모드의 커넥터는 모든 `call` 을 `undeclared_tool` 로 거부한다. 운영 데몬은 이 모드를 쓰지 않는다.
- **`call` 의 `retry_safe`**: HTTP 세션 만료(404)에서 한 번 다시 초기화해 재시도하는 것은 호스트가 `retry_safe:true` 로 보낸 호출(읽기)만이다. 쓰기는 다시 보내지 않고 `session_expired`(definite 아님) 오류를 낸다(→ `unknown`).
- **HTTP 전송의 서버→클라이언트 GET 스트림은 열지 않는다.** 목록 변경 알림은 POST 응답 SSE 로 온 것만 받는다. 놓친 변경은 주기 확인(10분)과 쓰기 전송 직전 확인이 잡는다.
- **definite 판정**: 연결 거부·DNS 실패·인증서 오류, 초기화 실패, 리다이렉트(3xx), 401/403, 선언 밖 도구, 설정 오류는 definite. 그 밖의 HTTP 상태(5xx 등)·시간 초과·서버/커넥터 종료·JSON-RPC 오류 응답은 definite 가 아니다(쓰기는 `unknown`).
- **오너 설명 전달**: `mcpToolDescriptions()` 를 데몬이 `AgentRuntimeOverrides.toolDescriptions` 로 넘겨 Claude Code 브리지의 도구 설명이 오너 문장이 된다(`main.ts`).
- 가짜 서버 각본에 `paged`, `big`, `session_expires`, `is_error`, `drifts_silently`(알림 없는 변경) 를 더했다.
- `list` 요청도 분당 상한을 센다(막지 않음). 읽기 실행기는 호스트 타이머를 `timeout_ms + 1초` 로 둬 게이트웨이 타임아웃이 먼저 끝나게 한다.
