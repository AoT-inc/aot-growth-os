// 효과 해소 다중 프로세스 시험: 데몬(정책 게이트 + 승인 엔진 + 효과 해소 채널 + 승인 소켓) 프로세스와 사람용 CLI(apps/daemon/src/approve.ts) 프로세스가 따로 돈다.
//  - 멱등 키 없는 외부 도구가 응답을 잃어 unknown → 업무는 needs_review. 사람이 `effects` 로 보고 `resolve-effect` 로 확정한다
//  - 에이전트 actor 는 인증 단계에서 거부(not_human), 소켓 권한이 없는 프로세스는 접속하지 못한다(EACCES)
//  - 같은 결과를 동시에 확정하는 CLI 둘 → applied:true 하나, applied:false 하나, 이벤트 1건. 확정 뒤 업무를 다시 올리면 그 단계는 재사용되어 재전송이 없다
//  - confirmed 와 failed(--totp-stdin)를 동시에 → 정확히 하나만 ok, 나머지는 outcome_conflict. 재인증 행은 이긴 쪽에 맞는다
// 시각은 부모가 IPC 로 정한다(가짜 시계). 요청 본문 표식과 TOTP 코드는 어떤 CLI 출력에도 나오지 않는다.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { applyMigrations, FakeClock, openDb, seedPhaseA, type Db } from '@aot/domain';
import { base32Decode, createPolicyGate, generateTotpSecret, PolicyStore, totpCode, TotpSecretStore } from '@aot/policy';
import { createTask, effectResolutionEventId } from '@aot/task-engine';

import { DEFAULT_POLICY_TEMPLATE, defaultInstancePaths } from '../../apps/daemon/src/assemble.ts';
import { runApproveCli, type CliResult } from '../support/approve-cli.ts';
import { taskStatus } from '../support/engine.ts';
import { effectDraft } from '../support/policy.ts';
import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';
import { addAgent } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const T0 = Date.parse('2026-10-19T00:00:00.000Z');
const HOUR = 3_600_000;
const OWNER = 'actor-owner';
const AGENT = 'actor-agent-1';
const NOTE = 'seen in the example.com outbox';
/** workers/effect-daemon.ts 의 요청 본문 표식 */
const BODY_MARKER = 'BODY-MARKER-77d1c2e0';

interface Env { dir: string; instance: string; dbPath: string; db: Db; toolStore: string; secret: string; tasks: string[] }

function setup(t: TestContext): Env {
  const dir = makeTempDir(t);
  const instance = join(dir, 'i');
  const dbPath = join(dir, 'aot.db');
  const db = openDb({ path: dbPath });
  t.after(() => db.close());
  const clock = new FakeClock(T0);
  applyMigrations(db, { dir: MIGRATIONS_DIR, clock });
  seedPhaseA(db, { clock });
  addAgent(db, clock, AGENT);
  const paths = defaultInstancePaths(instance);
  const secret = new TotpSecretStore(paths.totpDir).enroll(OWNER, generateTotpSecret());
  const gate = createPolicyGate({ store: new PolicyStore({ dir: paths.policyStoreDir, templates: [DEFAULT_POLICY_TEMPLATE] }) });
  const tasks = [1, 2].map((n) => createTask(db, { clock, gate }, { spec: effectDraft({ inputs: [{ name: 'n', ref: `r:task-${n}`, kind: 'k' }] }) }).taskId);
  return { dir, instance, dbPath, db, toolStore: join(dir, 'deliveries.jsonl'), secret, tasks };
}

type Message = { type: string; [key: string]: unknown };
interface TickReport { sentToReview: string[]; executed: { taskId: string; end: { outcome: string; taskStatus: string } } | null }

class EffectDaemon {
  readonly child: ChildProcess;
  readonly #inbox: Message[] = [];
  readonly #waiters: { type: string; resolve: (m: Message) => void }[] = [];
  readonly #exited: Promise<unknown>;

  constructor(t: TestContext, env: Env) {
    this.child = fork(new URL('./workers/effect-daemon.ts', import.meta.url), [env.dbPath, env.instance, env.toolStore]);
    this.#exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.on('message', (raw) => {
      const message = raw as Message;
      if (message.type === 'error') throw new Error(`effect daemon: ${String(message['message'])}`);
      const waiter = this.#waiters.findIndex((w) => w.type === message.type);
      if (waiter >= 0) this.#waiters.splice(waiter, 1)[0]!.resolve(message);
      else this.#inbox.push(message);
    });
    t.after(() => this.kill());
  }

  next(type: string): Promise<Message> {
    const index = this.#inbox.findIndex((m) => m.type === type);
    if (index >= 0) return Promise.resolve(this.#inbox.splice(index, 1)[0]!);
    return new Promise((resolve) => this.#waiters.push({ type, resolve }));
  }

  async set(now: number): Promise<void> {
    this.child.send({ cmd: 'set', now });
    await this.next('set');
  }

  /** 다음 전송 `count` 건은 부작용을 일으킨 뒤 응답을 잃는다 */
  async lose(count = 1): Promise<void> {
    this.child.send({ cmd: 'lose', count });
    await this.next('lose');
  }

  async tick(now: number): Promise<TickReport> {
    this.child.send({ cmd: 'tick', now });
    return (await this.next('tick'))['report'] as TickReport;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.#exited;
  }
}

const deliveries = (env: Env): number => (existsSync(env.toolStore) ? readFileSync(env.toolStore, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const count = (db: Db, table: string): number => Number(db.get(`SELECT count(*) AS n FROM ${table}`)?.['n']);
const effectOf = (db: Db, taskId: string) => db.get<{ id: string; state: string; response_ref: string | null }>('SELECT id, state, response_ref FROM external_effect WHERE task_id = ?', [taskId])!;
const outputOf = (...results: CliResult[]): string => results.map((r) => r.stdout + r.stderr).join('\n');

/**
 * 데몬을 띄우고, 두 업무를 승인·해제해 각각 부작용 한 건의 응답을 잃게 한다 → 두 업무 모두 needs_review, 효과는 unknown.
 * 돌려주는 `now` 는 데몬의 현재 가짜 시각이고, `code()` 는 그 시각의 사람 TOTP 코드다.
 */
async function prepare(t: TestContext, stage: 'daemon' | 'unknown' = 'unknown') {
  const env = setup(t);
  const daemon = new EffectDaemon(t, env);
  const socket = String((await daemon.next('ready'))['socket']);
  let now = T0;
  await daemon.set(now);
  const cli = (args: string[], actor = OWNER, stdin?: string) => runApproveCli(args, { socket, actor, ...(stdin === undefined ? {} : { stdin }) });
  const setNow = async (value: number): Promise<void> => {
    now = value;
    await daemon.set(now);
  };
  const code = (atMs = now): string => totpCode(base32Decode(env.secret), atMs);
  // `now` 는 getter 다: 펼치면(`...base`) 그 순간 값으로 굳으므로 반환은 Object.assign 으로 getter 를 살려 둔다
  const base = { env, daemon, socket, cli, code, setNow, get now() { return now; } };
  if (stage === 'daemon') return Object.assign(base, { first: env.tasks[0]!, second: env.tasks[1]!, effects: [] as string[] });

  // 승인이 없으면 실행되지 않는다
  assert.deepEqual([...(await daemon.tick(now)).sentToReview].sort(), [...env.tasks].sort());
  for (const id of env.tasks) {
    const shown = await cli(['show', 'task', id]);
    assert.equal(shown.code, 0, shown.stderr);
    const approved = await cli(['approve', 'task', id, '--hash', String(shown.json?.['hash'])]);
    assert.equal(approved.json?.['state'], 'cooldown', approved.stdout);
  }
  // cooldown 이 끝난 뒤 업무마다 다른 시간창의 TOTP 로 해제
  await setNow(T0 + HOUR + 5_000);
  for (const id of env.tasks) {
    const released = await cli(['release', 'task', id, '--totp-stdin'], OWNER, `${code()}\n`);
    assert.deepEqual(released.json, { ok: true, state: 'queued' }, released.stdout + released.stderr);
    await setNow(now + 35_000);
  }
  // 업무마다 응답을 잃게 한다. 어느 업무가 먼저 집힐지는 정하지 않는다 (id 순서)
  const order: string[] = [];
  for (let i = 0; i < env.tasks.length; i += 1) {
    await daemon.lose(1);
    now += 1_000;
    const ran = await daemon.tick(now);
    assert.deepEqual(ran.executed?.end, { outcome: 'effect_unknown', taskStatus: 'needs_review' });
    order.push(ran.executed!.taskId);
  }
  assert.deepEqual([...order].sort(), [...env.tasks].sort());
  for (const id of order) assert.equal(taskStatus(env.db, id), 'needs_review');
  assert.equal(deliveries(env), 2, 'the two lost sends did reach the outside');
  const effects = order.map((id) => effectOf(env.db, id).id);
  return Object.assign(base, { first: order[0]!, second: order[1]!, effects });
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

/** 사람이 다시 승인(show → approve)해 needs_review 업무를 queued 로 되돌린다 (이미 cooldown·재인증을 마친 승인 해시 그대로) */
async function requeue(p: Prepared, taskId: string): Promise<void> {
  const shown = await p.cli(['show', 'task', taskId]);
  assert.equal(shown.code, 0, shown.stderr);
  const approved = await p.cli(['approve', 'task', taskId, '--hash', String(shown.json?.['hash'])]);
  assert.equal(approved.json?.['state'], 'queued', approved.stdout);
  assert.equal(taskStatus(p.env.db, taskId), 'queued');
}

test('effects: a human lists the unknown rows without keys or bodies; an agent actor is refused at the authentication step', async (t) => {
  const p = await prepare(t);
  const listed = await p.cli(['effects']);
  assert.equal(listed.code, 0, listed.stderr);
  const rows = listed.json?.['effects'] as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => r['effect_id']).sort(), [...p.effects].sort());
  for (const row of rows) {
    assert.equal(row['task_status'], 'needs_review');
    assert.equal(row['tool'], 'notify-tool');
    assert.equal(row['supports_idempotency'], false);
    assert.equal(row['resend_window_open'], false);
    assert.equal(row['run_active'], false);
    assert.equal(row['resolved_before'], false);
  }
  const reread = p.env.db.get<{ effect_key: string }>('SELECT effect_key FROM external_effect WHERE id = ?', [p.effects[0]!])!;
  assert.ok(!outputOf(listed).includes(BODY_MARKER));
  assert.ok(!outputOf(listed).includes(reread.effect_key));
  assert.ok(!outputOf(listed).includes('effect_key'));
  assert.equal(count(p.env.db, 'event'), 0, 'listing writes nothing');

  const byAgent = await p.cli(['effects'], AGENT);
  assert.equal(byAgent.code, 1);
  assert.equal(byAgent.json?.['code'], 'not_human');
  assert.match(String(byAgent.json?.['error']), /only human actors/);
  const resolveByAgent = await p.cli(['resolve-effect', p.effects[0]!, '--outcome', 'confirmed', '--note', NOTE], AGENT);
  assert.equal(resolveByAgent.code, 1);
  assert.equal(resolveByAgent.json?.['code'], 'not_human');
  assert.equal(count(p.env.db, 'event'), 0);
  assert.equal(effectOf(p.env.db, p.first).state, 'unknown');
});

// root 는 파일 권한을 무시하므로 chmod 000 소켓에도 접속된다 (기존 소켓 시험들의 알려진 한계). root 가 아닐 때만 확인한다.
const asRoot = process.getuid?.() === 0;
test('a process without permission on the socket cannot list or resolve (EACCES)', { skip: asRoot ? 'running as root: file permissions do not apply (same limitation as the other socket tests)' : false }, async (t) => {
  const p = await prepare(t, 'daemon');
  chmodSync(p.socket, 0o000);
  let listed;
  let resolved;
  try {
    listed = await p.cli(['effects']);
    resolved = await p.cli(['resolve-effect', 'effect-any', '--outcome', 'confirmed', '--note', NOTE]);
  } finally {
    chmodSync(p.socket, 0o600);
  }
  for (const denied of [listed, resolved]) {
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /EACCES/);
  }
  assert.equal(count(p.env.db, 'event'), 0);
});

test('CLI argument handling: a missing id, --outcome or --note is exit 2 before connecting; the daemon, not the CLI, judges the values', async (t) => {
  const p = await prepare(t, 'daemon');
  const noId = await p.cli(['resolve-effect', '--outcome', 'confirmed', '--note', NOTE]);
  assert.equal(noId.code, 2);
  assert.match(noId.stderr, /resolve-effect needs an effect id/);
  const noOutcome = await p.cli(['resolve-effect', 'effect-any', '--note', NOTE]);
  assert.equal(noOutcome.code, 2);
  const noNote = await p.cli(['resolve-effect', 'effect-any', '--outcome', 'confirmed']);
  assert.equal(noNote.code, 2);
  const extraId = await p.cli(['resolve-effect', 'effect-any', 'effect-other', '--outcome', 'confirmed', '--note', NOTE]);
  assert.equal(extraId.code, 2);
  assert.match(extraId.stderr, /resolve-effect takes one effect id/);
  for (const result of [noId, noOutcome, noNote, extraId]) assert.equal(result.stdout, '');

  const badOutcome = await p.cli(['resolve-effect', 'effect-any', '--outcome', 'maybe', '--note', NOTE]);
  assert.equal(badOutcome.code, 1);
  assert.equal(badOutcome.json?.['code'], 'invalid_outcome');
  const blankNote = await p.cli(['resolve-effect', 'effect-any', '--outcome', 'confirmed', '--note', '   ']);
  assert.equal(blankNote.code, 1);
  assert.equal(blankNote.json?.['code'], 'note_required');
  const missing = await p.cli(['resolve-effect', 'effect-any', '--outcome', 'confirmed', '--note', NOTE]);
  assert.equal(missing.code, 1);
  assert.equal(missing.json?.['code'], 'not_found');
  assert.equal(count(p.env.db, 'event'), 0);
});

test('two CLI processes confirming the same effect at once: exactly one applied:true, one applied:false, one event; re-queued, the step is reused without a send', async (t) => {
  const p = await prepare(t);
  const effectId = effectOf(p.env.db, p.first).id;
  const args = ['resolve-effect', effectId, '--outcome', 'confirmed', '--note', NOTE];

  const results = await Promise.all([p.cli(args), p.cli(args)]);
  for (const result of results) assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(results.map((r) => r.json?.['applied']).sort(), [false, true]);
  const eventId = effectResolutionEventId(effectId);
  const applied = results.find((r) => r.json?.['applied'] === true)!.json!;
  const replayed = results.find((r) => r.json?.['applied'] === false)!.json!;
  assert.equal(applied['event_id'], eventId);
  assert.equal(applied['response_ref'], `human:${eventId}`);
  assert.equal(applied['previous_state'], 'unknown');
  assert.equal(replayed['event_id'], eventId);
  assert.equal(replayed['resolved_by'], OWNER);
  assert.equal(replayed['note'], NOTE);
  assert.equal(replayed['outcome'], 'confirmed');

  assert.equal(count(p.env.db, 'event'), 1);
  assert.deepEqual({ ...effectOf(p.env.db, p.first) }, { id: effectId, state: 'confirmed', response_ref: `human:${eventId}` });
  assert.equal(taskStatus(p.env.db, p.first), 'needs_review', 'the resolution does not change the task');
  assert.equal(count(p.env.db, "human_reauth WHERE purpose LIKE 'effect-resolve:%'"), 0);
  assert.ok(!outputOf(...results).includes(BODY_MARKER));
  assert.equal(effectOf(p.env.db, p.second).state, 'unknown', 'the other effect is untouched');
  const remaining = await p.cli(['effects']);
  assert.deepEqual((remaining.json?.['effects'] as { effect_id: string }[]).map((e) => e.effect_id), [effectOf(p.env.db, p.second).id]);

  // 사람이 업무를 다시 올리면 다음 tick 에 그 단계는 재사용되고 다시 보내지 않는다
  const sendsBefore = deliveries(p.env);
  await requeue(p, p.first);
  await p.setNow(p.now + 120_000);
  const ran = await p.daemon.tick(p.now);
  assert.equal(ran.executed?.taskId, p.first);
  assert.deepEqual(ran.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(deliveries(p.env), sendsBefore, 'no second send');
  assert.equal(taskStatus(p.env.db, p.first), 'validating');
  assert.equal(effectOf(p.env.db, p.first).state, 'confirmed');

  // 대조: 해소하지 않은 쪽을 다시 올리면 새 run 도 보내지 못하고(멱등 키 없음) unknown 때문에 다시 needs_review
  await requeue(p, p.second);
  await p.setNow(p.now + 120_000);
  const control = await p.daemon.tick(p.now);
  assert.equal(control.executed?.taskId, p.second);
  assert.deepEqual(control.executed?.end, { outcome: 'effect_unknown', taskStatus: 'needs_review' });
  assert.equal(deliveries(p.env), sendsBefore);
  assert.equal(effectOf(p.env.db, p.second).state, 'unknown');
});

test('confirmed and failed (with a TOTP) at once: exactly one wins, the other is outcome_conflict; the re-authentication count matches the winner', async (t) => {
  const p = await prepare(t);
  const effectId = effectOf(p.env.db, p.second).id;
  const releases = count(p.env.db, 'human_reauth');
  assert.equal(releases, 2);

  // failed 는 TOTP 가 필요하다: 없으면 reauth_required, 틀리면 reauth_failed — 아무것도 쓰이지 않는다
  const withoutCode = await p.cli(['resolve-effect', effectId, '--outcome', 'failed', '--note', 'not delivered']);
  assert.equal(withoutCode.code, 1);
  assert.equal(withoutCode.json?.['code'], 'reauth_required');
  const wrong = String((Number(p.code()) + 1) % 1_000_000).padStart(6, '0');
  const badCode = await p.cli(['resolve-effect', effectId, '--outcome', 'failed', '--note', 'not delivered', '--totp-stdin'], OWNER, `${wrong}\n`);
  assert.equal(badCode.code, 1);
  assert.equal(badCode.json?.['code'], 'reauth_failed');
  assert.equal(count(p.env.db, 'event'), 0);
  assert.equal(count(p.env.db, 'human_reauth'), releases);

  // 마지막으로 쓴 시간창보다 확실히 뒤의 시각에서 올바른 코드로 동시에 보낸다
  await p.setNow(p.now + 120_000);
  const code = p.code();
  const [confirmed, failed] = await Promise.all([
    p.cli(['resolve-effect', effectId, '--outcome', 'confirmed', '--note', NOTE]),
    p.cli(['resolve-effect', effectId, '--outcome', 'failed', '--note', 'not delivered', '--totp-stdin'], OWNER, `${code}\n`),
  ]);
  const winners = [confirmed, failed].filter((r) => r.json?.['ok'] === true);
  const losers = [confirmed, failed].filter((r) => r.json?.['ok'] === false);
  assert.equal(winners.length, 1, outputOf(confirmed, failed));
  assert.equal(losers.length, 1);
  assert.equal(losers[0]!.code, 1);
  assert.equal(losers[0]!.json?.['code'], 'outcome_conflict');
  assert.equal(winners[0]!.code, 0);
  assert.equal(winners[0]!.json?.['applied'], true);

  const winner = winners[0] === confirmed ? 'confirmed' : 'failed';
  const resolutionReauth = count(p.env.db, "human_reauth WHERE purpose LIKE 'effect-resolve:%'");
  assert.equal(resolutionReauth, winner === 'failed' ? 1 : 0, 'a conflicting request does not spend a code');
  assert.equal(count(p.env.db, 'human_reauth'), releases + resolutionReauth);
  if (winner === 'failed') {
    const row = p.env.db.get<{ actor_id: string; purpose: string; at: string }>("SELECT actor_id, purpose, at FROM human_reauth WHERE purpose LIKE 'effect-resolve:%'")!;
    assert.deepEqual({ ...row }, { actor_id: OWNER, purpose: `effect-resolve:${effectId}:failed`, at: new Date(p.now).toISOString() });
  }
  assert.equal(count(p.env.db, 'event'), 1);
  const event = p.env.db.get<{ payload: string }>('SELECT payload FROM event')!;
  assert.equal((JSON.parse(event.payload) as { outcome: string }).outcome, winner);
  assert.equal(effectOf(p.env.db, p.second).state, winner);
  assert.equal(effectOf(p.env.db, p.first).state, 'unknown');
  assert.equal(taskStatus(p.env.db, p.second), 'needs_review');

  // 어디에도 코드·표식이 새지 않는다
  const everything = outputOf(withoutCode, badCode, confirmed, failed) + JSON.stringify([p.env.db.all('SELECT * FROM event'), p.env.db.all('SELECT * FROM human_reauth')]);
  for (const secret of [code, wrong, BODY_MARKER, p.env.secret]) assert.ok(!everything.includes(secret));

  // 이긴 쪽과 같은 결정을 다시 보내면 재인증 없이 applied:false
  const repeat = winner === 'failed'
    ? await p.cli(['resolve-effect', effectId, '--outcome', 'failed', '--note', 'again'])
    : await p.cli(['resolve-effect', effectId, '--outcome', 'confirmed', '--note', 'again']);
  assert.equal(repeat.code, 0, repeat.stdout + repeat.stderr);
  assert.equal(repeat.json?.['applied'], false);
  assert.equal(count(p.env.db, 'event'), 1);
});
