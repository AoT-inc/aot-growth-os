// 실행 소유권(lease) — docs/operations/recovery.md §2.
//  - queued → running 전이와 task_run 생성은 한 쓰기 트랜잭션 (규칙 1). 활성 run 유일 인덱스가 두 번째 진입을 막는다.
//  - 펜싱 (규칙 2): run 소유자의 모든 쓰기(heartbeat, checkpoint, 부작용 갱신, 결과 제출)는 같은 트랜잭션에서
//    `lease_owner = 나 AND lease_expires_at > now AND outcome IS NULL` 을 확인한 뒤에만 한다. 실패하면 LeaseLostError.
//    펜싱 토큰은 run id 다: 인수는 옛 run 을 닫고(outcome 기록) 새 attempt 의 run 을 만들므로, 같은 워커 id 로
//    재시작한 프로세스라도 옛 run id 로는 더 쓸 수 없다.
//  - 만료 인수 (규칙 3·4): 옛 run 을 lease_expired 로 닫고, 남은 부작용을 §3 절차로 먼저 처리한 뒤 업무를 되돌린다.
import { randomUUID } from 'node:crypto';

import type { Clock, Db, EvidenceRow, ExternalEffectRow, TaskPolicyGate, TaskRow, TaskRunOutcome, TaskSpec, TaskStatus } from '@aot/domain';

import { LeaseLostError, type RunKillReason } from './errors.ts';
import { resendAllowed } from './idempotency.ts';
import { isoAfter } from './params.ts';
import { transitionEffect, transitionTask } from './transitions.ts';
import { attachRecordedMeasurements, measurementInputsOf, MEASUREMENTS_RECORDED_SQL } from './measurement.ts';
import { hasTaskResultInputs, resolveUpstream, type UpstreamResult } from './upstream.ts';

/** 워커가 쥔 실행 소유권. `runId` 가 펜싱 토큰이다. */
export interface Lease {
  runId: string;
  taskId: string;
  owner: string;
  attempt: number;
  leaseMs: number;
}

/** 펜싱 확인. 반드시 쓰기 트랜잭션 안에서 부르고, 같은 트랜잭션에서 쓴다. */
export function assertLeaseHeld(tx: Db, lease: Lease, now: string, what: string): void {
  const held = tx.get(
    'SELECT 1 AS one FROM task_run WHERE id = ? AND lease_owner = ? AND lease_expires_at > ? AND outcome IS NULL',
    [lease.runId, lease.owner, now],
  );
  if (!held) throw new LeaseLostError(lease.runId, what);
}

/** heartbeat: 조건부 갱신이 0건이면 lease 를 잃은 것이다. 새 만료 시각을 돌려준다. */
export function heartbeatInTx(tx: Db, clock: Clock, lease: Lease): string {
  const now = clock.nowIso();
  const expires = isoAfter(clock.nowMs(), lease.leaseMs);
  const changed = tx.run(
    `UPDATE task_run SET heartbeat_at = ?, lease_expires_at = ?
     WHERE id = ? AND lease_owner = ? AND lease_expires_at > ? AND outcome IS NULL`,
    [now, expires, lease.runId, lease.owner, now],
  );
  if (changed.changes !== 1) throw new LeaseLostError(lease.runId, 'heartbeat');
  return expires;
}

export function heartbeat(db: Db, clock: Clock, lease: Lease): string {
  return db.writeTx((tx) => heartbeatInTx(tx, clock, lease));
}

export function saveCheckpoint(db: Db, clock: Clock, lease: Lease, checkpoint: unknown): void {
  db.writeTx((tx) => {
    assertLeaseHeld(tx, lease, clock.nowIso(), 'checkpoint');
    tx.run('UPDATE task_run SET checkpoint = ? WHERE id = ?', [JSON.stringify(checkpoint ?? null), lease.runId]);
  });
}

// ===== 선택과 lease 획득 =====

/**
 * 명세 → 어댑터 이름 해석 포트 (A6-U11). 이름만 돌려준다: task-engine 은 어댑터를 모른다(agent-runtime 을 참조하지 않는다). null 이면 기본 어댑터.
 * 어댑터 선택은 권한이 아니다 — 어떤 어댑터가 실행하든 도구는 명세 `allowed_tools` 와 정책 게이트웨이가 정한다.
 * 던지거나 이름 형식이 틀리면 그 업무는 실행하지 않고 `needs_review` 로 간다(다른 어댑터로 조용히 바꿔 실행하지 않는다).
 */
export type AdapterSelector = (spec: TaskSpec) => string | null;

/** 어댑터 이름의 최대 길이 */
export const MAX_ADAPTER_NAME_CHARS = 100;

export interface ClaimOptions {
  clock: Clock;
  gate: TaskPolicyGate;
  workerId: string;
  actorId: string;
  /** task_run.adapter 의 기본값 */
  adapter: string;
  /** 업무마다 어댑터를 고른다. 생략하면 모든 업무가 `adapter` */
  adapterFor?: AdapterSelector;
  leaseMs: number;
  /** 특정 업무만 (시험·진단용) */
  taskId?: string;
  newRunId?: () => string;
}

export interface ClaimedTask {
  lease: Lease;
  task: TaskRow;
  spec: TaskSpec;
  /** `task_run.adapter` 에 기록한 이름 (실행기가 이 이름으로 어댑터를 고른다) */
  adapter: string;
  /** 명세의 `task_result` 입력을 읽은 결과 (통과 평가가 있는 완료 업무의 결과만). 입력이 없으면 빈 목록 */
  upstream: UpstreamResult[];
  /** 직전 run 의 checkpoint (인수한 run 은 여기서 이어 간다, 규칙 4) */
  checkpoint: unknown;
}

export interface ClaimResult {
  claimed: ClaimedTask | null;
  /** 실행 직전 정책 재검증에서 needs_review 로 보낸 업무 */
  sentToReview: string[];
}

const CANDIDATES_PER_CLAIM = 20;

/**
 * 실행할 수 있는 `queued` 업무 하나를 골라 lease 를 획득한다 (한 쓰기 트랜잭션).
 * 선행 업무가 모두 completed 인 업무만 고른다. 정책 재검증(gate.beforeRun)이 needs_review 를 내면 그 업무는
 * queued → needs_review 로 보내고 다음 후보를 본다.
 * A6-U11: 명세의 `task_result` 입력이 충족되지 않았거나(통과 평가가 있는 완료 업무의 결과만 인정, upstream.ts) 어댑터를 고를 수 없는 업무도
 * 같은 방식으로 `needs_review` 로 보낸다(run 을 만들지 않고 시도도 소모하지 않는다).
 * A6-U13: 명세의 `measurement` 입력이 아직 기록되지 않은 업무는 후보에서 빠진다(대기 조건: 전이 없음, 시도 소모 없음, SQL 조건이라 다른 업무의 선택을 막지 않음).
 * 기록된 뒤 집히는 업무에 아직 측정 근거가 없으면(측정 뒤에 만들어진 업무) 같은 트랜잭션에서 붙인다.
 */
export function claimNextTask(db: Db, options: ClaimOptions): ClaimResult {
  return db.writeTx((tx) => {
    const now = options.clock.nowIso();
    const sentToReview: string[] = [];
    const candidates = tx.all<TaskRow>(
      `SELECT t.* FROM task t
       WHERE t.status = 'queued' AND t.role_id IS NOT NULL ${options.taskId === undefined ? '' : 'AND t.id = ?'}
         AND NOT EXISTS (SELECT 1 FROM task_dependency d JOIN task p ON p.id = d.depends_on
                         WHERE d.task_id = t.id AND p.status <> 'completed')
         AND ${MEASUREMENTS_RECORDED_SQL}
       ORDER BY t.created_at, t.rowid LIMIT ${CANDIDATES_PER_CLAIM}`,
      options.taskId === undefined ? [] : [options.taskId],
    );
    for (const task of candidates) {
      const spec = JSON.parse(task.spec) as TaskSpec;
      const toReview = (reason: string): void => {
        transitionTask(tx, { taskId: task.id, from: 'queued', to: 'needs_review', by: 'scheduler', reason: reason.slice(0, 500), now });
        sentToReview.push(task.id);
      };
      let upstream: UpstreamResult[] = [];
      if (hasTaskResultInputs(spec)) {
        const resolved = resolveUpstream(tx, spec);
        if (!resolved.ok) {
          toReview(`upstream_unmet: ${resolved.code}: input '${resolved.input}': ${resolved.detail}`);
          continue;
        }
        upstream = resolved.upstream;
      }
      let adapter = options.adapter;
      if (options.adapterFor !== undefined) {
        let picked: unknown;
        try {
          picked = options.adapterFor(spec);
        } catch (error) {
          toReview(`adapter_unresolved: ${error instanceof Error ? error.message : 'the adapter selector threw'}`);
          continue;
        }
        if (picked !== null) {
          if (typeof picked !== 'string' || picked.trim() === '' || picked.length > MAX_ADAPTER_NAME_CHARS) {
            toReview('adapter_unresolved: the adapter selector returned an invalid adapter name');
            continue;
          }
          adapter = picked;
        }
      }
      const previous = tx.get<{ attempt: number; checkpoint: string | null }>(
        'SELECT attempt, checkpoint FROM task_run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1', [task.id],
      );
      const attempt = Number(previous?.attempt ?? 0) + 1;
      const verdict = options.gate.beforeRun(tx, { task, spec, attempt, now });
      if (verdict.decision !== 'allow') {
        transitionTask(tx, { taskId: task.id, from: 'queued', to: 'needs_review', by: 'policy', reason: verdict.reason, now });
        sentToReview.push(task.id);
        continue;
      }
      if (measurementInputsOf(spec).length > 0) attachRecordedMeasurements(tx, task.id, spec, now);
      const runId = options.newRunId?.() ?? `run-${randomUUID()}`;
      transitionTask(tx, {
        taskId: task.id, from: 'queued', to: 'running', by: 'scheduler', now,
        reason: `lease acquired by ${options.workerId} (run ${runId}, attempt ${attempt})`,
      });
      tx.run(
        `INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, lease_owner, lease_expires_at, heartbeat_at, checkpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, task.id, attempt, options.actorId, adapter, now, options.workerId,
          isoAfter(options.clock.nowMs(), options.leaseMs), now, previous?.checkpoint ?? null],
      );
      return {
        claimed: {
          lease: { runId, taskId: task.id, owner: options.workerId, attempt, leaseMs: options.leaseMs },
          task: { ...task, status: 'running' },
          spec,
          adapter,
          upstream,
          checkpoint: previous?.checkpoint == null ? null : JSON.parse(previous.checkpoint),
        },
        sentToReview,
      };
    }
    return { claimed: null, sentToReview };
  });
}

// ===== run 종료 =====

export interface RunEnd {
  outcome: TaskRunOutcome;
  taskStatus: TaskStatus;
}

/**
 * 재전송 창이 닫혔다는 판정을 행에 남긴다 (강화만: 지원 → 미지원). 시계가 뒤로 가도 다시 열리지 않는다. planned_at 은 건드리지 않는다.
 * 호출자는 쓰기 트랜잭션 안이어야 한다.
 */
export function closeResendWindowInTx(tx: Db, effectId: string): void {
  tx.run(
    "UPDATE external_effect SET supports_idempotency = 0, idempotency_retention_ms = NULL WHERE id = ? AND state = 'unknown' AND supports_idempotency = 1",
    [effectId],
  );
}

/**
 * 이 run 의 `unknown` 부작용 중 지금 재전송할 수 없는 것(미지원, 또는 재전송 창이 닫힘)이 있는가. 행만 보고 판정한다 (resendAllowed).
 * 창이 닫혀서 막힌 행은 미지원으로 굳힌다 (쓰기 트랜잭션 안에서만 호출).
 */
function hasUnresendableUnknown(tx: Db, runId: string, now: string): boolean {
  let blocked = false;
  const rows = tx.all<Pick<ExternalEffectRow, 'id' | 'supports_idempotency' | 'idempotency_retention_ms' | 'planned_at'>>(
    "SELECT id, supports_idempotency, idempotency_retention_ms, planned_at FROM external_effect WHERE task_run_id = ? AND state = 'unknown'", [runId],
  );
  for (const row of rows) {
    if (resendAllowed(row, now)) continue;
    blocked = true;
    closeResendWindowInTx(tx, row.id);
  }
  return blocked;
}

/**
 * 이 run 의 부작용 중 전송 중(`dispatched`)으로 남은 것을 `unknown` 으로 돌리고(§3: 응답 유실·워커 사망),
 * 자동으로 풀 수 없는 것 — 멱등 키 미지원 도구, 또는 재전송 창(planned_at 부터 보존 기간의 50%)이 닫힌 `unknown` — 이 남았는지 돌려준다.
 */
function settleRunEffects(tx: Db, runId: string, now: string): boolean {
  const inFlight = tx.all<Pick<ExternalEffectRow, 'id'>>("SELECT id FROM external_effect WHERE task_run_id = ? AND state = 'dispatched'", [runId]);
  for (const effect of inFlight) transitionEffect(tx, { effectId: effect.id, from: 'dispatched', to: 'unknown', by: 'system', now });
  return hasUnresendableUnknown(tx, runId, now);
}

function closeRun(tx: Db, runId: string, outcome: TaskRunOutcome, now: string, result?: unknown): void {
  tx.run('UPDATE task_run SET outcome = ?, ended_at = ?, result = coalesce(?, result) WHERE id = ? AND outcome IS NULL', [
    outcome, now, result === undefined ? null : JSON.stringify(result), runId,
  ]);
}

/**
 * 업무 범위 unknown 관문 (recovery §3). 이 업무의 `unknown`/`dispatched` 부작용을 run 과 무관하게 훑는다.
 * 재전송 불가(미지원·창 닫힘) unknown 은 미지원으로 굳히고 unresendable, 다른 run 에 남은 dispatched 는 비정상이라 fail-closed(행은 안 바꾼다),
 * 창 안 멱등 unknown 은 pendingResendable (행은 안 바꾼다). 다른 업무 행은 보지 않는다. 쓰기 트랜잭션 안에서만 호출.
 */
function scanTaskEffects(
  tx: Db, taskId: string, runId: string, now: string,
): { ownUnresendable: boolean; otherUnresendable: boolean; otherDispatched: boolean; pendingResendable: boolean } {
  let ownUnresendable = false;
  let otherUnresendable = false;
  let otherDispatched = false;
  let pendingResendable = false;
  const rows = tx.all<Pick<ExternalEffectRow, 'id' | 'task_run_id' | 'state' | 'supports_idempotency' | 'idempotency_retention_ms' | 'planned_at'>>(
    "SELECT id, task_run_id, state, supports_idempotency, idempotency_retention_ms, planned_at FROM external_effect WHERE task_id = ? AND state IN ('unknown', 'dispatched')",
    [taskId],
  );
  for (const row of rows) {
    const own = row.task_run_id === runId;
    if (row.state === 'dispatched') {
      if (own) ownUnresendable = true;
      else otherDispatched = true;
    } else if (resendAllowed(row, now)) pendingResendable = true;
    else {
      closeResendWindowInTx(tx, row.id);
      if (own) ownUnresendable = true;
      else otherUnresendable = true;
    }
  }
  return { ownUnresendable, otherUnresendable, otherDispatched, pendingResendable };
}

/**
 * 실행이 결과를 냈다 (에이전트 자기 보고). running → validating.
 * 이 업무에 해결 안 된 `unknown` 부작용이 하나라도 남았으면(어느 run 의 것이든 — 재전송 불가든 창 안 재전송 가능이든) 검증으로 넘기지 않는다:
 * run 은 effect_unknown, 업무는 needs_review (§3). 다른 run 에 남은 dispatched 는 fail-closed.
 */
export function submitRun(db: Db, clock: Clock, lease: Lease, result: unknown): RunEnd {
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    assertLeaseHeld(tx, lease, now, 'submit');
    const runBlocked = settleRunEffects(tx, lease.runId, now);
    const scan = scanTaskEffects(tx, lease.taskId, lease.runId, now);
    const parts: string[] = [];
    if (runBlocked || scan.ownUnresendable) parts.push(unknownEffectReason(lease.runId));
    if (scan.otherUnresendable) parts.push(earlierRunUnknownReason(lease));
    if (scan.otherDispatched) parts.push(otherRunDispatchedReason(lease));
    if (scan.pendingResendable) parts.push(resendableUnknownReason(lease));
    if (parts.length > 0) {
      const reason = parts.join('; ');
      closeRun(tx, lease.runId, 'effect_unknown', now, result);
      transitionTask(tx, { taskId: lease.taskId, from: 'running', to: 'needs_review', by: 'scheduler', now, reason });
      return { outcome: 'effect_unknown', taskStatus: 'needs_review' };
    }
    closeRun(tx, lease.runId, 'submitted', now, result);
    transitionTask(tx, { taskId: lease.taskId, from: 'running', to: 'validating', by: 'scheduler', now, reason: `run ${lease.runId} submitted` });
    return { outcome: 'submitted', taskStatus: 'validating' };
  });
}

export interface FailRunOptions {
  outcome: 'error' | 'timeout' | 'killed';
  reason: string;
  /** retry_wait 의 next_run_at = now + retryDelayMs */
  retryDelayMs: number;
}

/**
 * 실행이 오류·타임아웃으로 끝났다. 시도 1회를 소모한다(attempts + 1).
 * attempts < max_attempts 면 retry_wait, 아니면 failed. 재전송할 수 없는 unknown 부작용(미지원·창 닫힘)이 있으면 needs_review.
 */
export function failRun(db: Db, clock: Clock, lease: Lease, options: FailRunOptions): RunEnd {
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    assertLeaseHeld(tx, lease, now, options.outcome);
    const task = tx.get<{ attempts: number; max_attempts: number }>('SELECT attempts, max_attempts FROM task WHERE id = ?', [lease.taskId])!;
    const attempts = Number(task.attempts) + 1;
    const reason = `run ${lease.runId} ${options.outcome}: ${options.reason}`.slice(0, 500);
    if (settleRunEffects(tx, lease.runId, now)) {
      closeRun(tx, lease.runId, 'effect_unknown', now);
      transitionTask(tx, {
        taskId: lease.taskId, from: 'running', to: 'needs_review', by: 'scheduler', now,
        reason: `${unknownEffectReason(lease.runId)}; ${reason}`, set: { attempts },
      });
      return { outcome: 'effect_unknown', taskStatus: 'needs_review' };
    }
    closeRun(tx, lease.runId, options.outcome, now);
    if (attempts < Number(task.max_attempts)) {
      transitionTask(tx, {
        taskId: lease.taskId, from: 'running', to: 'retry_wait', by: 'scheduler', now, reason,
        set: { attempts, next_run_at: isoAfter(clock.nowMs(), options.retryDelayMs) },
      });
      return { outcome: options.outcome, taskStatus: 'retry_wait' };
    }
    transitionTask(tx, { taskId: lease.taskId, from: 'running', to: 'failed', by: 'scheduler', now, reason: `${reason} (attempts exhausted)`, set: { attempts } });
    return { outcome: options.outcome, taskStatus: 'failed' };
  });
}

export interface KillRunOptions {
  /** time_limit: 시간 제한 초과, budget_exceeded: 업무 예산 초과, review_required: 사람이 풀어야 하는 조건(로그인 만료·사용량 한도 등) */
  reason: RunKillReason;
  detail: string;
  /** time_limit 의 retry_wait 대기 시간 */
  retryDelayMs: number;
  /** deferred 의 retry_wait 대기 시간 (시도를 소모하지 않는다). 생략하면 `retryDelayMs` */
  deferDelayMs?: number;
}

/**
 * 실행 관리가 run 을 강제로 끝냈다(시스템이 죽임): run 은 `killed`. 업무 전이는 기존 허용표 안에서 정한다.
 *  - time_limit: `timeout` 과 같다. 시도 1회를 소모하고 attempts < max_attempts 면 retry_wait, 아니면 failed
 *  - budget_exceeded: 재시도해도 같은 예산이라 소용이 없으므로 시도를 소모하지 않고 needs_review (사람이 예산·명세를 정한다)
 *  - review_required: 재시도해도 같은 조건이라 시도를 소모하지 않고 needs_review (사람이 조건을 풀고 다시 큐에 넣는다)
 *  - deferred: 어댑터가 일을 시작하지 않고 미뤘다. 시도를 소모하지 않고 `deferDelayMs` 뒤의 retry_wait (시도가 남았는지와 무관하다 — 실패가 아니다)
 * 어느 쪽이든 재전송할 수 없는 unknown 부작용(미지원·창 닫힘)이 남았으면 run 은 effect_unknown, 업무는 needs_review (§3).
 */
export function killRun(db: Db, clock: Clock, lease: Lease, options: KillRunOptions): RunEnd {
  if (options.reason === 'time_limit') {
    return failRun(db, clock, lease, { outcome: 'killed', reason: `time_limit: ${options.detail}`, retryDelayMs: options.retryDelayMs });
  }
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    assertLeaseHeld(tx, lease, now, 'kill');
    const reason = `run ${lease.runId} killed: ${options.reason}: ${options.detail}`.slice(0, 500);
    const blocked = settleRunEffects(tx, lease.runId, now);
    closeRun(tx, lease.runId, blocked ? 'effect_unknown' : 'killed', now);
    if (options.reason === 'deferred' && !blocked) {
      transitionTask(tx, {
        taskId: lease.taskId, from: 'running', to: 'retry_wait', by: 'scheduler', now, reason,
        set: { next_run_at: isoAfter(clock.nowMs(), options.deferDelayMs ?? options.retryDelayMs) },
      });
      return { outcome: 'killed', taskStatus: 'retry_wait' };
    }
    transitionTask(tx, {
      taskId: lease.taskId, from: 'running', to: 'needs_review', by: 'scheduler', now,
      reason: blocked ? `${unknownEffectReason(lease.runId)}; ${reason}` : reason,
    });
    return { outcome: blocked ? 'effect_unknown' : 'killed', taskStatus: 'needs_review' };
  });
}

/**
 * 증거 한 줄. 어댑터가 낸 출력을 `evidence` 행으로 옮길 때 쓴다 (verified 는 0, 검증기가 올린다).
 * 신뢰 출처(`trust_origin`) 필드가 없다: 어댑터 출력은 신뢰 경계 밖이라 자기 신고를 받지 않고, `recordRunOutput` 이 항상 `external_untrusted` 로 쓴다.
 */
export interface RunEvidence {
  kind: EvidenceRow['kind'];
  ref: string;
  capturedAt: string;
  contentHash?: string;
}

export interface RunOutputRecord {
  evidence: readonly RunEvidence[];
  runLogRef: string | null;
}

/** 호스트(도구 실행기)가 직접 남기는 근거 한 줄. 신뢰 출처는 쓰는 쪽이 밝힌다 — 이 경로는 에이전트가 아니라 호스트 코드만 부를 수 있다 */
export interface HostEvidence {
  kind: EvidenceRow['kind'];
  ref: string;
  /** 본문의 sha256 (소문자 16진). 평가기가 저장된 본문을 읽어 다시 계산해 대조한다 */
  contentHash: string;
  trustOrigin: EvidenceRow['trust_origin'];
  capturedAt: string;
}

/**
 * 도구 실행기가 호출 시점에 본문을 저장하고 근거 행을 만든다(상품 등록 검증의 로컬 근거). 행 id 를 돌려주므로 에이전트가 보고서에서 그 근거를 가리킬 수 있다.
 * `recordRunOutput`(에이전트가 낸 증거: 항상 `external_untrusted`)과 달리 신뢰 출처를 호출한 호스트 코드가 정한다. lease 펜싱은 같다(잃었으면 던진다).
 */
export function recordHostEvidence(db: Db, clock: Clock, lease: Lease, item: HostEvidence, newId: () => string = () => `ev-${randomUUID()}`): string {
  if (!item.ref.startsWith(HOST_EVIDENCE_REF_PREFIX)) throw new Error(`host evidence refs must start with '${HOST_EVIDENCE_REF_PREFIX}' (the namespace reserved for host-stored evidence)`);
  return db.writeTx((tx) => {
    assertLeaseHeld(tx, lease, clock.nowIso(), 'record evidence');
    const id = newId();
    tx.run(
      'INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, trust_origin, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, lease.taskId, lease.runId, item.kind, item.ref, item.contentHash, item.trustOrigin, item.capturedAt],
    );
    return id;
  });
}

/**
 * 실행 출력(증거 행과 `task_run.run_log_ref`)을 기록한다. 펜싱을 확인한 같은 쓰기 트랜잭션에서만 쓰므로
 * lease 를 잃은 run 은 아무것도 남기지 못한다(LeaseLostError).
 *
 * 호스트 강제 (A5-U8): 이 함수가 에이전트 출력 → `evidence` 행의 유일한 저장 경로이고, `trust_origin` 을 인자로 받지 않는다.
 * 어댑터가 근거의 신뢰 출처를 무엇이라 밝혔든(계약의 `EvidenceItem.trust_origin` 은 어휘 검증만 받는 참고용 자기 신고다) 항상
 * `external_untrusted` 로 쓴다 — 어댑터 출력은 신뢰 경계 밖이므로 자기 신고에 기대지 않는다. 호출자가 객체에 `trustOrigin` 을 몰래 실어도 SQL 에 닿지 않는다.
 */
/** 호스트 전용 근거 참조 이름 공간: 호스트(도구 실행기)가 저장한 본문만 `blob:` 으로 시작한다. 에이전트가 낸 증거는 이 참조를 쓸 수 없다 */
export const HOST_EVIDENCE_REF_PREFIX = 'blob:';

export function recordRunOutput(db: Db, clock: Clock, lease: Lease, record: RunOutputRecord, newId: () => string = () => `ev-${randomUUID()}`): void {
  const reserved = record.evidence.find((item) => item.ref.startsWith(HOST_EVIDENCE_REF_PREFIX));
  if (reserved !== undefined) throw new Error(`evidence ref '${reserved.ref.slice(0, 40)}' is in the namespace reserved for host-stored evidence`);
  db.writeTx((tx) => {
    assertLeaseHeld(tx, lease, clock.nowIso(), 'record output');
    for (const item of record.evidence) {
      tx.run(
        "INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, trust_origin, captured_at) VALUES (?, ?, ?, ?, ?, ?, 'external_untrusted', ?)",
        [newId(), lease.taskId, lease.runId, item.kind, item.ref, item.contentHash ?? null, item.capturedAt],
      );
    }
    if (record.runLogRef !== null) tx.run('UPDATE task_run SET run_log_ref = ? WHERE id = ?', [record.runLogRef, lease.runId]);
  });
}

/**
 * 실행 중 재검증(부작용 직전 정책 게이트)이 거부했다: run 을 `killed`(시스템이 강제 종료)로 닫고 running → needs_review.
 * 반드시 펜싱을 확인한 같은 쓰기 트랜잭션 안에서 부른다. 시도 횟수는 소모하지 않는다(실행 실패가 아니라 재승인 대기).
 */
export function stopRunForReview(tx: Db, lease: Lease, now: string, reason: string): RunEnd {
  settleRunEffects(tx, lease.runId, now);
  closeRun(tx, lease.runId, 'killed', now);
  transitionTask(tx, {
    taskId: lease.taskId, from: 'running', to: 'needs_review', by: 'scheduler', now,
    reason: `run ${lease.runId} stopped before an external effect: ${reason}`.slice(0, 500),
  });
  return { outcome: 'killed', taskStatus: 'needs_review' };
}

const unknownEffectReason = (runId: string) =>
  `run ${runId} left an 'unknown' external effect that may not be resent (tool without idempotency keys, or more than 50% of retention_ms since planned_at); not resent automatically (recovery §3)`;

const earlierRunUnknownReason = (lease: Lease) =>
  `run ${lease.runId} submitted while task ${lease.taskId} has an 'unknown' external effect left by an earlier run that may not be resent (tool without idempotency keys, or more than 50% of retention_ms since planned_at); not resent automatically (recovery §3)`;

const otherRunDispatchedReason = (lease: Lease) =>
  `run ${lease.runId} submitted while task ${lease.taskId} has an external effect still 'dispatched' on another run (abnormal; delivery unknown, blocked fail-closed) (recovery §3)`;

const resendableUnknownReason = (lease: Lease) =>
  `run ${lease.runId} submitted while an external effect of task ${lease.taskId} is still 'unknown' (resendable with the same key, delivery unconfirmed); not completed automatically (recovery §3)`;

// ===== 만료 인수와 재시도 대기 =====

export interface ExpiredRun {
  runId: string;
  taskId: string;
  attempt: number;
  owner: string;
}

export function findExpiredRuns(db: Db, now: string): ExpiredRun[] {
  return db.all<{ id: string; task_id: string; attempt: number; lease_owner: string }>(
    'SELECT id, task_id, attempt, lease_owner FROM task_run WHERE outcome IS NULL AND lease_expires_at <= ? ORDER BY lease_expires_at, id',
    [now],
  ).map((row) => ({ runId: row.id, taskId: row.task_id, attempt: Number(row.attempt), owner: row.lease_owner }));
}

/** 인수 전에 외부 상태를 조회한 결과 (effect id → 조회 결과). 조회는 트랜잭션 밖에서 한다. */
export type EffectLookups = ReadonlyMap<string, { found: true; responseRef: string | null } | { found: false }>;

export interface TakeoverOptions {
  clock: Clock;
  workerId: string;
  lookups?: EffectLookups;
  /** lease 만료 인수가 시도 횟수를 소모하는가 (정책 파라미터, 기본 소모하지 않음 — state-machines.md 업무 규칙) */
  consumeAttempt?: boolean;
}

export interface TakeoverResult extends RunEnd {
  runId: string;
  taskId: string;
}

/**
 * 만료된 run 하나를 인수 처리한다 (한 쓰기 트랜잭션). 이미 다른 워커가 처리했거나 그 사이 heartbeat 로 살아났으면 null.
 *  1. 이 run 의 `dispatched`/`unknown` 부작용: 조회 결과가 "전달됨"이면 confirmed, 아니면 `unknown` (워커 사망)
 *  2. 재전송할 수 없는 `unknown`(미지원, 또는 planned_at 부터 보존 기간의 50% 가 지나 창이 닫힘)이 남으면 run = effect_unknown, 업무 running → needs_review (재전송 없음, 시도 소모 없음).
 *     도구 등록 없이 행만 보고 판정한다
 *  3. 아니면 run = lease_expired, 업무 running → queued. 창 안의 멱등 지원 `unknown` 은 새 attempt 가 같은 키로 재전송한다
 */
export function takeOverExpiredRun(db: Db, run: ExpiredRun, options: TakeoverOptions): TakeoverResult | null {
  return db.writeTx((tx) => {
    const now = options.clock.nowIso();
    const still = tx.get('SELECT 1 AS one FROM task_run WHERE id = ? AND outcome IS NULL AND lease_expires_at <= ?', [run.runId, now]);
    if (!still) return null;

    const open = tx.all<Pick<ExternalEffectRow, 'id' | 'state'>>(
      "SELECT id, state FROM external_effect WHERE task_run_id = ? AND state IN ('dispatched', 'unknown') ORDER BY id", [run.runId],
    );
    for (const effect of open) {
      const lookup = options.lookups?.get(effect.id);
      if (lookup?.found) {
        transitionEffect(tx, { effectId: effect.id, from: effect.state, to: 'confirmed', by: 'system', now, set: { response_ref: lookup.responseRef } });
      } else if (effect.state === 'dispatched') {
        transitionEffect(tx, { effectId: effect.id, from: 'dispatched', to: 'unknown', by: 'system', now });
      }
    }
    const blocked = hasUnresendableUnknown(tx, run.runId, now);
    const base = `lease of run ${run.runId} (attempt ${run.attempt}, owner ${run.owner}) expired; taken over by ${options.workerId}`;

    if (blocked) {
      closeRun(tx, run.runId, 'effect_unknown', now);
      transitionTask(tx, { taskId: run.taskId, from: 'running', to: 'needs_review', by: 'scheduler', now, reason: `${base}; ${unknownEffectReason(run.runId)}` });
      return { runId: run.runId, taskId: run.taskId, outcome: 'effect_unknown', taskStatus: 'needs_review' };
    }
    closeRun(tx, run.runId, 'lease_expired', now);
    const task = tx.get<{ attempts: number; max_attempts: number }>('SELECT attempts, max_attempts FROM task WHERE id = ?', [run.taskId])!;
    if (options.consumeAttempt) {
      const attempts = Number(task.attempts) + 1;
      if (attempts >= Number(task.max_attempts)) {
        transitionTask(tx, { taskId: run.taskId, from: 'running', to: 'failed', by: 'scheduler', now, reason: `${base} (attempts exhausted)`, set: { attempts } });
        return { runId: run.runId, taskId: run.taskId, outcome: 'lease_expired', taskStatus: 'failed' };
      }
      transitionTask(tx, { taskId: run.taskId, from: 'running', to: 'queued', by: 'scheduler', now, reason: base, set: { attempts } });
    } else {
      transitionTask(tx, { taskId: run.taskId, from: 'running', to: 'queued', by: 'scheduler', now, reason: base });
    }
    return { runId: run.runId, taskId: run.taskId, outcome: 'lease_expired', taskStatus: 'queued' };
  });
}

/** retry_wait 중 next_run_at 에 도달한 업무를 queued 로 (state-machines.md). */
export function promoteDueRetries(db: Db, clock: Clock): string[] {
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    const due = tx.all<{ id: string }>("SELECT id FROM task WHERE status = 'retry_wait' AND next_run_at <= ? ORDER BY next_run_at, id", [now]);
    for (const task of due) {
      transitionTask(tx, { taskId: task.id, from: 'retry_wait', to: 'queued', by: 'scheduler', now, reason: 'next_run_at reached', set: { next_run_at: null } });
    }
    return due.map((task) => task.id);
  });
}
