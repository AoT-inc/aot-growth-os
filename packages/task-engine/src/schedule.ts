// 루틴 발화 시각 계산 (A6-U9). 순수 함수만 있다: 시계를 읽지 않는다 (시각은 인자로 받은 에포크 밀리초).
// 외부 의존성 없이 Intl.DateTimeFormat 으로 IANA 시간대를 처리한다.
//
// `routine.schedule` 형식 (schema.sql 은 "cron + tz" 한 열이라고만 적는다. 이 형식이 그 정의다):
//   `<분> <시> <일> <월> <요일> <IANA tz>`  — 공백으로 나뉜 6개 토큰, 마지막이 시간대. 예: `0 9 * * 1 Asia/Seoul`
//   - 시간대는 필수다 (없으면 거부; 조용히 UTC 로 가정하지 않는다). IANA 이름만 받는다 (`+09:00` 같은 오프셋 거부).
//   - 각 필드: `*`, 숫자, 목록(`1,15`), 범위(`1-5`), 간격(`*/15`, `10-40/10`). 이것만 지원한다.
//   - 범위: 분 0-59, 시 0-23, 일 1-31, 월 1-12 (또는 JAN-DEC), 요일 0-7 (0 과 7 은 일요일, 또는 SUN-SAT). 이름은 대소문자 무시, 단독 값·목록·범위 끝점에 쓸 수 있다.
//   - 구현하지 않음(거부): `?`, `L`, `W`, `#`, `@daily` 같은 별칭, 6~7필드(초·연도) 형식.
//   - 일과 요일을 둘 다 제한하면(둘 다 `*` 로 시작하지 않으면) 표준 cron 처럼 "둘 중 하나라도 맞으면" 발화한다.
//
// 시간대 경계 규칙 (벽시계 시각 → 순간):
//   - 존재하지 않는 시각(봄 전환의 건너뛴 구간, 예: 뉴욕 2026-03-08 02:30): 전환 *전* 오프셋으로 계산해 건너뛴 길이만큼 뒤로 민다
//     (02:30 EST = 07:30Z = 03:30 EDT). 밀린 순간이 다른 슬롯과 겹치면 하나로 합친다.
//   - 두 번 나타나는 시각(가을 전환의 겹친 구간, 예: 뉴욕 2026-11-01 01:30): *앞선* 쪽 한 번만 발화한다 (뒤의 01:30 EST 는 슬롯이 아니다).
//   슬롯은 항상 "벽시계 시각 하나당 순간 하나"다. 같은 순간으로 모이는 슬롯은 중복 없이 한 번만 나온다.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** 슬롯이 없는 일정(예: 2월 30일)을 찾을 때 훑는 최대 일수 (윤일 주기 8년을 덮는다) */
const SEARCH_LIMIT_DAYS = 366 * 9;
/** `slotsBetween` 의 기본 상한 */
export const DEFAULT_SLOT_LIMIT = 10_000;

/** 잘못된 일정 문자열 또는 시간대. `reason` 은 어디가 왜 틀렸는지 설명한다. */
export class ScheduleError extends Error {
  readonly reason: string;
  readonly source: string;

  constructor(source: string, reason: string) {
    super(`invalid schedule '${source}': ${reason}`);
    this.name = 'ScheduleError';
    this.reason = reason;
    this.source = source;
  }
}

export interface CronSchedule {
  /** 원문 */
  readonly source: string;
  readonly tz: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0(일)-6(토) */
  readonly daysOfWeek: ReadonlySet<number>;
  /** 일 필드가 `*` 로 시작하는가 (요일과의 결합 규칙에 쓴다) */
  readonly dayOfMonthWild: boolean;
  readonly dayOfWeekWild: boolean;
}

interface FieldSpec { name: string; min: number; max: number; names?: readonly string[]; nameBase?: number }

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: 'day-of-week', min: 0, max: 7, names: WEEKDAY_NAMES, nameBase: 0 },
];

function parseValue(source: string, field: FieldSpec, text: string): number {
  const upper = text.toUpperCase();
  const named = field.names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + (field.nameBase ?? 0);
  if (!/^\d+$/.test(text)) throw new ScheduleError(source, `${field.name}: '${text}' is not a number${field.names ? ' or name' : ''}`);
  const value = Number(text);
  if (value < field.min || value > field.max) throw new ScheduleError(source, `${field.name}: ${value} is out of range ${field.min}-${field.max}`);
  return value;
}

function parseField(source: string, field: FieldSpec, text: string): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    if (item === '') throw new ScheduleError(source, `${field.name}: empty list item in '${text}'`);
    const [rangePart, stepPart, extra] = item.split('/');
    if (extra !== undefined) throw new ScheduleError(source, `${field.name}: more than one '/' in '${item}'`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new ScheduleError(source, `${field.name}: step '${stepPart}' must be a positive integer`);
      step = Number(stepPart);
    }
    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = field.min;
      to = field.name === 'day-of-week' ? 6 : field.max;
    } else if (rangePart!.includes('-')) {
      const bounds = rangePart!.split('-');
      if (bounds.length !== 2) throw new ScheduleError(source, `${field.name}: malformed range '${rangePart}'`);
      from = parseValue(source, field, bounds[0]!);
      to = parseValue(source, field, bounds[1]!);
      if (from > to) throw new ScheduleError(source, `${field.name}: range '${rangePart}' is reversed`);
    } else {
      from = parseValue(source, field, rangePart!);
      // `5/15` 같은 "시작/간격" 은 지원하지 않는다 (cron 구현마다 뜻이 다르다)
      if (stepPart !== undefined) throw new ScheduleError(source, `${field.name}: a step needs '*' or a range ('${item}')`);
      to = from;
    }
    for (let v = from; v <= to; v += step) values.add(field.name === 'day-of-week' && v === 7 ? 0 : v);
  }
  return values;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, formatter);
  }
  return formatter;
}

function checkTimeZone(source: string, tz: string): void {
  // IANA 이름만: 영문자로 시작하고 `/` 로 지역을 나눈다. 오프셋(`+09:00`)과 약어 외의 형태는 Intl 이 받아도 거부한다.
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) throw new ScheduleError(source, `time zone '${tz}' is not an IANA zone name`);
  try {
    formatterFor(tz);
  } catch {
    throw new ScheduleError(source, `time zone '${tz}' is unknown`);
  }
}

/** `routine.schedule` 를 해석한다. 잘못되면 `ScheduleError`(사유 포함). */
export function parseSchedule(text: string): CronSchedule {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length === 5) throw new ScheduleError(text, 'time zone is required as the 6th token (e.g. "0 9 * * 1 Asia/Seoul")');
  if (tokens.length !== 6) throw new ScheduleError(text, `expected 6 space-separated tokens (5 cron fields + IANA time zone), got ${tokens.length === 1 && tokens[0] === '' ? 0 : tokens.length}`);
  const tz = tokens[5]!;
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = FIELDS.map((field, i) => parseField(text, field, tokens[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  checkTimeZone(text, tz);
  return {
    source: text, tz,
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    daysOfMonth, months, daysOfWeek,
    dayOfMonthWild: tokens[2]!.startsWith('*'),
    dayOfWeekWild: tokens[4]!.startsWith('*'),
  };
}

// ===== 시간대 산술 =====

interface LocalFields { year: number; month: number; day: number }

/** `utcMs` 순간의 (벽시계 - UTC) 밀리초. 예: 서울 +32,400,000 */
function offsetAt(tz: string, utcMs: number): number {
  const seconds = Math.floor(utcMs / 1000) * 1000;
  const part: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(seconds))) {
    if (p.type !== 'literal') part[p.type] = Number(p.value);
  }
  return Date.UTC(part['year']!, part['month']! - 1, part['day']!, part['hour']!, part['minute']!, part['second']!) - seconds;
}

function localDateAt(tz: string, utcMs: number): LocalFields {
  const local = new Date(utcMs + offsetAt(tz, utcMs));
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

/** 벽시계 시각(`naive` = 그 시각을 UTC 로 읽은 밀리초) → 순간. 건너뛴 시각은 뒤로 밀고, 겹친 시각은 앞선 쪽을 고른다. */
function resolveLocal(tz: string, naive: number): number {
  const before = offsetAt(tz, naive - DAY_MS);
  const after = offsetAt(tz, naive + DAY_MS);
  const valid = [...new Set([before, after])].map((offset) => naive - offset).filter((instant) => offsetAt(tz, instant) === naive - instant);
  if (valid.length > 0) return Math.min(...valid);
  return naive - before;
}

function dayMatches(schedule: CronSchedule, year: number, month: number, day: number): boolean {
  if (!schedule.months.has(month)) return false;
  const domMatch = schedule.daysOfMonth.has(day);
  const dowMatch = schedule.daysOfWeek.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (!schedule.dayOfMonthWild && !schedule.dayOfWeekWild) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** 벽시계 날짜 하나의 슬롯 (순간, 오름차순, 중복 없음). `dayIndex` 는 1970-01-01 부터 센 날수 */
function slotsOnDay(schedule: CronSchedule, dayIndex: number): number[] {
  const date = new Date(dayIndex * DAY_MS);
  if (!dayMatches(schedule, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())) return [];
  const instants = new Set<number>();
  for (const hour of schedule.hours) {
    for (const minute of schedule.minutes) {
      instants.add(resolveLocal(schedule.tz, dayIndex * DAY_MS + hour * 60 * MINUTE_MS + minute * MINUTE_MS));
    }
  }
  return [...instants].sort((a, b) => a - b);
}

const dayIndexOf = (fields: LocalFields): number => Math.floor(Date.UTC(fields.year, fields.month - 1, fields.day) / DAY_MS);

/** (after, until] 의 모든 슬롯 중 앞에서부터 `limit` 개. 벽시계 날짜는 한 칸씩 넉넉히 훑는다 (전환으로 슬롯이 하루 밀릴 수 있다). */
export function slotsBetween(schedule: CronSchedule, afterMs: number, untilMs: number, limit: number = DEFAULT_SLOT_LIMIT): number[] {
  const slots: number[] = [];
  if (untilMs <= afterMs) return slots;
  const last = dayIndexOf(localDateAt(schedule.tz, untilMs)) + 1;
  for (let day = dayIndexOf(localDateAt(schedule.tz, afterMs)) - 1; day <= last; day += 1) {
    for (const slot of slotsOnDay(schedule, day)) {
      if (slot > afterMs && slot <= untilMs) {
        slots.push(slot);
        if (slots.length >= limit) return slots.sort((a, b) => a - b);
      }
    }
  }
  return slots.sort((a, b) => a - b);
}

/** `afterMs` *보다 뒤*인 첫 슬롯. 앞으로 약 9년 안에 슬롯이 없으면(예: 2월 30일) null. */
export function nextSlot(schedule: CronSchedule, afterMs: number): number | null {
  const start = dayIndexOf(localDateAt(schedule.tz, afterMs)) - 1;
  for (let day = start; day <= start + SEARCH_LIMIT_DAYS; day += 1) {
    const found = slotsOnDay(schedule, day).find((slot) => slot > afterMs);
    if (found !== undefined) return found;
  }
  return null;
}

/** (after, until] 에서 가장 늦은 슬롯. 뒤에서부터 훑으므로 오래 멈췄다 와도 싸다. 없으면 null. */
export function latestSlot(schedule: CronSchedule, afterMs: number, untilMs: number): number | null {
  if (untilMs <= afterMs) return null;
  const first = dayIndexOf(localDateAt(schedule.tz, afterMs)) - 1;
  const start = dayIndexOf(localDateAt(schedule.tz, untilMs)) + 1;
  for (let day = start; day >= first && start - day <= SEARCH_LIMIT_DAYS; day -= 1) {
    const slots = slotsOnDay(schedule, day).filter((slot) => slot > afterMs && slot <= untilMs);
    if (slots.length > 0) return slots[slots.length - 1]!;
  }
  return null;
}

// ===== catch_up =====

export type CatchUpPolicy = 'skip' | 'run_once';

export interface FirePlanInput {
  schedule: CronSchedule;
  catchUp: CatchUpPolicy;
  /** 이 순간 *뒤*의 슬롯부터 본다: 마지막 발화의 `scheduled_for`, 발화가 없으면 루틴을 처음 본 시각 */
  afterMs: number;
  nowMs: number;
  /** 이 시간 안에 도래한 슬롯은 "늦지 않았다". 이보다 오래된 미발화 슬롯이 "놓친" 슬롯이다 */
  lateToleranceMs: number;
}

/**
 * `(afterMs, nowMs]` 에서 지금 발화할 슬롯 (UTC ISO, 오름차순). `catch_up` 의 뜻:
 *  - `skip`:     놓친 슬롯은 버리고, 늦지 않은 슬롯(`nowMs - lateToleranceMs` 이후)만 발화한다. 다음 슬롯부터 정상 진행.
 *  - `run_once`: 놓친 것을 포함해 *가장 최근* 슬롯 1개만 발화한다. 나머지 놓친 슬롯은 버린다.
 * 버려진 슬롯은 기록하지 않는다 (`routine_firing` 은 발화한 것만 담는다). 다음 발화가 기준점을 앞으로 옮긴다.
 */
export function planFirings(input: FirePlanInput): string[] {
  const { schedule, catchUp, afterMs, nowMs, lateToleranceMs } = input;
  let fire: number[];
  if (catchUp === 'run_once') {
    const latest = latestSlot(schedule, afterMs, nowMs);
    fire = latest === null ? [] : [latest];
  } else {
    fire = slotsBetween(schedule, Math.max(afterMs, nowMs - lateToleranceMs), nowMs);
  }
  return fire.map((slot) => new Date(slot).toISOString());
}

/** `planFirings` 가 발화하지 않고 버리는 슬롯 (UTC ISO, 오름차순, 상한 `DEFAULT_SLOT_LIMIT`). 보고·시험용이며 tick 은 부르지 않는다. */
export function missedSlots(input: FirePlanInput): string[] {
  const fired = new Set(planFirings(input));
  return slotsBetween(input.schedule, input.afterMs, input.nowMs).map((slot) => new Date(slot).toISOString()).filter((iso) => !fired.has(iso));
}
