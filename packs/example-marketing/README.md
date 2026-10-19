# example-marketing (팩 골격)

주간 시장 조사 사이클을 담을 첫 도메인 팩의 자리표시다 ([ADR-0012](../../docs/adr/0012-extension-unit-contract.md)).
A0 에서는 구성만 있고 내용은 비어 있다. 값은 모두 가상이며 실제 제품·정책은 `instance/` 에 둔다.

| 위치 | 내용 | 상태 |
|---|---|---|
| `manifest.json` | 이름, 버전, 요구 코어 버전, 필요한 도구 | 형식 검증 있음 (`validatePackManifest`, A1) |
| `workflows/` | 업무 명세 템플릿 ([task-spec](../../docs/schema/task-spec.md) 형식) | 비어 있음 |
| `routines/` | 루틴 | 비어 있음 |
| `evaluations/` | 결정론적 검사 id, LLM 검증 프롬프트 | 비어 있음 |
| `policy-examples/` | 정책 **예시** (채택은 코어의 승인 경로) | 비어 있음 |

팩은 정책·스키마·검증기를 바꿀 수 없고, 코어 내부 모듈을 import 하지 않는다 (`npm run lint:boundaries`가 검사).
