// 외부 부작용 초안의 도메인 도우미(ADR-0015): 조회·해시 항목·전이·메시지 미리보기.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DRAFT_LIMITS, draftSubjectEntries, HOST_DISPATCH_ADAPTER, messagePreviewOf, proposedDraftsOf, transitionDrafts,
  TransitionError, type Db, type EffectDraftRow,
} from '@aot/domain';

import { queuedTask } from '../support/engine.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

function draftRow(over: Partial<EffectDraftRow>): EffectDraftRow {
  return {
    id: 'd1', task_id: 't1', task_run_id: 'r1', seq: 1, tool: 'message', action: 'send', target: 'mailbox:example', step_id: 's1',
    payload: '{"x":1}', payload_hash: 'h1', effect_key: 'k1', influenced_by_external_input: 0, state: 'pending',
    created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-04T00:00:00.000Z', at: '2026-01-01T00:00:00.000Z', ...over,
  };
}

/** 시드된 DB 에 업무 하나와 끝난 run 둘(r1, r2)을 만든다. 초안 행의 외래 키를 맞추려는 것이다. */
function seedDb(t: Parameters<typeof seededDb>[0]): Db {
  const { db, clock } = seededDb(t);
  const actorId = addAgent(db, clock);
  queuedTask(db, clock, {}, 't1');
  queuedTask(db, clock, { trigger: { kind: 'manual', ref: 'actor:other-owner' } }, 'other');
  db.writeTx((tx) => {
    for (const [id, attempt] of [['r1', 1], ['r2', 2]] as const) {
      tx.run(
        `INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, outcome)
         VALUES (?, 't1', ?, ?, 'fake-adapter', ?, ?, 'w1', ?, ?, 'killed')`,
        [id, attempt, actorId, clock.nowIso(), clock.nowIso(), clock.nowIso(), clock.nowIso()],
      );
    }
    tx.run(
      `INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, outcome)
       VALUES ('r-other', 'other', 1, ?, 'fake-adapter', ?, ?, 'w1', ?, ?, 'killed')`,
      [actorId, clock.nowIso(), clock.nowIso(), clock.nowIso(), clock.nowIso()],
    );
  });
  return db;
}

function insert(db: Db, row: EffectDraftRow): void {
  db.writeTx((tx) => tx.run(
    `INSERT INTO effect_draft (id, task_id, task_run_id, seq, tool, action, target, step_id, payload, payload_hash, effect_key,
      influenced_by_external_input, state, created_at, expires_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.task_id, row.task_run_id, row.seq, row.tool, row.action, row.target, row.step_id, row.payload, row.payload_hash,
      row.effect_key, row.influenced_by_external_input, row.state, row.created_at, row.expires_at, row.at],
  ));
}

test('constants', () => {
  assert.equal(HOST_DISPATCH_ADAPTER, 'host:dispatch');
  assert.deepEqual(DRAFT_LIMITS, { perRun: 20, payloadBytes: 262144 });
});

test('proposedDraftsOf returns only proposed drafts of the task in seq order', (t) => {
  const db = seedDb(t);
  {
    insert(db, draftRow({ id: 'a', seq: 2, effect_key: 'ka', state: 'proposed' }));
    insert(db, draftRow({ id: 'b', seq: 1, effect_key: 'kb', state: 'proposed' }));
    insert(db, draftRow({ id: 'c', seq: 3, effect_key: 'kc', state: 'pending' }));
    insert(db, draftRow({ id: 'd', seq: 4, effect_key: 'kd', state: 'superseded' }));
    insert(db, draftRow({ id: 'e', seq: 5, effect_key: 'ke', state: 'proposed', task_id: 'other', task_run_id: 'r-other' }));
    assert.deepEqual(proposedDraftsOf(db, 't1').map((r) => r.id), ['b', 'a']);
    assert.deepEqual(proposedDraftsOf(db, 'none'), []);
  }
});

test('draftSubjectEntries has the documented shape, sorted by seq, without the payload body', () => {
  const entries = draftSubjectEntries([draftRow({ id: 'b', seq: 2 }), draftRow({ id: 'a', seq: 1 })]);
  assert.deepEqual(entries.map((e) => e.draft_id), ['a', 'b']);
  assert.deepEqual(Object.keys(entries[0]!).sort(), ['action', 'draft_id', 'expires_at', 'payload_hash', 'seq', 'step_id', 'target', 'tool']);
  assert.deepEqual(draftSubjectEntries([]), []);
});

test('transitionDrafts follows the table, counts changed rows and can be limited to one run', (t) => {
  const db = seedDb(t);
  {
    insert(db, draftRow({ id: 'a', seq: 1, effect_key: 'ka', state: 'pending', task_run_id: 'r1' }));
    insert(db, draftRow({ id: 'b', seq: 1, effect_key: 'kb', state: 'pending', task_run_id: 'r2' }));
    const now = '2026-01-02T00:00:00.000Z';
    assert.equal(db.writeTx((tx) => transitionDrafts(tx, { taskId: 't1', from: ['pending'], to: 'proposed', by: 'validator', now, runId: 'r1' })), 1);
    assert.equal(db.get<{ state: string; at: string }>("SELECT state, at FROM effect_draft WHERE id = 'a'")?.state, 'proposed');
    assert.equal(db.get<{ state: string }>("SELECT state FROM effect_draft WHERE id = 'b'")?.state, 'pending');
    assert.equal(db.writeTx((tx) => transitionDrafts(tx, { taskId: 't1', from: ['pending', 'proposed'], to: 'superseded', by: 'scheduler', now })), 2);
    assert.equal(db.writeTx((tx) => transitionDrafts(tx, { taskId: 't1', from: ['pending'], to: 'superseded', by: 'scheduler', now })), 0);
  }
});

test('transitionDrafts rejects transitions outside the table and agents', (t) => {
  const db = seedDb(t);
  {
    const now = '2026-01-02T00:00:00.000Z';
    for (const bad of [
      { from: ['pending'], to: 'rejected', by: 'human' },
      { from: ['proposed'], to: 'pending', by: 'scheduler' },
      { from: ['pending'], to: 'proposed', by: 'human' },
      { from: ['superseded'], to: 'proposed', by: 'validator' },
      { from: ['proposed'], to: 'rejected', by: 'agent' },
    ] as const) {
      assert.throws(
        () => db.writeTx((tx) => transitionDrafts(tx, { taskId: 't1', from: bad.from, to: bad.to, by: bad.by, now })),
        TransitionError, `${bad.from}->${bad.to} by ${bad.by}`,
      );
    }
  }
});

test('messagePreviewOf reads message-shaped payloads only', () => {
  assert.deepEqual(
    messagePreviewOf({ to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'], subject: 'Hello', text: '\n  First line \nSecond' }),
    { recipients: ['a@example.com', 'b@example.com', 'c@example.com'], subject: 'Hello', firstLine: 'First line' },
  );
  assert.deepEqual(messagePreviewOf({ to: [], subject: ' ', text: '' }), { recipients: [], subject: null, firstLine: null });
  for (const bad of [null, 'text', [], {}, { to: 'a@example.com', subject: 's', text: 't' }, { to: ['a'], subject: 1, text: 't' },
    { to: ['a'], subject: 's' }, { to: ['a'], subject: 's', text: 't', cc: 'x' }, { to: [1], subject: 's', text: 't' }]) {
    assert.equal(messagePreviewOf(bad), null, JSON.stringify(bad));
  }
});
