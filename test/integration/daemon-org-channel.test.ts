// Phase B / B5: 조직 채널이 데몬 조립(assembleDaemon.handleChannelRequest)과 승인 CLI 에 연결돼 있다.
//  - 소켓 처리기가 `cmd:'org'` 를 조직 채널로 보내고, 같은 처리기가 `approve org_proposal` 을 승인 엔진으로 보낸다
//  - CLI: 사용법 오류는 종료 코드 2, 모르는 옵션 거부, 알려진 모양은 소켓에 도달한다(소켓이 없으면 연결 오류)
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runApproveCli } from '../support/approve-cli.ts';
import { rig } from '../support/experiment-cycle.ts';
import { OWNER, policyEnv } from '../support/policy.ts';
import { PLAN, seedTask, TYPE } from '../support/org-trial.ts';

const BODY = {
  diff: { ops: [{ op: 'add_role', role: { slug: 'example-researcher', description: '조사 전담', allowed_tools: [{ tool: 'web_search', operations: ['search'] }], unit: 'core' } }] },
  rationale: 'r', evidence_refs: ['task:x'], expected_effect: 'e', risk_assessment: { risks: ['a'], mitigations: ['b'] }, evaluation_plan: PLAN,
  rollback_plan: { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: 'generalist' }, running_tasks: 'finish', external_effects: 'human' },
  trial_scope: { task_types: [TYPE] },
};

test('the daemon socket handler serves org commands and the approval engine for org_proposal', (t) => {
  const env = policyEnv(t);
  const daemon = rig(env, []);
  const send = (request: Record<string, unknown>) => daemon.handleChannelRequest(request) as Record<string, unknown>;
  const proposed = send({ cmd: 'org', actor: OWNER, op: 'propose', proposal: BODY });
  assert.equal(proposed['ok'], true, JSON.stringify(proposed));
  const id = String(proposed['proposal_id']);
  const shown = send({ cmd: 'show', actor: OWNER, kind: 'org_proposal', id });
  assert.equal(shown['ok'], true);
  assert.equal(send({ cmd: 'approve', actor: OWNER, kind: 'org_proposal', id, hash: shown['hash'] })['state'], 'approved');
  assert.deepEqual((send({ cmd: 'list', actor: OWNER })['org_proposals'] as unknown[]), [], 'nothing waits for a decision any more');
  const status = send({ cmd: 'org', actor: OWNER, op: 'status' }) as { proposals: Array<{ id: string; status: string }> };
  assert.deepEqual(status.proposals.map((p) => [p.id, p.status]), [[id, 'approved']]);
  assert.equal(send({ cmd: 'org', actor: OWNER, op: 'nope' })['ok'], false);
  assert.match(String(send({ cmd: 'org', actor: OWNER, op: 'status', extra: 1 })['error']), /unknown field/);
});

test('approval CLI: org usage errors exit with 2; the file is parsed; known shapes reach the socket', async (t) => {
  const env = policyEnv(t);
  const missingSocket = join(env.dir, 'no-such.sock');
  const cli = (args: string[]) => runApproveCli(args, { socket: missingSocket, actor: OWNER });
  assert.equal((await cli(['org'])).code, 2);
  assert.equal((await cli(['org', 'bogus'])).code, 2);
  assert.equal((await cli(['org', 'propose'])).code, 2, 'needs --file');
  assert.equal((await cli(['org', 'propose', '--file', join(env.dir, 'missing.json')])).code, 2);
  assert.equal((await cli(['org', 'confirm', 'org-proposal-x'])).code, 2, 'needs --comment');
  assert.equal((await cli(['org', 'confirm', '--comment', 'ok'])).code, 2, 'needs an id');
  assert.equal((await cli(['org', 'signals', 'extra'])).code, 2);
  assert.equal((await cli(['org', 'status', '--bogus', 'x'])).code, 2, 'unknown option');
  assert.equal((await cli(['org', 'retrial', 'org-proposal-x', '--comment', 'c'])).code, 2, 'needs --file');
  const file = join(env.dir, 'proposal.json');
  writeFileSync(file, JSON.stringify(BODY));
  const reached = await cli(['org', 'propose', '--file', file]);
  assert.equal(reached.code, 2, 'parsed fine, then failed to connect (no daemon)');
  assert.doesNotMatch(reached.stderr, /usage|needs/);
  assert.match(reached.stderr, /ENOENT|connect|socket/i);
});

test('draft: a proposal is generated from the signal — no JSON to write; default tools mean no permission expansion; no signal, no draft', (t) => {
  const env = policyEnv(t);
  const daemon = rig(env, []);
  const send = (request: Record<string, unknown>) => daemon.handleChannelRequest(request) as Record<string, unknown>;
  const draft = { task_type: TYPE, role_slug: 'example-researcher' };
  assert.match(String(send({ cmd: 'org', actor: OWNER, op: 'propose', draft })['error']), /no unassigned task/);
  seedTask(env.db, env.clock, {});
  const made = send({ cmd: 'org', actor: OWNER, op: 'propose', draft });
  assert.equal(made['ok'], true, JSON.stringify(made));
  assert.equal(made['change_class'], 'normal', 'the default tool set is the generalist\'s: no expansion');
  const shown = send({ cmd: 'show', actor: OWNER, kind: 'org_proposal', id: made['proposal_id'] });
  assert.match(String(shown['rationale']), /1건/);
  assert.doesNotMatch(String(shown['rationale']), /unassigned/, 'human-facing draft text is plain Korean');
  assert.deepEqual(shown['trial_scope'], { task_types: [TYPE] });
  assert.equal(send({ cmd: 'approve', actor: OWNER, kind: 'org_proposal', id: made['proposal_id'], hash: shown['hash'] })['state'], 'approved');
  assert.equal(send({ cmd: 'org', actor: OWNER, op: 'propose', draft, proposal: BODY })['ok'], false, 'draft and proposal are exclusive');
  assert.equal(send({ cmd: 'org', actor: OWNER, op: 'propose' })['ok'], false);
  assert.match(String(send({ cmd: 'org', actor: OWNER, op: 'propose', draft: { ...draft, tools: [] } })['error']), /unknown field/);
  assert.equal(send({ cmd: 'org', actor: OWNER, op: 'propose', draft: { ...draft, role_slug: 'policy-writer' } })['code'], 'forbidden_target');
});

test('approval CLI: org propose --type/--role builds a draft request (no file needed)', async (t) => {
  const env = policyEnv(t);
  const cli = (args: string[]) => runApproveCli(args, { socket: join(env.dir, 'no-such.sock'), actor: OWNER });
  assert.equal((await cli(['org', 'propose', '--type', TYPE])).code, 2, 'needs --role');
  assert.equal((await cli(['org', 'propose', '--role', 'x-role'])).code, 2, 'needs --type');
  assert.equal((await cli(['org', 'propose', '--type', TYPE, '--role', 'x-role', '--file', 'a.json'])).code, 2, 'not both');
  const reached = await cli(['org', 'propose', '--type', TYPE, '--role', 'example-researcher']);
  assert.doesNotMatch(reached.stderr, /usage|needs/);
  assert.match(reached.stderr, /ENOENT|connect|socket/i);
});
