// 메일 payload 검증 (ADR-0017 §4): 다섯 키, to 1명, cc 규칙, 제목·본문 문자 규칙, 상한. 검토 화면 조각 상한과의 관계도 고정한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAIL_LIMITS, validateMailPayload, type MailPayload } from '@aot/domain';

import { CHUNK_MAX } from '../../apps/daemon/src/review-web/payload-view.ts';

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  from: 'support@sender.example.com', to: ['customer@example.com'], subject: 'Hello', text: 'First line\nSecond line', ...over,
});

const codes = (payload: unknown, requireFrom = true): string[] => {
  const r = validateMailPayload(payload, { requireFrom });
  return r.ok ? [] : r.errors.map((e) => `${e.path}:${e.code}`);
};

test('a plain payload is valid and the value keeps exactly the five keys', () => {
  const r = validateMailPayload(base(), { requireFrom: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, base() as unknown as MailPayload);
  const withCc = validateMailPayload(base({ cc: ['a@example.com', 'b@example.com'] }), { requireFrom: true });
  assert.equal(withCc.ok, true);
});

test('MAIL_LIMITS: the text limit equals the review screen chunk limit (what the person sees is what is sent)', () => {
  assert.ok(MAIL_LIMITS.textChars <= CHUNK_MAX);
  assert.deepEqual(MAIL_LIMITS, { textChars: 50_000, subjectChars: 200, maxCc: 4, maxRecipients: 5 });
  assert.equal(MAIL_LIMITS.maxCc + 1, MAIL_LIMITS.maxRecipients);
});

test('any key outside the five is rejected (bcc, reply_to, headers, html, attachments)', () => {
  for (const key of ['bcc', 'reply_to', 'headers', 'html', 'attachments', 'name']) {
    assert.deepEqual(codes(base({ [key]: 'x' })), [`${key}:unknown_key`], key);
  }
});

test('from: required when requireFrom, must be normalized; absent is fine without requireFrom', () => {
  const noFrom = Object.fromEntries(Object.entries(base()).filter(([key]) => key !== 'from'));
  assert.deepEqual(codes(noFrom), ['from:required']);
  assert.deepEqual(codes(noFrom, false), []);
  assert.deepEqual(codes(base({ from: 'Support <support@sender.example.com>' })), ['from:address']);
  assert.deepEqual(codes(base({ from: 'Support@Sender.example.com' })), ['from:address']);
  assert.deepEqual(codes(base({ from: 5 })), ['from:address']);
  const r = validateMailPayload(noFrom, { requireFrom: false });
  assert.equal(r.ok && 'from' in r.value, false);
});

test('to: exactly one normalized address', () => {
  assert.deepEqual(codes(base({ to: [] })), ['to:recipients']);
  assert.deepEqual(codes(base({ to: ['a@example.com', 'b@example.com'] })), ['to:recipients']);
  assert.deepEqual(codes(base({ to: 'customer@example.com' })), ['to:type']);
  assert.deepEqual(codes(base({ to: ['Customer@example.com'] })), ['to.0:address']);
  assert.deepEqual(codes(base({ to: ['Name <customer@example.com>'] })), ['to.0:address']);
  assert.deepEqual(codes(base({ to: [' customer@example.com'] })), ['to.0:address']);
  assert.deepEqual(codes(base({ to: [7] })), ['to.0:address']);
  assert.deepEqual(codes(base({ to: undefined })), ['to:type']);
});

test('cc: same non-free domain as to, 1 to 4 entries, no empty array, no duplicates', () => {
  assert.deepEqual(codes(base({ cc: [] })), ['cc:empty_cc']);
  assert.deepEqual(codes(base({ cc: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'] })), ['cc:recipients']);
  assert.deepEqual(codes(base({ cc: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'] })), []);
  assert.deepEqual(codes(base({ cc: ['other@example.org'] })), ['cc.0:cc_domain']);
  assert.deepEqual(codes(base({ cc: ['A@example.com'] })), ['cc.0:address']);
  assert.deepEqual(codes(base({ cc: 'a@example.com' })), ['cc:type']);
  assert.deepEqual(codes(base({ cc: ['customer@example.com'] })), ['cc.0:duplicate']);
  assert.deepEqual(codes(base({ cc: ['a@example.com', 'a@example.com'] })), ['cc.1:duplicate']);
  // 무료 메일 도메인은 같은 도메인이어도 cc 불가 (다른 고객끼리 주소가 보이지 않게)
  assert.deepEqual(codes(base({ to: ['one@gmail.com'], cc: ['two@gmail.com'] })), ['cc.0:cc_free_mail']);
  assert.deepEqual(codes(base({ to: ['one@gmail.com'] })), []);
});

test('subject: 1 to 200 chars, not blank, no control characters or line breaks, no broken text', () => {
  assert.deepEqual(codes(base({ subject: '' })), ['subject:length']);
  assert.deepEqual(codes(base({ subject: 'x'.repeat(201) })), ['subject:length']);
  assert.deepEqual(codes(base({ subject: 'x'.repeat(200) })), []);
  assert.deepEqual(codes(base({ subject: '   ' })), ['subject:blank']);
  assert.deepEqual(codes(base({ subject: 'a\nBcc: x@example.com' })), ['subject:chars']);
  assert.deepEqual(codes(base({ subject: 'a\rb' })), ['subject:chars']);
  assert.deepEqual(codes(base({ subject: 'a\tb' })), ['subject:chars']);
  assert.deepEqual(codes(base({ subject: 'a\u0000b' })), ['subject:chars']);
  assert.deepEqual(codes(base({ subject: 'a b' })), ['subject:chars']);
  assert.deepEqual(codes(base({ subject: 'a\ud800b' })), ['subject:chars']);
  assert.deepEqual(codes(base({ subject: 'a�b' })), ['subject:chars']);
  assert.deepEqual(codes(base({ subject: 1 })), ['subject:type']);
  assert.deepEqual(codes(base({ subject: '안녕하세요 😀' })), []);
});

test('text: 1 to 50,000 chars; \\n and tab allowed; \\r, other control characters, lone surrogates and U+FFFD rejected', () => {
  assert.deepEqual(codes(base({ text: '' })), ['text:length']);
  assert.deepEqual(codes(base({ text: 'x'.repeat(MAIL_LIMITS.textChars + 1) })), ['text:length']);
  assert.deepEqual(codes(base({ text: 'x'.repeat(MAIL_LIMITS.textChars) })), []);
  assert.deepEqual(codes(base({ text: 'a\n\tb\n' })), []);
  assert.deepEqual(codes(base({ text: 'a\r\nb' })), ['text:chars']);
  assert.deepEqual(codes(base({ text: 'a\u0000b' })), ['text:chars']);
  assert.deepEqual(codes(base({ text: 'a\u001bb' })), ['text:chars']);
  assert.deepEqual(codes(base({ text: 'a\u007fb' })), ['text:chars']);
  assert.deepEqual(codes(base({ text: 'a\u0085b' })), ['text:chars']);
  assert.deepEqual(codes(base({ text: 'a\udc00b' })), ['text:chars']);
  assert.deepEqual(codes(base({ text: 'a�b' })), ['text:chars']);
  assert.deepEqual(codes(base({ text: 'a😀b' })), []);
  assert.deepEqual(codes(base({ text: null })), ['text:type']);
});

test('non-objects are rejected', () => {
  for (const value of [null, 'x', 3, [], undefined]) assert.deepEqual(codes(value), [':type']);
});
