// SMTP 제출 클라이언트 (ADR-0017 §2, docs/plans/mail-tool.md §6·§9). `node:net`/`node:tls` 만 쓴다(새 의존성 없음).
//  - 보안: `starttls`(587, 서버가 STARTTLS 를 내세우지 않으면 평문으로 내려가지 않고 `tls` 단계에서 거절), `tls`(465), `none`(루프백 시험·로컬 릴레이, 자격 증명과 함께 쓰지 못한다).
//    AUTH PLAIN 은 TLS 위에서만 한다. 인증서 검증은 끄지 않는다(시험용 `ca` 만 받는다).
//  - 결과 규칙(RFC 5321): 데이터의 끝 점(`.`)을 쓰기 전에는 메시지가 성립하지 않으므로 어떤 실패든 `rejected` 다. 끝 점을 쓴 뒤 응답 전에 끊기거나 시간이 넘으면 던진다(결과를 알 수 없음 → 원장 `unknown`).
//    끝 점 뒤 2xx 는 `accepted`, 4xx/5xx 는 `rejected`(단계 data).
//  - RCPT 가 하나라도 거절되면 일부만 보내지 않고 RSET+QUIT 후 `rejected`(단계 envelope). 확장 상태 5.1.x 로 거절된 주소는 `bouncedRecipients` 에 담는다.
//  - 오류 문자열·코드에는 단계와 숫자 코드만 담는다. 서버 응답 원문, AUTH 줄, 자격 증명은 오류·로그 어디에도 남기지 않고 대화 기록도 남기지 않는다.
import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import { inspect } from 'node:util';

import type { MailRejectStage, MailSendResult, MailTransport, OutboundMail } from '@aot/domain';

export type SmtpSecurity = 'starttls' | 'tls' | 'none';

export interface SmtpTimeouts { connectMs: number; commandMs: number; totalMs: number }

export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = { connectMs: 10_000, commandMs: 30_000, totalMs: 60_000 };
/** 전체 전송 시간 상한. lease 기본 90초보다 짧아 전송 중 lease 를 잃지 않는다 */
export const MAX_SMTP_TOTAL_MS = 60_000;
/** 끝 점 뒤 최종 응답을 위해 따로 떼어 두는 시간 (commandMs 가 더 작으면 그만큼) */
export const POST_DOT_RESERVE_MS = 30_000;

export interface SmtpTransportOptions {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** AUTH PLAIN 자격 증명 (둘 다 있거나 둘 다 없다). `security: 'none'` 과 함께 쓰지 못한다 */
  username?: string;
  password?: string;
  /** 서버 인증서를 검증할 CA (PEM). 시험용이다. 없으면 시스템 CA */
  ca?: string;
  /** TLS 서버 이름(SNI·인증서 대조). 기본은 host */
  servername?: string;
  /** EHLO 에 쓰는 이름. 기본 `localhost` */
  ehloName?: string;
  timeouts?: Partial<SmtpTimeouts>;
}

/** 단계와 코드가 확실한 실패 (보내지 않았음이 확실하거나, 서버가 명확히 거절) */
class SmtpReject extends Error {
  readonly stage: MailRejectStage;
  readonly code: string;
  readonly bounced: string[];
  constructor(stage: MailRejectStage, code: string, bounced: string[] = []) {
    super(`smtp ${stage}: ${code}`);
    this.name = 'SmtpReject';
    this.stage = stage;
    this.code = code;
    this.bounced = bounced;
  }
}

/** 소켓·시간 오류 (서버 문구가 없다). 어느 단계에서 났는지는 호출 쪽이 정한다 */
class NetFail extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`smtp network: ${code}`);
    this.name = 'NetFail';
    this.code = code;
  }
}

const safeCode = (value: unknown): string => (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'error');

interface Reply { code: number; enhanced: string | null; lines: string[] }

const ENHANCED = /^([245])\.\d{1,3}\.\d{1,3}(?=\s|$)/;
const MAX_REPLY_BYTES = 64 * 1024;

/** 소켓 하나의 응답 읽기. 멀티라인 응답을 모아 한 번에 돌려준다 */
class Conn {
  readonly socket: Socket;
  private buffer = '';
  private failure: NetFail | null = null;
  private wake: (() => void) | null = null;
  private released = false;
  private readonly onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('latin1');
    if (this.buffer.length > MAX_REPLY_BYTES) this.fail(new NetFail('reply_too_large'));
    this.wake?.();
  };
  private readonly onError = (error: Error): void => this.fail(new NetFail(safeCode((error as { code?: unknown }).code)));
  private readonly onClose = (): void => this.fail(new NetFail('closed'));

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  fail(error: NetFail): void {
    if (this.failure === null && !this.released) this.failure = error;
    this.socket.destroy();
    this.wake?.();
  }

  /** TLS 로 올리기 전에 이 연결의 수신 처리를 거둔다(오류 처리는 남겨 미처리 오류가 되지 않게 한다) */
  release(): void {
    this.released = true;
    this.socket.off('data', this.onData);
    this.socket.off('close', this.onClose);
    this.socket.off('error', this.onError);
    this.socket.on('error', () => undefined);
  }

  write(data: string | Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure !== null) return reject(this.failure);
      this.socket.write(data, (error) => (error ? reject(new NetFail(safeCode((error as { code?: unknown }).code))) : resolve()));
    });
  }

  /** 응답 하나. `ms` 안에 완성되지 않으면 `timeout` */
  async reply(ms: number): Promise<Reply> {
    const deadline = Date.now() + ms;
    for (;;) {
      const parsed = this.parse();
      if (parsed !== null) return parsed;
      if (this.failure !== null) throw this.failure;
      const left = deadline - Date.now();
      if (left <= 0) throw new NetFail('timeout');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        function done(): void { clearTimeout(timer); resolve(); }
        this.wake = done;
      });
      this.wake = null;
    }
  }

  private parse(): Reply | null {
    const lines: string[] = [];
    let rest = this.buffer;
    for (;;) {
      const end = rest.indexOf('\n');
      if (end < 0) return null;
      const line = rest.slice(0, end).replace(/\r$/, '');
      rest = rest.slice(end + 1);
      const match = /^(\d{3})([ -]|$)(.*)$/.exec(line);
      if (match === null) throw new NetFail('malformed_reply');
      lines.push(line);
      if (match[2] !== '-') {
        this.buffer = rest;
        const text = match[3] ?? '';
        const enhanced = ENHANCED.exec(text)?.[0] ?? null;
        return { code: Number(match[1]), enhanced, lines };
      }
    }
  }
}

const codeOf = (reply: Reply): string => `smtp_${reply.code}${reply.enhanced === null ? '' : `_${reply.enhanced}`}`;
/** 받는 사람 주소가 없거나 잘못됐다는 확장 상태: 5.1.1 사서함 없음, 5.1.2 도메인 없음, 5.1.3 주소 형식, 5.1.6 이사함, 5.1.10 받는 사람 주소 없음 */
const RECIPIENT_BOUNCE_CODES: readonly string[] = ['5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10'];
const ADDRESS_OK = /^[^\s<>\r\n]+@[^\s<>\r\n]+$/;
// 본문은 ASCII + CRLF 만 허용한다 (bare LF/CR 은 SMTP smuggling 의 재료다)
const isAscii = (text: string): boolean => { for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 0x7f) return false; return true; };

const dotStuff = (raw: string): string => raw.replace(/^\./, '..').replace(/\r\n\./g, '\r\n..');

function wellFormed(raw: string): boolean {
  if (!isAscii(raw) || raw.includes('\0')) return false;
  return !/(^|[^\r])\n/.test(raw) && !/\r(?!\n)/.test(raw);
}

export function createSmtpTransport(options: SmtpTransportOptions): MailTransport {
  const timeouts: SmtpTimeouts = { ...DEFAULT_SMTP_TIMEOUTS, ...options.timeouts };
  const { host, port, security } = options;
  const credentials = options.username !== undefined && options.password !== undefined ? { username: options.username, password: options.password } : null;
  const ehloName = options.ehloName ?? 'localhost';
  const servername = options.servername ?? host;

  const transport: MailTransport = {
    name: 'smtp',
    idempotency: { supported: false },
    async send(mail: OutboundMail): Promise<MailSendResult> {
      let stage: MailRejectStage = 'config';
      let dotWritten = false;
      let conn: Conn | null = null;
      const rejected = (s: MailRejectStage, code: string, bounced: string[] = []): MailSendResult => ({ status: 'rejected', stage: s, code, bouncedRecipients: bounced });
      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      let preTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // 연결하기 전에 확인한다: 평문으로 자격 증명이 나갈 길, 잘못된 주소·메시지 모양은 아무것도 연결하지 않고 거절한다
        if (security === 'none' && credentials !== null) return rejected('config', 'auth_without_tls');
        if (!ADDRESS_OK.test(mail.envelopeFrom) || mail.recipients.length === 0 || !mail.recipients.every((r) => ADDRESS_OK.test(r))) return rejected('config', 'bad_address');
        if (!wellFormed(mail.raw)) return rejected('config', 'bad_message');

        const total = Math.min(timeouts.totalMs, MAX_SMTP_TOTAL_MS);
        // 끝 점 뒤 응답을 기다릴 시간을 따로 떼어 둔다(reserve): 끝 점 전 단계는 total - reserve 안에 끝나야 하고(넘으면 끝 점을 쓰기 전이므로 rejected),
        // 끝 점을 쓴 뒤의 응답 대기는 남은 시간이 얼마든 reserve 이상(commandMs 이하)을 보장받는다. 전체 상한(total ≤ 60초)은 그대로다.
        const reserve = Math.min(POST_DOT_RESERVE_MS, timeouts.commandMs, total);
        const preDotLimit = total - reserve;
        const startedAt = Date.now();
        preTimer = setTimeout(() => { if (!dotWritten) conn?.fail(new NetFail('timeout')); }, preDotLimit);
        totalTimer = setTimeout(() => conn?.fail(new NetFail('timeout')), total);
        const elapsed = (): number => Date.now() - startedAt;
        const cmdMs = (): number => Math.max(1, Math.min(timeouts.commandMs, (dotWritten ? Math.max(reserve, total - elapsed()) : preDotLimit - elapsed())));

        // ===== 연결 =====
        stage = security === 'tls' ? 'tls' : 'connect';
        conn = new Conn(await connectSocket({ host, port, security, ca: options.ca, servername }, timeouts.connectMs));
        stage = 'connect';
        const greeting = await conn.reply(cmdMs());
        if (greeting.code !== 220) return rejected('connect', codeOf(greeting));

        const command = async (line: string, ms = cmdMs()): Promise<Reply> => {
          await conn!.write(`${line}\r\n`);
          return conn!.reply(ms);
        };
        const ehlo = async (): Promise<Set<string>> => {
          const r = await command(`EHLO ${ehloName}`);
          if (r.code !== 250) throw new SmtpReject(stage, codeOf(r));
          return new Set(r.lines.slice(1).map((l) => l.slice(4).trim().toUpperCase()));
        };
        let capabilities = await ehlo();

        // ===== STARTTLS =====
        if (security === 'starttls') {
          stage = 'tls';
          if (!capabilities.has('STARTTLS')) return rejected('tls', 'starttls_unavailable'); // 평문으로 내려가지 않는다
          const go = await command('STARTTLS');
          if (go.code !== 220) return rejected('tls', codeOf(go));
          conn.release();
          const upgraded = await upgradeToTls(conn.socket, { servername, ca: options.ca }, timeouts.connectMs);
          conn = new Conn(upgraded);
          capabilities = await ehlo();
        }

        // ===== AUTH PLAIN (TLS 위에서만) =====
        if (credentials !== null) {
          stage = 'auth';
          const mechanisms = [...capabilities].find((c) => c.startsWith('AUTH ') || c.startsWith('AUTH='));
          if (mechanisms === undefined || !mechanisms.split(/[\s=]+/).includes('PLAIN')) return rejected('auth', 'auth_unavailable');
          const token = Buffer.from(`\0${credentials.username}\0${credentials.password}`, 'utf8').toString('base64');
          const auth = await command(`AUTH PLAIN ${token}`);
          if (auth.code !== 235) return rejected('auth', codeOf(auth));
        }

        // ===== envelope =====
        stage = 'envelope';
        const from = await command(`MAIL FROM:<${mail.envelopeFrom}>`);
        if (from.code !== 250) return rejected('envelope', codeOf(from));
        const failed: Reply[] = [];
        const bounced: string[] = [];
        for (const recipient of mail.recipients) {
          const r = await command(`RCPT TO:<${recipient}>`);
          if (r.code === 250 || r.code === 251) continue;
          failed.push(r);
          // 받는 사람 주소 자체가 없다는 확장 상태만 반송으로 센다. 5.1.7·5.1.8(보내는 사람 주소 거절)·5.1.0 은 받는 사람 탓이 아니다
          if (r.code >= 500 && r.enhanced !== null && RECIPIENT_BOUNCE_CODES.includes(r.enhanced)) bounced.push(recipient);
        }
        if (failed.length > 0) {
          await bestEffortReset(conn);
          return rejected('envelope', codeOf(failed[0]!), bounced);
        }

        // ===== DATA =====
        stage = 'data';
        const data = await command('DATA');
        if (data.code !== 354) {
          await bestEffortReset(conn);
          return rejected('data', codeOf(data));
        }
        const body = dotStuff(mail.raw);
        await conn.write(body.endsWith('\r\n') ? body : `${body}\r\n`);
        // 끝 점을 쓰는 순간부터 메시지가 성립했을 수 있다: 이후의 실패는 `rejected` 가 아니라 던진다
        dotWritten = true;
        if (preTimer !== undefined) clearTimeout(preTimer);
        await conn.write('.\r\n');
        const final = await conn.reply(cmdMs());
        if (final.code >= 200 && final.code < 300) {
          void conn.write('QUIT\r\n').catch(() => undefined);
          return { status: 'accepted', providerMessageId: null };
        }
        if (final.code >= 400) return rejected('data', codeOf(final));
        throw new Error('smtp data: unexpected reply after end of data'); // 1xx/3xx: 성립 여부를 알 수 없다
      } catch (error) {
        if (dotWritten) {
          // 서버 문구·자격 증명 없이 사유 코드만 담는다
          const reason = error instanceof NetFail ? error.code : 'error';
          throw new Error(`smtp data: outcome unknown after end of data (${reason})`);
        }
        if (error instanceof SmtpReject) return rejected(error.stage, error.code, error.bounced);
        if (error instanceof NetFail) return rejected(stage, `net_${error.code}`);
        const code = safeCode((error as { code?: unknown }).code);
        return rejected(stage, `net_${code}`); // TLS 인증서 오류 등: 코드 이름뿐이다
      } finally {
        if (totalTimer !== undefined) clearTimeout(totalTimer);
        if (preTimer !== undefined) clearTimeout(preTimer);
        conn?.socket.destroy();
      }
    },
  };
  // 설정(자격 증명 포함)이 로그·직렬화로 드러나지 않게 한다
  Object.defineProperty(transport, inspect.custom, { value: () => `SmtpTransport(${host}:${port}, ${security})`, enumerable: false });
  Object.defineProperty(transport, 'toString', { value: () => `SmtpTransport(${host}:${port})`, enumerable: false });
  return transport;
}

async function bestEffortReset(conn: Conn): Promise<void> {
  try {
    await conn.write('RSET\r\n');
    await conn.reply(2_000);
    await conn.write('QUIT\r\n');
  } catch {
    // 정리일 뿐이다: 이미 거절을 돌려주기로 했다
  }
}

function connectSocket(
  o: { host: string; port: number; security: SmtpSecurity; ca: string | undefined; servername: string },
  connectMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket: Socket = o.security === 'tls'
      ? tls.connect({ host: o.host, port: o.port, servername: o.servername, minVersion: 'TLSv1.2', ...(o.ca === undefined ? {} : { ca: o.ca }) })
      : net.connect({ host: o.host, port: o.port });
    const timer = setTimeout(() => finish(new NetFail('timeout')), connectMs);
    const event = o.security === 'tls' ? 'secureConnect' : 'connect';
    function finish(error?: NetFail): void {
      clearTimeout(timer);
      socket.off(event, onOk);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    }
    const onOk = (): void => finish();
    const onError = (e: Error): void => finish(new NetFail(safeCode((e as { code?: unknown }).code)));
    socket.once(event, onOk);
    socket.once('error', onError);
  });
}

function upgradeToTls(plain: Socket, o: { servername: string; ca: string | undefined }, connectMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: plain, servername: o.servername, minVersion: 'TLSv1.2', ...(o.ca === undefined ? {} : { ca: o.ca }) });
    const timer = setTimeout(() => finish(new NetFail('timeout')), connectMs);
    function finish(error?: NetFail): void {
      clearTimeout(timer);
      socket.off('secureConnect', onOk);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    }
    const onOk = (): void => finish();
    const onError = (e: Error): void => finish(new NetFail(safeCode((e as { code?: unknown }).code)));
    socket.once('secureConnect', onOk);
    socket.once('error', onError);
  });
}
