// 데몬 조립과 팩 (A6-U10): `pack` 옵션이 있을 때와 없을 때. 루틴은 enabled=0 이라 켜기 전에는 발화하지 않는다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import type { Db } from '@aot/domain';
import type { TaskExecutor } from '@aot/task-engine';

import { assembleDaemon, type AssembleOptions } from '../../apps/daemon/src/assemble.ts';
import { PackLoadError, PackSyncError } from '../../apps/daemon/src/pack-loader.ts';
import { manualTimers } from '../support/engine.ts';
import { REPO_ROOT } from '../support/schema-snapshot.ts';
import { addAgent, seededDb, START } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const PACK_DIR = join(REPO_ROOT, 'packs', 'example-marketing');
const VALUES = { org_unit: 'core', product: 'example-product', research_source_url: 'https://docs.example.com/market-news', research_host: 'docs.example.com', baseline_week: '2026-W43' };
const MONDAY = '2026-10-26T00:00:00.000Z'; // 09:00 Asia/Seoul
const completes: TaskExecutor = { execute: async () => ({ result: { ok: true } }) };

function rig(t: TestContext, extra: Partial<AssembleOptions> = {}, product = true) {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  if (product) {
    db.writeTx((tx) => tx.run(
      "INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES ('product-example-product', 'example-product', 'example-product', 'software', 'live', 'registered', ?, ?)",
      [START, START],
    ));
  }
  const dir = makeTempDir(t);
  const daemon = () => assembleDaemon({
    db, clock, workerId: 'w1', actorId, executor: completes, timers: manualTimers(),
    paths: { policyStoreDir: join(dir, 'policies'), totpDir: join(dir, 'totp'), approvalSocket: join(dir, 'run', 'approval.sock') },
    ...extra,
  });
  return { db, clock, daemon };
}
const count = (db: Db, table: string): number => Number(db.get(`SELECT count(*) AS n FROM ${table}`)?.['n']);

describe('assembleDaemon without a pack: the previous behaviour', () => {
  it('has no pack, writes no routine, and the worker looks at no routine even if one is enabled', async (t) => {
    const { db, clock, daemon } = rig(t);
    const d = daemon();
    assert.equal(d.pack, null);
    assert.equal(d.packSync, null);
    assert.equal(count(db, 'routine'), 0);
    db.writeTx((tx) => tx.run(
      "INSERT INTO routine (id, slug, org_unit_id, schedule, task_template, catch_up, enabled) VALUES ('r', 'r', 'org-unit-core', '0 9 * * 1 Asia/Seoul', 'x@1', 'skip', 1)",
    ));
    clock.set(MONDAY);
    const report = await d.worker.tick();
    assert.deepEqual(report.routines, { fired: [], failed: [] });
    assert.equal(count(db, 'routine_firing'), 0);
  });
});

describe('assembleDaemon with a pack', () => {
  it('loads the pack, writes the routine disabled, and exposes the signals', (t) => {
    const { db, daemon } = rig(t, { pack: { dir: PACK_DIR, values: VALUES } });
    const d = daemon();
    assert.equal(d.pack?.manifest.name, 'example-marketing');
    assert.deepEqual(d.packSync, { created: ['weekly-market-research'], updated: [], unchanged: [] });
    assert.deepEqual(d.pack?.signals.map((s) => s.id), ['weekly-landing-conversions']);
    assert.deepEqual(db.all('SELECT slug, enabled FROM routine').map((r) => ({ ...r })), [{ slug: 'weekly-market-research', enabled: 0 }]);
  });

  it('assembling again (a daemon restart) changes nothing in the database', (t) => {
    const { db, daemon } = rig(t, { pack: { dir: PACK_DIR, values: VALUES } });
    daemon();
    const snapshot = JSON.stringify(db.all('SELECT * FROM routine'));
    const again = daemon();
    assert.deepEqual(again.packSync, { created: [], updated: [], unchanged: ['weekly-market-research'] });
    assert.equal(JSON.stringify(db.all('SELECT * FROM routine')), snapshot);
  });

  it('nothing fires while the routine is disabled, however long the daemon runs', async (t) => {
    const { db, clock, daemon } = rig(t, { pack: { dir: PACK_DIR, values: VALUES } });
    const d = daemon();
    for (const at of ['2026-10-25T12:00:00.000Z', MONDAY, '2026-10-27T00:00:00.000Z', '2026-11-02T00:00:00.000Z']) {
      clock.set(at);
      assert.deepEqual((await d.worker.tick()).routines, { fired: [], failed: [] });
    }
    assert.equal(count(db, 'routine_firing'), 0);
    assert.equal(count(db, 'task'), 0);
  });

  it('the template port is wired: once a routine is enabled (U15 does this), its slot creates the pack task', async (t) => {
    const { db, clock, daemon } = rig(t, { pack: { dir: PACK_DIR, values: VALUES } });
    const d = daemon();
    db.writeTx((tx) => tx.run("UPDATE routine SET enabled = 1 WHERE slug = 'weekly-market-research'"));
    clock.set('2026-10-25T12:00:00.000Z');
    assert.deepEqual((await d.worker.tick()).routines, { fired: [], failed: [] }, 'first sight of the routine: nothing happened before it was seen');
    clock.set(MONDAY);
    const { routines } = await d.worker.tick();
    assert.deepEqual(routines.failed, []);
    assert.equal(routines.fired.length, 1);
    assert.equal(routines.fired[0]?.scheduledFor, MONDAY);
    const [task] = db.all<{ objective: string; trigger_kind: string; trigger_ref: string; product_id: string | null; role_id: string | null }>(
      'SELECT objective, trigger_kind, trigger_ref, product_id, role_id FROM task',
    );
    assert.deepEqual({ ...task }, {
      objective: 'example-product 관련 시장의 지난 7일 주요 변화를 출처와 함께 정리한다',
      trigger_kind: 'routine', trigger_ref: `weekly-market-research@${MONDAY}`, product_id: 'product-example-product', role_id: 'role-generalist',
    });
  });

  it('a pack that cannot be loaded or applied stops the assembly (fail closed)', (t) => {
    const { db, daemon } = rig(t, { pack: { dir: PACK_DIR, values: { ...VALUES, research_host: '' } } });
    assert.throws(() => daemon(), PackLoadError);
    assert.equal(count(db, 'routine'), 0);
    const missingProduct = rig(t, { pack: { dir: PACK_DIR, values: VALUES } }, false);
    assert.throws(() => missingProduct.daemon(), (error: unknown) => error instanceof PackSyncError && error.code === 'unknown_product');
    assert.equal(count(missingProduct.db, 'routine'), 0);
  });
});
