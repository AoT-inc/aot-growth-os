// 등록 도구의 저장소 바인딩(registration.ts): 에이전트는 경로를 주지 못한다 — 명세의 `repo:<slug>` 대상 하나와 product_repo 가 정한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RepoToolError } from '@aot/agent-runtime';

import { bindRepo, repoSlugOf } from '../../apps/daemon/src/registration.ts';
import { addProduct } from '../support/evaluation.ts';
import { seededDb } from '../support/seeded-db.ts';

const tool = (name: string, target?: string) => ({ tool: name, operations: ['x'], scope: 'internal' as const, impact: 'read' as const, ...(target === undefined ? {} : { target }) });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof RepoToolError ? error.code : `other:${String(error)}`;
  }
  return 'no error';
};

test('repoSlugOf: exactly one repo:<slug> across the registration tools; other tools are ignored', () => {
  assert.equal(repoSlugOf({ allowed_tools: [tool('repo_read', 'repo:example-product'), tool('secret_scan', 'repo:example-product'), tool('license_check', 'repo:example-product'), tool('web_search')] }), 'example-product');
  for (const allowed_tools of [
    [], [tool('web_search')], [tool('repo_read')], [tool('repo_read', 'mailbox:x')], [tool('repo_read', 'repo:a'), tool('secret_scan', 'repo:b')],
    [tool('repo_read', 'repo:../etc')], [tool('repo_read', 'repo:')], [tool('repo_read', 'repo:UPPER')], [tool('repo_read', 'repo:a b')],
  ]) {
    assert.equal(code(() => repoSlugOf({ allowed_tools })), 'repo_not_bound', JSON.stringify(allowed_tools));
  }
});

function withRepo(t: Parameters<typeof seededDb>[0], product: { status?: string; scope?: string; path?: string | null; second?: boolean } = {}) {
  const { db, clock } = seededDb(t);
  const productId = addProduct(db, clock, 'example-product');
  db.writeTx((tx) => {
    tx.run('UPDATE product SET registration_status = ? WHERE id = ?', [product.status ?? 'verifying', productId]);
    tx.run('INSERT INTO product_repo (id, product_id, name, local_path, access_scope) VALUES (?, ?, ?, ?, ?)', ['r1', productId, 'main', product.path === undefined ? '/srv/example/repo' : product.path, product.scope ?? 'read']);
    if (product.second === true) tx.run('INSERT INTO product_repo (id, product_id, name, local_path, access_scope) VALUES (?, ?, ?, ?, ?)', ['r2', productId, 'other', '/srv/example/other', 'read']);
  });
  return db;
}

test('bindRepo: opens only for a product under verification whose read access was approved, with one repository at an absolute path', (t) => {
  assert.deepEqual(bindRepo(withRepo(t), 'example-product'), { slug: 'example-product', root: '/srv/example/repo' });
  assert.deepEqual(bindRepo(withRepo(t, { scope: 'write_branch' }), 'example-product').root, '/srv/example/repo');
  assert.equal(code(() => bindRepo(withRepo(t, { scope: 'none' }), 'example-product')), 'repo_access_not_granted');
  for (const status of ['candidate', 'pending_approval', 'registered', 'rejected']) {
    assert.equal(code(() => bindRepo(withRepo(t, { status }), 'example-product')), 'repo_not_bound', status);
  }
  assert.equal(code(() => bindRepo(withRepo(t, { path: null }), 'example-product')), 'repo_not_bound');
  assert.equal(code(() => bindRepo(withRepo(t, { path: 'relative/repo' }), 'example-product')), 'repo_not_bound');
  assert.equal(code(() => bindRepo(withRepo(t, { second: true }), 'example-product')), 'repo_not_bound', 'ambiguous: two repositories');
  assert.equal(code(() => bindRepo(withRepo(t), 'unknown-product')), 'repo_not_bound');
});

test('bindRepo is re-evaluated at every call: revoking the access closes the tools at once', (t) => {
  const db = withRepo(t);
  assert.equal(bindRepo(db, 'example-product').root, '/srv/example/repo');
  db.writeTx((tx) => tx.run("UPDATE product_repo SET access_scope = 'none'"));
  assert.equal(code(() => bindRepo(db, 'example-product')), 'repo_access_not_granted');
});

test('bindRepo refuses a repository path that overlaps the daemon instance or evidence directory (it would expose other tasks\' evidence)', (t) => {
  const db = withRepo(t, { path: '/srv/example/instance/repos/example-product' });
  const forbidden = ['/srv/example/instance', '/srv/example/instance/evidence'];
  assert.equal(code(() => bindRepo(db, 'example-product', forbidden)), 'repo_not_bound', 'inside the instance directory');
  db.writeTx((tx) => tx.run("UPDATE product_repo SET local_path = '/srv/example'"));
  assert.equal(code(() => bindRepo(db, 'example-product', forbidden)), 'repo_not_bound', 'an ancestor of the instance directory');
  db.writeTx((tx) => tx.run("UPDATE product_repo SET local_path = '/srv/example/instance/evidence'"));
  assert.equal(code(() => bindRepo(db, 'example-product', forbidden)), 'repo_not_bound', 'the evidence directory itself');
  db.writeTx((tx) => tx.run("UPDATE product_repo SET local_path = '/srv/example-other/repo'"));
  assert.equal(bindRepo(db, 'example-product', forbidden).root, '/srv/example-other/repo', 'a sibling with a similar name is fine');
});
