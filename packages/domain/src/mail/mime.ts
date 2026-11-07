// payload → RFC 5322 메시지 (ADR-0017, docs/plans/mail-tool.md §5). 순수 함수이고 결정론이다: 내용을 바꾸거나 더하지 않는다.
// 유일한 변환은 줄바꿈 `\n → \r\n` 과 전송 인코딩(본문 base64, 제목 RFC 2047 B)이다. 받는 쪽이 디코드하면 payload 와 정확히 같다.
// 메시지 전체가 ASCII 이고 CRLF 줄바꿈이며 끝에 CRLF 가 있다.
import { normalizeAddress } from '../contacts.ts';
import { validateMailPayload, type MailPayload } from './payload.ts';

export interface RenderMailInput {
  payload: MailPayload;
  /** `<local@domain>` 꼴 (messageIdOf 로 만든다) */
  messageId: string;
  /** 전송 시각 (내용이 아니다) */
  date: Date | string;
  /** List-Unsubscribe 의 mailto 주소 (정규화된 주소) */
  listUnsubscribe: string;
}

const MESSAGE_ID = /^<[A-Za-z0-9._-]{1,64}@[a-z0-9.-]{1,253}>$/;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number): string => String(n).padStart(2, '0');

/** RFC 5322 날짜 (UTC, `+0000`) */
export function formatMailDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new Error('mail: invalid date');
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** effect_key 에서 정해지는 Message-ID. effect_key 는 내용 해시라 비밀·개인정보가 아니다 */
export function messageIdOf(effectKey: string, domain: string): string {
  const local = effectKey.slice(0, 32);
  const id = `<${local}@${domain}>`;
  if (!MESSAGE_ID.test(id)) throw new Error('mail: cannot build a valid Message-ID');
  return id;
}

const ENCODED_WORD_OVERHEAD = '=?UTF-8?B?'.length + '?='.length; // 12
const MAX_BYTES_PER_WORD = Math.floor((75 - ENCODED_WORD_OVERHEAD) / 4) * 3; // base64 60자 = 45바이트

/** 제목을 UTF-8 문자(코드 포인트) 경계에서 잘라 RFC 2047 encoded-word 목록으로 만든다. 각 조각은 75자 이하다 */
function encodeSubjectWords(subject: string): string[] {
  const words: string[] = [];
  let bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) words.push(`=?UTF-8?B?${Buffer.from(bytes).toString('base64')}?=`);
    bytes = [];
  };
  for (const char of subject) {
    const encoded = [...Buffer.from(char, 'utf8')];
    if (bytes.length + encoded.length > MAX_BYTES_PER_WORD) flush();
    bytes.push(...encoded);
  }
  flush();
  return words;
}

/** 그대로 헤더에 둬도 안전한 제목인가: 인쇄 가능 ASCII 70자 이하, 앞뒤 공백 없음, encoded-word 로 읽힐 `=?` 없음 */
const isPlainSubject = (subject: string): boolean => subject.length <= 70 && /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(subject) && !subject.includes('=?');

function base64Lines(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join('\r\n');
}

export function renderMailMessage(input: RenderMailInput): string {
  const checked = validateMailPayload(input.payload, { requireFrom: true });
  if (!checked.ok) throw new Error(`mail: invalid payload (${checked.errors.map((e) => `${e.path}: ${e.code}`).join(', ')})`);
  if (!MESSAGE_ID.test(input.messageId)) throw new Error('mail: invalid Message-ID');
  if (normalizeAddress(input.listUnsubscribe) !== input.listUnsubscribe) throw new Error('mail: invalid List-Unsubscribe address');
  const { from, to, cc, subject, text } = checked.value;

  const subjectLines = isPlainSubject(subject) ? [`Subject: ${subject}`] : ['Subject:', ...encodeSubjectWords(subject).map((word) => ` ${word}`)];
  const headers = [
    `From: ${from}`,
    `To: ${to[0]!}`,
    // 주소 4개가 각각 254자면 한 줄이 998자를 넘는다: 쉼표 뒤에서 접는다(받는 쪽이 펼치면 ", " 로 이어진 같은 목록)
    ...(cc === undefined ? [] : [`Cc: ${cc.join(',\r\n ')}`]),
    ...subjectLines,
    `Date: ${formatMailDate(input.date)}`,
    `Message-ID: ${input.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `List-Unsubscribe: <mailto:${input.listUnsubscribe}?subject=unsubscribe>`,
    'Auto-Submitted: auto-generated',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${base64Lines(text.replace(/\n/g, '\r\n'))}\r\n`;
}
