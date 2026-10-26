// A6-U13: 데몬 조립의 측정 채널. 승인 소켓 처리기 조합이 `measure`·`measurements` 만 측정 채널로 보내고 나머지는 승인 엔진으로 넘긴다.
// 평가 포트가 있으면 측정 값 조회기가 연결되어 측정을 기다리던 업무의 평가에 효과가 들어간다. (소켓·CLI 프로세스 경로는 통합 시험 daemon-measurement)
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { createTask, type TaskExecutor } from '@aot/task-engine';

import { assembleDaemon, type AssembleOptions } from '../../apps/daemon/src/assemble.ts';
import { manualTimers } from '../support/engine.ts';
import { FakeFetcher } from '../support/evaluation.ts';
import { AFTER_W43, PACK_SIGNAL, W43_KEY } from '../support/measurement.ts';
import { readOnlyDraft } from '../support/policy.ts';
import { REPO_ROOT } from '../support/schema-snapshot.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const OWNER = 'actor-owner';
const SHA = 'd'.repeat(64);
const completes: TaskExecutor = { execute: async () => ({ result: { summary: 'example plan' } }) };

function rig(t: TestContext, extra: Partial<AssembleOptions> = { measurementSignals: [PACK_SIGNAL] }) {
  const { db, clock } = seededDb(t);
  clock.set(AFTER_W43);
  const agent = addAgent(db, clock);
  const dir = makeTempDir(t);
  const daemon = assembleDaemon({
    db, clock, workerId: 'w1', actorId: agent, executor: completes, timers: manualTimers(),
    paths: { policyStoreDir: join(dir, 'policies'), totpDir: join(dir, 'totp'), approvalSocket: join(dir, 'run', 'approval.sock') },
    ...extra,
  });
  return { db, clock, agent, daemon };
}

const measure = (extra: Record<string, unknown> = {}) => ({
  cmd: 'measure', actor: OWNER, signal: PACK_SIGNAL.id, value: 9, observations: 2, quality: 'good',
  attachments: [{ ref: 'file:/example/week-43.png', sha256: SHA }], ...extra,
});

describe('the measurement channel on the approval socket handler', () => {
  it('refuses an agent actor at the authentication step, for both commands', (t) => {
    const { daemon, agent } = rig(t);
    for (const request of [measure({ actor: agent }), { cmd: 'measurements', actor: agent }]) {
      const response = daemon.handleChannelRequest(request) as { ok: boolean; error: string };
      assert.equal(response.ok, false);
      assert.match(response.error, /only human actors/);
    }
  });

  it('records a value from a human, lists waiting tasks with their reason, and leaves other commands to the approval engine', (t) => {
    const { db, clock, daemon } = rig(t);
    const taskId = createTask(db, { clock, gate: daemon.gate }, { spec: readOnlyDraft({ inputs: [{ name: 'conversions', ref: W43_KEY, kind: 'measurement' }] }) }).taskId;
    const listed = daemon.handleChannelRequest({ cmd: 'measurements', actor: OWNER }) as { ok: boolean; waiting: { taskId: string; reason: string }[]; signals: { id: string }[] };
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.waiting.map((w) => w.taskId), [taskId]);
    assert.match(listed.waiting[0]!.reason, /^measurement_pending: /);
    assert.deepEqual(listed.signals.map((s) => s.id), [PACK_SIGNAL.id]);

    const recorded = daemon.handleChannelRequest(measure({ minutes: 4 })) as Record<string, unknown>;
    assert.equal(recorded['ok'], true, JSON.stringify(recorded));
    assert.equal(recorded['created'], true);
    assert.equal(recorded['key'], W43_KEY);
    assert.deepEqual(recorded['attached_to'], [taskId]);
    assert.equal((daemon.handleChannelRequest(measure({ minutes: 4 })) as Record<string, unknown>)['created'], false);
    const conflict = daemon.handleChannelRequest(measure({ value: 10 })) as { ok: boolean; code: string };
    assert.deepEqual([conflict.ok, conflict.code], [false, 'conflict']);
    assert.deepEqual((daemon.handleChannelRequest({ cmd: 'measurements', actor: OWNER }) as { waiting: unknown[] }).waiting, []);
    assert.deepEqual(daemon.handleChannelRequest({ cmd: 'whoami', actor: OWNER }), { ok: true, actor: OWNER, kind: 'human' });
  });

  it('refuses unknown signals, unknown fields, a missing attachment and a week that has not ended', (t) => {
    const { daemon } = rig(t);
    const error = (request: unknown) => (daemon.handleChannelRequest(request) as { error: string }).error;
    assert.match(error(measure({ signal: 'other-signal' })), /unknown measurement signal/);
    assert.match(error(measure({ note: 'x' })), /unknown field\(s\): note/);
    assert.match(error(measure({ attachments: [] })), /attachment_required/);
    assert.match(error(measure({ week: '2026-W44' })), /week_not_ended/);
    assert.match(error(measure({ value: '9' })), /invalid_value/);
  });

  it('without measurement signals the channel says so; signals from a pack and from the option together are refused', (t) => {
    const { daemon } = rig(t, {});
    assert.equal(daemon.measurementSignals.length, 0);
    assert.match((daemon.handleChannelRequest(measure()) as { error: string }).error, /no measurement signal is defined/);
    assert.throws(() => rig(t, { measurementSignals: [PACK_SIGNAL], pack: { dir: join(REPO_ROOT, 'packs', 'example-marketing'), values: {} } }), /either through the pack or through measurementSignals/);
  });
});

describe('the measurement signal source in the assembled validator', () => {
  it('a task waits, runs on the next tick after the value is recorded, and its evaluation reads the recorded value', async (t) => {
    const { db, clock, daemon } = rig(t, { measurementSignals: [{ ...PACK_SIGNAL, pass_threshold: 5 }], evaluation: { fetcher: new FakeFetcher() } });
    const taskId = createTask(db, { clock, gate: daemon.gate }, {
      spec: readOnlyDraft({ inputs: [{ name: 'conversions', ref: W43_KEY, kind: 'measurement' }], validation: { deterministic: [], llm: null, human: true } }),
    }).taskId;
    assert.equal((await daemon.worker.tick()).executed, null);
    assert.equal((daemon.handleChannelRequest(measure()) as { ok: boolean }).ok, true);
    assert.equal((await daemon.worker.tick()).executed?.taskId, taskId);
    const validated = await daemon.worker.tick();
    assert.equal(validated.validated[0]?.taskId, taskId);
    const evaluation = db.get<{ outcome: string; effect: number; effect_note: string }>('SELECT outcome, effect, effect_note FROM evaluation WHERE task_id = ?', [taskId])!;
    assert.deepEqual({ ...evaluation }, { outcome: 'pass', effect: 9, effect_note: 'met: mean 9 over 2 observation(s)' });
  });
});
