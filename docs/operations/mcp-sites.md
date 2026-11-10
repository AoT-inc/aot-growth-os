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
- 인증: `{"kind":"bearer","token_env":…}`, `{"kind":"header","header":…,"value_env":…}`, `{"kind":"none"}`, `{"kind":"oauth_delegated","hub":…,"resource":…,"scopes":[…]}`(오너 로그인 위임, 10절). 값을 직접 적으면 거부된다.
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
| `idempotency` | 서버가 중복 요청 방지용 인자를 받는 쓰기에만: `{"key_argument":"request_id","retention_ms":86400000}`. 이 인자는 고정 스키마에 있어야 하고 **형식이 문자열을 받아야 한다**(`string`, 또는 형식 선언 없음. `integer` 등이면 `closed:invalid_declaration`). 전송 때 호스트가 effect key 문자열을 채우며, 에이전트가 넣으면 거부한다. 스키마가 이 인자를 `required` 로 요구해도 괜찮다(필수 검사에서 빠진다). 없으면 응답을 잃은 쓰기는 자동 재전송되지 않는다 |
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
| `closed:invalid_declaration` | `idempotency.key_argument` 가 고정 스키마에 없거나 문자열을 받지 않는다 | 선언 또는 스키마 확인 |
| `closed:duplicate` | 서버 목록에 같은 이름의 도구가 둘 이상이다 | 서버 코드 점검. `mcp-pin` 에 `duplicate` 로 나온다 |
| `closed:unavailable` | 서버나 커넥터에 닿지 못했다 | 토큰·주소·서버 상태 확인. 커넥터는 1초→60초 대기로 자동 재시작하고, 목록을 읽으면 열린다 |
| `undeclared` (이벤트 `undeclared_tools`) | 서버가 선언에 없는 도구를 더했다 | 기록만 한다. 쓰고 싶으면 3~6절을 처음부터 밟는다 |

그 밖의 운영 이벤트: `server_request_refused`(서버가 LLM 호출·사용자 입력 같은 요청을 보냈고 거절했다. 서버 코드 점검 대상), `connector_exit`(커넥터 종료와 재시작 대기).

## 8. 쓰기의 결과가 `unknown` 일 때
쓰기 전송이 시간 초과·서버 크래시로 끝나면 부작용 원장이 `unknown` 으로 기록하고 **자동 재전송하지 않는다**(멱등 키 인자를 선언한 도구만 같은 키로 재전송될 수 있다). 사이트에서 실제 반영 여부를 확인한 뒤 [recovery](recovery.md)의 절차(`resolve-effect`)로 사람이 확정한다.

## 9. 알아 둘 점
- 서버의 응답(읽기 결과)은 모두 외부 입력(`external_untrusted`)이다. 읽은 뒤의 쓰기 호출은 승인이 필요하고, 초안에는 `influenced_by_external_input` 표시가 남는다.
- 서버에는 텍스트 결과만 전달된다(이미지·리소스는 버리고 개수만 센다). 결과는 256 KiB 로 잘린다.
- 서버가 토큰을 응답에 되돌려도 `[redacted]` 로 바뀐 뒤에 데몬에 전달된다.
- 분당 상한을 넘은 읽기는 즉시 거부되고, 쓰기 전송은 상한 안에서 기다린다. 전송 전체(보내기 직전 확인 + 대기 + 호출)가 `timeout_ms` 안에 끝나지 못하면 서버에 보내지 않고 실패로 끝난다. 고정 확인(`list`)은 상한을 쓰지 않는다.

## 10. 오너 로그인 위임 토큰으로 연결하기 (`oauth_delegated`)
사이트가 중앙 인증(aot-auth)의 OAuth2 접근 토큰(1시간)을 요구할 때 쓴다. 환경 변수에 토큰을 넣는 1~2절 대신, 오너가 허브에 **한 번 로그인**하면 데몬이 접근 토큰을 만료 전에 갱신해 커넥터에 전달한다. 결정은 [ADR-0018 개정 1](../adr/0018-mcp-connector.md).
토큰은 **오너 권한 그대로**다(관리자면 사이트 쪽 권한 검사가 모두 통과한다). 울타리는 요청 범위와 오너가 선언한 도구뿐이므로 범위를 최소로 한다(처음엔 읽기 범위와 초안 쓰기 범위만, 사람·영상 쓰기 같은 범위는 빼고, 그 도구는 선언하지도 않는다).

### 10-1. 선언
```json
{
  "site": "course",
  "transport": { "kind": "http", "url": "https://mcp.course.example.com/mcp" },
  "auth": { "kind": "oauth_delegated", "hub": "https://auth.example.com",
            "resource": "https://mcp.course.example.com/mcp", "scopes": ["course.read", "units.write"] },
  "tools": []
}
```
- `hub`: 허브 주소(출처만, https). `resource`: 사이트가 허브에 등록된 값 그대로(허브는 정확히 일치를 요구한다). 전송 URL 과 **출처가 같아야** 한다(토큰이 다른 호스트로 나가지 않게). `scopes`: 요청 범위(허브가 사람의 동의 화면에서 줄일 수 있다).
- http 전송에서만 쓴다. 환경 변수는 필요 없다. 데몬은 저장된 로그인이 없어도 시작하고(도구는 `closed:unauthorized`, 알림 파일이 남는다) 로그인이 생기면 이어받는다.

### 10-2. 로그인
```
npm run mcp-login -- course --config instance/daemon.config.json
```
출력된 주소를 브라우저로 열어 허브에 로그인한다(비밀번호 + TOTP, 동의 화면에서 사이트와 범위 확인). 브라우저가 이 컴퓨터의 `127.0.0.1` 임의 포트로 되돌아오며(5분 제한, 허브 되돌림 주소 허용 목록에 이미 있다) 명령이 끝난다. 데몬이 도는 컴퓨터에서 실행한다(되돌림 주소가 그 컴퓨터의 루프백이다). 브라우저를 열 수 없는 서버에서 하는 로그인은 아직 지원하지 않는다(알려진 제약, 남은 일).
- 저장: `instance/mcp-auth/course.json`(디렉터리 0700, 파일 0600). 갱신 토큰은 여기에만 있다. 이 파일은 저장소에 커밋하지 않는다(`instance/` 는 무시 대상).
- 실행 중인 데몬은 약 30초 안에 이어받는다(재시작 불필요). 선언의 허브·resource·범위를 바꾸면 저장된 로그인이 맞지 않아 다시 로그인해야 한다.
- 3~5절의 `mcp-pin` 은 저장된 접근 토큰이 유효할 때 **읽기만** 한다(갱신은 데몬 한 곳이 한다: 갱신 토큰을 두 곳이 쓰면 허브가 연결 전체를 끊는다). 만료돼 있으면 데몬을 켜 두거나 다시 로그인한다.

### 10-3. 상태 확인과 알림
```
npm run mcp-login -- --status --config instance/daemon.config.json
```
사이트별 로그인 상태와 **오너 알림**을 보여 준다. 알림 파일은 `instance/mcp-auth/<site>.notice.json`(시각, 이유, 할 일)이고 운영 로그에도 `mcp <site>: {"type":"auth_failed",…}` 가 남는다. 다시 로그인하거나 갱신이 성공하면 지워진다.

| 이유 | 뜻 | 할 일 |
|---|---|---|
| `not_logged_in` | 저장된 로그인이 없다 | `mcp-login <site>` |
| `refresh_rejected` | 허브가 갱신을 거절(30일 경과, 연결 끊기, 계정·사이트 접근 회수) | 원인 확인 후 `mcp-login <site>` |
| `refresh_ambiguous` | 갱신 요청의 응답을 잃었다. 허브가 이미 토큰을 교체했을 수 있어 **재시도하지 않는다** | `mcp-login <site>` |
| `access_token_expired` | 서버 오류·연결 불가가 길어 접근 토큰이 만료됐다(재시도는 계속된다) | 허브 상태 확인, 자동 복구 대기 |
| `config_changed` | 선언의 허브·resource·범위가 저장된 로그인과 다르다 | `mcp-login <site>` |
| `store_unreadable` | 저장 파일이 깨졌거나 다른 사용자가 읽을 수 있는 권한이다(0600 이어야 한다) | 권한 확인, 안 되면 파일 삭제 후 `mcp-login <site>` |
| `store_write_failed` | 교체된 갱신 토큰을 디스크에 3번 연속 못 적었다(디스크 가득 참·권한). 옛 토큰을 다시 보내면 허브가 연결을 끊으므로 이 사이트를 닫고 계속 저장을 시도한다 | 디스크·`instance/mcp-auth` 권한 확인. 복구되면 자동으로 이어 간다 |

해당 사이트의 도구만 `closed:unauthorized` 가 된다(다른 사이트와 에이전트의 다른 도구는 그대로). 사이트가 401 을 돌려주면 원천이 한 번 갱신을 시도한다(1분에 한 번까지).

알려진 한계: 허브가 새 토큰을 내준 직후, 디스크에 쓰기 전에 데몬이 죽으면 새 갱신 토큰을 잃고 다음 기동에서 옛 토큰을 보내 허브가 연결을 끊을 수 있다(그러면 `refresh_rejected`, 다시 로그인). 로그인-갱신이 동시에 일어나는 경우는 쓰기 직전에 디스크의 토큰을 비교해 새 로그인을 지키지만 프로세스 사이 잠금은 아니다. 사이트가 계속 401 을 주면 강제 갱신 간격이 1분에서 30분까지 늘어난다.

### 10-4. 로그아웃과 폐지
`npm run mcp-login -- --logout course` 는 이 컴퓨터에 저장된 로그인만 지운다. 토큰이 새었을 수 있으면 허브 화면에서 연결을 끊는다(폐지 목록으로 최대 1시간 안에 사이트가 거절한다).
