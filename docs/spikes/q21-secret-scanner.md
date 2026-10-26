# 스파이크 Q21: 비밀값 스캐너

상태: 완료 (2026-10-19) · 관련: [open-questions Q21](../open-questions.md), [상품 등록 절차 §5](../../workflows/product-registration.md), [공개 저장소 규칙](../security/public-repository.md), [phase-a §4](../plans/phase-a.md)

## 결론

**gitleaks 8.30.1**(MIT)을 쓴다. 작업 트리와 이력을 모두 스캔하고, `--redact`로 출력과 보고서에 값 원문이 남지 않으며, 사용자 정의 규칙으로 누락 항목(접속 URL 비밀번호)과 금지어(홈 경로 패턴)까지 같은 도구로 덮을 수 있었다. 등록 검증 업무와 CI·커밋 전 검사가 같은 실행 파일을 쓴다.

## 판정 방법 (시험 전에 고정)

[open-questions](../open-questions.md): "가상 비밀값이 심긴 샘플로 탐지율·오탐·출력 안전성 비교". 요구 조건은 작업 트리·이력 스캔, 값 원문을 출력하지 않는 모드, 등록 검증 업무와 CI 공용.

시험 샘플은 임시 git 저장소다. 값은 무작위로 만든 **가짜**(형식만 실제 서비스 키와 비슷함)이며 저장소와 이 문서에는 싣지 않는다.

| 구분 | 내용 |
|---|---|
| 심은 것 (작업 트리) | 12개 위치: 클라우드 접근 키+비밀 키, 코드 호스팅 토큰, 메신저 봇 토큰, 결제 키, 개인 키 블록(PEM 형태), LLM API 키 2종, 지도 API 키, `.env`의 고엔트로피 값, DB 접속 URL의 비밀번호, JWT, 패키지 레지스트리 토큰 |
| 심은 것 (이력만) | 3개 위치: 첫 커밋에 토큰·클라우드 키를 넣고 다음 커밋에서 파일을 삭제 (작업 트리에는 없음) |
| 오탐 유도 | 6개 파일: `YOUR_API_KEY_HERE`·`${…}`·`process.env.…`·마스킹 값(`****`), 스키마의 `password`/`api_key` 필드명, 공개 문서에 나오는 예시 클라우드 키, 빈 값 `.env.example`, SHA-256·커밋 해시·UUID, 잠금 파일 무결성 해시, 작은 이미지 data URI, 한국어 문장 "비밀번호는 … 보관한다" |

채점은 (파일, 줄) 위치 단위다. 출력 안전성은 심은 값 전체, 또는 앞 14자·뒤 14자가 도구 출력(표준 출력, 보고서 파일)에 나타나는지로 검사했다.

## 후보와 결과

| 후보 | 버전 | 작업 트리 | 이력만 | 오탐(6파일) | 출력에 원문 | 이력 스캔 | 라이선스 |
|---|---|---|---|---|---|---|---|
| gitleaks | 8.30.1 | 11/12 (누락: DB URL 비밀번호) | 3/3 | 0 | `--redact` 시 없음. 없이 실행하면 12/12가 JSON에 원문 | 지원 (`gitleaks git`) | MIT |
| trufflehog | 3.99.2 | 8/12 | 2/3 | 0 | **항상 원문 출력** (JSON `Raw`, 텍스트 `Raw result`). 마스킹 옵션 없음 | 지원 (`trufflehog git`) | AGPL-3.0 |
| detect-secrets | 1.5.0 | 10/12 | 해당 없음 (이력 스캔 미지원) | 1 (공개 예시 클라우드 키) | 없음 (SHA-1 해시만 기록) | 미지원 | Apache-2.0 |
| secretlint | 13.0.7 | 8/12 | 해당 없음 (파일만 스캔) | 0 | JSON 형식은 `sourceContent`에 **파일 전체 내용** 포함. `stylish`·`compact`·`checkstyle` + `--maskSecrets`는 없음 | 미지원 | MIT |

- trufflehog 8/12는 `--no-verification`으로 실행한 결과다. 기본값은 후보 값을 해당 서비스에 보내 검증하므로(네트워크 송신) 검증 기능은 시험하지 않았다. 저장소 디렉터리를 `filesystem` 모드로 읽으면 `.git` 객체의 내용도 보고했다(제외 패턴을 시도했으나 적용을 확인하지 못했다). `git` 모드는 정상이었다.
- 이 수치는 이 샘플에 한정된 값이다(작은 표본, 위치 단위 채점). 도구의 일반적 우열 결론이 아니다.
- 미시험: ggshield(외부 서비스 계정·API 키가 필요하고 값이 서비스로 전송되므로 공개 저장소 규칙과 맞지 않아 제외), git-secrets, Nosey Parker, 코드 호스팅의 푸시 보호(서비스 기능이라 로컬 도구 비교 대상이 아님).

## 실행 기록

```
$ gitleaks dir fixture -r out/tree.json -f json --redact --no-banner -l warn --exit-code 3
WRN leaks found: 12                                  # 종료 코드 3. 표준 출력에 값 없음
$ gitleaks git fixture -r out/history.json -f json --redact --no-banner -l warn --exit-code 3
  이력 전용 3건 모두 첫 커밋에서 검출 (삭제된 파일 src/old.ts, docs/old-setup.md)
$ gitleaks git --pre-commit --staged --redact --no-banner -l warn .      # 스테이징된 가짜 토큰 1건
WRN leaks found: 1                                   # 종료 코드 1 (커밋 전 검사로 사용 가능)
```

`--redact` 보고서의 `Secret`·`Match`는 `REDACTED`로 나온다. 보고서에는 규칙 ID, 파일, 줄, 커밋, `Fingerprint`와 함께 커밋 작성자·이메일·메시지 필드도 들어 있으므로, 등록 검증 업무에서는 [product-registration §5](../../workflows/product-registration.md)의 "위치·종류·개수만 저장" 원칙에 따라 래퍼가 필요한 필드만 남기는 것을 권한다(작성자 정보는 `evidence`에 저장하지 않는다).

## 누락·금지어는 사용자 규칙으로 보완

기본 규칙에 DB 접속 URL의 비밀번호는 없었다. 아래 설정으로 같은 샘플에서 12/12가 되었다. 금지어(예: 사용자 홈 경로 패턴, 내부 제품명)도 같은 방식의 규칙으로 잡혔고, 출력은 역시 마스킹되었다. [공개 저장소 규칙](../security/public-repository.md)대로 금지어 목록은 저장소 밖에 두고 `--config`로 경로를 넘긴다.

```toml
title = "spike config"
[extend]
useDefault = true

[[rules]]
id = "db-url-password"
description = "Credentials embedded in a connection URL"
regex = '''(?i)[a-z][a-z0-9+.-]*://[^\s:/@]+:([^\s:/@]{6,})@'''
secretGroup = 1
keywords = ["://"]

# 금지어 규칙은 같은 형식으로 추가한다 (정규식은 인스턴스별 설정 파일에만 둔다)
```

## 선택 이유

- 세 조건(작업 트리·이력 스캔, 원문 비출력, 업무·CI 공용)을 하나의 실행 파일로 만족한 후보는 gitleaks뿐이다. trufflehog는 원문 출력을 끌 수 없어 에이전트 컨텍스트와 로그로 값이 흘러 들어갈 수 있다([trust-boundaries](../security/trust-boundaries.md) §3). detect-secrets는 이력을 보지 못하고, secretlint는 이력 스캔이 없고 JSON 출력이 파일 내용을 담는다.
- 탐지율이 가장 높고 오탐이 0건이었다. 전체 이력 스캔이 0.1초 안에 끝났다(작은 샘플).
- 단일 실행 파일이라 Node 의존성이 없다.

## A0에 반영할 것

- CI와 커밋 전 훅: `gitleaks dir` 또는 `git` + 커밋 전 `git --pre-commit --staged`. 항상 `--redact`. 보고서 파일은 산출물에 올리지 않거나 `.gitignore`에 둔다.
- 공개 전 이력 검사([공개 저장소 규칙](../security/public-repository.md) 3번)는 `gitleaks git`로 한다.
- 등록 검증 업무의 `secret_scan` 도구 어댑터: `scan_tree` = `dir`, `scan_history` = `git`. 어댑터가 `--redact`를 고정하고, 결과를 위치·규칙·개수로 줄인 뒤 반환한다. 출력 재스캔(결정론 검증 1단계)에도 같은 바이너리를 쓴다.
- 바이너리 버전은 고정하고 릴리스 체크섬을 확인해 설치한다. 시험은 로컬에 설치된 8.30.1로 했으며, CI 설치 방법(릴리스 내려받기 vs 패키지)은 A0에서 정한다.
- 오탐 허용 목록(`.gitleaksignore` 또는 allowlist)은 항목마다 이유를 남긴다. 이번 샘플에서는 필요하지 않았다.

## 사용 버전

gitleaks 8.30.1, trufflehog 3.99.2 (릴리스 체크섬 확인), detect-secrets 1.5.0 (Python 3.10 가상 환경), secretlint 13.0.7 + `@secretlint/secretlint-rule-preset-recommend` 13.0.7. macOS arm64.
