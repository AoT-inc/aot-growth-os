// 데몬 엔트리포인트 (A2: 폴링·lease 인수·재시작 복구, A3: 정책 게이트·승인 채널. 주간 사이클 통합은 A6).
// 설정은 저장소가 아니라 instance/ 와 환경 변수에서 읽는다 (config/daemon.config.example.json 참고).
//   node apps/daemon/src/main.ts [설정 파일]   (기본: $AOT_DAEMON_CONFIG 또는 $AOT_INSTANCE_DIR/daemon.config.json)
//
// 정책: 가장 최근 policy_version 의 내용(instance/policies/<hash>.yaml 또는 저장소 템플릿)으로 판정한다. 내용을 찾지 못하면 거부.
// 승인: 사람용 승인 CLI(apps/daemon/src/approve.ts)가 approval_socket 으로 접속한다 (trust-boundaries §3.1).
// 실행기(A5 U4·U6): `container_agent` 설정이 있으면 컨테이너 샌드박스 어댑터를 실행 관리(time_limit·예산 초과 취소, 비용 기록)에 연결하고, 시작 때 Docker 가용성 확인과
// 이 인스턴스의 고아 컨테이너 정리(`aot.run` AND `aot.instance`)를 한다. `research_agent` 설정이 더해지면 조사 에이전트 이미지·`fetch_url` 도구·검증기용 출처 조회기(같은 허용 호스트)도 연결한다.
// 설정이 없으면 실행기가 없어 실행 요청이 오류로 끝난다(기존 동작). 설정 → 조립은 runtime-config.ts.
// 구독 CLI(ADR-0005 Amendment 2026-10-26): `claude_code_cli` 설정이 있으면 `claude-code-cli` 어댑터를 연결한다(컨테이너 없이 단독이면 기본 어댑터, 컨테이너와 함께면 `roles` 의 역할만).
// 첫 실행 고지 동의는 설정이 아니라 승인 CLI `consent show|accept|revoke` 로 받은 기록(event)이며 어댑터가 run 마다 읽는다(apps/daemon/src/consent.ts). 동의가 없으면 업무는 needs_review.
// 팩(A6 U10): `pack_dir` 설정이 있으면 팩을 읽어 루틴을 `enabled=0` 으로 DB 에 반영하고 템플릿 포트를 워커에 연결한다(`pack_values` 로 {{자리표시자}} 치환). 설정이 없으면 기존 동작.
// LLM 검증기(A6-U12): `llm_verifier: {kind: "stub"}` 는 모델 호출 없는 가짜 검증기를, `{kind: "claude_code_cli", model}` 는 구독 CLI 를 도구 없이 불러 판정하는 검증기를 연결한다(Q22). 없으면 연결하지 않는다.
// 측정 값(A6-U13): 팩에 측정 신호 정의가 있으면 승인 소켓에 `measure`·`measurements` 명령이 생기고(사람만, 같은 인증 경계), 평가 포트가 있으면 측정 값 조회기가 연결된다.
// 주간 사이클 4·5단계(A6-U14): `experiment_cycle` 설정이 있으면 worker tick 뒤마다 `cycle.advance()` 로 완료된 기획 업무의 후보를 비교해 strategy_version 을
// `proposed` 로 만든다(추천이 없으면 사람 검토 목록). 같은 advance 가 사람이 승인한 실험(6단계, A6-U15)을 한 번만 켠다(루틴 enabled=1, 일회성 업무 생성).
// 승인 직후 종료되어도 재시작 후 advance 가 이어서 켠다. 설정이 없으면 부르지 않는다(이전 동작).
// 결과 검토(A6-U16): 실험 주가 끝나면 같은 advance 가 결과 검토 업무를 만들고(팩 템플릿 `experiment-result-review@1`), 평가가 정해지면 결과(measurement·strategy_record 기억, 실험 총비용)를
// 기록한다. fail 은 시스템이 거절하고, pass 의 승격은 사람이 승인 CLI `promote` 로 한다.
// `inputs[kind=measurement]` 업무는 값이 입력될 때까지 집히지 않는다. 출처 조회기는 `research_agent` 가 없으면 연결되지 않아 그 경우 validating 업무는 검증되지 않고 남는다(자동 완료 없음).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMigrations, openDb, systemClock } from '@aot/domain';
import { DEFAULT_LEASE_PARAMS, DEFAULT_POLL_MS, DEFAULT_RETRY_DELAY_MS, runPolling } from '@aot/task-engine';

import { assembleDaemon, defaultInstancePaths } from './assemble.ts';
import { readClaudeCodeConsent } from './consent.ts';
import { cycleOptionsFromConfig, type CycleConfig } from './cycle.ts';
import { createRepeatFilter } from './log-throttle.ts';
import { packOptionsFromConfig, type PackConfig } from './pack-loader.ts';
import { phoneOptionsFromConfig, type PhoneConfig } from './phone-config.ts';
import { startPhoneWebhookServer } from './phone-webhook-server.ts';
import { buildAgentRuntime, type AgentRuntimeConfig } from './runtime-config.ts';

/** 에이전트 쪽 키(container_agent·research_agent·instance_id·run_log_dir·default_time_limit)는 AgentRuntimeConfig 에 있다 */
/** 팩 키(pack_dir·pack_values)는 PackConfig 에, 주간 사이클 키(experiment_cycle)는 CycleConfig 에 있다 */
interface DaemonConfig extends AgentRuntimeConfig, PackConfig, CycleConfig {
  /** 전화 Capability (ADR-0014). 없으면 조립하지 않는다 */
  phone?: PhoneConfig | null;
  db_path: string;
  busy_timeout_ms?: number;
  worker_id: string;
  /** task_run.actor_id 로 쓸 에이전트 행위자 */
  actor_id?: string;
  lease_ms?: number;
  heartbeat_ms?: number;
  poll_ms?: number;
  retry_delay_ms?: number;
  /** 어댑터가 미룬(사람 우선 게이트) run 의 retry_wait 대기 시간. 시도를 소모하지 않는다. 기본 15분 */
  defer_delay_ms?: number;
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
  const instanceDir = config.instance_dir ?? process.env['AOT_INSTANCE_DIR'] ?? 'instance';
  const defaults = defaultInstancePaths(instanceDir);
  const { agent, evaluation } = buildAgentRuntime(config, instanceDir, { claudeCodeConsent: () => readClaudeCodeConsent(db), db });
  const pack = packOptionsFromConfig(config);
  const cycle = cycleOptionsFromConfig(config);
  const phone = phoneOptionsFromConfig(config);
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
    ...(agent === undefined
      ? { adapter: 'unconfigured', executor: { execute: () => Promise.reject(new Error('no executor configured (set container_agent)')) } }
      : { agent }),
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(pack === undefined ? {} : { pack }),
    ...(cycle === undefined ? {} : { cycle }),
    ...(phone === undefined ? {} : { phone: phone.options }),
    lease: { leaseMs: config.lease_ms ?? DEFAULT_LEASE_PARAMS.leaseMs, heartbeatMs: config.heartbeat_ms ?? DEFAULT_LEASE_PARAMS.heartbeatMs },
    retryDelayMs: config.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS,
    ...(config.defer_delay_ms === undefined ? {} : { deferDelayMs: config.defer_delay_ms }),
  });
  if (daemon.pack !== null && daemon.packSync !== null) {
    const { manifest, templates, signals } = daemon.pack;
    const { created, updated, unchanged } = daemon.packSync;
    console.log(`pack ${manifest.name}@${manifest.version}: routines created ${created.length}, updated ${updated.length}, unchanged ${unchanged.length} (all new routines stay disabled); templates ${templates.length}, measurement signals ${signals.length}`);
  }
  const readiness = await daemon.prepareAgentRuntime(); // 컨테이너 어댑터가 설정된 경우만: docker 확인과 고아 컨테이너 정리 (docker 가 없으면 시작하지 않는다)
  if (readiness !== null) {
    console.log(`container agent: docker ${readiness.dockerVersion}, orphan containers removed: ${readiness.orphans.removed}/${readiness.orphans.found.length}`);
    for (const failure of readiness.orphans.failures) console.error(`orphan cleanup: ${failure}`);
  }
  const channel = await daemon.startApprovalChannel((name) => console.error(`approval channel: ${String(name)}`));
  const { worker } = daemon;
  const experimentCycle = daemon.cycle;
  const phoneRuntime = daemon.phone;
  const webhookServer = phone?.webhook != null && phoneRuntime !== null
    ? await startPhoneWebhookServer({ runtime: phoneRuntime, ...phone.webhook, onError: (error) => console.error('phone webhook:', error) })
    : null;
  if (webhookServer !== null) console.log(`phone webhook listening on port ${webhookServer.port} (${phone!.webhook!.host}${phone!.webhook!.path}; terminate TLS in front of it)`);

  const validationLog = createRepeatFilter(() => Date.now());
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  console.log(`aot-daemon ${config.worker_id}: started (migrations applied: ${applied.length}, lease ${worker.params.leaseMs}ms, heartbeat ${worker.params.heartbeatMs}ms, approval channel ready)`);

  await runPolling(worker, {
    pollMs: config.poll_ms ?? DEFAULT_POLL_MS,
    signal: stop.signal,
    onTick: (report) => {
      for (const r of report.recovered) console.log(`recovered ${r.taskId}: run ${r.runId} ${r.outcome} -> ${r.taskStatus}`);
      for (const id of report.sentToReview) console.log(`needs_review ${id}: refused by the policy gate before running`);
      for (const v of report.validated) {
        validationLog.clear(v.taskId);
        console.log(`validated ${v.taskId}: evaluation ${v.evaluationId} -> ${v.taskStatus}`);
      }
      // 검증기를 쓸 수 없는 업무(구독 한도·로그인·미룸)는 풀릴 때까지 매 tick 같은 오류를 낸다: 같은 문구는 30분에 한 번만 찍는다
      for (const f of report.validationFailed) {
        if (validationLog.shouldLog(f.taskId, f.error)) console.error(`validation failed ${f.taskId}: ${f.error} (the task stays validating and is retried; the same message is logged again after 30 min)`);
      }
      if (report.executed) console.log(`executed ${report.executed.taskId} attempt ${report.executed.attempt}: ${JSON.stringify(report.executed.end)}`);
    },
    ...(experimentCycle === null && phoneRuntime === null ? {} : {
      afterTick: async () => {
        if (phoneRuntime !== null) {
          // webhook 이 늦거나 오지 않은 통화를 provider 에 조회하고, 마감을 넘기면 닫는다 (업무 검증 보류가 영원히 이어지지 않게)
          try {
            const calls = await phoneRuntime.reconcile();
            for (const id of calls.closedByProvider) console.log(`call ${id}: ended according to the provider (webhook was missing)`);
            for (const id of calls.expired) console.error(`call ${id}: closed at its deadline without a terminal event (deadline_exceeded)`);
          } catch (error) {
            console.error('call reconciliation failed:', error); // 전화 provider 문제가 주간 사이클을 멈추지 않게 한다
          }
        }
        if (experimentCycle === null) return;
        const report = await experimentCycle.advance();
        for (const c of report.compared) {
          console.log(`experiment comparison ${c.planningTaskId}: ${c.outcome}${c.strategyVersionId === null ? ' (waiting for a person to review)' : ` -> strategy_version ${c.strategyVersionId} proposed`}`);
        }
        for (const f of report.failed) console.error(`experiment comparison failed ${f.planningTaskId}: ${f.error}`);
        for (const a of report.activated) {
          if (a.activated) console.log(`experiment ${a.strategyVersionId} activated at ${a.activatedAt}: routines [${a.routineIds.join(', ')}], tasks [${a.taskIds.join(', ')}]`);
        }
        for (const f of report.activationFailed) console.error(`experiment activation failed ${f.strategyVersionId}${f.code === null ? '' : ` (${f.code})`}: ${f.error}`);
        for (const r of report.reviewsCreated) console.log(`experiment ${r.strategyVersionId}: week ${r.experimentWeek} ended; result review task ${r.reviewTaskId} created (routines off: [${r.routineIds.join(', ')}])`);
        for (const f of report.reviewFailed) console.error(`experiment review failed ${f.strategyVersionId}${f.code === null ? '' : ` (${f.code})`}: ${f.error}`);
        for (const r of report.resultsRecorded) {
          if (r.recorded) console.log(`experiment ${r.strategyVersionId}: result ${r.conclusion} recorded (evaluation ${r.evaluationId}, cost ${r.totalCostUsd} USD)${r.rejected ? ' -> rejected by the system' : r.conclusion === 'pass' ? ' (waiting for a person to promote)' : ''}`);
        }
        for (const f of report.resultFailed) console.error(`experiment result failed ${f.strategyVersionId}: ${f.error}`);
      },
    }),
    onError: (error) => console.error('tick failed:', error),
  });
  await webhookServer?.close();
  await channel.close();
  db.close();
  console.log(`aot-daemon ${config.worker_id}: stopped`);
}

await main();
