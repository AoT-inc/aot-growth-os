// 섀도 파일럿 준비 (docs/plans/registration-dogfood.md 4단계)를 데몬 조립에서 끝까지:
//   사람이 승인 소켓의 `product` 명령으로 후보를 올리고(add) 검증을 시작하고(start), 에이전트(시험용 어댑터)가 도구 7개로 증거를 모으고, 평가기가 검증하며,
//   검증기(가짜 claude 실행 파일, 섀도 모드)는 판정을 기록만 하고, 사람이 증거를 읽고 등록·반려를 결정하고, 파일럿 보고가 둘을 비교한다.
// 에이전트 계층의 실제 모델은 쓰지 않는다. 저장소는 실제 git, 스캐너는 가짜 gitleaks, 검증기는 가짜 claude 다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { buildAgentRuntime } from '../../apps/daemon/src/runtime-config.ts';
import { manualTimers } from '../support/engine.ts';
import { writeFakeVerifierClaude, type FakeVerifierScenario } from '../support/fake-claude-verifier.ts';
import { AGENT, OWNER, policyEnv, type PolicyEnv } from '../support/policy.ts';
import { REGISTRATION_FILES, scriptedAgent, type CallRecord } from '../support/registration-agent.ts';
import { GIT, makeRepo, writeStubGitleaks } from '../support/registration-tools.ts';
import { runApproveCli } from '../support/approve-cli.ts';
import { makeTempDir } from '../support/temp.ts';

const GITLEAKS_CONFIG = new URL('../../config/gitleaks-registration.toml', import.meta.url).pathname;
const CONSENT = { notice_version: 'notice-1', accepted_at: '2026-10-26T00:00:00.000Z' };

type Reply = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Rig {
  env: PolicyEnv;
  dir: string;
  daemon: ReturnType<typeof assembleDaemon>;
  calls: CallRecord[];
  send(request: Record<string, unknown>, actor?: string): Promise<Reply>;
  /** 후보를 올리고 검증을 시작하고 업무를 실행·검증한 뒤 status 를 돌려준다 */
  verified(slug: string): Promise<Reply>;
  repo(): string;
}

function rig(t: TestContext, verifier: FakeVerifierScenario = { default: 'supported' }): Rig {
  const env = policyEnv(t);
  const dir = makeTempDir(t, 'aot-pilot-');
  const scanner = writeStubGitleaks(dir, { kind: 'clean' });
  const fake = writeFakeVerifierClaude(dir, verifier);
  const built = buildAgentRuntime(
    {
      claude_code_cli: { claude_path: fake.path, run_root: join(dir, 'r'), env: { home: dir, user: 'example-daemon', path: `${process.execPath.replace(/\/node$/, '')}:/usr/bin:/bin` }, model: 'executor-alias' },
      registration_tools: { git_path: GIT, gitleaks_path: scanner.path, gitleaks_config: GITLEAKS_CONFIG, evidence_dir: join(dir, 'evidence') },
      llm_verifier: { kind: 'claude_code_cli', model: 'verifier-alias', shadow: true },
    },
    dir,
    { db: env.db, clock: env.clock, claudeCodeConsent: () => CONSENT },
  );
  assert.ok(built.agent && built.evaluation && built.productChannel);
  const calls: CallRecord[] = [];
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: { ...built.agent, adapter: scriptedAgent(calls) },
    evaluation: built.evaluation,
    productChannel: built.productChannel,
  });
  const send: Rig['send'] = async (request, actor = OWNER) => (await daemon.handleChannelRequest({ cmd: 'product', actor, ...request })) as Reply;
  const repo = (): string => makeRepo(t, REGISTRATION_FILES);
  const verified: Rig['verified'] = async (slug) => {
    assert.equal((await send({ op: 'add', slug, name: `Example ${slug}`, repo_path: repo() })).ok, true);
    const started = await send({ op: 'start', slug });
    assert.equal(started['ok'], true, JSON.stringify(started));
    await daemon.worker.tick(); // 실행
    await daemon.worker.tick(); // 검증
    return send({ op: 'status', slug });
  };
  return { env, dir, daemon, calls, send, verified, repo };
}

test('end to end: add -> start -> run -> shadow verification -> evidence read -> approve; the pilot report compares the verdict with the decision', async (t) => {
  const r = rig(t);
  const added = await r.send({ op: 'add', slug: 'example-product', name: 'Example Product', repo_path: r.repo() });
  assert.equal(added['ok'], true, JSON.stringify(added));
  assert.deepEqual([added['product'].registration_status, added['product'].access_scope], ['candidate', 'none']);

  const started = await r.send({ op: 'start', slug: 'example-product' });
  assert.equal(started['ok'], true, JSON.stringify(started));
  assert.deepEqual([started['product'].registration_status, started['product'].access_scope], ['verifying', 'read']);
  assert.equal(r.env.db.get("SELECT count(*) AS n FROM event WHERE type = 'registration.read_access_granted'")?.['n'], 1);

  await r.daemon.worker.tick();
  assert.deepEqual(r.calls.map((c) => c.ok), Array(7).fill(true), 'the agent could use every tool once read access was granted');
  const checked = await r.daemon.worker.tick();
  assert.deepEqual(checked.validated.map((v) => v.taskStatus), ['needs_review']);

  const status = await r.send({ op: 'status', slug: 'example-product' });
  const product = status['product'];
  assert.equal(product.registration_status, 'pending_approval', 'the validator moved the product on once the task reached human review');
  assert.equal(product.evaluation.outcome, 'pass');
  assert.deepEqual([product.shadow_verdict.verdict, product.shadow_verdict.verifier], ['supported', 'claude-code-cli-verifier@v1:verifier-alias']);
  assert.equal(product.evidence.length, 7);
  assert.ok(product.evidence.every((row: { verified: boolean }) => row.verified));
  assert.match(product.evaluation.note, /shadow claude-code-cli-verifier@v1:verifier-alias: supported/);

  // 사람은 증거 본문을 읽는다
  const bodies: Reply[] = [];
  for (const row of product.evidence as { id: string }[]) {
    const body = await r.send({ op: 'evidence', slug: 'example-product', evidence_id: row.id });
    assert.equal(body['ok'], true, JSON.stringify(body));
    assert.equal(body['evidence'].hash_matches, true);
    bodies.push(body['evidence']);
  }
  assert.ok(bodies.some((body) => /A small command line tool/.test(body['text'])), 'the README body is among the stored evidence');
  assert.equal((await r.send({ op: 'evidence', slug: 'example-product', evidence_id: 'evidence-nope' }))['code'], 'not_found');

  // 승인은 본 증거에 묶인다
  assert.equal((await r.send({ op: 'decide', slug: 'example-product', decision: 'approve' }))['code'], 'hash_required');
  assert.equal((await r.send({ op: 'decide', slug: 'example-product', decision: 'approve', hash: 'f'.repeat(64) }))['code'], 'hash_mismatch');
  const approved = await r.send({ op: 'decide', slug: 'example-product', decision: 'approve', hash: product.review_hash, comment: 'looks right' });
  assert.equal(approved['ok'], true, JSON.stringify(approved));
  assert.equal(approved['product'].registration_status, 'registered');
  assert.equal(r.env.db.get('SELECT status FROM task WHERE id = ?', [product.task.id])?.['status'], 'completed');
  assert.equal(r.env.db.get("SELECT count(*) AS n FROM approval WHERE decided_by = ? AND decision = 'approved'", [OWNER])?.['n'], 2, 'a product approval and a task approval');
  assert.equal(r.env.db.get("SELECT registration_approval_id AS id FROM product WHERE slug = 'example-product'")?.['id'] !== null, true);
  assert.equal((await r.send({ op: 'decide', slug: 'example-product', decision: 'reject', comment: 'x' }))['code'], 'wrong_state', 'a registered product cannot be rejected through this channel');

  const pilot = await r.send({ op: 'pilot' });
  assert.deepEqual(pilot['rows'].map((row: Reply) => [row['slug'], row['verdict'], row['human']]), [['example-product', 'supported', 'approved']]);
  assert.equal(pilot['summary'].first_decided.supported_but_rejected, 0);
  assert.equal(pilot['summary'].criterion.met, null, 'fewer than five decided products: no verdict on the criterion yet');
  assert.ok(pilot['summary'].first_decided.token_ratio_mean > 0);
});

test('shadow mode: an unsupported verdict does not fail the task; a rejection records the reason, takes the read access back and fails the task', async (t) => {
  const r = rig(t, { default: 'unsupported' });
  const status = await r.verified('example-product');
  assert.equal(status['product'].evaluation.outcome, 'pass', 'the verifier is recorded but does not decide');
  assert.equal(status['product'].shadow_verdict.verdict, 'unsupported');
  assert.equal(status['product'].registration_status, 'pending_approval');
  assert.equal((await r.send({ op: 'decide', slug: 'example-product', decision: 'reject' }))['code'], 'comment_required');
  const rejected = await r.send({ op: 'decide', slug: 'example-product', decision: 'reject', comment: 'the README does not match the code' });
  assert.equal(rejected['ok'], true, JSON.stringify(rejected));
  assert.deepEqual([rejected['product'].registration_status, rejected['product'].access_scope, rejected['product'].task.status], ['rejected', 'none', 'failed']);
  const pilot = await r.send({ op: 'pilot' });
  assert.deepEqual([pilot['rows'][0].verdict, pilot['rows'][0].human], ['unsupported', 'rejected']);
  assert.equal(pilot['summary'].first_decided.agreement, 1);
});

test('pilot criterion: judged on the first five decided products only; a later supported-but-rejected is reported but does not flip it; a verifier that never says supported is not a pass', async (t) => {
  const r = rig(t, { default: 'supported' });
  for (const slug of ['p-one', 'p-two', 'p-three', 'p-four']) {
    const status = await r.verified(slug);
    assert.equal((await r.send({ op: 'decide', slug, decision: 'approve', hash: status['product'].review_hash }))['ok'], true);
    r.env.clock.advance(1000);
  }
  assert.equal((await r.send({ op: 'pilot' }))['summary'].criterion.met, null, 'four decided so far');
  const fifth = await r.verified('p-five');
  assert.equal((await r.send({ op: 'decide', slug: 'p-five', decision: 'approve', hash: fifth['product'].review_hash }))['ok'], true);
  r.env.clock.advance(1000);
  const done = (await r.send({ op: 'pilot' }))['summary'];
  assert.deepEqual([done.first_decided.decided, done.first_decided.supported_but_rejected, done.criterion.met, done.criterion.failed, done.first_decided.agreement], [5, 0, true, false, 1]);

  const sixth = await r.verified('p-six');
  assert.equal(sixth['product'].shadow_verdict.verdict, 'supported');
  assert.equal((await r.send({ op: 'decide', slug: 'p-six', decision: 'reject', comment: 'a person found a secret the scanner missed' }))['ok'], true);
  const after = (await r.send({ op: 'pilot' }))['summary'];
  assert.deepEqual([after.criterion.met, after.criterion.failed], [true, false], 'the criterion is about the first five');
  assert.deepEqual([after.first_decided.decided, after.all_decided.decided, after.all_decided.supported_but_rejected], [5, 6, 1], 'the later miss is still visible');
});

test('pilot criterion: a miss inside the first five fails it, and five approvals of "unclear" verdicts do not count as a pass', async (t) => {
  const missed = rig(t, { default: 'supported' });
  const status = await missed.verified('p-one');
  assert.equal((await missed.send({ op: 'decide', slug: 'p-one', decision: 'reject', comment: 'the README lies about the license' }))['ok'], true);
  void status;
  assert.deepEqual([(await missed.send({ op: 'pilot' }))['summary'].criterion.failed], [true]);

  const vague = rig(t, { default: 'unclear' });
  for (const slug of ['v-one', 'v-two', 'v-three', 'v-four', 'v-five']) {
    const verified = await vague.verified(slug);
    assert.equal((await vague.send({ op: 'decide', slug, decision: 'approve', hash: verified['product'].review_hash }))['ok'], true);
    vague.env.clock.advance(1000);
  }
  const criterion = (await vague.send({ op: 'pilot' }))['summary'].criterion;
  assert.deepEqual([criterion.met, criterion.failed], [false, false]);
  assert.match(criterion.note, /never answered supported/);
});

test('one product counts once even when its verification ran again (several verdict events)', async (t) => {
  const r = rig(t);
  const status = await r.verified('example-product');
  const taskId = status['product'].task.id as string;
  const first = r.env.db.get<{ payload: string }>("SELECT payload FROM event WHERE source = 'shadow-verifier'")!;
  const earlier = { ...JSON.parse(first.payload), task_run_id: 'run-earlier', verdict: 'unsupported' };
  r.env.db.writeTx((tx) => tx.run(
    "INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES ('event-x', 'shadow-verifier', 'run-earlier', 'shadow.verdict', ?, NULL, 'shadow-verifier:run-earlier', ?, ?)",
    [JSON.stringify({ ...earlier, task_id: taskId }), r.env.clock.nowIso(), r.env.clock.nowIso()],
  ));
  const pilot = await r.send({ op: 'pilot' });
  assert.equal(pilot['rows'].length, 1);
  assert.equal(pilot['summary'].verdicts_recorded, 1);
});

test('approval needs a passed evaluation and host-stored verified evidence; a retry attempt that never produced a result is not a validation review', async (t) => {
  const r = rig(t);
  const status = await r.verified('example-product');
  const hash = status['product'].review_hash as string;
  const taskId = status['product'].task.id as string;
  for (const [outcome, safety] of [['inconclusive', 'pass'], ['fail', 'pass'], ['pass', 'fail']] as const) {
    r.env.db.writeTx((tx) => tx.run('UPDATE evaluation SET outcome = ?, safety = ? WHERE task_id = ?', [outcome, safety, taskId]));
    const fresh = (await r.send({ op: 'status', slug: 'example-product' }))['product'].review_hash as string;
    const refused = await r.send({ op: 'decide', slug: 'example-product', decision: 'approve', hash: fresh });
    assert.equal(refused['code'], 'evaluation_not_passed', `${outcome}/${safety}`);
  }
  r.env.db.writeTx((tx) => tx.run("UPDATE evaluation SET outcome = 'pass', safety = 'pass' WHERE task_id = ?", [taskId]));
  void hash;

  // 두 번째 시도가 결과 없이(한도) 끝나 needs_review 가 된 경우: 앞 시도의 평가로 pending_approval 이 되면 안 된다
  const other = rig(t);
  await other.send({ op: 'add', slug: 'example-product', name: 'X', repo_path: other.repo() });
  const started = await other.send({ op: 'start', slug: 'example-product' });
  await other.daemon.worker.tick();
  await other.daemon.worker.tick();
  const run1 = other.env.db.get<{ id: string }>('SELECT id FROM task_run WHERE task_id = ?', [started['task_id']])!;
  other.env.db.writeTx((tx) => {
    tx.run("UPDATE product SET registration_status = 'verifying' WHERE slug = 'example-product'");
    tx.run(
      "INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, outcome) VALUES ('run-2', ?, 2, ?, 'claude-code-cli', ?, ?, 'w1', ?, ?, 'error')",
      [started['task_id'], AGENT, other.env.clock.nowIso(), other.env.clock.nowIso(), other.env.clock.nowIso(), other.env.clock.nowIso()],
    );
  });
  assert.ok(run1.id !== 'run-2');
  assert.equal(other.env.db.get('SELECT status FROM task WHERE id = ?', [started['task_id']])?.['status'], 'needs_review', 'the task is waiting for a person, but not because of a validation');
  const stale = await other.send({ op: 'status', slug: 'example-product' });
  assert.equal(stale['product'].registration_status, 'verifying', 'the earlier attempt evaluation does not make the second attempt a validation review');
  assert.equal(stale['product'].evaluation, null);
});

test('restart: the previous verification task is cancelled, a new one is made from the current template, and only the new task\'s verdict counts', async (t) => {
  const r = rig(t);
  const first = await r.verified('example-product');
  const oldTaskId = first['product'].task.id as string;
  assert.equal(first['product'].registration_status, 'pending_approval');
  assert.equal((await r.send({ op: 'restart', slug: 'example-product' }))['code'], 'comment_required');
  assert.equal((await r.send({ op: 'restart', slug: 'example-product', comment: '  ' }))['code'], 'comment_required');

  const restarted = await r.send({ op: 'restart', slug: 'example-product', comment: 'verify again with the fixed checks' });
  assert.equal(restarted['ok'], true, JSON.stringify(restarted));
  assert.equal(restarted['previous_task_id'], oldTaskId);
  assert.notEqual(restarted['task_id'], oldTaskId);
  assert.deepEqual([restarted['product'].registration_status, restarted['product'].access_scope, restarted['product'].task.id, restarted['product'].task.status], ['verifying', 'read', restarted['task_id'], 'queued']);
  assert.equal(r.env.db.get('SELECT status FROM task WHERE id = ?', [oldTaskId])?.['status'], 'cancelled');
  assert.match(String(r.env.db.get("SELECT reason FROM task_transition WHERE task_id = ? AND to_status = 'cancelled'", [oldTaskId])?.['reason']), /verify again with the fixed checks/);
  assert.equal(r.env.db.get("SELECT count(*) AS n FROM event WHERE type = 'registration.verification_restarted'")?.['n'], 1);
  // 이전 업무의 판정은 낡았다: 새 업무가 판정을 낼 때까지 파일럿에 없다
  assert.equal((await r.send({ op: 'pilot' }))['rows'].length, 0);

  await r.daemon.worker.tick();
  await r.daemon.worker.tick();
  const second = await r.send({ op: 'status', slug: 'example-product' });
  assert.equal(second['product'].registration_status, 'pending_approval');
  assert.equal(second['product'].task.id, restarted['task_id']);
  assert.equal(second['product'].evidence.length, 7, 'the evidence of the new run only');
  assert.notEqual(second['product'].review_hash, first['product'].review_hash);
  assert.equal((await r.send({ op: 'decide', slug: 'example-product', decision: 'approve', hash: first['product'].review_hash }))['code'], 'hash_mismatch', 'an approval of the old evidence set does not carry over');
  assert.equal((await r.send({ op: 'pilot' }))['rows'].length, 1);
  assert.equal((await r.send({ op: 'decide', slug: 'example-product', decision: 'approve', hash: second['product'].review_hash }))['ok'], true);
});

test('restart also works while the product is still verifying (a task waiting for retry), and refuses a running task, a candidate, and decided products', async (t) => {
  const r = rig(t);
  await r.send({ op: 'add', slug: 'example-product', name: 'X', repo_path: r.repo() });
  assert.equal((await r.send({ op: 'restart', slug: 'example-product', comment: 'x' }))['code'], 'wrong_state', 'a candidate has nothing to restart');
  const started = await r.send({ op: 'start', slug: 'example-product' });
  const taskId = started['task_id'] as string;
  r.env.db.writeTx((tx) => tx.run("UPDATE task SET status = 'running' WHERE id = ?", [taskId]));
  assert.equal((await r.send({ op: 'restart', slug: 'example-product', comment: 'x' }))['code'], 'task_active');
  r.env.db.writeTx((tx) => tx.run("UPDATE task SET status = 'retry_wait' WHERE id = ?", [taskId]));
  const restarted = await r.send({ op: 'restart', slug: 'example-product', comment: 'the first attempt hit a budget limit' });
  assert.equal(restarted['ok'], true, JSON.stringify(restarted));
  assert.deepEqual([restarted['product'].registration_status, r.env.db.get('SELECT status FROM task WHERE id = ?', [taskId])?.['status']], ['verifying', 'cancelled']);
  await r.daemon.worker.tick();
  await r.daemon.worker.tick();
  const status = await r.send({ op: 'status', slug: 'example-product' });
  assert.equal((await r.send({ op: 'decide', slug: 'example-product', decision: 'approve', hash: status['product'].review_hash }))['ok'], true);
  assert.equal((await r.send({ op: 'restart', slug: 'example-product', comment: 'x' }))['code'], 'wrong_state', 'a registered product is not re-verified here');
  await r.verified('another-product');
  assert.equal((await r.send({ op: 'decide', slug: 'another-product', decision: 'reject', comment: 'no' }))['ok'], true);
  assert.equal((await r.send({ op: 'restart', slug: 'another-product', comment: 'x' }))['code'], 'wrong_state', 'a rejected product is not restarted');
  assert.equal((await r.send({ op: 'restart', slug: 'example-product', comment: 'x', extra: 1 }))['code'], 'invalid_request');
});

test('a repository can be registered once, and start checks the path again', async (t) => {
  const r = rig(t);
  const path = r.repo();
  assert.equal((await r.send({ op: 'add', slug: 'first', name: 'First', repo_path: path }))['ok'], true);
  const again = await r.send({ op: 'add', slug: 'second', name: 'Second', repo_path: path });
  assert.deepEqual([again['code'], /already a product/.test(again['error'])], ['duplicate', true]);
  // add 뒤에 저장소가 사라지면 start 가 읽기 접근을 승인하지 않는다
  const { rmSync } = await import('node:fs');
  rmSync(path, { recursive: true, force: true });
  const started = await r.send({ op: 'start', slug: 'first' });
  assert.equal(started['code'], 'invalid_repo');
  assert.equal((await r.send({ op: 'status', slug: 'first' }))['product'].access_scope, 'none');
});

test('the channel is for humans only and checks its input; the repository must be a git root outside the daemon directories', async (t) => {
  const r = rig(t);
  assert.equal((await r.send({ op: 'status' }, AGENT))['code'], 'not_human');
  assert.equal((await r.send({ op: 'status' }, 'actor-nobody'))['code'], 'unknown_actor');
  assert.equal((await r.send({ op: 'nope' }))['code'], 'unknown_op');
  assert.equal((await r.send({ op: 'status', repo_path: '/tmp' }))['code'], 'invalid_request');
  const base = { op: 'add', name: 'X' };
  assert.equal((await r.send({ ...base, slug: 'Bad Slug', repo_path: r.repo() }))['code'], 'invalid_request');
  assert.equal((await r.send({ ...base, slug: 'ok-slug', repo_path: 'relative/path' }))['code'], 'invalid_request');
  assert.equal((await r.send({ ...base, slug: 'ok-slug', repo_path: join(r.dir, 'missing') }))['code'], 'invalid_repo');
  assert.equal((await r.send({ ...base, slug: 'ok-slug', repo_path: r.dir }))['code'], 'invalid_repo', 'not a git root (and it holds the daemon directories)');
  const inside = join(r.dir, 'inside');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(inside, '.git'), { recursive: true });
  assert.equal((await r.send({ ...base, slug: 'ok-slug', repo_path: inside }))['code'], 'invalid_repo', 'a repository inside the instance directory is refused');
  const path = r.repo();
  assert.equal((await r.send({ ...base, slug: 'ok-slug', repo_path: path }))['ok'], true);
  assert.equal((await r.send({ ...base, slug: 'ok-slug', repo_path: path }))['code'], 'duplicate');
  assert.equal((await r.send({ op: 'start', slug: 'unknown' }))['code'], 'not_found');
  assert.equal((await r.send({ op: 'start', slug: 'ok-slug' }))['ok'], true);
  assert.equal((await r.send({ op: 'start', slug: 'ok-slug' }))['code'], 'wrong_state', 'a second start is refused');
  assert.equal((await r.send({ op: 'decide', slug: 'ok-slug', decision: 'approve', hash: 'x' }))['code'], 'wrong_state', 'not pending approval yet');
});

test('the approval CLI reaches the product channel over the real socket: add, start, status, usage errors', async (t) => {
  const r = rig(t);
  const channel = await r.daemon.startApprovalChannel();
  t.after(() => channel.close());
  const cli = (args: string[]) => runApproveCli(['product', ...args], { socket: channel.socketPath, actor: OWNER });
  const path = r.repo();
  const added = await cli(['add', 'example-product', '--name', 'Example Product', '--repo', path]);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  assert.equal((added.json!['product'] as Reply)['registration_status'], 'candidate');
  const started = await cli(['start', 'example-product']);
  assert.equal(started.code, 0, started.stdout);
  await r.daemon.worker.tick();
  await r.daemon.worker.tick();
  const summary = await cli(['status']);
  assert.deepEqual((summary.json!['products'] as Reply[]).map((row) => [row['slug'], row['registration_status'], row['shadow_verdict']]), [['example-product', 'pending_approval', 'supported']]);
  const detail = await cli(['status', 'example-product']);
  const hash = (detail.json!['product'] as Reply)['review_hash'] as string;
  const decided = await cli(['decide', 'example-product', 'approve', '--hash', hash]);
  assert.equal(decided.code, 0, decided.stdout);
  const pilot = await cli(['pilot']);
  assert.equal((((pilot.json!['summary'] as Reply)['first_decided'] as Reply)['decided']), 1);
  // 사용법 오류는 소켓에 닿기 전에 종료 코드 2
  for (const args of [['restart', 'example-product'], ['add', 'x'], ['decide', 'example-product', 'maybe'], ['decide', 'example-product', 'reject'], ['evidence', 'example-product'], ['nope'], ['status', '--typo', '1'], ['add', 'y', '--name', 'Y', '--repo', path, '--kinds', 'software']]) {
    const failed = await cli(args);
    assert.equal(failed.code, 2, args.join(' '));
  }
  // 에이전트 actor 는 채널이 거부한다
  const agent = await runApproveCli(['product', 'status'], { socket: channel.socketPath, actor: AGENT });
  assert.equal(agent.json!['code'], 'not_human');
});
