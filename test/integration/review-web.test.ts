// 읽기 전용 검토 화면 (docs/operations/review-web.md): 화면 내용·명령 모양·보안 규칙을 실제 서버(127.0.0.1, 임시 포트)와 데모 시나리오 DB 로 확인한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeClock, openDb } from '@aot/domain';
import { createEvidenceStore } from '../../apps/daemon/src/evidence-store.ts';
import { ApprovalEngine, PolicyStore, TotpSecretStore } from '@aot/policy';

import { DEFAULT_POLICY_TEMPLATE } from '../../apps/daemon/src/assemble.ts';
import { openReadOnlyDb, ReadOnlyViolation } from '../../apps/daemon/src/review-web/read-only-db.ts';
import { startReviewServer } from '../../apps/daemon/src/review-web/server.ts';
import { createReviewContext } from '../../apps/daemon/src/review-web/context.ts';
import { demoPng } from '../../scripts/review-web-demo.ts';
import { NOW_MS, rawRequest, startRig } from '../support/review-web.ts';
import { makeTempDir } from '../support/temp.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const CLI = 'node apps/daemon/src/approve.ts';

/** 화면에 보이는 글자만 (태그·스타일 제거, 엔티티 풀기) */
const textOf = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, ' [그래프] ').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
/** 첫 화면: 명령 상자(<code>)와 접힌 자세히(<details>)를 뺀 부분 */
const firstLevel = (html: string): string => textOf(html.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<code>[\s\S]*?<\/code>/g, ''));
const idsIn = (text: string): string[] => text.match(/[0-9a-f]{64}|\b(?:task|org-proposal|evidence|effect|strategy|publication|policy|product|run)-[0-9a-f][0-9a-f-]{5,}|\d{4}-\d\d-\d\dT\d\d|needs_review|pending_approval|\bproposed\b|\bunknown\b|approval required|\bmissing\b|\{"/g) ?? [];
const linkTo = (html: string, prefix: string): string => new RegExp(`href="(${prefix}[^"]*)"`).exec(html)![1]!;

test('home is a decision inbox: one question per card, three short facts, no ids or engine words on the first level', async (t) => {
  const rig = await startRig(t);
  const home = await rig.get('/');
  assert.equal(home.status, 200);
  const text = textOf(home.text);
  assert.match(text, /결정할 일 \d+건/);
  for (const question of [
    "새 역할 'example-support-triager' 시험 투입을 승인할까요?", "새 역할 'example-crm-updater' 시험 투입을 승인할까요?", '고객에게 나가는 작업 3건을 승인할까요?',
    "'주간 요약 보고서를 내부 문서함에 정리' — 진행해도 될까요?", '게시물을 public-web 에 누구나 볼 수 있게 공개할까요?', "상품 '예시 상품'을 등록할까요?",
    "보냈는지 확인 안 된 'notify-tool' 작업 1건 — 실제로 나갔나요?", '정책 변경을 배포할까요?', '실험을 시작할까요?', '정식 전략으로 올릴까요?', '실험 결과를 판정하지 못했습니다',
    "'example-analyst' 시험은 관측이 부족했습니다. 한 번 더 시험할까요?", "'example-researcher' 시험이 통과했습니다. 정식 확정할까요?", "'invoice-check' 업무 3건이 담당자 없이 멈췄습니다 — 새 역할 제안서를 만들까요?",
  ]) assert.ok(text.includes(question), question);
  assert.ok(!text.includes("'support-triage' 업무 4건이 담당자 없이"), 'a signal that already has a proposal is not suggested again');
  // 같은 사유의 고객 메일 3건은 한 장으로 묶인다
  assert.equal(text.split('고객에게 나가는 작업').length - 1, 1, 'batched into one card');
  assert.ok(!text.includes('고객 안내 메일 초안 #'), 'the batched tasks are listed only on the detail page');
  assert.ok(text.includes('13일 뒤 만료') && text.includes('검증 통과') && text.includes('판정 보류') && text.includes('어제부터 멈춰 있음'));
  assert.ok(text.includes('지켜보는 중') && text.includes("'example-reporter' 시험 중 — 3/6건 관측, 지금까지 통과 100%"), 'running trial as one line');
  // 첫 화면에는 id·해시·ISO 시각·엔진 상태 문구·JSON 이 없다
  assert.deepEqual(idsIn(firstLevel(home.text)), []);
  // 카드 하나는 질문 + 3줄 이하
  for (const card of home.text.split('<section class="card">').slice(1)) assert.ok((card.split('</section>')[0]!.match(/<li>/g) ?? []).length <= 3, 'at most three facts');
  // 0건 구역은 만들지 않는다
  assert.deepEqual(text.match(/\(0\)|(?<![0-9/])0건/g), null, 'no zero-count sections');
  for (const target of ['/watch', '/evidence']) assert.ok(home.text.includes(`href="${target}"`));
  assert.ok(!home.text.includes('href="/signals"') && !home.text.includes('href="/approvals"'), 'engineering pages are gone from the nav');
  for (const path of ['/watch', '/effects', '/evidence']) assert.equal((await rig.get(path)).status, 200, path);
});

test('an empty database says there is nothing to decide and renders no empty sections', async (t) => {
  const rig = await startRig(t, { empty: true });
  const home = await rig.get('/');
  const text = textOf(home.text);
  assert.ok(text.includes('지금 결정할 일이 없습니다'));
  assert.ok(!home.text.includes('<h2>지켜보는 중') && !/\(0\)|\b0건/.test(text));
  assert.equal((await rig.get('/watch')).status, 200);
  assert.equal((await rig.get('/effects')).status, 200);
});

test('org proposal detail: question, one-sentence summary and facts first, then the two choices, then collapsed details; the real hash only inside the command', async (t) => {
  const rig = await startRig(t);
  const page = await rig.get(`/approvals/org_proposal/${rig.demo.ids.orgNormal}`);
  assert.equal(page.status, 200);
  const html = page.text;
  const at = (needle: string): number => html.indexOf(needle);
  assert.ok(html.includes("<h1>새 역할 &#39;example-support-triager&#39; 시험 투입을 승인할까요?</h1>"), 'the h1 is the question');
  assert.ok(at('<h1>') < at('class="lead"') && at('class="lead"') < at('class="facts"') && at('class="facts"') < at('<h3>승인</h3>') && at('<h3>승인</h3>') < at('<h3>거절</h3>') && at('<h3>거절</h3>') < at('<details>'), 'order: question, summary, facts, approve, reject, details');
  const lead = textOf(html.slice(at('class="lead"'), at('class="facts"')));
  for (const part of ["'support-triage' 업무를 맡을 역할 하나를 추가합니다", '최소 14일 동안 이 업무만 맡기고', '통과율 80% 미만이거나 안전 문제 1건이면 자동으로 되돌립니다']) assert.ok(lead.includes(part), part);
  const first = firstLevel(html);
  assert.ok(first.includes('왜 지금') && first.includes('위험') && first.includes('기한') && first.includes('13일 뒤 만료'));
  assert.deepEqual(idsIn(first), []);
  const detailsHtml = html.slice(at('<details>'));
  for (const label of ['위험과 완화책', '평가 계획', '롤백 계획', '기대 효과', '성공 기준', '최소 관측']) assert.ok(detailsHtml.includes(label), `자세히 has ${label}`);
  const approve = /node apps\/daemon\/src\/approve\.ts approve org (\S+) --hash ([0-9a-f]{64})/.exec(html);
  assert.ok(approve, 'approve command with a 64-hex hash');
  assert.equal(approve![1], rig.demo.ids.orgNormal);
  assert.ok(html.includes(`${CLI} reject org ${rig.demo.ids.orgNormal} --comment`), 'reject command');
  assert.equal(html.split(approve![2]!).length - 1, 1, 'the hash appears once, only inside the command');

  // 보인 해시를 실제 승인 엔진에 넣으면 승인된다 (복사한 DB 에서)
  const copyDir = makeTempDir(t, 'aot-review-web-copy-');
  const copy = join(copyDir, 'copy.db');
  copyFileSync(rig.demo.dbPath, copy);
  const writable = openDb({ path: copy });
  t.after(() => writable.close());
  const engine = new ApprovalEngine({ db: writable, clock: new FakeClock(NOW_MS), store: new PolicyStore({ dir: join(copyDir, 'policies'), templates: [DEFAULT_POLICY_TEMPLATE] }), totp: new TotpSecretStore(join(copyDir, 'totp')) });
  const result = engine.handle({ cmd: 'approve', actor: 'actor-owner', kind: 'org_proposal', id: rig.demo.ids.orgNormal, hash: approve![2]! });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result['state'], 'approved');
});

test('every kind of decision opens on a question with its commands: risky org, task, batch, publication, policy, strategy', async (t) => {
  const rig = await startRig(t);
  const risky = await rig.get(`/approvals/org_proposal/${rig.demo.ids.orgRisky}`);
  const riskyText = firstLevel(risky.text);
  assert.ok(riskyText.includes('위험 변경 — 승인 후 OTP 해제 필요') && riskyText.includes("새 부서 'sales-ops'도 만듭니다"));
  assert.ok(risky.text.includes('release 가 한 번 더 필요합니다'));
  const task = await rig.get(`/approvals/task/${rig.demo.ids.plainTask}`);
  assert.ok(task.text.includes("<h1>&#39;주간 요약 보고서를 내부 문서함에 정리&#39; — 진행해도 될까요?</h1>") && task.text.includes(`${CLI} approve task ${rig.demo.ids.plainTask} --hash `));
  const home = (await rig.get('/')).text;
  const batchPath = linkTo(home, '/batch/');
  const batch = await rig.get(batchPath);
  assert.equal(batch.status, 200);
  assert.equal((batch.text.match(/ approve task /g) ?? []).length, 3, 'one approve command per batched task');
  assert.ok(batch.text.includes('고객 안내 메일 초안 #1 발송') && batch.text.includes('<h1>고객에게 나가는 작업 3건을 승인할까요?</h1>'));
  const publication = await rig.get(`/approvals/publication/${rig.demo.ids.publication}`);
  assert.ok(publication.text.includes(`${CLI} approve publication ${rig.demo.ids.publication} --hash `) && textOf(publication.text).includes('누구나 볼 수 있게 공개할까요?'));
  const strategy = await rig.get(`/approvals/strategy_version/${rig.demo.ids.strategy}`);
  assert.ok(strategy.text.includes(`${CLI} approve strategy ${rig.demo.ids.strategy} --hash `) && textOf(strategy.text).includes('주간 뉴스레터 제목에 질문형 문장 쓰기'));
  const policy = await rig.get(`/approvals/policy_version/${rig.demo.ids.policy}`);
  assert.equal(policy.status, 200);
  assert.ok(policy.text.includes(`release policy ${rig.demo.ids.policy} --totp-stdin`) || policy.text.includes(`cancel policy ${rig.demo.ids.policy}`));
  assert.equal((await rig.get('/approvals/org_proposal/nope')).status, 404);
  assert.equal((await rig.get('/approvals/bogus/x')).status, 404);
  assert.equal((await rig.get('/batch/000000000000')).status, 404);
});

test('trial: one verdict line first, one small chart, the commands; the rest is folded away', async (t) => {
  const rig = await startRig(t);
  const pass = await rig.get(`/trials/${rig.demo.ids.orgPass}`);
  const firstHtml = pass.text.slice(0, pass.text.indexOf('<details>'));
  assert.ok(textOf(firstHtml).includes('통과 — 4건 관측. 지금까지 통과율 100%로 기준(70%) 이상.'));
  assert.equal((firstHtml.match(/<svg class="chart"/g) ?? []).length, 1, 'exactly one chart above the fold');
  assert.ok(pass.text.slice(pass.text.indexOf('<details>')).includes('관측 수 vs 최소 관측'), 'observation and cost bars are inside details');
  assert.ok(pass.text.includes(`${CLI} org confirm ${rig.demo.ids.orgPass} --comment`));
  const inconclusive = await rig.get(`/trials/${rig.demo.ids.orgInconclusive}`);
  assert.ok(textOf(inconclusive.text).includes('판정 불충분 — 3건이 필요한데 1건만 관측됐습니다') && inconclusive.text.includes(`${CLI} org retrial ${rig.demo.ids.orgInconclusive} --file`));
  const running = await rig.get(`/trials/${rig.demo.ids.orgTrial}`);
  assert.ok(textOf(running.text).includes('아직 판정 전 — 6건 중 3건 관측. 지금까지 통과율 100%로 기준(80%) 이상.'));
  assert.ok(!running.text.includes(' org confirm '), 'nothing to decide yet');
  assert.ok(!/NaN|undefined|Infinity/.test(running.text));
  const watch = textOf((await rig.get('/watch')).text);
  assert.ok(watch.includes("'example-reporter' 시험 중") && watch.includes('결과를 기다리는 중') && watch.includes('반복됩니다'));
  assert.equal((await rig.get('/trials/nope')).status, 404);
});

test('products, effects, experiments and signals each open on one question with the command to act', async (t) => {
  const rig = await startRig(t);
  const product = await rig.get(`/products/${rig.demo.ids.productSlug}`);
  const productText = firstLevel(product.text);
  assert.ok(product.text.includes("<h1>상품 &#39;예시 상품&#39;을 등록할까요?</h1>") && productText.includes('검증 통과') && productText.includes('검증기 의견: 근거가 뒷받침됨') && productText.includes('7건 중 1건 확인됨, 외부 입력 3건 포함'));
  assert.deepEqual(idsIn(productText), []);
  assert.ok(/product decide example-product approve --hash [0-9a-f]{64}/.test(product.text) && product.text.includes('product decide example-product reject --comment'));
  assert.ok(product.text.slice(product.text.indexOf('<details>')).includes('독립 평가 (원문)'), 'evidence list and raw verdicts are folded');
  const effects = await rig.get('/effects');
  assert.ok(textOf(effects.text).includes("보냈는지 확인 안 된 'notify-tool' 작업 1건 — 실제로 나갔나요?"));
  assert.ok(effects.text.includes(`resolve-effect ${rig.demo.ids.effect} --outcome confirmed --note`) && effects.text.includes('--outcome failed --note &quot;확인한 내용&quot; --totp-stdin'));
  assert.ok(!effects.text.includes(sha(Buffer.from('demo-request'))) && !effects.text.includes('effect-key-demo-1'), 'no request hash or effect key');
  const promote = await rig.get(`/experiments/${rig.demo.ids.experiments.promote}`);
  assert.ok(promote.text.includes('promote strategy strategy-demo-promote --comment') && textOf(promote.text).includes('정식 전략으로 올릴까요?'));
  const needs = await rig.get(`/experiments/${rig.demo.ids.experiments.needs}`);
  assert.ok(needs.text.includes('reject strategy strategy-demo-needs --comment') && textOf(needs.text).includes('판정 보류'));
  const signal = await rig.get('/signals/invoice-check');
  assert.ok(signal.text.includes(`${CLI} org propose --type invoice-check --role`));
  assert.equal((await rig.get('/signals/support-triage')).status, 404, 'covered by an open proposal');
  assert.equal((await rig.get('/products/not-there')).status, 404);
});

test('evidence text is escaped and masked; external input is marked; images are shown inline', async (t) => {
  const rig = await startRig(t);
  const { evidence } = rig.demo.ids;
  const injected = await rig.get(`/evidence/${evidence.injected}`);
  assert.equal(injected.status, 200);
  assert.ok(injected.text.includes('&lt;script&gt;alert(&#39;demo&#39;)&lt;/script&gt;'), 'script is escaped');
  assert.ok(!injected.text.includes("<script>alert"), 'no live script');
  assert.ok(!injected.text.includes('x'.repeat(24)), 'secret is not shown');
  assert.ok(injected.text.includes('[REDACTED]'), 'secret is masked');
  assert.ok(injected.text.includes('외부 입력 — 지시 아님'), 'untrusted marker');
  const list = await rig.get('/evidence');
  assert.ok(list.text.includes('외부 입력 — 지시 아님') && list.text.includes('확인됨') && list.text.includes('<img class="thumb"'));
  assert.ok(!list.text.includes('x'.repeat(24)));
  const internal = await rig.get(`/evidence/${evidence.text}`);
  assert.ok(internal.text.includes('저장소 구조') && !internal.text.includes('class="card untrusted"'), 'internal text is shown without the untrusted frame');
  assert.ok(injected.text.includes('class="card untrusted"'), 'external text is framed as untrusted');
  const url = await rig.get(`/evidence/${evidence.url}`);
  assert.ok(url.text.includes('https://example.com/docs/getting-started') && !url.text.includes('href="https://example.com'), 'external urls are text, never links');
  const png = await rig.get(`/evidence/${evidence.png}`);
  assert.ok(png.text.includes(`<img class="evidence" alt="증거 그림" src="/evidence/${evidence.png}/file">`));
  assert.equal((await rig.get('/evidence?task=%27%20OR%201%3D1%20--')).status, 200, 'query goes through bound parameters');
  assert.ok((await rig.get('/evidence?task=%27%20OR%201%3D1%20--')).text.includes('증거가 없습니다'), 'injection matches nothing');
});

test('evidence files: only verified images inside an allowed root, served with their exact type', async (t) => {
  const rig = await startRig(t);
  const { evidence } = rig.demo.ids;
  const ok = await rig.get(`/evidence/${evidence.png}/file`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.ok(ok.body.equals(demoPng()), 'the same bytes');
  // SVG·HTML 같은 것은 내보내지 않는다 (목록만)
  assert.equal((await rig.get(`/evidence/${evidence.svg}/file`)).status, 404);
  const svgPage = await rig.get(`/evidence/${evidence.svg}`);
  assert.ok(svgPage.text.includes('그림이 아닌 파일은 목록만 보이고 내보내지 않습니다') && !svgPage.text.includes('<img'));
  // 해시가 다르면 거부
  assert.equal((await rig.get(`/evidence/${evidence.mismatch}/file`)).status, 404);
  assert.ok((await rig.get(`/evidence/${evidence.mismatch}`)).text.includes('해시가 증거 행의 해시와 다르다'));
  // 허용 폴더 밖
  assert.equal((await rig.get(`/evidence/${evidence.outside}/file`)).status, 404);
  assert.ok((await rig.get(`/evidence/${evidence.outside}`)).text.includes('허용된 증거 폴더 밖'));
  // 경로는 URL 로 받지 않는다
  for (const path of [`/evidence/${encodeURIComponent(rig.demo.dbPath)}/file`, '/evidence/..%2F..%2Fetc%2Fhosts/file', '/evidence/%2e%2e/file', `/file/${encodeURIComponent(join(rig.demo.evidenceDir, 'screenshot.png'))}`]) {
    const reply = await rig.get(path);
    assert.ok([400, 404].includes(reply.status), `${path} → ${reply.status}`);
  }
  // blob(텍스트)은 이미지 길로 나가지 않는다
  assert.equal((await rig.get(`/evidence/${evidence.text}/file`)).status, 404);
  assert.equal((await rig.get(`/evidence/${evidence.url}/file`)).status, 404);
});

test('evidence files: --evidence-root allows another folder; symlinks out of the root, oversize files and tampered blobs are refused', async (t) => {
  let linkRow = '';
  const rig = await startRig(t, {
    before: (db, demo) => {
      const png = demoPng();
      symlinkSync(join(demo.outsideDir, 'outside.png'), join(demo.evidenceDir, 'link.png'));
      const big = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024 + 1)]);
      writeFileSync(join(demo.evidenceDir, 'big.png'), big);
      const task = String(db.get<{ task_id: string }>('SELECT task_id FROM evidence LIMIT 1')!.task_id);
      const add = (id: string, ref: string, hash: string | null): void => {
        db.writeTx((tx) => tx.run("INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, trust_origin, captured_at, verified) VALUES (?, ?, NULL, 'other', ?, ?, 'internal', ?, 0)", [id, task, ref, hash, '2026-11-04T00:00:00.000Z']));
      };
      add('evidence-link', `file:${join(demo.evidenceDir, 'link.png')}`, sha(png));
      add('evidence-big', `file:${join(demo.evidenceDir, 'big.png')}`, sha(big));
      linkSync(join(demo.outsideDir, 'outside.png'), join(demo.evidenceDir, 'hard.png'));
      add('evidence-hardlink', `file:${join(demo.evidenceDir, 'hard.png')}`, sha(png));
      add('evidence-nohash', `file:${join(demo.evidenceDir, 'screenshot.png')}`, null);
      add('evidence-etc', 'file:/etc/hosts', null);
      add('evidence-relative', 'file:relative/path.png', null);
      // 본문 파일이 바뀐 blob: 이름의 해시와 내용이 다르다
      const blobHash = String(db.get<{ ref: string }>('SELECT ref FROM evidence WHERE id = ?', [demo.ids.evidence.text])!.ref).slice('blob:sha256:'.length);
      writeFileSync(join(demo.evidenceDir, blobHash), '바뀐 내용');
      linkRow = blobHash;
    },
  });
  assert.ok(linkRow.length === 64);
  for (const id of ['evidence-link', 'evidence-big', 'evidence-etc', 'evidence-relative']) assert.equal((await rig.get(`/evidence/${id}/file`)).status, 404, id);
  assert.ok((await rig.get('/evidence/evidence-link')).text.includes('허용된 증거 폴더 밖'), 'a symlink out of the root is judged by its real path');
  assert.ok((await rig.get('/evidence/evidence-big')).text.includes('너무 크다'));
  const tampered = await rig.get(`/evidence/${rig.demo.ids.evidence.text}`);
  assert.ok(tampered.text.includes('해시가 파일 이름과 다르다') && !tampered.text.includes('바뀐 내용'), 'a changed blob is not shown');
  // 해시가 없는 행은 허용 폴더 안이면 보이되 "미확인" 으로 표시
  assert.equal((await rig.get('/evidence/evidence-nohash/file')).status, 404, 'an image without a recorded hash is not served');
  assert.ok((await rig.get('/evidence/evidence-nohash')).text.includes('해시 없음 — 표시하지 않음') && !(await rig.get('/evidence/evidence-nohash')).text.includes('<img'));
  assert.equal((await rig.get('/evidence/evidence-hardlink/file')).status, 404, 'a hard link into the root is refused');
  assert.ok((await rig.get('/evidence/evidence-hardlink')).text.includes('하드 링크'));

  const extra = await startRig(t, { extraRoots: (demo) => [demo.outsideDir] });
  const allowed = await extra.get(`/evidence/${extra.demo.ids.evidence.outside}/file`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['content-type'], 'image/png');
});

test('network rules: loopback only, Host check (DNS rebinding), GET/HEAD only, security headers everywhere', async (t) => {
  const rig = await startRig(t);
  const port = rig.server.port;
  assert.equal((rig.server.server.address() as { address: string }).address, '127.0.0.1');
  await assert.rejects(startReviewServer(createReviewContext({ db: rig.db, policyStoreDir: 'x', evidenceDir: 'y' }), { host: '0.0.0.0' }), /only on 127\.0\.0\.1/);
  await assert.rejects(startReviewServer(createReviewContext({ db: rig.db, policyStoreDir: 'x', evidenceDir: 'y' }), { host: '::1' }), /only on 127\.0\.0\.1/);

  assert.equal((await rig.get('/', { host: `localhost:${port}` })).status, 200);
  assert.equal((await rig.get('/', { host: `LOCALHOST:${port}` })).status, 200);
  for (const host of ['evil.example.com', `evil.example.com:${port}`, '127.0.0.1', 'localhost', `127.0.0.1:${port + 1}`, `[::1]:${port}`, `127.0.0.1.evil.example:${port}`, '0.0.0.0:80']) {
    const reply = await rig.get('/watch', { host });
    assert.equal(reply.status, 421, host);
    assert.ok(!reply.text.includes('조직 변경'), 'nothing leaks to a wrong host');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const reply = await rig.get('/watch', { method });
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers['allow'], 'GET, HEAD');
  }
  const head = await rig.get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);

  const csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  for (const path of ['/', '/watch', '/nope', `/evidence/${rig.demo.ids.evidence.png}/file`]) {
    const reply = await rig.get(path);
    assert.equal(reply.headers['content-security-policy'], csp, path);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal(reply.headers['referrer-policy'], 'no-referrer');
    assert.equal(reply.headers['cache-control'], 'no-store');
  }
  assert.equal((await rig.get('/', { method: 'POST' })).headers['content-security-policy'], csp, 'errors carry the headers too');
  assert.equal((await rig.get('/nope')).status, 404);
  assert.equal((await rig.get('/%')).status, 400);
  // 어느 화면에도 폼·스크립트·외부 자원이 없다
  for (const path of ['/', '/watch', '/effects', '/evidence', `/trials/${rig.demo.ids.orgPass}`, `/products/${rig.demo.ids.productSlug}`, `/evidence/${rig.demo.ids.evidence.injected}`]) {
    const html = (await rig.get(path)).text;
    assert.ok(!/<form|<script|<iframe|<link |https?:\/\/[^\s"'<]*\.(js|css|woff2?|png)/i.test(html), `${path} has no forms, scripts or external resources`);
  }
});

test('the database is opened read-only: no write path, and serving every page leaves the file untouched', async (t) => {
  const rig = await startRig(t);
  const before = sha(readFileSync(rig.demo.dbPath));
  const mtime = statSync(rig.demo.dbPath).mtimeMs;
  const paths = ['/', '/watch', `/products/${rig.demo.ids.productSlug}`, '/effects', '/evidence', `/trials/${rig.demo.ids.orgPass}`, `/experiments/${rig.demo.ids.experiments.promote}`, '/signals/invoice-check',
    `/approvals/org_proposal/${rig.demo.ids.orgNormal}`, `/approvals/task/${rig.demo.ids.task}`, `/evidence/${rig.demo.ids.evidence.png}`, `/evidence/${rig.demo.ids.evidence.png}/file`];
  for (const path of paths) assert.equal((await rig.get(path)).status, 200, path);
  assert.equal(sha(readFileSync(rig.demo.dbPath)), before, 'the database file did not change');
  assert.equal(statSync(rig.demo.dbPath).mtimeMs, mtime);

  // 코드 수준: 쓰기 메서드는 SQLite 에 닿기 전에 막힌다
  assert.throws(() => rig.db.writeTx((tx) => tx.run('DELETE FROM approval')), ReadOnlyViolation);
  assert.throws(() => rig.db.run('DELETE FROM approval'), ReadOnlyViolation);
  assert.throws(() => rig.db.exec('DROP TABLE approval'), ReadOnlyViolation);
  // SQLite 수준: 읽기 전용 연결 자체가 쓰기를 거부한다
  const raw = openDb({ path: rig.demo.dbPath, readOnly: true });
  t.after(() => raw.close());
  assert.throws(() => raw.writeTx((tx) => tx.run('DELETE FROM approval')), /readonly|read-only|read only|attempt to write/i);
  assert.ok(Number(raw.get<{ n: number }>('SELECT COUNT(*) AS n FROM org_proposal')!.n) > 0, 'reads work');
  // 없는 파일은 만들지 않는다
  const missing = join(makeTempDir(t, 'aot-review-web-missing-'), 'nope.db');
  assert.throws(() => openReadOnlyDb(missing));
  assert.throws(() => statSync(missing));
});

test('a wrong Host never reaches the data layer even for the file route', async (t) => {
  const rig = await startRig(t);
  const reply = await rawRequest(rig.server.port, `/evidence/${rig.demo.ids.evidence.png}/file`, { host: 'attacker.example' });
  assert.equal(reply.status, 421);
  assert.ok(!reply.body.equals(demoPng()));
  const noHost = await rawRequest(rig.server.port, '/', { host: null }).catch(() => ({ status: 400 }));
  assert.ok([400, 421].includes(noHost.status));
});

test('long evidence is never cut silently, and a secret straddling a cut is masked before cutting', async (t) => {
  const key = `${'sk'}-${'QzK7'.repeat(8)}`;
  const rig = await startRig(t, {
    before: (db, demo) => {
      const store = createEvidenceStore({ dir: demo.evidenceDir });
      const task = String(db.get<{ task_id: string }>('SELECT task_id FROM evidence LIMIT 1')!.task_id);
      const add = (id: string, body: string): void => {
        const stored = store.put(body);
        db.writeTx((tx) => tx.run("INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, trust_origin, captured_at, verified) VALUES (?, ?, NULL, 'document', ?, ?, 'internal', ?, 0)", [id, task, stored.ref, stored.sha256, '2026-11-04T00:00:00.000Z']));
      };
      add('evidence-5k', `${'가'.repeat(4990)}끝-꼬리`);
      add('evidence-25k', `${'a'.repeat(30_000)}`);
      add('evidence-straddle', `${'b'.repeat(19_995)} ${key} ${'d'.repeat(100)}`);
      db.writeTx((tx) => tx.run("UPDATE event SET payload = json_set(payload, '$.password', 'PW-visible-check') WHERE id = 'event-demo-shadow'"));
      db.writeTx((tx) => tx.run("UPDATE strategy_version SET experiment_scope = json_set(experiment_scope, '$.api_token', 'TOK-visible-check')"));
    },
  });
  const five = await rig.get('/evidence/evidence-5k');
  assert.ok(five.text.includes('끝-꼬리'), 'a 5000-char body keeps its tail');
  assert.ok(!five.text.includes('이하 생략'));
  const big = await rig.get('/evidence/evidence-25k');
  assert.ok(big.text.includes('이하 생략') && big.text.includes('전체 30000자'), 'cut text says so');
  const straddle = await rig.get('/evidence/evidence-straddle');
  assert.ok(!straddle.text.includes('sk-QzK') && !straddle.text.includes('QzK7QzK7'), 'no secret prefix at the cut');
  // 키 이름 기반 비밀 가리기: DB 의 JSON 에서 password·api_token 값은 보이지 않는다
  const product = await rig.get(`/products/${rig.demo.ids.productSlug}`);
  assert.ok(!product.text.includes('PW-visible-check') && product.text.includes('[REDACTED]'));
  const strategy = await rig.get(`/approvals/strategy_version/${rig.demo.ids.strategy}`);
  assert.ok(!strategy.text.includes('TOK-visible-check') && strategy.text.includes('[REDACTED]'));
});

test('access token: no cookie → 401, the token URL sets an HttpOnly SameSite=Strict cookie and redirects without the token', async (t) => {
  const rig = await startRig(t);
  assert.ok(rig.server.tokenUrl.endsWith(`/?token=${rig.server.token}`) && /^[0-9a-f]{64}$/.test(rig.server.token));
  const csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  for (const cookie of [null, 'aot_review=wrong', 'aot_review=', 'other=' + rig.server.token]) {
    const denied = await rig.get('/watch', { cookie });
    assert.equal(denied.status, 401, String(cookie));
    assert.ok(denied.text.includes('서버를 시작한 사람만') && !denied.text.includes('조직 변경 제안'));
    assert.equal(denied.headers['content-security-policy'], csp);
  }
  assert.equal((await rig.get(`/evidence/${rig.demo.ids.evidence.png}/file`, { cookie: null })).status, 401, 'images need the cookie too');
  assert.equal((await rig.get('/approvals?token=wrong', { cookie: null })).status, 401);
  const entered = await rig.get(`/approvals?task=x&token=${rig.server.token}`, { cookie: null });
  assert.equal(entered.status, 303);
  assert.equal(entered.headers['location'], '/approvals?task=x');
  const setCookie = String(entered.headers['set-cookie']);
  assert.ok(setCookie.startsWith(`aot_review=${rig.server.token}`) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Path=\//.test(setCookie));
  assert.ok(!entered.text.includes(rig.server.token), 'the body does not echo the token');
  assert.equal((await rig.get('/watch', { cookie: setCookie.split(';')[0]! })).status, 200);
  assert.equal((await rig.get(`/?token=${rig.server.token}`, { cookie: null })).headers['location'], '/');
  assert.ok([400, 414].includes((await rig.get(`//evil.example/?token=${rig.server.token}`, { cookie: null })).status), 'no protocol-relative redirect');
});

test('the screen does not offer commands the engine would refuse (expired proposal, failed evaluation, no verified evidence)', async (t) => {
  const expired = await startRig(t, { clockMs: NOW_MS + 60 * 86_400_000 });
  const page = await expired.get(`/approvals/org_proposal/${expired.demo.ids.orgNormal}`);
  assert.ok(page.text.includes('만료됨') && !page.text.includes(`approve org ${expired.demo.ids.orgNormal} --hash`), 'expired: reason, no approve command');
  assert.ok(page.text.includes('reject org'), 'reject stays available');
  const failed = await startRig(t, { before: (db) => db.writeTx((tx) => tx.run("UPDATE evaluation SET outcome = 'fail' WHERE id = 'evaluation-demo-verify'")) });
  const noPass = await failed.get(`/products/${failed.demo.ids.productSlug}`);
  assert.ok(noPass.text.includes('검증이 통과하지 못했습니다') && noPass.text.includes('검증 실패 — 승인 불가') && !/product decide example-product approve/.test(noPass.text) && noPass.text.includes('product decide example-product reject'));
  const unverified = await startRig(t, { before: (db) => db.writeTx((tx) => tx.run("UPDATE evidence SET verified = 0")) });
  const noEvidence = await unverified.get(`/products/${unverified.demo.ids.productSlug}`);
  assert.ok(noEvidence.text.includes('확인된 증거가 없습니다') && !/product decide example-product approve/.test(noEvidence.text));
  const ok = await (await startRig(t)).get(`/products/${'example-product'}`);
  assert.ok(/product decide example-product approve --hash/.test(ok.text), 'still offered when the engine would accept');
});
