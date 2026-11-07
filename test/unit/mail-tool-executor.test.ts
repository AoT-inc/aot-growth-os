// 메일 게이트웨이 실행기 (ADR-0017 §3·§4): 인자 검증, from 채움, target 해소, 수신 거부·비밀 거부, 원장 입구로 넘기는 모양.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  createMailToolExecutor, isEffectLedgerBound, mailToolSpecs, MailToolError, type JsonObject, type MailEffectOutcome, type MailEffectStep, type ToolExecutionRequest,
} from '@aot/agent-runtime';
import { canonicalJson, sha256Hex } from '@aot/domain';

import { addContact, SENDER_ADDRESS, SENDERS } from '../support/mail.ts';
import { seededDb } from '../support/seeded-db.ts';

function rig(t: TestContext, over: { targets?: string[]; outcome?: MailEffectOutcome } = {}) {
  const env = seededDb(t);
  const calls: { tool: string; step: MailEffectStep; meta: { influenced: boolean } | undefined }[] = [];
  const executor = createMailToolExecutor({
    ledger: (tool, step, meta) => {
      calls.push({ tool, step, meta });
      return Promise.resolve(over.outcome ?? { state: 'drafted', draftId: 'draft-1' });
    },
    db: env.db, targets: over.targets ?? ['mail:support'], senders: SENDERS,
  });
  const run = (args: Record<string, unknown>, influenced = false) =>
    executor({ runId: 'r', tool: 'mail_send', operation: 'send', args: args as JsonObject, signal: new AbortController().signal, constraints: {} as never, influencedByExternalInput: influenced } satisfies ToolExecutionRequest);
  return { ...env, calls, run, executor };
}
const args = (over: Record<string, unknown> = {}) => ({ to: ['customer@example.com'], subject: 'Hello', text: 'Body', ...over });

const code = (promise: Promise<unknown>): Promise<string> => promise.then(() => 'no error', (e: unknown) => (e instanceof MailToolError ? e.code : `other: ${String(e)}`));

test('the tool declaration: mail_send.send, customer scope, external effect, side effect; the executor is ledger-bound', (t) => {
  assert.deepEqual(mailToolSpecs(), [{ tool: 'mail_send', operation: 'send', scope: 'customer', impact: 'external_effect', sideEffect: true }]);
  assert.equal(isEffectLedgerBound(rig(t).executor), true);
});

test('a valid call fills from, uses a payload-derived step id and the spec target, and returns the draft id', async (t) => {
  const r = rig(t);
  const result = await r.run(args({ cc: ['b@example.com'] }), true);
  assert.deepEqual(result, { result: { status: 'drafted', draft_id: 'draft-1' } });
  const [call] = r.calls;
  assert.equal(r.calls.length, 1);
  assert.equal(call!.tool, 'mail_send');
  const expected = { from: SENDER_ADDRESS, to: ['customer@example.com'], cc: ['b@example.com'], subject: 'Hello', text: 'Body' };
  assert.deepEqual(call!.step, { stepId: `mail-${sha256Hex(canonicalJson(expected)).slice(0, 16)}`, action: 'send', target: 'mail:support', request: expected });
  assert.deepEqual(call!.meta, { influenced: true });
  // 같은 내용은 같은 단계, 다른 내용은 다른 단계
  await r.run(args({ cc: ['b@example.com'] }));
  await r.run(args({ subject: 'Other' }));
  assert.equal(r.calls[1]!.step.stepId, call!.step.stepId);
  assert.notEqual(r.calls[2]!.step.stepId, call!.step.stepId);
});

test('a non-drafted outcome (dispatch or approval-scope flows) reports the ledger state', async (t) => {
  const r = rig(t, { outcome: { state: 'confirmed', effectId: 'e1' } });
  assert.deepEqual(await r.run(args()), { result: { status: 'confirmed' } });
});

test('from is never accepted from the agent; unknown arguments are refused', async (t) => {
  const r = rig(t);
  assert.equal(await code(r.run(args({ from: SENDER_ADDRESS }))), 'from_not_allowed');
  assert.equal(await code(r.run(args({ from: 'ceo@sender.example.com' }))), 'from_not_allowed');
  for (const key of ['bcc', 'reply_to', 'headers', 'html']) assert.equal(await code(r.run(args({ [key]: 'x' }))), 'invalid_args', key);
  assert.equal(r.calls.length, 0);
});

test('payload rule violations are refused with the field path (to count, cc domain, subject, text)', async (t) => {
  const r = rig(t);
  for (const bad of [
    { to: ['a@example.com', 'b@example.com'] }, { to: 'a@example.com' }, { to: ['A@Example.com'] }, { cc: [] }, { cc: ['x@example.org'] },
    { subject: 'a\nb' }, { subject: '' }, { text: 'a\rb' }, { text: '' },
  ]) {
    assert.equal(await code(r.run(args(bad))), 'invalid_payload', JSON.stringify(bad));
  }
  await assert.rejects(() => r.run(args({ to: [] })), /to: to must contain exactly one address/);
  assert.equal(r.calls.length, 0);
});

test('target resolution: none -> no_target, two different senders -> ambiguous_sender, the same target twice is fine, unconfigured -> unknown_sender', async (t) => {
  assert.equal(await code(rig(t, { targets: [] }).run(args())), 'no_target');
  assert.equal(await code(rig(t, { targets: ['mail:support', 'mail:sales'] }).run(args())), 'ambiguous_sender');
  assert.equal((await rig(t, { targets: ['mail:support', 'mail:support'] }).run(args())).result !== undefined, true);
  assert.equal(await code(rig(t, { targets: ['mail:sales'] }).run(args())), 'unknown_sender');
  assert.equal(await code(rig(t, { targets: ['mail:__proto__'] }).run(args())), 'unknown_sender');
});

test('a suppressed recipient (to or cc) is refused at the draft stage; unknown and active addresses pass', async (t) => {
  const r = rig(t);
  addContact(r.db, r.clock, 'gone@example.com', 'suppressed');
  addContact(r.db, r.clock, 'ok@example.com');
  assert.equal(await code(r.run(args({ to: ['gone@example.com'] }))), 'recipient_suppressed');
  assert.equal(await code(r.run(args({ to: ['customer@example.com'], cc: ['gone@example.com'] }))), 'recipient_suppressed');
  assert.equal(r.calls.length, 0);
  assert.equal(await code(r.run(args({ to: ['ok@example.com'] }))), 'no error');
  assert.equal(await code(r.run(args({ to: ['stranger@example.com'] }))), 'no error');
});

test('a subject or text that the secret mask would change is refused (it could not be approved on the review screen)', async (t) => {
  const r = rig(t);
  assert.equal(await code(r.run(args({ text: 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }))), 'secret_like');
  assert.equal(await code(r.run(args({ subject: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }))), 'secret_like');
  assert.equal(r.calls.length, 0);
});

test('errors carry only the code and a short message', async (t) => {
  const r = rig(t, { targets: [] });
  await assert.rejects(() => r.run(args()), (error: unknown) => error instanceof MailToolError && /^no_target: /.test(error.message));
});
