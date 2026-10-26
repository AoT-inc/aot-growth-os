// 경계 규칙 시험용 임시 저장소. 실제 저장소 골격(패키지 5개 + apps/daemon + 팩)과 같은 모양을 임시 디렉터리에 만들고
// node_modules/@aot/* 심볼릭 링크까지 실제 워크스페이스처럼 구성한다. 이름(@aot/x)으로 참조하는 위반이
// 조용히 통과하지 않는지(exports 해석)도 이 구성으로 확인한다.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dirname, '../..');
export const PACKAGES = ['domain', 'task-engine', 'policy', 'evaluation', 'agent-runtime'] as const;

export interface Violation {
  rule: string;
  from: string;
  to: string;
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function buildSandbox(root: string, overlay: Record<string, string>): void {
  for (const name of PACKAGES) {
    write(root, `packages/${name}/package.json`, JSON.stringify({ name: `@aot/${name}`, type: 'module', exports: { '.': './src/index.ts' } }));
    write(root, `packages/${name}/src/index.ts`, `export const ${name.replace(/-/g, '_')} = 1;\n`);
    write(root, `packages/${name}/src/internal/impl.ts`, 'export const impl = 1;\n');
    mkdirSync(join(root, 'node_modules/@aot'), { recursive: true });
    symlinkSync(join(root, `packages/${name}`), join(root, `node_modules/@aot/${name}`), 'dir');
  }
  write(root, 'apps/daemon/package.json', JSON.stringify({ name: '@aot/daemon', type: 'module' }));
  write(root, 'apps/daemon/src/main.ts', 'export const main = 1;\n');
  write(root, 'packs/example-marketing/manifest.json', '{}\n');
  write(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true, noEmit: true },
  }));
  for (const [relative, content] of Object.entries(overlay)) write(root, relative, content);
}

const BIN = join(REPO_ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const CONFIG = join(REPO_ROOT, '.dependency-cruiser.cjs');

/**
 * `npm run lint:boundaries` 와 같은 명령(기본 보고 형식)의 종료 코드. CI 가 이 값으로 실패한다.
 * (json 보고 형식은 위반이 있어도 0 으로 끝나므로 종료 코드는 여기서만 본다.)
 */
export function cruiseExitCode(root: string): number {
  const result = spawnSync(process.execPath, [BIN, 'packages', 'apps', 'packs', '--config', CONFIG], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status ?? -1;
}

/** 샌드박스에서 실제 저장소의 .dependency-cruiser.cjs 로 검사를 돌리고 위반 목록을 돌려준다. */
export function cruise(root: string): { violations: Violation[] } {
  const result = spawnSync(
    process.execPath,
    [BIN, 'packages', 'apps', 'packs', '--config', CONFIG, '--output-type', 'json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const report = JSON.parse(result.stdout) as {
    summary: { violations: { rule: { name: string; severity: string }; from: string; to: string }[] };
  };
  return {
    violations: report.summary.violations
      .filter((v) => v.rule.severity === 'error')
      .map((v) => ({ rule: v.rule.name, from: v.from, to: v.to })),
  };
}
