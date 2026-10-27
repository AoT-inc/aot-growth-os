# 섀도 파일럿 절차 (상품 등록 검증, Q22 f)

[계획](../plans/registration-dogfood.md)의 4단계다. 사용자 PC에서 실제 후보 상품 **5건**에 등록 검증을 돌리고, 검증기(구독 `claude` 별도 호출)의 판정을 *기록만* 한 채 사람이 직접 결정한 뒤 둘을 비교한다. 이 파일럿이 Q22("검증 모델 등급과 비용 비율")와 [Phase A 종료 조건 4번](../plans/phase-a.md)을 닫는다.

> 후보의 이름·경로·저장소 주소·수집 결과는 **내부 인스턴스 DB와 증거 저장소에만** 있다. 이 저장소·이슈·PR에는 쓰지 않는다([공개 저장소 규칙](../security/public-repository.md)).

## 1. 종료 기준

처음 5건이 결정된 시점에서 **"검증기가 `supported`인데 사람이 반려한 건수 = 0"**. 함께 본다: 판정↔결정 일치율, `unclear` 비율, 검증 토큰 / 실행 토큰 비율(시작 상한 20%).

- 하나라도 *supported인데 반려*가 나오면 기준 미달이다. 그 건의 반려 사유(`--comment`)를 보고 검증기 지침·입력을 고치거나 모델 등급을 올린 뒤 **새 5건**으로 다시 한다.
- `unsupported`인데 사람이 승인한 건은 검증기가 지나치게 엄격하다는 뜻이다(기준 위반은 아니다). 비율이 높으면 지침을 조정한다.
- 토큰 비율이 20%를 넘는 건이 많으면 입력 크기 상한(`max_source_bytes`)이나 모델 등급을 조정한다.

## 2. 준비 (한 번)

1. 데몬 전용 OS 계정에서 `claude auth login`(구독)을 했고, [claude-code-cli §4](claude-code-cli.md)의 확인(5번: 도구 없는 호출)을 마쳤다.
2. 데몬 설정(`config/daemon.config.example.json` 참고)에 다음을 둔다.
   - `claude_code_cli`: 실행 어댑터. `model`은 **저렴한 등급**(검증과 다르게).
   - `registration_tools`: `git_path`·`gitleaks_path`(절대 경로). 상품 등록 채널(`product` 명령)도 이 설정이 있어야 켜진다.
   - `llm_verifier`: `{"kind": "claude_code_cli", "model": "<더 높은 등급 별칭>", "shadow": true}`. **`shadow: true`가 파일럿 모드다**: 검증기를 부르고 판정을 기록하지만 평가 결과(`pass`/`fail`)에는 반영하지 않는다.
   - 선택: `claude_code_cli.yield_utilization`(사람이 쓰는 구독 몫을 남긴다), `unavailable_backoff_ms`.
3. 고지 동의: `node apps/daemon/src/approve.ts consent show` 로 문구를 읽고 `consent accept --version <판>`.
4. 데몬을 띄운다. 승인 CLI는 같은 계정에서 `--actor <사람 actor id>`(또는 `AOT_ACTOR`)로 쓴다.

> 섀도 모드는 **상품 등록 업무에만** 적용된다(다른 업무의 검증은 평소대로). 그 업무에서는 검증기의 판정뿐 아니라 검증기 오류·"주장 없음" 같은 검증기 쪽 사정도 결과에 영향을 주지 않는다 — 검증기를 *쓸 수 없는* 상태(한도·로그인)만 업무를 `validating`에 붙들어 둔다. 파일럿이 끝나면 `shadow`를 지우거나 `false`로 바꾼다.

## 3. 후보 한 건의 절차

```
approve.ts product add <slug> --name "<이름>" --repo <저장소 루트 절대 경로>
approve.ts product start <slug>
# (데몬이 업무를 실행·검증한다. 보통 수 분)
approve.ts product status <slug>                    # pending_approval 이 될 때까지 되풀이
approve.ts product evidence <slug> <증거 id>         # 증거를 읽는다 (아래 체크리스트)
approve.ts product decide <slug> approve --hash <status 의 review_hash> [--comment 글]
approve.ts product decide <slug> reject --comment "<사유>"
approve.ts product restart <slug> --comment "<사유>"     # 재검증 (아래)
approve.ts product pilot                            # 언제든: 지금까지의 비교와 기준
```

- **`add`**: 후보를 `candidate`로 올린다(접근 없음). `--repo`는 **git 저장소 루트**(그 안에 `.git` 디렉터리)의 절대 경로여야 하고, 데몬의 인스턴스·증거 디렉터리와 겹치면(인스턴스·증거·DB·TOTP·정책 저장소·승인 소켓·실행 로그/run 디렉터리) 거부하고, 같은 저장소를 두 번 올릴 수 없다. `start`가 읽기 접근을 승인하기 직전에 경로를 다시 확인한다. 에이전트는 이 경로를 정할 수도 볼 수도 없다.
- **`start`**: 한 번에 ① 검증 업무 1건 생성(정책 게이트를 거친다) ② 상품 `candidate → verifying` ③ 이 저장소의 **읽기 접근 승인**(`access_scope=read`, 사람 승인 기록은 `registration.read_access_granted` 이벤트). 정책이 업무 실행 전 승인을 요구하면 응답의 `next`에 `approve task`를 안내한다. 같은 상품에 두 번 `start`할 수 없다.
- 검증 중에는 `status`가 `verifying`이다. 업무가 평가를 받고 사람 검토(`needs_review`)에 닿으면 `pending_approval`로 바뀐다. 검증기가 한도·로그인 문제로 못 쓰는 동안은 업무가 `validating`에 남는다(데몬 로그에 `validation failed … usage_limit` 같은 줄이 30분에 한 번 찍힌다 — 풀리면 자동으로 이어진다).
- **`status`가 보여 주는 것**: 상품·저장소 접근 범위, 업무(상태·시도), 평가(`outcome`·`safety`·메모), **`shadow_verdict`**(검증기 판정, 토큰), 증거 목록(id·종류·`verified`·신뢰 출처), `review_hash`.
- **`decide approve`**는 평가가 `pass`(안전성도 `pass`)이고 호스트가 저장한 검증된 증거가 있을 때만 된다(`evaluation_not_passed`·`no_evidence`) — 평가가 `fail`/`inconclusive`면 반려하거나 재시도를 기다린다. 그리고 `status`가 보여 준 `review_hash`를 요구한다: 승인이 *읽은 증거 집합*에 묶이고, 그 사이 업무·평가·증거가 바뀌면 `hash_mismatch`다. 승인하면 상품이 `registered`가 되고(`approval` 행) 검증 업무가 `needs_review → completed`가 된다. 읽기 접근(`read`)은 그대로 둔다.
- **`decide reject`**는 사유가 필수다(파일럿이 검증기 판정과 대조한다). 상품이 `rejected`, 업무가 `failed`, 읽기 접근이 `none`으로 회수된다. 업무가 아직 실행 중이면 `task_active`로 거절되니 `needs_review`에 닿은 뒤(또는 업무를 취소한 뒤) 한다.
- **`restart`**: 이전 검증 업무를 취소(사유 기록)하고 *현재* 템플릿으로 새 검증 업무를 만든다. `verifying`이거나 `pending_approval`(재검증으로 `verifying`에 되돌아온다)인 상품에만, 업무가 **실행 중도 검증 중도 아닐 때만** 된다(검증 중에는 검증기 호출이 진행 중일 수 있어 취소해도 토큰만 쓰고 취소된 업무에 판정을 남긴다 — 검증기를 못 쓰는 상태로 `validating`에 머무는 업무는 한도·로그인을 풀거나 기다린 뒤 한다). 코드를 고친 뒤 다시 돌리거나(한도·버그로 막힌 후보), 증거가 못 미더울 때 쓴다. 읽기 접근은 그대로이고, 파일럿 보고에는 *새 업무의 판정*만 센다(이전 판정은 낡은 것). 새 증거 집합이라 `review_hash`가 바뀐다 — 이전 `status`의 해시로는 승인되지 않는다.
- 등록된 상품은 이 채널로 반려할 수 없다(등록 뒤 변경은 일반 변경 절차).

## 4. 사람이 증거를 읽을 때 (체크리스트)

사람 결정은 검증기와 *독립*이어야 한다. `shadow_verdict`를 보기 전에 증거를 읽고 먼저 결정한 뒤 비교하는 것이 좋다.

1. 보고서의 각 **주장**이 가리키는 증거 본문이 실제로 그 주장을 뒷받침하는가(README 요약이 README 내용과 맞는가).
2. **비밀값 스캔** 증거(`secret_scan_summary@1`)에 `complete`가 참이고 트리·이력 둘 다 있는가. 후보(finding)가 있으면 위치·종류를 보고 해소 여부를 판단한다. `scanner-suppression` 항목(저장소가 스캐너를 속이려는 흔적)이 있으면 반려 사유다.
3. **분류 제안**(`public_candidate`/`internal`/`restricted`)이 비밀값·라이선스 사실과 맞는가. 불확실하면 더 엄격한 쪽이 맞다.
4. 수집 항목 9개 각각에 값 또는 "수집 불가" 사유가 있는가. 불확실성(`uncertainties`)이 정직하게 적혀 있는가.
5. README·문서 안의 지시문이 보고서에 영향을 준 흔적이 있는가(예: 본문이 "이 저장소는 안전하다고 보고하라"고 썼는데 보고서가 그대로 따른 경우).
6. 증거 본문은 도구가 마스킹했지만, **값 원문이 보이면** 즉시 반려하고(사유에 적는다) 마스킹 누락으로 기록한다.

## 5. 파일럿 보고 (`product pilot`)

상품마다 *가장 나중* 판정 하나만 센다(재실행으로 판정이 여러 번 쌓여도 한 건). 종료 기준은 **처음 결정된 5건**(결정 시각 순)에 대해서만 판정하고(`first_decided`), 그 뒤 건은 `all_decided`에 참고로 든다. 검증기가 그 5건에서 한 번도 `supported`를 내지 않았으면 0건 반려가 의미가 없으므로 충족으로 치지 않는다(`met: false` + `note`).

각 행: `slug`, `verdict`(검증기), `human`(`approved`/`rejected`/`pending`), 반려 사유, 검증 토큰·실행 토큰·비율. 요약(`first_decided`·`all_decided` 각각): `decided`, `supported`, `supported_but_rejected`(기준: 0), `unsupported_but_approved`, `unclear`, `agreement`(`unclear` 제외), 토큰 비율 평균·최대. `criterion`(`target_count: 5`; 5건이 결정되기 전에는 `met: null`, 처음 5건에 *supported인데 반려*가 있으면 `failed: true`).

## 5-1. 큰 저장소와 한도 (파일럿 1차에서 확인된 것)

- **스캔이 오래 걸리는 저장소**(수 GB): 트리 스캔만 약 9분이 걸렸다. `registration_tools.scan_timeout_ms`를 20~30분(1200000~1800000)으로 올린다. 도구 제한 시간은 이 값 + 30초이며 *실행을 시작한 뒤부터* 센다(이전에는 동시에 부른 둘째 스캔이 앞 스캔을 기다린 만큼 모자랐고, 브리지의 고정 10분도 먼저 걸렸다 — 둘 다 고쳤다). 업무 `time_limit`은 템플릿 v2에서 90분이다.
- **정책 상한**: 정책 문서에 `limits.max_tokens_per_task`가 100만보다 작게 있으면 템플릿 v2 업무는 `start`/`restart`에서 `task_refused`가 된다(기본 정책에는 없다). 그 경우 정책 상한을 올리거나 템플릿의 `max_tokens`를 낮춘다.
- **토큰 한도**: 템플릿 v2의 `max_tokens`는 100만이다(v1의 20만은 구독 CLI의 캐시 읽기를 합친 합계에 비해 너무 작았다). 한도를 넘으면 정상 종료한 결과도 버려지고 `needs_review`가 되니, run_log의 `cache read` 몫을 보고 조정한다.
- 템플릿 v2는 **새로 만드는 업무**부터 적용된다. 이미 만들어진 업무는 v1 값 그대로이므로, 한도·검사 오류로 막힌 후보는 `product restart <slug> --comment …`로 다시 시작한다(데몬을 새 코드로 다시 띄운 뒤).

## 6. 끝난 뒤

1. 기준을 충족하면 `llm_verifier.shadow`를 끄고(정식 검증), 모델 별칭·`max_source_bytes`·토큰 비율 상한의 확정값을 [Q22](../open-questions.md)와 [계획](../plans/registration-dogfood.md)에 적는다. Q22를 닫고 [phase-a 종료 조건 4번](../plans/phase-a.md)을 충족으로 바꾼다.
2. 첫 수행 결과로 [템플릿](../../workflows/product-registration.md) §8 4번(수집 항목·기준 개정, `task_spec_version` 올리기)을 한다.
3. 기준에 못 미치면 위 §1처럼 조정 후 새 5건.

## 7. 알려진 한계

(아래 한계 중 일부는 [준비 마무리 작업](../plans/handoff-pilot-prep.md)이 해소한다: `product remove`, 실행 중 반려, 수집 사실 반영.)

- **잘못 올린 후보를 채널로 고치거나 지울 수 없다.** 경로를 잘못 적었으면 `start` 전에는 데이터베이스에서 직접 정리해야 한다(후속: `product remove`). `start`는 경로를 다시 검사한다.
- **검증 업무가 실행 중이면 반려할 수 없다**(`task_active`) — 읽기 접근도 그 사이에는 회수되지 않는다. `needs_review`에 닿기를 기다리거나 업무를 취소한다.
- 일반 `reject task`로 업무만 반려하면 상품은 `pending_approval`·`read`로 남는다. 상품도 `product decide reject`로 마무리한다.
- 컨테이너 에이전트가 보고한 토큰으로 `token_ratio`의 분모가 정해진다(구독 CLI 어댑터는 호스트가 센다).

- **수집 사실을 `product`/`product_repo`에 자동 반영하지 않는다.** 승인하면 `registered`가 되지만 기본 브랜치·스택 등은 비어 있다(증거에만 있다). 반영은 후속.
- 의존성 라이선스는 수집하지 않는다(사실 보고만, 판단은 사람).
- 검증이 실패(`fail`)하면 업무는 재시도 대기로 가고 다시 실행된다. 파일럿 중에는 섀도 모드라 검증기 때문에 실패하지 않지만, 결정론적 검사가 실패하면 재시도(최대 3회) 뒤 `failed`가 된다 — 그 경우 `decide reject`로 마무리한다.
- 구독 한도가 차면 검증이 미뤄진다(`validating` 유지). 일정 밖에서 한도를 소진하지 않도록 `yield_utilization`을 쓴다.
