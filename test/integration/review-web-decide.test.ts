// 검토 화면 → 실제 승인 엔진 (진짜 Unix 소켓): 화면의 폼을 POST 하면 엔진이 기록한다 (docs/plans/decision-delegation.md 트랙 C).
// 가짜 엔진이 아니라 ApprovalEngine 그대로다. 승인·거절(이유 있음/없음)·다시 쓰게·낡은 해시·이미 결정됨·위임 승인 취소 → 위임 자동 정지·정지 해제를 확인한다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { startApprovalServer, type ApprovalEngine } from '@aot/policy';

import { createReviewContext } from '../../apps/daemon/src/review-web/context.ts';
import { openReadOnlyDb } from '../../apps/daemon/src/review-web/read-only-db.ts';
import { startReviewServer } from '../../apps/daemon/src/review-web/server.ts';
import { createSocketClient, type DecisionClient, type SendOutcome } from '../../apps/daemon/src/review-web/write-state.ts';
import { approvalsOf, controlsOf, decide, DELEGATE, delegationEnv, draftedFor, hashOf } from '../support/delegation.ts';
import { policyEnv, OWNER, type PolicyEnv } from '../support/policy.ts';
import { rawRequest } from '../support/review-web.ts';
import { encodeForm, formsOf, rawPost, type PageForm } from '../support/review-web-write.ts';

const textOf = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

interface Rig {
  env: PolicyEnv;
  /** 화면이 엔진에 보낸 요청 (순서대로, whoami 제외) */
  sent: Record<string, unknown>[];
  /** 다음 요청을 엔진에 넘기기 직전에 한 번 실행한다 (보낸 뒤 상태가 바뀌는 경쟁을 만든다) */
  beforeSend: (hook: (request: Record<string, unknown>) => Record<string, unknown> | void) => void;
  get(path: string): Promise<{ status: number; text: string }>;
  forms(path: string): Promise<Map<string, PageForm>>;
  /** 폼 하나를 보내고 결과 화면의 글을 돌려준다 */
  submit(form: PageForm, extra?: Record<string, string>): Promise<string>;
}

async function rig(t: TestContext, envMaker: (t: TestContext) => PolicyEnv = (x) => policyEnv(x, { file: true })): Promise<Rig> {
  const env = envMaker(t);
  const socketPath = join(env.dir, 'run', 'approval.sock');
  const engine: ApprovalEngine = env.engine;
  const server = await startApprovalServer({ socketPath, handle: (request) => engine.handle(request as never) });
  t.after(() => server.close());
  const sent: Record<string, unknown>[] = [];
  let hook: ((request: Record<string, unknown>) => Record<string, unknown> | void) | null = null;
  const inner = createSocketClient(socketPath, 5_000);
  const client: DecisionClient = {
    async send(request): Promise<SendOutcome> {
      let out = request;
      if (hook !== null && request['cmd'] !== 'whoami') {
        const run = hook;
        hook = null;
        out = run(request) ?? request;
      }
      if (request['cmd'] !== 'whoami') sent.push(out);
      return inner.send(out);
    },
  };
  const db = openReadOnlyDb(env.dbPath);
  t.after(() => db.close());
  const ctx = createReviewContext({ db, clock: env.clock, policyStoreDir: join(env.dir, 'policies'), evidenceDir: join(env.dir, 'evidence'), writer: { actor: OWNER, client } });
  const web = await startReviewServer(ctx, { port: 0 });
  t.after(() => web.close());
  const cookie = `aot_review=${web.token}`;
  const get = async (path: string) => {
    const reply = await rawRequest(web.port, path, { cookie });
    return { status: reply.status, text: reply.text };
  };
  const forms = async (path: string) => {
    env.clock.advance(1_000); // 새 nonce
    return formsOf((await get(path)).text);
  };
  const submit = async (form: PageForm, extra: Record<string, string> = {}): Promise<string> => {
    const reply = await rawPost(web.port, '/decide', encodeForm({ ...form.fields, ...extra }), { cookie });
    assert.equal(reply.status, 303, reply.text);
    const page = await get(String(reply.headers['location']));
    assert.equal(page.status, 200);
    return textOf(page.text);
  };
  return { env, sent, beforeSend: (fn) => { hook = fn; }, get, forms, submit };
}

const taskPath = (id: string): string => `/approvals/task/${encodeURIComponent(id)}`;
const statusOf = (env: PolicyEnv, id: string): string => env.db.get<{ status: string }>('SELECT status FROM task WHERE id = ?', [id])!.status;
const humanRows = (env: PolicyEnv, id: string) => approvalsOf(env.db, id).filter((row) => row.mandate_id === null);

test('screen approve -> engine records a human approval with via=web, bound to the shown hash', async (t) => {
  const r = await rig(t);
  const { taskId } = await draftedFor(r.env);
  const hash = hashOf(r.env, taskId);
  const forms = await r.forms(taskPath(taskId));
  assert.deepEqual([...forms.keys()].sort(), ['approve', 'changes', 'reject']);
  const text = await r.submit(forms.get('approve')!);
  assert.match(text, /승인했습니다/);
  const [row] = humanRows(r.env, taskId);
  assert.deepEqual([row?.decision, row?.decided_by, row?.via, row?.subject_hash], ['approved', OWNER, 'web', hash]);
  const request = r.sent.at(-1)!;
  assert.deepEqual([request['cmd'], request['via'], request['hash']], ['approve', 'web', hash]);
});

test('screen reject with a reason and without one: the engine fails the task and keeps the reason (or its own default)', async (t) => {
  const r = await rig(t);
  const withReason = (await draftedFor(r.env, { dedupeKey: 'a' })).taskId;
  const without = (await draftedFor(r.env, { dedupeKey: 'b' })).taskId;
  const first = await r.forms(taskPath(withReason));
  assert.match(await r.submit(first.get('reject')!, { reason: '받는 사람이 맞지 않음' }), /거절했습니다/);
  const second = await r.forms(taskPath(without));
  assert.match(await r.submit(second.get('reject')!), /거절했습니다/);
  assert.deepEqual([statusOf(r.env, withReason), statusOf(r.env, without)], ['failed', 'failed']);
  assert.deepEqual(humanRows(r.env, withReason).map((x) => [x.decision, x.comment, x.via]), [['rejected', '받는 사람이 맞지 않음', 'web']]);
  assert.deepEqual(humanRows(r.env, without).map((x) => [x.decision, x.via]), [['rejected', 'web']]);
  const rejects = r.sent.filter((x) => x['cmd'] === 'reject');
  assert.ok(rejects.every((x) => /^[0-9a-f]{64}$/.test(String(x['expected_hash'])) && x['via'] === 'web'));
  assert.equal(rejects[1]!['comment'], undefined, 'no reason typed: no comment sent');
});

test('screen request_changes: the reason is required, the drafts are discarded and the task goes back to the queue', async (t) => {
  const r = await rig(t);
  const { taskId } = await draftedFor(r.env);
  const forms = await r.forms(taskPath(taskId));
  const form = forms.get('changes')!;
  assert.match(await r.submit(form, { reason: '인사말을 짧게' }), /다시 쓰라고 요청했습니다/);
  assert.equal(statusOf(r.env, taskId), 'queued');
  assert.deepEqual(humanRows(r.env, taskId).map((x) => [x.decision, x.comment, x.via]), [['changes_requested', '인사말을 짧게', 'web']]);
  assert.equal(r.sent.at(-1)!['cmd'], 'request_changes');
});

test('stale hash at the engine: a wrong expected_hash comes back as hash_mismatch and the page shows one conclusion line plus the next step', async (t) => {
  const r = await rig(t);
  const { taskId } = await draftedFor(r.env);
  const forms = await r.forms(taskPath(taskId));
  r.beforeSend((request) => ({ ...request, expected_hash: 'f'.repeat(64) }));
  const text = await r.submit(forms.get('reject')!);
  assert.match(text, /결정이 반영되지 않았습니다\. 그 사이 내용이 바뀌었습니다\./);
  assert.match(text, /새 내용 보기/);
  assert.deepEqual(humanRows(r.env, taskId), []);
  assert.equal(statusOf(r.env, taskId), 'needs_review');
  const first = text.split('자세히')[0]!;
  assert.ok(!/hash|expected|mismatch|[0-9a-f]{16}/i.test(first), `no engine text before 자세히: ${first}`);
});

test('wrong_state: someone else decided in between -> "이미 다른 결정이 났습니다" and the second decision is not recorded', async (t) => {
  const r = await rig(t);
  const { taskId } = await draftedFor(r.env);
  const forms = await r.forms(taskPath(taskId));
  r.beforeSend(() => {
    assert.equal(r.env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: taskId, comment: 'cli' }).ok, true);
  });
  const text = await r.submit(forms.get('approve')!);
  assert.match(text, /이미 다른 결정이 났습니다/);
  assert.deepEqual(humanRows(r.env, taskId).map((x) => x.decision), ['rejected']);
  assert.equal(humanRows(r.env, taskId)[0]!.via, null, 'the earlier decision came from outside the screen');
});

test('a decision that left the inbox before the POST is refused by the screen itself (gone) and never reaches the engine', async (t) => {
  const r = await rig(t);
  const { taskId } = await draftedFor(r.env);
  const forms = await r.forms(taskPath(taskId));
  assert.equal(r.env.send({ cmd: 'reject', actor: OWNER, kind: 'task', id: taskId }).ok, true);
  const text = await r.submit(forms.get('approve')!);
  assert.match(text, /이미 다른 결정이 났거나/);
  assert.equal(r.sent.length, 0);
});

test('delegated approval: it is not a decision, it shows in the AI digest with its reason and a cancel button; cancelling pauses the delegation, and resuming needs the OTP', async (t) => {
  const r = await rig(t, (x) => delegationEnv(x, [{}], { file: true }));
  const { taskId } = await draftedFor(r.env);
  assert.equal(decide(r.env, taskId, 'approve', '정기 안내 메일이고 가격 언급이 없음').ok, true);

  // 결정할 일에는 없고, AI가 처리함 요약에만 있다
  const home = await r.get('/');
  const homeText = textOf(home.text);
  assert.match(homeText, /지금 결정할 일이 없습니다/);
  assert.match(homeText, /AI가 처리함/);
  assert.match(homeText, /AI가 지난 24시간에 1건 처리함\. 1건은 아직 나가지 않았고 취소할 수 있습니다/);
  assert.match(homeText, /AI의 판단: 정기 안내 메일이고 가격 언급이 없음/);
  assert.match(homeText, /분 뒤 나감|곧 나감|시간 뒤 나감/);
  assert.ok(!home.text.includes(`href="${taskPath(taskId)}"`), 'no decision card or link for it');
  assert.ok(!/[0-9a-f]{40,}|20\d\d-\d\d-\d\dT/.test(textOf(home.text)), 'no hash or ISO time on the first view');
  assert.match(textOf((await r.get(taskPath(taskId))).text), /AI가 처리한 일입니다/);

  const forms = await r.forms('/delegated');
  assert.deepEqual([...forms.keys()].sort(), ['cancel', 'pause']);
  const text = await r.submit(forms.get('cancel')!);
  assert.match(text, /취소했습니다\. 같은 종류의 AI 처리는 멈췄고/);
  const cancel = r.sent.at(-1)!;
  assert.deepEqual([cancel['cmd'], cancel['via'], cancel['expected_hash']], ['cancel', 'web', hashOf(r.env, taskId)]);
  assert.deepEqual(approvalsOf(r.env.db, taskId).map((x) => [x.decision, x.decided_by, x.mandate_id === null ? 'human' : 'delegate']), [['approved', DELEGATE, 'delegate'], ['rejected', OWNER, 'human']]);
  assert.equal(approvalsOf(r.env.db, taskId).at(-1)!.via, 'web');
  assert.deepEqual(controlsOf(r.env.db).map((x) => [x.action, x.actor_id]), [['pause', OWNER]]);

  // 멈춘 상태가 보인다: 취소됨 + 다시 켜기(OTP)
  const after = textOf((await r.get('/delegated')).text);
  assert.match(after, /위임이 멈춰 있어/);
  assert.match(after, /취소됨/);
  const resumeForms = await r.forms('/delegated');
  assert.deepEqual([...resumeForms.keys()], ['resume0']);
  assert.match(resumeForms.get('resume0')!.html, /autocomplete="one-time-code"/);
  assert.match(await r.submit(resumeForms.get('resume0')!, { totp: '000000' }), /OTP 코드가 맞지 않습니다/);
  assert.deepEqual(controlsOf(r.env.db).map((x) => x.action), ['pause']);
  const again = await r.forms('/delegated');
  r.env.clock.advance(60_000);
  assert.match(await r.submit(again.get('resume0')!, { totp: r.env.code() }), /위임을 다시 켰습니다/);
  assert.deepEqual(controlsOf(r.env.db).map((x) => x.action), ['pause', 'resume']);
  // 취소한 건은 사람이 결정할 일로 남는다 (되살아나지 않는다)
  assert.match(textOf((await r.get('/')).text), /결정할 일 1건|바깥에 나가는 일 1건/);
});

test('"pause delegation" from the digest voids a waiting AI approval: the task returns to the inbox with a one-line reason', async (t) => {
  const r = await rig(t, (x) => delegationEnv(x, [{}], { file: true }));
  const { taskId } = await draftedFor(r.env);
  assert.equal(decide(r.env, taskId).ok, true);
  const forms = await r.forms('/delegated');
  assert.match(await r.submit(forms.get('pause')!), /위임을 멈췄습니다/);
  assert.deepEqual(controlsOf(r.env.db).map((x) => [x.action, x.mandate_id]), [['pause', null]]);
  const home = textOf((await r.get('/')).text);
  assert.match(home, /결정할 일 1건/);
  assert.match(home, /AI가 넘긴 이유 위임이 멈추거나 바뀌어/);
  assert.match(textOf((await r.get('/delegated')).text), /사람이 결정할 일로 돌아옴/);
});

test('an item the AI handed to a person shows the AI reason as a fact line on its card', async (t) => {
  const r = await rig(t, (x) => delegationEnv(x, [{}], { file: true }));
  const { taskId } = await draftedFor(r.env);
  assert.equal(decide(r.env, taskId, 'escalate', '가격 이야기가 들어 있어 사람이 봐야 합니다').ok, true);
  const home = textOf((await r.get('/')).text);
  assert.match(home, /AI가 넘긴 이유 가격 이야기가 들어 있어 사람이 봐야 합니다/);
  assert.ok(!/AI가 처리함/.test(home), 'nothing was handled by the AI');
});

test('an item handed over because of an unknown recipient says so in words on its card, with no command on the screen', async (t) => {
  const r = await rig(t, (x) => delegationEnv(x, [{}], { file: true }));
  const { taskId } = await draftedFor(r.env, { requests: [{ to: ['stranger@example.com'], subject: 'Hello', text: 'First line' }] });
  assert.equal(decide(r.env, taskId).ok, false);
  const home = textOf((await r.get('/')).text);
  assert.match(home, /AI가 넘긴 이유 처음 보는 받는 사람 1명/);
  assert.ok(!/contacts (add|import|suppress)|aot-approve/.test(home), 'no CLI command on the screen');
});
