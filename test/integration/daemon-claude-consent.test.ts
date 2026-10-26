// claude-code-cli 고지 동의 (가드레일 4)를 데몬 조립에서 끝까지: 설정(`claude_code_cli`) → 어댑터 → 승인 소켓의 `consent` 명령.
//  - 동의가 없으면 CLI 를 띄우지 않고 consent_required → 업무 needs_review (claude 경로가 없어도 cli_unavailable 이 아니라 consent_required 가 먼저다)
//  - 승인 채널로 동의하면 데몬 재시작 없이 다음 run 부터 통과한다 (여기서는 가짜 경로라 그다음 cli_unavailable 로 막힌다 — 동의는 넘었다는 증거)
//  - 철회하면 다시 consent_required
// 실제 `claude` 는 부르지 않는다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { CLAUDE_CODE_NOTICE } from '@aot/agent-runtime';
import type { Db } from '@aot/domain';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { readClaudeCodeConsent } from '../../apps/daemon/src/consent.ts';
import { buildAgentRuntime } from '../../apps/daemon/src/runtime-config.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { AGENT, createWithGate, OWNER, policyEnv, readOnlyDraft } from '../support/policy.ts';

const lastTransition = (db: Db, taskId: string) => db.get<{ to_status: string; reason: string }>('SELECT to_status, reason FROM task_transition WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId])!;
const attemptsOf = (db: Db, taskId: string): number => Number(db.get('SELECT attempts FROM task WHERE id = ?', [taskId])?.['attempts']);

test('consent flows from the approval channel to the next run: none -> consent_required, accepted -> passes the check, revoked -> consent_required again', async (t) => {
  const env = policyEnv(t);
  const built = buildAgentRuntime(
    { claude_code_cli: { claude_path: '/nonexistent/example/claude', run_root: join(env.dir, 'r'), env: { home: env.dir, user: 'example-daemon', path: '/usr/bin:/bin' } } },
    env.dir,
    { clock: env.clock, claudeCodeConsent: () => readClaudeCodeConsent(env.db) },
  );
  assert.equal(built.agent?.adapter.name, 'claude-code-cli', 'without container_agent the subscription CLI is the default adapter');
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    agent: built.agent!,
  });
  const draft = (n: number) => readOnlyDraft({ inputs: [{ name: 'k', ref: `r:${n}`, kind: 'k' }] });
  const consent = (request: Record<string, unknown>) => daemon.handleChannelRequest({ cmd: 'consent', actor: OWNER, ...request }) as Record<string, unknown>;

  // 1. 동의 없음: 업무는 needs_review, 시도를 쓰지 않는다
  const first = createWithGate(env, draft(1));
  await daemon.worker.tick();
  assert.equal(taskStatus(env.db, first), 'needs_review');
  assert.equal(attemptsOf(env.db, first), 0);
  assert.match(lastTransition(env.db, first).reason, /consent_required/);

  // 2. 사람이 고지를 읽고 동의한다 (승인 소켓과 같은 처리기)
  assert.equal((consent({ op: 'show' })['notice'] as { version: string }).version, CLAUDE_CODE_NOTICE.version);
  assert.equal(consent({ op: 'accept', notice_version: CLAUDE_CODE_NOTICE.version })['applied'], true);
  const second = createWithGate(env, draft(2));
  await daemon.worker.tick();
  assert.match(lastTransition(env.db, second).reason, /cli_unavailable/, 'the consent check passed; the fake claude path is then what stops the run');

  // 3. 철회하면 다음 run 부터 다시 막힌다
  assert.equal(consent({ op: 'revoke' })['applied'], true);
  const third = createWithGate(env, draft(3));
  await daemon.worker.tick();
  assert.match(lastTransition(env.db, third).reason, /consent_required/);
  assert.equal(taskStatus(env.db, third), 'needs_review');
});
