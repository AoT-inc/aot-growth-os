// 사람 승인 채널 (trust-boundaries §3.1, a0-decisions D5): 승인 CLI ↔ 데몬의 승인 엔진, Unix 도메인 소켓.
// 형식: 요청 한 줄(JSON) → 응답 한 줄(JSON), 연결당 요청 하나.
//
// Phase A 편차 (trust-boundaries §3.1, ADR-0013 Amendment): Node 는 피어 자격 증명(SO_PEERCRED / getpeereid)을
// 노출하지 않아 접속한 프로세스의 UID 를 네이티브 애드온 없이 확인할 수 없다. 대신
//  - 소켓은 데몬 사용자 소유의 0700 디렉터리 안에 두고 소켓 파일은 0600 으로 만든다 (다른 UID 는 OS 가 connect 를 막는다)
//  - 디렉터리가 데몬 사용자 소유가 아니거나 그룹·다른 사용자에게 열려 있으면 시작하지 않는다
// 같은 UID 의 다른 프로세스는 막지 못한다. 그래서 에이전트를 별도 UID·컨테이너로 돌리는 Q26 이 전제다.
// 요청 본문(특히 TOTP 코드)은 로그에 남기지 않는다.
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

export const MAX_REQUEST_BYTES = 512 * 1024;
const IDLE_TIMEOUT_MS = 10_000;

export class ApprovalChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalChannelError';
  }
}

/** 소켓 디렉터리 확인: 이 프로세스 사용자 소유, 0700(그룹·다른 사용자 권한 없음). 없으면 0700 으로 만든다. */
export function prepareSocketDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(dir);
  if (!stat.isDirectory()) throw new ApprovalChannelError(`${dir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new ApprovalChannelError('the approval socket directory must be owned by the daemon user');
  if ((stat.mode & 0o077) !== 0) throw new ApprovalChannelError('the approval socket directory must be 0700 (no group/other access)');
}

export interface ApprovalServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export type ApprovalHandler = (request: unknown) => unknown;

export async function startApprovalServer(options: { socketPath: string; handle: ApprovalHandler; onError?: (error: unknown) => void }): Promise<ApprovalServer> {
  const { socketPath } = options;
  prepareSocketDir(dirname(socketPath));
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new ApprovalChannelError(`${socketPath} exists and is not a socket`);
    unlinkSync(socketPath); // 이전 데몬이 남긴 소켓
  }
  const server: Server = createServer((socket) => serve(socket, options.handle, options.onError));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  return {
    socketPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function serve(socket: Socket, handle: ApprovalHandler, onError?: (error: unknown) => void): void {
  let buffer = '';
  let done = false;
  socket.setEncoding('utf8');
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  const reply = (value: unknown) => {
    done = true;
    socket.end(`${JSON.stringify(value)}\n`);
  };
  socket.on('data', (chunk: string) => {
    if (done) return;
    buffer += chunk;
    if (buffer.length > MAX_REQUEST_BYTES) return reply({ ok: false, error: 'request too large' });
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    let request: unknown;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      return reply({ ok: false, error: 'request must be one line of JSON' });
    }
    done = true; // 처리 중에 더 온 데이터로 같은 요청을 두 번 처리하지 않는다
    // 처리기는 동기일 수도, Promise 를 돌려줄 수도 있다 (상품 등록 채널은 근거 본문을 읽느라 비동기다)
    Promise.resolve().then(() => handle(request)).then(reply, (error: unknown) => {
      onError?.(error instanceof Error ? error.name : 'error');
      reply({ ok: false, error: 'internal error in the approval engine' });
    });
  });
  socket.on('error', () => socket.destroy());
}

/** 승인 CLI 쪽: 요청 하나를 보내고 응답 하나를 받는다. */
export function sendApprovalRequest(socketPath: string, request: unknown, timeoutMs = IDLE_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => socket.destroy(new ApprovalChannelError('approval channel timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch {
        reject(new ApprovalChannelError('malformed response from the approval channel'));
      }
    });
    socket.on('error', reject);
  });
}
