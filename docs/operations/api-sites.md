# MCP 서버가 없는 서비스를 API 로 붙이기 (운영 절차)

결정은 [ADR-0020](../adr/0020-api-connector.md), MCP 쪽 절차는 [mcp-sites](mcp-sites.md). API 전송은 같은 `mcp_sites[]` 항목에 `transport.kind: "api"` 를 쓰고, 정책·승인·원장·속도 제한·비밀 처리는 MCP 도구와 같다.
에이전트는 URL·메서드·헤더·본문을 정하지 못한다. 에이전트가 내는 것은 **선언된 동작 이름과 인자 값**뿐이고, 요청 모양은 오너가 선언한 틀이 정한다. 틀에 없는 요청은 보낼 수 없다.
전체 절차 개요는 [new-site](new-site.md). 글 초안 올리기 + PR 열기 선언은 `config/site-declarations/aot-web.json`.
예시는 자리표시자다(`gitea.example.net`). 실제 주소·토큰은 저장소에 넣지 않는다. 전체 예시 선언은 `config/daemon.config.example.json` 의 `_api_sites_example` (선언 고정까지 채워져 있고 시험이 일관성을 확인한다).

## 1. 선언 형식
```jsonc
{
  "site": "web",
  "transport": { "kind": "api", "base_url": "https://gitea.example.net/gitea/api/v1", "network": "tailnet" },
  "auth": { "kind": "header", "header": "Authorization", "value_env": "AOT_API_WEB_TOKEN" },
  "rate_limit_per_minute": 20, "timeout_ms": 20000,
  "tools": [ { /* 동작 하나 = 도구 하나 */ } ]
}
```
- `base_url`: 출처 + 선택적 경로 접두어. https 가 기본, 루프백 개발 서버만 `network: "loopback"` 와 http. 사용자 정보·쿼리·조각 없음.
- `network`: `public`(기본, 공인 주소만) · `tailnet`(공인 + 100.64.0.0/10; tailnet 의 IPv6 대역 fd7a:115c:a1e0::/48 은 **지원하지 않는다**) · `loopback`(**개발·시험 전용, 운영에서 쓰지 않는다** — 데몬이 도는 PC 의 로컬 서비스에 쓰기를 보낼 수 있는 선언이다). 사설망(RFC1918)·링크로컬은 어느 경우에도 거부한다. 주소 해석 결과가 하나라도 규칙 밖이면 연결하지 않고 연결은 검사한 주소로 고정한다. **리다이렉트는 따르지 않는다.**
- `auth`: `none` · `bearer`(`token_env`) · `header`(`header` + `value_env`). 값은 환경 변수 이름으로만 적고 커넥터 프로세스에만 전달된다. 서비스가 `Authorization: token <값>` 을 요구하면 `header: "Authorization"` 에 값이 `token xxxx` 인 환경 변수를 쓴다. `oauth_delegated` 는 api 사이트에서 지원하지 않는다.

동작(도구) 필드: 분류는 MCP 와 같다 — `name`(= 동작 이름), `as`, `description`(오너가 쓴 설명), `scope`, `impact`, `side_effect`, `approval`(쓰기 필수: `draft`|`scope`), `target`, `unit_cost_usd`. 거기에 아래가 더해진다(`input_schema_sha256`·`idempotency` 는 쓰지 않는다).

| 필드 | 뜻 |
|---|---|
| `args` | 인자 이름 → `{ type: string\|integer\|boolean, required?, enum?, pattern?, min?, max?, max_length? }`. 선언 밖 인자는 거부. 문자열 기본 `max_length` 256. `pattern` 은 값 **전체**와 일치해야 한다(앵커가 없어도 전체 일치로 검사). 패턴은 데몬 프로세스에서 실행되므로 패턴이 있는 문자열은 `max_length` ≤ 2048 이고, 반복되는 그룹 안의 반복·선택(`(a+)+`, `(a\|aa)*`)과 역참조는 선언 단계에서 거부한다. 한 줄 값은 `^[^\n\r\u2028\u2029\u0085]+$` 로 쓴다 |
| `request.method` | GET POST PUT PATCH DELETE. 쓰기는 GET 불가. 읽기에 GET 이 아닌 메서드를 쓰려면 `"ack_post_is_read": true` |
| `request.path` | `/repos/{owner}/…` 틀(끝 `/` 불가). `{이름}` 자리 인자는 `pattern`(또는 `enum`)과 `required` 가 필수. 글자는 영숫자와 `._~-` 만 |
| `request.query` | `{ 키: "고정 값" \| {"$arg":"이름"} \| {"$const":값} }`. 선택 인자가 없으면 그 키는 보내지 않는다 |
| `request.body` | JSON 틀. 문자열 값은 `{"$arg":…}` `{"$const":…}` `{"$template":"…", "encode":"base64"?}` 중 하나로만 쓴다. 키 자리에는 쓸 수 없다. POST/PUT/PATCH 만 |
| `request.headers` | 고정 헤더(`Authorization`·`Host`·`Cookie` 등 예약 이름 불가) |
| `returns` | 읽기 필수. 에이전트에 돌려줄 응답 필드 경로 `["/commit/sha", "/*/name"]` (`*` 는 배열 원소). 목록 밖 필드는 버리고 경로가 없으면 오류. **경로가 객체·배열에서 끝나면(`/*`, `/commit`) 그 아래 전체가 에이전트에 간다 — 항상 필요한 리프 필드까지 적는다** |
| `record` | 쓰기 선택. 원장 응답 기록에만 남길 필드. 쓰기는 `returns` 를 쓸 수 없고 응답 본문은 에이전트에 가지 않는다 |
| `pin` | 선언 고정(아래 3절). 해시에는 `base_url`·`network`·인증 종류와 환경 변수 이름·헤더 이름, 동작의 분류·승인·대상·`args`·`request`·`returns`·`record` 가 들어간다 |

템플릿: `{이름}` 또는 `{이름|변환}`, 변환은 `raw`(기본) · `json_string`(따옴표 친 JSON/YAML 스칼라) · `base64`. 글자 `{` `}` 는 `{{` `}}`. 호스트가 정하는 예약 인자 `{effect_key}` 는 쓰기 동작의 템플릿·`$arg` 에서만 쓸 수 있고, 부작용 원장의 효과 키가 들어간다 — 커밋 메시지 등에 넣어 두면 결과가 `unknown` 일 때 사람이 서비스에서 반영 여부를 찾을 수 있다.
앞머리(front matter)가 있는 파일을 만들 때 제목·요약은 한 줄 `pattern`(`^[^\n\r]+$`) + `json_string` 으로 쓰면 줄바꿈 주입이 안 된다.

## 2. 절차
1. 서비스 쪽에서 **전용 계정과 최소 권한 토큰**을 만든다(토큰 권한이 곧 울타리다). 토큰을 환경 변수에 넣고 데몬을 그 환경으로 띄운다. 값이 비면 데몬이 시작하지 않는다.
2. `mcp_sites` 에 항목을 더한다. 동작마다 `pin` 은 비워 둔다. 데몬은 시작하지만 그 동작은 `closed:drift` 로 닫혀 있다.
3. `npm run mcp-pin -- instance/daemon.config.json <site>` (별칭 `npm run api-pin -- …`) 을 돌린다. 동작마다 `input_schema_sha256: sha256:…` 와 상태(`open`/`drift`)가 나온다. **요청은 서비스로 나가지 않는다** — 선언만 읽는다. 선언을 직접 읽고 맞으면 그 값을 `pin` 에 적는다.
4. 데몬을 다시 띄워 `tool_state` 이벤트가 `open` 인지 본다. 선언(경로·본문 틀·분류·승인·`base_url`·`network`·인증 종류·헤더 이름)을 하나라도 고치면 해시가 바뀌어 그 동작은 다시 닫힌다 — 3번부터 반복한다. `description`·`as` 는 해시에 들어가지 않는다.
5. 업무 명세의 `allowed_tools` 와 정책 문서에 도구 이름 `mcp_<site>_<as>` 를 허용하는 규칙을 둔다(MCP 도구와 같다).

## 3. 선언 고정(pin)과 승인
- 쓰기 초안에는 승인 대상 인자와 함께 그 시점의 `pin` 이 저장된다. 사람이 승인한 뒤 선언이 바뀌어(다시 고정해도) `pin` 이 달라지면 그 초안은 전송되지 않고 `failed` 가 된다. 새 선언으로 다시 초안을 만들어야 한다.
- 호스트는 전송 직전마다 `pin` 을 확인한다. `pin` 은 *서비스 쪽 변화*는 못 잡는다 — 읽기 동작은 응답이 `returns` 모양과 다르면 오류로 알려 준다.

## 4. 결과 판정(쓰기)
보내기 전 실패(닫힘·인자 검사·주소·DNS·연결 실패)와 4xx·3xx 는 `failed`, 2xx 는 `confirmed`, 5xx·요청을 보낸 뒤의 시간 초과/연결 끊김은 `unknown` 이다. `unknown` 은 자동 재전송하지 않는다: 서비스에서 효과 키로 반영 여부를 찾아 `resolve-effect` 로 확정한다.

## 5. 첫 적용: gitea 에 홈페이지 글 초안 올리기
선언 예시는 `config/daemon.config.example.json` 의 `_api_sites_example`: 쓰기 `draft_post` 1개(새 브랜치 `agent/post-<slug>` 에 `src/ko/posts/<slug>.md` 와 `src/en/posts/<slug>.md` 를 **한 커밋**으로 만들고 `published: false` 고정), 읽기 `list_images`·`list_posts`. 이 문서와 예시는 선언일 뿐 실제 gitea 에는 아무 요청도 보내지 않는다.

gitea 쪽 설정(오너가 NAS 에서):
1. 봇 전용 계정(예: `aot-agent`)을 만들고 `aot/aot-web` 에 **쓰기 권한 협력자**로만 추가한다. 다른 저장소·조직 권한은 주지 않는다.
2. 그 계정의 토큰 범위는 저장소 쓰기만(NAS gitea 버전의 범위 이름은 설정 화면에서 확인). 사용자·조직·관리 범위는 주지 않는다. 환경 변수 값은 `token <토큰>` 형식이다(gitea 가 `Authorization: token …` 과 `Bearer` 중 무엇을 받는지는 확인 필요).
3. **main 브랜치 보호는 오너가 결정한다.** 걸면 봇은 새 브랜치만 만들 수 있고 main 에는 쓰지 못한다. 관리 화면(Sveltia)과 "고친 것 올리기"의 배포 키 경로가 막히지 않는지 먼저 시험한 뒤 켠다(푸시 허용 목록에 오너 계정·배포 키 필요, 배포 키 허용 가능 여부는 미확인). 걸지 않으면 봇 토큰 권한이 곧 main 쓰기 권한이므로 선언의 `branch`/`new_branch` 틀이 유일한 울타리가 된다.
4. 봇 브랜치는 `agent/` 접두어다. 오너는 gitea 의 브랜치 비교(또는 PR)에서 diff 를 보고 **병합한다 = main 반영**(NAS 가 main 을 2분 안에 배포)이지만 초안 글은 `published: false` 라서 병합 뒤 오너가 `published` 를 `true` 로 바꿔야 공개된다.
5. 이미지는 새로 올리지 않는다. `image` 는 이미 `static/img` 에 있는 파일 이름만 받고 `list_images` 로 목록을 읽어 고른다.
6. 미확인(실제 서버로 확인하지 않았다): gitea 가 **이미 있는 `new_branch` 이름**에 어떤 상태 코드로 답하는지. 4xx 이면 `failed`, 5xx 이면 `unknown` 으로 기록된다. 첫 실제 시험 전에 시험용 저장소에서 확인한다.
7. `base_url` 의 호스트가 tailnet 주소이면 `network: "tailnet"` — 데몬을 돌리는 PC 가 tailnet 에 있어야 닿는다. 아니면 gitea 를 공개 주소로 열어야 하는데 이는 별도 판단이다.

## 6. 만들 수 없는 것
멀티파트 업로드, 스트리밍, 쿠키 세션, 응답을 보고 다음 요청을 정하는 흐름, 페이지 자동 순회는 문법에 없다. 그런 서비스는 얇은 MCP 서버를 만들어 [mcp-sites](mcp-sites.md) 로 붙인다.
