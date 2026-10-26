// 가짜 docker 프로세스 포트 (단위 시험용). 실제 docker 를 쓰지 않고 `ProcessPort` 를 대신해
//  - spawn 된 `docker run -i` 프로세스(FakeProcess): 시험이 stdout/stderr/close 를 직접 내보내고, stdin 에 쓴 프레임을 읽는다
//  - exec 호출(`docker kill`·`rm`·`ps`·`version`): 호출 기록과 대본(응답)
// 기본 대본: `docker kill <이름>` 은 성공하고 곧 가장 최근 FakeProcess 가 137 로 닫힌다(컨테이너가 죽으면 CLI 도 끝난다). `docker rm -f` 는 "No such container".
import type { ExecResult, ProcessPort, SpawnedProcess } from '@aot/agent-runtime';

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 조건이 참이 될 때까지 이벤트 루프를 돌린다(가상 시간은 흐르지 않는다) */
export async function until(condition: () => boolean, what = 'condition', rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

export class FakeProcess implements SpawnedProcess {
  readonly stdinText: string[] = [];
  stdinEnded = false;
  readonly signals: string[] = [];
  #stdout: ((chunk: Buffer) => void)[] = [];
  #stderr: ((chunk: Buffer) => void)[] = [];
  #close: ((code: number | null, signal: string | null) => void)[] = [];
  #error: ((error: Error) => void)[] = [];
  closed = false;
  /** SIGKILL 을 받으면 이 신호로 닫힌다 */
  closeOnKill = true;

  writeStdin(text: string): void { this.stdinText.push(text); }
  endStdin(): void { this.stdinEnded = true; }
  onStdout(listener: (chunk: Buffer) => void): void { this.#stdout.push(listener); }
  onStderr(listener: (chunk: Buffer) => void): void { this.#stderr.push(listener); }
  onClose(listener: (code: number | null, signal: string | null) => void): void { this.#close.push(listener); }
  onError(listener: (error: Error) => void): void { this.#error.push(listener); }
  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal);
    if (signal === 'SIGKILL' && this.closeOnKill) this.emitClose(null, 'SIGKILL');
  }

  emitStdout(data: string | Buffer): void { for (const l of this.#stdout) l(typeof data === 'string' ? Buffer.from(data, 'utf8') : data); }
  emitStderr(data: string): void { for (const l of this.#stderr) l(Buffer.from(data, 'utf8')); }
  emitClose(code: number | null, signal: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.#close) l(code, signal);
  }
  emitError(error: Error): void { for (const l of this.#error) l(error); }

  /** 한 줄 프레임을 내보낸다 */
  sendFrame(frame: unknown): void { this.emitStdout(`${JSON.stringify(frame)}\n`); }
  /** stdin 에 쓴 프레임(줄 단위 JSON)들 */
  frames(): Record<string, unknown>[] {
    return this.stdinText.join('').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

export interface SpawnRecord { file: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd?: string; proc: FakeProcess }
export interface ExecRecord { file: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd?: string; timeoutMs: number }

export type ExecScript = (record: ExecRecord, docker: FakeDocker) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

export class FakeDocker implements ProcessPort {
  readonly spawned: SpawnRecord[] = [];
  readonly execs: ExecRecord[] = [];
  /** `spawn` 이 이 오류를 던진다 */
  spawnThrows: Error | null = null;
  script: ExecScript = (record, docker) => {
    if (record.args[0] === 'kill') {
      const proc = docker.last()?.proc;
      queueMicrotask(() => proc?.emitClose(137, null));
      return { code: 0, stdout: `${record.args[1] ?? ''}\n` };
    }
    if (record.args[0] === 'rm') return { code: 1, stderr: 'Error response from daemon: No such container: x' };
    return { code: 0 };
  };

  spawn(file: string, args: readonly string[], options: { env: Readonly<Record<string, string>>; cwd?: string }): SpawnedProcess {
    if (this.spawnThrows) throw this.spawnThrows;
    const proc = new FakeProcess();
    this.spawned.push({ file, args: [...args], env: { ...options.env }, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), proc });
    return proc;
  }

  async exec(file: string, args: readonly string[], options: { env: Readonly<Record<string, string>>; timeoutMs: number; cwd?: string }): Promise<ExecResult> {
    const record: ExecRecord = { file, args: [...args], env: { ...options.env }, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeoutMs: options.timeoutMs };
    this.execs.push(record);
    const partial = await this.script(record, this);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...partial };
  }

  last(): SpawnRecord | undefined { return this.spawned[this.spawned.length - 1]; }
  execsOf(command: string): ExecRecord[] { return this.execs.filter((e) => e.args[0] === command); }
}
