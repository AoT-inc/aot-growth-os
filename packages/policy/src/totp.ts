// TOTP (RFC 6238, HMAC-SHA1, 30초 시간창, 6자리) — 위험 변경의 실행 직전 사람 재인증 (a0-decisions D5).
// 의존성 없이 node:crypto 로 구현한다. 비밀은 instance/ 의 파일(0600)에만 있다. 비밀과 입력 코드는 로그·DB 에 남기지 않는다.
// 재사용 방지(같은 시간창 코드 재입력 거부)는 승인 엔진이 human_reauth 로 한다 (approval.ts).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 시계 차이 허용: 앞뒤 한 시간창 */
export const TOTP_WINDOW = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new TotpSecretError('secret is not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP(RFC 4226) 값. TOTP 는 counter = 시간창 번호. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

export function totpCode(secret: Uint8Array, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(nowMs), digits);
}

/** 코드가 맞으면 일치한 시간창 번호, 아니면 null. 비교는 상수 시간. */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number, window = TOTP_WINDOW): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step += 1) {
    if (step < 0) continue;
    // 모든 후보를 끝까지 비교한다 (일치 위치로 시간 차이가 생기지 않게).
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given) && matched === null) matched = step;
  }
  return matched;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export class TotpSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpSecretError';
  }
}

const ACTOR_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * instance/totp/<actor id> 파일(base32 한 줄)에 둔 사람별 TOTP 비밀. 파일이 그룹·다른 사용자에게 열려 있으면 쓰지 않는다.
 */
export class TotpSecretStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  #path(actorId: string): string {
    if (!ACTOR_FILE.test(actorId)) throw new TotpSecretError(`invalid actor id for a TOTP secret file`);
    return join(this.dir, actorId);
  }

  has(actorId: string): boolean {
    return existsSync(this.#path(actorId));
  }

  /** 비밀을 읽는다. 없거나 권한이 넓으면 TotpSecretError. */
  secretOf(actorId: string): Buffer {
    const path = this.#path(actorId);
    if (!existsSync(path)) throw new TotpSecretError(`no TOTP secret is enrolled for actor '${actorId}'`);
    if ((statSync(path).mode & 0o077) !== 0) throw new TotpSecretError(`TOTP secret file for '${actorId}' must be 0600 (owner only)`);
    return base32Decode(readFileSync(path, 'utf8').trim());
  }

  /** 새 비밀을 만들어 저장한다(0600). 이미 있으면 덮어쓰지 않는다. 돌려준 값은 인증 앱 등록에 한 번만 쓴다. */
  enroll(actorId: string, secret = generateTotpSecret()): string {
    const path = this.#path(actorId);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if ((statSync(this.dir).mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
    writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    return secret;
  }
}

/** 인증 앱 등록용 URI. 비밀이 들어 있으므로 사람의 화면에 한 번만 보여 주고 어디에도 기록하지 않는다. */
export function otpauthUri(secret: string, label: string, issuer = 'aot-growth-os'): string {
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?${params.toString()}`;
}
