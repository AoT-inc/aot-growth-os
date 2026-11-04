// 읽기 전용 검토 화면 (docs/operations/review-web.md): 화면 내용·명령 모양·보안 규칙을 실제 서버(127.0.0.1, 임시 포트)와 데모 시나리오 DB 로 확인한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalJson, FakeClock, openDb, sha256Hex } from '@aot/domain';
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
    "'support-triage 업무 담당' 역할을 시험 투입할까요?", "'고객 후속 연락 기록 담당' 역할을 시험 투입할까요?", '고객 안내 메일 4통(받는 사람 8명)을 보낼까요?', '예약 확인 메일 1통(받는 사람 1명)을 보낼까요?', '고객 안내 메일 2통(받는 사람 3명)을 보낼까요?',
    "'주간 요약 보고서를 내부 문서함에 정리' — 진행해도 될까요?", "'가을 신제품 안내' 게시물을 누구나 볼 수 있게 공개할까요?", "상품 '예시 상품'을 등록할까요?",
    "'고객 안내 메일 초안 #4 발송' 전송 여부 1건 — 실제로 나갔나요?", '정책 변경을 배포할까요?', '실험을 시작할까요?', '정식 전략으로 올릴까요?', '실험 결과를 판정하지 못했습니다',
    "'분기 검토 자료 담당' 시험은 관측이 부족했습니다. 한 번 더 시험할까요?", "'주간 시장 조사 담당' 시험이 통과했습니다. 정식 확정할까요?", "'invoice-check' 업무 3건이 맡을 역할이 없어 멈췄습니다 — 새 역할 제안서를 만들까요?",
  ]) assert.ok(text.includes(question), question);
  assert.ok(!text.includes("'support-triage' 업무 4건"), 'a signal that already has a proposal is not suggested again');
  // 같은 사유의 고객 메일 3건은 한 장으로 묶인다
  assert.equal(home.text.split('<a class="card"').filter((c) => c.includes('고객 안내 메일 4통')).length, 1, 'batched into one card, named from the common part of the objectives');
  assert.ok(!text.includes('초안 #1') && !text.includes('초안 #2'), 'the batched tasks are listed only on the detail page');
  assert.ok(text.includes('13일 뒤 만료') && text.includes('검증 통과') && text.includes('판정 보류') && text.includes('어제부터 대기'));
  assert.ok(text.includes('지켜보는 중') && text.includes("'월간 지표 보고서 담당' 시험 중 — 3/6건 관측, 지금까지 통과 100%"), 'running trial as one line');
  // 삼분류: 먼저 / 이번 주 안에, 그리고 분류별 개수 한 줄
  assert.ok(text.includes('바깥에 나가는 일 5건 · 조직 변경 5건 · 실험 3건 · 상품 등록 1건 · 기타 2건'));
  const firstGroup = home.text.slice(home.text.indexOf('<h2 class="grp">먼저'), home.text.indexOf('<h2 class="grp">이번 주 안에'));
  assert.ok(firstGroup.includes('고객 안내 메일 4통') && firstGroup.includes('게시물') && firstGroup.includes('전송 여부') && !firstGroup.includes('시험 투입'), 'outside-reaching items come first');
  assert.ok(home.text.includes('<a class="card" href='), 'the whole card is the link');
  assert.ok(!home.text.includes('열기 →') && !/slug|retired|public-web|unassigned|OTP 해제|notify-tool/.test(firstLevel(home.text)), 'no slugs or jargon on the first level');
  // 첫 화면에는 id·해시·ISO 시각·엔진 상태 문구·JSON 이 없다
  assert.deepEqual(idsIn(firstLevel(home.text)), []);
  // 카드 하나는 질문 + 3줄 이하
  for (const card of home.text.split('<a class="card"').slice(1)) assert.ok((card.split('</a>')[0]!.match(/<li>/g) ?? []).length <= 3, 'at most three facts');
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
  assert.ok(html.includes("<h1>&#39;support-triage 업무 담당&#39; 역할을 시험 투입할까요?</h1>"), 'the h1 is the question');
  assert.ok(at('<h1>') < at('class="lead"') && at('class="lead"') < at('class="facts"') && at('class="facts"') < at('결정하기') && at('결정하기') < at('>승인</span>') && at('>승인</span>') < at('>거절</span>') && at('>거절</span>') < at('<details>'), 'order: question, summary, facts, approve, reject, details');
  const lead = textOf(html.slice(at('class="lead"'), at('class="facts"')));
  for (const part of ['이 업무를 맡을 역할 하나를 추가합니다', '최소 14일 동안 이 업무만 맡기고', '통과율 80% 미만이거나 안전 문제 1건이면 자동으로 되돌립니다']) assert.ok(lead.includes(part), part);
  const first = firstLevel(html);
  assert.ok(first.includes('무엇') && first.includes('확인할 것') && first.includes('위험·기한') && first.includes('13일 뒤 만료'));
  assert.equal((first.match(/support-triage/g) ?? []).length, 3, 'only the page title, the h1 and the rationale name the task type; the summary sentence says "이 업무"');
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
  assert.ok(riskyText.includes('위험 변경 — 승인 후 OTP 코드로 한 번 더 확인해야 함') && riskyText.includes("새 부서 '영업 운영'도 만듭니다"));
  assert.ok(risky.text.includes('OTP 코드로 한 번 더 확인해야 합니다 (release)'));
  const task = await rig.get(`/approvals/task/${rig.demo.ids.plainTask}`);
  assert.ok(task.text.includes("<h1>&#39;주간 요약 보고서를 내부 문서함에 정리&#39; — 진행해도 될까요?</h1>") && task.text.includes(`${CLI} approve task ${rig.demo.ids.plainTask} --hash `));
  const home = (await rig.get('/')).text;
  const batchPath = linkTo(home, '/batch/');
  const batch = await rig.get(batchPath);
  assert.equal(batch.status, 200);
  assert.equal((batch.text.slice(0, batch.text.indexOf('<details>')).match(/ approve task /g) ?? []).length, 2, 'one joined command above the fold (the expired draft is left out)');
  assert.ok(batch.text.slice(0, batch.text.indexOf('<details>')).includes('2건 승인') && batch.text.includes('&amp;&amp; node apps/daemon/src/approve.ts approve task') || batch.text.includes('&& node apps/daemon/src/approve.ts approve task'), 'joined with &&');
  assert.ok((batch.text.slice(batch.text.indexOf('<details>')).match(/ approve task /g) ?? []).length >= 2 && (batch.text.slice(batch.text.indexOf('<details>')).match(/ request-changes task /g) ?? []).length >= 3, 'per-item commands inside the details');
  assert.ok(batch.text.includes('고객 안내 메일 초안 #1 발송') && batch.text.includes('<h1>고객 안내 메일 4통(받는 사람 8명)을 보낼까요?</h1>'));
  const publication = await rig.get(`/approvals/publication/${rig.demo.ids.publication}`);
  assert.ok(publication.text.includes(`${CLI} approve publication ${rig.demo.ids.publication} --hash `) && textOf(publication.text).includes('가을 신제품 안내') && textOf(publication.text).includes('누구나 볼 수 있게 공개할까요?') && textOf(publication.text).includes('이번 달 말부터 새 제품을 판매합니다'));
  const strategy = await rig.get(`/approvals/strategy_version/${rig.demo.ids.strategy}`);
  assert.ok(strategy.text.includes(`${CLI} approve strategy ${rig.demo.ids.strategy} --hash `) && textOf(strategy.text).includes('주간 뉴스레터 제목에 질문형 문장 쓰기'));
  const policy = await rig.get(`/approvals/policy_version/${rig.demo.ids.policy}`);
  assert.equal(policy.status, 200);
  assert.ok(policy.text.includes(`release policy ${rig.demo.ids.policy} --totp-stdin`) || policy.text.includes(`cancel policy ${rig.demo.ids.policy}`));
  assert.ok(textOf(policy.text).includes('업무 하나당 비용 한도(USD): 5 → 8'), 'the changed rule is said in words');
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
  assert.ok(watch.includes("'월간 지표 보고서 담당' 시험 중") && watch.includes('결과를 기다리는 중') && watch.includes('반복됩니다'));
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
  assert.ok(textOf(effects.text).includes("'고객 안내 메일 초안 #4 발송' 전송 여부 1건 — 실제로 나갔나요?") && !textOf(effects.text.slice(0, effects.text.indexOf('<details>'))).includes('notify-tool'));
  assert.ok(effects.text.includes(`resolve-effect ${rig.demo.ids.effect} --outcome confirmed --note`) && effects.text.includes('--outcome failed --note &quot;확인한 내용&quot; --totp-stdin'));
  assert.ok(!effects.text.includes(sha(Buffer.from('demo-request'))) && !effects.text.includes('effect-key-demo-1'), 'no request hash or effect key');
  const promote = await rig.get(`/experiments/${rig.demo.ids.experiments.promote}`);
  assert.ok(promote.text.includes('promote strategy strategy-demo-promote --comment') && textOf(promote.text).includes('정식 전략으로 올릴까요?') && textOf(promote.text).includes('보관 처리'));
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

// ----- 초안 승인 업무 (ADR-0015 W11) -----
const DRAFT_ADDRESSES = ['kim.minji@example.com', 'lee.joon@example.com', 'park.seo@example.org', 'choi.yuna@example.com', 'han.dowon@example.com', 'jung.haru@example.com', 'support@example.com', 'oh.sora@example.com'];
const taskOfRun = (rig: Awaited<ReturnType<typeof startRig>>, run: string): string => rig.db.get<{ task_id: string }>('SELECT task_id FROM effect_draft WHERE task_run_id = ?', [run])!.task_id;
const setPayload = (db: import('@aot/domain').Db, run: string, seq: number, request: object): void => {
  const payload = canonicalJson(request) as string;
  db.writeTx((tx) => tx.run('UPDATE effect_draft SET payload = ?, payload_hash = ? WHERE task_run_id = ? AND seq = ?', [payload, sha256Hex(payload), run, seq]));
};

test('a customer-mail task with drafts shows who gets what, in three rows, with the influenced badge and the expiry', async (t) => {
  const rig = await startRig(t);
  const home = (await rig.get('/')).text;
  const card = home.split('<a class="card"').find((c) => c.includes('고객 안내 메일 4통'))!;
  const cardText = textOf(card);
  assert.ok(cardText.includes("메일 4통 · 받는 사람 모두 8명 · 첫 제목 '"), cardText);
  assert.ok(cardText.includes('고객 안내 메일 4통(받는 사람 8명)을 보낼까요?') && !cardText.includes('3건'), 'the question counts mails, not tasks');
  assert.ok(cardText.includes('1통 기한 지남') && !cardText.includes('어제부터 대기'), 'expired count is a badge; the waiting time stays in the details');
  const risk = /위험·기한 (.*?)\s*$/.exec(cardText)![1]!;
  assert.equal(risk.split(' · ').length, 2, risk);
  assert.equal(risk, '보내면 되돌릴 수 없음 · 초안 23시간 뒤 만료');
  assert.ok(cardText.includes('받는 사람과 문구가 이대로 나가도 되는지') && cardText.includes('초안 23시간 뒤 만료') && cardText.includes('외부 입력 영향 하에 작성됨 (1건)'), cardText);
  assert.ok(!cardText.includes('내용 미리보기 없음'), 'the old placeholder copy is gone for tasks with drafts');
  assert.deepEqual(idsIn(cardText), []);
  // 한 업무(메일 2건): 제목·받는 사람 가림·도메인별 수·본문·짧은 해시(자세히 안)
  const one = await rig.get(`/approvals/task/${rig.demo.ids.task}`);
  const first = firstLevel(one.text);
  assert.ok(first.includes("메일 2통 · 받는 사람 모두 4명 · 첫 제목 '가을 신제품 판매 시작 안내'") && first.includes('초안 47시간 뒤 만료'), first);
  assert.ok(first.includes('k***@example.com, l***@example.com, p***@example.org') && first.includes('example.com 2명, example.org 1명') && first.includes('이번 달 말부터 새 제품을 판매합니다') && first.includes('정확한 주소는 CLI show 에서'), first);
  assert.ok(!first.includes('외부 입력 영향'), 'not influenced');
  assert.deepEqual(idsIn(first), [], 'no ids or hashes above the fold');
  const hashPrefix = rig.db.get<{ payload_hash: string }>('SELECT payload_hash FROM effect_draft WHERE task_run_id = ? AND seq = 1', ['run-demo-draft-0'])!.payload_hash.slice(0, 12);
  assert.ok(one.text.slice(one.text.indexOf('<details>')).includes(hashPrefix) && !first.includes(hashPrefix), 'the short payload hash is only inside the details');
  assert.ok(one.text.includes(`${CLI} approve task ${rig.demo.ids.task} --hash `) && one.text.includes(`${CLI} reject task ${rig.demo.ids.task}`) && one.text.includes(`${CLI} request-changes task ${rig.demo.ids.task} --comment`));
  // 외부 입력 영향 업무
  const influenced = await rig.get(`/approvals/task/${taskOfRun(rig, 'run-demo-draft-1')}`);
  assert.ok(firstLevel(influenced.text).includes("받는 사람 3명 · 제목 '문의하신 환불 절차 안내' · 첫 줄 문의해 주신 환불은") && firstLevel(influenced.text).includes('외부 입력 영향 하에 작성됨') && firstLevel(influenced.text).includes('초안 23시간 뒤 만료'), firstLevel(influenced.text));
  assert.ok(influenced.text.includes('<span class="badge warn">외부 입력 영향 하에 작성됨</span>'));
});

test('an expired draft has no approve command: the reason and the request-changes command take its place', async (t) => {
  const rig = await startRig(t);
  const id = taskOfRun(rig, 'run-demo-draft-2');
  const page = await rig.get(`/approvals/task/${id}`);
  const first = firstLevel(page.text);
  assert.ok(first.includes('초안 기한이 지났습니다 — 다시 쓰게 하려면 변경 요청') && first.includes('승인 불가 — 초안 기한 지남'), first);
  assert.ok(!page.text.includes(`approve task ${id}`), 'no approve command');
  assert.ok(page.text.includes(`${CLI} request-changes task ${id} --comment`) && page.text.includes(`${CLI} reject task ${id}`));
  // 묶음의 한 번에 승인에서도 빠진다
  const batch = await rig.get(`/batch/${/href="\/batch\/([^"]*)"/.exec((await rig.get('/')).text)![1]}`);
  assert.ok(!batch.text.includes(`approve task ${id}`) && batch.text.includes(`request-changes task ${id}`) && batch.text.includes('2건 승인'));
});

test('recipient addresses never appear in full, and a secret in a draft body is masked before it is cut', async (t) => {
  const key = `${'sk'}-${'q'.repeat(30)}`;
  const rig = await startRig(t, { before: (db) => setPayload(db, 'run-demo-draft-2', 1, { to: ['oh.sora@example.com'], subject: `정기 점검 안내 ${key}`, text: `점검 안내입니다.\napi_key = ${key}\n${'긴 문장 '.repeat(20000)}` }) });
  const task = taskOfRun(rig, 'run-demo-draft-2');
  const pages = ['/', `/approvals/task/${rig.demo.ids.task}`, `/approvals/task/${task}`, `/approvals/task/${taskOfRun(rig, 'run-demo-draft-1')}`, /href="(\/batch\/[^"]*)"/.exec((await rig.get('/')).text)![1]!];
  for (const path of pages) {
    const body = (await rig.get(path)).text;
    for (const address of DRAFT_ADDRESSES) assert.ok(!body.includes(address), `${address} on ${path}`);
    assert.ok(!body.includes(key) && !body.includes('qqqqqqqq'), `secret on ${path}`);
  }
  const detail = (await rig.get(`/approvals/task/${task}`)).text;
  assert.ok(detail.includes('o***@example.com') && detail.includes('[REDACTED]') && detail.includes('이하 생략'), 'masked, then cut with a visible note');
});

test('tasks with drafts are never batched with tasks without; other kinds of drafts say there is no preview', async (t) => {
  const rig = await startRig(t, {
    before: (db) => {
      db.writeTx((tx) => tx.run("UPDATE effect_draft SET state = 'superseded' WHERE task_run_id = 'run-demo-draft-1'"));
      setPayload(db, 'run-demo-draft-0', 2, { op: 'create', record: { name: '예시' } });
    },
  });
  const home = (await rig.get('/')).text;
  const cards = home.split('<a class="card"').slice(1).map(textOf);
  const plainCards = cards.filter((c) => c.includes('초안 #2'));
  assert.equal(plainCards.length, 1, 'the task without drafts is its own card');
  assert.ok(!plainCards[0]!.includes('/batch/'), 'not folded into the draft batch');
  const plain = plainCards[0]!;
  assert.ok(plain.includes('내용 미리보기 없음, 자세히에서 원문 확인') && plain.includes('받는 사람과 문구가 맞는지') && !plain.includes('이대로'), 'today\'s copy for a task without drafts');
  const draftBatch = cards.find((c) => c.includes('/batch/'))!;
  assert.ok(!draftBatch.includes('초안 #2') && draftBatch.includes('받는 사람 모두'), draftBatch);
  assert.ok(draftBatch.includes('그 밖 1건은 미리보기 없음'), draftBatch);
  const detail = (await rig.get(`/approvals/task/${rig.demo.ids.task}`)).text;
  assert.ok(detail.includes('메일 모양이 아닌 초안입니다') && detail.includes('create'), 'the raw payload is shown instead of a preview');
  const only = await startRig(t, { before: (db) => db.writeTx((tx) => tx.run("UPDATE effect_draft SET payload = '{\"op\":\"x\"}' WHERE task_run_id = 'run-demo-draft-1'")) });
  const onlyCard = textOf((await only.get('/')).text.split('<a class="card"').find((c) => c.includes('/batch/'))!);
  assert.ok(onlyCard.includes('메일 3통') && onlyCard.includes('그 밖 1건은 미리보기 없음'), onlyCard);
});

test('a draft with a secret-looking value cannot be approved on the screen: badge, one line of reason, request-changes only', async (t) => {
  const rig = await startRig(t);
  const id = taskOfRun(rig, 'run-demo-draft-4');
  const page = await rig.get(`/approvals/task/${id}`);
  const first = firstLevel(page.text);
  assert.ok(first.includes('예약 확인 메일 1통(받는 사람 1명)을 보낼까요?') && first.includes('승인 불가 — 가려진 값이 있음'), first);
  assert.ok(first.includes('비밀값처럼 보이는 내용이 있어 사람이 전부 볼 수 없습니다. 변경 요청으로 다시 쓰게 하세요'), first);
  assert.ok(!page.text.includes(`approve task ${id}`), 'no approve command');
  assert.ok(page.text.includes(`${CLI} request-changes task ${id} --comment`) && page.text.includes(`${CLI} reject task ${id}`));
  assert.ok(textOf(page.text).includes('headers.X-Api-Token') && !page.text.includes('xxxxxxxx'), 'the path is named, the value never shown');
  const risk = /위험·기한 (.*?)\s*$/.exec(textOf((await rig.get('/')).text.split('<a class="card"').find((c) => c.includes('예약 확인 메일'))!))![1]!;
  assert.ok(risk.split(' · ').length <= 2);
  // 값 모양만 비밀인 본문(키 이름은 평범함)도 같은 가리기(maskSecrets)로 걸러진다
  const valueOnly = await startRig(t, { before: (db) => setPayload(db, 'run-demo-draft-2', 1, { to: ['oh.sora@example.com'], subject: '점검 안내', text: `토큰 ${'sk'}-${'z'.repeat(30)}` }) });
  const vo = await valueOnly.get(`/approvals/task/${taskOfRun(valueOnly, 'run-demo-draft-2')}`);
  assert.ok(vo.text.includes('승인 불가 — 가려진 값이 있음') && !vo.text.includes(`approve task ${taskOfRun(valueOnly, 'run-demo-draft-2')}`) && !vo.text.includes('zzzzzzzz'));
});

test('a partly sent draft task shows what went out, and offers neither reject nor request-changes', async (t) => {
  const rig = await startRig(t);
  const id = taskOfRun(rig, 'run-demo-effect');
  const page = await rig.get(`/approvals/task/${id}`);
  const first = firstLevel(page.text);
  assert.ok(first.includes('이미 나간 1통, 전송 여부 불명 1통 · 전송 여부 카드에서 확인') && first.includes('보냄') && first.includes('전송 여부 불명'), first);
  assert.ok(first.includes('거절 불가') && first.includes('변경 요청 불가'), first);
  assert.ok(!page.text.includes(`request-changes task ${id}`) && !page.text.includes(`reject task ${id}`), 'neither command is offered');
  assert.ok(page.text.includes(`approve task ${id}`), 'approving (after the unknown effect is resolved) is still the engine\'s call');
  assert.ok((await rig.get('/effects')).text.includes('전송 여부 1건'), 'the effects card still owns the unknown effect');
  // 보내지 못함
  const failed = await startRig(t, { before: (db) => db.writeTx((tx) => tx.run("UPDATE external_effect SET state = 'failed' WHERE id = 'effect-demo-sent'")) });
  assert.ok(textOf((await failed.get(`/approvals/task/${taskOfRun(failed, 'run-demo-effect')}`)).text).includes('보내지 못함'));
});

test('draft cards stay short: at most two risk segments on every draft card', async (t) => {
  const rig = await startRig(t);
  const cards = (await rig.get('/')).text.split('<a class="card"').slice(1).map(textOf).filter((c) => c.includes('확인할 것 받는 사람과 문구가 이대로'));
  assert.equal(cards.length, 3, 'batch, partly sent, masked');
  for (const c of cards) assert.ok(/위험·기한 (.*?)\s*$/.exec(c)![1]!.split(' · ').length <= 2, c);
});
