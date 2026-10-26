// 등록 후보 저장소에 `git` 을 읽기 전용으로 실행한다. 저장소의 설정·훅이 코드를 실행하지 못하게 굳힌다:
//   - 인자는 코드가 정한 배열이다(에이전트 입력이 인자에 들어가지 않는다). `shell: false`.
//   - 환경은 PATH·HOME(임시 디렉터리)·GIT_* 뿐이다. 전역·시스템 설정은 읽지 않는다(`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`).
//   - 저장소가 이력을 숨기지 못하게 한다: 교체 객체(`refs/replace`)를 쓰지 않는다(`GIT_NO_REPLACE_OBJECTS=1`, `core.useReplaceRefs=false`).
//   - git 이 후보 루트 밖으로 올라가 다른 저장소를 찾지 못하게 한다(`GIT_CEILING_DIRECTORIES` = 루트의 부모). 호출하는 쪽도 `.git` 이 실제 디렉터리인지 먼저 확인한다.
//   - 저장소 설정으로 실행될 수 있는 것을 끈다: `core.fsmonitor`, `core.hooksPath`, `log.showSignature`(gpg 실행), 페이저, 외부 diff·textconv 는 쓰는 명령이 없다.
//   - `safe.directory` 는 명령줄로 이 저장소만 허용한다(소유자가 달라도 읽기 위해).
//   - 네트워크 명령(fetch·pull·ls-remote 등)은 이 모듈이 부르지 않는다.
// 남는 위험: 저장소 로컬 설정이 위 목록 밖의 실행 지점을 쓰는 경우. 쓰는 명령이 rev-parse·symbolic-ref·remote·log·rev-list 뿐이라 현재 알려진 지점은 막았다.
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

import type { ProcessPort } from '../docker.ts';
import { nodeProcessPort } from '../docker.ts';
import { RepoToolError } from './repo-files.ts';

export interface GitRunner {
  /** git 하위 명령 인자(예: `['rev-list', '--count', 'HEAD', '--']`). 성공하면 stdout, 실패하면 `RepoToolError('git_failed')`. `signal` 이 abort 되면 git 을 끝낸다 */
  run(root: string, args: readonly string[], signal?: AbortSignal): Promise<string>;
  /** 실패를 값으로 돌려준다(저장소가 아니거나 원격이 없는 경우 등 예상된 실패용) */
  tryRun(root: string, args: readonly string[], signal?: AbortSignal): Promise<{ ok: true; stdout: string } | { ok: false }>;
}

export interface GitRunnerOptions {
  /** `git` 실행 파일의 절대 경로 */
  gitPath: string;
  process?: ProcessPort;
  timeoutMs?: number;
}

export function createGitRunner(options: GitRunnerOptions): GitRunner {
  const port = options.process ?? nodeProcessPort;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseEnv: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/local/bin',
    HOME: tmpdir(),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  };
  const argsFor = (root: string, args: readonly string[]): string[] => [
    '--no-pager', '--no-optional-locks',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'log.showSignature=false', '-c', 'core.pager=cat', '-c', 'core.useReplaceRefs=false', '-c', `safe.directory=${root}`,
    '-C', root,
    ...args,
  ];
  const exec = (root: string, args: readonly string[], signal?: AbortSignal) => {
    const env = { ...baseEnv, GIT_CEILING_DIRECTORIES: dirname(root) };
    return port.exec(options.gitPath, argsFor(root, args), { env, timeoutMs, ...(signal === undefined ? {} : { signal }) });
  };
  return {
    async run(root, args, signal) {
      const result = await exec(root, args, signal);
      if (result.spawnError !== undefined || result.timedOut || result.code !== 0) {
        throw new RepoToolError('git_failed', `git ${args[0] ?? ''} failed${result.timedOut ? ' (timed out)' : result.spawnError === undefined ? ` (exit ${String(result.code)})` : ` (${result.spawnError})`}`);
      }
      return result.stdout;
    },
    async tryRun(root, args, signal) {
      const result = await exec(root, args, signal);
      return result.spawnError === undefined && !result.timedOut && result.code === 0 ? { ok: true, stdout: result.stdout } : { ok: false };
    },
  };
}
