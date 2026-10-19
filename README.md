# AoT Growth OS

조직·업무·기억·평가·전략을 코드로 운영하는 AI-native 기업 운영체계.

사람은 목표와 제약을 정하고, 시스템은 이벤트와 루틴에 따라 업무를 만들고 실행하며, 검증된 결과를 다음 의사결정에 반영한다. 핵심은 에이전트가 아니라 **에이전트가 무엇을 해야 하는지 결정하고, 결과를 검증하고, 그 결과를 되먹임하는 운영 계층**이다.

## 현재 상태: 설계 단계 (docs only)

코드는 아직 없다. 구현 전에 아래 문서를 확정한다.

| 문서 | 내용 |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | 정체성, 자체 개발 범위 vs 재사용, 아키텍처, MVP |
| [docs/glossary.md](docs/glossary.md) | 용어집 (한/영 대응, 정의, 금지 용법) |
| [docs/adr/](docs/adr/README.md) | 아키텍처 결정 기록 (ADR 0001–0012) |
| [docs/schema/](docs/schema/README.md) | 데이터 모델 초안 (`schema.sql`, 상태 전이, 업무 명세) |
| [docs/products/](docs/products/README.md) | 상품 등록 절차 (앱·데몬 구동 후 검증·승인으로 등록) |
| [workflows/product-registration.md](workflows/product-registration.md) | 상품 등록 검증 업무 템플릿 (`task_spec`, 읽기 전용 수집, 비밀값 스캔, 3단계 검증) |
| [docs/plans/phase-a.md](docs/plans/phase-a.md) | Phase A 구현 계획 (패키지 순서, 필수 테스트 매핑, 부트스트랩, 스파이크) |
| [docs/plans/a0-decisions.md](docs/plans/a0-decisions.md) | A0 착수 전 사람 결정 (런타임, 시드 조직, 라이선스, 확장 단위는 2026-10-19 결정. 측정 신호, 승인자, 승인 채널은 대기) |
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

## 예정 저장소 구조

```
aot-growth-os/
├── apps/        web, public-web, daemon
├── packages/    domain, task-engine, policy, agent-runtime, evaluation, ...
├── departments/ 부서별 책임·업무 정의·검증 기준
├── policies/    정책 형식과 기본 템플릿 (에이전트 쓰기 경로 밖, 실제 값은 instance/)
├── instance/    (커밋 제외) 내부 DB·설정·등록된 제품 데이터
├── workflows/  routines/  evaluations/  migrations/  tests/  docs/
```

MVP 단계에서는 `domain`, `task-engine`(스케줄러 포함), `policy`, `agent-runtime`, `evaluation` 5개 패키지로 시작한다 ([ADR-0001](docs/adr/0001-modular-monolith.md)).

## 라이선스와 기여

[Apache-2.0](LICENSE). 기여는 [DCO](https://developercertificate.org/)에 동의하는 서명이 필요하며, 커밋할 때 `git commit -s`로 `Signed-off-by` 줄을 남긴다. 프로젝트 이름·로고는 라이선스와 별개로 상표이며, Apache-2.0은 상표 사용권을 주지 않는다.
