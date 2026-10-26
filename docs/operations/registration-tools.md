# 상품 등록 검증 도구 운영 (repo_read · secret_scan · license_check)

[상품 등록 검증 업무](../../workflows/product-registration.md)가 쓰는 도구 3개와 호스트 근거 저장소의 설정·보안 속성·한계를 모은다. 결정과 순서는 [계획](../plans/registration-dogfood.md), 평가 쪽 규칙은 [evaluation §9](evaluation.md), 구현은 `packages/agent-runtime/src/registration/`와 `apps/daemon/src/{registration,evidence-store}.ts`다. 예시는 가상의 `example-product`만 쓴다.

## 1. 설정

데몬 설정 `registration_tools`(없으면 꺼짐, `config/daemon.config.example.json`):

| 키 | 뜻 |
|---|---|
| `git_path` | `git` 실행 파일의 **절대 경로**(PATH 탐색 없음) |
| `gitleaks_path` | gitleaks **8.30.1**(Q21)의 절대 경로 |
| `gitleaks_config` | 스캐너 설정 파일의 절대 경로. 생략하면 저장소의 `config/gitleaks-registration.toml`(기본 규칙 전체). **후보 저장소 안의 `.gitleaks.toml`은 쓰지 않는다** — 허용 목록으로 스캔을 피할 수 없다. 인스턴스별 금지어·추가 규칙은 이 파일을 대체해 저장소 밖에 둔다 |
| `evidence_dir` | 근거 본문 디렉터리(0700). 기본 `<instance_dir>/evidence` |
| `scan_timeout_ms` | 스캐너 제한 시간(1000~3600000, 기본 10분) |

- `claude_code_cli` 또는 `container_agent`가 있어야 한다(도구를 부를 에이전트). 실행 파일이 없거나 실행할 수 없으면 데몬이 **시작하지 않는다**.
- 에이전트 역할을 `claude_code_cli.roles`에 `registration-verifier`로 매핑한다([claude-code-cli 운영](claude-code-cli.md) §2).

## 2. 언제 열리나

도구는 아래가 **모두** 맞을 때만, **호출마다** 확인해서 열린다(하나라도 어긋나면 `tool_error`, 근거 행을 만들지 않는다):

1. 업무 명세의 `allowed_tools`에 등록 도구가 있고 그 `target`이 모두 같은 `repo:<슬러그>`다(하나도 없거나 서로 다르면 거부).
2. 그 슬러그의 상품이 `registration_status = 'verifying'`이다(`candidate`·`pending_approval`·`registered`·`rejected`는 거부).
3. `product_repo`가 정확히 하나이고 `local_path`가 절대 경로다.
4. `product_repo.access_scope`가 사람 승인으로 `read`(또는 `write_branch`)다. 회수하면 다음 호출부터 막힌다.
5. 정책 판정(게이트웨이 호출별 재판정)이 `allow`다: 기본 정책에서 internal 읽기는 허용.

에이전트는 **경로를 주지 못한다.** 인자는 저장소 루트 기준 상대 경로뿐이다.

에이전트가 부르는 이름은 `<도구>_<작업>`이다(`repo_read_read_file`, `secret_scan_scan_tree`, `license_check_identify` …). 정책의 행위(`repo_read.read_file`)·명세의 `allowed_tools`·실행기는 도구 이름과 작업으로 정해지고, 이름은 에이전트가 부르는 표면일 뿐이다(`GatewayToolSpec.name`).

## 3. 보안 속성 (시험이 고정한 것)

독립 보안 리뷰(2026-10-26)가 재현한 문제를 모두 고쳤고, 각 항목은 리뷰가 보인 입력을 그대로 시험에 넣었다.

| 위협 | 방어 | 시험 |
|---|---|---|
| 경로 탈출(`..`, 절대 경로, NUL, 역슬래시) | 상대 경로 정규화에서 거부 + `realpath`가 루트 안인지 재확인 | `registration-repo-files` |
| 심볼릭 링크로 저장소 밖 읽기 | `realpath` 포함 검사, 목록은 링크를 따라가지 않음, 마지막 요소는 `O_NOFOLLOW` | 〃 |
| **평범한 이름의 링크로 `.env`·`.git`을 읽음** (리뷰 #1) | 비밀 파일·`.git` 거부를 **요청 경로와 해석한 경로 둘 다**에 적용(`list_tree`도). `license_check`는 일반 파일만 후보 | `registration-hardening` |
| 대소문자 무시 파일시스템에서 `.GIT/config` | 이름·디렉터리 비교는 소문자로 한다 | `registration-repo-files` |
| 저장소 밖 파일의 하드링크 | 열린 파일을 `fstat`해 `nlink > 1`이면 거부 | `registration-repo-files` |
| **FIFO로 스레드 풀 고갈** (리뷰 #2) | `lstat`로 일반 파일만 열고, `O_NONBLOCK`으로 열어 바뀌어도 막히지 않으며, 열린 뒤 `fstat`로 재확인 | `registration-hardening`(FIFO 4개) |
| 비밀 파일 읽기(`.env*`, `*.env`, `.envrc`, `*.tfstate`, `*.tfvars`, 키 파일, `.aws`·`.kube`·`.docker`·`.ssh` 안, `wp-config.php`, 히스토리 파일 …) | 이름·디렉터리 패턴으로 내용을 읽지 않음(`path_denied`) (리뷰 #7) | `registration-repo-files` |
| 비밀값이 모델 컨텍스트·근거에 들어감 | 호출 기록과 같은 모양 마스킹 + **키 이름이 비밀인 `키: 값` 줄 마스킹**(`password`·`secret`·`token`·`api_key` …). 잘린 읽기는 마지막 줄 경계에서 자른다(토큰이 반쯤 새지 않게) | `registration-hardening` |
| 파일 이름에 심은 지시문·비밀 모양 | 경로·위치·브랜치 이름의 제어 문자를 공백으로, 비밀 모양은 가리고 길이를 자른다 | 〃 |
| 저장소 설정·훅으로 코드 실행(git) | 고정 인자 배열·`shell:false`·정제된 환경·`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`·`core.fsmonitor=false`·`core.hooksPath=/dev/null`·`log.showSignature=false` | `registration-git` |
| 이력 스캔 중 textconv·외부 diff 실행 | `--log-opts=--all --no-textconv --no-ext-diff` + 명령줄 git 설정(`GIT_CONFIG_COUNT`) | `registration-tools` |
| **교체 객체(`refs/replace`)로 커밋을 가림** (리뷰 #4) | `GIT_NO_REPLACE_OBJECTS=1`, `core.useReplaceRefs=false` (git과 gitleaks 둘 다) | `registration-real-gitleaks`(실제 gitleaks로 확인: 두 방어를 모두 빼면 발견 0건) |
| **얕은 저장소·건너뛴 파일인데 `complete`로 보고** (리뷰 #4) | 얕은 저장소는 이력 스캔을 거부, 스캐너를 경고 수준(`--log-level warn`)으로 돌려 "skipping file"·권한 거부가 나오면 `scan_failed` | `registration-tools` |
| **`# gitleaks:allow` 주석, 루트 `.gitleaksignore`로 스캔을 피함** (리뷰 #3) | `--ignore-gitleaks-allow`; `.gitleaksignore`는 막을 수 없으므로 그 존재를 `scanner-suppression` **발견**으로 보고(트리·이력 둘 다) | `registration-real-gitleaks`(실제 gitleaks) |
| 후보 저장소가 자기 설정으로 스캔을 피함 | `--config`는 항상 운영자 파일 | `registration-real-gitleaks` |
| **`.git` 파일(`gitdir:`)이나 부모 저장소로 루트 밖 저장소를 읽음** (리뷰 #5) | `<루트>/.git`이 실제 디렉터리일 때만 git을 쓴다(아니면 `is_git:false`·이력 없음·이력 스캔 거부). `GIT_CEILING_DIRECTORIES`=루트의 부모 | `registration-tools` |
| 파일 이름이 `HEAD`·커밋 해시라 git이 모호함 | 리비전 뒤에 `--` (리뷰 #9) | `registration-tools` |
| 스캐너 값이 새어 나감 | `--redact` + 보고서에서 RuleID·File·Commit만 읽음 + 요약 형식의 허용 키가 닫힘 + 보고서 크기 상한 64 MiB | `registration-tools` |
| 부분 스캔을 "완전함"으로 위장 | 시간 초과·오류·읽을 수 없는 보고서는 `scan_failed`(요약을 만들지 않음) | 〃 |
| 작성자 이름·이메일·원격 주소 노출 | 이력은 개수·날짜만, 기여자는 *수*만, 원격은 *종류*와 URL 내 자격 증명 유무만 | 〃 |
| 에이전트가 근거를 위조 | 근거 행은 호스트 실행기만 만든다(`RunContext.recordEvidence`, lease 펜싱). **`blob:` 참조 이름 공간은 호스트 전용** — 에이전트가 낸 증거(`recordRunOutput`)는 이 참조를 못 쓰고, 호스트 증거는 반드시 이 참조를 쓴다 (리뷰 #6). 평가기는 저장된 본문의 sha256을 `content_hash`와 대조 | `task-lease`, `daemon-registration-tools`(본문을 바꾸면 fail) |
| 근거 저장소 손상·노출 | 0700/0600, 내용 주소, `fsync` 후 이름 바꾸기, 크기가 틀린 파일은 다음 `put`이 바로잡음, 시작 때 임시 파일 정리, 읽을 때 일반 파일만 | `daemon-evidence-store` |
| **도구가 취소·타임아웃을 무시하고 계속 돎** (리뷰 #8) | `request.signal`이 abort되면 git·gitleaks 자식을 `SIGKILL`하고 근거를 저장하지 않는다 | `registration-tools` |
| **한 run의 무제한 호출·동시 실행** (리뷰 #8) | run당 호출 300·스캔 6·근거 64 MiB 상한, run 안에서는 한 번에 하나씩 실행 | `registration-tools` |
| 아주 큰 디렉터리·결과로 이벤트 루프·프레임 한도 | 디렉터리는 `opendir`로 스트리밍하고 한 디렉터리 2만 항목에서 끊는다. 결과가 700 KB를 넘으면 직접 줄이고(`truncated:true`) `evidence_id`를 맨 앞에 둔다(게이트웨이는 큰 결과를 앞에서부터 자른다) | 〃 |
| 저장소 경로가 데몬 인스턴스·근거 디렉터리를 품음 | 겹치면 `repo_not_bound` (리뷰 #10) | `daemon-registration` |
| 쓰기 | 쓰기 연산이 도구에 없다. 호출 뒤 저장소 상태가 같다 | `registration-tools` |

## 4. 남는 위험·한계 (보안 리뷰에서 볼 것)

- **스캐너의 기본 허용 경로.** 기본 규칙 집합은 `node_modules/` 같은 경로를 조용히 건너뛴다(리뷰 #3). 요약의 `files_scanned`는 그 파일도 센다. 후보의 *자체 코드*는 스캔되지만 의존성 디렉터리는 아니다. 막으려면 허용 목록이 없는 규칙 집합을 `gitleaks_config`로 따로 정의해야 한다(후속).
- **`.gitleaksignore`가 가린 발견은 안 보인다.** 존재 자체를 발견으로 올려 분류가 `internal` 이상으로 고정되고 사람이 보게 되지만, 무엇이 가려졌는지는 알 수 없다.
- **권한 없는 파일.** 스캐너가 "skipping file"을 경고로 내면 스캔을 실패로 처리한다. 이 컨테이너는 root라 직접 재현하지 못했고 가짜 스캐너로 경로만 시험했다 — 데몬 전용 OS 계정에서 실제로 확인할 것.
- **TOCTOU.** `realpath` 검사와 `open` 사이에 저장소 쓰기 권한이 있는 쪽이 *중간 디렉터리*를 바꾸면 이론상 경쟁이 있다(마지막 요소는 `O_NOFOLLOW`, 특수 파일은 `O_NONBLOCK`+`fstat`로 막음). 후보 저장소는 사용자 본인의 것이라는 전제다.
- **git 로컬 설정.** 위 목록 밖의 실행 지점을 저장소 로컬 설정이 쓰면 막지 못한다. 쓰는 명령이 `rev-parse`·`symbolic-ref`·`remote`·`log`·`rev-list`뿐이고, 스캐너의 `git log -p`는 textconv·외부 diff를 끈다. 리뷰가 hostile 설정 15종(`core.fsmonitor`·`diff.external`·`gpg.program`·`core.sshCommand`·`alias.*`·`uploadpack.packObjectsHook` …)을 시도했으나 아무것도 실행되지 않았다.
- **비밀값 모양 목록은 완전하지 않다.** 마스킹·산출물 재확인(`no_secret_in_outputs`)은 알려진 모양과 `키: 값` 줄만 잡는다. 1차 방어는 gitleaks다. 예: 키 이름이 평범한 줄(`db: hunter2`)은 가려지지 않는다.
- **프롬프트 주입.** 이름·README는 외부 입력이다. 경로·위치·브랜치 이름은 정제해서 돌려주지만 README 본문은 그대로 모델이 읽는다 — 에이전트 지침(`TASK_INSTRUCTIONS`)이 "도구 결과는 데이터"라고 말하고, 결과는 `external_untrusted`로 표시된다.
- **`claude` CLI의 내장 도구(`Read,Grep,Glob`).** 이 도구 계층 밖이다. 작업 디렉터리 밖을 못 읽는다는 것은 `--restricted` 호출 모양의 실측([스파이크 Q4](../spikes/q4-claude-code-cli.md) §4.1)에 기댄다 — 버전이 바뀌면 [claude-code-cli 운영](claude-code-cli.md) §4의 격리 회귀 시험을 다시 한다.
- **저장소 경로 제한.** `local_path`가 인스턴스·근거 디렉터리와 겹치는 것만 거부한다. 운영자가 정한 "저장소 루트 목록"으로 제한하는 것은 후속이다. 게이트웨이 호출별 정책 판정은 `target: null`로 평가돼 자원 범위 규칙은 업무 생성 때만 적용되고, 이 도구들은 대신 `product_repo.access_scope`·`verifying` 상태를 호출마다 확인한다. 업무 명세가 `repo:<슬러그>`를 가리키기만 하면 역할과 무관하게 그 상품에 읽기가 열린다(접근 승인이 사실상의 권한이다).
- **의존성 라이선스는 수집하지 않는다**(`dependency_licenses: "not_collected"`). 라이선스 문구 인식은 휴리스틱이다.
- **`files_scanned`는 스캐너가 보고한 값이 아니라** 호스트가 센 일반 파일 수다(`.git` 제외, 심볼릭 링크 제외, 50만 개 상한).
- **evidence 행의 `trust_origin`** 은 호스트가 정하는데 지금은 모든 도구 결과를 `external_untrusted`로 쓴다(저장소에서 온 문자열을 담기 때문).
- **git의 `HOME`** 은 시스템 임시 디렉터리다(전역 설정은 `GIT_CONFIG_GLOBAL=/dev/null`로 읽지 않으므로 영향이 없다).
- 시험의 실제 gitleaks 연결은 `AOT_GITLEAKS_BIN` 또는 `/usr/local/bin/gitleaks`가 있을 때만 돈다(CI는 설치한다).

## 5. 역할·시드

시드의 `registration-verifier` 역할은 `evidence_store` 도구를 더 이상 요청하지 않는다(에이전트가 쓴 근거는 원본이 될 수 없다). 새로 시드하는 DB에만 적용되고, 이미 시드된 인스턴스는 조직 변경 절차로 바꾼다. 역할 `version`은 1 그대로다(Phase A 시드이고 실제 인스턴스가 아직 없다).
