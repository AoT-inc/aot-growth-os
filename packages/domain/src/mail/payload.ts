// 메일 payload 형식과 검증 (ADR-0017, docs/plans/mail-tool.md §4). 사람(또는 위임 AI)이 승인하는 바이트의 모양이다.
// 키는 `from`·`to`·`cc`·`subject`·`text` 다섯 개뿐이고 그 밖의 키는 모두 거부한다. 순수 함수만 둔다(DB·시계 없음).
import { domainOfAddress, FREE_MAIL_DOMAINS, normalizeAddress } from '../contacts.ts';

export interface MailPayload {
  /** 보내는 사람 주소. 호스트(실행기)가 명세 target 의 설정 주소로 채운다 */
  from: string;
  /** 받는 사람: 정확히 1명 */
  to: string[];
  /** 참조: 0~4명(빈 배열 금지), 모두 `to` 와 같은 비무료 도메인 */
  cc?: string[];
  subject: string;
  text: string;
}

export const MAIL_LIMITS = { textChars: 50_000, subjectChars: 200, maxCc: 4, maxRecipients: 5 } as const;

export const MAIL_PAYLOAD_KEYS: readonly string[] = ['from', 'to', 'cc', 'subject', 'text'];

export interface MailPayloadIssue { path: string; code: string; message: string }

export type MailPayloadCheck = { ok: true; value: MailPayload } | { ok: false; errors: MailPayloadIssue[] };

// 제어 문자: C0(0x00-0x1f), DEL, C1(0x80-0x9f). 줄 구분자 U+2028·U+2029 도 제목·본문에 두지 않는다.
const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
// 짝 없는 서로게이트와 U+FFFD (검토 화면의 BINARY 규칙과 같은 조건)
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const REPLACEMENT = '�';

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

function badChars(text: string, allowed: ReadonlySet<number>): string | null {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isControl(code) && !allowed.has(code)) return code === 0x0d ? 'a carriage return (\\r); use \\n for line breaks' : `a control character (U+${code.toString(16).toUpperCase().padStart(4, '0')})`;
  }
  if (LONE_SURROGATE.test(text)) return 'an unpaired surrogate';
  if (text.includes(REPLACEMENT)) return 'the replacement character U+FFFD';
  return null;
}

const TEXT_ALLOWED: ReadonlySet<number> = new Set([0x09, 0x0a]);
const NONE: ReadonlySet<number> = new Set();

export function validateMailPayload(payload: unknown, options: { requireFrom: boolean }): MailPayloadCheck {
  const errors: MailPayloadIssue[] = [];
  const add = (path: string, code: string, message: string): void => void errors.push({ path, code, message });
  if (!isPlainRecord(payload)) return { ok: false, errors: [{ path: '', code: 'type', message: 'payload must be an object' }] };

  for (const key of Object.keys(payload)) {
    if (!MAIL_PAYLOAD_KEYS.includes(key)) add(key, 'unknown_key', `unknown key '${key}': a mail has only from, to, cc, subject and text`);
  }

  // from
  const from = payload['from'];
  if (from === undefined) {
    if (options.requireFrom) add('from', 'required', 'from is required');
  } else if (typeof from !== 'string' || normalizeAddress(from) !== from) {
    add('from', 'address', 'from must be a normalized address (lowercase, no display name)');
  }

  // to
  const to = payload['to'];
  let toAddress: string | null = null;
  if (!Array.isArray(to)) add('to', 'type', 'to must be an array with exactly one address');
  else if (to.length !== 1) add('to', 'recipients', 'to must contain exactly one address');
  else if (typeof to[0] !== 'string' || normalizeAddress(to[0]) !== to[0]) add('to.0', 'address', 'to must be a normalized address (lowercase, no display name)');
  else toAddress = to[0];

  // cc
  const cc = payload['cc'];
  if (cc !== undefined) {
    if (!Array.isArray(cc)) add('cc', 'type', 'cc must be an array of addresses');
    else if (cc.length === 0) add('cc', 'empty_cc', 'cc must not be an empty array; omit the key');
    else if (cc.length > MAIL_LIMITS.maxCc) add('cc', 'recipients', `cc has at most ${MAIL_LIMITS.maxCc} addresses`);
    else {
      const seen = new Set<string>(toAddress === null ? [] : [toAddress]);
      cc.forEach((entry: unknown, index) => {
        const path = `cc.${index}`;
        if (typeof entry !== 'string' || normalizeAddress(entry) !== entry) return void add(path, 'address', 'cc must be a normalized address (lowercase, no display name)');
        if (seen.has(entry)) return void add(path, 'duplicate', `duplicate recipient '${entry}'`);
        seen.add(entry);
        if (toAddress !== null) {
          const domain = domainOfAddress(entry);
          if (domain !== domainOfAddress(toAddress)) add(path, 'cc_domain', 'cc must be in the same domain as to (other customers must not see each other\'s addresses)');
          else if (FREE_MAIL_DOMAINS.includes(domain)) add(path, 'cc_free_mail', 'cc is not allowed on a public free-mail domain');
        }
      });
    }
  }

  // subject
  const subject = payload['subject'];
  if (typeof subject !== 'string') add('subject', 'type', 'subject must be a string');
  else if (subject.length < 1 || subject.length > MAIL_LIMITS.subjectChars) add('subject', 'length', `subject must be 1 to ${MAIL_LIMITS.subjectChars} characters`);
  else if (subject.trim() === '') add('subject', 'blank', 'subject must not be only whitespace');
  else {
    const bad = badChars(subject, NONE);
    if (bad !== null) add('subject', 'chars', `subject contains ${bad}`);
  }

  // text
  const text = payload['text'];
  if (typeof text !== 'string') add('text', 'type', 'text must be a string');
  else if (text.length < 1 || text.length > MAIL_LIMITS.textChars) add('text', 'length', `text must be 1 to ${MAIL_LIMITS.textChars} characters`);
  else {
    const bad = badChars(text, TEXT_ALLOWED);
    if (bad !== null) add('text', 'chars', `text contains ${bad}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  // requireFrom=false 이고 from 이 없으면 값에서도 뺀다 (호출자가 채운 뒤 requireFrom=true 로 다시 검증한다)
  const value = {
    ...(from === undefined ? {} : { from: from as string }),
    to: [...(to as string[])],
    ...(cc === undefined ? {} : { cc: [...(cc as string[])] }),
    subject: subject as string,
    text: text as string,
  } as MailPayload;
  return { ok: true, value };
}

/** to + cc 순서대로 */
export const mailRecipients = (payload: Pick<MailPayload, 'to' | 'cc'>): string[] => [...payload.to, ...(payload.cc ?? [])];
