// 측정 값 입력과 대기 조건 (A6-U13, a0-decisions D2: 랜딩 1개 주간 전환 수, Phase A 는 사람이 값을 입력하고 근거를 첨부한다).
//
// 입력(`recordMeasurement`, 한 `Db.writeTx`):
//   ① event: source='measurement', type='measurement.recorded', idempotency_key = `measurement:<신호 id>@<ISO 주>` (= 기다리는 업무의 `inputs[].ref`).
//      payload 에 값(단위 없는 수)·관측 수·데이터 품질·측정 구간(그 주의 시작·끝 순간과 tz)·첨부(참조와 sha256)·입력한 사람을 남긴다.
//   ② 그 측정을 기다리는(아직 끝나지 않은) 업무마다 근거: `measurement` 1줄(내용 해시) + 첨부 1줄씩(`document`, 파일 sha256). 모두 trust_origin='internal'
//      (사람이 사람 채널로 넣은 값이다). 파일 내용은 DB 에 넣지 않는다.
//   ③ 분을 주면 `human_time` 비용 1줄(금액 0, units.minutes).
//   같은 키가 다시 오면: 내용(값·관측 수·품질·첨부 해시 집합)이 같으면 아무것도 쓰지 않고 처음 기록을 돌려준다. 다르면 덮어쓰지 않고 거부한다(`conflict`).
//   정정 절차는 아직 없다(phase-a A6-U13 열린 항목).
// 사람만: `actor.kind='human'` 이 아니면 거부한다. 채널 쪽(소켓 권한 + 같은 확인)과 별개로 이 함수가 한 번 더 본다.
//
// 대기 조건: `inputs[kind=measurement]` 의 이벤트가 없으면 `claimNextTask` 가 그 업무를 후보에서 뺀다(SQL 조건이라 다른 업무의 선택을 막지 않는다).
// 상태 전이도 시도 소모도 없다. 이벤트가 생기면 다음 tick 에 집히고, 그때 아직 근거가 붙지 않은 업무(측정 뒤에 만들어진 업무)에 근거를 붙인다.
// 기다리는 업무는 `listMeasurementWaits` 로 사유와 함께 본다.
//
// 주 키: ISO 8601 주(월요일 시작)를 신호 정의의 `tz` 벽시계로 센다. 명세에는 주를 명시한다(`2026-W43`). 입력할 때 주를 생략하면 주입된 Clock 의
// 지금이 속한 주의 *바로 앞 주*(끝난 마지막 주)다. 아직 끝나지 않은 주(구간 끝 > 지금)의 값은 받지 않는다.
import { randomUUID } from 'node:crypto';

import {
  addDays, canonicalJson, isMeasurementSignalId, isNonBlankString, isoWeekKeyOfDate, isoWeekMonday, isPlainObject,
  MEASUREMENT_INPUT_KIND, measurementRef, parseIsoWeekKey, parseMeasurementRef, sha256Hex, validateMeasurementSignal,
  type Clock, type Db, type MeasurementSignal, type TaskSpec,
} from '@aot/domain';

import { MeasurementRefusedError } from './errors.ts';
import { localDateAt, resolveLocal } from './schedule.ts';

export const MEASUREMENT_EVENT_SOURCE = 'measurement';
export const MEASUREMENT_EVENT_TYPE = 'measurement.recorded';
export const DATA_QUALITIES = ['good', 'poor'] as const;
export type DataQuality = (typeof DATA_QUALITIES)[number];
export const MAX_MEASUREMENT_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_REF_CHARS = 1024;

// ===== 주 키 (시간대) =====

/** `utcMs` 순간이 `tz` 벽시계로 속한 ISO 주 */
export const isoWeekKeyAt = (utcMs: number, tz: string): string => isoWeekKeyOfDate(localDateAt(tz, utcMs));

/** `utcMs` 순간이 속한 주의 바로 앞 주 (끝난 마지막 주) */
export const previousIsoWeekKey = (utcMs: number, tz: string): string => isoWeekKeyOfDate(addDays(localDateAt(tz, utcMs), -7));

export interface MeasurementPeriod {
  /** 그 주 월요일 00:00 (`tz` 벽시계)의 순간, UTC ISO */
  start: string;
  /** 다음 주 월요일 00:00 의 순간 (구간은 [start, end)) */
  end: string;
  tz: string;
}

/** ISO 주의 구간. 자정이 건너뛰어지는 시간대는 건너뛴 길이만큼 뒤로 민다(schedule.ts 와 같은 규칙) */
export function isoWeekPeriod(week: string, tz: string): MeasurementPeriod {
  const parsed = parseIsoWeekKey(week);
  if (parsed === null) throw new MeasurementRefusedError('invalid_week', `'${week}' is not an ISO week key (YYYY-Www) of an existing week`);
  const monday = isoWeekMonday(parsed.year, parsed.week);
  const next = addDays(monday, 7);
  const at = (d: { year: number; month: number; day: number }) => new Date(resolveLocal(tz, Date.UTC(d.year, d.month - 1, d.day))).toISOString();
  return { start: at(monday), end: at(next), tz };
}

// ===== 입력 =====

export interface MeasurementAttachment {
  /** 로컬 참조 (예: `file:<절대 경로>`). 파일 내용은 저장하지 않는다 */
  ref: string;
  /** 파일 내용의 sha256 (소문자 16진 64자) */
  sha256: string;
}

export interface RecordMeasurementInput {
  /** 값을 넣는 사람. `actor.kind='human'` 이어야 한다 */
  actorId: string;
  /** 측정 신호 정의 (팩의 `measurement-signals/<id>.json`, validateMeasurementSignal 형식) */
  signal: MeasurementSignal;
  /** ISO 주 키 (`YYYY-Www`). 생략하면 지금(Clock)이 속한 주의 바로 앞 주 */
  week?: string;
  /** 값 (단위 없는 수, 0 이상) */
  value: number;
  /** 이 값의 관측 수 (정수 ≥ 0). 신호의 `min_observations` 와 비교된다 */
  observations: number;
  quality: DataQuality;
  attachments: readonly MeasurementAttachment[];
  /** 입력에 든 사람 시간(분). 주면 `human_time` 비용 1줄 */
  minutes?: number;
}

export interface RecordMeasurementResult {
  /** false 면 같은 신호·주의 같은 값이 이미 있어 아무것도 쓰지 않았다 */
  created: boolean;
  eventId: string;
  /** `measurement:<신호 id>@<주>` (= event.idempotency_key = 기다리는 업무의 inputs[].ref) */
  key: string;
  week: string;
  period: MeasurementPeriod;
  /** 이번 호출로 근거를 붙인 업무 */
  attachedTo: string[];
  /** 기록한 human_time 비용 줄 (분을 주지 않았거나 created=false 면 null) */
  costEntryId: string | null;
}

/** 저장된 측정 이벤트의 payload */
export interface MeasurementPayload {
  signal_id: string;
  page_ref: string;
  action: string;
  week: string;
  period: MeasurementPeriod;
  value: number;
  observations: number;
  data_quality: DataQuality;
  attachments: MeasurementAttachment[];
  recorded_by: string;
}

export interface MeasurementContext {
  clock: Clock;
  newId?: () => string;
}

const SHA256 = /^[0-9a-f]{64}$/;
// 참조는 한 줄짜리 식별자다: 제어 문자(줄바꿈 포함)를 받지 않는다
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const refuse = (code: string, message: string): never => {
  throw new MeasurementRefusedError(code, message);
};

/** 값이 같은지 비교하는 내용 해시: 값·관측 수·품질·첨부 해시 집합 (첨부 참조 문자열·입력한 사람·분은 넣지 않는다) */
export function measurementContentHash(payload: Pick<MeasurementPayload, 'signal_id' | 'week' | 'value' | 'observations' | 'data_quality' | 'attachments'>): string {
  return sha256Hex(canonicalJson({
    signal_id: payload.signal_id, week: payload.week, value: payload.value, observations: payload.observations, data_quality: payload.data_quality,
    attachments: [...new Set(payload.attachments.map((a) => a.sha256))].sort(),
  }));
}

function checkInput(input: RecordMeasurementInput): { signal: MeasurementSignal; attachments: MeasurementAttachment[] } {
  const checked = validateMeasurementSignal(input.signal);
  if (!checked.ok) refuse('invalid_signal', `the signal definition is invalid: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  const signal = input.signal;
  if (!isMeasurementSignalId(signal.id)) refuse('invalid_signal', `signal id '${signal.id}' is too long`);
  if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0) refuse('invalid_value', 'value must be a finite number >= 0 (unitless)');
  if (typeof input.observations !== 'number' || !Number.isInteger(input.observations) || input.observations < 0) {
    refuse('invalid_observations', 'observations must be an integer >= 0');
  }
  if (!(DATA_QUALITIES as readonly unknown[]).includes(input.quality)) refuse('invalid_quality', `quality must be one of ${DATA_QUALITIES.join('|')}`);
  if (input.minutes !== undefined && (typeof input.minutes !== 'number' || !Number.isFinite(input.minutes) || input.minutes < 0)) {
    refuse('invalid_minutes', 'minutes must be a finite number >= 0');
  }
  if (!Array.isArray(input.attachments)) refuse('invalid_attachment', 'attachments must be an array');
  if (signal.attachment_required && input.attachments.length === 0) {
    refuse('attachment_required', `signal '${signal.id}' requires an attached evidence (a screenshot or an export file) for every value`);
  }
  if (input.attachments.length > MAX_MEASUREMENT_ATTACHMENTS) refuse('invalid_attachment', `at most ${MAX_MEASUREMENT_ATTACHMENTS} attachments`);
  const bySha = new Map<string, MeasurementAttachment>();
  for (const item of input.attachments as unknown[]) {
    if (!isPlainObject(item)) return refuse('invalid_attachment', 'each attachment must be {ref, sha256}');
    const ref = item['ref'];
    const sha = item['sha256'];
    if (!isNonBlankString(ref) || ref.length > MAX_ATTACHMENT_REF_CHARS || CONTROL.test(ref)) {
      refuse('invalid_attachment', `an attachment ref must be a single-line string of at most ${MAX_ATTACHMENT_REF_CHARS} characters`);
    }
    if (typeof sha !== 'string' || !SHA256.test(sha)) refuse('invalid_attachment', 'an attachment sha256 must be 64 lowercase hex characters');
    // 같은 파일(같은 해시)을 두 번 붙이면 하나로 본다
    if (!bySha.has(sha as string)) bySha.set(sha as string, { ref: ref as string, sha256: sha as string });
  }
  return { signal, attachments: [...bySha.values()] };
}

function requireHumanActor(tx: Db, actorId: unknown): void {
  if (!isNonBlankString(actorId)) refuse('unknown_actor', 'an actor id is required');
  const actor = tx.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId as string]);
  if (!actor) refuse('unknown_actor', `unknown actor '${String(actorId)}'`);
  if (actor!.kind !== 'human') refuse('not_human', `only human actors can record measurements; '${String(actorId)}' is '${actor!.kind}'`);
}

/** 측정 이벤트 하나를 읽는다 (없으면 null) */
export function findMeasurement(db: Db, key: string): { eventId: string; payload: MeasurementPayload } | null {
  const row = db.get<{ id: string; payload: string }>(
    'SELECT id, payload FROM event WHERE idempotency_key = ? AND source = ? AND type = ?', [key, MEASUREMENT_EVENT_SOURCE, MEASUREMENT_EVENT_TYPE],
  );
  if (!row) return null;
  return { eventId: row.id, payload: JSON.parse(row.payload) as MeasurementPayload };
}

/**
 * 측정 값 하나를 기록한다. 같은 신호·주의 같은 내용이면 아무것도 쓰지 않고(`created: false`), 다른 내용이면 `conflict` 로 거부한다.
 * 거부는 모두 `MeasurementRefusedError`(사유 코드)다.
 */
export function recordMeasurement(db: Db, context: MeasurementContext, input: RecordMeasurementInput): RecordMeasurementResult {
  const { signal, attachments } = checkInput(input);
  const newId = context.newId ?? (() => randomUUID());
  return db.writeTx((tx) => {
    requireHumanActor(tx, input.actorId);
    const nowMs = context.clock.nowMs();
    const now = context.clock.nowIso();
    const week = input.week ?? previousIsoWeekKey(nowMs, signal.tz);
    const period = isoWeekPeriod(week, signal.tz);
    if (Date.parse(period.end) > nowMs) {
      refuse('week_not_ended', `week ${week} (${signal.tz}) ends at ${period.end}; a value can be recorded only after the week has ended`);
    }
    const key = measurementRef(signal.id, week);
    const payload: MeasurementPayload = {
      signal_id: signal.id, page_ref: signal.page_ref, action: signal.action, week, period,
      value: input.value, observations: input.observations, data_quality: input.quality, attachments, recorded_by: input.actorId,
    };

    const existing = findMeasurement(tx, key);
    if (existing) {
      if (measurementContentHash(existing.payload) !== measurementContentHash(payload)) {
        refuse('conflict', `a different value is already recorded for ${key} (value ${existing.payload.value}, observations ${existing.payload.observations}, quality ${existing.payload.data_quality}); it is not overwritten — a correction procedure is not defined yet`);
      }
      return { created: false, eventId: existing.eventId, key, week, period: existing.payload.period, attachedTo: [], costEntryId: null };
    }
    if (tx.get('SELECT 1 AS one FROM event WHERE idempotency_key = ?', [key])) {
      refuse('conflict', `the key ${key} is already used by an event that is not a recorded measurement`);
    }

    const eventId = `event-${newId()}`;
    tx.run(
      `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [eventId, MEASUREMENT_EVENT_SOURCE, `${signal.id}@${week}`, MEASUREMENT_EVENT_TYPE, JSON.stringify(payload), key, period.end, now],
    );
    const waiting = tasksAwaiting(tx, key);
    const attachedTo = waiting.filter((task) => attachEvidence(tx, task.id, { eventId, payload }, now, newId)).map((task) => task.id);

    let costEntryId: string | null = null;
    if (input.minutes !== undefined) {
      // 사람 시간은 한 번만 센다: 기다리는 업무가 여럿이면 가장 먼저 만든 업무에, 없으면 업무 없이(units 로 추적) 남긴다
      const owner = waiting[0] ?? null;
      costEntryId = `cost-${newId()}`;
      tx.run(
        "INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES (?, ?, NULL, ?, 'human_time', 0, ?, ?)",
        [costEntryId, owner?.id ?? null, owner?.product_id ?? null, JSON.stringify({ minutes: input.minutes, source: 'measurement', event_id: eventId, measurement: key }), now],
      );
    }
    return { created: true, eventId, key, week, period, attachedTo, costEntryId };
  });
}

/** 이 측정을 입력으로 가진, 아직 끝나지 않은 업무 (만든 순서) */
function tasksAwaiting(tx: Db, key: string): { id: string; product_id: string | null }[] {
  return tx.all<{ id: string; product_id: string | null }>(
    `SELECT t.id, t.product_id FROM task t
     WHERE t.status NOT IN ('completed', 'failed', 'cancelled')
       AND EXISTS (SELECT 1 FROM json_each(t.spec, '$.inputs') i WHERE json_extract(i.value, '$.kind') = ? AND json_extract(i.value, '$.ref') = ?)
     ORDER BY t.created_at, t.rowid`,
    [MEASUREMENT_INPUT_KIND, key],
  );
}

/**
 * 업무에 측정 근거를 붙인다 (이미 붙어 있으면 아무것도 하지 않고 false). 측정 1줄 + 첨부마다 1줄, 모두 internal.
 * 첨부 줄의 `content_hash` 는 `sha256:<파일 해시>` 이며 신호 조회기(evaluation)가 이벤트의 첨부와 대조한다.
 */
function attachEvidence(tx: Db, taskId: string, measurement: { eventId: string; payload: MeasurementPayload }, now: string, newId: () => string): boolean {
  const key = measurementRef(measurement.payload.signal_id, measurement.payload.week);
  if (tx.get("SELECT 1 AS one FROM evidence WHERE task_id = ? AND kind = 'measurement' AND ref = ?", [taskId, key])) return false;
  const insert = (kind: 'measurement' | 'document', ref: string, hash: string, note: string) => tx.run(
    "INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, trust_origin, captured_at, verification_note) VALUES (?, ?, NULL, ?, ?, ?, 'internal', ?, ?)",
    [`ev-${newId()}`, taskId, kind, ref, hash, now, note],
  );
  insert('measurement', key, `sha256:${measurementContentHash(measurement.payload)}`, `recorded by ${measurement.payload.recorded_by} (event ${measurement.eventId})`);
  for (const attachment of measurement.payload.attachments) {
    insert('document', attachment.ref, `sha256:${attachment.sha256}`, `attachment of ${key}`);
  }
  return true;
}

// ===== 대기 조건 =====

/** 명세의 측정 입력 (없으면 빈 목록) */
export const measurementInputsOf = (spec: Pick<TaskSpec, 'inputs'>) =>
  (Array.isArray(spec.inputs) ? spec.inputs : []).filter((input) => input.kind === MEASUREMENT_INPUT_KIND);

/**
 * `claimNextTask` 의 후보 조건(SQL, 업무 별칭 `t`): 측정 입력이 모두 기록된 업무만. 측정이 없는 업무는 후보에서 빠질 뿐 상태가 바뀌지 않는다.
 * LIMIT 앞의 WHERE 에 있으므로 기다리는 업무가 많아도 다른 업무의 선택을 막지 않는다.
 */
export const MEASUREMENTS_RECORDED_SQL = `NOT EXISTS (
  SELECT 1 FROM json_each(t.spec, '$.inputs') mi
  WHERE json_extract(mi.value, '$.kind') = '${MEASUREMENT_INPUT_KIND}'
    AND NOT EXISTS (SELECT 1 FROM event me WHERE me.idempotency_key = json_extract(mi.value, '$.ref')
                    AND me.source = '${MEASUREMENT_EVENT_SOURCE}' AND me.type = '${MEASUREMENT_EVENT_TYPE}'))`;

/** claim 직전: 측정 뒤에 만들어진 업무처럼 아직 근거가 없으면 붙인다 (쓰기 트랜잭션 안) */
export function attachRecordedMeasurements(tx: Db, taskId: string, spec: Pick<TaskSpec, 'inputs'>, now: string): void {
  for (const input of measurementInputsOf(spec)) {
    const found = findMeasurement(tx, input.ref);
    if (found) attachEvidence(tx, taskId, found, now, () => randomUUID());
  }
}

export interface MeasurementWait {
  taskId: string;
  /** 명세 `inputs[].name` */
  input: string;
  ref: string;
  signalId: string | null;
  week: string | null;
  /** 업무를 만든 시각 */
  since: string;
  reason: string;
}

/** 측정 값을 기다리느라 집히지 않는 `queued` 업무 (만든 순서). 사유를 함께 돌려준다 */
export function listMeasurementWaits(db: Db): MeasurementWait[] {
  const rows = db.all<{ id: string; created_at: string; name: string; ref: string }>(
    `SELECT t.id, t.created_at, json_extract(mi.value, '$.name') AS name, json_extract(mi.value, '$.ref') AS ref
     FROM task t, json_each(t.spec, '$.inputs') mi
     WHERE t.status = 'queued' AND json_extract(mi.value, '$.kind') = ?
       AND NOT EXISTS (SELECT 1 FROM event me WHERE me.idempotency_key = json_extract(mi.value, '$.ref') AND me.source = ? AND me.type = ?)
     ORDER BY t.created_at, t.rowid`,
    [MEASUREMENT_INPUT_KIND, MEASUREMENT_EVENT_SOURCE, MEASUREMENT_EVENT_TYPE],
  );
  return rows.map((row) => {
    const parsed = parseMeasurementRef(row.ref);
    return {
      taskId: row.id, input: row.name, ref: row.ref, signalId: parsed?.signalId ?? null, week: parsed?.week ?? null, since: row.created_at,
      reason: parsed === null
        ? `measurement_pending: input '${row.name}' has an unreadable ref '${row.ref}'`
        : `measurement_pending: input '${row.name}' waits for a human to record signal '${parsed.signalId}' for ${parsed.week}`,
    };
  });
}

