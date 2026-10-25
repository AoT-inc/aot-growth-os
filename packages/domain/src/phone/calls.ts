// 통화 저장과 canonical 이벤트 적용 (ADR-0014 §4~§6). `call` 은 현재 상태 + 상관 키, 이벤트는 기존 `event` 테이블(source='phone'),
// 본문(transcript, outcome)은 `call_artifact`, 업무에 연결된 통화는 통화 기록·산출물이 `evidence` 로도 남아 평가기가 원본 증거로 읽는다.
//
// 이벤트 적용 규칙 (applyPhoneEvent, 한 쓰기 트랜잭션)
//  - 같은 이벤트(멱등 키 `phone:<provider>:<eventId>`)는 한 번만 적용한다 → `duplicate`.
//  - 상태는 앞으로만 간다. 이미 지나간 상태나 종료 상태로 되돌리는 이벤트, 허용표에 없는 전이는 기록만 하고 상태는 바꾸지 않는다 → `stale`.
//  - 알 수 없는 통화의 이벤트는 인바운드 `initiated` 만 통화를 만든다. 그 밖은 아무것도 쓰지 않는다 → `unknown_call`.
//  - 이벤트 payload 에는 전화번호와 발화 내용을 넣지 않는다(개인정보). 본문은 call_artifact 에만 있다.
//  - 비용·증거·산출물은 이벤트가 새로 기록될 때만 쓴다(중복 이벤트가 비용을 두 번 더하지 못한다).
import { randomUUID } from 'node:crypto';

import { contentHash, canonicalJson } from '../canonical.ts';
import type { Clock } from '../clock.ts';
import type { Db } from '../db/types.ts';
import type { CallArtifactKind, CallArtifactRow, CallArtifactSource, CallRow, CallStatus, TrustOrigin } from '../entities/index.ts';
import { validateConversationOutcome, type ConversationOutcome } from '../conversation/outcome.ts';
import { normalizeTranscriptTurns, type TranscriptTurn } from '../conversation/transcript.ts';
import { assertTransition, checkTransition, type TransitionActor } from '../state/machine.ts';
import { CALL_MACHINE, isCallOpen } from '../state/machines.ts';
import { ValidationError } from '../validation.ts';

import { PhoneRuleError } from './errors.ts';
import { callOf, type Call, type CallOutcome, type PhoneAnalysisInput, type PhoneEvent, type Transcript } from './model.ts';
import { validatePhoneEvent } from './validate.ts';

export const PHONE_EVENT_SOURCE = 'phone';
/** 우리 쪽에서 만드는 이벤트(발신 접수 등)의 provider 이름 */
export const AOT_EVENT_PROVIDER = 'aot';

export const phoneEventKey = (provider: string, eventId: string): string => `phone:${provider}:${eventId}`;

const RANK: Readonly<Record<CallStatus, number>> = { queued: 0, initiated: 1, ringing: 2, connected: 3, transferred: 4, completed: 5, failed: 5, cancelled: 5 };

const STATUS_OF: Readonly<Partial<Record<PhoneEvent['type'], CallStatus>>> = {
  'phone.call.initiated': 'initiated', 'phone.call.ringing': 'ringing', 'phone.call.connected': 'connected',
  'phone.call.completed': 'completed', 'phone.call.failed': 'failed', 'phone.call.cancelled': 'cancelled', 'phone.call.transferred': 'transferred',
};

const END_REASON_CHARS = 200;

// ===== 조회 =====

export const getCallRow = (db: Db, callId: string): CallRow | undefined => db.get<CallRow>('SELECT * FROM call WHERE id = ?', [callId]);

export function getCall(db: Db, callId: string): Call {
  const row = getCallRow(db, callId);
  if (!row) throw new PhoneRuleError('call_not_found', `call '${callId}' does not exist`);
  return callOf(row);
}

export const findCallByProvider = (db: Db, provider: string, providerCallId: string): Call | null => {
  const row = db.get<CallRow>('SELECT * FROM call WHERE provider = ? AND provider_call_id = ?', [provider, providerCallId]);
  return row ? callOf(row) : null;
};

export const listCallsForTask = (db: Db, taskId: string): Call[] =>
  db.all<CallRow>('SELECT * FROM call WHERE task_id = ? ORDER BY created_at, id', [taskId]).map(callOf);

/** 이 업무에 아직 끝나지 않은 통화가 있는가 (task-engine 의 검증 보류가 쓰는 조건의 TS 쪽 거울) */
export const hasOpenCall = (db: Db, taskId: string): boolean =>
  db.get("SELECT 1 AS one FROM call WHERE task_id = ? AND status NOT IN ('completed','failed','cancelled') LIMIT 1", [taskId]) !== undefined;

/** `sinceIso` 이후 만든 발신 통화 수 (하루 통화량 한도용). 제공자에 닿지 못하고 실패한 통화는 세지 않는다 */
export function countOutboundCallsSince(db: Db, sinceIso: string): number {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM call WHERE direction = 'outbound' AND created_at >= ? AND NOT (status IN ('failed','cancelled') AND provider_call_id IS NULL)", [sinceIso],
  );
  return Number(row?.n ?? 0);
}

// ===== 생성 =====

export interface NewOutboundCall {
  provider: string;
  to: string;
  from: string | null;
  taskId: string;
  taskRunId: string | null;
  actorId: string | null;
  orgUnitId: string | null;
  objective: string;
  /** external_effect.effect_key — 같은 요청이면 같은 Call 을 돌려준다 */
  effectKey: string;
  maxDurationSeconds: number;
  allowTransfer: boolean;
  recording: boolean;
}

/** 발신 요청을 `queued` 로 기록하고 `phone.call.requested` 이벤트를 남긴다. 같은 effectKey 가 이미 있으면 새로 만들지 않는다. */
export function createOutboundCall(db: Db, clock: Clock, input: NewOutboundCall): { call: Call; created: boolean } {
  return db.writeTx((tx) => {
    const existing = tx.get<CallRow>('SELECT * FROM call WHERE effect_key = ?', [input.effectKey]);
    if (existing) return { call: callOf(existing), created: false };
    const now = clock.nowIso();
    const id = `call-${input.effectKey.slice(0, 32)}`;
    tx.run(
      `INSERT INTO call (id, provider, provider_call_id, direction, status, from_number, to_number, task_id, task_run_id, actor_id, org_unit_id, objective, effect_key,
         max_duration_seconds, allow_transfer, recording, end_reason, started_at, connected_at, ended_at, created_at, updated_at)
       VALUES (?, ?, NULL, 'outbound', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      [id, input.provider, input.from, input.to, input.taskId, input.taskRunId, input.actorId, input.orgUnitId, input.objective, input.effectKey,
        input.maxDurationSeconds, input.allowTransfer ? 1 : 0, input.recording ? 1 : 0, now, now],
    );
    insertEvent(tx, now, {
      provider: AOT_EVENT_PROVIDER, eventId: `requested:${id}`, type: 'phone.call.requested', callId: id, occurredAt: now,
      payload: { call_id: id, direction: 'outbound', task_id: input.taskId, objective: input.objective },
    });
    return { call: callOf(tx.get<CallRow>('SELECT * FROM call WHERE id = ?', [id])!), created: true };
  });
}

// ===== 이벤트 적용 =====

export type ApplyResult =
  | { result: 'applied'; callId: string; from: CallStatus | null; to: CallStatus; callCreated: boolean }
  | { result: 'stale'; callId: string; status: CallStatus }
  | { result: 'duplicate'; callId: string | null }
  | { result: 'unknown_call'; callId: null };

function resolveCall(tx: Db, event: PhoneEvent): CallRow | undefined {
  if (event.callId !== undefined) {
    const row = tx.get<CallRow>('SELECT * FROM call WHERE id = ?', [event.callId]);
    if (row && event.provider !== AOT_EVENT_PROVIDER && row.provider !== event.provider) throw new PhoneRuleError('provider_mismatch', `call '${row.id}' belongs to provider '${row.provider}', not '${event.provider}'`);
    if (row && event.providerCallId !== null && row.provider_call_id !== null && row.provider_call_id !== event.providerCallId) {
      throw new PhoneRuleError('provider_mismatch', `call '${row.id}' is known to the provider as another call id`);
    }
    return row;
  }
  return event.providerCallId === null ? undefined : tx.get<CallRow>('SELECT * FROM call WHERE provider = ? AND provider_call_id = ?', [event.provider, event.providerCallId]);
}

export function applyPhoneEvent(db: Db, clock: Clock, raw: PhoneEvent): ApplyResult {
  const checked = validatePhoneEvent(raw);
  if (!checked.ok) throw new ValidationError('phone event', checked.errors);
  const event = checked.value;
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    const key = phoneEventKey(event.provider, event.eventId);
    let call = resolveCall(tx, event);
    if (tx.get('SELECT 1 AS one FROM event WHERE idempotency_key = ?', [key])) return { result: 'duplicate', callId: call?.id ?? null };

    let callCreated = false;
    if (!call) {
      if (event.type !== 'phone.call.initiated' || event.direction !== 'inbound' || event.providerCallId === null || event.to === undefined) return { result: 'unknown_call', callId: null };
      call = insertInboundCall(tx, now, event);
      callCreated = true;
    } else if (call.provider_call_id === null && event.providerCallId !== null) {
      tx.run('UPDATE call SET provider_call_id = ?, updated_at = ? WHERE id = ?', [event.providerCallId, now, call.id]);
      call = { ...call, provider_call_id: event.providerCallId };
    }

    const target = STATUS_OF[event.type];
    let applied: { from: CallStatus | null; to: CallStatus } | null = null;
    if (callCreated) {
      applied = { from: null, to: call.status };
    } else if (target !== undefined) {
      const allowed = RANK[target] > RANK[call.status] && checkTransition(CALL_MACHINE, { from: call.status, to: target, by: 'system' }).ok;
      if (allowed) {
        assertTransition(CALL_MACHINE, { from: call.status, to: target, by: 'system' });
        const terminal = !isCallOpen(target);
        const sets: string[] = ['status = ?', 'updated_at = ?'];
        const values: (string | number | null)[] = [target, now];
        if (target === 'initiated' && call.started_at === null) { sets.push('started_at = ?'); values.push(event.occurredAt); }
        if (target === 'connected' && call.connected_at === null) { sets.push('connected_at = ?'); values.push(event.occurredAt); }
        if (terminal) { sets.push('ended_at = ?'); values.push(event.occurredAt); }
        const reason = endReasonOf(event);
        if (terminal && reason !== null) { sets.push('end_reason = ?'); values.push(reason); }
        const changed = tx.run(`UPDATE call SET ${sets.join(', ')} WHERE id = ? AND status = ?`, [...values, call.id, call.status]);
        if (changed.changes !== 1) throw new PhoneRuleError('not_open', `call ${call.id} changed concurrently`);
        applied = { from: call.status, to: target };
      }
    }

    const payload: Record<string, unknown> = { call_id: call.id, ...(applied ? { status_after: applied.to } : { status_unchanged: call.status }) };
    if (event.type === 'phone.call.completed') {
      if (event.endedReason !== undefined) payload['ended_reason'] = event.endedReason.slice(0, END_REASON_CHARS);
      if (event.durationSeconds !== undefined) payload['duration_seconds'] = event.durationSeconds;
      if (event.costUsd !== undefined) payload['cost_usd'] = event.costUsd;
    }
    if (event.type === 'phone.call.failed') payload['code'] = event.code;
    if (event.type === 'phone.call.transcript.updated') payload['turns'] = event.transcript.turns.length;
    insertEvent(tx, now, { provider: event.provider, eventId: event.eventId, type: event.type, callId: call.id, occurredAt: event.occurredAt, payload });

    // 산출물: 상태가 늦은 이벤트(stale)여도 transcript·분석은 받는다(통화 내용은 사실이다). 종료 상태가 아닌 통화의 outcome 은 받지 않는다.
    const transcriptInput = event.type === 'phone.call.transcript.updated' ? event.transcript : event.type === 'phone.call.completed' ? event.transcript : undefined;
    if (transcriptInput !== undefined) {
      const turns = normalizeTranscriptTurns(transcriptInput.turns);
      if (turns.ok && turns.value.length > 0) upsertTranscript(tx, now, call.id, turns.value, transcriptInput.language);
    }
    if (event.type === 'phone.call.completed') {
      if (event.analysis !== undefined) recordProviderAnalysis(tx, now, call.id, event.analysis);
      if (event.costUsd !== undefined && event.costUsd > 0) {
        tx.run(
          "INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES (?, ?, ?, NULL, 'external', ?, ?, ?)",
          [`cost-${randomUUID()}`, call.task_id, call.task_run_id, event.costUsd, JSON.stringify({ source: 'phone', call_id: call.id, provider: call.provider, duration_seconds: event.durationSeconds ?? null }), now],
        );
      }
    }
    syncCallEvidence(tx, now, call.id);
    return applied
      ? { result: 'applied', callId: call.id, from: applied.from, to: applied.to, callCreated }
      : { result: 'stale', callId: call.id, status: call.status };
  });
}

function endReasonOf(event: PhoneEvent): string | null {
  switch (event.type) {
    case 'phone.call.completed': return event.endedReason === undefined ? null : event.endedReason.slice(0, END_REASON_CHARS);
    case 'phone.call.failed': return `${event.code}${event.reason === undefined ? '' : `: ${event.reason}`}`.slice(0, END_REASON_CHARS);
    case 'phone.call.cancelled': return event.reason === undefined ? null : event.reason.slice(0, END_REASON_CHARS);
    default: return null;
  }
}

function insertInboundCall(tx: Db, now: string, event: Extract<PhoneEvent, { type: 'phone.call.initiated' }>): CallRow {
  const id = `call-${randomUUID()}`;
  tx.run(
    `INSERT INTO call (id, provider, provider_call_id, direction, status, from_number, to_number, task_id, task_run_id, actor_id, org_unit_id, objective, effect_key,
       max_duration_seconds, allow_transfer, recording, end_reason, started_at, connected_at, ended_at, created_at, updated_at)
     VALUES (?, ?, ?, 'inbound', 'initiated', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, ?, NULL, NULL, ?, ?)`,
    [id, event.provider, event.providerCallId, event.from ?? null, event.to ?? '', event.occurredAt, now, now],
  );
  return tx.get<CallRow>('SELECT * FROM call WHERE id = ?', [id])!;
}

function insertEvent(tx: Db, now: string, e: { provider: string; eventId: string; type: string; callId: string; occurredAt: string; payload: Record<string, unknown> }): void {
  const key = phoneEventKey(e.provider, e.eventId);
  tx.run(
    `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [`event-${contentHash(key).slice(0, 32)}`, PHONE_EVENT_SOURCE, e.callId, e.type, JSON.stringify(e.payload), key, e.occurredAt, now],
  );
}

// ===== 인바운드 통화와 업무의 연결 =====

export interface CallLink {
  taskId: string;
  taskRunId?: string | null | undefined;
  actorId?: string | null | undefined;
  orgUnitId?: string | null | undefined;
  objective?: string | null | undefined;
}

/** 업무 없이 생긴 통화(인바운드)를 업무에 연결한다. 이미 다른 업무에 연결된 통화는 거부한다. 연결하면 통화 증거도 업무에 붙는다 */
export function linkCallToTask(db: Db, clock: Clock, callId: string, link: CallLink): Call {
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    const call = tx.get<CallRow>('SELECT * FROM call WHERE id = ?', [callId]);
    if (!call) throw new PhoneRuleError('call_not_found', `call '${callId}' does not exist`);
    if (call.task_id !== null && call.task_id !== link.taskId) throw new PhoneRuleError('link_conflict', `call '${callId}' is already linked to another task`);
    tx.run(
      'UPDATE call SET task_id = ?, task_run_id = COALESCE(?, task_run_id), actor_id = COALESCE(?, actor_id), org_unit_id = COALESCE(?, org_unit_id), objective = COALESCE(?, objective), updated_at = ? WHERE id = ?',
      [link.taskId, link.taskRunId ?? null, link.actorId ?? null, link.orgUnitId ?? null, link.objective ?? null, now, callId],
    );
    syncCallEvidence(tx, now, callId);
    return callOf(tx.get<CallRow>('SELECT * FROM call WHERE id = ?', [callId])!);
  });
}

// ===== 산출물: transcript, outcome =====

const artifactRow = (db: Db, callId: string, kind: CallArtifactKind): CallArtifactRow | undefined =>
  db.get<CallArtifactRow>('SELECT * FROM call_artifact WHERE call_id = ? AND kind = ?', [callId, kind]);

function upsertTranscript(tx: Db, now: string, callId: string, turns: TranscriptTurn[], language: string | undefined): void {
  const content = canonicalJson({ turns, ...(language === undefined || language === '' ? {} : { language }) });
  const existing = artifactRow(tx, callId, 'transcript');
  const hash = contentHash({ turns, language: language ?? null });
  if (!existing) {
    tx.run(
      "INSERT INTO call_artifact (id, call_id, kind, content, content_hash, source, trust_origin, created_at, updated_at) VALUES (?, ?, 'transcript', ?, ?, 'provider_transcript', 'external_untrusted', ?, ?)",
      [`artifact-${randomUUID()}`, callId, content, hash, now, now],
    );
    return;
  }
  // 스트리밍 갱신은 더 긴(또는 같은 길이의) 기록이 이긴다. 늦게 도착한 짧은 기록이 완성된 기록을 덮지 못한다.
  const before = (JSON.parse(existing.content) as { turns: unknown[] }).turns.length;
  if (turns.length >= before && existing.content_hash !== hash) {
    tx.run('UPDATE call_artifact SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?', [content, hash, now, existing.id]);
  }
}

function outcomeContent(outcome: ConversationOutcome): string {
  return canonicalJson({ disposition: outcome.disposition, summary: outcome.summary, structured_data: outcome.structuredData, ...(outcome.nextAction === undefined ? {} : { next_action: outcome.nextAction }) });
}

/** provider 분석 → outcome 후보. disposition·summary 가 없거나 형식이 틀리면 만들지 않는다(자유 텍스트만으로는 outcome 이 아니다) */
function recordProviderAnalysis(tx: Db, now: string, callId: string, analysis: PhoneAnalysisInput): void {
  if (analysis.disposition === undefined || analysis.summary === undefined) return;
  const checked = validateConversationOutcome({
    disposition: analysis.disposition, summary: analysis.summary, structuredData: analysis.structuredData ?? {},
    ...(analysis.nextAction === undefined ? {} : { nextAction: analysis.nextAction }),
  });
  if (!checked.ok) return;
  if (artifactRow(tx, callId, 'outcome')) return; // 한 번만 기록한다
  const content = outcomeContent(checked.value);
  tx.run(
    "INSERT INTO call_artifact (id, call_id, kind, content, content_hash, source, trust_origin, created_at, updated_at) VALUES (?, ?, 'outcome', ?, ?, 'provider_analysis', 'external_untrusted', ?, ?)",
    [`artifact-${randomUUID()}`, callId, content, contentHash(content), now, now],
  );
}

export interface RecordCallOutcomeInput {
  callId: string;
  outcome: unknown;
  /** 기록 출처. 에이전트가 자기 결과를 기록하는 길은 없다 */
  source: Extract<CallArtifactSource, 'extractor' | 'human'>;
  by: TransitionActor;
  /** 허용 disposition (업무 명세의 expected_call_outcome) */
  allowedDispositions?: readonly string[] | undefined;
}

/** 사람 또는 추출기가 통화 결과를 기록한다. 통화가 끝나 있어야 하고, 한 번만 기록된다(같은 내용 재기록은 흡수, 다른 내용은 거부) */
export function recordCallOutcome(db: Db, clock: Clock, input: RecordCallOutcomeInput): { created: boolean; outcome: CallOutcome } {
  if (input.by === 'agent') throw new PhoneRuleError('agent_forbidden', 'an agent cannot record the outcome of its own call: the outcome is evidence, not a self-report');
  const checked = validateConversationOutcome(input.outcome, input.allowedDispositions);
  if (!checked.ok) throw new ValidationError('call outcome', checked.errors);
  return db.writeTx((tx) => {
    const now = clock.nowIso();
    const call = tx.get<CallRow>('SELECT * FROM call WHERE id = ?', [input.callId]);
    if (!call) throw new PhoneRuleError('call_not_found', `call '${input.callId}' does not exist`);
    if (isCallOpen(call.status)) throw new PhoneRuleError('not_open', `call '${call.id}' is still ${call.status}; an outcome is recorded after the call ends`);
    const content = outcomeContent(checked.value);
    const existing = artifactRow(tx, call.id, 'outcome');
    if (existing) {
      if (existing.content_hash === contentHash(content)) return { created: false, outcome: outcomeOf(existing) };
      throw new PhoneRuleError('outcome_conflict', `call '${call.id}' already has a different outcome`);
    }
    const trust: TrustOrigin = input.source === 'human' ? 'internal' : 'external_untrusted';
    const id = `artifact-${randomUUID()}`;
    tx.run(
      'INSERT INTO call_artifact (id, call_id, kind, content, content_hash, source, trust_origin, created_at, updated_at) VALUES (?, ?, \'outcome\', ?, ?, ?, ?, ?, ?)',
      [id, call.id, content, contentHash(content), input.source, trust, now, now],
    );
    syncCallEvidence(tx, now, call.id);
    return { created: true, outcome: outcomeOf(tx.get<CallArtifactRow>('SELECT * FROM call_artifact WHERE id = ?', [id])!) };
  });
}

function outcomeOf(row: CallArtifactRow): CallOutcome {
  const content = JSON.parse(row.content) as { disposition: string; summary: string; structured_data: Record<string, unknown>; next_action?: string };
  return {
    callId: row.call_id, disposition: content.disposition, summary: content.summary, structuredData: content.structured_data,
    ...(content.next_action === undefined ? {} : { nextAction: content.next_action }), source: row.source, recordedAt: row.updated_at,
  };
}

export function getCallOutcome(db: Db, callId: string): (CallOutcome & { trustOrigin: TrustOrigin }) | null {
  const row = artifactRow(db, callId, 'outcome');
  return row ? { ...outcomeOf(row), trustOrigin: row.trust_origin } : null;
}

export function getTranscript(db: Db, callId: string): Transcript | null {
  const row = artifactRow(db, callId, 'transcript');
  if (!row) return null;
  const content = JSON.parse(row.content) as { turns: TranscriptTurn[]; language?: string };
  return { callId, turns: content.turns, ...(content.language === undefined ? {} : { language: content.language }), createdAt: row.created_at };
}

// ===== 증거 연결 =====
// 업무에 연결된 통화의 기록과 산출물을 evidence 로 남긴다 (trust_origin = external_untrusted: 통화는 상대와 provider 에서 온 데이터다).
// task_run_id 는 NULL 로 둔다: 통화는 run 을 넘어 업무에 속하고(재시도 run 의 평가도 같은 통화를 본다), 평가기는 task_run_id NULL 행도 읽는다.
function syncCallEvidence(tx: Db, now: string, callId: string): void {
  const call = tx.get<CallRow>('SELECT * FROM call WHERE id = ?', [callId]);
  if (!call || call.task_id === null) return;
  const put = (ref: string, kind: 'other' | 'document', hash: string): void => {
    const existing = tx.get<{ id: string; content_hash: string | null }>('SELECT id, content_hash FROM evidence WHERE task_id = ? AND ref = ?', [call.task_id, ref]);
    if (!existing) {
      tx.run(
        "INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, trust_origin, captured_at, verified, verification_note) VALUES (?, ?, NULL, ?, ?, ?, 'external_untrusted', ?, 0, NULL)",
        [`evidence-${randomUUID()}`, call.task_id, kind, ref, hash, now],
      );
    } else if (existing.content_hash !== hash) {
      tx.run('UPDATE evidence SET content_hash = ?, captured_at = ?, verified = 0, verification_note = NULL WHERE id = ?', [hash, now, existing.id]);
    }
  };
  if (!isCallOpen(call.status)) {
    put(`call:${call.id}`, 'other', contentHash({ provider: call.provider, direction: call.direction, status: call.status, connected_at: call.connected_at, ended_at: call.ended_at }));
  }
  for (const kind of ['transcript', 'outcome'] as const) {
    const artifact = artifactRow(tx, call.id, kind);
    if (artifact) put(`call:${call.id}#${kind}`, 'document', artifact.content_hash);
  }
}

// ===== 마감 =====

/** 마감을 넘긴 열린 통화: 최대 통화시간(없으면 `defaultMaxSeconds`) + 유예. 먼저 provider 에 조회(reconcile)한 뒤 `expireCall` 로 닫는다 */
export function overdueOpenCalls(db: Db, clock: Clock, options: { graceMs: number; defaultMaxSeconds: number }): Call[] {
  const nowMs = clock.nowMs();
  return db
    .all<CallRow>("SELECT * FROM call WHERE status NOT IN ('completed','failed','cancelled') ORDER BY created_at, id")
    .filter((row) => {
      const startedMs = Date.parse(row.started_at ?? row.created_at);
      const limitSeconds = row.max_duration_seconds === null ? options.defaultMaxSeconds : Number(row.max_duration_seconds);
      return nowMs > startedMs + limitSeconds * 1000 + options.graceMs;
    })
    .map(callOf);
}

/** 마감을 넘긴 통화를 `failed`(deadline_exceeded)로 닫는다. 이미 닫혔으면 아무것도 하지 않는다 (멱등) */
export function expireCall(db: Db, clock: Clock, callId: string): ApplyResult {
  return applyPhoneEvent(db, clock, {
    type: 'phone.call.failed', eventId: `deadline:${callId}`, provider: AOT_EVENT_PROVIDER, providerCallId: null, callId, occurredAt: clock.nowIso(),
    code: 'deadline_exceeded', reason: 'no terminal event from the provider before the deadline',
  });
}

