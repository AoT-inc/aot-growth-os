import { applyMigrations, FakeClock, openDb, seedPhaseA, type Db } from '@aot/domain';

import { MIGRATIONS_DIR } from './schema-snapshot.ts';

export const START = '2026-10-19T00:00:00.000Z';

/** 빈 DB 에 migrations/ 를 적용한다. (시드 전) */
export function migratedDb(t: { after(fn: () => void): void }, clock = new FakeClock(START)): { db: Db; clock: FakeClock } {
  const db = openDb({ path: ':memory:' });
  t.after(() => db.close());
  applyMigrations(db, { dir: MIGRATIONS_DIR, clock });
  return { db, clock };
}

/** migrations/ 적용 + Phase A 시드 */
export function seededDb(t: { after(fn: () => void): void }, clock = new FakeClock(START)): { db: Db; clock: FakeClock } {
  const result = migratedDb(t, clock);
  seedPhaseA(result.db, { clock });
  return result;
}

/** 시험용 에이전트 행위자 (시드에는 에이전트가 없다) */
export function addAgent(db: Db, clock: FakeClock, id = 'actor-agent-1'): string {
  db.writeTx((tx) =>
    tx.run('INSERT INTO actor (id, kind, name, adapter, created_at) VALUES (?, ?, ?, ?, ?)', [id, 'agent', 'example-agent', 'fake-adapter', clock.nowIso()]),
  );
  return id;
}
