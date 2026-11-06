// 고객 연락처 (결정 위임 D-B11, ADR-0016). 받는 사람 주소의 엄격한 정규화와, 연락처 저장소 조회.
//  - 정규화: 앞뒤 공백 제거, 소문자, 표시 이름(`Name <a@b.com>`) 제거. 규칙에 맞지 않으면 null (= 모르는 주소로 센다).
//  - 쓰기는 사람만 한다(승인 소켓의 `contacts` 명령, apps/daemon/src/contacts.ts). 이 모듈은 읽기와 순수 함수뿐이다.
import type { Db } from './db/types.ts';
import type { ContactRow, ContactStatus } from './entities/index.ts';

/** 공개 무료 메일 도메인 (코드 상수, 정책으로 못 바꾼다). 이 도메인을 위임 허용 목록에 넣으면 아무나 받는 사람이 되어 규칙의 의미가 사라진다 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.kr', 'yahoo.co.jp', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'aol.com', 'gmx.com', 'gmx.net',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com', 'tutanota.com', 'tuta.io', 'fastmail.com',
];

const MAX_ADDRESS_CHARS = 254;
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const hasControlChar = (text: string): boolean => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/** 도메인(소문자 ASCII, 점으로 나뉜 2개 이상의 라벨)이 올바른가. 와일드카드·IDN·IP 는 받지 않는다 */
export function isStrictDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]!); // 마지막이 숫자뿐이면 IP 모양
}

/**
 * 받는 사람 문자열 하나를 `local@domain`(소문자)으로 만든다. 모양이 맞지 않으면 null.
 * 허용: `a@b.com`, `Name <a@b.com>`, `"Name" <a@b.com>`. 거부: 주소가 둘 이상, 코멘트, 표시 이름 속 `@`, 제어 문자, 비 ASCII, 규칙 밖 문자.
 */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || text.length > 998 || hasControlChar(text)) return null;
  let address = text;
  const angle = /^(?:"([^"\\]*)"|([^<>"@,;:()[\]\\]*?))\s*<([^<>\s]+)>$/.exec(text);
  if (angle !== null) {
    const display = angle[1] ?? angle[2] ?? '';
    if (display.includes('@') || display.includes('<') || display.includes('>')) return null;
    address = angle[3]!;
  }
  address = address.toLowerCase();
  if (address.length > MAX_ADDRESS_CHARS) return null;
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local) || !isStrictDomain(domain)) return null;
  return address;
}

export const domainOfAddress = (address: string): string => address.slice(address.lastIndexOf('@') + 1);

export interface RecipientAddresses {
  /** to + cc + bcc 순서대로 */
  recipients: string[];
  /** `reply_to` (문자열 또는 문자열 배열) 와 헤더의 Reply-To. 없으면 빈 배열 */
  replyTo: string[];
  /** 모양이 맞지 않아 읽지 못한 항목 수 (문자열이 아닌 값 포함) */
  malformed: number;
}

const strings = (value: unknown): { items: string[]; malformed: number } => {
  if (value === undefined || value === null) return { items: [], malformed: 0 };
  if (typeof value === 'string') return { items: [value], malformed: 0 };
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string');
    return { items, malformed: value.length - items.length };
  }
  return { items: [], malformed: 1 };
};

/** 초안 payload 에서 받는 사람 주소와 reply-to 를 뽑는다 (정규화 전 원문). payload 가 객체가 아니면 null */
export function recipientAddressesOf(payload: unknown): RecipientAddresses | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const out: RecipientAddresses = { recipients: [], replyTo: [], malformed: 0 };
  for (const key of ['to', 'cc', 'bcc']) {
    const part = strings(record[key]);
    out.recipients.push(...part.items);
    out.malformed += part.malformed;
  }
  const reply = [strings(record['reply_to'])];
  const headers = record['headers'];
  if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase().replace(/_/g, '-') === 'reply-to') reply.push(strings(value));
    }
  }
  for (const part of reply) {
    out.replyTo.push(...part.items);
    out.malformed += part.malformed;
  }
  return out;
}

/** 주소 → 상태. 정규화된 주소만 조회한다 */
export function contactStatuses(db: Db, addresses: readonly string[]): Map<string, ContactStatus> {
  const out = new Map<string, ContactStatus>();
  for (const address of new Set(addresses)) {
    const row = db.get<{ status: ContactStatus }>('SELECT status FROM contact WHERE address = ?', [address]);
    if (row !== undefined) out.set(address, row.status);
  }
  return out;
}

export function listContacts(db: Db): ContactRow[] {
  return db.all<ContactRow>('SELECT * FROM contact ORDER BY address');
}
