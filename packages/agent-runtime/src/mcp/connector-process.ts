// 커넥터 프로세스 시작 (ADR-0018 §1, §5). `process.execPath` 로 connector/main.ts 를 띄운다(Node 24 는 .ts 를 바로 실행한다).
// 환경은 `PATH` 와 그 사이트의 비밀 변수뿐이다: 데몬 환경을 물려주지 않는다. 줄 하나 상한(8 MiB)을 넘으면 프로세스를 죽인다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createLineReader } from '../line-reader.ts';

import { MAX_LINE_BYTES } from './connector/wire.ts';

/** 커넥터와 줄 단위 JSON 으로 통신하는 연결. 시험은 이 모양의 가짜를 주입할 수 있다 */
export interface ConnectorLink {
  send(value: unknown): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: () => void): void;
  onStderr(handler: (text: string) => void): void;
  kill(): void;
}

export type ConnectorSpawner = () => ConnectorLink;

export const CONNECTOR_ENTRY = fileURLToPath(new URL('./connector/main.ts', import.meta.url));

/** @param secretEnv 이 사이트의 비밀 변수(이름 → 값). 이 밖의 환경은 넘기지 않는다 */
export function spawnConnectorProcess(secretEnv: Readonly<Record<string, string>>, entry: string = CONNECTOR_ENTRY): ConnectorLink {
  const env: Record<string, string> = { ...secretEnv };
  if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let lineHandler: (line: string) => void = () => undefined;
  let exitHandler: () => void = () => undefined;
  let stderrHandler: (text: string) => void = () => undefined;
  let exited = false;
  const reader = createLineReader(MAX_LINE_BYTES);
  child.stdout.on('data', (chunk: Buffer) => {
    for (const event of reader.push(chunk)) {
      if (event.kind === 'line') lineHandler(event.line);
      else child.kill('SIGKILL'); // 줄 하나가 상한을 넘었다: 죽이고 호스트가 다시 띄운다
    }
  });
  child.stderr.on('data', (chunk: Buffer) => stderrHandler(chunk.toString('utf8').slice(0, 1000)));
  child.stdin.on('error', () => undefined);
  const done = (): void => {
    if (exited) return;
    exited = true;
    exitHandler();
  };
  child.on('exit', done);
  child.on('error', done);
  return {
    send(value) {
      if (exited || !child.stdin.writable) throw new Error('the connector process is not running');
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    onLine: (handler) => { lineHandler = handler; },
    onExit: (handler) => { exitHandler = handler; },
    onStderr: (handler) => { stderrHandler = handler; },
    kill() {
      if (exited) return;
      child.kill('SIGKILL');
    },
  };
}
