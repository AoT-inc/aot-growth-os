// 검토 화면에서 결정 보내기 (docs/operations/review-web.md "화면에서 결정하기", 설계 docs/plans/decision-delegation.md §2.3·§2.4):
// CSRF(쿠키·Origin·Sec-Fetch-Site·Content-Type·크기·nonce), 낡은 화면 막기, 행위자, OTP, 속도 제한, 실패 문구, PRG 결과, DB 읽기 전용 — 가짜 승인 엔진(진짜 Unix 소켓)으로 확인한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { openDb } from '@aot/domain';
import { ApprovalEngine, PolicyStore, TotpSecretStore } from '@aot/policy';

import { DEFAULT_POLICY_TEMPLATE } from '../../apps/daemon/src/assemble.ts';
import { connectWriter, createSocketClient } from '../../apps/daemon/src/review-web/write-state.ts';
import { NOW_MS, rawRequest } from '../support/review-web.ts';
import { encodeForm, formsOf, startWriteRig, type PageForm, type WriteRig } from '../support/review-web-write.ts';
import { makeTempDir } from '../support/temp.ts';

const textOf = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const OWNER = 'actor-owner';

const methodRequest = (rig: WriteRig, method: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> => rawRequest(rig.server.port, path, { method, cookie: `aot_review=${rig.server.token}` });
const orgPath = (rig: WriteRig): string => `/approvals/org_proposal/${rig.demo.ids.orgNormal}`;
const engineHash = (rig: WriteRig, kind: string, id: string): string => (rig.ctx.engine.handle({ cmd: 'show', actor: OWNER, kind, id }) as unknown as { hash: string }).hash;

/** 폼의 필드 + 입력한 값으로 POST. 이름이 겹치면 `extra` 가 이긴다 */
const submit = (rig: WriteRig, form: PageForm, extra: Record<string, string> = {}, options: Parameters<WriteRig['post']>[2] = {}) => rig.post('/decide', encodeForm({ ...form.fields, ...extra }), options);
const resultOf = async (rig: WriteRig, reply: { status: number; headers: Record<string, string | string[] | undefined> }): Promise<string> => {
  assert.equal(reply.status, 303);
  const location = String(reply.headers['location']);
  assert.match(location, /^\/result\/[0-9a-f]{32}$/);
  const page = await rig.get(location);
  assert.equal(page.status, 200);
  return textOf(page.text);
};
/** 새 nonce 가 나오도록 시각을 조금 옮긴 뒤 폼을 읽는다 */
const freshForms = async (rig: WriteRig, path: string): Promise<Map<string, PageForm>> => {
  rig.clock.advance(1_000);
  return rig.forms(path);
};
const requestsOf = (rig: WriteRig): Record<string, unknown>[] => rig.sent.filter((r) => r['cmd'] !== 'whoami');

test('without --actor the screen is view-only: no forms, a notice, and POST /decide is 405', async (t) => {
  const rig = await startWriteRig(t, { actor: null });
  const page = await rig.get(orgPath(rig));
  assert.equal(formsOf(page.text).size, 0);
  assert.ok(!page.text.includes('<form') && textOf(page.text).includes('보기 전용'));
  const reply = await rig.post('/decide', 'key=x');
  assert.equal(reply.status, 405);
  assert.equal(reply.headers['allow'], 'GET, HEAD');
  assert.equal(rig.sent.length, 0);
});

test('startup checks the actor over the socket: a human enables decisions; anything else leaves the screen view-only with the reason', async (t) => {
  const rig = await startWriteRig(t, { actor: null });
  const ok = await connectWriter(OWNER, createSocketClient(rig.socketPath, 1_000));
  assert.equal(ok.writer?.actor, OWNER);
  assert.equal(rig.sent[0]!['cmd'], 'whoami');
  rig.respond(() => ({ ok: true, actor: 'agent-x', kind: 'agent' }));
  assert.match((await connectWriter('agent-x', createSocketClient(rig.socketPath, 1_000))).notice ?? '', /사람이 아니거나/);
  rig.respond(() => ({ ok: false, error: 'unknown actor' }));
  assert.match((await connectWriter('nobody', createSocketClient(rig.socketPath, 1_000))).notice ?? '', /사람이 아니거나/);
  assert.match((await connectWriter(null, createSocketClient(rig.socketPath, 1_000))).notice ?? '', /--actor/);
  const down = await startWriteRig(t, { actor: null, startEngine: false });
  const gone = await connectWriter(OWNER, createSocketClient(down.socketPath, 1_000));
  assert.equal(gone.writer, undefined);
  assert.match(gone.notice ?? '', /닿지 못해/);
});

test('a decision page offers buttons only when decisions are on, and the first screen never shows an actor flag or command', async (t) => {
  const rig = await startWriteRig(t);
  const page = await rig.get(orgPath(rig));
  assert.deepEqual([...formsOf(page.text).keys()], ['approve', 'reject']);
  assert.ok(page.text.includes('<form class="act" method="post" action="/decide">'));
  assert.ok(!/<script|<iframe|<link |https?:\/\/[^\s"'<]*\.(js|css|woff2?|png)/i.test(page.text), 'still no scripts or external resources');
  assert.equal(page.headers['content-security-policy']?.toString().includes("form-action 'self'"), true);
});

test('CSRF: cookie, Origin, Sec-Fetch-Site, Content-Type and size are checked before anything reaches the engine', async (t) => {
  const rig = await startWriteRig(t);
  const forms = await rig.forms(orgPath(rig));
  const body = encodeForm(forms.get('approve')!.fields);
  const port = rig.server.port;
  // 쿠키 없음/틀림
  assert.equal((await rig.post('/decide', body, { cookie: null })).status, 401);
  assert.equal((await rig.post('/decide', body, { cookie: 'aot_review=wrong' })).status, 401);
  // Origin: 없음 / 다른 사이트 / 다른 포트 / Host 와 다름 / 문자열 흉내
  for (const origin of [null, 'null', 'http://evil.example', `http://evil.example:${port}`, `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}.evil.example`, `http://127.0.0.1:${port}/`]) {
    const reply = await rig.post('/decide', body, { origin });
    assert.equal(reply.status, 403, String(origin));
  }
  // Host 가 localhost 이면 Origin 도 localhost 여야 한다
  assert.equal((await rig.post('/decide', body, { host: `localhost:${port}`, origin: `http://127.0.0.1:${port}` })).status, 403);
  assert.equal((await rig.post('/decide', body, { host: 'evil.example', origin: 'http://evil.example' })).status, 421);
  // Sec-Fetch-Site 가 있으면 same-origin 이어야 한다
  for (const site of ['cross-site', 'same-site', 'none']) assert.equal((await rig.post('/decide', body, { secFetchSite: site })).status, 403, site);
  // Content-Type 은 폼만
  for (const contentType of [null, 'application/json', 'text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded-evil']) assert.equal((await rig.post('/decide', body, { contentType })).status, 415, String(contentType));
  // 크기: 16KB 초과 (Content-Length 로, 그리고 Content-Length 를 속여도)
  assert.equal((await rig.post('/decide', `${body}&pad=${'x'.repeat(17_000)}`)).status, 413);
  // 다른 메서드·다른 경로
  assert.equal((await rig.get('/decide')).status, 405);
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const reply = await methodRequest(rig, method, '/decide');
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers['allow'], 'GET, HEAD, POST');
  }
  assert.equal((await rig.post('/approvals/anything', body)).status, 405);
  assert.equal((await rig.post('/', body)).status, 405);
  assert.equal(requestsOf(rig).length, 0, 'none of the rejected requests reached the engine');
  // 맞는 요청은 통과한다 (Origin 이 localhost 이고 Host 도 localhost)
  const ok = await rig.post('/decide', body, { host: `localhost:${port}`, origin: `http://localhost:${port}`, secFetchSite: 'same-origin' });
  assert.equal(ok.status, 303);
});

test('a slow or unfinished body times out instead of holding the connection', async (t) => {
  const rig = await startWriteRig(t);
  const { request } = await import('node:http');
  const reply = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: rig.server.port, path: '/decide', method: 'POST', setHost: false,
      headers: { Host: `127.0.0.1:${rig.server.port}`, Origin: `http://127.0.0.1:${rig.server.port}`, Cookie: `aot_review=${rig.server.token}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '100' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.write('key=');
  });
  assert.equal(reply, 408);
  assert.equal(requestsOf(rig).length, 0);
});

test('nonce: missing, tampered, for another target, reused, expired or from another run is never sent', async (t) => {
  const rig = await startWriteRig(t);
  const forms = await rig.forms(orgPath(rig));
  const approve = forms.get('approve')!;
  const reject = forms.get('reject')!;
  // 없음/틀림/다른 버튼·대상·지문
  assert.equal((await submit(rig, approve, { nonce: '' })).status, 403);
  assert.equal((await submit(rig, approve, { nonce: 'a'.repeat(64) })).status, 403);
  assert.equal((await submit(rig, approve, { nonce: reject.fields['nonce']! })).status, 403, 'the reject nonce does not approve');
  assert.equal((await submit(rig, approve, { key: `org:${rig.demo.ids.orgRisky}` })).status, 403, 'another target');
  assert.equal((await submit(rig, approve, { hash: '0'.repeat(64) })).status, 403, 'another fingerprint');
  assert.equal((await submit(rig, approve, { issued: String(NOW_MS + 1) })).status, 403, 'another issue time');
  const missing = { ...approve.fields };
  delete missing['nonce'];
  assert.equal((await rig.post('/decide', encodeForm(missing))).status, 403);
  assert.equal(requestsOf(rig).length, 0);
  // 한 번 쓰면 끝: 같은 폼을 다시 보내도 엔진에는 한 번만 간다 (같은 결과로 되돌아간다)
  const first = await submit(rig, approve);
  assert.equal(first.status, 303);
  const again = await submit(rig, approve);
  assert.equal(again.status, 303);
  assert.equal(again.headers['location'], first.headers['location'], 'a double submit lands on the same result');
  assert.equal(requestsOf(rig).length, 1);
  // 30분이 지나면 만료
  const old = (await freshForms(rig, orgPath(rig))).get('reject')!;
  rig.clock.advance(31 * 60_000);
  const expired = await submit(rig, old);
  assert.match(await resultOf(rig, expired), /이 화면이 오래돼서 결정을 보내지 않았습니다/);
  assert.equal(requestsOf(rig).length, 1);
  // 다른 실행(다른 토큰)의 서버가 만든 nonce 는 맞지 않는다
  const other = await startWriteRig(t);
  const foreign = (await other.forms(orgPath(other))).get('approve')!;
  assert.equal((await submit(rig, foreign)).status, 403);
  assert.equal((await submit(other, foreign)).status, 303, 'but it is fine on its own server');
});

test('the request sent to the engine: the screen actor, via web, the hash the person saw, the optional reason; form fields cannot change what is sent', async (t) => {
  const rig = await startWriteRig(t);
  const id = rig.demo.ids.orgNormal;
  const hash = engineHash(rig, 'org_proposal', id);
  const forms = await rig.forms(orgPath(rig));
  const reply = await submit(rig, forms.get('approve')!, { actor: 'actor-evil', cmd: 'cancel', kind: 'task', id: 'x', via: 'cli', hash: forms.get('approve')!.fields['hash']!, comment: 'sneaky' });
  assert.match(await resultOf(rig, reply), /승인했습니다/);
  assert.deepEqual(requestsOf(rig), [{ cmd: 'approve', kind: 'org_proposal', id, hash, actor: OWNER, via: 'web' }]);
  // 거절: 이유는 선택. 낡은 화면 방지 expected_hash 가 실린다
  const rejectForm = (await freshForms(rig, `/approvals/org_proposal/${rig.demo.ids.orgRisky}`)).get('reject')!;
  const riskyHash = engineHash(rig, 'org_proposal', rig.demo.ids.orgRisky);
  assert.match(await resultOf(rig, await submit(rig, rejectForm)), /거절했습니다/);
  assert.deepEqual(requestsOf(rig)[1], { cmd: 'reject', kind: 'org_proposal', id: rig.demo.ids.orgRisky, expected_hash: riskyHash, actor: OWNER, via: 'web' });
  const taskPath = `/approvals/task/${rig.demo.ids.plainTask}`;
  const withReason = (await freshForms(rig, taskPath)).get('reject')!;
  await submit(rig, withReason, { reason: '  이번 분기에는 하지 않기로 함  ' });
  assert.deepEqual(requestsOf(rig)[2], { cmd: 'reject', kind: 'task', id: rig.demo.ids.plainTask, expected_hash: engineHash(rig, 'task', rig.demo.ids.plainTask), comment: '이번 분기에는 하지 않기로 함', actor: OWNER, via: 'web' });
  // 다시 쓰게: 이유 필수 (비어 있으면 보내지 않고 400)
  const draftTask = rig.demo.ids.task;
  const draftPath = `/approvals/task/${draftTask}`;
  const changes = (await freshForms(rig, draftPath)).get('changes')!;
  assert.equal((await submit(rig, changes, { reason: '   ' })).status, 400);
  assert.equal((await submit(rig, changes, { reason: 'x'.repeat(501) })).status, 400);
  assert.equal(requestsOf(rig).length, 3);
  assert.match(await resultOf(rig, await submit(rig, changes, { reason: '인사말을 짧게' })), /다시 쓰라고 요청했습니다/);
  assert.deepEqual(requestsOf(rig)[3], { cmd: 'request_changes', kind: 'task', id: draftTask, expected_hash: engineHash(rig, 'task', draftTask), comment: '인사말을 짧게', actor: OWNER, via: 'web' });
  // 이유 칸이 없는 버튼에 이유를 실으면 거부
  const approveDraft = (await freshForms(rig, draftPath)).get('approve')!;
  assert.equal((await submit(rig, approveDraft, { reason: '왜' })).status, 400);
  assert.equal(requestsOf(rig).length, 4);
  // 500자까지는 된다 (엔진 규칙 1~500)
  const edge = (await freshForms(rig, `/approvals/task/${rig.demo.ids.plainTask}`)).get('reject')!;
  assert.equal((await submit(rig, edge, { reason: 'ㄱ'.repeat(500) })).status, 303);
});

test('a batch button sends one request per task, in order, and reports each one', async (t) => {
  const rig = await startWriteRig(t);
  const home = (await rig.get('/')).text;
  const batchPath = /href="(\/batch\/[^"]*)"/.exec(home)![1]!;
  const forms = await rig.forms(batchPath);
  const outcome = await submit(rig, forms.get('approve')!);
  assert.match(await resultOf(rig, outcome), /승인했습니다/);
  const sent = requestsOf(rig);
  assert.equal(sent.length, 2, 'the expired draft task is left out');
  assert.ok(sent.every((r) => r['cmd'] === 'approve' && r['kind'] === 'task' && r['via'] === 'web' && r['actor'] === OWNER));
  for (const r of sent) assert.equal(r['hash'], engineHash(rig, 'task', String(r['id'])));
  // 일부 실패: 건별로 말한다
  rig.sent.length = 0;
  let n = 0;
  rig.respond(() => (++n === 2 ? { ok: false, error: 'x', code: 'hash_mismatch' } : { ok: true }));
  const again = (await freshForms(rig, batchPath)).get('approve')!;
  const text = await resultOf(rig, await submit(rig, again));
  assert.ok(text.includes('2건 중 1건 반영, 1건 실패: 내용이 바뀜'), text);
  assert.ok(text.includes('반영됨') && text.includes('실패') && text.includes('새 내용 보기'));
  // 모두 다시 쓰게: 같은 이유가 건마다 실린다
  rig.sent.length = 0;
  rig.respond(() => ({ ok: true }));
  const all = (await freshForms(rig, batchPath)).get('changes')!;
  await submit(rig, all, { reason: '문구를 다듬어 주세요' });
  const sentAll = requestsOf(rig);
  assert.equal(sentAll.length, 3, 'every task of the batch can be rewritten, the expired one too');
  assert.ok(sentAll.every((r) => r['cmd'] === 'request_changes' && r['comment'] === '문구를 다듬어 주세요' && typeof r['expected_hash'] === 'string'));
});

test('stale screen: when the content changed after the page was shown, nothing is sent and the person is told', async (t) => {
  const rig = await startWriteRig(t);
  const path = `/approvals/task/${rig.demo.ids.task}`;
  const forms = await rig.forms(path);
  // 화면을 연 뒤 초안 내용이 바뀐다 (다른 프로세스가 DB 에 쓴다)
  const writable = openDb({ path: rig.demo.dbPath });
  t.after(() => writable.close());
  writable.writeTx((tx) => tx.run("UPDATE effect_draft SET payload_hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' WHERE task_run_id = 'run-demo-draft-0'"));
  const reply = await submit(rig, forms.get('approve')!);
  const text = await resultOf(rig, reply);
  assert.ok(text.includes('결정이 반영되지 않았습니다. 그 사이 내용이 바뀌었습니다.') && text.includes('새 내용 보기'), text);
  assert.equal(requestsOf(rig).length, 0);
  // 새로 연 화면의 폼은 보내진다
  const fresh = await freshForms(rig, path);
  assert.equal((await submit(rig, fresh.get('approve')!)).status, 303);
  assert.equal(requestsOf(rig).length, 1);
  // 이미 처리된 결정(더는 결정할 일이 아님)
  const gonePage = `/approvals/org_proposal/${rig.demo.ids.orgNormal}`;
  const goneForm = (await freshForms(rig, gonePage)).get('approve')!;
  writable.writeTx((tx) => tx.run("UPDATE org_proposal SET status = 'rejected' WHERE id = ?", [rig.demo.ids.orgNormal]));
  const gone = await resultOf(rig, await submit(rig, goneForm));
  assert.ok(gone.includes('이미 다른 결정이 났거나') && gone.includes('결정할 일로 가기'), gone);
  assert.equal(requestsOf(rig).length, 1);
});

test('OTP: only the buttons that need it ask for six digits; the code goes to the engine and nowhere else', async (t) => {
  const rig = await startWriteRig(t);
  const forms = await rig.forms('/effects');
  const failed = forms.get('failed')!;
  assert.ok(failed.html.includes('name="totp"') && failed.html.includes('inputmode="numeric"') && failed.html.includes('autocomplete="one-time-code"'));
  assert.ok(!forms.get('confirmed')!.html.includes('totp'));
  // 6자리 숫자가 아니면 보내지 않는다
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６']) assert.equal((await submit(rig, failed, { totp: bad, reason: '받는 쪽을 확인함' })).status, 400, bad);
  assert.equal(requestsOf(rig).length, 0);
  // 맞는 모양이면 엔진에 실린다 (효과 확정은 note 필드)
  const reply = await submit(rig, failed, { totp: '123456', reason: '받는 쪽을 확인함' });
  const location = String(reply.headers['location']);
  assert.ok(!location.includes('123456') && !JSON.stringify(reply.headers).includes('123456'));
  const text = await resultOf(rig, reply);
  assert.match(text, /나가지 않았다고 기록했습니다/);
  assert.ok(!text.includes('123456'));
  assert.deepEqual(requestsOf(rig), [{ cmd: 'resolve-effect', effect_id: rig.demo.ids.effect, outcome: 'failed', note: '받는 쪽을 확인함', totp: '123456', actor: OWNER, via: 'web' }]);
  // 나갔다고 확인: OTP 없음
  const confirmed = (await freshForms(rig, '/effects')).get('confirmed')!;
  await submit(rig, confirmed, { reason: '수신함에서 확인' });
  assert.equal('totp' in requestsOf(rig)[1]!, false);
  // 틀린 코드: 잠김과 같은 문구, 입력 비움(같은 폼 다시)
  rig.respond(() => ({ ok: false, error: 'the TOTP code is not valid', code: 'reauth_failed' }));
  const wrong = (await freshForms(rig, '/effects')).get('failed')!;
  const wrongText = await resultOf(rig, await submit(rig, wrong, { totp: '000000', reason: '확인함' }));
  assert.ok(wrongText.includes('OTP 코드가 맞지 않습니다.') && wrongText.includes('다시 하기') && !wrongText.includes('000000'));
  rig.respond(() => ({ ok: false, error: 'too many wrong TOTP codes; try again later', code: 'reauth_locked' }));
  const locked = (await freshForms(rig, '/effects')).get('failed')!;
  assert.ok((await resultOf(rig, await submit(rig, locked, { totp: '000000', reason: '확인함' }))).includes('잠시 뒤 다시 하세요(5분).'));
});

test('a risky change waiting for its OTP: the OTP button sends release with the shown hash; cancel needs no OTP', async (t) => {
  const rig = await startWriteRig(t);
  const id = rig.demo.ids.policy;
  const forms = await rig.forms(`/approvals/policy_version/${id}`);
  assert.deepEqual([...forms.keys()], ['otp', 'cancel']);
  assert.ok(forms.get('otp')!.html.includes('name="totp"') && !forms.get('cancel')!.html.includes('totp'));
  const hash = engineHash(rig, 'policy_version', id);
  const text = await resultOf(rig, await submit(rig, forms.get('otp')!, { totp: '654321' }));
  assert.ok(text.includes('OTP 확인을 마쳤습니다.') && !text.includes('654321'));
  assert.deepEqual(requestsOf(rig)[0], { cmd: 'release', kind: 'policy_version', id, expected_hash: hash, totp: '654321', actor: OWNER, via: 'web' });
  await submit(rig, (await freshForms(rig, `/approvals/policy_version/${id}`)).get('cancel')!);
  assert.deepEqual(requestsOf(rig)[1], { cmd: 'cancel', kind: 'policy_version', id, expected_hash: hash, actor: OWNER, via: 'web' });
});

test('rate limits: 20 decision requests a minute, 5 OTP entries in 5 minutes', async (t) => {
  const rig = await startWriteRig(t);
  for (let i = 0; i < 20; i += 1) assert.equal((await rig.post('/decide', 'key=')).status, 400);
  assert.equal((await rig.post('/decide', 'key=')).status, 429);
  rig.clock.advance(61_000);
  assert.equal((await rig.post('/decide', 'key=')).status, 400, 'the window moves on');
  // OTP
  const otp = await startWriteRig(t);
  let accepted = 0;
  let limited = 0;
  for (let i = 0; i < 7; i += 1) {
    const form = (await freshForms(otp, '/effects')).get('failed')!;
    const status = (await submit(otp, form, { totp: '123456', reason: '확인함' })).status;
    if (status === 303) accepted += 1;
    if (status === 429) limited += 1;
  }
  assert.deepEqual([accepted, limited], [5, 2]);
  assert.equal(requestsOf(otp).length, 5);
});

test('failures are said in plain Korean from the engine code; an unknown code or no code falls back to one generic line', async (t) => {
  const rig = await startWriteRig(t);
  const path = `/approvals/task/${rig.demo.ids.plainTask}`;
  const say = async (response: unknown): Promise<string> => {
    rig.respond(() => response);
    return resultOf(rig, await submit(rig, (await freshForms(rig, path)).get('approve')!));
  };
  const cases: [string, string, string?][] = [
    ['hash_mismatch', '결정이 반영되지 않았습니다. 그 사이 내용이 바뀌었습니다.', '새 내용 보기'],
    ['wrong_state', '이미 다른 결정이 났습니다.', '결정할 일로 가기'],
    ['send_started', '이미 보내기 시작해 거절·다시 쓰게를 할 수 없습니다.', '전송 여부 카드 보기'],
    ['masked', '가려진 값이 있어 승인할 수 없습니다.'],
    ['expired', '초안 기한이 지나 승인할 수 없습니다.'],
    ['policy_denied', '지금 정책이 허용하지 않아 승인할 수 없습니다.'],
    ['self_approval', '요청한 사람이 직접 승인할 수 없습니다.'],
    ['cooldown', '아직 대기 시간이 끝나지 않았습니다.'],
    ['reauth_required', 'OTP 코드가 필요합니다.'],
    ['reauth_failed', 'OTP 코드가 맞지 않습니다.', '다시 하기'],
    ['reauth_locked', '잠시 뒤 다시 하세요(5분).'],
    ['not_human', '이 결정은 사람만 할 수 있습니다.'],
    ['bad_request', '처리하지 못했습니다.'],
    ['something_new', '처리하지 못했습니다.'],
  ];
  for (const [code, headline, next] of cases) {
    const text = await say({ ok: false, error: 'engine words here: do not show', code });
    assert.ok(text.includes(headline), `${code}: ${text}`);
    if (next !== undefined) assert.ok(text.includes(next), `${code} → ${next}`);
    assert.ok(text.includes('engine words here'), 'the engine text is kept, inside the folded details');
  }
  // 코드가 없으면 영어 문장을 짐작하지 않는다: 어떤 문장이든 같은 한 줄
  const noCode = await say({ ok: false, error: 'the task changed since it was shown (subject hash mismatch); show it again before approving' });
  assert.ok(noCode.includes('처리하지 못했습니다.') && !noCode.includes('그 사이 내용이 바뀌었습니다'));
  assert.ok((await say({ ok: false, error: 'something nobody has seen' })).includes('처리하지 못했습니다.'));
  assert.ok((await say({ nonsense: true })).length > 0, 'a response without ok is treated as no answer');
  // 첫 화면(제목과 다음 할 일)에는 영어 엔진 문장이 없고 자세히 안에만 있다
  rig.respond(() => ({ ok: false, error: 'engine words here: do not show', code: 'wrong_state' }));
  const reply = await submit(rig, (await freshForms(rig, path)).get('approve')!);
  const page = await rig.get(String(reply.headers['location']));
  assert.ok(!textOf(page.text.replace(/<details[\s\S]*?<\/details>/g, '')).includes('engine words'));
});

test('connection failures: a stopped daemon changes nothing and says so; a timeout says it does not know', async (t) => {
  const down = await startWriteRig(t, { startEngine: false });
  // 시작 때 whoami 는 성공했다고 가정하고(이 시험은 중간에 꺼진 경우), 폼을 보낸다
  const stopped = await down.forms(orgPath(down));
  assert.ok(stopped.has('approve'));
  const text = await resultOf(down, await submit(down, stopped.get('approve')!));
  assert.ok(text.includes('데몬이 꺼져 있어 보내지 못했습니다. 아무것도 바뀌지 않았습니다.') && text.includes('다시 하기'), text);

  const slow = await startWriteRig(t, { timeoutMs: 300 });
  slow.respond(() => new Promise(() => { /* 응답하지 않는다 */ }));
  const timeoutText = await resultOf(slow, await submit(slow, (await slow.forms(orgPath(slow))).get('approve')!));
  assert.ok(timeoutText.includes('결과를 확인하지 못했습니다.') && timeoutText.includes('상태 다시 보기'), timeoutText);
  assert.ok(!timeoutText.includes('아무것도 바뀌지 않았습니다'), 'a timeout does not claim that nothing changed');
  assert.equal(requestsOf(slow).length, 1, 'no automatic retry');
});

test('the result page: PRG with a random id, kept ten minutes, behind the cookie, with nothing secret on it', async (t) => {
  const rig = await startWriteRig(t);
  const reply = await submit(rig, (await rig.forms(orgPath(rig))).get('approve')!);
  assert.equal(reply.status, 303);
  const location = String(reply.headers['location']);
  assert.match(location, /^\/result\/[0-9a-f]{32}$/);
  assert.equal(reply.headers['cache-control'], 'no-store');
  const page = await rig.get(location);
  assert.equal(page.status, 200);
  assert.ok(!/nonce|totp/i.test(page.text));
  assert.equal((await rawRequest(rig.server.port, location, { cookie: null })).status, 401, 'behind the cookie');
  assert.equal((await rig.get('/result/00000000000000000000000000000000')).status, 404);
  assert.equal((await rig.get('/result/not-hex')).status, 404);
  rig.clock.advance(10 * 60_000 + 1);
  assert.equal((await rig.get(location)).status, 404, 'results are forgotten after ten minutes');
});

test('the screen process still cannot write the database: deciding leaves the file untouched', async (t) => {
  const rig = await startWriteRig(t);
  const before = sha(readFileSync(rig.demo.dbPath));
  for (const [path, verb] of [[orgPath(rig), 'approve'], [`/approvals/task/${rig.demo.ids.plainTask}`, 'reject'], ['/effects', 'confirmed']] as const) {
    const form = (await freshForms(rig, path)).get(verb)!;
    await submit(rig, form, verb === 'confirmed' ? { reason: '확인함' } : {});
  }
  assert.ok(requestsOf(rig).length >= 3);
  assert.equal(sha(readFileSync(rig.demo.dbPath)), before);
  assert.throws(() => rig.db.run('DELETE FROM approval'), /read-only/);
  assert.throws(() => rig.ctx.db.writeTx((tx) => tx.run('DELETE FROM approval')), /read-only/);
});

test('with the real approval engine behind the socket: the hash the screen carries is accepted, and the extra fields do no harm', async (t) => {
  const rig = await startWriteRig(t);
  const dir = makeTempDir(t, 'aot-rw-engine-');
  const writable = openDb({ path: rig.demo.dbPath });
  t.after(() => writable.close());
  const engine = new ApprovalEngine({ db: writable, clock: rig.clock, store: new PolicyStore({ dir: `${rig.demo.dir}/policies`, templates: [DEFAULT_POLICY_TEMPLATE] }), totp: new TotpSecretStore(`${dir}/totp`) });
  rig.respond((req) => engine.handle(req));
  const forms = await rig.forms(orgPath(rig));
  const text = await resultOf(rig, await submit(rig, forms.get('approve')!));
  assert.ok(text.includes('승인했습니다.'), text);
  const row = writable.get<{ decision: string; decided_by: string }>("SELECT decision, decided_by FROM approval WHERE subject_kind = 'org_proposal' AND subject_id = ?", [rig.demo.ids.orgNormal]);
  assert.deepEqual({ ...row }, { decision: 'approved', decided_by: OWNER });
  // 엔진이 거절하면 영어 문장 대신 한국어 문구가 나온다 (현재 엔진은 코드가 없어 패턴으로 짐작한다)
  const task = (await freshForms(rig, `/approvals/task/${rig.demo.ids.plainTask}`)).get('approve')!;
  writable.writeTx((tx) => tx.run("UPDATE task SET status = 'cancelled' WHERE id = ?", [rig.demo.ids.plainTask]));
  const refused = await resultOf(rig, await submit(rig, task));
  assert.ok(refused.includes('이미 다른 결정이 났거나') || refused.includes('이미 다른 결정이 났습니다.') || refused.includes('결정이 반영되지 않았습니다'), refused);
});
