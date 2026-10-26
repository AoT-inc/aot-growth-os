// 열린 통화가 있는 `validating` 업무는 검증되지 않고 기다린다 (ADR-0014 §6): 전이도 시도 소모도 없다. 통화가 끝나면 다음 tick 에 검증된다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPhoneEvent, createOutboundCall, expireCall } from '@aot/domain';
import { listCallWaits, nextValidatingTask, TaskWorker, type TaskExecutor } from '@aot/task-engine';
import { createTaskValidator } from '@aot/evaluation';

import { ALLOW_ALL_GATE, manualTimers, taskStatus } from '../support/engine.ts';
import { FakeFetcher, submittedRun } from '../support/evaluation.ts';
import { COMPLETED_ANALYSIS, ev, FROM, phoneSpecOverrides, PROVIDER, TO, TRANSCRIPT } from '../support/phone.ts';
import { seededDb } from '../support/seeded-db.ts';

test('a task whose call is still open is not picked for validation; ending the call releases it', async (t) => {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: phoneSpecOverrides(), result: { summary: 'called' } });
  const other = submittedRun(db, clock, { spec: { trigger: { kind: 'manual', ref: 'actor:other' } }, result: { summary: 'no call here' }, worker: 'w2' });
  const call = createOutboundCall(db, clock, {
    provider: PROVIDER, to: TO, from: FROM, taskId: run.taskId, taskRunId: run.runId, actorId: null, orgUnitId: null, objective: 'qualify_lead',
    effectKey: 'f'.repeat(40), maxDurationSeconds: 600, allowTransfer: false, recording: false,
  }).call;
  assert.equal(taskStatus(db, run.taskId), 'validating');

  // 통화가 열려 있는 동안: 통화 없는 업무만 검증 대상이고, 통화 업무는 보류 목록에 오른다
  assert.equal(nextValidatingTask(db), other.taskId);
  assert.equal(nextValidatingTask(db, new Set([other.taskId])), null);
  assert.deepEqual(listCallWaits(db), [{ taskId: run.taskId, calls: [{ callId: call.id, status: 'queued', createdAt: call.createdAt }] }]);

  const validator = createTaskValidator({ db, clock, fetcher: new FakeFetcher() });
  const worker = new TaskWorker({
    db, clock, workerId: 'w9', actorId: 'actor-agent-1', adapter: 'fake', executor: { execute: () => Promise.reject(new Error('nothing to run')) } as TaskExecutor,
    gate: ALLOW_ALL_GATE, validator, timers: manualTimers(),
  });
  const first = await worker.validatePending();
  assert.deepEqual(first.validated.map((v) => v.taskId), [other.taskId]);
  assert.equal(taskStatus(db, run.taskId), 'validating', 'no transition while the call is open');
  const attempts = db.get<{ attempts: number }>('SELECT attempts FROM task WHERE id = ?', [run.taskId])!.attempts;
  assert.equal(Number(attempts), 0, 'waiting consumes no attempt');

  // 통화가 연결·종료되면 다음 tick 에 검증된다
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-w', clock.nowIso(), { callId: call.id }));
  applyPhoneEvent(db, clock, ev('phone.call.connected', 'p-w', clock.nowIso()));
  assert.deepEqual((await worker.validatePending()).validated, [], 'a connected call is still open');
  applyPhoneEvent(db, clock, ev('phone.call.completed', 'p-w', clock.nowIso(), { transcript: TRANSCRIPT, analysis: COMPLETED_ANALYSIS }));
  assert.deepEqual(listCallWaits(db), []);
  const second = await worker.validatePending();
  assert.deepEqual(second.validated.map((v) => [v.taskId, v.taskStatus]), [[run.taskId, 'completed']]);
  assert.equal(taskStatus(db, run.taskId), 'completed');
});

test('a call whose end is never reported is closed at its deadline, which turns the wait into an insufficient-evidence review', async (t) => {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: phoneSpecOverrides(), result: { summary: 'called' } });
  const call = createOutboundCall(db, clock, {
    provider: PROVIDER, to: TO, from: FROM, taskId: run.taskId, taskRunId: run.runId, actorId: null, orgUnitId: null, objective: 'qualify_lead',
    effectKey: 'g'.repeat(40), maxDurationSeconds: 60, allowTransfer: false, recording: false,
  }).call;
  applyPhoneEvent(db, clock, ev('phone.call.initiated', 'p-lost', clock.nowIso(), { callId: call.id }));
  const worker = new TaskWorker({
    db, clock, workerId: 'w9', actorId: 'actor-agent-1', adapter: 'fake', executor: { execute: () => Promise.reject(new Error('x')) } as TaskExecutor,
    gate: ALLOW_ALL_GATE, validator: createTaskValidator({ db, clock, fetcher: new FakeFetcher() }), timers: manualTimers(),
  });
  assert.equal((await worker.validatePending()).validated.length, 0);
  clock.advance(10 * 60_000);
  expireCall(db, clock, call.id);
  const done = await worker.validatePending();
  assert.equal(done.validated.length, 1);
  assert.equal(taskStatus(db, run.taskId), done.validated[0]!.taskStatus);
  assert.notEqual(taskStatus(db, run.taskId), 'completed');
});
