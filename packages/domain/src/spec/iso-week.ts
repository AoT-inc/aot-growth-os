// ISO 8601 주 키 (`YYYY-Www`, A6-U13). 순수 달력 계산이며 시간대는 다루지 않는다: 벽시계 날짜 → 주 키, 주 키 → 그 주 월요일의 날짜.
// 순간(UTC) ↔ 벽시계 날짜 변환은 시간대가 필요하므로 task-engine(measurement.ts)이 맡는다.
// 규칙: 주는 월요일에 시작하고, 그 해의 첫 목요일이 든 주가 W01 이다. 12월 28일이 든 주가 그 해의 마지막 주(52 또는 53)다.

export interface CalendarDate { year: number; month: number; day: number }

const ISO_WEEK_KEY = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86_400_000;

/** 1970-01-01 부터 센 날수 */
const dayIndex = (date: CalendarDate): number => Math.floor(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
/** 월=1 … 일=7 */
const isoWeekday = (index: number): number => ((new Date(index * DAY_MS).getUTCDay() + 6) % 7) + 1;

/** 그 해의 ISO 주 수 (52 또는 53) */
export function isoWeeksInYear(year: number): number {
  return isoWeekOf({ year, month: 12, day: 28 }).week;
}

/** 벽시계 날짜가 속한 ISO 주 (연도는 ISO 주 연도라 1월 초·12월 말에는 달력 연도와 다를 수 있다) */
export function isoWeekOf(date: CalendarDate): { year: number; week: number } {
  const index = dayIndex(date);
  const thursday = index - isoWeekday(index) + 4; // 같은 주의 목요일이 주 연도를 정한다
  const year = new Date(thursday * DAY_MS).getUTCFullYear();
  const firstDay = dayIndex({ year, month: 1, day: 1 });
  return { year, week: Math.floor((thursday - firstDay) / 7) + 1 };
}

export const formatIsoWeekKey = (year: number, week: number): string => `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;

/** 벽시계 날짜 → `YYYY-Www` */
export const isoWeekKeyOfDate = (date: CalendarDate): string => {
  const { year, week } = isoWeekOf(date);
  return formatIsoWeekKey(year, week);
};

/** `YYYY-Www` 를 읽는다. 형식이 틀리거나 그 해에 없는 주(W00, W54, 52주인 해의 W53)면 null */
export function parseIsoWeekKey(key: string): { year: number; week: number } | null {
  const match = ISO_WEEK_KEY.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < 1970 || week < 1 || week > isoWeeksInYear(year)) return null;
  return { year, week };
}

/** ISO 주의 월요일 날짜 */
export function isoWeekMonday(year: number, week: number): CalendarDate {
  const jan4 = dayIndex({ year, month: 1, day: 4 }); // 1월 4일은 항상 W01 에 있다
  const monday = jan4 - isoWeekday(jan4) + 1 + (week - 1) * 7;
  const date = new Date(monday * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** 날짜에 n 일을 더한다 */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const next = new Date((dayIndex(date) + days) * DAY_MS);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}
