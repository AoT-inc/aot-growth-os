# 새 사이트 붙이는 절차 (MCP 또는 API)

growth-os 는 서비스별 전용 도구를 만들지 않는다. 서비스는 `mcp_sites[]` 항목 하나로 붙고, 에이전트는 **오너가 선언한 도구만** 쓴다(기본 거부). 이 문서는 전체 순서를 한 번에 보여 주는 길잡이다. 세부는 [mcp-sites](mcp-sites.md)(MCP, 로그인 위임 포함)와 [api-sites](api-sites.md)(MCP 서버가 없는 서비스), 결정은 [ADR-0018](../adr/0018-mcp-connector.md)·[ADR-0020](../adr/0020-api-connector.md).
기록은 각 도구(서비스)에 남고, 조직·역할·권한·승인 규칙은 growth-os 에 있다. 에이전트는 교체 가능한 작업자다.

## 0. MCP 로 붙일까, API 로 붙일까
- 서비스에 MCP 서버가 있으면 MCP(주). 없으면 API 커넥터(보조): 본문 틀을 오너가 한 동작씩 선언한다. 문법에 없는 API 는 얇은 MCP 서버를 만들어 붙인다.

## 1. 사이트 항목을 `tools: []` 로 추가 (MCP)
[mcp-sites §1~2](mcp-sites.md). 토큰은 환경 변수 *이름*으로만 적거나(`bearer`) 로그인 위임(`oauth_delegated`, `npm run mcp-login`). 자리표시자 예시는 `config/site-declarations/` 에 있다.

## 2. 도구 목록을 읽어 초안을 만든다
```
npm run mcp-draft -- instance/daemon.config.json <site> --out instance/<site>.draft.json
```
(`--out` 을 빼면 표준 출력. 이미 있는 파일은 덮어쓰지 않고, 설정 파일은 어떤 경우에도 고치지 않는다.) 출력은 다음과 같다.
- `site_entry`: 설정에 있던 전송·인증 그대로, `tools: []`.
- `draft_tools`: 서버 도구마다 초안 하나. **닫혀 있다**: `description` 이 비어 있고 `_review` 키가 있어 그대로 설정에 붙이면 데몬이 거부한다.
- 분류 제안: 서버가 `readOnlyHint:true` 이면서 파괴적·외부 접촉이 아니라고 분명히 알린 도구만 읽기(`internal`), 나머지(주석 없음 포함)는 쓰기(`external_effect`, `approval: "draft"`, `scope: "customer"`). `_review.basis` 에 이유가 있다. 서버 주석은 *힌트*일 뿐 근거가 아니다.
- `already_declared`(이미 선언된 도구), `skipped`(이름이 이상하거나 겹치거나 `as` 를 못 만든 도구. 이름은 잘라서 인용), `omitted_over_limit`(한 번에 200개까지만 초안).
- 서버가 준 **설명 문자열은 읽지도 않고**, 이름·주석은 신뢰하지 않는 자료로 걸러서 쓴다(이름 모양 제한, 불리언 4개만).
- `input_schema_sha256` 은 서버의 입력 스키마 해시다([mcp-pin](mcp-sites.md) 과 같은 값). API 사이트는 서버 목록이 없으므로 초안 명령을 쓰지 않고 [api-sites](api-sites.md)대로 선언을 직접 쓴다.

## 3. 도구마다 읽고 분류·승인 방식을 정한다
서버 코드·문서를 직접 읽고 [mcp-sites §4](mcp-sites.md) 표의 항목을 채운다. 쓸 도구만 `site_entry.tools` 로 옮기고 `_review` 를 지운다. 안 쓸 도구는 옮기지 않는다(그대로 거부).
- **쓰기는 `approval: "draft"`**: 에이전트가 정확한 인자를 초안으로 남기고 사람이 그 초안을 승인한 뒤 호스트가 그 바이트 그대로 보낸다. 삭제·사람 관리·초대·결제·외부 발송에 닿는 도구는 *선언하지 않는 것*이 기본이다.
- **인자 한 개가 동작을 고르는 도구**(예: 본문이 `{"op":"delete"}` 같은 목록을 받는 도구)는 호출 단위로만 분류할 수 있다. 가장 위험한 동작에 맞춰 쓰기·초안 승인으로 선언한다. 읽기와 쓰기가 한 도구에 섞이면 읽기로 선언하지 않는다(서버의 `dry_run` 인자가 있어도 호출 단위로 쓰기).
- 서버 쪽 권한(토큰 범위, 계정 권한)이 진짜 울타리다. 로그인 위임이면 요청 범위를 읽기와 초안 쓰기로 최소화한다.

## 4. 고정(pin)
`npm run mcp-pin -- instance/daemon.config.json <site>` 가 출력하는 `input_schema_sha256` 을 선언에 붙이고(API 사이트는 `pin`), 다시 돌려 선언 도구가 모두 `open` 인지 본다. 해시가 자리표시자(`sha256:000…`)인 도구는 `drift` 로 닫혀 있다.

## 5. 역할의 `allowed_tools` 와 정책
선언만으로는 에이전트가 쓰지 못한다. 업무 명세·역할의 `allowed_tools` 에 `mcp_<site>_<as>`(operation `call`)를 넣고, 정책 문서에 행위 `mcp_<site>_<as>.call` 과 `target` 규칙을 둔다([mcp-sites §6](mcp-sites.md)). 설정을 저장하고 데몬을 재시작해 시작 로그의 도구 상태를 확인한다.

## 예: AoT 도구 세 곳
`config/site-declarations/` 의 파일은 위 절차의 *결과* 초안이다(실제 서버 목록이 아니라 각 저장소의 도구 정의 코드를 읽어 썼다). 시험(`test/unit/site-declarations.test.ts`)이 실제 검증기 통과와 안전 규칙을 확인한다. 주소·허브는 자리표시자(`example.com`)이므로 실제 값으로 바꿔 `instance/daemon.config.json` 의 `mcp_sites` 에 옮긴다.

| 파일 | 사이트 | 내용 |
|---|---|---|
| `aot-project.json` | `project` | 읽기 12개(프로젝트·견적·비용·카탈로그·재고·거래내역서 등), 쓰기 9개는 모두 초안 승인(구매처·카탈로그 등록/수정, 견적 **초안**만). 재무(`finance`)와 서버가 외부 주소를 읽는 `shop_search`·`import_link` 는 선언하지 않았다. 인증은 `oauth_delegated`(범위 `project.read`, `project.write`). 임시로 개인 토큰을 쓰려면 `auth` 를 `{"kind":"bearer","token_env":"AOT_MCP_PROJECT_TOKEN"}` 로 바꾼다. |
| `aot-course.json` | `course` | 읽기 7개(`whoami`, `writing_guide`, 단원 검색·조회·이력·검사, 강의실 목록), 쓰기 2개 `unit_create`·`unit_update`(초안 승인). `unit_update` 는 `ops` 목록(`insert`·`replace`·`delete`…)을 받으므로 호출 단위로 쓰기다. 삭제·복원, 사람·초대·학생 재설정, 강의실 쓰기, 영상·미디어 도구는 선언하지 않았다(범위 `course.read`, `units.write` 만 요청). |
| `aot-web.json` | `web` | gitea API 커넥터. 쓰기 2개: `create_post_branch`(새 브랜치 `agent/post-<slug>` 에 한·영 글 파일을 `published:false` 로 한 커밋), `open_post_pr`(그 브랜치에서 main 으로 PR 열기). main 에 직접 쓰는 동작은 없다. 읽기: 이미지·글 목록. **병합은 오너가 gitea 에서 하고, 병합만으로는 공개되지 않는다**(`published:false`): 병합 뒤 front matter 의 `published` 를 `true` 로 바꿔야 공개된다. 제약: 홈페이지가 마크다운 본문을 Nunjucks 로 처리하므로(`markdownTemplateEngine: "njk"`) 본문(`ko_body`·`en_body`)에는 `{`·`}` 와 줄바꿈·탭·CR 외의 제어 문자(NUL 포함)를 쓸 수 없고(`{{ }}`·`{% %}` 가 빌드 때 실행되지 않게; 선언의 `forbidden_chars`) 각각 10000자까지다(호스트 인자 상한 64 KiB 안에서의 최악 계산값, [api-sites §5](api-sites.md)). 중괄호가 필요한 글은 초안 뒤에 gitea 에서 오너가 보탠다. 한계: 이미 있는 초안 브랜치는 고치는 동작이 없다(수정은 gitea 에서, 같은 slug 의 새 초안은 gitea 가 거부). gitea 쪽 계정·토큰·main 보호 판단은 [api-sites §5](api-sites.md). |

MCP 두 파일의 `input_schema_sha256` 은 자리표시자다. 실제 서버를 `mcp-pin` 으로 읽어 도구마다 값을 바꿔 넣어야 열린다(그 전에는 `closed:drift`). 서버 도구 이름이 코드와 달라졌는지도 그때 확인된다.
