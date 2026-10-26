import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** 시험마다 격리된 임시 디렉터리. 시험이 끝나면 지운다. */
export function makeTempDir(t: TestContext, prefix = 'aot-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
