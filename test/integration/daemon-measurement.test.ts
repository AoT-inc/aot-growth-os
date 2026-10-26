// A6-U13 다중 프로세스 시험: 같은 DB 파일을 여는 데몬 두 개(하나만 승인 소켓을 연다)와 사람용 CLI(apps/daemon/src/approve.ts)가 따로 돈다.
//  - 측정 값을 기다리는 업무는 집히지 않고, 그동안 다른 업무는 정상 실행된다(두 데몬 중 하나가 1회)
//  - 소켓 권한이 없는 프로세스는 접속하지 못하고(EACCES), 에이전트 actor 는 인증 단계에서 거부된다
//  - 사람이 CLI 로 값과 첨부(파일의 sha256 과 로컬 참조만)를 넣으면 다음 tick 에 그 업무가 두 데몬을 통틀어 1회 실행된다
//  - 같은 입력의 반복은 이벤트 1건, 다른 값은 거부, 첨부 없는 값은 거부
// 시각은 부모가 IPC 로 정한다(가짜 시계).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { applyMigrations, FakeClock, openDb, seedPhaseA, type Db } from '@aot/domain';
import { createPolicyGate, PolicyStore } from '@aot/policy';
import { createTask } from '@aot/task-engine';

import { DEFAULT_POLICY_TEMPLATE, defaultInstancePaths } from '../../apps/daemon/src/assemble.ts';
import { runApproveCli } from '../support/approve-cli.ts';
import { runsOf, taskStatus } from '../support/engine.ts';
import { AFTER_W43, W43_KEY } from '../support/measurement.ts';
import { readOnlyDraft } from '../support/policy.ts';
import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';
import { addAgent } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const T0 = Date.parse(AFTER_W43);
const OWNER = 'actor-owner';
const AGENT = 'actor-agent-1';

interface Env { dir: string; dbPath: string; db: Db; logPath: string; waiting: string; plain: string }

function setup(t: TestContext): Env {
  const dir = makeTempDir(t);
  const dbPath = join(dir, 'aot.db');
  const db = openDb({ path: dbPath });
  t.after(() => db.close());
  const clock = new FakeClock(T0);
  applyMigrations(db, { dir: MIGRATIONS_DIR, clock });
  seedPhaseA(db, { clock });
  addAgent(db, clock, AGENT);
  const gate = createPolicyGate({ store: new PolicyStore({ dir: join(dir, 'policies'), templates: [DEFAULT_POLICY_TEMPLATE] }) });
  const waiting = createTask(db, { clock, gate }, { spec: readOnlyDraft({ inputs: [{ name: 'conversions', ref: W43_KEY, kind: 'measurement' }] }) }).taskId;
  clock.advance(1_000);
  const plain = createTask(db, { clock, gate }, { spec: readOnlyDraft() }).taskId;
  return { dir, dbPath, db, logPath: join(dir, 'executions.log'), waiting, plain };
}

type Message = { type: string; [key: string]: unknown };

class MeasureDaemon {
  readonly child: ChildProcess;
  readonly #inbox: Message[] = [];
  readonly #waiters: { type: string; resolve: (m: Message) => void }[] = [];
  readonly #exited: Promise<unknown>;

  constructor(t: TestContext, env: Env, id: string, channel: boolean) {
    this.child = fork(new URL('./workers/measure-daemon.ts', import.meta.url), [env.dbPath, join(env.dir, `i-${id.slice(-1)}`), env.logPath, id, channel ? '1' : '0']);
    this.#exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.on('message', (raw) => {
      const message = raw as Message;
      if (message.type === 'error') throw new Error(`${id}: ${String(message['message'])}`);
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

  async tick(now: number): Promise<{ executed: { taskId: string } | null }> {
    this.child.send({ cmd: 'tick', now });
    return (await this.next('tick'))['report'] as never;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.#exited;
  }
}

async function twoDaemons(t: TestContext, env: Env) {
  const a = new MeasureDaemon(t, env, 'daemon-a', true);
  const b = new MeasureDaemon(t, env, 'daemon-b', false);
  const socket = String((await a.next('ready'))['socket']);
  await b.next('ready');
  await Promise.all([a.set(T0), b.set(T0)]);
  assert.equal(socket, defaultInstancePaths(join(env.dir, 'i-a')).approvalSocket);
  /** 두 데몬이 같은 시각에 동시에 tick 한다 */
  const tickBoth = (now: number) => Promise.all([a.tick(now), b.tick(now)]);
  return { socket, tickBoth };
}

const executions = (env: Env, taskId: string): string[] =>
  (existsSync(env.logPath) ? readFileSync(env.logPath, 'utf8').trim().split('\n').filter(Boolean) : []).filter((line) => line.endsWith(` ${taskId}`));
const count = (db: Db, sql: string): number => Number(db.get(`SELECT count(*) AS n FROM ${sql}`)?.['n']);

function attachment(env: Env): { path: string; sha256: string } {
  const path = join(env.dir, 'week-43-export.csv');
  const content = 'week,signups\n2026-W43,42\n';
  writeFileSync(path, content);
  return { path, sha256: createHash('sha256').update(content).digest('hex') };
}

test('measurement channel over the socket: no access without socket permission, agents refused, a human value is recorded once', async (t) => {
  const env = setup(t);
  const { socket } = await twoDaemons(t, env);
  const file = attachment(env);
  const measureArgs = (value: string, extra: string[] = ['--attach', file.path]) => ['measure', 'weekly-landing-conversions', value, '--observations', '7', '--quality', 'good', ...extra];

  // 소켓 파일·디렉터리 권한이 없는 프로세스는 접속하지 못한다
  chmodSync(socket, 0o000);
  let denied;
  try {
    denied = await runApproveCli(measureArgs('42'), { socket, actor: OWNER });
  } finally {
    chmodSync(socket, 0o600);
  }
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /EACCES/);

  // 에이전트 actor 는 인증 단계에서 거부된다 (값 입력도, 대기 목록 조회도)
  const byAgent = await runApproveCli(measureArgs('42'), { socket, actor: AGENT });
  assert.equal(byAgent.code, 1);
  assert.match(String(byAgent.json?.['error']), /only human actors/);
  assert.equal((await runApproveCli(['measurements'], { socket, actor: AGENT })).code, 1);
  assert.equal(count(env.db, 'event'), 0);

  // 첨부 없는 값은 거부된다
  const bare = await runApproveCli(measureArgs('42', []), { socket, actor: OWNER });
  assert.equal(bare.code, 1);
  assert.equal(bare.json?.['code'], 'attachment_required');

  // 사람이 기다리는 업무를 보고 값을 넣는다 (주를 생략하면 데몬 시계 기준 지난주 = 2026-W43)
  const listed = await runApproveCli(['measurements'], { socket, actor: OWNER });
  assert.deepEqual((listed.json?.['waiting'] as { taskId: string }[]).map((w) => w.taskId), [env.waiting]);
  const recorded = await runApproveCli(measureArgs('42', ['--attach', file.path, '--minutes', '3']), { socket, actor: OWNER });
  assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);
  assert.equal(recorded.json?.['created'], true);
  assert.equal(recorded.json?.['key'], W43_KEY);
  assert.deepEqual(recorded.json?.['attached_to'], [env.waiting]);

  // 같은 입력 반복 → 이벤트 1건, 다른 값 → 거부
  const again = await runApproveCli(measureArgs('42', ['--attach', file.path, '--minutes', '3']), { socket, actor: OWNER });
  assert.equal(again.json?.['created'], false);
  const different = await runApproveCli(measureArgs('43'), { socket, actor: OWNER });
  assert.equal(different.code, 1);
  assert.equal(different.json?.['code'], 'conflict');

  assert.equal(count(env.db, 'event'), 1);
  const evidence = env.db.all<{ kind: string; ref: string; content_hash: string; trust_origin: string }>(
    'SELECT kind, ref, content_hash, trust_origin FROM evidence WHERE task_id = ? ORDER BY kind', [env.waiting],
  );
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((row) => [row.kind, row.trust_origin]), [['document', 'internal'], ['measurement', 'internal']]);
  assert.equal(evidence[0]!.content_hash, `sha256:${file.sha256}`, 'the attachment is recorded by its hash');
  assert.match(evidence[0]!.ref, /^file:\//);
  assert.ok(!JSON.stringify(env.db.all('SELECT payload FROM event')).includes('signups'), 'the file content is not stored');
  assert.equal(count(env.db, "cost_entry WHERE category = 'human_time'"), 1);
});

test('wait → value → the next tick runs the task exactly once across two daemons; other tasks are not blocked meanwhile', async (t) => {
  const env = setup(t);
  const { socket, tickBoth } = await twoDaemons(t, env);

  // 기다리는 동안: 다른 업무는 두 데몬 중 하나가 한 번 실행하고, 기다리는 업무는 그대로 queued
  for (let i = 0; i < 3; i += 1) await tickBoth(T0 + i * 5_000);
  assert.equal(executions(env, env.plain).length, 1);
  assert.deepEqual(executions(env, env.waiting), []);
  assert.equal(taskStatus(env.db, env.waiting), 'queued');
  assert.deepEqual(runsOf(env.db, env.waiting), []);

  const file = attachment(env);
  const recorded = await runApproveCli(
    ['measure', 'weekly-landing-conversions', '42', '--observations', '7', '--quality', 'good', '--attach', file.path, '--week', '2026-W43'],
    { socket, actor: OWNER },
  );
  assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);

  const reports = await tickBoth(T0 + 20_000);
  assert.deepEqual(reports.map((r) => r.executed?.taskId ?? null).filter(Boolean), [env.waiting], 'exactly one daemon runs it');
  for (let i = 0; i < 3; i += 1) await tickBoth(T0 + 25_000 + i * 5_000);
  assert.equal(executions(env, env.waiting).length, 1);
  assert.equal(runsOf(env.db, env.waiting).length, 1);
  assert.equal(taskStatus(env.db, env.waiting), 'validating');
});
