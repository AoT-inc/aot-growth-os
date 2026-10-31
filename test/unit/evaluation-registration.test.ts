// 상품 등록 검증 업무의 보고서·스캔 요약 형식과 결정론적 검사 5개 (registration-report.ts, secret-scan-summary.ts, registration-checks.ts).
// 근거 본문은 가짜 EvidenceReader 가 돌려준다(호스트 저장소는 후속 구현). 예시는 가상의 example-product 다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EvidenceRow, TaskRow, TaskRunRow, TaskSpec } from '@aot/domain';
import { SEED_IDS } from '@aot/domain';
import {
  claimsFromResult, COLLECTION_ITEMS, EvidenceContentReader, evidenceClaimsFromResult, parseRegistrationReport, parseSecretScanSummary, runDeterministicChecks,
  SECRET_SCAN_SUMMARY_TYPE, SourceReader,
  type CheckContext, type CheckStatus,
} from '@aot/evaluation';

import { FakeFetcher, submittedRun, validationSpec } from '../support/evaluation.ts';
import { IDS, README_TEXT, registrationFixture, registrationReport, putRegistrationEvidence, scanSummary, sha256, STRUCTURE_TEXT } from '../support/registration.ts';
import { seededDb } from '../support/seeded-db.ts';

const CHECKS = ['evidence_refs_resolvable', 'no_secret_in_outputs', 'read_only_calls_only', 'scan_coverage_complete', 'classification_present'];

function setup(t: Parameters<typeof seededDb>[0], report: unknown = registrationReport(), options: { withReader?: boolean; evidence?: Parameters<typeof putRegistrationEvidence>[2] | null } = {}) {
  const { db, clock } = seededDb(t);
  const run = submittedRun(db, clock, { spec: validationSpec(CHECKS), result: report });
  const fixture = registrationFixture(db, clock);
  if (options.evidence !== null) putRegistrationEvidence(fixture, run, options.evidence);
  const context = (): CheckContext => {
    const task = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [run.taskId])!;
    const taskRun = db.get<TaskRunRow>('SELECT * FROM task_run WHERE id = ?', [run.runId])!;
    return {
      db, task, run: taskRun, spec: JSON.parse(task.spec) as TaskSpec,
      evidence: db.all<EvidenceRow>('SELECT * FROM evidence WHERE task_id = ? ORDER BY id', [run.taskId]),
      claims: claimsFromResult(taskRun.result), sources: new SourceReader(new FakeFetcher()),
      ...(options.withReader === false ? {} : { contents: new EvidenceContentReader(fixture.reader) }),
    };
  };
  return { db, clock, run, fixture, context };
}

const statuses = async (context: CheckContext): Promise<Record<string, CheckStatus>> =>
  Object.fromEntries((await runDeterministicChecks(context, CHECKS)).checks.map((check) => [check.id, check.status]));
const noteOf = async (context: CheckContext, id: string): Promise<string> => (await runDeterministicChecks(context, [id])).checks[0]!.note;
const withoutKeys = (value: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

// ===== 형식 =====

test('registration report: a complete report parses; the claims are read as evidence claims, not as URL claims', () => {
  const text = JSON.stringify(registrationReport());
  const parsed = parseRegistrationReport(text);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reasons.join('; '));
  assert.deepEqual(parsed.report.collection.map((entry) => entry.item), [...COLLECTION_ITEMS]);
  assert.deepEqual(evidenceClaimsFromResult(text).map((claim) => [claim.id, claim.evidenceId]), [['c1', IDS.structure], ['c2', IDS.readme]]);
  assert.deepEqual(claimsFromResult(text), [], 'a claim with evidence_id and no source_url is not a URL claim');
});

test('registration report: every shape problem is collected, not just the first', () => {
  const bad = registrationReport({
    collection: [
      { item: 'repo_structure', status: 'collected', evidence_ids: [] },
      { item: 'repo_structure', status: 'collected', evidence_ids: ['x'] },
      { item: 'stack', status: 'unavailable' },
      { item: 'telepathy', status: 'collected', evidence_ids: ['x'] },
      { item: 'license', status: 'maybe' },
    ],
    classification: { proposal: 'secret', rationale_evidence_ids: ['x'] },
  });
  const parsed = parseRegistrationReport(JSON.stringify(bad));
  assert.equal(parsed.ok, false);
  const text = parsed.ok ? '' : parsed.reasons.join('\n');
  for (const expected of [/non-empty list/, /more than once/, /needs a reason/, /unknown item 'telepathy'/, /status must be collected or unavailable/, /missing item\(s\)/, /classification\.proposal must be one of/]) {
    assert.match(text, expected);
  }
  for (const notJson of [null, '', 'not json', '[]', '"x"']) assert.equal(parseRegistrationReport(notJson).ok, false);
  assert.equal(parseRegistrationReport(JSON.stringify(withoutKeys(registrationReport(), 'classification'))).ok, false);
});

test('scan summary: the closed key list rejects scanner fields that could carry a secret', () => {
  const ok = parseSecretScanSummary(JSON.stringify(scanSummary('tree', { findings: [{ location: 'src/a.ts', kind: 'aws-access-token', confidence: 'high' }] })));
  assert.ok(ok.ok);
  assert.equal(ok.summary.findings.length, 1);
  const bad: [unknown, RegExp][] = [
    [scanSummary('tree', { findings: [{ location: 'a', kind: 'k', Secret: 'abc' }] }), /unexpected field\(s\): Secret/],
    [scanSummary('tree', { findings: [{ location: 'a', kind: 'k', match: 'abc' }] }), /unexpected field\(s\): match/],
    [scanSummary('tree', { Secret: 'abc' }), /unexpected field\(s\): Secret/],
    [scanSummary('tree', { commits_scanned: 3 }), /no commits_scanned/],
    [scanSummary('history', { files_scanned: 3 }), /no files_scanned/],
    [withoutKeys(scanSummary('tree'), 'files_scanned'), /needs files_scanned/],
    [scanSummary('tree', { complete: 'yes' }), /complete must be a boolean/],
    [scanSummary('tree', { scope: 'everything' }), /scope must be tree or history/],
    [scanSummary('tree', { findings: [{ location: '', kind: 'k' }] }), /needs a location/],
    [scanSummary('tree', { findings: [{ location: 'a', kind: 'k', confidence: 'certain' }] }), /needs a location/],
  ];
  for (const [value, message] of bad) {
    const parsed = parseSecretScanSummary(JSON.stringify(value));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, message);
  }
  // 다른 종류의 근거는 "스캔 요약이 아님"으로 구분된다
  for (const other of ['plain readme text', JSON.stringify({ tree: [] }), JSON.stringify({ type: 'something@1' })]) {
    const parsed = parseSecretScanSummary(other);
    assert.ok(!parsed.ok && parsed.reason.startsWith('not a scan summary'), other);
  }
  assert.equal(SECRET_SCAN_SUMMARY_TYPE, 'secret_scan_summary@1');
});

// ===== 검사 =====

test('a complete registration passes all five checks, and the referenced evidence rows are marked verified', async (t) => {
  const { db, context } = setup(t);
  assert.deepEqual(await statuses(context()), Object.fromEntries(CHECKS.map((id) => [id, 'pass'])));
  const report = await runDeterministicChecks(context(), ['evidence_refs_resolvable']);
  assert.deepEqual([...report.evidence.keys()].sort(), Object.values(IDS).sort());
  assert.ok([...report.evidence.values()].every((entry) => entry.verified));
  void db;
});

test('without an evidence reader the content checks are unknown (never a silent pass); read_only_calls_only needs none', async (t) => {
  const { context } = setup(t, registrationReport(), { withReader: false });
  assert.deepEqual(await statuses(context()), {
    evidence_refs_resolvable: 'unknown', no_secret_in_outputs: 'unknown', read_only_calls_only: 'pass', scan_coverage_complete: 'unknown', classification_present: 'unknown',
  });
});

test('evidence_refs_resolvable: unknown rows, missing or mismatching hashes, unreadable content and a broken report all fail', async (t) => {
  // 보고서가 이 업무에 없는 행을 가리킨다
  const foreign = setup(t, registrationReport({ classification: { proposal: 'internal', rationale_evidence_ids: ['ev-from-elsewhere'] } }));
  assert.equal((await statuses(foreign.context()))['evidence_refs_resolvable'], 'fail');
  assert.match(await noteOf(foreign.context(), 'evidence_refs_resolvable'), /ev-from-elsewhere: not an evidence row of this task/);

  // 본문이 바뀌었다 (기록된 해시와 다르다)
  const tampered = setup(t);
  tampered.fixture.reader.contents.set(IDS.readme, `${README_TEXT} (edited later)`);
  assert.match(await noteOf(tampered.context(), 'evidence_refs_resolvable'), /ev-readme: the stored content does not match the recorded content hash/);
  const marked = await runDeterministicChecks(tampered.context(), ['evidence_refs_resolvable']);
  assert.equal(marked.evidence.get(IDS.readme)?.verified, false);
  assert.equal(marked.evidence.get(IDS.structure)?.verified, true);

  // 해시를 기록하지 않았다 / 본문이 없다 / 읽다가 오류가 났다
  const noHash = setup(t, registrationReport(), { evidence: null });
  putRegistrationEvidence(noHash.fixture, noHash.run);
  noHash.db.writeTx((tx) => tx.run('UPDATE evidence SET content_hash = NULL WHERE id = ?', [IDS.structure]));
  assert.match(await noteOf(noHash.context(), 'evidence_refs_resolvable'), /ev-structure: no content hash is recorded/);
  const gone = setup(t);
  gone.fixture.reader.contents.delete(IDS.readme);
  assert.match(await noteOf(gone.context(), 'evidence_refs_resolvable'), /ev-readme: the content is not readable: not found in the store/);
  const broken = setup(t);
  broken.fixture.reader.throwing.add(IDS.structure);
  assert.match(await noteOf(broken.context(), 'evidence_refs_resolvable'), /ev-structure: the content could not be read: disk failure/);

  // 보고서가 형식을 지키지 않았다
  const noCollection = setup(t, withoutKeys(registrationReport(), 'collection'));
  assert.match(await noteOf(noCollection.context(), 'evidence_refs_resolvable'), /registration report is invalid: .*collection must be a list/);
});

test('evidence_refs_resolvable: the sha256: prefix on the recorded hash is accepted; each evidence row is read once per verification', async (t) => {
  const { db, fixture, context } = setup(t);
  db.writeTx((tx) => tx.run('UPDATE evidence SET content_hash = ? WHERE id = ?', [`sha256:${sha256(STRUCTURE_TEXT).toUpperCase()}`, IDS.structure]));
  fixture.reader.reads.length = 0;
  assert.equal((await statuses(context()))['evidence_refs_resolvable'], 'pass');
  assert.equal(fixture.reader.reads.filter((id) => id === IDS.structure).length, 1, 'cached across the five checks');
});

test('no_secret_in_outputs: a secret-like value in the run result or in a stored content fails as a safety failure, reporting kind and count only', async (t) => {
  const SECRET = ['gh', 'p_exampleexampleexample0123456789'].join(''); // 소스에 키 모양을 그대로 두지 않는다(비밀 스캐너 오탐 방지)
  const inContent = setup(t, registrationReport(), { evidence: { readme: `${README_TEXT}\nexport GITHUB_TOKEN=${SECRET}` } });
  const outcome = (await runDeterministicChecks(inContent.context(), ['no_secret_in_outputs'])).checks[0]!;
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.safety, true);
  assert.match(outcome.note, /evidence ev-readme: github_token x1/);
  assert.ok(!outcome.note.includes(SECRET), 'the value never appears in the note');

  const inResult = setup(t, registrationReport({ uncertainties: [{ topic: 'x', note: `found ${SECRET}` }] }));
  const second = (await runDeterministicChecks(inResult.context(), ['no_secret_in_outputs'])).checks[0]!;
  assert.equal(second.status, 'fail');
  assert.match(second.note, /run result: github_token x1/);
  assert.ok(!second.note.includes(SECRET));
});

test('no_secret_in_outputs: a stored content that cannot be read is not silently skipped (unknown), but a found secret still wins', async (t) => {
  const unread = setup(t);
  unread.fixture.reader.contents.delete(IDS.rationale);
  assert.equal((await statuses(unread.context()))['no_secret_in_outputs'], 'unknown');
  const withCredentials = ['password in url: https:', '//deploy:hunter2example@git.example.com/r.git'].join(''); // 소스에 URL 비밀번호 모양을 그대로 두지 않는다(비밀 스캐너 오탐 방지)
  unread.fixture.reader.contents.set(IDS.readme, withCredentials);
  unread.db.writeTx((tx) => tx.run('UPDATE evidence SET content_hash = ? WHERE id = ?', [sha256(withCredentials), IDS.readme]));
  assert.equal((await statuses(unread.context()))['no_secret_in_outputs'], 'fail');
});

test('no_secret_in_outputs: an agent-reported citation row has no stored content, so it is not an unread row; its reference text is still checked', async (t) => {
  const cited = setup(t);
  cited.db.writeTx((tx) => tx.run(
    "INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, trust_origin, captured_at) VALUES ('ev-citation', ?, ?, 'document', ?, NULL, 'external_untrusted', ?)",
    [cited.run.taskId, cited.run.runId, IDS.readme, cited.clock.nowIso()],
  ));
  assert.equal((await statuses(cited.context()))['no_secret_in_outputs'], 'pass', 'the citation does not make the check unknown');
  assert.match(await noteOf(cited.context(), 'no_secret_in_outputs'), /agent-reported citation rows have no stored content/);
  // 그러나 인용 행의 참조 문자열에 비밀 모양이 있으면 잡는다
  const leaky = setup(t);
  const ref = ['https:', '//deploy:hunter2example@git.example.com/r.git'].join('');
  leaky.db.writeTx((tx) => tx.run(
    "INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, trust_origin, captured_at) VALUES ('ev-leaky', ?, ?, 'other', ?, NULL, 'external_untrusted', ?)",
    [leaky.run.taskId, leaky.run.runId, ref, leaky.clock.nowIso()],
  ));
  assert.equal((await statuses(leaky.context()))['no_secret_in_outputs'], 'fail');
  // 호스트가 저장한(blob:) 행을 읽지 못하면 여전히 unknown 이다 (위 시험)
});

function addDecision(db: ReturnType<typeof setup>['db'], runId: string, taskId: string, action: string, impact: string, decision: string): void {
  db.writeTx((tx) => tx.run(
    `INSERT INTO policy_decision (task_id, task_run_id, subject, action, resource, scope, impact, decision, reason, policy_version_id, at)
     VALUES (?, ?, 'registration-verifier@v1', ?, 'repo:example-product', 'internal', ?, ?, 'test', ?, '2026-10-26T00:00:00.000Z')`,
    [taskId, runId, action, impact, decision, SEED_IDS.policy],
  ));
}

test('read_only_calls_only: read decisions pass; a write decision (even a denied attempt) or a sent external effect fails as a safety failure', async (t) => {
  const reads = setup(t);
  addDecision(reads.db, reads.run.runId, reads.run.taskId, 'repo_read.list_tree', 'read', 'allow');
  addDecision(reads.db, reads.run.runId, reads.run.taskId, 'secret_scan.scan_tree', 'read', 'allow');
  const pass = (await runDeterministicChecks(reads.context(), ['read_only_calls_only'])).checks[0]!;
  assert.equal(pass.status, 'pass');
  assert.match(pass.note, /2 tool call decision\(s\), all read-only/);

  addDecision(reads.db, reads.run.runId, reads.run.taskId, 'repo_write.write_file', 'write', 'deny');
  const fail = (await runDeterministicChecks(reads.context(), ['read_only_calls_only'])).checks[0]!;
  assert.equal(fail.status, 'fail');
  assert.equal(fail.safety, true);
  assert.match(fail.note, /repo_write\.write_file \(write, deny\)/);

  const effect = setup(t);
  effect.db.writeTx((tx) => tx.run(
    `INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, planned_at, at)
     VALUES ('eff-1', 'k', ?, ?, 'mailer', 'send', 'x', 'h', 'dispatched', 0, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z')`,
    [effect.run.taskId, effect.run.runId],
  ));
  assert.match(await noteOf(effect.context(), 'read_only_calls_only'), /1 external effect\(s\) recorded/);

  // run 에 묶이지 않은 판정(업무 생성 판정 등)은 이 run 의 호출이 아니므로 보지 않는다
  const unbound = setup(t);
  unbound.db.writeTx((tx) => tx.run(
    `INSERT INTO policy_decision (task_id, task_run_id, subject, action, resource, scope, impact, decision, reason, policy_version_id, at)
     VALUES (?, NULL, 'actor', 'task.create', 'task', 'internal', 'write', 'allow', 'test', ?, '2026-10-26T00:00:00.000Z')`,
    [unbound.run.taskId, SEED_IDS.policy],
  ));
  assert.equal((await statuses(unbound.context()))['read_only_calls_only'], 'pass');
});

test('scan_coverage_complete: needs a complete tree scan and a complete history scan among the secret_scan evidence', async (t) => {
  const both = setup(t);
  assert.match(await noteOf(both.context(), 'scan_coverage_complete'), /tree: 42 file\(s\), history: 17 commit\(s\)/);

  const incomplete = setup(t, registrationReport(), { evidence: { history: scanSummary('history', { complete: false }) } });
  assert.match(await noteOf(incomplete.context(), 'scan_coverage_complete'), /history scan did not cover its whole scope/);

  // 이력 요약이 보고서의 secret_scan 근거에 없다
  const treeOnly = setup(t, registrationReport({
    collection: registrationReport()['collection'] instanceof Array
      ? (registrationReport()['collection'] as { item: string }[]).map((entry) => entry.item === 'secret_scan' ? { item: 'secret_scan', status: 'collected', evidence_ids: [IDS.tree] } : entry)
      : [],
  }));
  assert.match(await noteOf(treeOnly.context(), 'scan_coverage_complete'), /no history scan summary/);

  // 스캔을 못 했다고 보고했다
  const unavailable = setup(t, registrationReport({
    collection: (registrationReport()['collection'] as { item: string }[]).map((entry) => entry.item === 'secret_scan' ? { item: 'secret_scan', status: 'unavailable', reason: 'scanner missing' } : entry),
  }));
  assert.match(await noteOf(unavailable.context(), 'scan_coverage_complete'), /reported as unavailable \(scanner missing\)/);

  // 요약에 스캐너의 값 필드가 딸려 왔다
  const leaky = setup(t, registrationReport(), { evidence: { tree: scanSummary('tree', { findings: [{ location: 'a', kind: 'k', Secret: 'abc' }] }) } });
  assert.match(await noteOf(leaky.context(), 'scan_coverage_complete'), /unexpected field\(s\): Secret/);

  const noReader = setup(t, registrationReport(), { withReader: false });
  assert.equal((await statuses(noReader.context()))['scan_coverage_complete'], 'unknown');
});

test('classification_present: scan findings forbid relaxing to public_candidate; internal or restricted is allowed', async (t) => {
  const findings = [{ location: 'config/old.env', kind: 'generic-api-key', confidence: 'medium' }];
  const relaxed = setup(t, registrationReport({ classification: { proposal: 'public_candidate', rationale_evidence_ids: [IDS.rationale] } }), { evidence: { tree: scanSummary('tree', { findings }) } });
  assert.match(await noteOf(relaxed.context(), 'classification_present'), /1 candidate secret\(s\), so the classification cannot be relaxed to public_candidate/);

  for (const proposal of ['internal', 'restricted']) {
    const strict = setup(t, registrationReport({ classification: { proposal, rationale_evidence_ids: [IDS.rationale] } }), { evidence: { tree: scanSummary('tree', { findings }) } });
    assert.equal((await statuses(strict.context()))['classification_present'], 'pass', proposal);
  }

  // 후보가 없으면 public_candidate 도 허용
  const clean = setup(t, registrationReport({ classification: { proposal: 'public_candidate', rationale_evidence_ids: [IDS.rationale] } }));
  assert.equal((await statuses(clean.context()))['classification_present'], 'pass');
});

test('classification_present: a missing classification or rationale fails; a broken scan is left to scan_coverage_complete (unknown here)', async (t) => {
  const none = setup(t, withoutKeys(registrationReport(), 'classification'));
  assert.equal((await statuses(none.context()))['classification_present'], 'fail');

  const noRationaleRow = setup(t, registrationReport({ classification: { proposal: 'internal', rationale_evidence_ids: ['ev-nowhere'] } }));
  assert.match(await noteOf(noRationaleRow.context(), 'classification_present'), /ev-nowhere/);
  assert.equal((await statuses(noRationaleRow.context()))['classification_present'], 'fail');

  const brokenScan = setup(t, registrationReport(), { evidence: { tree: scanSummary('tree', { complete: 'yes' }) } });
  const result = await statuses(brokenScan.context());
  assert.equal(result['classification_present'], 'unknown');
  assert.equal(result['scan_coverage_complete'], 'fail');
});
