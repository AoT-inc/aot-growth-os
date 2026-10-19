// 데몬 엔트리포인트 (A2: 폴링·lease 인수·재시작 복구. 주간 사이클 통합은 A6).
// 설정은 저장소가 아니라 instance/ 와 환경 변수에서 읽는다 (config/daemon.config.example.json 참고).
//   node apps/daemon/src/main.ts [설정 파일]   (기본: $AOT_DAEMON_CONFIG 또는 $AOT_INSTANCE_DIR/daemon.config.json)
//
// 아직 연결되지 않은 것: 정책 엔진(A3) — 기본 거부 훅을 쓰므로 queued 업무는 실행되지 않고 needs_review 로 간다.
// 실행기(A5) — 연결 전까지 실행 요청은 오류로 끝난다. 재시작 복구(만료 lease 인수)는 지금도 매 tick 동작한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMigrations, openDb, systemClock } from '@aot/domain';
import { DEFAULT_LEASE_PARAMS, DEFAULT_POLL_MS, DEFAULT_RETRY_DELAY_MS, runPolling, TaskWorker } from '@aot/task-engine';

interface DaemonConfig {
  db_path: string;
  busy_timeout_ms?: number;
  worker_id: string;
  /** task_run.actor_id 로 쓸 에이전트 행위자 */
  actor_id?: string;
  lease_ms?: number;
  heartbeat_ms?: number;
  poll_ms?: number;
  retry_delay_ms?: number;
}

const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));

function loadConfig(): DaemonConfig {
  const path = process.argv[2] ?? process.env['AOT_DAEMON_CONFIG'] ?? join(process.env['AOT_INSTANCE_DIR'] ?? 'instance', 'daemon.config.json');
  const config = JSON.parse(readFileSync(path, 'utf8')) as DaemonConfig;
  if (typeof config.db_path !== 'string' || typeof config.worker_id !== 'string') {
    throw new Error(`${path}: db_path and worker_id are required`);
  }
  return config;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb({ path: config.db_path, ...(config.busy_timeout_ms === undefined ? {} : { busyTimeoutMs: config.busy_timeout_ms }) });
  const applied = applyMigrations(db, { dir: MIGRATIONS, clock: systemClock });
  const worker = new TaskWorker({
    db,
    clock: systemClock,
    workerId: config.worker_id,
    actorId: config.actor_id ?? 'actor-agent-1',
    adapter: 'unconfigured',
    executor: { execute: () => Promise.reject(new Error('no executor configured (agent-runtime, A5)')) },
    lease: { leaseMs: config.lease_ms ?? DEFAULT_LEASE_PARAMS.leaseMs, heartbeatMs: config.heartbeat_ms ?? DEFAULT_LEASE_PARAMS.heartbeatMs },
    retryDelayMs: config.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS,
  });

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  console.log(`aot-daemon ${config.worker_id}: started (migrations applied: ${applied.length}, lease ${worker.params.leaseMs}ms, heartbeat ${worker.params.heartbeatMs}ms)`);

  await runPolling(worker, {
    pollMs: config.poll_ms ?? DEFAULT_POLL_MS,
    signal: stop.signal,
    onTick: (report) => {
      for (const r of report.recovered) console.log(`recovered ${r.taskId}: run ${r.runId} ${r.outcome} -> ${r.taskStatus}`);
      for (const id of report.sentToReview) console.log(`needs_review ${id}: refused by the policy gate before running`);
      if (report.executed) console.log(`executed ${report.executed.taskId} attempt ${report.executed.attempt}: ${JSON.stringify(report.executed.end)}`);
    },
    onError: (error) => console.error('tick failed:', error),
  });
  db.close();
  console.log(`aot-daemon ${config.worker_id}: stopped`);
}

await main();
