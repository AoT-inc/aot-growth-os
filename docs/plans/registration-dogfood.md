# 상품 등록 검증 첫 실제 업무: 결정과 구현 순서 (2026-10-26)

[Phase A 종료 조건 4번](phase-a.md)("상품 등록 검증 업무를 첫 실제 업무로 수행할 수 있는 상태")을 채우는 계획이다. 업무 템플릿은 [workflows/product-registration.md](../../workflows/product-registration.md). 예시는 가상의 `example-product`만 쓴다.

## 결정 (사용자 승인 2026-10-26)

### Q22: 검증 모델과 비용
| # | 결정 |
|---|---|
| a | 검증은 `claude-code-cli`를 **도구 없이 별도 호출**로 재사용한다(세션·작업 디렉터리 비공유, 입력은 `IsolatedVerificationInput`뿐). |
| b | 실행과 검증의 **모델 별칭을 다르게** 한다: 실행은 저렴한 등급, 검증은 더 높은 등급(검증 입력이 작다). 구체 별칭은 요금제에 달려 있어 설정으로 정한다. |
| c | 검증 토큰 ≤ 업무 토큰의 **20%를 시작 상한**으로 두고 파일럿 후 조정한다. 구독이므로 USD가 아니라 `cost.tokens`로 기록한다. |
| d | 검증 호출도 같은 구독 풀을 쓴다: 실행 어댑터와 **동시 실행 한도를 공유**하고 `yield_utilization` 게이트를 적용한다. |
| e | 검증기를 쓸 수 없는 상황(한도·로그인·미룸)은 **`validating`에 두고 재시도**한다(`VerifierUnavailableError`). 모델이 판단 불가를 낸 경우만 `unclear`다. |
| f | **섀도 파일럿**: 처음 5건은 검증기 판정을 기록만 하고 사람이 결정한다. 기준은 *검증기가 supported인데 사람이 반려한 건수 = 0*, 일치율·토큰 비율도 본다. 이 파일럿으로 Q22의 "비용 대비 검출력 비교"를 닫는다. |

PC 확인 필요: `--tools ""`와 빈 MCP 설정으로 `claude -p`가 구독 로그인 상태에서 정상 동작하는지(a의 전제).

### 도구 어댑터
모두 데몬(호스트)의 게이트웨이 실행기다. 에이전트는 네트워크·마운트가 없고 `claude-code-cli`의 내장 도구는 빈 작업 디렉터리만 보므로 저장소를 읽는 유일한 길이다. 대상 경로는 에이전트가 주지 않는다(`repo:<slug>` → `product_repo.local_path`를 호스트가 해석). 결과의 `resultOrigin`은 `external_untrusted`.
- `repo_read`: `list_tree`·`read_file`·`read_metadata`는 `realpath` 포함 검사(저장소 밖 심볼릭 링크 거부), 바이너리·비밀 파일 패턴 거부, 결과 마스킹. `read_history`는 `git`을 고정 인자·정제한 환경·`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`로 실행하고 저장소 설정이 코드를 실행하지 못하게 `core.fsmonitor`·hooks를 끈다. 작성자 이름·이메일은 뺀다.
- `secret_scan`: gitleaks 8.30.1(Q21) `--redact`. **출력 필드를 허용 목록으로 걸러** `secret_scan_summary@1`만 만든다. 실행 파일은 설정 `secret_scan.gitleaks_path`(절대 경로)이며 없으면 데몬이 시작하지 않는다.
- `license_check`: 사실만 보고(라이선스 파일 이름·해시·SPDX 헤더, 매니페스트 `license` 필드). 의존성 라이선스는 1차에서 "수집 불가"로 둔다. 판단은 사람.
- `evidence_store`는 **도구에서 뺀다**(에이전트가 쓴 근거는 원본이 될 수 없다). 호스트가 위 도구의 결과를 호출 시점에 저장하고(`instance/` 아래 0600, sha256) `evidence` 행으로 만든다. 템플릿 `allowed_tools`와 시드 역할이 바뀐다.

## 구현 순서 (PR 단위)
1. **평가 쪽 (이 PR)**: `VerifierUnavailableError`, `EvidenceReader` 포트, 결정론적 검사 5개, `registration-report@1`·`secret_scan_summary@1` 형식. 가짜 시험만. → [evaluation §9](../operations/evaluation.md)
2. **도구 3개와 호스트 결과 저장**, 시드 역할·템플릿 개정, `EvidenceReader` 실제 구현. **구현됨**([운영 문서](../operations/registration-tools.md)). 보안 리뷰 대상(경로 포함 검사, `git` 실행, 외부 실행 파일, 마스킹). 구현 중 알게 된 것: 게이트웨이는 도구 이름 하나에 작업 하나라서 에이전트가 부르는 이름을 `<도구>_<작업>`으로 분리했다(`GatewayToolSpec.name`); 역할 `version`은 올리지 않고 시드를 직접 고쳤다(실제 인스턴스 없음).
3. **`claude-code-cli` 검증기**와 설정 연결(`llm_verifier.kind: "claude_code_cli"`, `model`). **구현됨**([운영 문서 §6](../operations/claude-code-cli.md)): 도구 없는 별도 호출(`--tools ""`, 빈 MCP, stdin 프롬프트), 주장별 판정을 코드가 합침, 미룬 동안 안쪽 호출 없이 `VerifierUnavailableError`를 던지는 자체 조절, 실행 어댑터와 게이트(동시 실행·사람 우선) 공유, 검증 토큰을 원장과 평가 메모에 기록, 데몬 로그 반복 억제. 구현 중 정한 것: 자리가 없으면 기다리지 않고 `busy`로 던진다(워커 tick을 붙들지 않는다); 20% 상한은 강제하지 않고 기록만 한다(파일럿에서 조정); 실패한 호출의 토큰은 원장에 남기지 않는다; 독립 리뷰(중간 3·낮음 4 수정, 한 프롬프트의 교차 출처 영향은 알려진 위험으로 문서화)를 거쳤다. **전제 확인:** `--tools ""`+빈 MCP+stdin 구조화 출력은 클라우드 컨테이너의 `claude` 2.1.310으로 확인했고, **사용자 PC 구독 로그인에서는 아직이다**([§4 5번](../operations/claude-code-cli.md)).
4. **사용자 PC 섀도 파일럿 5건** (준비 마무리 작업 목록: [handoff-pilot-prep](handoff-pilot-prep.md)), 그다음 Q22와 종료 조건 4번을 닫는다. **준비 구현됨**([절차서](../operations/shadow-pilot.md)): ① 섀도 모드(`llm_verifier.shadow`: 판정을 `shadow-verifier` 이벤트·평가 메모에 기록만 하고 결과에 반영하지 않는다) ② 사람용 `product` 명령(`add`·`start`·`status`·`evidence`·`decide`·`pilot`, 승인 소켓·사람 전용): 지금까지 SQL로만 하던 후보 등록·읽기 접근 승인·검증 업무 생성·등록/반려 결정을 채널로 옮겼다 ③ 파일럿 보고(검증기 판정↔사람 결정, 종료 기준 `supported인데 반려 = 0`). 구현 중 정한 것: 읽기 접근 승인은 `start` 명령 자체가 승인이고(`registration.read_access_granted` 이벤트; `approval` 행은 최종 등록 승인용), 등록 승인은 `status`의 `review_hash`(업무·평가·증거 해시)에 묶인다; verifying → pending_approval은 상태 조회 때 반영한다(`status`/`decide`/`pilot`); 수집 사실의 `product`/`product_repo` 반영은 후속. 독립 리뷰(중간 6·낮음 5)를 거쳐 고친 것: 승인은 평가 `pass`(안전성 포함)와 호스트 저장·검증된 증거가 있을 때만; 사람 검토 판정·평가·증거는 *가장 나중 실행* 것만(앞선 시도의 평가가 한도로 멈춘 재시도를 검토로 둔갑시키지 않게); 파일럿은 상품당 가장 나중 판정 한 건, 종료 기준은 처음 결정된 5건만이고 `supported`가 한 번도 없으면 충족이 아니다; 섀도 모드는 상품 등록 업무에만, 검증기 오류도 결과에 영향이 없다; 저장소 금지 경로에 DB·TOTP·정책 저장소·승인 소켓·run 디렉터리 포함, 같은 저장소 중복 등록 거부, `start`에서 경로 재검사; 승인 소켓의 직렬화 실패가 데몬을 죽이지 않게.

## 파일럿 1차 결과 (2026-10-27, 후보 4건, 이름은 쓰지 않는다)
| 후보 | 결과 | 원인 | 처리 |
|---|---|---|---|
| A | `inconclusive` | 에이전트가 보고서에서 인용한 호스트 근거를 구조화 출력의 `evidence`에도 다시 적어, 저장된 본문이 없는 인용 행 13건이 생겼고 `no_secret_in_outputs`가 읽지 못한 행으로 `unknown` | 같은 업무의 근거 id를 `ref`로 낸 항목은 행으로 만들지 않고(`recordRunOutput`), 검사는 저장 본문이 없는 행을 `unknown`이 아니라 참조 문자열 검사로 다룬다; 템플릿에 "evidence 배열은 비워 둔다" |
| B | `fail` | 설정 예시의 `postgresql+psycopg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@…`를 `url_credentials`로 오인(치환 문법 예외 없음) | 값 자리가 치환 문법뿐이면(`${NAME}`·`$NAME`·`<name>` 등) 비밀이 아니다 — 검사와 마스킹이 같은 규칙; 기본값·리터럴이 섞인 값은 그대로 비밀 |
| C | 평가 못 감(`needs_review`) | 토큰 합계 328,018이 한도 20만을 넘어 정상 종료한 결과가 버려짐(26턴, 도구 25회, 추정 0.32 USD / 1 USD) | 템플릿 v2 `max_tokens` 100만; run_log에 토큰 구성 |
| D | `killed` 두 번 | 6.3 GB 저장소: 트리 스캔 약 9분, 동시에 부른 이력 스캔이 대기 시간까지 제한에 들어가고 브리지 고정 10분이 먼저 걸림, 재호출로 20분 소진 | 게이트웨이 `serialGroup`(제한은 시작부터), 브리지 제한은 run 시간 제한을 따름, 템플릿 v2 `time_limit` 90분, 큰 저장소는 `scan_timeout_ms` 상향 |

종료 기준(처음 5건)은 아직 채워지지 않았다 — 위 수정 뒤 `product restart`로 다시 돌려야 한다(재검증 명령과 상태표의 `pending_approval → verifying`은 이 결과로 필요해졌다). 이 시험들이 통합 시험에서 안 드러난 이유: 시험의 에이전트는 가짜라서 구조화 출력의 `evidence`에 인용을 적지 않았고, 스캐너는 즉시 끝났고, 설정 예시 파일을 담은 저장소가 없었다. 인용 항목·치환 문법 URL·겹치는 느린 스캔을 각각 회귀 시험으로 고정했다.

## 열린 점
- 모델 별칭·비용 비율 상한의 실측값(파일럿 후).
- 의존성 라이선스 수집(후속), 금지어 목록(인스턴스 설정).
- (해결됨 3단계) 데몬 로그: 같은 업무·같은 문구의 `validation failed …`는 30분에 한 번만 찍는다.
- 실패한 검증 호출이 쓴 토큰은 원장에 남지 않는다(진단 로그뿐). 파일럿에서 비중이 크면 평가기가 없는 평가 기록 경로를 따로 둘지 정한다.
