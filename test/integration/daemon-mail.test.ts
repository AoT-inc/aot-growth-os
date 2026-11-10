// ADR-0017 통합: 실제 메일 런타임 + SMTP 어댑터 + 가짜 SMTP 서버(루프백)로 초안 먼저 → 사람 승인 → 호스트 전송을 끝까지 본다.
//   초안 run (도구 전송 0회) → 검증기 → needs_review → approve(show 의 해시) → cooldown + TOTP release → 전송 run (에이전트·LLM 0회) → 서버가 승인된 바이트를 받음 → confirmed
//   끝 점 뒤 연결 끊김 → unknown + needs_review + 서버에 정확히 한 통(재전송 0), 승인 뒤 수신 거부 → 전송 0 + failed, RCPT 5.1.1 → failed + 연락처 수신 거부(감사 기록).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createFakeAgentAdapter, type JsonObject, type ToolCallRecord } from '@aot/agent-runtime';
import { canonicalJson, type EffectDraftRow } from '@aot/domain';

import { assembleDaemon } from '../../apps/daemon/src/assemble.ts';
import { createSmtpTransport } from '../../apps/daemon/src/mail-smtp.ts';
import { draftsOf } from '../support/drafts.ts';
import { manualTimers, taskStatus } from '../support/engine.ts';
import { EXAMPLE_URL, FakeFetcher, validationSpec } from '../support/evaluation.ts';
import { startFakeSmtpServer, type FakeSmtpScript, type FakeSmtpServer } from '../support/fake-smtp-server.ts';
import { ManualGatewayTimers } from '../support/gateway-contract.ts';
import { decodeMail } from '../support/mail-decode.ts';
import { addContact, contactRow, eventsOf, SENDER_ADDRESS, SENDERS, UNSUBSCRIBE } from '../support/mail.ts';
import { AGENT, createWithGate, effectDraft, HOUR, OWNER, policyEnv, type PolicyEnv } from '../support/policy.ts';

interface Rig {
  env: PolicyEnv;
  server: FakeSmtpServer;
  daemon: ReturnType<typeof assembleDaemon>;
  adapterRuns: { count: number };
  records: ToolCallRecord[];
}

const MAIL_ARGS = { to: ['customer@example.com'], subject: '주문 안내 😀', text: 'First line\n.dot line\n한글 본문\n' };

async function rig(t: TestContext, script: FakeSmtpScript = {}, args: Record<string, unknown> = MAIL_ARGS): Promise<Rig> {
  const env = policyEnv(t);
  const server = await startFakeSmtpServer(script);
  t.after(() => server.close());
  const adapterRuns = { count: 0 };
  const records: ToolCallRecord[] = [];
  const daemon = assembleDaemon({
    db: env.db, clock: env.clock, workerId: 'w1', actorId: AGENT, timers: manualTimers(), retryDelayMs: 10_000,
    paths: { policyStoreDir: join(env.dir, 'policies'), totpDir: join(env.dir, 'totp'), approvalSocket: join(env.dir, 'run', 'approval.sock') },
    evaluation: { fetcher: new FakeFetcher({ [EXAMPLE_URL]: 'page' }), evidenceReader: { read: () => Promise.resolve({ readable: false, reason: 'no stored content in this test' }) } },
    mail: {
      transport: createSmtpTransport({ host: server.host, port: server.port, security: 'none' }),
      senders: SENDERS, unsubscribeMailto: UNSUBSCRIBE, maxPerDay: 200, minIntervalMs: 0,
    },
    agent: {
      adapter: {
        name: 'draft-fake',
        run: (input, context) => {
          adapterRuns.count += 1;
          return createFakeAgentAdapter({
            clock: env.clock, scenario: 'tool_calls', name: 'draft-fake', evidence: [{ kind: 'source_url', ref: EXAMPLE_URL }],
            toolCalls: [{ tool: 'mail_send', args: args as JsonObject }],
          }).run(input, context);
        },
      },
      tools: [], timers: new ManualGatewayTimers(), recorder: { record: (record) => void records.push(record) },
    },
  });
  return { env, server, daemon, adapterRuns, records };
}

const mailTask = (r: Rig, target = 'mail:support') => createWithGate(r.env, effectDraft({
  ...validationSpec(['url_reachable', 'no_secret_in_outputs', 'budget']),
  allowed_tools: [{ tool: 'mail_send', operations: ['send'], scope: 'customer', impact: 'external_effect', target }],
}));

async function draftUntilReview(r: Rig, taskId: string): Promise<void> {
  assert.equal((await r.daemon.worker.tick()).executed?.taskId, taskId);
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['needs_review']);
}

const show = (r: Rig, taskId: string) => r.env.send({ cmd: 'show', actor: OWNER, kind: 'task', id: taskId });

function approveAndRelease(r: Rig, taskId: string): void {
  const hash = String(show(r, taskId)['hash']);
  assert.equal(r.env.send({ cmd: 'approve', actor: OWNER, kind: 'task', id: taskId, hash })['state'], 'cooldown');
  r.env.clock.advance(HOUR);
  assert.deepEqual(r.env.send({ cmd: 'release', actor: OWNER, kind: 'task', id: taskId, totp: r.env.code() }), { ok: true, state: 'queued' });
}

const effectsOf = (r: Rig, taskId: string) =>
  r.env.db.all<{ state: string; response_ref: string | null; tool: string; target: string; effect_key: string; supports_idempotency: number }>(
    'SELECT state, response_ref, tool, target, effect_key, supports_idempotency FROM external_effect WHERE task_id = ?', [taskId],
  );

test('draft -> approve -> dispatch: the server receives exactly the approved payload as a mail and the effect is confirmed', async (t) => {
  const r = await rig(t);
  const taskId = mailTask(r);

  // 1) 초안 run: 에이전트는 mail_send 를 불렀지만 아무것도 연결하지 않았다
  assert.equal((await r.daemon.worker.tick()).executed?.taskId, taskId);
  assert.equal(r.server.connections(), 0, 'the draft run sent nothing');
  assert.deepEqual(r.records.map((rec) => [rec.tool, rec.outcome]), [['mail_send', 'ok']]);
  assert.equal(r.env.db.get('SELECT count(*) AS n FROM external_effect')?.['n'], 0);
  const drafts = draftsOf(r.env.db, taskId);
  assert.deepEqual(drafts.map((d) => [d.state, d.tool, d.action, d.target]), [['pending', 'mail_send', 'send', 'mail:support']]);
  const approvedPayload = JSON.parse(drafts[0]!.payload) as Record<string, unknown>;
  assert.deepEqual(approvedPayload, { from: SENDER_ADDRESS, ...MAIL_ARGS }, 'the host filled from; the agent never sent it');

  // 2) 검증기 -> 사람의 한 번. 화면에 보이는 payload = 보낼 payload
  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['needs_review']);
  const shown = show(r, taskId)['drafts'] as { payload: unknown; target: string }[];
  assert.deepEqual(shown[0]!.payload, approvedPayload);
  assert.equal(shown[0]!.target, 'mail:support');
  approveAndRelease(r, taskId);
  assert.equal(r.server.connections(), 0, 'approval alone sends nothing');

  // 3) 전송 run: 에이전트 호출 0회, 서버가 받은 바이트가 승인된 payload 와 같다
  assert.equal((await r.daemon.worker.tick()).executed?.taskId, taskId);
  assert.equal(r.adapterRuns.count, 1, 'no LLM in the dispatch run');
  assert.equal(r.server.messages.length, 1);
  const message = r.server.messages[0]!;
  assert.deepEqual([message.mailFrom, message.recipients], [SENDER_ADDRESS, ['customer@example.com']]);
  const decoded = decodeMail(message.data);
  assert.equal(decoded.subject, approvedPayload['subject']);
  assert.equal(decoded.text, approvedPayload['text']);
  assert.equal(decoded.headers.get('From'), SENDER_ADDRESS);
  assert.equal(decoded.headers.get('To'), 'customer@example.com');
  assert.equal(decoded.headers.get('List-Unsubscribe'), `<mailto:${UNSUBSCRIBE}?subject=unsubscribe>`);
  const [effect] = effectsOf(r, taskId);
  assert.equal(effectsOf(r, taskId).length, 1);
  assert.deepEqual([effect!.state, effect!.tool, effect!.target, effect!.supports_idempotency], ['confirmed', 'mail_send', 'mail:support', 0]);
  assert.equal(effect!.response_ref, decoded.headers.get('Message-ID'), 'response_ref is the Message-ID');
  assert.equal(decoded.headers.get('Message-ID')!.slice(1, 33), effect!.effect_key.slice(0, 32));
  const draft = draftsOf(r.env.db, taskId)[0] as EffectDraftRow;
  assert.equal(canonicalJson(JSON.parse(draft.payload)), draft.payload);

  assert.deepEqual((await r.daemon.worker.tick()).validated.map((v) => v.taskStatus), ['completed']);
  assert.equal(r.server.messages.length, 1);
});

test('the connection drops right after the end-of-data dot: the effect is unknown, the task needs a person, the server has exactly one message and nothing is resent', async (t) => {
  const r = await rig(t, { dropAfterDot: true });
  const taskId = mailTask(r);
  await draftUntilReview(r, taskId);
  approveAndRelease(r, taskId);

  const dispatched = await r.daemon.worker.tick();
  assert.equal(dispatched.executed?.taskId, taskId);
  assert.equal(r.server.messages.length, 1);
  assert.deepEqual(effectsOf(r, taskId).map((e) => e.state), ['unknown']);
  assert.equal(taskStatus(r.env.db, taskId), 'needs_review');
  assert.equal(r.adapterRuns.count, 1);

  // 시간이 지나고 워커가 계속 돌아도 다시 보내지 않는다 (멱등 미지원이라 재전송 금지)
  for (let i = 0; i < 3; i += 1) {
    r.env.clock.advance(HOUR);
    await r.daemon.worker.tick();
  }
  assert.equal(r.server.messages.length, 1, 'no resend');
  assert.equal(r.server.connections(), 1);
  assert.deepEqual(effectsOf(r, taskId).map((e) => e.state), ['unknown']);
  assert.equal(taskStatus(r.env.db, taskId), 'needs_review');
});

test('a recipient suppressed after the approval: nothing is sent (no connection), the effect is failed', async (t) => {
  const r = await rig(t);
  const taskId = mailTask(r);
  await draftUntilReview(r, taskId);
  approveAndRelease(r, taskId);
  addContact(r.env.db, r.env.clock, 'customer@example.com', 'suppressed'); // 승인 뒤에 수신 거부가 들어왔다

  const dispatched = await r.daemon.worker.tick();
  assert.equal(dispatched.executed?.taskId, taskId);
  assert.equal(r.server.connections(), 0);
  assert.equal(r.server.messages.length, 0);
  assert.deepEqual(effectsOf(r, taskId).map((e) => [e.state, e.response_ref]), [['failed', null]]);
  assert.notEqual(taskStatus(r.env.db, taskId), 'completed');
  // 재승인해도 다시 보내지 않는다 (failed 효과는 재전송하지 않는다)
  await r.daemon.worker.tick();
  assert.equal(r.server.connections(), 0);
});

test('a hard bounce at RCPT (550 5.1.1) fails the effect, sends no message, and suppresses the existing active contact as the host with an audit event', async (t) => {
  const r = await rig(t, { rejectRcpt: ['customer@example.com'] });
  addContact(r.env.db, r.env.clock, 'customer@example.com');
  const taskId = mailTask(r);
  await draftUntilReview(r, taskId);
  approveAndRelease(r, taskId);
  await r.daemon.worker.tick();

  assert.equal(r.server.connections(), 1);
  assert.equal(r.server.messages.length, 0, 'no message was accepted');
  assert.deepEqual(effectsOf(r, taskId).map((e) => e.state), ['failed']);
  const row = contactRow(r.env.db, 'customer@example.com')!;
  assert.deepEqual([row.status, row.suppressed_by, row.added_by], ['suppressed', null, OWNER]);
  const [event] = eventsOf(r.env.db, 'mail.feedback.hard_bounce');
  assert.equal(eventsOf(r.env.db, 'mail.feedback.hard_bounce').length, 1);
  assert.equal(event!.source, 'mail');
  assert.match(event!.payload, /smtp_550_5\.1\.1/);
  assert.ok(!event!.payload.includes('First line'), 'no mail content in the audit event');
});

test('draft stage refusals reach the agent as tool errors and leave no draft: suppressed recipient, from, extra keys, no sender in the spec', async (t) => {
  for (const [label, args, target] of [
    ['suppressed recipient', MAIL_ARGS, 'mail:support'],
    ['from from the agent', { ...MAIL_ARGS, from: 'ceo@sender.example.com' }, 'mail:support'],
    ['bcc', { ...MAIL_ARGS, bcc: ['x@example.com'] }, 'mail:support'],
    ['sender not configured', MAIL_ARGS, 'mail:sales'],
  ] as const) {
    const r = await rig(t, {}, args as unknown as Record<string, unknown>);
    addContact(r.env.db, r.env.clock, 'customer@example.com', label === 'suppressed recipient' ? 'suppressed' : 'active');
    const taskId = mailTask(r, target);
    await r.daemon.worker.tick();
    assert.deepEqual(r.records.map((rec) => rec.outcome), ['tool_error'], label);
    assert.deepEqual(draftsOf(r.env.db, taskId), [], label);
    assert.equal(r.server.connections(), 0, label);
  }
});

test('a task spec that does not name the sender is refused at creation (mail_target)', async (t) => {
  const r = await rig(t);
  assert.throws(() => createWithGate(r.env, effectDraft({
    ...validationSpec(['url_reachable', 'budget']),
    allowed_tools: [{ tool: 'mail_send', operations: ['send'], scope: 'customer', impact: 'external_effect' }],
  })), /mail_target|needs a target/);
});
