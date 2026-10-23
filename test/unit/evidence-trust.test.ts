// evidence.trust_origin 와 신뢰 불변식 (docs/schema/schema.sql evidence, docs/schema/memory-item.md 규칙 3·9, trust-boundaries §2-3).
//  - 열: NOT NULL, 기본값 없음, 어휘는 memory_item 과 같다(internal | external_untrusted)
//  - 불변식: external_untrusted 유래 evidence 는 기억으로 편입돼도 trusted 로도, 현재 사실(fact)로도 취급되지 않는다
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryItem, currentFacts, EVIDENCE_SOURCE_PREFIX, MemoryRuleError, SEED_IDS, TRUST_ORIGINS, type MemoryRuleCode, type NewMemoryItem } from '@aot/domain';
import { applyEvidenceVerification, claimsFromResult, runDeterministicChecks, SourceReader, type CheckContext } from '@aot/evaluation';

import { addEvidence, EXAMPLE_URL, FakeFetcher, submittedRun, validationSpec } from '../support/evaluation.ts';
import { addAgent, seededDb } from '../support/seeded-db.ts';

const rejects = (code: MemoryRuleCode) => (error: unknown) => error instanceof MemoryRuleError && error.code === code;

function setup(t: { after(fn: () => void): void }) {
  const { db, clock } = seededDb(t);
  const agent = addAgent(db, clock);
  const run = submittedRun(db, clock, { spec: validationSpec(['url_reachable']) });
  const external = addEvidence(db, clock, run, { kind: 'source_url', ref: EXAMPLE_URL, trustOrigin: 'external_untrusted' });
  const internal = addEvidence(db, clock, run, { kind: 'run_log', ref: `run-log:${run.runId}`, trustOrigin: 'internal' });
  let n = 0;
  const context = { clock, newId: () => `mem-${(n += 1)}` };
  const item = (evidenceId: string, extra: Partial<NewMemoryItem> = {}): NewMemoryItem => ({
    kind: 'hypothesis',
    body: '출처 페이지가 말하는 내용',
    source_ref: `${EVIDENCE_SOURCE_PREFIX}${evidenceId}`,
    observed_at: '2026-10-18T00:00:00Z',
    created_by: SEED_IDS.owner,
    ...extra,
  });
  const add = (evidenceId: string, extra: Partial<NewMemoryItem> = {}) => db.writeTx((tx) => createMemoryItem(tx, item(evidenceId, extra), context));
  return { db, clock, agent, run, external, internal, item, add };
}

test('evidence.trust_origin: NOT NULL with no default, and only the memory_item vocabulary is accepted', (t) => {
  const { db, clock, run } = setup(t);
  const insert = (trust: string | null) => db.writeTx((tx) => tx.run(
    'INSERT INTO evidence (id, task_id, task_run_id, kind, ref, trust_origin, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`ev-x-${String(trust)}`, run.taskId, run.runId, 'source_url', 'https://docs.example.com/x', trust, clock.nowIso()],
  ));
  for (const trust of TRUST_ORIGINS) insert(trust);
  assert.throws(() => insert(null), /NOT NULL/, 'a writer that does not say where the evidence came from is refused');
  assert.throws(() => insert('trusted'), /CHECK/, 'only internal | external_untrusted');
  assert.throws(() => insert(''), /CHECK/);
  assert.throws(
    () => db.writeTx((tx) => tx.run('INSERT INTO evidence (id, task_id, task_run_id, kind, ref, captured_at) VALUES (?, ?, ?, ?, ?, ?)', ['ev-no-col', run.taskId, run.runId, 'source_url', 'https://docs.example.com/y', clock.nowIso()])),
    /NOT NULL/, 'there is no default that could silently mark an evidence row as trusted or untrusted',
  );
  const column = db.all<{ name: string; notnull: number; dflt_value: string | null }>("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('evidence') WHERE name = 'trust_origin'")[0];
  assert.deepEqual([column?.notnull, column?.dflt_value], [1, null]);
});

test('memory from external_untrusted evidence is external_untrusted: the origin is inherited, "internal" is refused, and it can only be an unverified hypothesis', (t) => {
  const { db, external, add } = setup(t);
  const inherited = add(external);
  assert.equal(inherited.trust_origin, 'external_untrusted', 'omitting trust_origin takes the evidence origin');
  assert.equal(inherited.kind, 'hypothesis');
  assert.equal(inherited.verification_status, 'unverified');
  assert.throws(() => add(external, { trust_origin: 'internal' }), rejects('untrusted_evidence_origin'));
  // 외부 유래는 hypothesis/unverified 로만 (규칙 3) — 근거를 거쳐도 fact·verified 로 시작할 수 없다
  assert.throws(() => add(external, { kind: 'fact' }), rejects('external_must_be_hypothesis'));
  assert.throws(() => add(external, { kind: 'fact', verification_status: 'verified', trust_origin: 'external_untrusted' }), rejects('external_must_be_hypothesis'));
  assert.throws(() => add(external, { verification_status: 'verified' }), rejects('external_must_be_hypothesis'));
  assert.throws(() => add(external, { kind: 'measurement' }), rejects('external_must_be_hypothesis'));
  // 거부는 아무것도 쓰지 않는다
  assert.equal(db.all('SELECT id FROM memory_item').length, 1);
});

test('current-fact lookup never returns an item that came from external_untrusted evidence', (t) => {
  const { db, clock, external, internal, add } = setup(t);
  add(external);
  add(external, { body: '두 번째 외부 주장', trust_origin: 'external_untrusted' });
  assert.deepEqual(currentFacts(db, { clock }), []);
  // 같은 근거 경로라도 내부 근거에서 온 사람의 검증된 사실은 현재 사실이다 (규칙이 외부 유래만 막는다)
  const fact = add(internal, { kind: 'fact', verification_status: 'verified' });
  assert.equal(fact.trust_origin, 'internal');
  assert.deepEqual(currentFacts(db, { clock }).map((m) => m.id), [fact.id]);
  assert.ok(currentFacts(db, { clock }).every((m) => m.trust_origin === 'internal'));
});

test('an agent cannot launder external evidence into a fact either, and its external hypothesis stays untrusted', (t) => {
  const { agent, external, add } = setup(t);
  assert.throws(() => add(external, { created_by: agent, kind: 'fact', trust_origin: 'external_untrusted' }), rejects('external_must_be_hypothesis'));
  assert.throws(() => add(external, { created_by: agent, trust_origin: 'internal' }), rejects('untrusted_evidence_origin'));
  const ok = add(external, { created_by: agent });
  assert.deepEqual([ok.kind, ok.verification_status, ok.trust_origin], ['hypothesis', 'unverified', 'external_untrusted']);
});

test('a source_ref that names evidence which does not exist is refused (it would otherwise skip the origin rule)', (t) => {
  const { add } = setup(t);
  assert.throws(() => add('no-such-evidence'), rejects('invalid_field'));
  assert.throws(() => add('no-such-evidence', { trust_origin: 'internal', kind: 'fact', verification_status: 'verified' }), rejects('invalid_field'));
});

test('verification (evidence.verified) does not change the origin: a verified external source is still external_untrusted', async (t) => {
  const { db, run, external } = setup(t);
  const task = db.get('SELECT * FROM task WHERE id = ?', [run.taskId])!;
  const context = (): CheckContext => ({
    db, task: task as never, run: db.get('SELECT * FROM task_run WHERE id = ?', [run.runId]) as never,
    spec: JSON.parse(String(task['spec'])), evidence: db.all('SELECT * FROM evidence WHERE task_id = ?', [run.taskId]) as never,
    claims: claimsFromResult(null), sources: new SourceReader(new FakeFetcher({ [EXAMPLE_URL]: 'page' })),
  });
  const report = await runDeterministicChecks(context(), ['url_reachable']);
  assert.equal(report.evidence.get(external)?.verified, true);
  db.writeTx((tx) => applyEvidenceVerification(tx, report.evidence));
  const row = db.get('SELECT verified, trust_origin FROM evidence WHERE id = ?', [external]);
  assert.deepEqual([Number(row?.['verified']), row?.['trust_origin']], [1, 'external_untrusted']);
});
