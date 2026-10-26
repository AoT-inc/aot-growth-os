// 후보 저장소에 git 을 실행하는 방식(git.ts): 저장소 설정·훅이 코드를 실행하지 못하게 굳힌 호출 모양을 고정한다. 프로세스는 가짜 포트다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGitRunner, remoteKind, type ProcessPort } from '@aot/agent-runtime';

type Call = { file: string; args: readonly string[]; env: Readonly<Record<string, string>>; timeoutMs: number };

function fakePort(result: { code: number | null; stdout?: string; spawnError?: string; timedOut?: boolean }): { port: ProcessPort; calls: Call[] } {
  const calls: Call[] = [];
  const port: ProcessPort = {
    spawn: () => { throw new Error('unused'); },
    exec(file, args, options) {
      calls.push({ file, args, env: options.env, timeoutMs: options.timeoutMs });
      return Promise.resolve({ code: result.code, stdout: result.stdout ?? '', stderr: '', timedOut: result.timedOut ?? false, ...(result.spawnError === undefined ? {} : { spawnError: result.spawnError }) });
    },
  };
  return { port, calls };
}

test('git runs with a fixed argument array, no shell, a scrubbed environment and the repository-config execution points switched off', async () => {
  const { port, calls } = fakePort({ code: 0, stdout: 'ok\n' });
  const git = createGitRunner({ gitPath: '/usr/bin/git', process: port });
  assert.equal(await git.run('/srv/example/repo', ['rev-list', '--count', 'HEAD']), 'ok\n');
  const [call] = calls;
  assert.equal(call?.file, '/usr/bin/git');
  const args = call!.args;
  assert.deepEqual(args.slice(0, 2), ['--no-pager', '--no-optional-locks']);
  for (const setting of ['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'log.showSignature=false', 'core.pager=cat', 'core.useReplaceRefs=false', 'safe.directory=/srv/example/repo']) {
    assert.ok(args.some((arg, i) => args[i - 1] === '-c' && arg === setting), setting);
  }
  assert.equal(args[args.indexOf('-C') + 1], '/srv/example/repo');
  assert.deepEqual(args.slice(args.indexOf('-C') + 2), ['rev-list', '--count', 'HEAD']);
  // 환경: 전역·시스템 설정을 읽지 않고 대화형 입력도 없다. 부모 환경(비밀 포함)은 잇지 않는다
  assert.equal(call?.env['GIT_CONFIG_GLOBAL'], '/dev/null');
  assert.equal(call?.env['GIT_CONFIG_SYSTEM'], '/dev/null');
  assert.equal(call?.env['GIT_CONFIG_NOSYSTEM'], '1');
  assert.equal(call?.env['GIT_TERMINAL_PROMPT'], '0');
  assert.equal(call?.env['GIT_NO_REPLACE_OBJECTS'], '1', 'a repository cannot hide commits with refs/replace');
  assert.equal(call?.env['GIT_CEILING_DIRECTORIES'], '/srv/example', 'git does not climb out of the candidate directory');
  assert.deepEqual(Object.keys(call!.env).filter((name) => !name.startsWith('GIT_')).sort(), ['HOME', 'LC_ALL', 'PATH']);
});

test('failures: run throws git_failed (no stderr in the message); tryRun returns ok:false instead', async () => {
  for (const result of [{ code: 128 }, { code: null, timedOut: true }, { code: null, spawnError: 'ENOENT' }]) {
    const { port } = fakePort(result);
    const git = createGitRunner({ gitPath: '/usr/bin/git', process: port });
    await assert.rejects(git.run('/r', ['status']), /git_failed: git status failed/);
    assert.deepEqual(await git.tryRun('/r', ['status']), { ok: false });
  }
});

test('remoteKind: only the host KIND and whether credentials are embedded; the address is never returned', () => {
  assert.deepEqual(remoteKind('https://github.com/example/example-product.git'), { kind: 'github', credentialsInUrl: false });
  assert.deepEqual(remoteKind('git@github.com:example/example-product.git'), { kind: 'github', credentialsInUrl: false });
  assert.deepEqual(remoteKind('ssh://git@gitlab.com/example/p.git'), { kind: 'gitlab', credentialsInUrl: false });
  assert.deepEqual(remoteKind('https://bitbucket.org/example/p'), { kind: 'bitbucket', credentialsInUrl: false });
  assert.deepEqual(remoteKind('https://user:pw@git.example.invalid/x.git'), { kind: 'other', credentialsInUrl: true });
  assert.deepEqual(remoteKind('/srv/example/local.git'), { kind: 'other', credentialsInUrl: false });
  assert.deepEqual(remoteKind('not a url'), { kind: 'other', credentialsInUrl: false });
});
