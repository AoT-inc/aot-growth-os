// 영업시간 창. 정책(`phone.business_hours`)과 인바운드 라우팅 규칙이 같은 형식을 쓴다.
// 하루 안의 창만 지원한다(자정을 넘는 창은 거부): 규칙을 단순하게 두고 검토를 쉽게 하려는 선택이다.
import { IssueCollector, isPlainObject } from '../validation.ts';

export interface BusinessHours {
  /** IANA 시간대 (예: Asia/Seoul). 필수 — 조용히 UTC 로 가정하지 않는다 */
  tz: string;
  /** 1(월)~7(일) */
  days: number[];
  /** HH:MM (포함) */
  start: string;
  /** HH:MM (미포함) */
  end: string;
}

const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** 형식 검사. 문제는 `out` 에 쌓고 정규화한 값(요일 정렬·중복 제거)을 돌려준다 */
export function checkBusinessHours(value: unknown, path: string, out: IssueCollector): BusinessHours | null {
  if (!isPlainObject(value)) {
    out.add(path, 'type', 'business hours must be a mapping {tz, days, start, end}');
    return null;
  }
  let ok = true;
  for (const key of Object.keys(value)) {
    if (!['tz', 'days', 'start', 'end'].includes(key)) {
      out.add(`${path}.${key}`, 'unknown_key', `unknown key '${key}'`);
      ok = false;
    }
  }
  const tz = value['tz'];
  if (typeof tz !== 'string' || tz === '') {
    out.add(`${path}.tz`, 'required', 'tz is required (an IANA time zone such as Asia/Seoul)');
    ok = false;
  } else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      out.add(`${path}.tz`, 'format', `'${tz}' is not a known IANA time zone`);
      ok = false;
    }
  }
  const days = value['days'];
  if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)) {
    out.add(`${path}.days`, 'range', 'days must be a non-empty list of integers 1 (Mon) to 7 (Sun)');
    ok = false;
  }
  const start = value['start'];
  const end = value['end'];
  if (typeof start !== 'string' || !CLOCK.test(start)) {
    out.add(`${path}.start`, 'format', 'start must be HH:MM');
    ok = false;
  }
  if (typeof end !== 'string' || !CLOCK.test(end)) {
    out.add(`${path}.end`, 'format', 'end must be HH:MM');
    ok = false;
  }
  if (ok && minutesOf(start as string) >= minutesOf(end as string)) {
    out.add(path, 'window', 'start must be before end (a window that crosses midnight is not supported)');
    ok = false;
  }
  if (!ok) return null;
  return { tz: tz as string, days: [...new Set(days as number[])].sort((a, b) => a - b), start: start as string, end: end as string };
}

/** `at` 이 창 안인가 (시간대 벽시계 기준, 시작 포함·끝 미포함) */
export function withinBusinessHours(hours: BusinessHours, at: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: hours.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value ?? ''];
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (weekday === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return false;
  const now = hour * 60 + minute;
  return hours.days.includes(weekday) && now >= minutesOf(hours.start) && now < minutesOf(hours.end);
}
