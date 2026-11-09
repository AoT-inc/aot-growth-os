# 오너 사이트의 MCP 서버 붙이기 (운영 절차)

결정은 [ADR-0018](../adr/0018-mcp-connector.md), 설계는 [plans/mcp-connector](../plans/mcp-connector.md). 이 문서는 오너가 새 사이트를 붙일 때 따르는 순서다.
에이전트는 MCP 서버를 직접 보지 못한다. 데몬이 사이트마다 **커넥터 프로세스**를 띄우고, 에이전트에게는 **오너가 선언한 도구만** 게이트웨이 도구(`mcp_<site>_<이름>`)로 보인다.
서버가 알리는 도구 목록·설명·`readOnlyHint` 는 분류에 쓰이지 않는다. 읽기인지 쓰기인지, 누구에게 보이는지, 사람 승인이 필요한지는 오너가 한 도구씩 정한다.

예시는 모두 자리표시자다(`course.example.com`, `course`). 실제 주소·토큰은 저장소에 넣지 않는다.

## 1. 토큰을 환경 변수로 준비한다
- 서버가 요구하는 토큰을 데몬을 띄우는 환경의 변수 하나에 넣는다. 예: `AOT_MCP_COURSE_TOKEN`.
- 설정 파일에는 **변수 이름**만 적는다. 값은 설정·DB·로그·초안·에이전트 입력 어디에도 들어가지 않는다. 데몬은 시작할 때 값을 읽어 이 사이트의 커넥터 프로세스 환경으로만 넘긴다(그 밖의 환경은 넘기지 않는다).
- 변수가 비어 있으면 데몬이 시작하지 않는다.

## 2. `mcp_sites` 항목을 `tools: []` 로 추가한다
데몬 설정(`instance/daemon.config.json`)에 항목을 더한다. 처음에는 도구를 비워 둔다.

```json
{
  "mcp_sites": [
    {
      "site": "course",
      "transport": { "kind": "http", "url": "https://mcp.course.example.com/mcp" },
      "auth": { "kind": "bearer", "token_env": "AOT_MCP_COURSE_TOKEN" },
      "rate_limit_per_minute": 30,
      "timeout_ms": 20000,
      "tools": []
    }
  ]
}
```

- `site`: 소문자·숫자 16자 이하. 에이전트용 도구 이름은 `mcp_<site>_<as>` 가 된다.
- 전송: `http`(https 만. `http://` 는 `127.0.0.1`·`localhost`·`[::1]` 만) 또는 `stdio`(`command` 절대 경로, `args`, 서버가 받을 환경은 `env_from: {"<서버가 받을 이름>": "<데몬 환경 변수 이름>"}`). 리다이렉트는 따르지 않는다.
- 인증: `{"kind":"bearer","token_env":…}`, `{"kind":"header","header":…,"value_env":…}`, `{"kind":"none"}`. 값을 직접 적으면 거부된다.
- `rate_limit_per_minute`(1~600, 기본 30), `timeout_ms`(1000~120000, 기본 20000).

## 3. `mcp-pin` 으로 서버의 도구 목록을 읽는다
```
npm run mcp-pin -- instance/daemon.config.json course
```
도구마다 이름, 입력 스키마 해시(`sha256:…`), 서버 주석, 선언과의 일치 상태를 출력한다. **설정 파일을 쓰지 않고**, 서버 설명은 보여 주지 않는다.
이 단계에서 서버 도구는 모두 `undeclared` 로 나온다(아직 선언이 없다).

## 4. 도구를 하나씩 읽고 분류한다
도구마다 서버 쪽 코드·문서를 직접 읽고 아래를 정한다. 서버가 `readOnlyHint:true` 라고 해도 믿지 않는다.

| 항목 | 정하는 것 |
|---|---|
| `name` / `as` | 서버 도구 이름 / 에이전트가 부를 이름(`^[a-z][a-z0-9_]{0,39}$`). 서버 이름에 대시·점이 있으면 `as` 가 필요하다 |
| `description` | **오너가 쓰는** 1~500자 문장. 에이전트에게 보이는 유일한 설명이다. 부작용과 누구에게 보이는지를 적는다 |
| `impact` / `side_effect` | `read` + `false`, 또는 `external_effect` + `true`. 서버 상태를 바꾸면 모두 쓰기다 |
| `scope` | `internal`(내부만) · `customer`(학생·고객에게 보임) · `public`(공개) |
| `target` | 정책이 보는 대상. 예: `site:course/units` |
| `approval` | 쓰기에서 **필수**. 바깥으로 나가는 모든 쓰기(게시, 학생·고객에게 가는 글, 인증서 발급)는 `draft`: 에이전트가 정확한 인자를 초안으로 남기고 사람이 그 초안을 승인한 뒤 호스트가 그 바이트 그대로 보낸다. `scope` 는 내용을 미리 확정할 수 없는 동작에만 쓴다 |
| `idempotency` | 서버가 중복 요청 방지용 인자를 받는 쓰기에만: `{"key_argument":"request_id","retention_ms":86400000}`. 이 인자는 스키마에 있어야 하며 전송 때 호스트가 채운다(에이전트가 넣으면 거부). 없으면 응답을 잃은 쓰기는 자동 재전송되지 않는다 |
| `unit_cost_usd` | 선택. 호출당 비용 |
| `ack_server_hint_conflict` | 읽기 선언에만. 6절 참고 |

## 5. 해시를 붙여 넣는다
3절의 `input_schema_sha256` 값을 해당 도구 선언에 그대로 붙인다.

```json
"tools": [
  {
    "name": "units_search", "as": "search_units",
    "description": "강좌 단원을 제목으로 찾는다. 읽기 전용.",
    "scope": "internal", "impact": "read", "side_effect": false,
    "target": "site:course/units",
    "input_schema_sha256": "sha256:<mcp-pin 이 출력한 값>"
  },
  {
    "name": "unit_update", "as": "update_unit",
    "description": "단원 본문을 고친다. 학생에게 보인다.",
    "scope": "customer", "impact": "external_effect", "side_effect": true, "approval": "draft",
    "target": "site:course/units",
    "input_schema_sha256": "sha256:<mcp-pin 이 출력한 값>",
    "idempotency": { "key_argument": "request_id", "retention_ms": 86400000 }
  }
]
```
다시 `mcp-pin` 을 돌려 모든 선언 도구가 `open` 인지 확인한다. 의도하지 않은 `undeclared` 는 그대로 둔다(에이전트에게도 커넥터에게도 보이지 않는다).

## 6. 역할·명세와 정책에 연결한다
선언만으로는 에이전트가 쓰지 못한다. 기존 규칙이 그대로 적용된다.
- 업무 명세·역할의 `allowed_tools` 에 도구를 넣는다: `{"tool":"mcp_course_search_units","operations":["call"],"scope":"internal","impact":"read","target":"site:course/units"}`. operation 은 항상 `call` 이다.
- 정책 문서에 행위 `mcp_<site>_<as>.call` 과 대상 `target` 규칙을 둔다(쓰기는 `require_approval` 이 기본이다). 정책 변경은 평소의 승인 절차를 따른다.
- 설정을 저장하고 데몬을 재시작한다. 시작 로그에 도구별 상태(`open`)가 나온다.

## 7. 상태가 바뀌면
도구마다 **시작할 때, 서버의 목록 변경 알림을 받을 때, 10분마다, 쓰기 전송 직전마다** 다시 확인한다. 상태가 바뀌면 운영 로그에 `mcp <site>: {"type":"tool_state",…}` 가 남는다.

| 상태 | 뜻 | 할 일 |
|---|---|---|
| `open` | 선언과 서버가 맞다 | 없음 |
| `closed:drift` | 서버의 입력 스키마가 고정값과 다르다 | 서버 변경을 읽고 괜찮으면 `mcp-pin` 으로 새 해시를 확인해 선언을 고치고 재시작. 자동 승인은 없다. 읽기 호출은 `tool_error`, 쓰기 전송은 서버에 보내기 전에 `failed` |
| `closed:missing` | 선언한 도구가 서버에 없다 | 서버 쪽 사정 확인. 도구 이름이 바뀌었으면 선언을 고친다 |
| `closed:hint_conflict` | 읽기로 선언했는데 서버가 읽기 전용이 아니라고(`readOnlyHint:false`) 또는 파괴적이라고(`destructiveHint:true`) 알린다 | 서버 코드를 확인한다. 정말 읽기 전용이면 선언에 `"ack_server_hint_conflict": true` 로 확인 표시를 달고, 아니면 쓰기(`external_effect` + `approval`)로 바꾼다 |
| `closed:invalid_declaration` | `idempotency.key_argument` 가 고정 스키마에 없다 | 선언 또는 스키마 확인 |
| `closed:unavailable` | 서버나 커넥터에 닿지 못했다 | 토큰·주소·서버 상태 확인. 커넥터는 1초→60초 대기로 자동 재시작하고, 목록을 읽으면 열린다 |
| `undeclared` (이벤트 `undeclared_tools`) | 서버가 선언에 없는 도구를 더했다 | 기록만 한다. 쓰고 싶으면 3~6절을 처음부터 밟는다 |

그 밖의 운영 이벤트: `server_request_refused`(서버가 LLM 호출·사용자 입력 같은 요청을 보냈고 거절했다. 서버 코드 점검 대상), `connector_exit`(커넥터 종료와 재시작 대기).

## 8. 쓰기의 결과가 `unknown` 일 때
쓰기 전송이 시간 초과·서버 크래시로 끝나면 부작용 원장이 `unknown` 으로 기록하고 **자동 재전송하지 않는다**(멱등 키 인자를 선언한 도구만 같은 키로 재전송될 수 있다). 사이트에서 실제 반영 여부를 확인한 뒤 [recovery](recovery.md)의 절차(`resolve-effect`)로 사람이 확정한다.

## 9. 알아 둘 점
- 서버의 응답(읽기 결과)은 모두 외부 입력(`external_untrusted`)이다. 읽은 뒤의 쓰기 호출은 승인이 필요하고, 초안에는 `influenced_by_external_input` 표시가 남는다.
- 서버에는 텍스트 결과만 전달된다(이미지·리소스는 버리고 개수만 센다). 결과는 256 KiB 로 잘린다.
- 서버가 토큰을 응답에 되돌려도 `[redacted]` 로 바뀐 뒤에 데몬에 전달된다.
- 분당 상한을 넘은 읽기는 즉시 거부되고, 쓰기 전송은 상한 안에서 `timeout_ms` 까지 기다린다.
