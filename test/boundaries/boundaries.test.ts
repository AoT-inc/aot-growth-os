// 경계 규칙 고정 시험 (docs/spikes/q19-boundary-lint.md 의 V1~V8 재사용).
// 규칙이 조용히 약해지면(예: 워크스페이스 exports 해석 누락) 여기서 실패한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDir } from '../support/temp.ts';
import { buildSandbox, cruise, cruiseExitCode, type Violation } from '../support/boundary-sandbox.ts';

/** 합법 사례: 어떤 규칙도 위반하지 않아야 한다. */
const LEGAL: Record<string, string> = {
  'packages/task-engine/src/uses-domain.ts': "import { domain } from '@aot/domain';\nexport const a = domain;\n",
  'packages/policy/src/uses-domain-relative.ts': "import { domain } from '../../domain/src/index.ts';\nexport const a = domain;\n",
  'packages/agent-runtime/src/uses-lower-layers.ts':
    "import { policy } from '@aot/policy';\nimport { task_engine } from '@aot/task-engine';\nimport { evaluation } from '@aot/evaluation';\nimport { domain } from '@aot/domain';\nexport const a = [policy, task_engine, evaluation, domain];\n",
  'apps/daemon/src/uses-packages.ts': "import { agent_runtime } from '@aot/agent-runtime';\nexport const a = agent_runtime;\n",
  // V8: 팩이 코어의 공개 API(src/index.ts)를 상대 경로로 참조하는 것은 허용
  'packs/example-marketing/src/uses-public-api.ts': "import { task_engine } from '../../../packages/task-engine/src/index.ts';\nexport const a = task_engine;\n",
  'packages/domain/src/a.ts': "import { b } from './b.ts';\nexport const a = b;\n",
  'packages/domain/src/b.ts': 'export const b = 1;\n',
  // 연결 열기 파일은 node:sqlite 를 import 할 수 있다
  'packages/domain/src/db/node-sqlite.ts': "import { DatabaseSync } from 'node:sqlite';\nexport const d = DatabaseSync;\n",
};

interface ViolationCase {
  name: string;
  /** 위반을 담은 파일 */
  file: string;
  content: string;
  /** 이 파일에서 나와야 하는 규칙 (전부, 순서 무관) */
  rules: string[];
}

const VIOLATIONS: ViolationCase[] = [
  { name: 'V1 domain -> task-engine (by package name)', file: 'packages/domain/src/v1.ts',
    content: "import { task_engine } from '@aot/task-engine';\nexport const v = task_engine;\n", rules: ['domain-is-bottom'] },
  { name: 'V2 task-engine -> agent-runtime', file: 'packages/task-engine/src/v2.ts',
    content: "import { agent_runtime } from '@aot/agent-runtime';\nexport const v = agent_runtime;\n", rules: ['mid-layer-only-domain'] },
  { name: 'V3 agent-runtime -> task-engine internal (relative path)', file: 'packages/agent-runtime/src/v3.ts',
    content: "import { impl } from '../../task-engine/src/internal/impl.ts';\nexport const v = impl;\n", rules: ['only-public-api-across-packages'] },
  { name: 'V3b apps -> package internal', file: 'apps/daemon/src/v3b.ts',
    content: "import { impl } from '../../../packages/domain/src/internal/impl.ts';\nexport const v = impl;\n", rules: ['only-public-api-across-packages'] },
  { name: 'V4 pack -> task-engine internal', file: 'packs/example-marketing/src/v4.ts',
    content: "import { impl } from '../../../packages/task-engine/src/internal/impl.ts';\nexport const v = impl;\n",
    rules: ['only-public-api-across-packages', 'packs-not-to-core-internals'] },
  { name: 'V4b pack -> apps', file: 'packs/example-marketing/src/v4b.ts',
    content: "import { main } from '../../../apps/daemon/src/main.ts';\nexport const v = main;\n", rules: ['packs-not-to-core-internals'] },
  { name: 'V5 policy -> apps', file: 'packages/policy/src/v5.ts',
    content: "import { main } from '../../../apps/daemon/src/main.ts';\nexport const v = main;\n",
    rules: ['mid-layer-only-domain', 'packages-not-to-apps'] },
  { name: 'V6 policy -> evaluation (peers)', file: 'packages/policy/src/v6.ts',
    content: "import { evaluation } from '@aot/evaluation';\nexport const v = evaluation;\n", rules: ['mid-layer-peers-isolated'] },
  { name: 'V7a domain -> policy via `import type`', file: 'packages/domain/src/v7a.ts',
    content: "import type { policy } from '@aot/policy';\nexport type V = typeof policy;\n", rules: ['domain-is-bottom'] },
  { name: 'V7b domain -> policy via dynamic import()', file: 'packages/domain/src/v7b.ts',
    content: "export const v = () => import('@aot/policy');\n", rules: ['domain-is-bottom'] },
  { name: 'V7c domain -> policy via `export ... from`', file: 'packages/domain/src/v7c.ts',
    content: "export { policy } from '@aot/policy';\n", rules: ['domain-is-bottom'] },
  { name: 'core code -> pack code (packages)', file: 'packages/agent-runtime/src/v9.ts',
    content: "import { a } from '../../../packs/example-marketing/src/uses-public-api.ts';\nexport const v = a;\n", rules: ['core-not-to-packs'] },
  { name: 'core code -> pack code (apps)', file: 'apps/daemon/src/v9b.ts',
    content: "import { a } from '../../../packs/example-marketing/src/uses-public-api.ts';\nexport const v = a;\n", rules: ['core-not-to-packs'] },
  { name: 'node:sqlite outside the one driver file', file: 'packages/task-engine/src/v10.ts',
    content: "import { DatabaseSync } from 'node:sqlite';\nexport const v = DatabaseSync;\n", rules: ['sqlite-driver-only-in-one-file'] },
  { name: 'unresolvable import is an error, not silence', file: 'packages/policy/src/v11.ts',
    content: "import { x } from '@aot/does-not-exist';\nexport const v = x;\n", rules: ['not-to-unresolvable'] },
];

const CIRCULAR: Record<string, string> = {
  'packages/policy/src/c1.ts': "import { c2 } from './c2.ts';\nexport const c1 = () => c2;\n",
  'packages/policy/src/c2.ts': "import { c1 } from './c1.ts';\nexport const c2 = () => c1;\n",
};

function rulesFor(violations: Violation[], file: string): string[] {
  return [...new Set(violations.filter((v) => v.from === file).map((v) => v.rule))].sort();
}

test('legal dependencies produce zero violations (control)', (t) => {
  const root = makeTempDir(t);
  buildSandbox(root, LEGAL);
  assert.deepEqual(cruise(root).violations, []);
  assert.equal(cruiseExitCode(root), 0);
});

test('every injected violation is caught by exactly the expected rules', (t) => {
  const root = makeTempDir(t);
  buildSandbox(root, {
    ...LEGAL,
    ...CIRCULAR,
    ...Object.fromEntries(VIOLATIONS.map((v) => [v.file, v.content])),
  });
  const { violations } = cruise(root);
  assert.notEqual(cruiseExitCode(root), 0, 'depcruise must exit non-zero when there are violations (CI fails)');

  for (const v of VIOLATIONS) {
    assert.deepEqual(rulesFor(violations, v.file), [...v.rules].sort(), v.name);
  }
  const circular = violations.filter((v) => v.rule === 'no-circular').map((v) => v.from);
  assert.ok(circular.includes('packages/policy/src/c1.ts') || circular.includes('packages/policy/src/c2.ts'), 'circular import');

  // 합법 파일은 어느 위반에도 등장하지 않는다.
  for (const legalFile of Object.keys(LEGAL)) {
    assert.deepEqual(rulesFor(violations, legalFile), [], `legal file flagged: ${legalFile}`);
  }
});

test('the real repository tree currently has zero violations', () => {
  // npm run lint:boundaries 와 같은 검사. 시험 결과에도 남겨 둔다.
  const repoRoot = new URL('../..', import.meta.url).pathname;
  assert.deepEqual(cruise(repoRoot).violations, []);
  assert.equal(cruiseExitCode(repoRoot), 0);
});
