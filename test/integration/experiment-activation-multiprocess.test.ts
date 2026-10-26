// A6-U15 다중 프로세스 시험: 같은 DB 파일을 여는 데몬 프로세스들(workers/experiment-daemon.ts)과 사람용 CLI(apps/daemon/src/approve.ts).
//  - 사람이 CLI 로 실험 전략을 보고(show) 그 해시로 승인 → 같은 트랜잭션에서 `experiment`. 에이전트 actor 는 채널 인증 단계에서 거부
//  - 승인 응답 직후 그 데몬을 SIGKILL (활성화 전) → 새로 띄운 데몬 두 개가 동시에 advance → 활성화 정확히 1회(event 1건, 업무 1건)
//  - 그 뒤 두 데몬이 tick 해도 마케팅 업무는 1회만 실행된다
// 시각은 부모가 IPC 로 정한다(가짜 시계).
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { applyMigrations, FakeClock, openDb, seedPhaseA, type Db } from '@aot/domain';

import { runApproveCli } from '../support/approve-cli.ts';
import { readOnlyDraft } from '../support/policy.ts';
import { MIGRATIONS_DIR } from '../support/schema-snapshot.ts';
import { addAgent } from '../support/seeded-db.ts';
import { makeTempDir } from '../support/temp.ts';

const T0 = Date.parse('2026-10-26T01:00:00.000Z');
const OWNER = 'actor-owner';
const AGENT = 'actor-agent-1';
const STRATEGY = 'strategy-example-copy-test';

interface Env { dir: string; dbPath: string; db: Db; logPath: string }

function setup(t: TestContext): Env {
  const dir = makeTempDir(t);
  const dbPath = join(dir, 'aot.db');
  const db = openDb({ path: dbPath });
  t.after(() => db.close());
  const clock = new FakeClock(T0);
  applyMigrations(db, { dir: MIGRATIONS_DIR, clock });
  seedPhaseA(db, { clock });
  addAgent(db, clock, AGENT);
  const spec = readOnlyDraft({ objective: 'example-product 랜딩 페이지 문구를 한 주 동안 바꿔 본다' });
  delete spec['trigger'];
  const scope = { duration: { period: 'iso_week', weeks: 1 }, task: { kind: 'task_spec', spec }, trust_origin: 'external_untrusted' };
  db.writeTx((tx) => tx.run(
    `INSERT INTO strategy_version (id, parent_id, title, body, rationale_refs, status, experiment_scope, created_by, created_at)
     VALUES (?, NULL, 'Experiment proposal copy-test', 'hypothesis copy-test', '["task:example"]', 'proposed', ?, ?, ?)`,
    [STRATEGY, JSON.stringify(scope), AGENT, clock.nowIso()],
  ));
  return { dir, dbPath, db, logPath: join(dir, 'executions.log') };
}

type Message = { type: string; [key: string]: unknown };

class ExperimentDaemon {
  readonly child: ChildProcess;
  readonly #inbox: Message[] = [];
  readonly #waiters: { type: string; resolve: (m: Message) => void }[] = [];
  readonly #exited: Promise<unknown>;

  constructor(t: TestContext, env: Env, id: string, channel: boolean) {
    this.child = fork(new URL('./workers/experiment-daemon.ts', import.meta.url), [env.dbPath, join(env.dir, `i-${id.slice(-1)}`), env.logPath, id, channel ? '1' : '0']);
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

  async request(cmd: 'set' | 'tick' | 'advance', now: number): Promise<Message> {
    this.child.send({ cmd, now });
    return this.next(cmd);
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.#exited;
  }
}

const count = (db: Db, sql: string, params: string[] = []): number => Number(db.get<{ n: number }>(sql, params)!.n);
const executions = (env: Env): string[] => (existsSync(env.logPath) ? readFileSync(env.logPath, 'utf8').trim().split('\n').filter(Boolean) : []);
type AdvanceReport = { activated: { strategyVersionId: string; activated: boolean; taskIds: string[] }[]; activationFailed: unknown[] };

test('approved over the socket, the daemon killed before activation: two fresh daemons activate the experiment exactly once and run its task once', async (t) => {
  const env = setup(t);
  const a = new ExperimentDaemon(t, env, 'daemon-a', true);
  const socket = String((await a.next('ready'))['socket']);
  await a.request('set', T0);
  const cli = (args: string[], actor = OWNER) => runApproveCli(args, { socket, actor });

  // 에이전트는 인증 단계에서 거부된다 (show 도, approve 도)
  assert.match(String((await cli(['show', 'strategy', STRATEGY], AGENT)).json?.['error']), /only human actors/);
  const listed = await cli(['list']);
  assert.deepEqual((listed.json?.['strategy_proposals'] as { id: string }[]).map((s) => s.id), [STRATEGY]);
  const shown = await cli(['show', 'strategy', STRATEGY]);
  assert.equal(shown.code, 0, shown.stderr);
  const hash = String(shown.json?.['hash']);
  const byAgent = await cli(['approve', 'strategy', STRATEGY, '--hash', hash], AGENT);
  assert.equal(byAgent.code, 1);
  assert.match(String(byAgent.json?.['error']), /only human actors/);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM approval WHERE subject_kind = 'strategy_version'"), 0);

  const approved = await cli(['approve', 'strategy', STRATEGY, '--hash', hash, '--comment', 'example approval']);
  assert.equal(approved.code, 0, approved.stdout + approved.stderr);
  assert.equal(approved.json?.['state'], 'experiment');
  // 승인 직후, 활성화 전에 그 데몬이 죽는다
  await a.kill();
  assert.equal(count(env.db, "SELECT count(*) AS n FROM strategy_version WHERE id = ? AND status = 'experiment'", [STRATEGY]), 1);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM event WHERE type = 'experiment.activated'"), 0);

  const b = new ExperimentDaemon(t, env, 'daemon-b', false);
  const c = new ExperimentDaemon(t, env, 'daemon-c', false);
  await Promise.all([b.next('ready'), c.next('ready')]);
  const advanceBoth = async (now: number) => (await Promise.all([b.request('advance', now), c.request('advance', now)])).map((m) => m['report'] as AdvanceReport);

  const reports = await advanceBoth(T0 + 5_000);
  for (const report of reports) assert.deepEqual(report.activationFailed, []);
  const activated = reports.flatMap((r) => r.activated).filter((x) => x.activated);
  assert.equal(activated.length, 1, JSON.stringify(reports));
  assert.equal(activated[0]!.strategyVersionId, STRATEGY);
  const [taskId] = activated[0]!.taskIds;
  for (let i = 0; i < 3; i += 1) {
    for (const report of await advanceBoth(T0 + 10_000 + i * 5_000)) assert.deepEqual(report.activated, []);
  }
  assert.equal(count(env.db, "SELECT count(*) AS n FROM event WHERE type = 'experiment.activated'"), 1);
  assert.equal(count(env.db, 'SELECT count(*) AS n FROM task WHERE strategy_version_id = ?', [STRATEGY]), 1);

  for (let i = 0; i < 3; i += 1) await Promise.all([b.request('tick', T0 + 30_000 + i * 5_000), c.request('tick', T0 + 30_000 + i * 5_000)]);
  assert.deepEqual(executions(env).map((line) => line.split(' ')[1]), [taskId], 'the marketing task runs once across both daemons');
});
