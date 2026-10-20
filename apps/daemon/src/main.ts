// 데몬 엔트리포인트 (A2: 폴링·lease 인수·재시작 복구, A3: 정책 게이트·승인 채널. 주간 사이클 통합은 A6).
// 설정은 저장소가 아니라 instance/ 와 환경 변수에서 읽는다 (config/daemon.config.example.json 참고).
//   node apps/daemon/src/main.ts [설정 파일]   (기본: $AOT_DAEMON_CONFIG 또는 $AOT_INSTANCE_DIR/daemon.config.json)
//
// 정책: 가장 최근 policy_version 의 내용(instance/policies/<hash>.yaml 또는 저장소 템플릿)으로 판정한다. 내용을 찾지 못하면 거부.
// 승인: 사람용 승인 CLI(apps/daemon/src/approve.ts)가 approval_socket 으로 접속한다 (trust-boundaries §3.1).
// 아직 연결되지 않은 것: 실행기(A5) — 연결 전까지 실행 요청은 오류로 끝난다. 검증기의 외부 포트(출처 조회·LLM 검증기·측정 값)도 A5/A6 — 연결 전까지 validating 업무는 검증되지 않는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMigrations, openDb, systemClock } from '@aot/domain';
import { DEFAULT_LEASE_PARAMS, DEFAULT_POLL_MS, DEFAULT_RETRY_DELAY_MS, runPolling } from '@aot/task-engine';

import { assembleDaemon, defaultInstancePaths } from './assemble.ts';

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
  /** 기본: AOT_INSTANCE_DIR 또는 instance */
  instance_dir?: string;
  policy_store_dir?: string;
  totp_dir?: string;
  approval_socket?: string;
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
  const defaults = defaultInstancePaths(config.instance_dir ?? process.env['AOT_INSTANCE_DIR'] ?? 'instance');
  const daemon = assembleDaemon({
    db,
    clock: systemClock,
    paths: {
      policyStoreDir: config.policy_store_dir ?? defaults.policyStoreDir,
      totpDir: config.totp_dir ?? defaults.totpDir,
      approvalSocket: config.approval_socket ?? defaults.approvalSocket,
    },
    workerId: config.worker_id,
    actorId: config.actor_id ?? 'actor-agent-1',
    adapter: 'unconfigured',
    executor: { execute: () => Promise.reject(new Error('no executor configured (agent-runtime, A5)')) },
    lease: { leaseMs: config.lease_ms ?? DEFAULT_LEASE_PARAMS.leaseMs, heartbeatMs: config.heartbeat_ms ?? DEFAULT_LEASE_PARAMS.heartbeatMs },
    retryDelayMs: config.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS,
  });
  const channel = await daemon.startApprovalChannel((name) => console.error(`approval channel: ${String(name)}`));
  const { worker } = daemon;

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  console.log(`aot-daemon ${config.worker_id}: started (migrations applied: ${applied.length}, lease ${worker.params.leaseMs}ms, heartbeat ${worker.params.heartbeatMs}ms, approval channel ready)`);

  await runPolling(worker, {
    pollMs: config.poll_ms ?? DEFAULT_POLL_MS,
    signal: stop.signal,
    onTick: (report) => {
      for (const r of report.recovered) console.log(`recovered ${r.taskId}: run ${r.runId} ${r.outcome} -> ${r.taskStatus}`);
      for (const id of report.sentToReview) console.log(`needs_review ${id}: refused by the policy gate before running`);
      for (const v of report.validated) console.log(`validated ${v.taskId}: evaluation ${v.evaluationId} -> ${v.taskStatus}`);
      for (const f of report.validationFailed) console.error(`validation failed ${f.taskId}: ${f.error}`);
      if (report.executed) console.log(`executed ${report.executed.taskId} attempt ${report.executed.attempt}: ${JSON.stringify(report.executed.end)}`);
    },
    onError: (error) => console.error('tick failed:', error),
  });
  await channel.close();
  db.close();
  console.log(`aot-daemon ${config.worker_id}: stopped`);
}

await main();
