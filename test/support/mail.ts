// 메일 시험 공용 (ADR-0017): 연락처·원장 행을 직접 넣는 도우미.
import type { FakeClock } from '@aot/domain';
import type { Db } from '@aot/domain';

import { addAgent } from './seeded-db.ts';
import { queuedTask } from './engine.ts';

export const SENDER_ADDRESS = 'support@sender.example.com';
export const SENDERS = { support: { address: SENDER_ADDRESS } } as const;
export const UNSUBSCRIBE = 'unsubscribe@sender.example.com';
export const OWNER = 'actor-owner';

export const mailPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  from: SENDER_ADDRESS, to: ['customer@example.com'], subject: 'Hello', text: 'First line\nSecond line', ...over,
});

export function addContact(db: Db, clock: FakeClock, address: string, status: 'active' | 'suppressed' = 'active'): void {
  db.writeTx((tx) => tx.run(
    'INSERT INTO contact (address, label, status, added_by, added_at, suppressed_by, suppressed_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
    [address, status, OWNER, clock.nowIso(), status === 'suppressed' ? OWNER : null, status === 'suppressed' ? clock.nowIso() : null],
  ));
}

export const contactRow = (db: Db, address: string) =>
  db.get<{ status: string; suppressed_by: string | null; suppressed_at: string | null; added_by: string }>('SELECT status, suppressed_by, suppressed_at, added_by FROM contact WHERE address = ?', [address]);

export const eventsOf = (db: Db, type: string) =>
  db.all<{ source: string; external_id: string; payload: string; idempotency_key: string }>('SELECT source, external_id, payload, idempotency_key FROM event WHERE type = ? ORDER BY received_at, id', [type]);

/** `mail_send` 원장 행을 직접 넣는다 (하루 상한 시험). 업무·run 은 하나를 만들어 재사용한다 */
export function ledgerFixture(db: Db, clock: FakeClock): { insert(key: string, state: string, at: string, tool?: string): void } {
  addAgent(db, clock);
  const taskId = queuedTask(db, clock);
  db.writeTx((tx) => tx.run(
    `INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, lease_owner, lease_expires_at, heartbeat_at, outcome) VALUES ('run-fixture', ?, 1, 'actor-agent-1', 'fake', ?, 'w', ?, ?, 'submitted')`,
    [taskId, clock.nowIso(), clock.nowIso(), clock.nowIso()],
  ));
  let n = 0;
  return {
    insert(key, state, at, tool = 'mail_send') {
      n += 1;
      db.writeTx((tx) => tx.run(
        `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, idempotency_retention_ms, planned_at, at)
         VALUES (?, ?, ?, 'run-fixture', ?, 'send', 'mail:support', 'h', ?, 0, NULL, ?, ?)`,
        [`effect-fixture-${n}`, key, taskId, tool, state, at, at],
      ));
    },
  };
}
