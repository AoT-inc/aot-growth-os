// Phase A 시드 (D4): 오너 1 + generalist + 읽기 전용 registration-verifier + policy_version v1.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkTaskSpecReferences, currentPolicyVersionId, DEFAULT_OWNER_NAME, FakeClock, POLICY_V1_DOCUMENT, policyV1ContentHash,
  SEED_IDS, SEED_SLUGS, seedPhaseA, taskCreationPrerequisites, validateTaskSpec, type Db, type TaskSpec,
} from '@aot/domain';

import { minimalDraft, productRegistrationTemplate } from '../support/spec-fixtures.ts';
import { migratedDb, seededDb, START } from '../support/seeded-db.ts';

// node:sqlite 의 행은 프로토타입이 없는 객체라 strict deepEqual 전에 평범한 객체로 바꾼다.
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const count = (db: Db, table: string): number => Number(db.get(`SELECT count(*) AS n FROM ${table}`)?.['n']);

/** 업무 한 건을 queued 로 넣는다 (A2 의 업무 생성 엔진이 하게 될 일의 최소형). */
function insertTask(tx: Db, spec: TaskSpec, policyVersionId: string, roleId: string | null, at: string): void {
  tx.run(
    `INSERT INTO task (id, dedupe_key, objective, role_id, role_version, trigger_kind, trigger_ref, spec, status,
       policy_version_id, cost_budget_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'task-1', 'dedupe-1', spec.objective, roleId, roleId === null ? null : 1, spec.trigger.kind, spec.trigger.ref,
      JSON.stringify(spec), roleId === null ? 'unassigned' : 'queued', policyVersionId, spec.cost_budget.max_usd, at, at,
    ],
  );
}

const storedSpec = (policyVersion: string): TaskSpec => ({
  ...(minimalDraft() as never as TaskSpec),
  role: 'generalist',
  policy_version: policyVersion,
  versions: { org_version: SEED_IDS.orgVersion, role_version: 1, task_spec_version: 1, strategy_version: null, tool_contract_version: null },
});

test('before seeding there is no policy_version, so no task can be created; after seeding one can', (t) => {
  const { db, clock } = migratedDb(t);
  assert.deepEqual(taskCreationPrerequisites(db), { ok: false, missing: ['policy_version', 'assignable_role'] });
  assert.equal(currentPolicyVersionId(db), null);
  const spec = storedSpec('policy-v1');
  assert.throws(() => db.writeTx((tx) => insertTask(tx, spec, 'policy-v1', null, clock.nowIso())), /FOREIGN KEY/);

  seedPhaseA(db, { clock });
  assert.deepEqual(taskCreationPrerequisites(db), { ok: true, missing: [] });
  assert.equal(currentPolicyVersionId(db), SEED_IDS.policy);

  const validated = validateTaskSpec(spec, 'stored');
  assert.equal(validated.ok, true);
  db.writeTx((tx) => insertTask(tx, spec, currentPolicyVersionId(tx)!, SEED_IDS.generalist, clock.nowIso()));
  const row = db.get<{ status: string; policy_version_id: string }>('SELECT status, policy_version_id FROM task WHERE id = ?', ['task-1']);
  assert.deepEqual(plain(row), { status: 'queued', policy_version_id: 'policy-v1' });
});

test('the seed is exactly one human owner, one unit, two active roles, one org_version and policy v1', (t) => {
  const { db } = seededDb(t);
  assert.equal(count(db, 'actor'), 1);
  assert.deepEqual(plain(db.all('SELECT id, kind, name, adapter FROM actor')), [{ id: SEED_IDS.owner, kind: 'human', name: DEFAULT_OWNER_NAME, adapter: null }]);
  assert.deepEqual(plain(db.all('SELECT slug, lifecycle FROM org_unit')), [{ slug: 'core', lifecycle: 'active' }]);
  assert.deepEqual(
    plain(db.all('SELECT slug, lifecycle, version, trial_scope FROM role ORDER BY slug')),
    [
      { slug: 'generalist', lifecycle: 'active', version: 1, trial_scope: null },
      { slug: 'registration-verifier', lifecycle: 'active', version: 1, trial_scope: null },
    ],
  );
  assert.deepEqual(plain(db.all('SELECT id, status, parent_id, proposal_id FROM org_version')), [{ id: SEED_IDS.orgVersion, status: 'active', parent_id: null, proposal_id: null }]);
  assert.equal(count(db, 'policy_version'), 1);
  for (const table of ['task', 'task_run', 'product', 'strategy_version', 'org_proposal', 'role_assignment', 'event', 'routine']) {
    assert.equal(count(db, table), 0, `${table} must stay empty`);
  }
  const snapshot = JSON.parse(String(db.get('SELECT snapshot FROM org_version')?.['snapshot'])) as { roles: Array<{ slug: string }> };
  assert.deepEqual(snapshot.roles.map((r) => r.slug).sort(), ['generalist', 'registration-verifier']);
});

test('registration-verifier requests only read tools plus appending to its own evidence', (t) => {
  const { db } = seededDb(t);
  const tools = JSON.parse(String(db.get("SELECT allowed_tools FROM role WHERE slug = 'registration-verifier'")?.['allowed_tools'])) as Array<{ tool: string; operations: string[] }>;
  assert.deepEqual(tools.map((x) => x.tool).sort(), ['evidence_store', 'license_check', 'repo_read', 'secret_scan']);
  const operations = tools.flatMap((x) => x.operations);
  assert.ok(!operations.some((op) => /write|delete|exec|push|publish|send|install/.test(op)), operations.join(','));
  assert.deepEqual(tools.find((x) => x.tool === 'evidence_store')?.operations, ['append']);
});

test('policy v1: default deny, internal read allowed, write within task scope, external effects and customer/public need approval', (t) => {
  const { db } = seededDb(t);
  const row = db.get<{ content_hash: string; change_class: string; approved_by: string; deployed_at: string; rollback_of: string | null }>(
    'SELECT content_hash, change_class, approved_by, deployed_at, rollback_of FROM policy_version WHERE id = ?', [SEED_IDS.policy],
  )!;
  assert.equal(row.deployed_at, START);
  assert.equal(row.rollback_of, null);
  assert.deepEqual(JSON.parse(row.approved_by), [SEED_IDS.owner]);
  assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.content_hash, policyV1ContentHash());

  const rules: readonly { scope?: readonly string[]; impact?: readonly string[]; decision: string }[] = POLICY_V1_DOCUMENT.rules;
  assert.equal(POLICY_V1_DOCUMENT.default, 'deny');
  const find = (predicate: (r: (typeof rules)[number]) => boolean) => rules.filter(predicate).map((r) => r.decision);
  assert.deepEqual(find((r) => r.scope?.includes('internal') === true && r.impact?.includes('read') === true), ['allow']);
  assert.deepEqual(find((r) => r.impact?.includes('write') === true), ['allow']);
  assert.deepEqual(find((r) => r.impact?.includes('external_effect') === true), ['require_approval']);
  for (const scope of ['customer', 'public']) assert.deepEqual(find((r) => r.scope?.includes(scope) === true), ['require_approval'], scope);
  assert.ok(!rules.some((r) => r.decision === 'allow' && !(r.scope?.length === 1 && r.scope[0] === 'internal')), 'nothing outside internal is auto-allowed');
  assert.deepEqual(POLICY_V1_DOCUMENT.risky_change, { min_approvers: 1, cooldown: 3600, reauth_before_effect: true, self_approval: false });
});

test('seeding twice changes nothing; owner name and time come from the arguments, never from the system', (t) => {
  const { db, clock } = migratedDb(t, new FakeClock('2026-03-01T09:00:00.000Z'));
  assert.equal(seedPhaseA(db, { clock, ownerName: 'owner-from-instance' }).applied, true);
  clock.advance(86_400_000);
  const again = seedPhaseA(db, { clock, ownerName: 'someone-else' });
  assert.equal(again.applied, false);
  assert.equal(count(db, 'actor'), 1);
  assert.equal(db.get('SELECT name FROM actor')?.['name'], 'owner-from-instance');
  assert.equal(db.get('SELECT created_at FROM actor')?.['created_at'], '2026-03-01T09:00:00.000Z');
  assert.equal(db.get('SELECT deployed_at FROM policy_version')?.['deployed_at'], '2026-03-01T09:00:00.000Z');
  assert.throws(() => seedPhaseA(db, { clock, ownerName: '  ' }), RangeError);
});

test('a failure while seeding leaves nothing behind, and seeding cannot run inside another write transaction', (t) => {
  const { db, clock } = migratedDb(t);
  db.writeTx((tx) => tx.run('INSERT INTO actor (id, kind, name, created_at) VALUES (?, ?, ?, ?)', [SEED_IDS.owner, 'human', 'preexisting', clock.nowIso()]));
  assert.throws(() => seedPhaseA(db, { clock }), /UNIQUE|constraint/);
  assert.equal(count(db, 'policy_version'), 0);
  assert.equal(count(db, 'org_unit'), 0);
  assert.throws(() => db.writeTx(() => seedPhaseA(db, { clock })), /nested/);
});

test('the product-registration template references only seeded departments and roles (D4)', (t) => {
  const { db } = seededDb(t);
  const template = productRegistrationTemplate();
  assert.equal(validateTaskSpec(template, 'draft').ok, true);
  assert.deepEqual(checkTaskSpecReferences(db, template as Parameters<typeof checkTaskSpecReferences>[1]), []);
  assert.equal(template['department'], SEED_SLUGS.unit);
  assert.equal(template['role'], SEED_SLUGS.registrationVerifier);
});

test('checkTaskSpecReferences: seeded roles are usable; unknown/unassignable roles, departments, products and dependencies are not', (t) => {
  const { db, clock } = seededDb(t);
  const issues = (spec: Parameters<typeof checkTaskSpecReferences>[1]) => checkTaskSpecReferences(db, spec).map((i) => `${i.path}:${i.code}`);

  assert.deepEqual(issues({ role: 'generalist', department: 'core' }), []);
  assert.deepEqual(issues({}), [], 'no role is fine: the task is created as unassigned');
  assert.deepEqual(issues({ role: 'market-researcher' }), ['role:not_found']);
  assert.deepEqual(issues({ department: 'planning' }), ['department:not_found']);

  const now = clock.nowIso();
  db.writeTx((tx) => {
    tx.run(
      'INSERT INTO role (id, org_unit_id, slug, description, allowed_tools, lifecycle, version, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      ['role-p', SEED_IDS.unit, 'proposed-role', 'x', '[]', 'proposed', now],
    );
    tx.run(
      'INSERT INTO role (id, org_unit_id, slug, description, allowed_tools, lifecycle, version, trial_scope, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      ['role-t', SEED_IDS.unit, 'trial-role', 'x', '[]', 'trial', '["weekly"]', now],
    );
    tx.run(
      'INSERT INTO role (id, org_unit_id, slug, description, allowed_tools, lifecycle, version, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      ['role-r', SEED_IDS.unit, 'retired-role', 'x', '[]', 'retired', now],
    );
    for (const [slug, status] of [['example-registered', 'registered'], ['example-candidate', 'candidate'], ['example-verifying', 'verifying']] as const) {
      tx.run(
        'INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`p-${slug}`, slug, slug, 'software', 'idea', status, now, now],
      );
    }
  });
  assert.deepEqual(issues({ role: 'proposed-role' }), ['role:not_assignable']);
  assert.deepEqual(issues({ role: 'retired-role' }), ['role:not_assignable']);
  assert.deepEqual(issues({ role: 'trial-role' }), []);
  assert.deepEqual(issues({ product: 'example-registered' }), []);
  assert.deepEqual(issues({ product: 'example-candidate' }), ['product:not_registered']);
  assert.deepEqual(issues({ product: 'example-verifying' }), ['product:not_registered']);
  assert.deepEqual(issues({ product: 'example-unknown' }), ['product:not_registered']);

  assert.deepEqual(issues({ dependencies: ['task-1'] }), ['dependencies[0]:not_found']);
  const spec = storedSpec(SEED_IDS.policy);
  db.writeTx((tx) => insertTask(tx, spec, SEED_IDS.policy, SEED_IDS.generalist, now));
  assert.deepEqual(issues({ dependencies: ['task-1', 'task-2'] }), ['dependencies[1]:not_found']);
});
