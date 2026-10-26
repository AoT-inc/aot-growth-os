// TOTP (RFC 6238) 자체 구현: RFC 시험 벡터, 정상/오답, 시간창 경계(가짜 시각), 비밀 파일 권한.
import assert from 'node:assert/strict';
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, TOTP_STEP_SECONDS, totpCode, TotpSecretError, TotpSecretStore, totpStep, verifyTotp,
} from '@aot/policy';

import { makeTempDir } from '../support/temp.ts';

test('RFC 6238 appendix B vectors (SHA-1, 8 digits) and RFC 4226 HOTP vectors', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const vectors: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) assert.equal(hotp(secret, totpStep(seconds * 1000), 8), expected, String(seconds));
  const hotpVectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  hotpVectors.forEach((expected, counter) => assert.equal(hotp(secret, counter), expected));
});

test('base32 round trip (RFC 4648)', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Encode(base32Decode(secret)), secret);
  assert.throws(() => base32Decode('not base32!'), TotpSecretError);
});

test('verification: correct code accepted, wrong or malformed rejected', () => {
  const secret = base32Decode(generateTotpSecret());
  const now = Date.parse('2026-10-19T12:00:10.000Z');
  const code = totpCode(secret, now);
  assert.equal(verifyTotp(secret, code, now), totpStep(now));
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  assert.equal(verifyTotp(secret, wrong, now), null);
  for (const bad of ['', '12345', '1234567', 'abcdef', ` ${code}`]) assert.equal(verifyTotp(secret, bad, now), null, JSON.stringify(bad));
});

test('time-window boundaries: one step of drift either way is accepted, two are not', () => {
  const secret = base32Decode(generateTotpSecret());
  const stepMs = TOTP_STEP_SECONDS * 1000;
  const start = Date.parse('2026-10-19T12:00:00.000Z'); // 시간창의 시작 (30초 배수)
  assert.equal(start % stepMs, 0);
  const code = totpCode(secret, start);
  // 같은 창의 끝(29.999초)까지 같은 코드, 다음 창의 시작부터는 다른 코드
  assert.equal(totpCode(secret, start + stepMs - 1), code);
  assert.notEqual(totpCode(secret, start + stepMs), code);
  // 앞 창 코드: 다음 창 끝까지 받고(drift 1), 그다음 창 시작부터 거부
  assert.equal(verifyTotp(secret, code, start + 2 * stepMs - 1), totpStep(start));
  assert.equal(verifyTotp(secret, code, start + 2 * stepMs), null);
  // 뒤 창 코드(시계가 늦은 경우): 한 창 앞까지 받는다
  const next = totpCode(secret, start + stepMs);
  assert.equal(verifyTotp(secret, next, start), totpStep(start) + 1);
  assert.equal(verifyTotp(secret, totpCode(secret, start + 2 * stepMs), start), null);
});

test('secret files live under instance/ with owner-only permissions; wider permissions are refused', (t) => {
  const dir = join(makeTempDir(t), 'totp');
  const store = new TotpSecretStore(dir);
  const secret = store.enroll('actor-owner');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'actor-owner')).mode & 0o777, 0o600);
  assert.equal(base32Encode(store.secretOf('actor-owner')), secret);
  assert.throws(() => store.enroll('actor-owner'), /EEXIST/, 'an enrolled secret is never overwritten');
  chmodSync(join(dir, 'actor-owner'), 0o644);
  assert.throws(() => store.secretOf('actor-owner'), /must be 0600/);
  assert.throws(() => store.secretOf('actor-nobody'), /no TOTP secret/);
  assert.throws(() => store.secretOf('../escape'), /invalid actor id/);
  assert.match(otpauthUri(secret, 'actor-owner'), /^otpauth:\/\/totp\/aot-growth-os%3Aactor-owner\?secret=[A-Z2-7]+&issuer=aot-growth-os&algorithm=SHA1&digits=6&period=30$/);
});
