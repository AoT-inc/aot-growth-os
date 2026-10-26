// 사람 승인 채널의 OS 수준 확인 (trust-boundaries §3.1·§6, 가능한 범위): 소켓 디렉터리 0700·소켓 0600, 권한 없는
// 프로세스의 접속 실패, 넓은 권한 디렉터리에서 시작 거부, 에이전트 actor 의 인증 단계 거부.
// 한계(Phase A 편차): 다른 UID 로 프로세스를 띄울 권한이 없어, "다른 사용자"는 파일 권한을 없앤 소켓으로 흉내 낸다.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { prepareSocketDir, sendApprovalRequest, startApprovalServer } from '@aot/policy';

import { AGENT, OWNER, policyEnv } from '../support/policy.ts';
import { runApproveCli } from '../support/approve-cli.ts';
import { makeTempDir } from '../support/temp.ts';

async function serve(t: TestContext) {
  const env = policyEnv(t);
  const socket = join(makeTempDir(t, 'aot-sock-'), 'run', 'approval.sock');
  const server = await startApprovalServer({ socketPath: socket, handle: (request) => env.engine.handle(request) });
  t.after(() => server.close());
  return { env, socket };
}

test('the server creates an owner-only directory (0700) and socket (0600); a human can use it from another process', async (t) => {
  const { socket } = await serve(t);
  assert.equal(statSync(join(socket, '..')).mode & 0o777, 0o700);
  assert.ok(statSync(socket).isSocket());
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  const result = await runApproveCli(['whoami'], { socket, actor: OWNER });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json, { ok: true, actor: OWNER, kind: 'human' });
});

test('an agent actor is refused at the authentication step, over the socket and from another process', async (t) => {
  const { socket } = await serve(t);
  const direct = await sendApprovalRequest(socket, { cmd: 'list', actor: AGENT }) as { ok: boolean; error: string };
  assert.equal(direct.ok, false);
  assert.match(direct.error, /only human actors/);
  const cli = await runApproveCli(['list'], { socket, actor: AGENT });
  assert.equal(cli.code, 1);
  assert.match(String(cli.json?.['error']), /only human actors/);
  const garbage = await sendApprovalRequest(socket, { cmd: 'approve', actor: OWNER, kind: 'task' }) as { ok: boolean; error: string };
  assert.match(garbage.error, /id is required/);
});

test('a process without permission on the socket file or its directory cannot connect (EACCES)', async (t) => {
  const { socket } = await serve(t);
  chmodSync(socket, 0o000);
  const noSocket = await runApproveCli(['whoami'], { socket, actor: OWNER });
  assert.notEqual(noSocket.code, 0);
  assert.match(noSocket.stderr, /EACCES/);
  chmodSync(socket, 0o600);
  const dir = join(socket, '..');
  chmodSync(dir, 0o000);
  let noDir;
  try {
    noDir = await runApproveCli(['whoami'], { socket, actor: OWNER });
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.notEqual(noDir.code, 0);
  assert.match(noDir.stderr, /EACCES/);
  assert.equal((await runApproveCli(['whoami'], { socket, actor: OWNER })).code, 0, 'restoring the permission restores access');
});

test('the server refuses to start in a group/world-accessible directory or over a non-socket file', async (t) => {
  const base = makeTempDir(t, 'aot-sock-');
  const open = join(base, 'open');
  mkdirSync(open, { mode: 0o755 });
  chmodSync(open, 0o755);
  await assert.rejects(startApprovalServer({ socketPath: join(open, 'approval.sock'), handle: () => ({}) }), /must be 0700/);
  assert.throws(() => prepareSocketDir(open), /must be 0700/);
  const closed = join(base, 'closed');
  mkdirSync(closed, { mode: 0o700 });
  writeFileSync(join(closed, 'approval.sock'), 'not a socket');
  await assert.rejects(startApprovalServer({ socketPath: join(closed, 'approval.sock'), handle: () => ({}) }), /not a socket/);
});
