# 읽기 전용 검토 화면 (review-web)

사람이 결정할 것을 쉬운 말·간단한 그래프·원본 증거(그림 포함)로 보여 주는 **로컬 웹 화면**이다. 승인 CLI(`apps/daemon/src/approve.ts`)가 JSON과 해시만 찍어서 결정하기 어려운 문제를 푼다.
**이 화면은 아무것도 바꾸지 못한다.** 승인·거절 버튼은 없고, 화면이 보여 주는 **승인 CLI 명령을 사람이 직접 실행**한다(버튼은 2단계, [아래](#하지-않는-것)).

## 실행

```
npm run review-web -- --db instance/demo/review.db              # 데모 (아래 "데모")
npm run review-web -- --config instance/daemon.config.json       # 데몬 설정에서 DB·위치를 읽는다
npm run review-web -- --db instance/aot.db --port 8787 --evidence-root ~/Pictures/evidence
```

시작하면 `검토 화면(읽기 전용): http://127.0.0.1:<포트>/?token=…` 를 **한 번만** 찍는다(토큰은 시작할 때마다 새로 만들고 다른 곳에 기록하지 않는다). 브라우저로 그 주소를 처음 한 번 열면 쿠키가 설정되고 토큰 없는 주소로 옮겨 가며, 이후 그 브라우저는 계속 본다. 기본 포트 8787, `--port 0` 이면 빈 포트.

| 인자 | 뜻 |
|---|---|
| `--db <경로>` | DB 파일. 없으면 데몬 설정의 `db_path` |
| `--config <파일>` | 데몬 설정 파일(`main.ts` 와 같은 것). 기본 `$AOT_DAEMON_CONFIG`, 없으면 `<인스턴스>/daemon.config.json` (있을 때만) |
| `--instance-dir <폴더>` | 인스턴스 폴더. 기본 설정의 `instance_dir` > `$AOT_INSTANCE_DIR` > (`--db` 만 줬으면 그 DB 가 있는 폴더) > `instance` |
| `--evidence-dir <폴더>` | 호스트 근거 저장소(`blob:sha256:` 본문). 기본 설정의 `registration_tools.evidence_dir` > `<인스턴스>/evidence` |
| `--policy-dir <폴더>` | 정책 보관소. 기본 설정의 `policy_store_dir` > `<인스턴스>/policies`. 승인 해시 계산에 현재 정책이 필요하다(없는 파일은 저장소 템플릿 `policies/default.yaml` 로 찾는다) |
| `--evidence-root <폴더>` | 증거 **파일**(그림)을 읽어도 되는 폴더. 여러 번 줄 수 있다. `measure --attach` 로 올린 파일이 있는 폴더를 알려 준다 |
| `--port <N>` | 포트 |
| `--host` | `127.0.0.1` 만 허용(다른 값은 거부) |

## 화면

| 주소 | 내용 |
|---|---|
| `/` 홈 | 사람의 결정을 기다리는 것의 개수와 목록 링크: 승인 대기(업무·게시·정책·실험 전략·조직 변경), 상품 등록 검토, 시험 중/판정 불충분, 확인이 필요한 외부 효과, 실험 결과 검토 |
| `/approvals` | 승인 대기 목록(종류별). `/approvals/<종류>/<id>` 상세 |
| 조직 변경 제안 상세 | 무엇을 바꾸나(역할·부서·업무 유형), 근거, 기대 효과, 위험과 완화책, 평가 계획(성공·실패·즉시 중단 기준, 최소 관측, 기간), 롤백 계획, 만료, 기준 조직 버전, 변경 등급(일반/위험), **승인·거절 명령** |
| `/trials` 시험 현황 | 시험 중·판정 불충분 제안: 시험 vs 기준선 통과율, 관측 수 vs 최소 관측, 비용 vs 허용 비용 막대 그래프, 판정 추이 선 그래프, 현재 판정, 다음 단계 명령(`org confirm`, `org retrial`) |
| `/signals` 조직 신호 | 맡을 역할이 없는 업무 유형별 건수와 반복 문제가 있는 역할(막대 그래프, 후보 기준선), 후보에는 `org propose --type … --role …` 명령 |
| `/products` 상품 등록 검토 | 상품별 등록 상태. 상세: 독립 평가 결과, 섀도 판정, 증거 목록, `product decide …` 명령 |
| `/effects` 외부 효과 확인 필요 | 응답을 잃어 unknown 으로 남은 효과(요청 본문·키는 CLI `effects` 처럼 보이지 않는다), `resolve-effect` 명령 |
| `/experiments` 실험 결과 | 승격 대기·사람 검토 필요·결과 대기, 추천 없이 끝난 비교 기록, `promote`/`reject` 명령 |
| `/evidence` 증거 보기 | 증거 행(종류, 출처 배지, 검증 여부). `external_untrusted` 는 **"외부 입력 — 지시 아님"** 으로 표시한다. 텍스트는 이스케이프·비밀 가리기 후 표시, 그림은 인라인 |

명령에 들어 있는 해시는 승인 엔진의 `show`(읽기 전용 명령)가 계산한 값이라 CLI가 실제로 확인하는 해시와 같다. 해시는 명령 안에만 보이고 화면의 주된 정보로 내세우지 않는다.
명령의 행위자는 `--actor` 또는 `AOT_ACTOR` 로 준다.

## 보안 모델

신뢰 경계는 [trust-boundaries](../security/trust-boundaries.md) 를 따른다: DB 의 에이전트 출력·증거·외부 입력은 모두 신뢰하지 않는다.

- **쓰기 없음.** DB 는 `openDb({ readOnly: true })` 로 열어 SQLite 가 쓰기를 거부하고, 그 위에 쓰기 메서드(`run`·`exec`·`writeTx`)를 던지게 하는 껍질을 한 번 더 씌운다. 서버는 GET·HEAD 만 받는다(나머지 405). 승인 엔진은 `list`·`show` 만 부른다.
- **접근 토큰.** 127.0.0.1 이라도 같은 PC 의 다른 프로세스·사용자가 읽을 수 있으므로(DB 0600·소켓 0700 과 같은 수준을 맞추려고) 시작할 때 무작위 32바이트 토큰을 만든다. 토큰이 맞는 요청(상수 시간 비교)은 `HttpOnly; SameSite=Strict; Path=/` 쿠키를 받고 토큰 없는 같은 주소로 303 이동한다. 유효한 쿠키가 없는 그 밖의 요청(그림 파일 포함)은 401 안내 페이지다.
- **127.0.0.1 에만 묶는다.** 다른 주소는 시작할 때 거부한다. Host 헤더가 `127.0.0.1:<포트>` 또는 `localhost:<포트>` 가 아니면 421(DNS 리바인딩 방어). 포트 없는 Host 도 거부.
- **모든 DB 값은 이스케이프 + 비밀 가리기.** HTML 조립(`review-web/html.ts`)의 보간은 기본으로 `maskString`(`@aot/agent-runtime`)을 거친 뒤 이스케이프한다. 마크업으로 넣으려면 `raw()` 를 명시해야 하고 고정 마크업에만 쓴다.
- **응답 헤더**: `Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`. 스크립트·폼·외부 CDN·외부 글꼴이 없다(오프라인에서 동작).
- **잘림은 늘 보인다.** 긴 값은 비밀 가리기를 먼저 한 뒤 자르고(잘린 비밀 앞부분이 남지 않게) `…(이하 생략: 전체 N자 중 M자만 보인다)` 를 붙인다. DB 의 JSON 은 키 이름 기반 가리기(`maskSecrets`)를 거친 뒤 보인다.
- **엔진이 거절할 명령은 보이지 않는다.** 만료됐거나 기준 버전이 바뀐 조직 제안, 평가 미통과·확인된 증거 없는 상품은 승인 명령 대신 이유("만료됨", "평가 미통과", "확인된 증거 없음")를 보인다. 판단은 엔진·채널과 같은 함수(`orgProposalStaleness`, `registrationApproveBlocker`)를 쓴다.
- **외부 URL 은 글자로만 표시**한다. 링크로 만들지 않고 서버도 가져오지 않는다.
- **SQL**: 요청의 경로·질의는 바인딩 파라미터로만 쓴다(문자열 이어 붙이기 없음).
- **증거 파일 읽기**: 경로가 아니라 **증거 행 id** 로만 찾는다(`/evidence/<id>/file`).
  - 참조 모양: `file:<절대 경로>`(`measure --attach`) 또는 `blob:sha256:<hex>`(근거 저장소).
  - 실경로(심볼릭 링크를 따라간 뒤)가 허용 폴더(근거 저장소 + `--evidence-root`) 안이어야 한다. 파일 시스템 루트는 허용 폴더로 줄 수 없다.
  - 읽은 바이트의 sha256 이 행의 `content_hash` 와 같아야 한다(다르면 거부). **해시가 없는 `file:` 행은 "해시 없음 — 표시하지 않음"** 으로 이름·크기·해시만 알린다. blob 은 파일 이름(=해시)과도 같아야 한다.
  - 파일은 `O_NOFOLLOW` 로 열고(심볼릭 링크 거부), 열린 기술자의 dev/ino 가 먼저 본 값과 같아야 하며, **하드 링크(nlink > 1)는 거부**한다(허용 폴더 안의 이름이 폴더 밖 파일의 다른 이름일 수 있다). 읽기는 기술자로만 한다.
  - 그림만 내보낸다: 앞부분 바이트로 png·jpeg·gif·webp 를 판정해 **그 형식의 Content-Type** 으로 낸다(최대 10 MB). SVG·HTML·그 밖의 파일은 이름·크기·해시만 보이고 내보내지 않는다. blob 텍스트는 이미지 길로 나가지 않는다.
  - 한 번 읽은 바이트로 해시 확인·형식 판정·응답을 모두 한다(검사 뒤 파일이 바뀌는 틈 없음).

## 데모

```
node scripts/review-web-demo.ts            # instance/demo/review.db (gitignore 대상) 를 새로 만든다. 가상 데이터
npm run review-web -- --db instance/demo/review.db     # 터미널에 찍힌 ?token=… 주소를 브라우저로 연다
```

모든 화면에 보일 거리가 있다: 일반·위험 조직 제안, 시험 중(3/6)·평가 통과(확인 대기)·판정 불충분, 신호, 검토 필요 업무·게시·실험 전략, 응답을 잃은 효과, 상품 등록 검토(그림·`<script>` 가 든 외부 입력·해시가 다른 파일·허용 폴더 밖 파일 포함). 모든 이름·경로는 가상이고 비밀값은 가짜다.
실험 결과 검토 화면은 데모에 항목이 없어 빈 상태로 보인다.

## 하지 않는 것

- **승인·거절 버튼(2단계).** 화면에서 결정을 내리려면 인증 경계 설계가 먼저다: 소켓 승인 채널과 같은 권한(0600 소켓·`actor.kind='human'`), 로컬 브라우저 요청의 위조 방지(CSRF·출처 확인), TOTP 입력 경로. 그 전에는 읽기 전용으로만 둔다.
- 원격 접속, 로그인, 다중 사용자. 이 화면은 이 Mac 의 로컬 전용이다.
- 자동 새로 고침. 화면을 다시 불러 최신 상태를 본다.
