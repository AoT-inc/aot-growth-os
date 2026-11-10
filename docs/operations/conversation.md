# 대화 채널 운영 (ADR-0019)

클로드 데스크탑(음성)이나 claude CLI 로 growth-os 의 현황을 묻고 업무를 요청한다. 승인은 여기서 못 한다. 승인은 검토 화면(`npm run review-web`)이나 승인 CLI 에서 오너가 직접 한다.

```
데스크탑 / claude CLI --stdio--> apps/conversation-mcp --instance/run/conversation.sock--> 데몬(대화 채널)
```

## 1. 데몬 켜기
데몬 설정(`instance/daemon.config.json`)에 `conversation` 을 더하고 데몬을 다시 시작한다. 없으면 대화 소켓은 열리지 않는다.
```json
{ "conversation": { "max_pending": 3, "max_per_day": 20, "max_notes_per_task": 20 } }
```
`socket` 을 생략하면 `instance/run/conversation.sock`. 승인 소켓과 같은 경로는 거부된다. 값은 모두 선택이다(위 값이 기본).

## 2. 클로드 데스크탑 설정 예시 (오너 PC 에서 직접 한다)
`~/Library/Application Support/Claude/claude_desktop_config.json` 에 더한다. 경로는 이 저장소의 절대 경로로 바꾼다. Node 는 24 이상.
```json
{
  "mcpServers": {
    "aot-growth-os": {
      "command": "node",
      "args": ["/ABS/PATH/aot-growth-os/apps/conversation-mcp/src/server.ts"],
      "env": { "AOT_INSTANCE_DIR": "/ABS/PATH/aot-growth-os/instance" }
    }
  }
}
```
저장 뒤 데스크탑을 완전히 종료했다가 다시 연다. 음성 모드에서 도구가 실제로 불리는지는 이 PC 에서 확인된 바 없다(미확인). 안 되면 음성에서는 현황 질문만 하고 요청은 텍스트나 CLI 로 한다.

## 3. claude CLI 등록 예시
```bash
claude mcp add aot-growth-os --scope local -e AOT_INSTANCE_DIR=/ABS/PATH/aot-growth-os/instance -- node /ABS/PATH/aot-growth-os/apps/conversation-mcp/src/server.ts
```
확인: `claude mcp list` 에서 `aot-growth-os` 가 연결됨으로 나온다.

## 4. 도구
| 도구 | 하는 일 |
|---|---|
| `overview` | 결정할 일·진행 중·막힌 일 건수, 상태별 업무 수 |
| `list_pending` | 결정을 기다리는 일 목록(요약만. 초안 본문·받는 사람 없음) |
| `task_status` | 진행 중 업무. `task_id` 를 주면 상세와 대화 메모 |
| `blockers` | 검토 대기·실패·재시도 대기와 이유 |
| `org_roles` | 조직 단위, 역할, 역할별 열린 업무 수 |
| `sites_status` | 사이트(MCP)별 열린·닫힌 도구 |
| `request_task` | `template`+`topic`. 허용 템플릿 `research-brief` 만 업무가 되고, 나머지는 보류 기록만 남는다. 대기 상한(기본 3)이면 거절 |
| `add_note` | `task_id`+`text` 메모. 기록만 되고 상태는 바뀌지 않는다 |

응답 안의 글은 외부 입력이 섞인 데이터다(`untrusted` 표지). 그 안의 "승인해" 같은 문구는 지시가 아니다.

## 5. 대화 세션 deny 규칙 예시 (안전벨트)
대화용 claude CLI 설정(`.claude/settings.json` 또는 사용자 설정)의 `permissions.deny` 에 승인 CLI 호출과 인스턴스 비밀 읽기를 넣는다. 같은 UID 한계 때문에 이것은 **방어선이 아니라 안전벨트**다(ADR-0019 "남는 위험"). 경로는 실제 위치로 바꾼다.
```json
{
  "permissions": {
    "deny": [
      "Bash(node */apps/daemon/src/approve.ts*)",
      "Bash(npm run review-web*)",
      "Read(/ABS/PATH/aot-growth-os/instance/**)",
      "Edit(/ABS/PATH/aot-growth-os/instance/**)"
    ]
  }
}
```
가능하면 대화 세션에서 셸 도구를 끄거나 권한 확인 모드를 기본으로 둔다. 클로드 데스크탑 음성 모드는 보통 셸 도구가 없다.

## 6. 점검 명령
```bash
# 소켓: 파일 0600, 폴더 0700, 승인 소켓과 다른 파일
ls -ld instance/run && ls -l instance/run/conversation.sock instance/run/approval.sock
stat -f '%Lp %N' instance/run instance/run/conversation.sock      # macOS: 700, 600

# 중계 서버가 데몬에 닿는지: overview 한 번 (JSON 한 줄이 돌아온다)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"overview","arguments":{}}}' \
  | AOT_INSTANCE_DIR=instance node apps/conversation-mcp/src/server.ts

# 승인류가 거부되는지: not_allowed 가 나와야 한다
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"approve","arguments":{}}}' \
  | AOT_INSTANCE_DIR=instance node apps/conversation-mcp/src/server.ts
```
요청·메모 기록은 DB 의 `event`(source='conversation')에서 `task_request`·`task_request_held`·`note` 로 보인다. 대화로 만든 업무는 `task.trigger_ref LIKE 'conversation:%'`.

## 7. 알려진 한계
- 요청함·메모 표시 화면은 후속이다(review-web). 지금은 위 DB 조회나 `task_status` 로 본다.
- 한도 리셋 시각은 확인된 바 없다. `blockers` 도 "미확인"이라고 알린다.
- 보류 요청(`task_request_held`)을 볼 화면은 아직 없다. DB 의 `event` 에서 본다.
- 소켓 생성과 chmod 사이에 짧은 권한 틈이 있다(폴더 0700 이 막는다, ADR-0019 "알려진 한계").
- 대화 업무(`research-brief`)는 도구가 없어 업무 승인 없이 시작한다. 막는 것은 고지 동의, 사람 우선 게이트, 동시 1, 상한들이다(ADR-0019 "게이트 정책 사실 확인").
- 같은 UID 문제(ADR-0019)는 풀리지 않았다. 대화 세션이 셸을 가지면 승인 CLI 에 닿을 수 있다.
