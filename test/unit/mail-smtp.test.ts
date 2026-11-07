// SMTP 제출 클라이언트 (ADR-0017 §6·§9) 를 가짜 SMTP 서버(루프백)로 시험한다: 바이트, RCPT 거절, 끝 점 뒤 끊김, STARTTLS 필수, AUTH 는 TLS 위에서만, 시간 제한, 오류에 비밀 없음.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';

import { renderMailMessage, type MailSendResult, type MailTransport, type OutboundMail } from '@aot/domain';

import { createSmtpTransport } from '../../apps/daemon/src/mail-smtp.ts';
import { startFakeSmtpServer, type FakeSmtpScript, type FakeSmtpServer } from '../support/fake-smtp-server.ts';
import { decodeMail } from '../support/mail-decode.ts';
import { mailPayload } from '../support/mail.ts';
import { makeTestCertificate } from '../support/test-cert.ts';

const PASSWORD = 'pass-not-real-9f3a';
const USER = 'user-not-real';
const cert = makeTestCertificate({ dnsNames: ['localhost'] });

const mailOf = (over: Partial<OutboundMail> = {}): OutboundMail => {
  const payload = mailPayload() as unknown as OutboundMail['payload'];
  const messageId = '<0123456789abcdef0123456789abcdef@sender.example.com>';
  return {
    idempotencyKey: 'k', envelopeFrom: 'bounce@sender.example.com', recipients: ['customer@example.com'], messageId, payload,
    raw: renderMailMessage({ payload, messageId, date: '2026-11-07T00:00:00.000Z', listUnsubscribe: 'unsubscribe@sender.example.com' }), ...over,
  };
};

async function withServer(t: { after(fn: () => unknown): void }, script: FakeSmtpScript = {}, secure = false): Promise<FakeSmtpServer> {
  const server = await startFakeSmtpServer(script, secure ? { key: cert.keyPem, cert: cert.certPem } : undefined);
  t.after(() => server.close());
  return server;
}
const plain = (server: FakeSmtpServer, extra: Partial<Parameters<typeof createSmtpTransport>[0]> = {}): MailTransport =>
  createSmtpTransport({ host: server.host, port: server.port, security: 'none', ...extra });
const secure = (server: FakeSmtpServer, extra: Partial<Parameters<typeof createSmtpTransport>[0]> = {}): MailTransport =>
  createSmtpTransport({ host: server.host, port: server.port, security: 'starttls', ca: cert.certPem, servername: 'localhost', ...extra });
const rejected = (result: MailSendResult) => {
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  return result as Extract<MailSendResult, { status: 'rejected' }>;
};

test("security 'none' on loopback without auth: the server receives exactly the rendered bytes (dot-unstuffed), the envelope, and the result is accepted", async (t) => {
  const server = await withServer(t);
  const mail = mailOf({ recipients: ['customer@example.com', 'b@example.com'] });
  const result = await plain(server).send(mail);
  assert.deepEqual(result, { status: 'accepted', providerMessageId: null });
  assert.equal(server.messages.length, 1);
  assert.equal(server.messages[0]!.data, mail.raw, 'byte for byte');
  assert.equal(server.messages[0]!.mailFrom, 'bounce@sender.example.com');
  assert.deepEqual(server.messages[0]!.recipients, ['customer@example.com', 'b@example.com']);
  assert.deepEqual(server.commands.slice(0, 3), ['EHLO', 'MAIL', 'RCPT']);
  assert.ok(!server.commands.includes('AUTH') && !server.commands.includes('STARTTLS'));
  assert.equal(decodeMail(server.messages[0]!.data).text, 'First line\nSecond line');
});

test('dot-stuffing: lines that start with a dot are doubled on the wire and restored by the server; the body is not altered', async (t) => {
  const server = await withServer(t);
  const raw = 'Subject: x\r\n\r\n.starts with dot\r\n..two dots\r\n.\r\nafter\r\n.';
  const result = await plain(server).send(mailOf({ raw: `${raw}\r\n` }));
  assert.equal(result.status, 'accepted');
  assert.equal(server.messages[0]!.data, `${raw}\r\n`);
  const lines = server.messages[0]!.data.split('\r\n');
  assert.ok(lines.includes('.') && lines.includes('.starts with dot') && lines.includes('..two dots'));
});

test('a RCPT rejected with 550 5.1.1 -> rejected (envelope) with the bounced address, RSET+QUIT, and no message is accepted (nothing partial)', async (t) => {
  const server = await withServer(t, { rejectRcpt: ['gone@example.com'] });
  const result = rejected(await plain(server).send(mailOf({ recipients: ['customer@example.com', 'gone@example.com', 'c@example.com'] })));
  assert.deepEqual([result.stage, result.code, result.bouncedRecipients], ['envelope', 'smtp_550_5.1.1', ['gone@example.com']]);
  assert.equal(server.messages.length, 0);
  assert.ok(server.commands.includes('RSET') && !server.commands.includes('DATA'));
});

test('a 4xx or 5.7.x RCPT rejection is rejected (envelope) but its address is not a bounced address; a 5.1.x reply on a 4xx code is not a bounce either', async (t) => {
  const server = await withServer(t, { rcptReplies: { 'a@example.com': '550 5.7.1 policy', 'b@example.com': '452 4.2.2 mailbox full', 'c@example.com': '450 5.1.1 greylist' } });
  const policy = rejected(await plain(server).send(mailOf({ recipients: ['a@example.com'] })));
  assert.deepEqual([policy.stage, policy.code, policy.bouncedRecipients], ['envelope', 'smtp_550_5.7.1', []]);
  const full = rejected(await plain(server).send(mailOf({ recipients: ['b@example.com'] })));
  assert.deepEqual([full.stage, full.code, full.bouncedRecipients], ['envelope', 'smtp_452_4.2.2', []]);
  const odd = rejected(await plain(server).send(mailOf({ recipients: ['c@example.com'] })));
  assert.deepEqual(odd.bouncedRecipients, []);
  assert.equal(server.messages.length, 0);
});

test('the connection drops right after the final dot (no reply) -> throws (unknown); the server has exactly one message and there is no resend', async (t) => {
  const server = await withServer(t, { dropAfterDot: true });
  await assert.rejects(() => plain(server).send(mailOf()), (error: Error) => /outcome unknown after end of data/.test(error.message) && !error.message.includes('First line'));
  assert.equal(server.messages.length, 1);
  assert.equal(server.connections(), 1);
});

test('no reply within the command timeout after the final dot -> throws (unknown)', async (t) => {
  const server = await withServer(t, { finalDelayMs: 600 });
  await assert.rejects(() => plain(server, { timeouts: { commandMs: 150 } }).send(mailOf()), /outcome unknown after end of data \(timeout\)/);
  assert.equal(server.messages.length, 1);
});

test('554 after the final dot -> rejected (data); 2xx after the dot is accepted', async (t) => {
  const refused = await withServer(t, { finalReply: '554' });
  const result = rejected(await plain(refused).send(mailOf()));
  assert.deepEqual([result.stage, result.code], ['data', 'smtp_554_5.0.0']);
});

test('any failure before the final dot is rejected, never thrown: greeting 421, connection refused, reply timeout, dropped connection', async (t) => {
  const busy = await withServer(t, { greeting421: true });
  assert.equal(rejected(await plain(busy).send(mailOf())).stage, 'connect');

  const dead = await withServer(t);
  const port = dead.port;
  await dead.close();
  const refused = rejected(await createSmtpTransport({ host: '127.0.0.1', port, security: 'none' }).send(mailOf()));
  assert.equal(refused.stage, 'connect');
  assert.match(refused.code, /^net_/);

  const slow = await withServer(t, { delayMs: 500 });
  const timedOut = rejected(await plain(slow, { timeouts: { commandMs: 100 } }).send(mailOf()));
  assert.deepEqual([timedOut.stage, timedOut.code], ['connect', 'net_timeout']);
  assert.equal(slow.messages.length, 0);

  const total = await withServer(t, { delayMs: 150 });
  const tooLong = rejected(await plain(total, { timeouts: { totalMs: 400, commandMs: 10_000 } }).send(mailOf()));
  assert.equal(tooLong.code, 'net_timeout');
  assert.equal(total.messages.length, 0, 'the total deadline stops the session before the message is complete');
});

test('STARTTLS is required: a server that does not offer it -> rejected (tls) before AUTH; the credentials never reach the server and nothing falls back to plaintext', async (t) => {
  const server = await withServer(t, { noStarttls: true, auth: { username: USER, password: PASSWORD }, advertiseAuthInPlain: true }, true);
  const result = rejected(await secure(server, { username: USER, password: PASSWORD }).send(mailOf()));
  assert.deepEqual([result.stage, result.code, result.bouncedRecipients], ['tls', 'starttls_unavailable', []]);
  assert.ok(!server.commands.includes('AUTH'), 'AUTH was never sent');
  assert.ok(!server.commands.includes('MAIL'));
  assert.equal(server.messages.length, 0);
  assert.ok(!JSON.stringify(result).includes(PASSWORD));
});

test("security 'none' with credentials is refused before connecting (no plaintext AUTH path)", async (t) => {
  const server = await withServer(t, { auth: { username: USER, password: PASSWORD }, advertiseAuthInPlain: true });
  const result = rejected(await plain(server, { username: USER, password: PASSWORD }).send(mailOf()));
  assert.deepEqual([result.stage, result.code], ['config', 'auth_without_tls']);
  assert.equal(server.connections(), 0);
});

test('STARTTLS + AUTH PLAIN round trip over a verified certificate: EHLO again after TLS, AUTH only after TLS, the message arrives byte for byte', async (t) => {
  const server = await withServer(t, { auth: { username: USER, password: PASSWORD } }, true);
  const mail = mailOf();
  const result = await secure(server, { username: USER, password: PASSWORD }).send(mail);
  assert.deepEqual(result, { status: 'accepted', providerMessageId: null });
  assert.deepEqual(server.commands.filter((c) => c !== 'QUIT'), ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']);
  assert.equal(server.messages[0]!.data, mail.raw);
});

test('STARTTLS without credentials works; the certificate is verified (an untrusted certificate -> rejected at tls, nothing else sent)', async (t) => {
  const server = await withServer(t, {}, true);
  assert.equal((await secure(server).send(mailOf())).status, 'accepted');

  const other = makeTestCertificate({ dnsNames: ['localhost'] });
  const untrusted = rejected(await secure(server, { ca: other.certPem, username: USER, password: PASSWORD }).send(mailOf()));
  assert.equal(untrusted.stage, 'tls');
  assert.match(untrusted.code, /^net_/);
  const wrongName = rejected(await secure(server, { servername: 'elsewhere.example.com' }).send(mailOf()));
  assert.equal(wrongName.stage, 'tls');
  assert.ok(!server.commands.includes('AUTH'));
  assert.equal(server.messages.length, 1, 'only the first, verified connection delivered a message');
});

test('a wrong password -> rejected (auth) with the numeric code only; the password is nowhere in the result or in the transport description', async (t) => {
  const server = await withServer(t, { auth: { username: USER, password: PASSWORD } }, true);
  const transport = secure(server, { username: USER, password: 'wrong-password-value' });
  const result = rejected(await transport.send(mailOf()));
  assert.deepEqual([result.stage, result.code], ['auth', 'smtp_535_5.7.8']);
  assert.ok(!JSON.stringify(result).includes('wrong-password-value'));
  for (const text of [String(transport), inspect(transport, { depth: 5 }), JSON.stringify(transport)]) {
    assert.ok(!text.includes('wrong-password-value') && !text.includes(USER), text);
  }
  assert.equal(server.messages.length, 0);
});

test('a server that does not advertise AUTH PLAIN when credentials are set -> rejected (auth) before any MAIL', async (t) => {
  const server = await withServer(t, {}, true);
  const result = rejected(await secure(server, { username: USER, password: PASSWORD }).send(mailOf()));
  assert.deepEqual([result.stage, result.code], ['auth', 'auth_unavailable']);
  assert.ok(!server.commands.includes('MAIL'));
});

test('malformed input never reaches the network: bad envelope addresses, empty recipients, bare LF in the message, non-ASCII', async (t) => {
  const server = await withServer(t);
  const transport = plain(server);
  for (const bad of [
    mailOf({ envelopeFrom: 'a@b.com>\r\nRCPT TO:<x@y.com' }),
    mailOf({ recipients: [] }),
    mailOf({ recipients: ['a@b.com\r\nDATA'] }),
    mailOf({ raw: 'Subject: x\n\nbare lf\r\n' }),
    mailOf({ raw: 'Subject: x\r\rbare cr\r\n' }),
    mailOf({ raw: 'Subject: 한글\r\n\r\nbody\r\n' }),
  ]) {
    assert.equal(rejected(await transport.send(bad)).stage, 'config');
  }
  assert.equal(server.connections(), 0);
});

test('the transport declares no idempotency (SMTP has no key)', () => {
  const transport = createSmtpTransport({ host: '127.0.0.1', port: 1, security: 'none' });
  assert.deepEqual(transport.idempotency, { supported: false });
  assert.equal(transport.name, 'smtp');
});

test("direct TLS (security 'tls') round trip with AUTH over a verified certificate; a hostname mismatch is rejected at tls before anything is sent", async (t) => {
  const server = await withServer(t, { implicitTls: true, auth: { username: USER, password: PASSWORD } }, true);
  const direct = (extra: Partial<Parameters<typeof createSmtpTransport>[0]> = {}) =>
    createSmtpTransport({ host: server.host, port: server.port, security: 'tls', ca: cert.certPem, servername: 'localhost', ...extra });
  const mail = mailOf();
  assert.equal((await direct({ username: USER, password: PASSWORD }).send(mail)).status, 'accepted');
  assert.deepEqual(server.commands.filter((c) => c !== 'QUIT'), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']);
  assert.equal(server.messages[0]!.data, mail.raw);
  const mismatch = rejected(await direct({ servername: 'elsewhere.example.com', username: USER, password: PASSWORD }).send(mailOf()));
  assert.equal(mismatch.stage, 'tls');
  assert.equal(server.messages.length, 1);
  assert.equal(server.commands.filter((c) => c === 'AUTH').length, 1, 'no AUTH on the mismatched connection');
  const untrusted = rejected(await direct({ ca: makeTestCertificate({ dnsNames: ['localhost'] }).certPem }).send(mailOf()));
  assert.equal(untrusted.stage, 'tls');
});

test('only recipient-address rejections count as bounces: 5.1.1/2/3/6/10 yes; 5.1.0, 5.1.7, 5.1.8 and 4xx with 5.1.x no', async (t) => {
  const replies: Record<string, string> = {
    'a1@example.com': '550 5.1.1 no user', 'a2@example.com': '550 5.1.2 bad domain', 'a3@example.com': '553 5.1.3 bad syntax',
    'a6@example.com': '551 5.1.6 moved', 'a10@example.com': '550 5.1.10 recipient not found',
    'n0@example.com': '550 5.1.0 other', 'n7@example.com': '550 5.1.7 bad sender', 'n8@example.com': '553 5.1.8 Sender address rejected', 'n4@example.com': '450 5.1.1 later',
  };
  const server = await withServer(t, { rcptReplies: replies });
  for (const [address] of Object.entries(replies)) {
    const result = rejected(await plain(server).send(mailOf({ recipients: [address] })));
    const counts = /^a/.test(address);
    assert.deepEqual(result.bouncedRecipients, counts ? [address] : [], address);
  }
  assert.equal(server.messages.length, 0);
});

test('replies split into single characters, multi-line replies split across chunks, and two replies in one chunk are all read correctly', async (t) => {
  for (const script of [{ splitReplies: true }, { splitLines: true }, { finalPlusBye: true }] as FakeSmtpScript[]) {
    const server = await withServer(t, script);
    const mail = mailOf({ recipients: ['customer@example.com', 'b@example.com'] });
    assert.equal((await plain(server).send(mail)).status, 'accepted', JSON.stringify(script));
    assert.equal(server.messages[0]!.data, mail.raw);
  }
});

test('post-dot budget: a pre-dot stage that outlasts total - reserve is rejected before the dot (never unknown); a final reply within the reserved budget is accepted', async (t) => {
  // total 1000, command 300 -> 예약 300, 끝 점 전 단계는 700ms 안에 끝나야 한다
  const slow = await withServer(t, { delayMs: 170 });
  const tooSlow = rejected(await plain(slow, { timeouts: { totalMs: 1000, commandMs: 300 } }).send(mailOf()));
  assert.equal(tooSlow.code, 'net_timeout');
  assert.equal(slow.messages.length, 0, 'the dot was never written');

  const ok = await withServer(t, { delayMs: 100, finalDelayMs: 150 });
  assert.equal((await plain(ok, { timeouts: { totalMs: 1000, commandMs: 300 } }).send(mailOf())).status, 'accepted');

  // 끝 점 뒤 응답이 예약을 넘으면 던진다
  const lost = await withServer(t, { delayMs: 10, finalDelayMs: 600 });
  await assert.rejects(() => plain(lost, { timeouts: { totalMs: 1000, commandMs: 300 } }).send(mailOf()), /outcome unknown/);
});
