// 모듈 경계 검사 (docs/spikes/q19-boundary-lint.md, ADR-0001, ADR-0012).
// 실행: npm run lint:boundaries   (규칙이 실제로 위반을 잡는지는 test/boundaries 가 고정 시험한다)
//
// 의존 방향: domain <- task-engine / policy / evaluation <- agent-runtime <- apps
// 패키지 사이 참조는 대상 패키지의 src/index.ts 만 허용한다. packs/ 는 코어 내부 모듈을 참조하지 않는다.
// task-engine / policy / evaluation 끼리의 참조는 막아 둔다 (ADR-0001 에 명시 없음 — 실제 필요가 생기면
// A1 이후 'mid-layer-peers-isolated' 규칙만 고친다).
const MID = 'task-engine|policy|evaluation';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // 해석 실패는 곧 오류다. 워크스페이스 exports 해석이 빠지면 위반이 조용히 통과하므로 반드시 켜 둔다.
    { name: 'not-to-unresolvable', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },

    { name: 'domain-is-bottom', severity: 'error',
      comment: 'domain 은 다른 패키지·apps·packs 를 참조하지 않는다',
      from: { path: '^packages/domain/' },
      to: { path: '^(packages/(?!domain/)|apps/|packs/)' } },
    { name: 'mid-layer-only-domain', severity: 'error',
      comment: 'task-engine/policy/evaluation 은 domain 만 참조한다 (agent-runtime·apps·packs 금지)',
      from: { path: `^packages/(${MID})/` },
      to: { path: '^(packages/agent-runtime/|apps/|packs/)' } },
    { name: 'mid-layer-peers-isolated', severity: 'error',
      comment: 'task-engine/policy/evaluation 서로 참조 금지',
      from: { path: `^packages/(${MID})/` },
      to: { path: `^packages/(${MID})/`, pathNot: '^packages/$1/' } },
    { name: 'packages-not-to-apps', severity: 'error',
      from: { path: '^packages/' }, to: { path: '^apps/' } },
    { name: 'core-not-to-packs', severity: 'error',
      comment: '팩은 선언형 데이터이고 커넥터는 별도 프로세스다 (ADR-0012). 코어 코드가 팩 코드를 import 하지 않는다',
      from: { path: '^(packages|apps)/' }, to: { path: '^packs/' } },

    { name: 'only-public-api-across-packages', severity: 'error',
      comment: '다른 패키지의 내부 모듈 참조 금지: 대상 패키지의 src/index.ts 만 허용',
      from: { path: '^(packages|apps|packs)/([^/]+)/' },
      to: { path: '^packages/([^/]+)/src/(?!index\\.ts$)', pathNot: '^packages/$2/' } },
    { name: 'packs-not-to-core-internals', severity: 'error',
      comment: '팩은 코어 내부 모듈과 apps 를 참조하지 않는다 (공개 API 는 허용)',
      from: { path: '^packs/' },
      to: { path: '^(packages/[^/]+/src/(?!index\\.ts$)|apps/)' } },

    { name: 'sqlite-driver-only-in-one-file', severity: 'error',
      comment: '연결은 openDb() 로만 연다. PRAGMA 순서(busy_timeout 먼저)와 BEGIN IMMEDIATE 규칙이 거기에 있다',
      from: { pathNot: '^packages/domain/src/db/node-sqlite\\.ts$' },
      to: { dependencyTypes: ['core'], path: '^(node:)?sqlite$' } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true, // `import type` 도 의존으로 센다
    // 워크스페이스 패키지(@aot/*)를 package.json 의 exports 로 해석한다. 없으면 위반이 조용히 통과한다.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
