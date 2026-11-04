// 초안 단계(draft) run (ADR-0015 W5): 보내지 않고 effect_draft 에 남긴다 (I1). 승인 방식 계산, 상한, 펜싱, 이전 초안 폐기.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson, DRAFT_LIMITS, sha256Hex, type TaskSpec } from '@aot/domain';
import {
  beginDispatch, claimNextTask, DraftRefusedError, effectApprovalOf, effectKeyOf, failRun, LeaseLostError, performEffect, promoteDueRetries, recordDraft,
  TaskWorker, type EffectOutcome, type Lease, type RunContext,
} from '@aot/task-engine';

import { draftsOf } from '../support/drafts.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { createFakeMessageTool, examplePayload, MESSAGE_TARGET, MESSAGE_TOOL } from '../support/message-tool.ts';
import { AGENT, createWithGate, effectDraft, policyEnv, readOnlyDraft } from '../support/policy.ts';

const LEASE_MS = 60_000;
const step = (stepId: string, request: unknown = examplePayload(), target = MESSAGE_TARGET) => ({ stepId, action: 'send', target, request });

function setup(t: Parameters<typeof policyEnv>[0], approval: 'draft' | 'scope' = 'draft') {
  const env = policyEnv(t);
  const fake = createFakeMessageTool({ approval });
  const taskId = createWithGate(env, effectDraft());
  const claim = (workerId = 'w1'): { lease: Lease; phase: string } => {
    const result = claimNextTask(env.db, {
      clock: env.clock, gate: env.gate, workerId, actorId: AGENT, adapter: 'fake-adapter', leaseMs: LEASE_MS, taskId,
      effectApprovalOf: () => 'draft',
    });
    assert.ok(result.claimed, 'a draft run is claimed without approval');
    return { lease: result.claimed.lease, phase: result.claimed.phase };
  };
  const worker = (execute: (ctx: RunContext) => Promise<unknown>) => new TaskWorker({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', gate: env.gate, tools: { [MESSAGE_TOOL]: fake.tool },
    executor: { execute: async (ctx) => ({ result: await execute(ctx) }) }, timers: manualTimers(),
  });
  return { env, fake, taskId, claim, worker };
}

test('effectApprovalOf: draft only when every external-effect request is a registered approval:draft action', () => {
  const draftTool = createFakeMessageTool().tool;
  const scopeTool = createFakeMessageTool({ approval: 'scope' }).tool;
  const spec = (tools: unknown[]): TaskSpec => ({ allowed_tools: tools }) as unknown as TaskSpec;
  const mail = { tool: MESSAGE_TOOL, operations: ['send'], scope: 'customer', impact: 'external_effect', target: MESSAGE_TARGET };
  const read = { tool: 'web_search', operations: ['search'], scope: 'internal', impact: 'read' };
  assert.equal(effectApprovalOf(spec([read, mail]), { [MESSAGE_TOOL]: draftTool }), 'draft');
  assert.equal(effectApprovalOf(spec([mail]), { [MESSAGE_TOOL]: scopeTool }), 'scope');
  assert.equal(effectApprovalOf(spec([mail]), {}), 'scope', 'an unregistered tool is scope');
  assert.equal(effectApprovalOf(spec([mail]), undefined), 'scope');
  assert.equal(effectApprovalOf(spec([read]), { [MESSAGE_TOOL]: draftTool }), 'scope', 'no external effect requested');
  assert.equal(effectApprovalOf(spec([{ ...mail, operations: ['send', 'unknown_op'] }]), { [MESSAGE_TOOL]: draftTool }), 'scope', 'an undeclared operation is scope');
  assert.equal(effectApprovalOf(spec([mail, { ...mail, tool: 'phone_call' }]), { [MESSAGE_TOOL]: draftTool }), 'scope', 'one scope/unknown tool makes the task scope');
});

test('a draft run sends nothing: drafts are stored with payload bytes, payload_hash and effect_key (I1)', async (t) => {
  const { env, fake, taskId, worker } = setup(t);
  const outcomes: EffectOutcome[] = [];
  const request1 = examplePayload({ subject: 'one' });
  const request2 = examplePayload({ subject: 'two', cc: ['cc@example.com'] });
  const report = await worker(async (ctx) => {
    assert.equal(ctx.phase, 'draft');
    outcomes.push(await ctx.performEffect(MESSAGE_TOOL, step('s1', request1), { influenced: false }));
    outcomes.push(await ctx.performEffect(MESSAGE_TOOL, step('s2', request2), { influenced: true }));
    return {};
  }).tick();
  assert.equal(report.executed?.end !== 'lease_lost' && report.executed?.end.taskStatus, 'validating');
  assert.equal(fake.sent.length, 0, 'tool.send was not called');
  assert.equal(env.db.get('SELECT count(*) AS n FROM external_effect')?.['n'], 0, 'the effect ledger has no rows');
  const rows = draftsOf(env.db, taskId);
  assert.deepEqual(rows.map((r) => [r.seq, r.state, r.step_id, r.influenced_by_external_input]), [[1, 'pending', 's1', 0], [2, 'pending', 's2', 1]]);
  assert.deepEqual(outcomes, rows.map((r) => ({ state: 'drafted', draftId: r.id })));
  assert.equal(rows[0]!.payload, canonicalJson(request1), 'payload is the canonical JSON string of the request');
  assert.equal(rows[0]!.payload_hash, sha256Hex(rows[0]!.payload));
  assert.equal(rows[0]!.effect_key, effectKeyOf(taskId, 's1', JSON.parse(rows[0]!.payload)));
  assert.equal(rows[0]!.tool, MESSAGE_TOOL);
  assert.equal(rows[0]!.target, MESSAGE_TARGET);
  assert.equal(rows[0]!.expires_at, '2026-10-22T00:00:00.000Z', 'default 72h');
  assert.equal(taskStatus(env.db, taskId), 'validating');
  assert.deepEqual(env.db.all('SELECT decision FROM policy_decision WHERE task_run_id IS NOT NULL'), [], 'no effect-time decision: the ledger gate was never reached');
});

test('the same step in the same run is drafted once (the existing row is returned)', async (t) => {
  const { env, taskId, worker } = setup(t);
  const ids: string[] = [];
  await worker(async (ctx) => {
    for (let i = 0; i < 3; i += 1) {
      const outcome = await ctx.performEffect(MESSAGE_TOOL, step('s1'));
      assert.equal(outcome.state, 'drafted');
      if (outcome.state === 'drafted') ids.push(outcome.draftId);
    }
    await ctx.performEffect(MESSAGE_TOOL, step('s1', examplePayload({ subject: 'changed' })));
    return {};
  }).tick();
  assert.equal(new Set(ids).size, 1);
  assert.equal(draftsOf(env.db, taskId).length, 2, 'a different request is a new draft; the first row is unchanged');
});

test('limits: at most 20 drafts per run and 256 KiB per payload; the refused call leaves no row', async (t) => {
  const { env, taskId, worker } = setup(t);
  const refused: string[] = [];
  await worker(async (ctx) => {
    for (let i = 0; i < DRAFT_LIMITS.perRun; i += 1) await ctx.performEffect(MESSAGE_TOOL, step(`s${i}`, examplePayload({ subject: `m${i}` })));
    for (const attempt of [step('over', examplePayload({ subject: 'over' })), step('big', examplePayload({ text: 'x'.repeat(DRAFT_LIMITS.payloadBytes) }))]) {
      try {
        await ctx.performEffect(MESSAGE_TOOL, attempt);
      } catch (error) {
        refused.push(error instanceof DraftRefusedError ? error.code : String(error));
      }
    }
    return {};
  }).tick();
  assert.deepEqual(refused, ['too_many_drafts', 'payload_too_large']);
  assert.equal(draftsOf(env.db, taskId).length, DRAFT_LIMITS.perRun);
});

test('a run that lost its lease cannot leave a draft', (t) => {
  const { env, taskId, fake, claim } = setup(t);
  const { lease } = claim();
  env.clock.advance(LEASE_MS);
  assert.throws(() => recordDraft(env.db, env.clock, lease, fake.tool, step('s1')), LeaseLostError);
  assert.equal(draftsOf(env.db, taskId).length, 0);
});

test('a scope action cannot be drafted, nor a target outside allowed_tools, nor a call from a non-draft run', (t) => {
  const { env, taskId, claim } = setup(t, 'scope');
  const { lease } = claim();
  const scopeTool = createFakeMessageTool({ approval: 'scope' }).tool;
  assert.throws(() => recordDraft(env.db, env.clock, lease, scopeTool, step('s1')), (e: unknown) => e instanceof DraftRefusedError && e.code === 'scope_action');
  const draftTool = createFakeMessageTool().tool;
  assert.throws(() => recordDraft(env.db, env.clock, lease, draftTool, step('s1', examplePayload(), 'mailbox:other')), (e: unknown) => e instanceof DraftRefusedError && e.code === 'out_of_scope');
  assert.throws(() => recordDraft(env.db, env.clock, { ...lease, phase: 'execute' }, draftTool, step('s1')), (e: unknown) => e instanceof DraftRefusedError && e.code === 'not_draft_phase');
  assert.equal(draftsOf(env.db, taskId).length, 0);
});

test('the ledger refuses to dispatch from a draft run, so a draft run cannot send even by calling it directly (I1)', async (t) => {
  const { env, fake, claim, taskId } = setup(t);
  const { lease } = claim();
  await assert.rejects(() => performEffect(env.db, env.clock, lease, fake.tool, step('s1'), env.gate), /draft-phase run/);
  assert.equal(fake.sent.length, 0);
  assert.equal(taskStatus(env.db, taskId), 'running');
  assert.throws(() => beginDispatch(env.db, env.clock, lease, { id: 'x', state: 'planned' }, env.gate), /draft-phase run/);
});

test('a draft run that ends without being submitted discards its pending drafts', (t) => {
  const { env, taskId, fake, claim } = setup(t);
  const first = claim().lease;
  recordDraft(env.db, env.clock, first, fake.tool, step('s1'));
  recordDraft(env.db, env.clock, first, fake.tool, step('s2', examplePayload({ subject: 'b' })));
  failRun(env.db, env.clock, first, { outcome: 'error', reason: 'x', retryDelayMs: 1 });
  assert.deepEqual(draftsOf(env.db, taskId).map((r) => r.state), ['superseded', 'superseded']);
  env.clock.advance(1);
  assert.deepEqual(promoteDueRetries(env.db, env.clock), [taskId]);
  const second = claim('w2').lease;
  recordDraft(env.db, env.clock, second, fake.tool, step('s1'));
  const rows = draftsOf(env.db, taskId);
  assert.equal(rows.filter((r) => r.state === 'pending').length, 1, 'only the new run has a live draft');
  assert.equal(rows.find((r) => r.state === 'pending')!.task_run_id, second.runId);
});

test('starting a draft run discards the proposed drafts of earlier runs in the same transaction', (t) => {
  const { env, taskId, fake, claim } = setup(t);
  const first = claim().lease;
  recordDraft(env.db, env.clock, first, fake.tool, step('s1'));
  env.db.writeTx((tx) => tx.run("UPDATE effect_draft SET state = 'proposed'"));
  failRun(env.db, env.clock, first, { outcome: 'error', reason: 'x', retryDelayMs: 1 });
  assert.deepEqual(draftsOf(env.db, taskId).map((r) => r.state), ['proposed'], 'a proposed draft survives a failed run');
  env.clock.advance(1);
  promoteDueRetries(env.db, env.clock);
  // 정책 게이트는 제안된 초안이 있으면 전송 단계로만 보낸다. 여기서는 초안 단계를 강제하는 게이트로 claim 의 정리만 본다.
  const forced = { ...env.gate, beforeRun: () => ({ decision: 'allow' as const, phase: 'draft' as const }) };
  const result = claimNextTask(env.db, { clock: env.clock, gate: forced, workerId: 'w2', actorId: AGENT, adapter: 'fake-adapter', leaseMs: LEASE_MS, taskId });
  assert.equal(result.claimed?.phase, 'draft');
  assert.deepEqual(draftsOf(env.db, taskId).map((r) => r.state), ['superseded']);
});

test('a task without draft support is untouched: no effectApprovalOf means the old execute phase and an unchanged approval need', (t) => {
  const env = policyEnv(t);
  const id = createWithGate(env, effectDraft());
  const result = claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', leaseMs: LEASE_MS, taskId: id });
  assert.equal(result.claimed, null, 'still needs the spec approval');
  assert.equal(taskStatus(env.db, id), 'needs_review');
  const ro = createWithGate(env, readOnlyDraft(), { dedupeKey: 'read-only' });
  const claimed = claimNextTask(env.db, { clock: env.clock, gate: env.gate, workerId: 'w1', actorId: AGENT, adapter: 'fake-adapter', leaseMs: LEASE_MS, taskId: ro, effectApprovalOf: () => 'draft' });
  assert.equal(claimed.claimed?.phase, 'execute');
  assert.equal(claimed.claimed?.lease.phase, 'execute');
});
