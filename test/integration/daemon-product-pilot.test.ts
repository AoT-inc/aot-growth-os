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
  assert.equal(pilot['summary'].supported_but_rejected, 0);
  assert.equal(pilot['summary'].criterion.met, null, 'fewer than five decided products: no verdict on the criterion yet');
  assert.ok(pilot['summary'].token_ratio_mean > 0);
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
  assert.equal(pilot['summary'].agreement, 1);
});

test('pilot criterion: a verdict of supported that a person rejects is counted and fails the criterion; five decided with none keeps it met', async (t) => {
  const r = rig(t, { default: 'supported' });
  for (const slug of ['p-one', 'p-two', 'p-three', 'p-four']) {
    const status = await r.verified(slug);
    assert.equal((await r.send({ op: 'decide', slug, decision: 'approve', hash: status['product'].review_hash }))['ok'], true);
  }
  assert.equal((await r.send({ op: 'pilot' }))['summary'].criterion.met, null, 'four decided so far');
  const fifth = await r.verified('p-five');
  assert.equal((await r.send({ op: 'decide', slug: 'p-five', decision: 'approve', hash: fifth['product'].review_hash }))['ok'], true);
  const done = (await r.send({ op: 'pilot' }))['summary'];
  assert.deepEqual([done.decided, done.supported_but_rejected, done.criterion.met, done.criterion.failed, done.agreement], [5, 0, true, false, 1]);

  const sixth = await r.verified('p-six');
  assert.equal(sixth['product'].shadow_verdict.verdict, 'supported');
  assert.equal((await r.send({ op: 'decide', slug: 'p-six', decision: 'reject', comment: 'a person found a secret the scanner missed' }))['ok'], true);
  const after = (await r.send({ op: 'pilot' }))['summary'];
  assert.deepEqual([after.supported_but_rejected, after.criterion.failed, after.criterion.met], [1, true, false]);
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
  assert.equal(((pilot.json!['summary'] as Reply)['decided']), 1);
  // 사용법 오류는 소켓에 닿기 전에 종료 코드 2
  for (const args of [['add', 'x'], ['decide', 'example-product', 'maybe'], ['decide', 'example-product', 'reject'], ['evidence', 'example-product'], ['nope']]) {
    const failed = await cli(args);
    assert.equal(failed.code, 2, args.join(' '));
  }
  // 에이전트 actor 는 채널이 거부한다
  const agent = await runApproveCli(['product', 'status'], { socket: channel.socketPath, actor: AGENT });
  assert.equal(agent.json!['code'], 'not_human');
});
