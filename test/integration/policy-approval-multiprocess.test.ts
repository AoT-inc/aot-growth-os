// A3 다중 프로세스 시험: 데몬(정책 게이트 + 승인 엔진 + 승인 소켓) 프로세스와 사람용 승인 CLI 프로세스가 따로 돌며
// 승인 → 대기 → TOTP 해제 → 실행(외부 부작용 1건) 흐름 1건을 끝까지 수행한다 (phase-a §3 "승인").
// 데몬의 시각은 부모가 IPC 로 정한다(가짜 시계). CLI 는 실제 apps/daemon/src/approve.ts 다.
// 마지막 시험은 실제 엔트리포인트(apps/daemon/src/main.ts, 시스템 시계)가 승인 소켓을 열고 닫는지 확인한다.
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyMigrations, FakeClock, openDb, seedPhaseA, type Db } from '@aot/domain';
import { base32Decode, createPolicyGate, generateTotpSecret, PolicyStore, totpCode, TotpSecretStore } from '@aot/policy';
import { createTask } from '@aot/task-engine';

import { DEFAULT_POLICY_TEMPLATE, defaultInstancePaths } from '../../apps/daemon/src/assemble.ts';
import { runApproveCli } from '../support/approve-cli.ts';
import { taskStatus } from '../support/engine.ts';
import { effectDraft } from '../support/policy.ts';
import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';
import { addAgent } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const T0 = Date.parse('2026-10-19T00:00:00.000Z');
const HOUR = 3_600_000;
const OWNER = 'actor-owner';
const AGENT = 'actor-agent-1';

interface Env { dir: string; instance: string; dbPath: string; db: Db; toolStore: string; secret: string; taskId: string }

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
  const taskId = createTask(db, { clock, gate }, { spec: effectDraft() }).taskId;
  return { dir, instance, dbPath, db, toolStore: join(dir, 'deliveries.jsonl'), secret, taskId };
}

type Message = { type: string; [key: string]: unknown };

class PolicyDaemon {
  readonly child: ChildProcess;
  readonly #inbox: Message[] = [];
  readonly #waiters: { type: string; resolve: (m: Message) => void }[] = [];
  readonly #exited: Promise<unknown>;

  constructor(t: TestContext, env: Env) {
    this.child = fork(new URL('./workers/policy-daemon.ts', import.meta.url), [env.dbPath, env.instance, env.toolStore]);
    this.#exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.on('message', (raw) => {
      const message = raw as Message;
      if (message.type === 'error') throw new Error(`policy daemon: ${String(message['message'])}`);
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

  set(now: number): Promise<Message> {
    this.child.send({ cmd: 'set', now });
    return this.next('set');
  }

  async tick(now: number): Promise<{ sentToReview: string[]; executed: { taskId: string; end: unknown } | null }> {
    this.child.send({ cmd: 'tick', now });
    return (await this.next('tick'))['report'] as never;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.#exited;
  }
}

const deliveries = (env: Env) => (existsSync(env.toolStore) ? readFileSync(env.toolStore, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('daemon and approval CLI as separate processes: approve → cooldown → TOTP release → run with one external effect', async (t) => {
  const env = setup(t);
  const daemon = new PolicyDaemon(t, env);
  const socket = String((await daemon.next('ready'))['socket']);
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  const cli = (args: string[], actor = OWNER, stdin?: string) => runApproveCli(args, { socket, actor, ...(stdin === undefined ? {} : { stdin }) });

  // 1. 승인 없이는 실행되지 않는다
  assert.deepEqual((await daemon.tick(T0)).sentToReview, [env.taskId]);
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');

  // 2. 에이전트는 승인 채널의 인증 단계에서 거부된다
  const byAgent = await cli(['show', 'task', env.taskId], AGENT);
  assert.equal(byAgent.code, 1);
  assert.match(String(byAgent.json?.['error']), /only human actors/);

  // 3. 사람이 보고(show) 그 해시로 승인 → 대기
  const listed = await cli(['list']);
  assert.deepEqual((listed.json?.['tasks'] as { id: string }[]).map((x) => x.id), [env.taskId]);
  const shown = await cli(['show', 'task', env.taskId]);
  assert.equal(shown.code, 0, shown.stderr);
  const hash = String(shown.json?.['hash']);
  const approved = await cli(['approve', 'task', env.taskId, '--hash', hash, '--comment', 'example approval']);
  assert.equal(approved.json?.['state'], 'cooldown', approved.stdout);
  assert.equal((await daemon.tick(T0 + 60_000)).executed, null);

  // 4. 대기 중 해제 시도는 거부, 대기 뒤 TOTP(표준 입력)로 해제
  const early = await cli(['release', 'task', env.taskId, '--totp-stdin'], OWNER, `${totpCode(base32Decode(env.secret), T0 + 60_000)}\n`);
  assert.match(String(early.json?.['error']), /cooldown until/);
  await daemon.set(T0 + HOUR + 5_000);
  const code = totpCode(base32Decode(env.secret), T0 + HOUR + 5_000);
  const released = await cli(['release', 'task', env.taskId, '--totp-stdin'], OWNER, `${code}\n`);
  assert.deepEqual(released.json, { ok: true, state: 'queued' });
  const replay = await cli(['release', 'task', env.taskId, '--totp-stdin'], OWNER, `${code}\n`);
  assert.equal(replay.code, 1, 'the task is no longer waiting, and the code is spent');

  // 5. 데몬이 실행: 실행 직전·부작용 직전 재검증을 통과하고 부작용은 정확히 1건
  const ran = await daemon.tick(T0 + HOUR + 10_000);
  assert.equal(ran.executed?.taskId, env.taskId);
  assert.deepEqual(ran.executed?.end, { outcome: 'submitted', taskStatus: 'validating' });
  assert.equal(deliveries(env), 1);
  const checks = env.db.all<{ reason: string; task_run_id: string | null }>("SELECT reason, task_run_id FROM policy_decision WHERE task_id = ? AND action = 'notify-tool.send' ORDER BY id", [env.taskId]);
  assert.ok(checks.some((c) => /approval: valid \(re-check before run\)/.test(c.reason)));
  assert.ok(checks.some((c) => c.task_run_id !== null && /approval: valid \(re-check before external effect, first\)/.test(c.reason)));
  assert.equal(env.db.get<{ n: number }>("SELECT count(*) AS n FROM approval WHERE subject_id = ? AND decided_by = ?", [env.taskId, OWNER])!.n, 1);
  assert.equal(env.db.get<{ n: number }>('SELECT count(*) AS n FROM human_reauth')!.n, 1);
});

test('the real daemon entrypoint opens the approval socket (0600) and closes it on SIGTERM', async (t) => {
  const env = setup(t);
  const config = join(env.dir, 'daemon.config.json');
  writeFileSync(config, JSON.stringify({ db_path: env.dbPath, worker_id: 'daemon-main', instance_dir: env.instance, poll_ms: 50 }));
  const main = spawn(process.execPath, [fileURLToPath(new URL('../../apps/daemon/src/main.ts', import.meta.url)), config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  main.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  main.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => main.once('exit', resolve));
  t.after(() => {
    if (main.exitCode === null) main.kill('SIGKILL');
  });
  const socket = defaultInstancePaths(env.instance).approvalSocket;
  for (let i = 0; i < 200 && !output.includes('approval channel ready'); i += 1) await sleep(25);
  assert.match(output, /approval channel ready/);
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.deepEqual((await runApproveCli(['whoami'], { socket, actor: OWNER })).json, { ok: true, actor: OWNER, kind: 'human' });
  // 실제 시스템 시계의 데몬도 승인이 필요한 업무는 실행하지 않는다
  for (let i = 0; i < 200 && taskStatus(env.db, env.taskId) !== 'needs_review'; i += 1) await sleep(25);
  assert.equal(taskStatus(env.db, env.taskId), 'needs_review');
  main.kill('SIGTERM');
  assert.equal(await exited, 0, output);
  assert.match(output, /stopped/);
});
