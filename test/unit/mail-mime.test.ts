// 메일 렌더링 (ADR-0017 §5): 순수·결정론, CRLF, 정해진 헤더만, 디코드하면 payload 와 바이트 단위로 같다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatMailDate, messageIdOf, renderMailMessage, type MailPayload } from '@aot/domain';

import { decodeMail } from '../support/mail-decode.ts';

const payload = (over: Partial<MailPayload> = {}): MailPayload => ({
  from: 'support@sender.example.com', to: ['customer@example.com'], subject: 'Hello', text: 'First line\nSecond line', ...over,
});
const ID = '<0123456789abcdef0123456789abcdef@sender.example.com>';
const render = (p: MailPayload, date: Date | string = '2026-11-07T01:02:03.456Z') =>
  renderMailMessage({ payload: p, messageId: ID, date, listUnsubscribe: 'unsubscribe@sender.example.com' });

test('headers are exactly the design list, in order, with CRLF and a trailing CRLF', () => {
  const raw = render(payload({ cc: ['a@example.com', 'b@example.com'] }));
  assert.ok(raw.endsWith('\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(raw), 'no bare LF');
  assert.ok([...raw].every((c) => c.charCodeAt(0) < 0x80), 'ASCII only');
  const { headerLines } = decodeMail(raw);
  assert.deepEqual(headerLines, [
    'From: support@sender.example.com',
    'To: customer@example.com',
    'Cc: a@example.com, b@example.com',
    'Subject: Hello',
    'Date: Sat, 07 Nov 2026 01:02:03 +0000',
    `Message-ID: ${ID}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'List-Unsubscribe: <mailto:unsubscribe@sender.example.com?subject=unsubscribe>',
    'Auto-Submitted: auto-generated',
  ]);
  assert.ok(!render(payload()).includes('Cc:'), 'no Cc header without cc');
});

test('the body is base64 of the UTF-8 text with \\n -> \\r\\n, in 76-character lines', () => {
  const text = 'line one\n\n한글 본문 😀\n'.repeat(40);
  const raw = render(payload({ text }));
  const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  const lines = body.split('\r\n');
  assert.equal(lines.at(-1), '');
  for (const line of lines.slice(0, -2)) assert.equal(line.length, 76);
  assert.ok(lines.at(-2)!.length <= 76 && lines.at(-2)!.length > 0);
  assert.equal(Buffer.from(lines.join(''), 'base64').toString('utf8'), text.replace(/\n/g, '\r\n'));
  assert.equal(decodeMail(raw).text, text);
});

test('round trip: decoded subject and text are byte-equal to the payload (ASCII, Korean, emoji, long)', () => {
  const subjects = [
    'Hello',
    '주문하신 상품이 발송되었습니다',
    'x'.repeat(71),
    'x'.repeat(200),
    '😀'.repeat(60),
    '가'.repeat(15), // 45바이트 경계
    '가'.repeat(16), // 48바이트: 조각 둘
    `${'a'.repeat(44)}가`, // 문자 경계: 44바이트 + 3바이트가 한 조각에 들어가지 않는다
    `${'a'.repeat(43)}😀`,
    ' leading space',
    'trailing space ',
    '=?UTF-8?B?aGk=?= looks encoded',
    '안녕 hello 😀 world '.repeat(8).trim(),
  ];
  for (const subject of subjects) {
    const text = `${subject}\n본문 😀\n\n끝`;
    const raw = render(payload({ subject, text }));
    const decoded = decodeMail(raw);
    assert.equal(decoded.subject, subject, subject.slice(0, 20));
    assert.equal(decoded.text, text);
    // 헤더 줄은 모두 78자 이하, 각 encoded-word 는 75자 이하
    for (const line of decoded.headerLines) assert.ok(line.length <= 78, `${line.length}: ${line}`);
    for (const word of raw.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []) assert.ok(word.length <= 75, word);
  }
});

test('subject encoding: plain ASCII up to 70 chars stays as is, everything else is RFC 2047 split on character boundaries', () => {
  assert.equal(decodeMail(render(payload({ subject: 'x'.repeat(70) }))).headers.get('Subject'), 'x'.repeat(70));
  assert.ok(decodeMail(render(payload({ subject: 'x'.repeat(71) }))).headers.get('Subject')!.startsWith('=?UTF-8?B?'));
  // 문자 경계: 모든 조각이 그 자체로 올바른 UTF-8 이다
  const raw = render(payload({ subject: '😀가나다라마바사아자차카타파하'.repeat(3) }));
  for (const word of raw.match(/=\?UTF-8\?B\?([^?]*)\?=/g) ?? []) {
    const bytes = Buffer.from(word.slice(10, -2), 'base64');
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('�'), false);
  }
});

test('rendering is deterministic and does not add or change content', () => {
  const p = payload({ text: 'a\n.\n..\n' });
  assert.equal(render(p), render(p));
  assert.equal(decodeMail(render(p)).text, 'a\n.\n..\n');
});

test('invalid input is refused (header injection, bad Message-ID, bad unsubscribe address, bad date)', () => {
  assert.throws(() => render(payload({ subject: 'a\r\nBcc: x@example.com' })), /invalid payload/);
  assert.throws(() => renderMailMessage({ payload: payload(), messageId: 'no-brackets@x.com', date: new Date(), listUnsubscribe: 'u@sender.example.com' }), /Message-ID/);
  assert.throws(() => renderMailMessage({ payload: payload(), messageId: ID, date: new Date(), listUnsubscribe: 'U@Sender.example.com' }), /List-Unsubscribe/);
  assert.throws(() => render(payload(), 'not a date'), /invalid date/);
});

test('messageIdOf: first 32 characters of the effect key at the domain; date formatting is RFC 5322 in UTC', () => {
  const key = 'f'.repeat(64);
  assert.equal(messageIdOf(key, 'sender.example.com'), `<${'f'.repeat(32)}@sender.example.com>`);
  assert.equal(formatMailDate(new Date(Date.UTC(2026, 0, 5, 9, 8, 7))), 'Mon, 05 Jan 2026 09:08:07 +0000');
});
