// 시험용 가짜 SMTP 서버 (ADR-0017 §12). 127.0.0.1 의 임시 포트에서 `node:net` 으로 듣고, 받은 envelope 와 DATA 원문(점 채우기를 푼 것)을 기록한다.
// 대본으로 실패를 만든다: RCPT 거절(5.1.1), 인사말 421, STARTTLS 미제공, 끝 점 뒤 연결 끊기(응답 없음), 응답 지연, DATA 뒤 554.
// STARTTLS 는 키·인증서(PEM)를 주면 `tls.TLSSocket` 으로 올린다. 키 파일을 저장소에 두지 않는다(test-cert.ts 가 메모리에서 만든다).
import net, { type Server, type Socket } from 'node:net';
import tls from 'node:tls';

export interface FakeSmtpScript {
  /** 이 주소의 RCPT 는 `550 5.1.1` 로 거절한다 */
  rejectRcpt?: readonly string[];
  /** 주소별 RCPT 응답을 직접 정한다 (예: `{'a@example.com': '550 5.7.1 policy'}`, `'452 4.2.2 full'`) */
  rcptReplies?: Readonly<Record<string, string>>;
  /** 인사말 대신 `421` */
  greeting421?: boolean;
  /** EHLO 에 STARTTLS 를 내세우지 않는다 (키가 있어도) */
  noStarttls?: boolean;
  /** 끝 점을 받자마자 응답 없이 연결을 끊는다 */
  dropAfterDot?: boolean;
  /** DATA 끝 점 뒤 응답 코드 (기본 250). 예: 554 */
  finalReply?: string;
  /** 응답을 한 글자씩(작은 조각으로) 나눠 보낸다 */
  splitReplies?: boolean;
  /** 멀티라인 EHLO 응답을 줄마다 다른 조각으로 보낸다 */
  splitLines?: boolean;
  /** 처음부터 TLS (포트 465 방식). 키·인증서가 있어야 한다 */
  implicitTls?: boolean;
  /** 끝 점 뒤 250 과 221 을 한 조각으로 보낸다 (응답 둘이 한 조각에 올 수 있다) */
  finalPlusBye?: boolean;
  /** 모든 응답 전에 기다리는 시간(ms) */
  delayMs?: number;
  /** 끝 점 뒤 응답만 늦춘다 */
  finalDelayMs?: number;
  /** AUTH 를 광고하고 이 자격 증명만 받는다. 없으면 AUTH 를 광고하지 않는다 */
  auth?: { username: string; password: string };
  /** AUTH 를 TLS 가 아니어도 광고한다(클라이언트가 평문 AUTH 를 하는지 보는 시험용) */
  advertiseAuthInPlain?: boolean;
}

export interface FakeSmtpMessage {
  mailFrom: string;
  recipients: string[];
  /** DATA 원문 (점 채우기를 푼 것, 끝 점 제외) */
  data: string;
}

export interface FakeSmtpServer {
  readonly port: number;
  readonly host: string;
  /** 성립한 메시지 (끝 점을 받은 것; dropAfterDot 도 포함 — 서버는 받았다) */
  readonly messages: FakeSmtpMessage[];
  /** 받은 명령 이름 순서 (EHLO, STARTTLS, AUTH, MAIL, RCPT, DATA, RSET, QUIT). AUTH 는 인자를 기록하지 않는다 */
  readonly commands: string[];
  /** 연결 수 */
  connections(): number;
  close(): Promise<void>;
}

export async function startFakeSmtpServer(script: FakeSmtpScript = {}, tlsOptions?: { key: string; cert: string }): Promise<FakeSmtpServer> {
  const messages: FakeSmtpMessage[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => void setTimeout(resolve, ms));

  const serve = (initial: Socket): void => {
    let socket: Socket = initial;
    let secure = script.implicitTls === true;
    let mailFrom = '';
    let recipients: string[] = [];
    let inData = false;
    let dataBuf = '';
    let buffer = '';
    let authed = false;

    const reply = async (text: string, extraDelay = 0): Promise<void> => {
      const wait = (script.delayMs ?? 0) + extraDelay;
      if (wait > 0) await sleep(wait);
      if (socket.destroyed) return;
      if (script.splitReplies === true) {
        for (const ch of `${text}\r\n`) {
          socket.write(ch);
          await sleep(1);
        }
      } else if (script.splitLines === true) {
        for (const line of text.split('\r\n')) {
          socket.write(`${line}\r\n`);
          await sleep(5);
        }
      } else {
        socket.write(`${text}\r\n`);
      }
    };

    const handleLine = async (line: string): Promise<void> => {
      if (inData) {
        if (line === '.') {
          inData = false;
          messages.push({ mailFrom, recipients, data: dataBuf });
          dataBuf = '';
          if (script.dropAfterDot === true) {
            socket.destroy();
            return;
          }
          if (script.finalPlusBye === true) return void (await reply('250 2.0.0 queued\r\n221 2.0.0 bye', script.finalDelayMs ?? 0));
          await reply(`${script.finalReply ?? '250'} ${script.finalReply === undefined || script.finalReply.startsWith('2') ? '2.0.0 queued' : '5.0.0 refused'}`, script.finalDelayMs ?? 0);
          return;
        }
        dataBuf += `${line.startsWith('.') ? line.slice(1) : line}\r\n`;
        return;
      }
      const verb = line.split(' ')[0]!.toUpperCase();
      commands.push(verb === 'AUTH' ? 'AUTH' : verb);
      switch (verb) {
        case 'EHLO': {
          const lines = ['250-fake.example.test', '250-8BITMIME'];
          if (tlsOptions !== undefined && !secure && script.noStarttls !== true) lines.push('250-STARTTLS');
          if (script.auth !== undefined && (secure || script.advertiseAuthInPlain === true)) lines.push('250-AUTH PLAIN');
          lines.push('250 SIZE 1000000');
          await reply(lines.join('\r\n'));
          return;
        }
        case 'STARTTLS': {
          if (tlsOptions === undefined) return void (await reply('502 5.5.1 not available'));
          await reply('220 2.0.0 ready');
          const plain = socket;
          plain.removeAllListeners('data');
          const upgraded = new tls.TLSSocket(plain, { isServer: true, key: tlsOptions.key, cert: tlsOptions.cert });
          sockets.add(upgraded);
          upgraded.on('data', onData);
          upgraded.on('error', () => undefined);
          socket = upgraded;
          secure = true;
          buffer = '';
          return;
        }
        case 'AUTH': {
          if (script.auth === undefined) return void (await reply('504 5.7.4 no auth'));
          const token = line.split(' ')[2] ?? '';
          const [, user, pass] = Buffer.from(token, 'base64').toString('utf8').split('\0');
          authed = user === script.auth.username && pass === script.auth.password;
          await reply(authed ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
          return;
        }
        case 'MAIL':
          mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? '';
          recipients = [];
          await reply('250 2.1.0 ok');
          return;
        case 'RCPT': {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          const custom = script.rcptReplies?.[address];
          if (custom !== undefined) return void (await reply(custom));
          if (script.rejectRcpt?.includes(address)) return void (await reply('550 5.1.1 no such user'));
          recipients.push(address);
          await reply('250 2.1.5 ok');
          return;
        }
        case 'DATA':
          inData = true;
          dataBuf = '';
          await reply('354 go ahead');
          return;
        case 'RSET':
          mailFrom = '';
          recipients = [];
          await reply('250 2.0.0 ok');
          return;
        case 'QUIT':
          await reply('221 2.0.0 bye');
          socket.end();
          return;
        default:
          await reply('500 5.5.2 unknown');
      }
    };

    // 한 번에 한 줄씩 순서대로 처리한다 (reply 지연 중에 온 줄이 앞지르지 않게)
    let chain: Promise<void> = Promise.resolve();
    function onData(chunk: Buffer): void {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        chain = chain.then(() => handleLine(line)).catch(() => undefined);
      }
    }
    sockets.add(socket);
    socket.on('data', onData);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    chain = chain.then(() => reply(script.greeting421 === true ? '421 4.3.2 busy' : '220 fake.example.test ESMTP'));
  };

  const onConnection = (socket: Socket): void => {
    connections += 1;
    serve(socket);
  };
  const server: Server = script.implicitTls === true && tlsOptions !== undefined
    ? tls.createServer({ key: tlsOptions.key, cert: tlsOptions.cert }, onConnection)
    : net.createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake smtp: no port');
  return {
    port: address.port, host: '127.0.0.1', messages, commands, connections: () => connections,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
