// run_log 저장소 (단계 A5 U4). `task_run.run_log_ref` 에 넣을 위치를 돌려준다. 스키마에는 로그 본문을 담는 열이 없으므로(새 테이블·열 없음) 본문은 파일로 둔다:
// `<dir>/<run id>.jsonl` (한 줄에 항목 하나, 비밀값은 가려서 쓴다). ref 는 `run-log:<run id>` 이며 데몬 설정의 run_log_dir 과 합쳐 파일을 찾는다.
// 디렉터리는 0700, 파일은 0600 으로 만든다. 항목 수·길이에 상한이 있다(에이전트가 로그로 디스크를 채우지 못하게).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunLogEntry } from './contract.ts';
import { maskString } from './mask.ts';

export interface RunLogStore {
  /** 이 run 의 로그를 저장하고 `task_run.run_log_ref` 에 넣을 ref 를 돌려준다 */
  save(runId: string, entries: readonly RunLogEntry[]): string | Promise<string>;
}

export const RUN_LOG_REF_PREFIX = 'run-log:';
export const MAX_RUN_LOG_ENTRIES = 5000;
export const MAX_RUN_LOG_MESSAGE_CHARS = 2000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export const runLogRefFor = (runId: string): string => `${RUN_LOG_REF_PREFIX}${runId}`;

export function createFileRunLogStore(options: { dir: string }): RunLogStore {
  if (typeof options.dir !== 'string' || options.dir === '') throw new Error('run log directory is required');
  return {
    async save(runId, entries) {
      if (!RUN_ID.test(runId)) throw new Error('run id is not usable as a log file name');
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      const lines = entries.slice(0, MAX_RUN_LOG_ENTRIES)
        .map((entry) => JSON.stringify({ at: entry.at, message: maskString(entry.message).slice(0, MAX_RUN_LOG_MESSAGE_CHARS) }));
      if (entries.length > MAX_RUN_LOG_ENTRIES) lines.push(JSON.stringify({ at: entries[MAX_RUN_LOG_ENTRIES]?.at ?? '', message: `(${entries.length - MAX_RUN_LOG_ENTRIES} more entries omitted)` }));
      await writeFile(join(options.dir, `${runId}.jsonl`), `${lines.join('\n')}\n`, { mode: 0o600 });
      return runLogRefFor(runId);
    },
  };
}
