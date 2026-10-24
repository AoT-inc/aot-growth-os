// 측정 값 입력 채널 (A6-U13): 사람 승인 채널(Unix 소켓, trust-boundaries §3.1)에 얹은 `measure`·`measurements` 명령.
// 소켓 처리기 조합(assemble.ts)이 이 두 명령만 여기로 보내고 나머지는 승인 엔진(`engine.handle`)으로 넘긴다.
//
// 인증 경계: 승인 CLI 와 같다 — 소켓 파일 권한(0700 디렉터리 + 0600 소켓, 다른 UID 는 접속 불가)과 요청의 actor 가 `actor.kind='human'` 인지 확인.
// TOTP 재인증은 요구하지 않는다: 값 입력은 외부 부작용도 정책 변경도 아니므로 사람 1인 확인으로 충분하다(A6 결정). 에이전트는 컨테이너 안에서 돌며 소켓이 보이지 않는다(Q26).
// 사람 actor 확인은 task-engine 의 `recordMeasurement` 가 한 번 더 한다(에이전트 actor 면 거부).
//
// 요청 (한 줄 JSON):
//   {cmd:'measure', actor, signal, value, observations, quality:'good'|'poor', attachments:[{ref, sha256}], week?:'YYYY-Www', minutes?}
//   {cmd:'measurements', actor}   → 측정을 기다리는 업무(사유 포함)와 정의된 신호
// 첨부 파일은 CLI 가 읽어 sha256 과 로컬 참조(`file:<절대 경로>`)만 보낸다. 데몬은 파일을 읽지 않고 내용도 DB 에 넣지 않는다.
import type { Clock, Db, MeasurementSignal } from '@aot/domain';
import { listMeasurementWaits, MeasurementRefusedError, recordMeasurement, type DataQuality, type MeasurementAttachment } from '@aot/task-engine';

export const MEASUREMENT_COMMANDS = ['measure', 'measurements'] as const;

export interface MeasurementChannelOptions {
  db: Db;
  clock: Clock;
  signals: readonly MeasurementSignal[];
}

/** 이 요청이 측정 명령인가 (소켓 처리기 조합이 고르는 기준) */
export function isMeasurementCommand(request: unknown): boolean {
  return typeof request === 'object' && request !== null && !Array.isArray(request)
    && (MEASUREMENT_COMMANDS as readonly unknown[]).includes((request as Record<string, unknown>)['cmd']);
}

class Refused extends Error {}

const refuse = (message: string): never => {
  throw new Refused(message);
};

function requireHuman(db: Db, actorId: unknown): string {
  if (typeof actorId !== 'string' || actorId === '') refuse('an actor id is required');
  const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId as string]);
  if (!actor) refuse(`unknown actor '${String(actorId)}'`);
  if (actor!.kind !== 'human') refuse(`only human actors can use the measurement channel; '${String(actorId)}' is '${actor!.kind}'`);
  return actorId as string;
}

const KEYS = ['cmd', 'actor', 'signal', 'value', 'observations', 'quality', 'attachments', 'week', 'minutes'];

export function createMeasurementHandler(options: MeasurementChannelOptions): (request: unknown) => Record<string, unknown> {
  const signals = new Map(options.signals.map((signal) => [signal.id, signal]));
  return (raw) => {
    try {
      const request = raw as Record<string, unknown>;
      const actor = requireHuman(options.db, request['actor']);
      if (request['cmd'] === 'measurements') {
        return {
          ok: true,
          waiting: listMeasurementWaits(options.db),
          signals: [...signals.values()].map((signal) => ({ id: signal.id, tz: signal.tz, min_observations: signal.min_observations })),
        };
      }
      const unknown = Object.keys(request).filter((key) => !KEYS.includes(key));
      if (unknown.length > 0) refuse(`unknown field(s): ${unknown.join(', ')}`);
      const signalId = request['signal'];
      if (typeof signalId !== 'string') refuse('signal (a measurement signal id) is required');
      const signal = signals.get(signalId as string) ?? refuse(`unknown measurement signal '${String(signalId)}'`);
      const week = request['week'];
      if (week !== undefined && typeof week !== 'string') refuse('week must be an ISO week key (YYYY-Www)');
      const minutes = request['minutes'];
      const result = recordMeasurement(options.db, { clock: options.clock }, {
        actorId: actor,
        signal,
        ...(week === undefined ? {} : { week: week as string }),
        value: request['value'] as number,
        observations: request['observations'] as number,
        quality: request['quality'] as DataQuality,
        attachments: (request['attachments'] ?? []) as MeasurementAttachment[],
        ...(minutes === undefined ? {} : { minutes: minutes as number }),
      });
      return {
        ok: true, created: result.created, event_id: result.eventId, key: result.key, week: result.week, period: result.period,
        attached_to: result.attachedTo, cost_entry_id: result.costEntryId,
      };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, error: error.message };
      if (error instanceof MeasurementRefusedError) return { ok: false, error: error.message, code: error.code };
      throw error;
    }
  };
}
