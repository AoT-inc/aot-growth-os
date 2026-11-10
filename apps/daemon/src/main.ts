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
import { delegateReviewerFromConfig } from './delegate-cycle.ts';
import { buildClaudeDelegateReviewer, parseDelegateReviewerSetting } from './delegate-reviewer-config.ts';
import { daemonForbiddenRoots } from './forbidden-roots.ts';
import { cycleOptionsFromConfig, type CycleConfig } from './cycle.ts';
import { advanceOrganization } from './org-cycle.ts';
import { createRepeatFilter } from './log-throttle.ts';
import { packOptionsFromConfig, type PackConfig } from './pack-loader.ts';
import { mailOptionsFromConfig, type MailConfig } from './mail-config.ts';
import { mcpToolDescriptions } from '@aot/agent-runtime';
import { mcpOptionsFromConfig, type McpConfig } from './mcp-config.ts';
import { phoneOptionsFromConfig, type PhoneConfig } from './phone-config.ts';
import { startPhoneWebhookServer } from './phone-webhook-server.ts';
import { buildAgentRuntime, buildClaudeGate, parseClaudeCodeCliConfig, type AgentRuntimeConfig } from './runtime-config.ts';

/** 에이전트 쪽 키(container_agent·research_agent·instance_id·run_log_dir·default_time_limit)는 AgentRuntimeConfig 에 있다 */
/** 팩 키(pack_dir·pack_values)는 PackConfig 에, 주간 사이클 키(experiment_cycle)는 CycleConfig 에 있다 */
interface DaemonConfig extends AgentRuntimeConfig, PackConfig, CycleConfig, McpConfig {
  /** 전화 Capability (ADR-0014). 없으면 조립하지 않는다 */
  phone?: PhoneConfig | null;
  /** 메일 도구 (ADR-0017). 없으면 조립하지 않는다 */
  mail?: MailConfig | null;
  /**
   * 결정 위임 검토자 (ADR-0016). 위임을 켜는 것은 정책의 `delegation.mandates` 다. 없으면 새 검토는 하지 않고 이미 기록된 위임 승인의 풀어 주기만 한다.
   * `{"kind":"claude_code_cli","model"?:"sonnet","timeout_ms"?:…,"assumed_cost_usd"?:…}`: 구독 CLI 를 도구 없이 불러 판정을 받는다. `claude_code_cli` 설정이 있어야 하고 동의·게이트는 실행 어댑터·검증기와 같다 (delegate-reviewer-config.ts).
   * `{"kind":"stub"}` 는 시험 전용이라 데몬은 읽지 않고 시작을 거부한다 (delegate-cycle.ts).
   */
  delegate_reviewer?: unknown;
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
  /** 외부 부작용 초안의 기한(ms, ADR-0015). 이 시간이 지나면 승인·해제·전송이 거부된다. 기본 72시간 */
  draft_ttl_ms?: number;
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
  if (config.draft_ttl_ms !== undefined && (!Number.isSafeInteger(config.draft_ttl_ms) || config.draft_ttl_ms <= 0)) {
    throw new Error(`${path}: draft_ttl_ms must be a positive integer (milliseconds)`);
  }
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
  const mcp = mcpOptionsFromConfig(config); // 환경 변수가 비어 있으면 여기서 던진다(시작하지 않는다)
  // 실행 어댑터·검증기·위임 검토자가 같은 동의 읽기와 같은 게이트를 쓴다 (구독 풀이 하나다)
  const claudeConfig = parseClaudeCodeCliConfig(config.claude_code_cli);
  const claudeConsent = (): ReturnType<typeof readClaudeCodeConsent> => readClaudeCodeConsent(db);
  const claudeGate = claudeConfig === undefined ? undefined : buildClaudeGate(claudeConfig, systemClock);
  const { agent, evaluation, productChannel } = buildAgentRuntime(config, instanceDir, {
    ...(mcp === undefined ? {} : { toolDescriptions: mcpToolDescriptions(mcp.sites.map((site) => site.manifest)) }), // 에이전트에는 오너가 쓴 설명만 보인다
    claudeCodeConsent: claudeConsent, db, ...(claudeGate === undefined ? {} : { claudeGate }),
    forbiddenRoots: daemonForbiddenRoots(config, instanceDir),
  });
  const pack = packOptionsFromConfig(config);
  const cycle = cycleOptionsFromConfig(config);
  const phone = phoneOptionsFromConfig(config);
  const mail = mailOptionsFromConfig(config);
  const delegateSetting = parseDelegateReviewerSetting(config.delegate_reviewer, { claude: claudeConfig });
  const delegateReviewer = delegateSetting === undefined ? undefined
    : delegateSetting.kind === 'claude_code_cli'
      ? buildClaudeDelegateReviewer(delegateSetting, { claude: claudeConfig!, clock: systemClock, gate: claudeGate!, consent: claudeConsent })
      : delegateReviewerFromConfig(delegateSetting);
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
    ...(productChannel === undefined ? {} : { productChannel }),
    ...(pack === undefined ? {} : { pack }),
    ...(cycle === undefined ? {} : { cycle }),
    ...(phone === undefined ? {} : { phone: phone.options }),
    ...(mail === undefined ? {} : { mail }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(delegateReviewer === undefined ? {} : { delegate: { reviewer: delegateReviewer } }),
    lease: { leaseMs: config.lease_ms ?? DEFAULT_LEASE_PARAMS.leaseMs, heartbeatMs: config.heartbeat_ms ?? DEFAULT_LEASE_PARAMS.heartbeatMs },
    retryDelayMs: config.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS,
    ...(config.defer_delay_ms === undefined ? {} : { deferDelayMs: config.defer_delay_ms }),
    ...(config.draft_ttl_ms === undefined ? {} : { draftTtlMs: config.draft_ttl_ms }),
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
  await daemon.mcp?.start(); // 사이트마다 커넥터 프로세스를 띄우고 첫 고정 확인을 한다(서버가 안 보여도 도구가 닫힌 채 시작하고 다시 시도한다)
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
    afterTick: async () => {
        {
          // 조직 변경(Phase B): 승인된 제안의 시험 시작, 범위 안 unassigned 업무 배정, 시험 평가와 롤백. 제안이 없으면 읽기만 한다
          const org = advanceOrganization(db, systemClock);
          for (const s of org.started) console.log(`org proposal ${s.proposalId}: trial started (org_version ${s.orgVersionId})`);
          for (const r of org.routed) console.log(`task ${r.taskId}: assigned to role ${r.role} (type ${r.taskType})`);
          for (const e of org.evaluated) console.log(`org proposal ${e.proposalId}: trial ${e.verdict}${e.transitionedTo === null ? '' : ` -> ${e.transitionedTo}`}: ${e.reason}`);
          for (const id of org.awaitingConfirmation) console.log(`org proposal ${id}: trial passed; waiting for a person to confirm (org confirm)`);
          for (const id of [...org.expired, ...org.superseded]) console.log(`org proposal ${id}: closed (expired or superseded)`);
          for (const f of org.failed) console.error(`org cycle failed${f.proposalId === null ? '' : ` ${f.proposalId}`}: ${f.error}`);
        }
        try {
          // 결정 위임(ADR-0016, 제안): 위임 cooldown 이 끝난 승인을 풀고, 적격 업무를 검토한다. 위임이 없는 정책에서는 읽기만 한다
          const delegated = await daemon.delegation.advance();
          for (const r of delegated.released) console.log(`delegated approval released ${r.taskId}: mandate ${r.mandateId} (approval ${r.approvalId})`);
          for (const d of delegated.decided) console.log(`delegate review ${d.taskId}: ${d.verdict} -> ${d.outcome}`);
          if (delegated.unavailable > 0) console.error(`delegate reviewer unavailable: ${delegated.unavailable} review(s) postponed`);
        } catch (error) {
          console.error('delegation cycle failed:', error); // 위임 문제가 주간 사이클을 멈추지 않게 한다
        }
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
    onError: (error) => console.error('tick failed:', error),
  });
  await webhookServer?.close();
  await daemon.mcp?.close();
  await channel.close();
  db.close();
  console.log(`aot-daemon ${config.worker_id}: stopped`);
}

await main();
