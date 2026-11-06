// 폼 nonce: 세션 키(시작 토큰에서 유도, 메모리에만 있다)로 만든 HMAC-SHA256(버튼|결정 키|지문|발급 시각). 30분 안에 한 번만 쓸 수 있다.
// 다른 대상·다른 버튼·다른 지문·다른 시각으로는 맞지 않고, 다른 서버 실행(다른 토큰)의 nonce 도 맞지 않는다.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const NONCE_TTL_MS = 30 * 60_000;

export type NonceCheck = 'ok' | 'bad' | 'expired' | 'used';

export class FormGuard {
  readonly #key: Buffer;
  readonly #ttlMs: number;
  /** 쓴 nonce → 쓴 시각. 만료된 것은 치운다(만료된 nonce 는 어차피 거부된다) */
  readonly #used = new Map<string, { at: number; resultId?: string }>();

  constructor(key: Buffer | string, ttlMs = NONCE_TTL_MS) {
    this.#key = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
    this.#ttlMs = ttlMs;
  }

  #mac(verb: string, key: string, hash: string, issued: string): string {
    return createHmac('sha256', this.#key).update(JSON.stringify(['decide', verb, key, hash, issued])).digest('hex');
  }

  issue(verb: string, key: string, hash: string, nowMs: number): { issued: string; nonce: string } {
    const issued = String(nowMs);
    return { issued, nonce: this.#mac(verb, key, hash, issued) };
  }

  /** 소비하지 않고 확인 */
  check(fields: { verb: string; key: string; hash: string; issued: string; nonce: string }, nowMs: number): NonceCheck {
    if (!/^\d{1,16}$/.test(fields.issued) || !/^[0-9a-f]{64}$/.test(fields.nonce)) return 'bad';
    const expected = Buffer.from(this.#mac(fields.verb, fields.key, fields.hash, fields.issued), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(fields.nonce, 'hex'))) return 'bad';
    const issuedMs = Number(fields.issued);
    if (issuedMs > nowMs + 60_000 || nowMs - issuedMs > this.#ttlMs) return 'expired';
    return this.#used.has(fields.nonce) ? 'used' : 'ok';
  }

  /** 한 번 쓰면 끝 */
  consume(nonce: string, nowMs: number, resultId?: string): void {
    for (const [value, item] of this.#used) if (nowMs - item.at > this.#ttlMs + 60_000) this.#used.delete(value);
    const earlier = this.#used.get(nonce);
    this.#used.set(nonce, { at: earlier?.at ?? nowMs, ...(resultId === undefined ? {} : { resultId }) });
  }

  /** 이 nonce 로 이미 보낸 요청의 결과 id (이중 전송으로 같은 결과를 다시 보여 줄 때) */
  resultOf(nonce: string): string | undefined {
    return this.#used.get(nonce)?.resultId;
  }
}
