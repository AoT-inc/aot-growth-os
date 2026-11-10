// WP5: 상품 저장소가 겹치면 안 되는 데몬 디렉터리 목록(apps/daemon/src/forbidden-roots.ts).
// 설정으로 인스턴스 밖에 둔 경로도 목록에 들어가는지, 상대 경로가 절대 경로로 바뀌는지를 고정한다.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { daemonForbiddenRoots } from '../../apps/daemon/src/forbidden-roots.ts';

const INSTANCE = '/srv/example/instance';

describe('daemonForbiddenRoots', () => {
  it('uses the instance defaults when only db_path is configured', () => {
    assert.deepEqual(daemonForbiddenRoots({ db_path: '/srv/example/instance/db/aot.sqlite' }, INSTANCE), [
      '/srv/example/instance/db/aot.sqlite',
      '/srv/example/instance/totp',
      '/srv/example/instance/policies',
      '/srv/example/instance/run/approval.sock',
    ]);
  });

  it('includes directories configured outside the instance (instead of the defaults)', () => {
    const roots = daemonForbiddenRoots(
      { db_path: '/data/example/aot.sqlite', totp_dir: '/secure/example/totp', policy_store_dir: '/etc/example/policies', approval_socket: '/var/run/example/approval.sock' },
      INSTANCE,
    );
    assert.deepEqual(roots, ['/data/example/aot.sqlite', '/secure/example/totp', '/etc/example/policies', '/var/run/example/approval.sock']);
    for (const root of roots) assert.ok(!root.startsWith(INSTANCE), `${root} must not fall back to the instance default`);
  });

  it('mixes configured and default entries per field', () => {
    const roots = daemonForbiddenRoots({ db_path: '/data/example/aot.sqlite', totp_dir: '/secure/example/totp' }, INSTANCE);
    assert.deepEqual(roots, ['/data/example/aot.sqlite', '/secure/example/totp', '/srv/example/instance/policies', '/srv/example/instance/run/approval.sock']);
  });

  it('returns absolute paths even for a relative configuration', () => {
    const roots = daemonForbiddenRoots({ db_path: 'db/aot.sqlite' }, 'instance');
    assert.deepEqual(roots, [resolve('db/aot.sqlite'), resolve('instance/totp'), resolve('instance/policies'), resolve('instance/run/approval.sock')]);
    for (const root of roots) assert.equal(root, resolve(root));
  });

  it('does not alter the configuration object', () => {
    const config = { db_path: 'db/aot.sqlite' };
    daemonForbiddenRoots(config, INSTANCE);
    assert.deepEqual(config, { db_path: 'db/aot.sqlite' });
  });
});
