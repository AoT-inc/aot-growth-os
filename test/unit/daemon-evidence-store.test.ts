// 호스트 근거 본문 저장소(evidence-store.ts): 내용 주소 방식, 0700/0600, 덮어쓰지 않음, 읽을 때 일반 파일만, 상한.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore, MAX_EVIDENCE_BYTES } from '../../apps/daemon/src/evidence-store.ts';
import { sha256 } from '../support/registration.ts';
import { makeTempDir } from '../support/temp.ts';

const row = (ref: string) => ({ id: 'ev-1', kind: 'document' as const, ref, content_hash: null });

test('put stores the body under its sha256 (once), returns the reference, and the reader gives the same text back', async (t) => {
  const dir = join(makeTempDir(t, 'aot-evstore-'), 'evidence');
  const store = createEvidenceStore({ dir });
  const first = store.put('hello 가나다');
  assert.equal(first.sha256, sha256('hello 가나다'));
  assert.equal(first.ref, `blob:sha256:${first.sha256}`);
  assert.deepEqual(store.put('hello 가나다'), first, 'the same body is stored once');
  assert.deepEqual(readdirSync(dir), [first.sha256]);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, first.sha256)).mode & 0o777, 0o600);
  assert.deepEqual(await store.reader.read(row(first.ref)), { readable: true, text: 'hello 가나다' });
});

test('an existing file is never overwritten; no temporary file is left behind', (t) => {
  const dir = join(makeTempDir(t, 'aot-evstore-'), 'evidence');
  const store = createEvidenceStore({ dir });
  const { sha256: hash } = store.put('original');
  writeFileSync(join(dir, hash), 'tampered', { mode: 0o600 });
  store.put('original');
  assert.equal(readdirSync(dir).length, 1);
  assert.equal(readdirSync(dir)[0], hash);
});

test('a directory that other users can reach is tightened to 0700; a body over the limit is refused', (t) => {
  const dir = join(makeTempDir(t, 'aot-evstore-'), 'evidence');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const store = createEvidenceStore({ dir });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.throws(() => store.put('x'.repeat(MAX_EVIDENCE_BYTES + 1)), /larger than/);
});

test('the reader refuses anything that is not a stored blob: other schemes, path tricks, missing files, symlinks', async (t) => {
  const dir = join(makeTempDir(t, 'aot-evstore-'), 'evidence');
  const store = createEvidenceStore({ dir });
  const outside = join(makeTempDir(t, 'aot-outside-'), 'secret.txt');
  writeFileSync(outside, 'outside');
  const hash = 'b'.repeat(64);
  symlinkSync(outside, join(dir, hash));
  const refused = async (ref: string) => (await store.reader.read(row(ref))).readable;
  assert.equal(await refused('https://example.com/x'), false);
  assert.equal(await refused('blob:sha256:../../etc/passwd'), false);
  assert.equal(await refused(`blob:sha256:${'c'.repeat(64)}`), false, 'missing');
  assert.equal(await refused(`blob:sha256:${hash}`), false, 'a symlink is not a regular file');
  assert.equal(await refused(`blob:sha256:${'B'.repeat(64)}`), false, 'uppercase hex is not a reference we produce');
});
