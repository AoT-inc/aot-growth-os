// 구독 `claude` CLI 를 부르는 모든 쪽(실행 어댑터·검증기)이 함께 쓰는 게이트. 같은 구독 풀을 쓰므로 한도가 하나여야 한다 (Q22 d):
//  - 동시 실행 수 한도 (가드레일 2): 실행과 검증이 같은 자리를 다툰다.
//  - 사람 우선 게이트(`yieldUtilization`): 직전 호출이 본 창별 사용률이 문턱 이상이면 새 호출을 시작하지 않는다 (CLI 를 띄우지 않으므로 사용량을 쓰지 않는다).
// 사용률은 메모리에만 둔다: 데몬을 다시 띄우면 첫 호출이 측정한다.
import type { Clock } from '@aot/domain';

import type { StreamState } from './stream.ts';

export interface ClaudeCodeGateOptions {
  clock: Clock;
  /** 동시 실행 수. 기본 1 */
  maxConcurrent?: number;
  /**
   * 직전 호출이 본 창별 사용률이 여기 적은 값 이상이면(그 창이 아직 리셋되지 않았을 때) 새 호출을 미룬다.
   * 창 이름은 `rate_limit_event.unifiedWindows` 의 키(`five_hour`, `seven_day`). 0~1 (1 을 넘으면 퍼센트). 기본 꺼짐.
   * 리셋 시각을 모르면 읽은 지 15분 뒤에 낡은 값으로 본다.
   */
  yieldUtilization?: Readonly<Record<string, number>>;
}

export interface ClaudeCodeGate {
  /** 자리를 기다린다. 기다리는 중 취소되면 자리를 받지 않고 false */
  acquire(signal: AbortSignal): Promise<boolean>;
  /** 기다리지 않고 자리를 받는다. 자리가 없거나 기다리는 쪽이 있으면(새치기 금지) false. 검증기가 쓴다: tick 을 붙들고 기다리지 않는다 */
  tryAcquire(): boolean;
  release(): void;
  /** 새 호출을 미뤄야 하면 이유 문구, 아니면 null (자리를 받은 뒤에 본다: 앞선 호출이 끝나며 본 사용률이 반영된다) */
  deferral(): string | null;
  /** 끝난 호출이 본 한도 정보를 기록한다 */
  observe(state: StreamState): void;
}

const STALE_USAGE_MS = 15 * 60_000;

interface Seen { seenAtMs: number; windows: Record<string, { utilization: number; resetsAtMs: number | null }> }

/** 동시 실행 수를 제한하는 대기열 (먼저 온 순서). 기다리는 중 취소되면 자리를 받지 않고 false */
function createSlots(max: number): { acquire(signal: AbortSignal): Promise<boolean>; tryAcquire(): boolean; release(): void } {
  let used = 0;
  const waiting: { grant: () => void; signal: AbortSignal; onAbort: () => void; settle: (ok: boolean) => void }[] = [];
  return {
    tryAcquire() {
      if (used >= max || waiting.length > 0) return false;
      used += 1;
      return true;
    },
    acquire(signal) {
      if (signal.aborted) return Promise.resolve(false);
      if (used < max) {
        used += 1;
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const entry = {
          signal,
          grant: () => { used += 1; entry.settle(true); },
          onAbort: () => {
            const index = waiting.indexOf(entry);
            if (index !== -1) waiting.splice(index, 1);
            entry.settle(false);
          },
          settle: (ok: boolean) => {
            signal.removeEventListener('abort', entry.onAbort);
            resolve(ok);
          },
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
        waiting.push(entry);
      });
    },
    release() {
      used -= 1;
      const next = waiting.shift();
      if (next !== undefined) next.grant();
    },
  };
}

function normalizeYield(value: Readonly<Record<string, number>> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, raw] of Object.entries(value ?? {})) {
    if (!(Number.isFinite(raw) && raw > 0 && raw <= 100)) throw new Error(`yieldUtilization['${name}'] must be a number in (0, 100] (0~1, or a percentage when above 1)`);
    out[name] = raw > 1 ? raw / 100 : raw;
  }
  return out;
}

/** 새 호출을 미뤄야 하면 이유 문구, 아니면 null. 이미 리셋된 창(또는 낡은 값)은 보지 않는다 */
function usageDeferral(yieldAt: Readonly<Record<string, number>>, last: Seen | null, nowMs: number): string | null {
  if (last === null) return null;
  for (const [name, limit] of Object.entries(yieldAt)) {
    const seen = last.windows[name];
    if (seen === undefined) continue;
    const utilization = seen.utilization > 1 ? seen.utilization / 100 : seen.utilization;
    if (utilization < limit) continue;
    const validUntil = seen.resetsAtMs ?? last.seenAtMs + STALE_USAGE_MS;
    if (validUntil <= nowMs) continue;
    const until = new Date(validUntil).toISOString();
    return `the '${name}' subscription window was at ${Math.round(utilization * 100)}% (yield threshold ${Math.round(limit * 100)}%); this run is deferred to leave the rest for the person using the same subscription${seen.resetsAtMs === null ? ` (reading treated as stale after ${until})` : ` (window resets ${until})`}`;
  }
  return null;
}

export function createClaudeCodeGate(options: ClaudeCodeGateOptions): ClaudeCodeGate {
  const maxConcurrent = options.maxConcurrent ?? 1;
  if (!(Number.isInteger(maxConcurrent) && maxConcurrent > 0)) throw new Error('maxConcurrent must be a positive integer');
  const slots = createSlots(maxConcurrent);
  const yieldAt = normalizeYield(options.yieldUtilization);
  let last: Seen | null = null;
  return {
    acquire: (signal) => slots.acquire(signal),
    tryAcquire: () => slots.tryAcquire(),
    release: () => slots.release(),
    deferral: () => usageDeferral(yieldAt, last, options.clock.nowMs()),
    observe(state) {
      if (state.rateLimit === null) return;
      const windows: Seen['windows'] = {};
      for (const [name, value] of Object.entries(state.rateLimit.utilization)) windows[name] = { utilization: value, resetsAtMs: state.rateLimit.windowResetsMs[name] ?? null };
      last = { seenAtMs: options.clock.nowMs(), windows };
    },
  };
}
