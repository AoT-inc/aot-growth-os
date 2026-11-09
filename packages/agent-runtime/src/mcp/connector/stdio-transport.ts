// stdio 전송: 서버를 자식 프로세스로 띄우고 줄 단위 JSON 으로 통신한다. 서버 stderr 는 읽어서 버린다(막히지 않게 비운다).
// 환경은 `PATH` 와 오너가 `env_from` 으로 지정한 변수뿐이다 — 커넥터의 나머지 환경(다른 비밀값 포함)은 서버에 주지 않는다.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { abortError, isRecord, type JsonRpcInbound, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse, type RequestOptions, type Transport } from './transport.ts';
import { ConnectorFailure, MAX_LINE_BYTES } from './wire.ts';

export interface StdioTransportOptions {
  command: string;
  args: readonly string[];
  /** 서버가 받을 환경 (이미 값이 채워진 것) */
  env: Readonly<Record<string, string>>;
}

interface Pending { resolve(response: JsonRpcResponse): void; reject(error: unknown): void }

export function createStdioTransport(options: StdioTransportOptions): Transport {
  let child: ChildProcessWithoutNullStreams | null = null;
  const pending = new Map<number, Pending>();
  let messageHandler: (message: JsonRpcInbound) => void = () => undefined;
  let closedHandler: () => void = () => undefined;

  const failAll = (error: ConnectorFailure): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const start = (): ChildProcessWithoutNullStreams => {
    if (child !== null) return child;
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(options.command, [...options.args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...options.env } });
    } catch (error) {
      throw new ConnectorFailure('spawn_failed', `could not start the MCP server: ${error instanceof Error ? error.message : 'unknown'}`, true);
    }
    child = proc;
    let buffer = Buffer.alloc(0);
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) break;
        const line = buffer.subarray(0, newline).toString('utf8').trim();
        buffer = buffer.subarray(newline + 1);
        if (line !== '') dispatchLine(line);
      }
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = Buffer.alloc(0);
        proc.kill('SIGKILL'); // 개행 없이 끝없이 쓰는 서버
      }
    });
    proc.stderr.on('data', () => undefined);
    proc.stdin.on('error', () => undefined);
    proc.on('error', (error) => {
      if (child === proc) child = null;
      failAll(new ConnectorFailure('spawn_failed', `MCP server process error: ${error.message}`, true));
      closedHandler();
    });
    proc.on('exit', () => {
      if (child === proc) child = null;
      failAll(new ConnectorFailure('server_exit', 'the MCP server process exited', false));
      closedHandler();
    });
    return proc;
  };

  const dispatchLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // 서버가 JSON 이 아닌 줄(로그 등)을 stdout 에 쓴 경우는 무시한다
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const inbound = message as JsonRpcInbound;
      const isResponse = inbound.method === undefined && (inbound.result !== undefined || inbound.error !== undefined);
      if (isResponse && typeof inbound.id === 'number') {
        const entry = pending.get(inbound.id);
        if (entry) {
          pending.delete(inbound.id);
          entry.resolve(inbound as JsonRpcResponse);
        }
      } else if (typeof inbound.method === 'string') {
        messageHandler(inbound);
      }
    }
  };

  const write = (message: unknown): void => {
    const proc = start();
    if (!proc.stdin.writable) throw new ConnectorFailure('server_exit', 'the MCP server input is closed', false);
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return {
    request(message: JsonRpcRequest, requestOptions: RequestOptions = {}): Promise<JsonRpcResponse> {
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        const { signal, timeoutMs } = requestOptions;
        if (signal?.aborted) {
          reject(abortError(signal));
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          pending.delete(message.id);
        };
        const onAbort = (): void => {
          cleanup();
          reject(abortError(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            cleanup();
            reject(new ConnectorFailure('timeout', `no response within ${timeoutMs} ms`, false));
          }, timeoutMs);
        }
        pending.set(message.id, {
          resolve: (response) => { cleanup(); resolve(response); },
          reject: (error) => { cleanup(); reject(error); },
        });
        try {
          write(message);
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
    },
    notify(message: JsonRpcNotification): Promise<void> {
      try {
        write(message);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('write failed'));
      }
    },
    reply(message: JsonRpcResponse): Promise<void> {
      try {
        write(message);
        return Promise.resolve();
      } catch {
        return Promise.resolve();
      }
    },
    onMessage: (handler) => { messageHandler = handler; },
    onClosed: (handler) => { closedHandler = handler; },
    setProtocolVersion: () => undefined,
    close(): Promise<void> {
      const proc = child;
      child = null;
      if (proc === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = (): void => resolve();
        proc.once('exit', done);
        try {
          proc.stdin.end();
        } catch { /* 이미 닫힘 */ }
        setTimeout(() => proc.kill('SIGKILL'), 1000).unref();
        proc.kill('SIGTERM');
      });
    },
  };
}
