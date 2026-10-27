// docs/schema/state-machines.md 의 허용표와 "금지된 전이" 를 고정한다.
// 기대 전이 목록은 문서에서 따로 옮겨 적은 것이다 (구현의 규칙 배열을 재사용하지 않는다).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertTransition, checkTransition, EXTERNAL_EFFECT_MACHINE, isTaskTerminal, NON_AGENT_ACTORS, ORG_PROPOSAL_MACHINE,
  PRODUCT_LIFECYCLE_MACHINE, PRODUCT_REGISTRATION_MACHINE, PUBLICATION_MACHINE, ROLE_MACHINE, STRATEGY_MACHINE,
  TASK_MACHINE, TransitionError, reachableFrom,
  type StateMachine, type TransitionActor,
} from '@aot/domain';

type Pair = readonly [from: string | null, to: string];

const TASK_ALLOWED: Pair[] = [
  [null, 'queued'], [null, 'unassigned'], ['unassigned', 'queued'],
  ['queued', 'running'], ['queued', 'needs_review'],
  ['running', 'validating'], ['running', 'queued'], ['running', 'needs_review'], ['running', 'retry_wait'], ['running', 'failed'],
  ['validating', 'completed'], ['validating', 'retry_wait'], ['validating', 'needs_review'],
  ['needs_review', 'queued'], ['needs_review', 'completed'], ['needs_review', 'failed'],
  ['retry_wait', 'queued'],
  ['unassigned', 'cancelled'], ['queued', 'cancelled'], ['running', 'cancelled'], ['validating', 'cancelled'],
  ['needs_review', 'cancelled'], ['retry_wait', 'cancelled'],
];
const ORG_ALLOWED: Pair[] = [
  ['proposed', 'approved'], ['proposed', 'rejected'], ['proposed', 'expired'], ['proposed', 'superseded'],
  ['approved', 'trial'], ['trial', 'active'], ['trial', 'inconclusive'], ['trial', 'rolled_back'],
  ['inconclusive', 'trial'], ['active', 'rolled_back'], ['active', 'retired'],
];
const ROLE_ALLOWED: Pair[] = [['proposed', 'trial'], ['trial', 'active'], ['active', 'retired']];
const STRATEGY_ALLOWED: Pair[] = [
  ['proposed', 'experiment'], ['proposed', 'active'], ['proposed', 'rejected'], ['experiment', 'active'], ['experiment', 'rejected'], ['active', 'retired'],
];
const PUBLICATION_ALLOWED: Pair[] = [
  ['draft', 'pending_approval'], ['pending_approval', 'published'], ['draft', 'published'], ['published', 'withdrawn'],
];
const REGISTRATION_ALLOWED: Pair[] = [
  ['candidate', 'verifying'], ['verifying', 'pending_approval'], ['pending_approval', 'registered'],
  ['verifying', 'rejected'], ['pending_approval', 'rejected'], ['pending_approval', 'verifying'],
];
const LIFECYCLE_ALLOWED: Pair[] = [
  ['idea', 'development'], ['development', 'beta'], ['beta', 'live'], ['live', 'maintenance'], ['maintenance', 'sunset'],
];

// docs/operations/recovery.md §3: 그림(planned → dispatched → confirmed/failed/unknown, confirmed → compensated)과
// 재시도 표(unknown 재전송·조회 확인, failed 재전송)
const EFFECT_ALLOWED: Pair[] = [
  ['planned', 'dispatched'], ['dispatched', 'confirmed'], ['dispatched', 'failed'], ['dispatched', 'unknown'],
  ['unknown', 'dispatched'], ['unknown', 'confirmed'], ['unknown', 'failed'], ['failed', 'dispatched'], ['confirmed', 'compensated'],
];

const ALL_ACTORS: TransitionActor[] = [...NON_AGENT_ACTORS, 'agent'];

function acceptsSome(machine: StateMachine<string>, from: string | null, to: string): boolean {
  return ALL_ACTORS.some(
    (by) => checkTransition(machine, { from, to, by, reason: 'r', approvalId: 'approval-1', audience: 'internal' }).ok,
  );
}

const MACHINES: ReadonlyArray<readonly [string, StateMachine<string>, Pair[]]> = [
  ['task', TASK_MACHINE, TASK_ALLOWED],
  ['org_proposal', ORG_PROPOSAL_MACHINE, ORG_ALLOWED],
  ['role', ROLE_MACHINE, ROLE_ALLOWED],
  ['strategy_version', STRATEGY_MACHINE, STRATEGY_ALLOWED],
  ['publication', PUBLICATION_MACHINE, PUBLICATION_ALLOWED],
  ['product registration', PRODUCT_REGISTRATION_MACHINE, REGISTRATION_ALLOWED],
  ['product lifecycle', PRODUCT_LIFECYCLE_MACHINE, LIFECYCLE_ALLOWED],
  ['external_effect', EXTERNAL_EFFECT_MACHINE, EFFECT_ALLOWED],
];

for (const [name, machine, allowed] of MACHINES) {
  test(`${name}: exactly the documented transitions are allowed, every other pair is rejected`, () => {
    const allowedKeys = new Set(allowed.map(([f, t]) => `${f}->${t}`));
    for (const from of [null, ...machine.states]) {
      for (const to of machine.states) {
        const key = `${from}->${to}`;
        assert.equal(acceptsSome(machine, from, to), allowedKeys.has(key), key);
      }
    }
  });

  test(`${name}: an agent can never cause any transition`, () => {
    for (const from of [null, ...machine.states]) {
      for (const to of machine.states) {
        const result = checkTransition(machine, { from, to, by: 'agent', reason: 'r', approvalId: 'a', audience: 'internal' });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'agent_forbidden');
      }
    }
  });
}

test('task: terminal states (completed/failed/cancelled) allow no transition at all', () => {
  for (const from of ['completed', 'failed', 'cancelled'] as const) {
    assert.equal(isTaskTerminal(from), true);
    for (const to of TASK_MACHINE.states) {
      for (const by of NON_AGENT_ACTORS) {
        const r = checkTransition(TASK_MACHINE, { from, to, by, reason: 'r', approvalId: 'a' });
        assert.equal(r.ok, false, `${from}->${to} by ${by}`);
        if (!r.ok) assert.equal(r.code, 'terminal_state');
      }
    }
  }
  assert.equal(isTaskTerminal('needs_review'), false);
});

test('task: only the validator can complete from validating; running -> completed does not exist', () => {
  for (const by of NON_AGENT_ACTORS) {
    assert.equal(checkTransition(TASK_MACHINE, { from: 'validating', to: 'completed', by }).ok, by === 'validator', by);
    assert.equal(checkTransition(TASK_MACHINE, { from: 'running', to: 'completed', by, approvalId: 'a' }).ok, false);
  }
  const wrong = checkTransition(TASK_MACHINE, { from: 'validating', to: 'completed', by: 'scheduler' });
  assert.ok(!wrong.ok && wrong.code === 'actor_not_allowed');
  const none = checkTransition(TASK_MACHINE, { from: 'running', to: 'completed', by: 'validator' });
  assert.ok(!none.ok && none.code === 'not_allowed');
});

test('task: needs_review exits need a human and an approval record', () => {
  for (const to of ['queued', 'completed', 'failed'] as const) {
    const noApproval = checkTransition(TASK_MACHINE, { from: 'needs_review', to, by: 'human' });
    assert.ok(!noApproval.ok && noApproval.code === 'approval_required', to);
    assert.ok(checkTransition(TASK_MACHINE, { from: 'needs_review', to, by: 'human', approvalId: 'approval-1' }).ok);
    for (const by of ['scheduler', 'validator', 'policy', 'system'] as const) {
      assert.equal(checkTransition(TASK_MACHINE, { from: 'needs_review', to, by, approvalId: 'approval-1' }).ok, false);
    }
  }
});

test('task: cancellation needs a reason and a human or the policy', () => {
  for (const from of ['unassigned', 'queued', 'running', 'validating', 'needs_review', 'retry_wait'] as const) {
    const blank = checkTransition(TASK_MACHINE, { from, to: 'cancelled', by: 'human', reason: '  ' });
    assert.ok(!blank.ok && blank.code === 'reason_required', from);
    assert.ok(checkTransition(TASK_MACHINE, { from, to: 'cancelled', by: 'policy', reason: 'budget exceeded' }).ok);
    assert.equal(checkTransition(TASK_MACHINE, { from, to: 'cancelled', by: 'scheduler', reason: 'x' }).ok, false);
  }
});

test('task: creation goes through the creation engine; unassigned cannot run directly', () => {
  assert.deepEqual(reachableFrom(TASK_MACHINE, null).sort(), ['queued', 'unassigned']);
  assert.ok(checkTransition(TASK_MACHINE, { from: null, to: 'queued', by: 'task_creator' }).ok);
  assert.equal(checkTransition(TASK_MACHINE, { from: null, to: 'queued', by: 'scheduler' }).ok, false);
  assert.equal(checkTransition(TASK_MACHINE, { from: 'unassigned', to: 'running', by: 'scheduler' }).ok, false);
  assert.deepEqual(reachableFrom(TASK_MACHINE, 'unassigned').sort(), ['cancelled', 'queued']);
});

test('task: unknown states are reported, and assertTransition throws a typed error', () => {
  const unknown = checkTransition(TASK_MACHINE, { from: 'queued', to: 'paused' as never, by: 'scheduler' });
  assert.ok(!unknown.ok && unknown.code === 'unknown_state');
  assert.throws(
    () => assertTransition(TASK_MACHINE, { from: 'completed', to: 'queued', by: 'human', approvalId: 'a' }),
    (error: unknown) => error instanceof TransitionError && error.code === 'terminal_state',
  );
  assert.equal(assertTransition(TASK_MACHINE, { from: 'queued', to: 'running', by: 'scheduler' }).to, 'running');
});

test('org_proposal: skipping approval or evaluation is forbidden, and the org-management role proposes only', () => {
  const forbidden: Pair[] = [['proposed', 'trial'], ['proposed', 'active'], ['proposed', 'rolled_back'], ['inconclusive', 'active'], ['approved', 'active']];
  for (const [from, to] of forbidden) {
    for (const by of ALL_ACTORS) {
      assert.equal(checkTransition(ORG_PROPOSAL_MACHINE, { from: from as never, to: to as never, by }).ok, false, `${from}->${to} by ${by}`);
    }
  }
  for (const [from, to] of [['proposed', 'approved'], ['approved', 'trial'], ['trial', 'active'], ['trial', 'rolled_back'], ['active', 'rolled_back']] as const) {
    assert.equal(checkTransition(ORG_PROPOSAL_MACHINE, { from, to, by: 'org_management' }).ok, false, `${from}->${to}`);
  }
  assert.ok(checkTransition(ORG_PROPOSAL_MACHINE, { from: 'proposed', to: 'approved', by: 'human' }).ok);
  assert.equal(checkTransition(ORG_PROPOSAL_MACHINE, { from: 'proposed', to: 'approved', by: 'system' }).ok, false);
  assert.ok(checkTransition(ORG_PROPOSAL_MACHINE, { from: 'trial', to: 'inconclusive', by: 'evaluator' }).ok);
  assert.equal(checkTransition(ORG_PROPOSAL_MACHINE, { from: 'trial', to: 'inconclusive', by: 'human' }).ok, false);
  assert.ok(checkTransition(ORG_PROPOSAL_MACHINE, { from: 'inconclusive', to: 'trial', by: 'human' }).ok);
  assert.equal(checkTransition(ORG_PROPOSAL_MACHINE, { from: 'inconclusive', to: 'trial', by: 'system' }).ok, false);
});

test('strategy_version: promotion from proposed needs a human approval', () => {
  for (const to of ['experiment', 'active'] as const) {
    const none = checkTransition(STRATEGY_MACHINE, { from: 'proposed', to, by: 'human' });
    assert.ok(!none.ok && none.code === 'approval_required', to);
    assert.ok(checkTransition(STRATEGY_MACHINE, { from: 'proposed', to, by: 'human', approvalId: 'approval-1' }).ok);
    assert.equal(checkTransition(STRATEGY_MACHINE, { from: 'proposed', to, by: 'system', approvalId: 'approval-1' }).ok, false);
  }
});

test('publication: publishing outside internal needs an approval; internal does not', () => {
  for (const from of ['draft', 'pending_approval'] as const) {
    for (const audience of ['customer', 'public'] as const) {
      const none = checkTransition(PUBLICATION_MACHINE, { from, to: 'published', by: 'system', audience });
      assert.ok(!none.ok && none.code === 'approval_required', `${from} ${audience}`);
      assert.ok(checkTransition(PUBLICATION_MACHINE, { from, to: 'published', by: 'system', audience, approvalId: 'approval-1' }).ok);
    }
    assert.ok(checkTransition(PUBLICATION_MACHINE, { from, to: 'published', by: 'system', audience: 'internal' }).ok);
    const missing = checkTransition(PUBLICATION_MACHINE, { from, to: 'published', by: 'system' });
    assert.ok(!missing.ok && missing.code === 'audience_required');
  }
});

test('product registration: only a human with an approval can register; the verifier moves it to pending_approval', () => {
  const noApproval = checkTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'pending_approval', to: 'registered', by: 'human' });
  assert.ok(!noApproval.ok && noApproval.code === 'approval_required');
  assert.ok(checkTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'pending_approval', to: 'registered', by: 'human', approvalId: 'approval-1' }).ok);
  for (const by of ['validator', 'system', 'task_creator', 'policy', 'scheduler'] as const) {
    assert.equal(checkTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'pending_approval', to: 'registered', by, approvalId: 'approval-1' }).ok, false, by);
  }
  assert.equal(checkTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'verifying', to: 'registered', by: 'human', approvalId: 'approval-1' }).ok, false);
  assert.ok(checkTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'verifying', to: 'pending_approval', by: 'validator' }).ok);
  // 재검증: 승인 대기에서 검증으로 되돌리는 것은 새 검증 업무를 만드는 쪽(task_creator)만. 에이전트·검증기는 못 한다
  assert.ok(checkTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'pending_approval', to: 'verifying', by: 'task_creator' }).ok);
  for (const by of ['agent', 'validator', 'system', 'policy', 'scheduler'] as const) {
    assert.equal(checkTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'pending_approval', to: 'verifying', by }).ok, false, by);
  }
  assert.equal(checkTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'registered', to: 'verifying', by: 'task_creator' }).ok, false, 'a registered product is not re-verified through this table');
});

test('every rule documents its allowed actors, and the table has no duplicate (from, to, actor)', () => {
  for (const [name, machine] of MACHINES) {
    const seen = new Set<string>();
    for (const rule of machine.rules) {
      assert.ok(rule.by.length > 0, `${name}: ${rule.from}->${rule.to} has no actor`);
      for (const actor of rule.by) {
        const key = `${rule.from}->${rule.to}:${actor}`;
        assert.ok(!seen.has(key), `${name}: duplicate ${key}`);
        seen.add(key);
      }
    }
  }
});
