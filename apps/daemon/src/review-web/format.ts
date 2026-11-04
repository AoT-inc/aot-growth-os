// 사람이 읽는 시각·길이 표현 (한국 시간 기준). 첫 화면에는 ISO 시각을 내지 않는다.
const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const dayIndex = (ms: number): number => Math.floor((ms + KST) / DAY);

/** "11월 17일" */
export function monthDay(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms + KST);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}

/** 지난 일: "오늘", "어제", "3일 전" */
export function ago(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  const days = dayIndex(nowMs) - dayIndex(ms);
  if (days <= 0) return '오늘';
  return days === 1 ? '어제' : `${days}일 전`;
}

/** 기한: "만료됨", "오늘 만료", "내일 만료", "13일 뒤 만료" (`what` 으로 말미를 바꾼다) */
export function until(iso: string, nowMs: number, what = '만료'): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  if (ms <= nowMs) return `${what === '만료' ? '만료됨' : `${what} 지남`}`;
  const days = dayIndex(ms) - dayIndex(nowMs);
  if (days <= 0) return `오늘 ${what}`;
  return days === 1 ? `내일 ${what}` : `${days}일 뒤 ${what}`;
}

/** 한 줄로 줄인다 (줄바꿈은 공백으로) */
export function clip(value: unknown, max = 40): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export const percent = (rate: number | null): string => (rate === null ? '-' : `${Math.round(rate * 100)}%`);
