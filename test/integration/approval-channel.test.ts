// 사람 승인 채널의 OS 수준 확인 (trust-boundaries §3.1·§6, 가능한 범위): 소켓 디렉터리 0700·소켓 0600, 권한 없는
// 프로세스의 접속 실패, 넓은 권한 디렉터리에서 시작 거부, 에이전트 actor 의 인증 단계 거부.
// 한계(Phase A 편차): 다른 UID 로 프로세스를 띄울 권한이 없어, "다른 사용자"는 파일 권한을 없앤 소켓으로 흉내 낸다.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { prepareSocketDir, sendApprovalRequest, startApprovalServer } from '@aot/policy';

import { draftedTask } from '../support/draft-flow.ts';
import { examplePayload } from '../support/message-tool.ts';
import { DELEGATE, delegationEnv } from '../support/delegation.ts';
import { AGENT, OWNER, policyEnv, taskRow } from '../support/policy.ts';
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

test('a handler may answer asynchronously; the request is handled once even when more data arrives meanwhile, and a rejected promise gives an error reply', async (t) => {
  const socket = join(makeTempDir(t, 'aot-sock-'), 'run', 'approval.sock');
  let calls = 0;
  const errors: unknown[] = [];
  const server = await startApprovalServer({
    socketPath: socket,
    handle: async (request) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      if ((request as { boom?: boolean }).boom === true) throw new Error('private detail');
      return { ok: true, echoed: request };
    },
    onError: (error) => errors.push(error),
  });
  t.after(() => server.close());
  assert.deepEqual(await sendApprovalRequest(socket, { n: 1 }), { ok: true, echoed: { n: 1 } });
  const failed = await sendApprovalRequest(socket, { boom: true }) as { ok: boolean; error: string };
  assert.deepEqual([failed.ok, failed.error], [false, 'internal error in the approval engine']);
  assert.deepEqual(errors, ['Error']);
  // 같은 연결에 처리 중 더 쓰면 요청을 다시 처리하지 않는다
  const before = calls;
  const { createConnection } = await import('node:net');
  const reply = await new Promise<string>((resolve, reject) => {
    const connection = createConnection(socket);
    let data = '';
    connection.setEncoding('utf8').on('data', (chunk: string) => (data += chunk)).on('close', () => resolve(data)).on('error', reject);
    connection.write('{"n":2}\n');
    setTimeout(() => connection.write('{"n":3}\n'), 5);
  });
  assert.equal(calls - before, 1);
  assert.deepEqual(JSON.parse(reply.trim()), { ok: true, echoed: { n: 2 } });
});

test('a reply that cannot be serialized does not crash the daemon: the client gets the error reply', async (t) => {
  const socket = join(makeTempDir(t, 'aot-sock-'), 'run', 'approval.sock');
  const errors: unknown[] = [];
  const server = await startApprovalServer({ socketPath: socket, handle: (request) => ((request as { big?: boolean }).big === true ? { n: 1n } : { ok: true }), onError: (error) => errors.push(error) });
  t.after(() => server.close());
  const reply = await sendApprovalRequest(socket, { big: true }) as { ok: boolean; error: string };
  assert.deepEqual([reply.ok, reply.error], [false, 'internal error in the approval engine']);
  assert.deepEqual(errors, ['TypeError']);
  assert.deepEqual(await sendApprovalRequest(socket, { big: false }), { ok: true }, 'the server keeps serving');
});

// ===== 초안 승인 명령 (ADR-0015) =====

test('the CLI shows the proposed drafts with secret-like values masked (the stored payload stays exact), and request-changes takes a required comment', async (t) => {
  const { env, socket } = await serve(t);
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123';
  const { taskId } = await draftedTask(env, { requests: [examplePayload({ text: `key ${secret}`, subject: 'Hello' })] });
  const shown = await runApproveCli(['show', 'task', taskId], { socket, actor: OWNER });
  assert.equal(shown.code, 0, shown.stderr);
  const drafts = shown.json?.['drafts'] as { payload: { subject: string; text: string; to: string[] } }[];
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.payload.subject, 'Hello');
  assert.deepEqual(drafts[0]!.payload.to, ['customer@example.com'], 'recipients are shown exactly in the CLI');
  assert.doesNotMatch(shown.stdout, new RegExp(secret), 'the secret shape is masked in the display');
  const stored = env.db.get<{ payload: string }>('SELECT payload FROM effect_draft WHERE task_id = ?', [taskId])!.payload;
  assert.match(stored, new RegExp(secret), 'the stored payload is the exact bytes');

  const usage = await runApproveCli(['request-changes', 'task', taskId], { socket, actor: OWNER });
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /needs --comment/);
  const wrongKind = await runApproveCli(['request-changes', 'publication', 'x', '--comment', 'r'], { socket, actor: OWNER });
  assert.equal(wrongKind.code, 2);
  const agent = await runApproveCli(['request-changes', 'task', taskId, '--comment', 'r'], { socket, actor: AGENT });
  assert.equal(agent.code, 1);
  assert.match(String(agent.json?.['error']), /only human actors/);

  const done = await runApproveCli(['request-changes', 'task', taskId, '--comment', 'remove the key'], { socket, actor: OWNER });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.json?.['state'], 'queued');
  assert.equal(taskRow(env.db, taskId).status, 'queued');
});

// ===== 공유 계약: expected_hash · via · code, 위임 명령 (ADR-0016, 제안) =====

test('over the socket and the CLI: via is recorded, a stale --expected-hash is refused with code hash_mismatch, and the reply carries the refusal code', async (t) => {
  const { env, socket } = await serve(t);
  const { taskId } = await draftedTask(env);
  const shown = await runApproveCli(['show', 'task', taskId], { socket, actor: OWNER });
  const hash = String(shown.json?.['hash']);

  const stale = await runApproveCli(['reject', 'task', taskId, '--expected-hash', 'a'.repeat(64)], { socket, actor: OWNER });
  assert.equal(stale.code, 1);
  assert.equal(stale.json?.['code'], 'hash_mismatch');
  assert.equal(taskRow(env.db, taskId).status, 'needs_review');

  const raw = await sendApprovalRequest(socket, { cmd: 'cancel', actor: OWNER, kind: 'task', id: taskId, expected_hash: 'b'.repeat(64), via: 'web' }) as { ok: boolean; code: string };
  assert.deepEqual([raw.ok, raw.code], [false, 'hash_mismatch']);
  assert.equal((await sendApprovalRequest(socket, { cmd: 'reject', actor: OWNER, kind: 'task', id: taskId, via: 'delegate' }) as { code: string }).code, 'bad_request');
  assert.equal((await sendApprovalRequest(socket, { cmd: 'list', actor: AGENT }) as { code: string }).code, 'not_human');

  const approved = await runApproveCli(['approve', 'task', taskId, '--hash', hash], { socket, actor: OWNER });
  assert.equal(approved.code, 0, approved.stderr);
  const rows = env.db.all<{ via: string | null }>("SELECT via FROM approval WHERE subject_kind = 'task' AND subject_id = ?", [taskId]);
  assert.deepEqual(rows.map((row) => row.via), ['cli'], 'the CLI reports via=cli');
  const web = await sendApprovalRequest(socket, { cmd: 'cancel', actor: OWNER, kind: 'task', id: taskId, expected_hash: hash, via: 'web' }) as { ok: boolean };
  assert.equal(web.ok, true);
  assert.deepEqual(env.db.all<{ via: string | null }>("SELECT via FROM approval WHERE subject_kind = 'task' AND subject_id = ? ORDER BY at, rowid", [taskId]).map((row) => row.via), ['cli', 'web']);
});

test('the delegation CLI: status, pause, resume (TOTP from stdin) and revoke; a delegateDecide-shaped request is not a socket command', async (t) => {
  const env = delegationEnv(t);
  const socket = join(makeTempDir(t, 'aot-sock-'), 'run', 'approval.sock');
  const server = await startApprovalServer({ socketPath: socket, handle: (request) => env.engine.handle(request) });
  t.after(() => server.close());

  const status = await runApproveCli(['delegation', 'status'], { socket, actor: OWNER });
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json?.['enabled'], true);
  assert.deepEqual((status.json?.['mandates'] as { id: string; state: string }[]).map((m) => [m.id, m.state]), [['routine-mail', 'active']]);

  const paused = await runApproveCli(['delegation', 'pause', '--comment', 'holiday'], { socket, actor: OWNER });
  assert.equal(paused.json?.['state'], 'paused');
  const noCode = await runApproveCli(['delegation', 'resume'], { socket, actor: OWNER });
  assert.equal(noCode.code, 1);
  assert.equal(noCode.json?.['code'], 'reauth_required');
  const resumed = await runApproveCli(['delegation', 'resume', '--totp-stdin'], { socket, actor: OWNER, stdin: `${env.code(OWNER)}\n` });
  assert.equal(resumed.json?.['state'], 'resumed', resumed.stderr);
  const revoked = await runApproveCli(['delegation', 'revoke', 'routine-mail'], { socket, actor: OWNER });
  assert.deepEqual(revoked.json?.['mandate_ids'], ['routine-mail']);
  assert.equal((await runApproveCli(['delegation', 'frobnicate'], { socket, actor: OWNER })).code, 2);
  assert.equal((await runApproveCli(['delegation', 'pause'], { socket, actor: AGENT })).json?.['code'], 'not_human');

  const shaped = await sendApprovalRequest(socket, { cmd: 'delegate_decide', actor: DELEGATE, task_id: 'x', hash: 'a'.repeat(64), verdict: 'approve', reason: 'x' }) as { ok: boolean; code: string };
  assert.deepEqual([shaped.ok, shaped.code], [false, 'bad_request']);
  const asHuman = await sendApprovalRequest(socket, { cmd: 'delegate_decide', actor: OWNER, task_id: 'x', hash: 'a'.repeat(64), verdict: 'approve', reason: 'x' }) as { code: string };
  assert.equal(asHuman.code, 'bad_request', 'not a socket command even for a person');
});
