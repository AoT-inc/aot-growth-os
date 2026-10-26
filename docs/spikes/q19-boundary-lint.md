# 스파이크 Q19: 모듈 경계 lint 도구

상태: 완료 (2026-10-19) · 관련: [open-questions Q19](../open-questions.md), [ADR-0001](../adr/0001-modular-monolith.md), [phase-a §4](../plans/phase-a.md), [a0-decisions D7](../plans/a0-decisions.md)

## 결론

**dependency-cruiser 18.6.0**을 쓴다. 의존 방향, 공개 API(`src/index.ts`)만 허용하는 깊은 참조 금지, 순환, 팩 경계(`packs/`는 코어 내부 모듈 참조 금지)를 한 설정 파일에서 정규식 규칙으로 표현하고, 시험한 위반을 전부 잡았다. ESLint 플러그인 두 후보도 방향·깊은 참조는 잡았지만 순환 검사와 설정 함정이 따로 필요했다.

## 판정 방법 (시험 전에 고정)

[open-questions](../open-questions.md)의 방법대로 "후보를 가상 위반 사례로 시험"한다. 통과 기준:

1. 위반 10건(아래)을 모두 실패로 잡는다.
2. 정상 골격(위반 없음)에서는 0건이다. 합법 사례(V8)를 막지 않는다.
3. 같은 설정이 [npm 워크스페이스](#워크스페이스에서-주의) 배치에서도 동작한다.
4. 팩 경계 규칙을 표현할 수 있다.

## 시험 골격과 규칙

`packages/{domain,task-engine,policy,evaluation,agent-runtime}/src/{index.ts,internal/}`, `apps/daemon`, `packs/example-marketing`. 가상 코드 20여 파일, TypeScript.

| 규칙 | 내용 |
|---|---|
| R1 | `domain`은 다른 패키지·apps·packs를 참조하지 않는다 |
| R2 | `task-engine`/`policy`/`evaluation`은 `domain`만 참조한다 (서로, 상위 참조 금지) |
| R3 | 패키지·팩·앱 사이 참조는 대상 패키지의 `src/index.ts`만 허용한다 (깊은 참조 금지) |
| R4 | `packages/`는 `apps/`를 참조하지 않는다 |
| R5 | `packs/`는 `apps/`와 코어 패키지의 내부 모듈을 참조하지 않는다 (공개 API는 허용) |
| R6 | 순환 금지 |

ADR-0001은 `task-engine`/`policy`/`evaluation` 사이의 참조를 명시하지 않아, 같은 층끼리도 금지(R2)로 시험했다. 허용하려면 규칙 한 줄만 바꾸면 된다.

주입한 위반: V1 `domain`→`task-engine`, V2 `task-engine`→`agent-runtime`, V3 `agent-runtime`→`task-engine` 내부 파일(상대 경로), V4 팩→`task-engine` 내부 파일, V5 `policy`→`apps`, V6 `policy`↔`evaluation` 상호 참조(2건), V7a/b/c `domain`→상위 패키지를 `import type`·`import()`·`export … from`으로 우회. 별도로 패키지 내부 순환(`c1`↔`c2`). 합법 사례 V8: 팩이 `task-engine`의 `src/index.ts`를 상대 경로로 참조(통과해야 함).

## 후보와 결과

| 후보 | 버전 | 정상 골격 | 위반 10건 | 순환 | V8(합법) | 비고 |
|---|---|---|---|---|---|---|
| dependency-cruiser | 18.6.0 | 0건 | 10/10 | 잡음 (`no-circular`) | 통과 | 규칙 8개, 설정 약 30줄. 종료 코드 = 위반 수 |
| eslint-plugin-boundaries | 7.2.0 (eslint 9.39.5, typescript-eslint 8.71.2) | 0건 | 10/10 | 못 잡음 (순환 규칙 없음) | 통과 | 기본 거부 + 허용 정책 방식이라 새 패키지는 정책을 쓰기 전까지 막힌다. 설정 약 40줄 |
| eslint-plugin-import-x `no-restricted-paths` + `no-cycle` | 4.17.1 | 0건 | 10/10 | `import-x/parsers`·`extensions` 설정 후에야 잡음 | 통과 | `zones`가 길어져 코드로 생성함. `from`에 글롭과 일반 경로를 섞으면 설정 오류 |

미시험: Nx 모듈 경계 규칙(Nx 도입이 전제), TypeScript 프로젝트 참조(팩 규칙·공개 API 규칙 표현이 어려울 것으로 예상하나 확인하지 않음).

## 실행 기록

```
$ npx depcruise packages apps packs -c .dependency-cruiser.cjs      # 정상 골격
✔ no dependency violations found (9 modules, 11 dependencies cruised)

$ npx depcruise packages apps packs -c .dependency-cruiser.cjs      # 위반 주입본
  error packs-not-to-core-internals: packs/example-marketing/src/v4.ts → packages/task-engine/src/internal/queue.ts
  error only-public-api-across-packages: packages/agent-runtime/src/v3.ts → packages/task-engine/src/internal/queue.ts
  error domain-is-bottom: packages/domain/src/internal/v7b.ts → packages/policy/src/index.ts
  error no-circular: packages/policy/src/c1.ts →
x 13 dependency violations (13 errors, 0 warnings). 22 modules, 24 dependencies cruised.   # 종료 코드 13

$ npx eslint .     # eslint-plugin-boundaries, 위반 주입본
  There is no policy allowing dependencies from elements of type "pack" to elements of type "task-engine"  boundaries/dependencies
✖ 10 problems (10 errors, 0 warnings)
```

dependency-cruiser의 13건은 한 위반이 규칙 둘에 걸린 중복(V4, V5)과 순환 1건을 포함한다.

## 선택 이유

- 경계 규칙 전부(방향, 공개 API, 팩, 순환)를 한 파일·한 도구로 표현한다. ESLint 후보는 순환에 플러그인을 하나 더 쓰거나(import-x), 아예 못 한다(boundaries).
- 정적 분석 대상이 import 구문이라 `import type`, 동적 `import()` 리터럴, `export … from`을 모두 잡았다.
- ESLint 설정에 의존하지 않아 lint 규칙(스타일)과 경계 검사를 CI에서 별도 단계로 분리할 수 있다. 의존 그래프 출력도 같은 도구로 얻는다(시험하지 않음).
- 한계: 정적 도구라 문자열 변수로 만든 동적 `import(x)`는 어떤 후보도 잡지 못한다. 코드 리뷰와 "동적 import 금지" 관례로 보완한다.

## 설정 발췌 (정상 동작 확인한 규칙)

```js
// .dependency-cruiser.cjs (발췌)
const MID = 'task-engine|policy|evaluation';
module.exports = {
  forbidden: [
    { name: 'not-to-unresolvable', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'domain-is-bottom', severity: 'error',
      from: { path: '^packages/domain/' }, to: { path: '^(packages/(?!domain/)|apps/|packs/)' } },
    { name: 'mid-layer-only-domain', severity: 'error',
      from: { path: `^packages/(${MID})/` }, to: { path: '^(packages/agent-runtime/|apps/|packs/)' } },
    { name: 'mid-layer-peers-isolated', severity: 'error',
      from: { path: `^packages/(${MID})/` }, to: { path: `^packages/(${MID})/`, pathNot: '^packages/$1/' } },
    { name: 'packages-not-to-apps', severity: 'error',
      from: { path: '^packages/' }, to: { path: '^apps/' } },
    { name: 'only-public-api-across-packages', severity: 'error',
      from: { path: '^(packages|apps|packs)/([^/]+)/' },
      to: { path: '^packages/([^/]+)/src/(?!index\\.ts$)', pathNot: '^packages/$2/' } },
    { name: 'packs-not-to-core-internals', severity: 'error',
      from: { path: '^packs/' }, to: { path: '^(packages/[^/]+/src/(?!index\\.ts$)|apps/)' } },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' }, doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
```

## 워크스페이스에서 주의

npm 워크스페이스(`@aot/domain` 같은 패키지 이름으로 참조)로 배치하면 `package.json`의 `exports`를 읽도록 `enhancedResolveOptions`를 설정해야 한다. 설정하지 않으면 패키지 이름 참조가 **해석되지 않은 채 조용히 통과**해 위반이 잡히지 않았다(시험: `domain`→`task-engine` 위반이 0건으로 나옴). 그래서 `not-to-unresolvable` 규칙을 함께 둔다. 이 규칙이 있으면 해석 실패가 곧바로 오류로 나온다. 위 설정에서 워크스페이스 위반은 정상적으로 잡혔다.

ESLint 후보를 쓸 경우 `import-x/no-cycle`은 `import-x/extensions`와 `import-x/parsers` 설정이 없으면 TypeScript 파일의 순환을 조용히 놓쳤다.

## A0에 반영할 것

- `.dependency-cruiser.cjs`를 저장소 루트에 두고 CI 필수 단계로 연결한다([phase-a §4](../plans/phase-a.md) "CI 필수 통과 항목").
- 위반 사례 몇 건을 `test/boundaries/` 같은 곳에 고정 시험으로 남겨 규칙이 조용히 약해지는 것을 막는다(이번 시험의 V1~V8 재사용).
- `task-engine`/`policy`/`evaluation` 상호 참조 허용 여부는 A1에서 실제 필요가 생길 때 정한다.

## 사용 버전

dependency-cruiser 18.6.0 (Node `^22 || ^24 || >=26` 요구. Node 25.9에서 설치하면 npm이 호환 버전 17.4.3을 골랐으므로 LTS에서 시험), eslint 9.39.5, eslint-plugin-boundaries 7.2.0, eslint-plugin-import-x 4.17.1, eslint-import-resolver-typescript 4.4.5, typescript-eslint 8.71.2, typescript 5.9.3. Node 24.22.0 (LTS), macOS arm64.
