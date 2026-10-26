// 등록 후보 저장소 파일 접근(repo-files.ts): 저장소는 신뢰할 수 없는 입력이다 — 경로 탈출·심볼릭 링크·하드링크·비밀 파일·바이너리·마스킹.
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { countFiles, isDeniedPath, listTree, normalizeRelativePath, readTextFile } from '@aot/agent-runtime';

import { makeRepo } from '../support/registration-tools.ts';
import { makeTempDir } from '../support/temp.ts';

test('normalizeRelativePath: only plain relative paths; absolute, parent, NUL, control and backslash are refused', () => {
  assert.equal(normalizeRelativePath(''), '');
  assert.equal(normalizeRelativePath('.'), '');
  assert.equal(normalizeRelativePath('src//a/./b.ts'), 'src/a/b.ts');
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a/..', 'C:/x', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(513), 5, null, undefined, {}]) {
    assert.equal(normalizeRelativePath(bad), null, String(bad));
  }
});

test('isDeniedPath: secret-looking file names and anything under .git are never read', () => {
  for (const denied of ['.env', '.env.production', 'config/.env.local', 'server.pem', 'keys/private.key', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.netrc', 'credentials.json', 'secrets.yaml',
    '.git/config', 'sub/.git/HEAD', 'service-account.json', 'store.p12', 'vault.kdbx']) {
    assert.equal(isDeniedPath(denied), true, denied);
  }
  for (const fine of ['README.md', 'src/index.ts', 'docs/environment.md', 'package.json', '.gitignore', 'env.example', 'secret_santa.md.txt']) {
    assert.equal(isDeniedPath(fine), false, fine);
  }
});

test('readTextFile: reads text, masks secret-looking values, truncates on a character boundary', async (t) => {
  const key = ['gh', 'p_exampleexampleexample0123456789'].join('');
  const root = makeRepo(t, { 'README.md': `token ${key} here\nhello`, 'ko.txt': '가나다라마바사', 'empty.txt': '' });
  const masked = await readTextFile(root, 'README.md', 1000);
  assert.ok(masked.ok);
  assert.ok(!masked.text.includes(key) && masked.text.includes('[REDACTED]'));
  assert.equal(masked.truncated, false);
  // 한글은 문자당 3바이트: 10바이트에서 자르면 9바이트(3자)로 물러난다
  const cut = await readTextFile(root, 'ko.txt', 10);
  assert.ok(cut.ok);
  assert.equal(cut.text, '가나다');
  assert.equal(cut.truncated, true);
  const empty = await readTextFile(root, 'empty.txt', 10);
  assert.ok(empty.ok && empty.text === '' && empty.bytes === 0);
});

test('readTextFile: unavailable (not an error) for secret names, binaries, directories, missing files and escapes', async (t) => {
  const outside = makeTempDir(t, 'aot-outside-');
  writeFileSync(join(outside, 'outside.txt'), 'outside secret');
  const root = makeRepo(t, { '.env': 'A=1', 'bin.dat': Buffer.from([1, 2, 0, 3, 4]), 'bad.txt': Buffer.from([0xff, 0xfe, 0x41]), 'dir/a.txt': 'a', 'ok.txt': 'ok' });
  symlinkSync(join(outside, 'outside.txt'), join(root, 'link-out.txt'));
  symlinkSync(outside, join(root, 'dir-link'));
  symlinkSync('ok.txt', join(root, 'link-in.txt'));
  const reason = async (rel: string) => { const r = await readTextFile(root, rel, 100); return r.ok ? 'OK' : r.reason; };
  assert.equal(await reason('.env'), 'path_denied');
  assert.equal(await reason('.git/config'), 'path_denied');
  assert.equal(await reason('bin.dat'), 'binary_file');
  assert.equal(await reason('bad.txt'), 'binary_file');
  assert.equal(await reason('dir'), 'not_a_file');
  assert.equal(await reason('missing.txt'), 'not_found');
  assert.equal(await reason('link-out.txt'), 'path_outside_repo');
  assert.equal(await reason('dir-link/outside.txt'), 'path_outside_repo');
  assert.equal(await reason('link-in.txt'), 'OK', 'a symlink that stays inside the repository resolves to its target');
});

test('readTextFile: a hard link (possibly to a file outside the repository) is refused', async (t) => {
  const outside = makeTempDir(t, 'aot-outside-');
  writeFileSync(join(outside, 'target.txt'), 'outside');
  const root = makeRepo(t, { 'ok.txt': 'ok' });
  try {
    linkSync(join(outside, 'target.txt'), join(root, 'hard.txt'));
  } catch {
    t.skip('hard links are not available here');
    return;
  }
  const result = await readTextFile(root, 'hard.txt', 100);
  assert.deepEqual(result, { ok: false, reason: 'hardlinked_file' });
});

test('listTree: does not follow symlinks, does not descend into .git, respects depth and the entry limit', async (t) => {
  const outside = makeTempDir(t, 'aot-outside-');
  writeFileSync(join(outside, 'x.txt'), 'x');
  const root = makeRepo(t, { 'a/b/c/deep.txt': '1', 'a/top.txt': '2', 'z.txt': '3' });
  symlinkSync(outside, join(root, 'out-link'));
  const shallow = await listTree(root, '', 1, 100);
  assert.ok(shallow.ok);
  assert.deepEqual(shallow.entries.map((e) => [e.path, e.type]), [['.git', 'dir'], ['a', 'dir'], ['out-link', 'symlink'], ['z.txt', 'file']]);
  const deep = await listTree(root, '', 4, 100);
  assert.ok(deep.ok);
  assert.ok(deep.entries.some((e) => e.path === 'a/b/c/deep.txt'));
  assert.ok(!deep.entries.some((e) => e.path.startsWith('.git/')), 'nothing under .git');
  assert.ok(!deep.entries.some((e) => e.path.startsWith('out-link/')), 'symlinked directories are not followed');
  const limited = await listTree(root, '', 4, 3);
  assert.ok(limited.ok && limited.entries.length === 3 && limited.truncated);
  assert.deepEqual(await listTree(root, 'z.txt', 1, 10), { ok: false, reason: 'not_a_directory' });
  assert.deepEqual(await listTree(root, 'out-link', 1, 10), { ok: false, reason: 'path_outside_repo' });
  assert.deepEqual(await listTree(root, 'nope', 1, 10), { ok: false, reason: 'not_found' });
});

test('countFiles: regular files only, nothing under .git, manifests at the root, extensions counted', async (t) => {
  const root = makeRepo(t, { 'package.json': '{}', 'src/a.ts': '', 'src/b.ts': '', 'README': '' });
  mkdirSync(join(root, 'node_x'));
  symlinkSync('src/a.ts', join(root, 'sym.ts'));
  const counted = await countFiles(root);
  assert.equal(counted.files, 4);
  assert.deepEqual(counted.manifests, ['package.json']);
  assert.equal(counted.byExtension.get('ts'), 2);
  assert.equal(counted.byExtension.get('json'), 1);
});
