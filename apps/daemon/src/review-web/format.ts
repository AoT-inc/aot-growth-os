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

/** 받침에 따라 을/를을 붙인다 ("발송" → "발송을", "메일" → "메일을", "보고서" → "보고서를") */
export function eulReul(word: string): string {
  const code = word.charCodeAt(word.length - 1);
  const mark = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 0 ? '를' : '을';
  return `${word}${mark}`;
}

/** 여러 문장의 앞부분·뒷부분 공통 글자 (단어 경계로 자른다). 업무 제목 묶음 이름용 */
export function commonAffixes(items: readonly string[]): { prefix: string; suffix: string } {
  if (items.length < 2) return { prefix: '', suffix: '' };
  let prefix = items[0]!;
  for (const item of items) while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
  let suffix = items[0]!;
  for (const item of items) while (!item.endsWith(suffix)) suffix = suffix.slice(1);
  prefix = prefix.replace(/[\s#0-9]+$/, '').trim();
  suffix = suffix.replace(/^[\s#0-9]+/, '').trim();
  const cleaned = prefix.length >= 3 ? prefix : '';
  return { prefix: cleaned, suffix: cleaned === '' ? '' : suffix.length >= 2 ? suffix : '' };
}

/** 받는 사람 주소를 가린다: 'kim@example.com' → 'k***@example.com' (정확한 주소는 화면에 내지 않는다, ADR-0015 D10) */
export function maskAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return `${trimmed.slice(0, 1)}***`;
  return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`;
}

/** 주소의 도메인 (소문자). 없으면 '(도메인 없음)' */
export function addressDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 || at === address.length - 1 ? '(도메인 없음)' : address.slice(at + 1).trim().toLowerCase();
}

/** 초안 기한: "초안 기한 지남", "초안 40분 뒤 만료", "초안 5시간 뒤 만료", "초안 3일 뒤 만료" */
export function draftExpiry(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '초안 기한 확인 불가';
  if (ms <= nowMs) return '초안 기한 지남';
  const minutes = Math.ceil((ms - nowMs) / 60_000);
  if (minutes < 60) return `초안 ${minutes}분 뒤 만료`;
  const hours = Math.ceil(minutes / 60);
  return hours < 48 ? `초안 ${hours}시간 뒤 만료` : `초안 ${Math.ceil(hours / 24)}일 뒤 만료`;
}
