// 사람이 입력한 측정 값의 신호 조회기 (A6-U13, a0-decisions D2). `EffectSignalSource` 포트 구현이며 읽기 전용이다(쓰기 없음).
//
// 평가 대상 업무의 명세 `inputs[kind=measurement]`(`measurement:<신호 id>@<ISO 주>`)가 가리키는 측정 이벤트(task-engine 의 `recordMeasurement` 가 쓴다)와
// 그 업무에 붙은 근거를 읽어 `EffectSignal` 을 만든다. 측정 입력이 없는 업무는 null(효과 측정 없음, 기존과 같다).
//   - 값: 이벤트의 `value` 1개(1주 = 관측 단위 1, A6 결정 ②). 관측 수: 사람이 밝힌 `observations`. 최소 관측 수·합격선: 신호 정의의 `min_observations`·`pass_threshold`
//   - 데이터 품질: 사람이 밝힌 품질이 `good` 이고, 첨부가 필수인 신호면 이벤트의 첨부 *전부*가 이 업무의 `internal` 근거 행(`document`, `sha256:<해시>`)과
//     측정 근거 행(`measurement`, 같은 키)으로 남아 있을 때만 통과. 아니면 품질 불량 → 평가 inconclusive (기존 평가 규칙 그대로)
//   - 신호 정의가 없거나 이벤트가 없거나 payload 를 읽을 수 없으면 "측정 불가"(inconclusive)
// 에이전트 보고서는 읽지 않는다(evaluation.md §3). 이벤트 형식(source·type·payload 키)은 task-engine measurement.ts 와 같아야 한다 — 패키지 경계상 상수를 가져오지 못하므로
// 여기 다시 적고 시험(evaluation-measurement-source)이 task-engine 의 값과 대조한다.
import {
  isPlainObject, MEASUREMENT_INPUT_KIND, parseMeasurementRef,
  type Db, type MeasurementSignal, type TaskSpec,
} from '@aot/domain';

import type { EffectObservation, EffectSignalSource } from './ports.ts';

export const MEASUREMENT_SOURCE_EVENT = { source: 'measurement', type: 'measurement.recorded' } as const;

export interface MeasurementSignalSourceOptions {
  db: Db;
  /** 측정 신호 정의 (팩의 `measurement-signals/`) */
  signals: readonly MeasurementSignal[];
}

const SHA256 = /^[0-9a-f]{64}$/;

export function createMeasurementSignalSource(options: MeasurementSignalSourceOptions): EffectSignalSource {
  const byId = new Map(options.signals.map((signal) => [signal.id, signal]));
  const { db } = options;
  return {
    read({ taskId }) {
      return Promise.resolve(readObservation(db, byId, taskId));
    },
  };
}

function readObservation(db: Db, signals: ReadonlyMap<string, MeasurementSignal>, taskId: string): EffectObservation | null {
  const task = db.get<{ spec: string }>('SELECT spec FROM task WHERE id = ?', [taskId]);
  if (!task) return null;
  const spec = JSON.parse(task.spec) as Pick<TaskSpec, 'inputs'>;
  const input = (Array.isArray(spec.inputs) ? spec.inputs : []).find((item) => item.kind === MEASUREMENT_INPUT_KIND);
  if (input === undefined) return null;

  const unmeasurable = (reason: string): EffectObservation => ({ measurable: false, reason });
  const parsed = parseMeasurementRef(input.ref);
  if (parsed === null) return unmeasurable(`measurement input '${input.name}' has an unreadable ref '${input.ref}'`);
  const signal = signals.get(parsed.signalId);
  if (signal === undefined) return unmeasurable(`measurement signal '${parsed.signalId}' is not defined`);

  const event = db.get<{ payload: string }>(
    'SELECT payload FROM event WHERE idempotency_key = ? AND source = ? AND type = ?', [input.ref, MEASUREMENT_SOURCE_EVENT.source, MEASUREMENT_SOURCE_EVENT.type],
  );
  if (!event) return unmeasurable(`no value is recorded for ${input.ref}`);
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    return unmeasurable(`the recorded value for ${input.ref} is not readable`);
  }
  if (!isPlainObject(payload)) return unmeasurable(`the recorded value for ${input.ref} is not readable`);
  const value = payload['value'];
  const observations = payload['observations'];
  const quality = payload['data_quality'];
  const attachments = payload['attachments'];
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof observations !== 'number' || !Number.isInteger(observations) || observations < 0
    || (quality !== 'good' && quality !== 'poor') || !Array.isArray(attachments) || payload['signal_id'] !== parsed.signalId || payload['week'] !== parsed.week) {
    return unmeasurable(`the recorded value for ${input.ref} does not have the expected shape`);
  }

  const problems: string[] = [];
  if (quality === 'poor') problems.push('the person who recorded the value marked its data quality as poor');
  if (signal.attachment_required) problems.push(...attachmentProblems(db, taskId, input.ref, attachments));

  return {
    measurable: true,
    signal: {
      name: `${parsed.signalId}@${parsed.week}`,
      values: [value],
      observations,
      minObservations: signal.min_observations,
      dataQualityOk: problems.length === 0,
      ...(problems.length === 0 ? {} : { qualityNote: problems.join('; ') }),
      ...(signal.pass_threshold === undefined ? {} : { passAtLeast: signal.pass_threshold }),
    },
  };
}

/** 첨부가 필수인 신호: 이벤트의 첨부가 하나 이상이고, 전부가 이 업무의 internal 근거로 남아 있어야 한다 */
function attachmentProblems(db: Db, taskId: string, key: string, attachments: readonly unknown[]): string[] {
  const hashes = attachments.map((item) => (isPlainObject(item) && typeof item['sha256'] === 'string' && SHA256.test(item['sha256']) ? item['sha256'] : null));
  if (hashes.length === 0) return ['no attachment (screenshot or export) was recorded with the value'];
  if (hashes.includes(null)) return ['an attachment of the recorded value has no valid sha256'];
  const rows = db.all<{ kind: string; ref: string; content_hash: string | null }>(
    "SELECT kind, ref, content_hash FROM evidence WHERE task_id = ? AND trust_origin = 'internal' AND kind IN ('measurement', 'document')", [taskId],
  );
  const problems: string[] = [];
  if (!rows.some((row) => row.kind === 'measurement' && row.ref === key)) problems.push(`the task has no measurement evidence for ${key}`);
  const documented = new Set(rows.filter((row) => row.kind === 'document').map((row) => row.content_hash));
  const missing = hashes.filter((hash) => !documented.has(`sha256:${hash!}`));
  if (missing.length > 0) problems.push(`${missing.length} attachment(s) of the recorded value have no evidence row on the task`);
  return problems;
}
