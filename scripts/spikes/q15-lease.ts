// 스파이크 Q15: lease 만료 시간과 heartbeat 주기 (docs/spikes/q15-lease-parameters.md, phase-a §5 스파이크 4).
// 실행: node scripts/spikes/q15-lease.ts [--workers 8] [--seconds 10]
//
// 1부 (실측): 여러 프로세스가 같은 SQLite 파일에서 실제 엔진 함수로 heartbeat·업무 생성·lease 획득·제출을 동시에 쓴다.
//            heartbeat 한 번의 쓰기 트랜잭션 소요(busy_timeout 대기 포함)와 SQLITE_BUSY 실패 수를 잰다.
// 2부 (모의): 가짜 시계로 파라미터 조합 × 지연 시나리오를 실제 엔진 함수(claim/heartbeat/인수)로 돌려
//            오탐 인수(살아 있는 워커의 lease 를 뺏음)와 복구 지연(워커 사망 → 인수)을 센다.
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyMigrations, DEFAULT_BUSY_TIMEOUT_MS, FakeClock, openDb, seedPhaseA, systemClock,
  type Clock, type Db, type TaskPolicyGate,
} from '@aot/domain';
import {
  claimNextTask, createTask, findExpiredRuns, heartbeat, LeaseLostError, submitRun, takeOverExpiredRun, type Lease,
} from '@aot/task-engine';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const ALLOW: TaskPolicyGate = { beforeCreate: () => ({ decision: 'allow' }), beforeRun: () => ({ decision: 'allow' }) };

const spec = (n: string) => ({
  objective: `example-product 조사 ${n}`,
  role: 'generalist',
  trigger: { kind: 'manual', ref: `spike:${n}` },
  inputs: [{ name: 'k', ref: `spike:${n}`, kind: 'strategy' }],
  allowed_tools: [],
  constraints: {},
  acceptance_criteria: ['x'],
  validation: { deterministic: ['budget'], llm: null, human: false },
  cost_budget: { max_usd: 1 },
});

const AGENT_ID = 'actor-agent-spike';

function prepare(db: Db, clock: Clock): string {
  applyMigrations(db, { dir: MIGRATIONS, clock });
  seedPhaseA(db, { clock });
  db.writeTx((tx) => tx.run('INSERT INTO actor (id, kind, name, adapter, created_at) VALUES (?, ?, ?, ?, ?)', [AGENT_ID, 'agent', 'example-agent', 'spike', clock.nowIso()]));
  return AGENT_ID;
}

// ===== 1부: 실측 =====

interface ContendReport { worker: string; heartbeatMs: number[]; busyFailures: number; cycles: number; leaseLost: number }

async function childContend(dbPath: string, worker: string, seconds: number, startAt: number): Promise<void> {
  const db = openDb({ path: dbPath });
  const actorId = AGENT_ID;
  const leaseMs = 60_000;
  const claim = () => claimNextTask(db, { clock: systemClock, gate: ALLOW, workerId: worker, actorId, adapter: 'spike', leaseMs, taskId: `task-${worker}-hold` });
  createTask(db, { clock: systemClock, gate: ALLOW }, { id: `task-${worker}-hold`, spec: spec(`${worker}-hold`) });
  const held = claim().claimed!.lease;
  const report: ContendReport = { worker, heartbeatMs: [], busyFailures: 0, cycles: 0, leaseLost: 0 };
  while (Date.now() < startAt) { /* 동시 출발 */ }
  const end = Date.now() + seconds * 1000;
  let n = 0;
  while (Date.now() < end) {
    const t0 = performance.now();
    try {
      heartbeat(db, systemClock, held);
      report.heartbeatMs.push(performance.now() - t0);
    } catch (error) {
      if (error instanceof LeaseLostError) report.leaseLost += 1;
      else report.busyFailures += 1;
    }
    // 전이 경합: 업무 생성 → lease 획득 → 제출
    try {
      const id = `task-${worker}-${n++}`;
      createTask(db, { clock: systemClock, gate: ALLOW }, { id, spec: spec(id) });
      const lease = claimNextTask(db, { clock: systemClock, gate: ALLOW, workerId: worker, actorId, adapter: 'spike', leaseMs, taskId: id }).claimed?.lease;
      if (lease) submitRun(db, systemClock, lease, { ok: true });
      report.cycles += 1;
    } catch {
      report.busyFailures += 1;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  db.close();
  process.send?.(report);
}

async function measure(workers: number, seconds: number): Promise<{ maxMs: number; p99Ms: number; p50Ms: number; beats: number; busy: number; cycles: number; lost: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'aot-q15-'));
  try {
    const dbPath = join(dir, 'spike.db');
    const db = openDb({ path: dbPath });
    prepare(db, systemClock);
    db.close();
    const startAt = Date.now() + 1500;
    const reports = await Promise.all(Array.from({ length: workers }, (_, i) => new Promise<ContendReport>((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ['--child', dbPath, `w${i}`, String(seconds), String(startAt)]);
      child.once('message', (m) => resolve(m as ContendReport));
      child.once('error', reject);
    })));
    const all = reports.flatMap((r) => r.heartbeatMs).sort((a, b) => a - b);
    const at = (q: number) => all[Math.min(all.length - 1, Math.floor(q * all.length))] ?? 0;
    return {
      maxMs: all.at(-1) ?? 0, p99Ms: at(0.99), p50Ms: at(0.5), beats: all.length,
      busy: reports.reduce((s, r) => s + r.busyFailures, 0), cycles: reports.reduce((s, r) => s + r.cycles, 0),
      lost: reports.reduce((s, r) => s + r.leaseLost, 0),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===== 2부: 모의 =====

interface Combo { leaseMs: number; heartbeatMs: number }
interface Scenario {
  name: string;
  /** 직전 성공 heartbeat 이후 다음 성공까지의 간격을 만든다 (beat 번호 → 지연 ms 와 실패 여부) */
  beat: (index: number, combo: Combo) => { delayMs: number; fails: boolean };
}

const POLL_MS = 5_000;
const HORIZON_MS = 30 * 60_000;

function simulateFalseTakeovers(combo: Combo, scenario: Scenario): { falseTakeovers: number; minMarginMs: number } {
  const clock = new FakeClock('2026-10-19T00:00:00.000Z');
  const db = openDb({ path: ':memory:' });
  const actorId = prepare(db, clock);
  createTask(db, { clock, gate: ALLOW }, { id: 'task-live', spec: spec('live') });
  const start = clock.nowMs();
  let lease: Lease = claimNextTask(db, { clock, gate: ALLOW, workerId: 'live', actorId, adapter: 'sim', leaseMs: combo.leaseMs }).claimed!.lease;
  let expiresAt = start + combo.leaseMs;
  let falseTakeovers = 0;
  let minMargin = Number.POSITIVE_INFINITY;

  // 사건: 정상 워커의 heartbeat 시도(setInterval 주기 + 시나리오 지연), 인수자의 폴링(POLL_MS 주기)
  const events: { at: number; kind: 'beat' | 'poll'; fails?: boolean }[] = [];
  for (let i = 1, t = start; t < start + HORIZON_MS; i += 1) {
    const { delayMs, fails } = scenario.beat(i, combo);
    t = start + i * combo.heartbeatMs;
    events.push({ at: t + delayMs, kind: 'beat', fails });
  }
  for (let t = start + POLL_MS; t < start + HORIZON_MS; t += POLL_MS) events.push({ at: t, kind: 'poll' });
  events.sort((a, b) => a.at - b.at || (a.kind === 'beat' ? -1 : 1));

  for (const event of events) {
    clock.set(Math.max(clock.nowMs(), event.at));
    if (event.kind === 'beat') {
      if (event.fails) continue; // busy_timeout 초과로 이번 heartbeat 실패 (다음 주기에 다시)
      try {
        minMargin = Math.min(minMargin, expiresAt - clock.nowMs());
        heartbeat(db, clock, lease);
        expiresAt = clock.nowMs() + combo.leaseMs;
      } catch (error) {
        if (!(error instanceof LeaseLostError)) throw error;
        // 오탐 인수 후: 정상 워커가 새로 lease 를 잡았다고 보고 계속 센다
        const again = claimNextTask(db, { clock, gate: ALLOW, workerId: 'live', actorId, adapter: 'sim', leaseMs: combo.leaseMs }).claimed;
        if (again) {
          lease = again.lease;
          expiresAt = clock.nowMs() + combo.leaseMs;
        }
      }
    } else {
      for (const run of findExpiredRuns(db, clock.nowIso())) {
        if (takeOverExpiredRun(db, run, { clock, workerId: 'recoverer' })) falseTakeovers += 1;
      }
    }
  }
  db.close();
  return { falseTakeovers, minMarginMs: minMargin };
}

function simulateRecoveryDelay(combo: Combo): number {
  let worst = 0;
  for (let k = 0; k < 20; k += 1) {
    const clock = new FakeClock('2026-10-19T00:00:00.000Z');
    const db = openDb({ path: ':memory:' });
    const actorId = prepare(db, clock);
    createTask(db, { clock, gate: ALLOW }, { id: 'task-dead', spec: spec('dead') });
    const start = clock.nowMs();
    const lease = claimNextTask(db, { clock, gate: ALLOW, workerId: 'dying', actorId, adapter: 'sim', leaseMs: combo.leaseMs }).claimed!.lease;
    // 사망 시각: 마지막 heartbeat 직후(최악)를 포함해 주기 안에서 고르게
    const beatsBeforeDeath = 3;
    for (let i = 1; i <= beatsBeforeDeath; i += 1) {
      clock.set(start + i * combo.heartbeatMs);
      heartbeat(db, clock, lease);
    }
    const death = start + beatsBeforeDeath * combo.heartbeatMs + Math.floor((k / 20) * combo.heartbeatMs);
    let takenAt = -1;
    for (let t = Math.ceil(start / POLL_MS) * POLL_MS + (k * 250) % POLL_MS; takenAt < 0; t += POLL_MS) {
      if (t < death) continue;
      clock.set(t);
      for (const run of findExpiredRuns(db, clock.nowIso())) if (takeOverExpiredRun(db, run, { clock, workerId: 'recoverer' })) takenAt = t;
    }
    worst = Math.max(worst, takenAt - death);
    db.close();
  }
  return worst;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--child') {
    await childContend(args[1]!, args[2]!, Number(args[3]), Number(args[4]));
    return;
  }
  const opt = (name: string, fallback: number) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : fallback;
  };
  const workers = opt('--workers', 8);
  const seconds = opt('--seconds', 10);

  const m = await measure(workers, seconds);
  console.log(`## 1부 실측: ${workers} 프로세스 × ${seconds}초, busy_timeout ${DEFAULT_BUSY_TIMEOUT_MS}ms`);
  console.log(`heartbeat ${m.beats}회: p50 ${m.p50Ms.toFixed(2)}ms, p99 ${m.p99Ms.toFixed(2)}ms, 최대 ${m.maxMs.toFixed(2)}ms; ` +
    `전이 사이클 ${m.cycles}회; SQLITE_BUSY 실패 ${m.busy}회; lease 상실 ${m.lost}회`);

  // 판정 기준(시작 전 고정): w = 실측 최대 대기의 2배(편차 여유), 올림 1초 단위
  const w = Math.max(1000, Math.ceil((m.maxMs * 2) / 1000) * 1000);
  const busyFail = DEFAULT_BUSY_TIMEOUT_MS;
  const scenarios: Scenario[] = [
    { name: 'S0 지연 없음', beat: () => ({ delayMs: 0, fails: false }) },
    { name: `S1 매 heartbeat 쓰기 대기 ${w}ms`, beat: () => ({ delayMs: w, fails: false }) },
    { name: `S2 5분마다 heartbeat 1회 busy 실패(${busyFail}ms 대기) + 다음 회 대기 ${w}ms`,
      beat: (i, c) => (i % Math.max(2, Math.round(300_000 / c.heartbeatMs)) === 0 ? { delayMs: busyFail, fails: true } : { delayMs: w, fails: false }) },
    { name: `S3 S2 + 실패 직후 이벤트 루프 정지 10s`,
      beat: (i, c) => {
        const period = Math.max(3, Math.round(300_000 / c.heartbeatMs));
        if (i % period === 0) return { delayMs: busyFail, fails: true };
        if (i % period === 1) return { delayMs: 10_000 + w, fails: false };
        return { delayMs: w, fails: false };
      } },
  ];
  const combos: Combo[] = [
    { leaseMs: 15_000, heartbeatMs: 5_000 }, { leaseMs: 30_000, heartbeatMs: 10_000 }, { leaseMs: 30_000, heartbeatMs: 15_000 },
    { leaseMs: 60_000, heartbeatMs: 15_000 }, { leaseMs: 60_000, heartbeatMs: 20_000 }, { leaseMs: 60_000, heartbeatMs: 30_000 },
    { leaseMs: 90_000, heartbeatMs: 30_000 }, { leaseMs: 120_000, heartbeatMs: 30_000 }, { leaseMs: 120_000, heartbeatMs: 40_000 },
  ];
  console.log(`\n## 2부 모의 (가짜 시계, 30분, 인수자 폴링 ${POLL_MS / 1000}s)\n`);
  console.log(`| lease | heartbeat | ${scenarios.map((s) => s.name.split(' ')[0]).join(' 오탐 | ')} 오탐 | 최소 여유(S3) | 최대 복구 지연 | heartbeat 쓰기/분·run |`);
  console.log(`|${'---|'.repeat(scenarios.length + 5)}`);
  for (const combo of combos) {
    const results = scenarios.map((s) => simulateFalseTakeovers(combo, s));
    const recovery = simulateRecoveryDelay(combo);
    console.log(`| ${combo.leaseMs / 1000}s | ${combo.heartbeatMs / 1000}s | ${results.map((r) => r.falseTakeovers).join(' | ')} | ` +
      `${(results.at(-1)!.minMarginMs / 1000).toFixed(1)}s | ${(recovery / 1000).toFixed(1)}s | ${(60_000 / combo.heartbeatMs).toFixed(1)} |`);
  }
  console.log('\n시나리오:');
  for (const s of scenarios) console.log(`- ${s.name}`);
}

await main();
