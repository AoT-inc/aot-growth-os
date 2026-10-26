export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * 연결을 열 때 적용하는 PRAGMA, 실행 순서 그대로.
 * `busy_timeout` 이 반드시 `journal_mode=WAL` 보다 먼저여야 한다. 반대 순서면 여러 프로세스가
 * 동시에 열 때 WAL 전환이 `database is locked` 로 즉시 실패했다 (docs/spikes/q20-test-runner.md).
 */
export function connectionPragmas(busyTimeoutMs: number, inMemory: boolean): string[] {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
    throw new RangeError('busyTimeoutMs must be a positive integer');
  }
  const pragmas = [`PRAGMA busy_timeout = ${busyTimeoutMs}`];
  if (!inMemory) pragmas.push('PRAGMA journal_mode = WAL');
  pragmas.push('PRAGMA foreign_keys = ON', 'PRAGMA synchronous = NORMAL');
  return pragmas;
}
