// 폴링 데몬 루프. 업무가 있으면 쉬지 않고 다음 tick, 없으면 pollMs 만큼 쉰다. signal 이 abort 되면 현재 tick 을 끝내고 멈춘다.
// 재시작 복구는 별도 절차가 아니다: 새로 뜬 데몬의 매 tick 이 만료된 lease 를 인수한다 (recovery §4).
import type { TaskWorker, TickReport } from './worker.ts';

export interface PollingOptions {
  pollMs: number;
  signal: AbortSignal;
  /** 기본은 setTimeout. 시험에서 바꿔 끼운다 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onTick?: (report: TickReport) => void;
  /** tick 뒤에 한 번 부른다 (예: 주간 사이클의 후보 비교, A6-U14). 실패는 onError 로 가고 루프는 계속한다. 생략하면 부르지 않는다 */
  afterTick?: () => Promise<void>;
  onError?: (error: unknown) => void;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export async function runPolling(worker: TaskWorker, options: PollingOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  while (!options.signal.aborted) {
    let busy = false;
    try {
      const report = await worker.tick();
      options.onTick?.(report);
      busy = report.executed !== null;
    } catch (error) {
      options.onError?.(error);
    }
    if (options.afterTick !== undefined) {
      try {
        await options.afterTick();
      } catch (error) {
        options.onError?.(error);
      }
    }
    if (!busy) await sleep(options.pollMs, options.signal);
  }
}
