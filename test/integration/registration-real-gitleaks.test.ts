// 실제 gitleaks 와의 연결 (secret_scan). 실행 파일이 없으면 건너뛴다: `AOT_GITLEAKS_BIN`(절대 경로) 또는 /usr/local/bin/gitleaks(CI 설치 위치).
// 확인하는 것: 호출 모양이 실제 gitleaks 8.30.1 에서 통한다 / 보고서에서 위치·종류만 뽑는다 / 후보 저장소의 .gitleaks.toml 허용 목록이 스캔을 가리지 못한다 / 이력에만 있는 비밀도 이력 스캔이 찾는다.
// 표본 비밀은 실행 중에 무작위로 만들어 임시 저장소에만 둔다(소스에 키 모양을 두지 않는다).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createRegistrationTools, SECRET_SCAN_TOOL, type JsonObject } from '@aot/agent-runtime';
import { parseSecretScanSummary } from '@aot/evaluation';
import { FakeClock } from '@aot/domain';

import { git, GIT, makeRepo, MemoryCapture, request, toolRun } from '../support/registration-tools.ts';

const GITLEAKS = process.env['AOT_GITLEAKS_BIN'] ?? '/usr/local/bin/gitleaks';
const CONFIG = new URL('../../config/gitleaks-registration.toml', import.meta.url).pathname;

let available = true;
try {
  accessSync(GITLEAKS, constants.X_OK);
} catch {
  available = false;
}

const base62 = (length: number): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join('');
};

describe('secret_scan with the real gitleaks', { skip: available ? false : `gitleaks not found at ${GITLEAKS} (set AOT_GITLEAKS_BIN)` }, () => {
  it('finds a secret in the tree and one that only exists in history, reports location and rule only, and ignores the candidate repository\'s own allowlist', async (t) => {
    const secret = ['gh', 'p_', base62(36)].join('');
    const root = makeRepo(t, {
      'README.md': '# example-product\n',
      'config/old.txt': `token = ${secret}\n`,
      // 후보 저장소가 자기 설정으로 스캔을 피하려는 시도
      '.gitleaks.toml': '[allowlist]\npaths = [\'\'\'.*\'\'\']\n',
    });
    const capture = new MemoryCapture();
    const tools = createRegistrationTools({ clock: new FakeClock('2026-10-26T00:00:00.000Z'), gitPath: GIT, gitleaksPath: GITLEAKS, gitleaksConfigPath: CONFIG });
    const call = async (operation: string) => (await tools.executorsFor(toolRun(root, capture)).get(SECRET_SCAN_TOOL)!(request(SECRET_SCAN_TOOL, operation))).result as JsonObject;

    const tree = await call('scan_tree');
    assert.equal(tree['findings_count'], 1);
    assert.match(String((tree['findings'] as { location: string }[])[0]?.location), /^config\/old\.txt$/);
    assert.match(String((tree['findings'] as { kind: string }[])[0]?.kind), /github/i);
    assert.match(String(tree['scanner']), /^gitleaks@\d+\.\d+\.\d+$/);

    // 비밀 파일을 지우고 커밋한다: 작업 트리는 깨끗해지고 이력에만 남는다
    rmSync(join(root, 'config', 'old.txt'));
    writeFileSync(join(root, 'README.md'), '# example-product\nremoved the old config\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'remove old config');
    assert.equal((await call('scan_tree'))['findings_count'], 0, 'the working tree is clean now');
    const history = await call('scan_history');
    assert.equal(history['commits_scanned'], 2);
    assert.ok(Number(history['findings_count']) >= 1, 'the history scan still finds it');
    assert.match(String((history['findings'] as { location: string }[])[0]?.location), /^[0-9a-f]{12}:config\/old\.txt$/);

    // 저장된 요약과 도구 결과 어디에도 비밀 값이 없다
    for (const text of [...capture.saved.map((saved) => saved.text), JSON.stringify(tree), JSON.stringify(history)]) assert.ok(!text.includes(secret.slice(4)), 'the secret value never leaves');
    for (const saved of capture.saved) assert.ok(parseSecretScanSummary(saved.text).ok, 'each stored summary matches the evaluator format');
  });
});
