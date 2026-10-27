# 인계: 섀도 파일럿 준비 마무리 (2026-10-26)

[상품 등록 도그푸딩 계획](registration-dogfood.md) 1~3단계와 4단계의 *준비*(섀도 모드·`product` 명령·파일럿 보고, PR #13까지)가 main에 있다. 파일럿 5건 자체는 사용자 PC에서 한다([절차서](../operations/shadow-pilot.md)). 이 문서는 **그 전에 클라우드 세션(AI)이 사용자 PC 없이 끝낼 수 있는 일**을 작업 단위(WP)로 나눈 것이다. 각 WP는 혼자 읽고 시작할 수 있게 썼다.

## 현재 상태 (main `3e19735` 기준)
- 구독 검증기(`llm_verifier: claude_code_cli`, 도구 없는 별도 호출), 섀도 모드(`shadow: true`, 상품 등록 업무에만), 사람용 `product` 명령(`add`·`start`·`status`·`evidence`·`decide`·`pilot`), 파일럿 절차서가 있다. 독립 보안 리뷰를 두 번 거쳤다(검증기, 등록 채널).
- 사용자 PC에서 확인됨: 구독 로그인으로 `--tools ""` + 빈 MCP + stdin 프롬프트 호출이 정상(격리 init `tools=[]`, `mcp_servers=[]`). 어댑터 전체 옵션(`--restricted` 등) 모양의 검증기 호출은 PC에서 아직 안 돌려 봤다.
- 로컬 검사: 단위 1301, 통합 227/234(**실패 2건은 root 컨테이너의 소켓 권한(EACCES) 시험이며 이전부터 같다** — 비-root 환경에서 확인할 것), 경계 3. `check:schema`는 `sqlite3` 바이너리가 있는 환경에서만 돈다(CI에는 있다).

## 작업 단위

| WP | 제목 | 상태 | 사용자 결정 |
|---|---|---|---|
| 1 | `product remove` (잘못 올린 후보 지우기) | 미착수 (`restart`는 2026-10-27 구현됨: 재검증) | 불필요 |
| 2 | 파일럿 사전 점검 CLI (`preflight`) | 미착수 | 불필요 |
| 3 | 승인 시 수집 사실 반영 | 미착수 | **필드 범위 확인 필요**(아래 제안대로 진행하고 PR 본문에 명시) |
| 4 | 검증 업무 실행 중 반려·접근 회수 | 미착수 | **설계 확인 필요**(아래 제안대로 진행하고 PR 본문에 명시) |
| 5 | `main.ts` 금지 경로 조립을 함수로 빼서 시험 | 미착수 | 불필요 |
| 6 | 의존성 라이선스 수집 (선택) | 미착수 | 범위 확인 필요 — 급하지 않음 |

작업을 시작하기 전에 열린 PR 목록에서 같은 WP를 하는 PR이 없는지 확인하고, 시작하면 이 표의 상태를 `진행 중 (PR 링크)`로 바꾸는 것을 그 PR의 첫 커밋에 넣는다. 끝나면 `완료 (PR 링크)`.

### WP1. `product remove <slug>`
- **왜.** 후보 경로를 잘못 적었을 때 채널로 고치거나 지울 길이 없어 DB를 직접 만져야 한다([절차서 §7](../operations/shadow-pilot.md)).
- **무엇.** `product` 채널에 `remove` op(사람 전용). `candidate` 상태이고 `access_scope=none`이며 검증 업무가 없는 상품만 지운다(`product` + `product_repo` 행). 그 밖의 상태는 `wrong_state`. 지운 사실을 `event`(`source='product-registration'`, `type='registration.candidate_removed'`)로 남긴다. 승인 CLI에 `product remove <slug>`, 모르는 옵션 거부 규칙 유지.
- **파일.** `apps/daemon/src/product-channel.ts`(OPS·KEYS·switch), `apps/daemon/src/approve.ts`, 시험 `test/integration/daemon-product-pilot.test.ts`, 절차서 §3·§7.
- **완료 기준.** add → remove → 같은 슬러그·같은 경로로 다시 add 가능; start 한 상품은 remove 거부; 에이전트 actor 거부; CLI 사용법 오류 종료 코드 2.

### WP2. 파일럿 사전 점검 CLI (`npm run preflight`)
- **왜.** PC에서 설정 실수(상대 경로, 실행 파일 없음, 실행·검증 모델 같음, 동의 안 함)를 데몬을 띄운 뒤에야 알게 되는 일을 줄인다.
- **무엇.** `apps/daemon/src/preflight.ts` + `package.json` 스크립트. 인자로 받은 데몬 설정 파일을 읽어 점검 결과를 한 줄씩(`ok`/`warn`/`fail` + 사유) 낸다. 점검: ① 설정 파싱(`parseClaudeCodeCliConfig`·`parseRegistrationToolsConfig`·`parseLlmVerifierConfig` 재사용) ② 경로가 절대 경로이고 실행 파일은 실행 가능 ③ `claude --version`·`git --version`·`gitleaks version` 실행(gitleaks 8.30.1이 아니면 `warn`) ④ `llm_verifier`가 `claude_code_cli`이고 `shadow: true`이며 모델이 실행 모델과 다름 ⑤ DB가 있으면 읽기 전용으로 열어 고지 동의 상태(`readClaudeCodeConsent`)와 마이그레이션 적용 여부 ⑥ 증거·run 디렉터리 권한(0700) ⑦ `registration_tools`가 켜져 있어야 `product` 명령이 켜진다는 안내.
- **하지 않는 것.** 모델을 호출하지 않는다(구독 사용량을 쓰지 않는다). 환경 변수·토큰·로그인 정보를 읽거나 출력하지 않는다. DB를 쓰지 않는다. 실제 구독 로그인 여부는 점검할 수 없으니 "PC에서 §4 5번 명령으로 확인" 안내만 한다.
- **시험.** 가짜 실행 파일(`test/support/fake-claude-verifier.ts` 참고)로 각 점검의 `ok`/`fail`; 출력에 설정의 비밀스러운 값이 없음.

### WP3. 승인 시 수집 사실 반영
- **왜.** 지금은 승인해도 `product_repo.default_branch`·`stack`이 비어 있다(증거에만 있음). [템플릿 §2](../../workflows/product-registration.md)는 "승인 시 컬럼에 반영"이라 한다.
- **제안.** `decide approve`의 트랜잭션에서, 이 업무의 `repo_read.read_metadata` 증거 본문(`repo_metadata@1` 등 형식은 `packages/agent-runtime/src/registration/repo-read.ts`)을 읽어 `default_branch`와 `stack`(매니페스트 이름·확장자별 파일 수)만 `product_repo`에 쓴다. **원격 주소·경로는 쓰지 않는다**(도구가 주소를 수집하지 않는다). 읽을 수 없거나 해시가 맞지 않으면 승인을 거부하지 않고 그 칸을 비워 둔다(응답에 `facts_applied: false` + 사유).
- **주의.** 증거 본문은 외부 입력(`external_untrusted`)이다 — 문자열은 길이 상한·문자 검사 후에만 쓴다. `decide`는 현재 동기 구간에서 읽고 쓴다(레이스 방지): 본문 읽기가 비동기이므로 **트랜잭션 밖에서 읽은 뒤 `review_hash` 재확인 → 쓰기** 순서를 지켜 승인 시점과 어긋나지 않게 한다.
- **보안 리뷰 대상**(DB에 외부 유래 문자열을 쓴다).

### WP4. 검증 업무 실행 중 반려·접근 회수
- **왜.** 지금 `decide reject`는 업무가 `needs_review`·종료 상태일 때만 된다(`task_active`). 실행 중 위험을 발견해도 읽기 접근을 채널로 회수할 수 없다.
- **제안.** 반려는 업무 상태와 무관하게 허용한다: 상품 `rejected` + `product_repo.access_scope='none'`을 먼저 적용한다(도구는 `bindRepo`가 호출마다 `verifying`·`read`를 확인하므로 다음 호출부터 닫힌다). 업무가 `queued`·`unassigned`·`retry_wait`·`validating`이면 사람이 취소(상태표의 취소 규칙, 사유 필수)하고, `running`이면 그대로 두어 다음 도구 호출 실패로 끝나게 한다. 응답에 어느 경우였는지 적는다.
- **주의.** 상태표(`docs/schema/state-machines.md`)에 없는 업무 전이를 만들지 않는다. 필요하면 사용자에게 묻는다. **보안 리뷰 대상.**

### WP5. 금지 경로 조립을 함수로
- `apps/daemon/src/main.ts`가 `buildAgentRuntime`에 넘기는 `forbiddenRoots`(DB 파일·TOTP·정책 저장소·승인 소켓)를 `main.ts` 밖의 함수(예: `apps/daemon/src/forbidden-roots.ts`)로 빼고, 설정에 따라 인스턴스 밖에 놓인 경로도 포함되는지 단위 시험을 쓴다. 동작은 바꾸지 않는다.

### WP6. 의존성 라이선스 수집 (선택, 후순위)
- [템플릿 §2](../../workflows/product-registration.md)의 "의존성 라이선스 목록"은 지금 수집하지 않는다. 범위(매니페스트 파싱만? 잠금 파일?)와 "판단하지 않고 사실만" 원칙을 사용자와 정한 뒤에만 시작한다.

## PC 에서만 할 수 있는 것 (클라우드에서 시도하지 말 것)
- 파일럿 5건 실행과 사람 결정([절차서](../operations/shadow-pilot.md)), 데몬 전용 OS 계정의 `claude auth login`, 실제 소켓에서 `consent show/accept`, 어댑터 전체 옵션 모양의 검증기 호출, 구독 사용률 척도(0~1/0~100)와 실제 한도 문구 관찰, 비-root 계정에서의 권한 없는 파일 스캔 동작 확인. 결과는 사용자가 알려 주면 [claude-code-cli §4](../operations/claude-code-cli.md)와 [계획](registration-dogfood.md)에 기록한다.
- 파일럿 결과로 Q22·종료 조건 4번을 닫는 문서 개정은 결과를 받은 뒤에 한다.

## 작업 규칙 (모든 WP)
- Node 24(`npm ci`). 푸시 전에 `npm run typecheck`, `lint`, `lint:boundaries`, `test:unit`, `test:integration`(위 EACCES 2건은 root 환경의 기존 실패), `test:boundaries`, `scan:secrets`를 돌린다. 이 PR 커밋 범위의 gitleaks 이력 검사도(`gitleaks git . --config config/gitleaks-registration.toml --ignore-gitleaks-allow --log-opts "origin/main..HEAD"`).
- 공개 저장소: 실제 제품명·경로·주소·비밀값 금지(`example-product`, `example.com`). 비밀처럼 보이는 시험 표본은 런타임에 문자열을 이어 붙여 만든다(스캐너가 잡는다). 경계 lint 완화 금지, 시간은 주입 Clock, 쓰기는 `Db.writeTx`, 스키마·상태 허용표 변경은 사용자 결정 후.
- 커밋은 `-s` 서명. PR은 초안으로 올리고 본문에 *확인한 것 / 확인하지 못한 것 / 정한 것*을 구분해 적는다. **보안 리뷰 대상 표시가 있는 WP는 병합 전에 별도 세션의 독립 리뷰**(재현되는 문제만, 코드와 diff만 주고 결론은 주지 않는다)를 받고, 하위 에이전트의 보고는 믿지 말고 검사를 다시 돌린다.
- 병합은 사용자가 지시할 때만 한다. 사용자 결정이 필요하다고 표시된 곳은 위 제안으로 구현하되 PR 본문 맨 위에 결정 요청으로 적는다.
