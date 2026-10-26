// 다중 프로세스 시나리오 예제 (phase-a §4 테스트 러너 항목, Q20).
// 같은 SQLite 파일을 여러 프로세스가 동시에 열어 쓴다 — 단일 프로세스 안의 동시성으로 대체하지 않는다.
// A2 의 "동시 워커 중 하나만 실행" 시험은 이 틀을 그대로 쓴다.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

import { openDb } from '@aot/domain';

import { createClaimDb } from '../support/claim-db.ts';

const WORKERS = 6;
const ITEMS = 50;

interface WorkerReport {
  workerId: string;
  won: number[];
  errors: string[];
}

function runWorker(dbPath: string, workerId: string, startAt: number): Promise<WorkerReport> {
  const child = fork(new URL('./workers/claim-worker.ts', import.meta.url), [dbPath, workerId, String(ITEMS), String(startAt)]);
  return new Promise((resolve, reject) => {
    child.once('message', (message) => resolve(message as WorkerReport));
    child.once('error', reject);
    child.once('exit', (code) => code === 0 || reject(new Error(`worker ${workerId} exited with ${code}`)));
  });
}

test(`${WORKERS} processes race for ${ITEMS} items on one SQLite file: exactly one winner each, no errors`, async (t) => {
  const { dbPath, db } = createClaimDb(t, ITEMS);
  const startAt = Date.now() + 1500;
  const reports = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => runWorker(dbPath, `w${i}`, startAt)),
  );

  assert.deepEqual(reports.flatMap((r) => r.errors), [], 'no SQLITE_BUSY may leak out of writeTx');
  const winners = reports.flatMap((r) => r.won);
  assert.equal(winners.length, ITEMS);
  assert.equal(new Set(winners).size, ITEMS, 'each item is won by exactly one process');
  assert.equal(db.get('SELECT n FROM claim_counter')?.['n'], ITEMS);
  assert.equal(db.get('SELECT count(*) AS n FROM claim_item WHERE owner IS NULL')?.['n'], 0);
});

test('a process killed with SIGKILL inside a write transaction leaves nothing behind and releases the lock', async (t) => {
  const { dbPath, db } = createClaimDb(t, 3);
  const child: ChildProcess = fork(new URL('./workers/hold-lock-worker.ts', import.meta.url), [dbPath]);
  t.after(() => child.kill('SIGKILL'));
  const [message] = await once(child, 'message');
  assert.equal(message, 'locked');

  // 잠금이 실제로 잡혀 있다: 짧은 busy_timeout 으로 쓰기를 시도하면 실패한다.
  const probe = openDb({ path: dbPath, busyTimeoutMs: 100 });
  assert.throws(() => probe.writeTx((tx) => tx.run('UPDATE claim_counter SET n = n + 1')), /locked/);
  probe.close();

  child.kill('SIGKILL');
  await once(child, 'exit');

  assert.equal(db.get('SELECT count(*) AS n FROM claim_item WHERE id = 999')?.['n'], 0, 'uncommitted insert is gone');
  db.writeTx((tx) => tx.run('UPDATE claim_counter SET n = n + 1'));
  assert.equal(db.get('SELECT n FROM claim_counter')?.['n'], 1, 'a new writer proceeds immediately');
});
