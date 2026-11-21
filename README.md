# AoT Growth OS

조직·업무·기억·평가·전략을 코드로 운영하는 AI-native 기업 운영체계.

사람은 목표와 제약을 정하고, 시스템은 이벤트와 루틴에 따라 업무를 만들고 실행하며, 검증된 결과를 다음 의사결정에 반영한다. 핵심은 에이전트가 아니라 **에이전트가 무엇을 해야 하는지 결정하고, 결과를 검증하고, 그 결과를 되먹임하는 운영 계층**이다.

## 현재 상태: Phase A(A0~A6) 구현, Phase B 설계 중

[Phase A](docs/plans/phase-a.md)의 A0~A6을 구현했다. 5개 패키지와 데몬이 동작하며, 주간 사이클 1~7단계(루틴 → 조사 → 검증 → 실험 후보 → 비교 → 사람 승인 → 결과 기록)가 가짜 어댑터로 끝까지 실행되고, 읽기 전용 조사 에이전트(컨테이너)로 1~3단계를 실제로 실행한다. 업무 상태 머신·lease·부작용 멱등성·정책 판정과 승인 채널·독립 평가와 비용 원장·도구 게이트웨이와 컨테이너 격리·팩 로더가 들어 있고, 단위·통합(다중 프로세스, Docker)·경계 시험이 CI에서 돈다.

남은 것: Phase A 종료 조건 중 상품 등록 업무 수행 준비는 미충족이고(검증 모델 Q22와 저장소 읽기·비밀값 스캐너 도구 어댑터가 없다), 실제 외부 부작용 어댑터도 아직 없다. 단계별 완료 기록·편차·열린 항목은 [phase-a.md](docs/plans/phase-a.md)와 [A6 인계](docs/plans/handoff-after-a6.md)가 정본이다. 다음 단계인 적응형 조직(Phase B)은 [phase-b.md](docs/plans/phase-b.md)에서 설계 중이다.

| 문서 | 내용 |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | 정체성, 자체 개발 범위 vs 재사용, 아키텍처, MVP |
| [docs/glossary.md](docs/glossary.md) | 용어집 (한/영 대응, 정의, 금지 용법) |
| [docs/adr/](docs/adr/README.md) | 아키텍처 결정 기록 (ADR 0001–0012) |
| [docs/schema/](docs/schema/README.md) | 데이터 모델 초안 (`schema.sql`, 상태 전이, 업무 명세) |
| [docs/products/](docs/products/README.md) | 상품 등록 절차 (앱·데몬 구동 후 검증·승인으로 등록) |
| [workflows/product-registration.md](workflows/product-registration.md) | 상품 등록 검증 업무 템플릿 (`task_spec`, 읽기 전용 수집, 비밀값 스캔, 3단계 검증) |
| [docs/plans/phase-a.md](docs/plans/phase-a.md) | Phase A 구현 계획과 A1~A6 완료 기록 (단계별 구현·편차·열린 항목, 종료 조건 충족 현황) |
| [docs/plans/phase-b.md](docs/plans/phase-b.md) | Phase B(적응형 조직) 설계 — 단계 분할, ADR-0011과 구현의 연결점·빈틈, 선행 조건 |
| [docs/plans/a0-decisions.md](docs/plans/a0-decisions.md) | A0 착수 전 사람 결정 (런타임, 시드 조직, 측정 신호, 승인자, 승인 채널, 라이선스, 확장 단위) |
| [docs/security/public-repository.md](docs/security/public-repository.md) | 공개 저장소에 두는 것과 두지 않는 것 |
| [docs/operations/](docs/operations/recovery.md) | 복구·중복 방지([recovery](docs/operations/recovery.md)), 평가 운영([evaluation](docs/operations/evaluation.md)) |
| [docs/security/trust-boundaries.md](docs/security/trust-boundaries.md) | 신뢰 경계와 위협 시나리오 |
| [docs/open-questions.md](docs/open-questions.md) | 미결정 사항과 결정 기한 |

> 공개 저장소다. 실제 제품명·경로·비밀값·인스턴스 데이터는 두지 않는다. [규칙](docs/security/public-repository.md)

## 설계 원칙 (요약)

1. 장기 세션을 기억으로 쓰지 않는다. 모든 중요한 상태는 영속 저장소에 둔다.
2. 에이전트는 정책을 바꾸지 못한다. 정책은 별도 승인·배포 경로를 가진다.
3. 완료는 에이전트의 자기 보고가 아니라 시스템의 검증 결과로 결정한다.
4. 안전성은 다른 점수로 상쇄되지 않는 필수 조건이다.
5. 외부 게시와 내부 작업을 분리한다.
6. 기존 제품(Odoo, n8n, Temporal 등)을 먼저 평가하고, 마이크로서비스보다 모듈형 모놀리스로 시작한다.

## 개발

Node 24 LTS와 npm이 필요하다 (`sqlite3` CLI와 [gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1은 스키마·스캔 검사용).

```
npm ci
npm run check            # 아래 전부
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint (+ SQL 현재 시각 함수 금지)
npm run lint:boundaries  # dependency-cruiser: 의존 방향·공개 API·팩 경계·순환
npm test                 # node:test: unit, integration(다중 프로세스 SQLite), boundaries
npm run check:schema     # sqlite3 :memory: < docs/schema/schema.sql
npm run scan:secrets     # gitleaks (--redact); 이력은 npm run scan:history
npm run hooks:install    # 커밋 전 스캔 훅 (git config core.hooksPath .githooks)
```

설정은 `*.example`(`.env.example`, `config/daemon.config.example.json`)만 저장소에 두고 실제 값은 `instance/`와 환경 변수로 주입한다.

## 저장소 구조

```
aot-growth-os/
├── apps/        daemon (워커·승인 CLI·주간 사이클)  — web, public-web 은 후속
├── packages/    domain, task-engine, policy, agent-runtime, evaluation
├── packs/       example-marketing (도메인 팩: 루틴·업무 템플릿·측정 신호, ADR-0012)
├── test/        unit, integration, boundaries, support(가짜 어댑터·가짜 도구)
├── departments/ 부서별 책임·업무 정의·검증 기준
├── policies/    정책 형식과 기본 템플릿 (에이전트 쓰기 경로 밖, 실제 값은 instance/)
├── instance/    (커밋 제외) 내부 DB·설정·등록된 제품 데이터
├── workflows/  docs/  (팩 안: workflows/ routines/ evaluations/)
```
(`departments/`, `policies/`, `instance/` 는 예정 또는 커밋 제외)

MVP 단계에서는 `domain`, `task-engine`(스케줄러 포함), `policy`, `agent-runtime`, `evaluation` 5개 패키지로 시작한다 ([ADR-0001](docs/adr/0001-modular-monolith.md)).

## 라이선스와 기여

[Apache-2.0](LICENSE). 기여는 [DCO](https://developercertificate.org/)에 동의하는 서명이 필요하며, 커밋할 때 `git commit -s`로 `Signed-off-by` 줄을 남긴다. 프로젝트 이름·로고는 라이선스와 별개로 상표이며, Apache-2.0은 상표 사용권을 주지 않는다.
