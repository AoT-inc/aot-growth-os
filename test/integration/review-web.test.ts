// 검토 화면 (docs/operations/review-web.md): 화면 내용·결정 버튼 모양·읽기 보안 규칙을 실제 서버(127.0.0.1, 임시 포트)와 데모 시나리오 DB 로 확인한다. 결정 보내기(POST)는 review-web-write.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalJson, openDb, sha256Hex } from '@aot/domain';
import { PolicyStore } from '@aot/policy';
import { createEvidenceStore } from '../../apps/daemon/src/evidence-store.ts';

import { openReadOnlyDb, ReadOnlyViolation } from '../../apps/daemon/src/review-web/read-only-db.ts';
import { startReviewServer } from '../../apps/daemon/src/review-web/server.ts';
import { createReviewContext } from '../../apps/daemon/src/review-web/context.ts';
import { demoPng } from '../../scripts/review-web-demo.ts';
import { NOW_MS, rawRequest, startRig } from '../support/review-web.ts';
import { draftRowFor, insertDraftRow } from '../support/drafts.ts';
import { formsOf, startWriteRig } from '../support/review-web-write.ts';
import { makeTempDir } from '../support/temp.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** 화면에 보이는 글자만 (태그·스타일 제거, 엔티티 풀기) */
const textOf = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, ' [그래프] ').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
/** 첫 화면: 접힌 자세히(<details>)와 이유 칸을 뺀 부분 */
const firstLevel = (html: string): string => textOf(html.replace(/<details[\s\S]*?<\/details>/g, ''));
/** 화면 어디에도 승인 CLI 명령 조각이 없다 */
const CLI_WORDS = /approve\.ts|node apps\/|--hash|--comment|--totp-stdin|--actor|request-changes|resolve-effect|product decide|org retrial|org propose|AOT_ACTOR/;
const verbsOf = (html: string): string[] => [...formsOf(html).keys()];
const idsIn = (text: string): string[] => text.match(/[0-9a-f]{64}|\b(?:task|org-proposal|evidence|effect|strategy|publication|policy|product|run)-[0-9a-f][0-9a-f-]{5,}|\d{4}-\d\d-\d\dT\d\d|needs_review|pending_approval|\bproposed\b|\bunknown\b|approval required|\bmissing\b|\{"/g) ?? [];
const linkTo = (html: string, prefix: string): string => new RegExp(`href="(${prefix}[^"]*)"`).exec(html)![1]!;

test('home is a decision inbox: one question per card, three short facts, no ids or engine words on the first level', async (t) => {
  const rig = await startRig(t);
  const home = await rig.get('/');
  assert.equal(home.status, 200);
  const text = textOf(home.text);
  assert.match(text, /결정할 일 \d+건/);
  for (const question of [
    "'support-triage 업무 담당' 역할을 시험 투입할까요?", "'고객 후속 연락 기록 담당' 역할을 시험 투입할까요?", '고객 안내 메일 4통(받는 사람 8명)을 보낼까요?', "'예약 확인 메일'에 가려진 값이 있어요. 다시 쓰게 할까요?", '메일 1통이 실제로 나갔는지 먼저 확인해 주세요',
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

test('org proposal detail: question, summary and facts first, then the decision buttons, then collapsed details; the engine hash and any command stay off the page', async (t) => {
  const rig = await startWriteRig(t);
  const page = await rig.get(`/approvals/org_proposal/${rig.demo.ids.orgNormal}`);
  assert.equal(page.status, 200);
  const html = page.text;
  const at = (needle: string): number => html.indexOf(needle);
  assert.ok(html.includes("<h1>&#39;support-triage 업무 담당&#39; 역할을 시험 투입할까요?</h1>"), 'the h1 is the question');
  assert.ok(at('<h1>') < at('class="lead"') && at('class="lead"') < at('class="facts"') && at('class="facts"') < at('결정하기') && at('결정하기') < at('>승인</button>') && at('>승인</button>') < at('>거절</button>') && at('>거절</button>') < at('<details>'), 'order: question, summary, facts, approve, reject, details');
  const lead = textOf(html.slice(at('class="lead"'), at('class="facts"')));
  for (const part of ['이 업무를 맡을 역할 하나를 추가합니다', '최소 14일 동안 이 업무만 맡기고', '통과율 80% 미만이거나 안전 문제 1건이면 자동으로 되돌립니다']) assert.ok(lead.includes(part), part);
  const first = firstLevel(html);
  assert.ok(first.includes('무엇') && first.includes('확인할 것') && first.includes('위험·기한') && first.includes('13일 뒤 만료'));
  assert.equal((first.match(/support-triage/g) ?? []).length, 3, 'only the page title, the h1 and the rationale name the task type; the summary sentence says "이 업무"');
  assert.deepEqual(idsIn(first), []);
  const detailsHtml = html.slice(at('<details>'));
  for (const label of ['위험과 완화책', '평가 계획', '롤백 계획', '기대 효과', '성공 기준', '최소 관측']) assert.ok(detailsHtml.includes(label), `자세히 has ${label}`);
  assert.deepEqual(verbsOf(html), ['approve', 'reject']);
  assert.ok(!CLI_WORDS.test(html), 'no command text anywhere on the page');
  const shown = rig.ctx.engine.handle({ cmd: 'show', actor: 'actor-owner', kind: 'org_proposal', id: rig.demo.ids.orgNormal }) as unknown as { hash: string };
  assert.match(shown.hash, /^[0-9a-f]{64}$/);
  assert.ok(!html.includes(shown.hash), 'the engine hash is not printed: the form carries a fingerprint only');
  // 거절은 이유 칸이 접혀 있고 선택이다. 승인에는 이유 칸이 없다
  const forms = formsOf(html);
  assert.ok(forms.get('reject')!.html.includes('<details class="why">') && !forms.get('reject')!.html.includes(' required'));
  assert.ok(!forms.get('approve')!.html.includes('textarea'));
});

test('every kind of decision opens on a question with its buttons: risky org, task, batch, publication, policy, strategy', async (t) => {
  const rig = await startWriteRig(t);
  const risky = await rig.get(`/approvals/org_proposal/${rig.demo.ids.orgRisky}`);
  const riskyText = firstLevel(risky.text);
  assert.ok(riskyText.includes('위험 변경 — 승인 후 OTP 코드로 한 번 더 확인해야 함') && riskyText.includes("새 부서 '영업 운영'도 만듭니다"));
  assert.ok(textOf(risky.text).includes('승인 뒤 대기 시간이 지나면 OTP 코드로 한 번 더 확인해야 합니다') && !risky.text.includes('(release)'));
  const task = await rig.get(`/approvals/task/${rig.demo.ids.plainTask}`);
  assert.ok(task.text.includes("<h1>&#39;주간 요약 보고서를 내부 문서함에 정리&#39; — 진행해도 될까요?</h1>") && verbsOf(task.text).join() === 'approve,reject');
  const home = (await rig.get('/')).text;
  const batchPath = linkTo(home, '/batch/');
  const batch = await rig.get(batchPath);
  assert.equal(batch.status, 200);
  const above = batch.text.slice(0, batch.text.indexOf('<details>'));
  const batchForms = formsOf(above);
  assert.deepEqual([...batchForms.keys()], ['approve', 'reject', 'changes']);
  assert.equal(batchForms.get('approve')!.label, '보낼 수 있는 메일 3통 승인 (업무 2건)', 'the expired draft is left out of the approve button');
  assert.equal(batchForms.get('reject')!.label, '메일 4통 모두 거절');
  assert.equal(batchForms.get('changes')!.label, '메일 4통 모두 다시 쓰게');
  assert.ok(batch.text.includes('고객 안내 메일 초안 #1 발송') && batch.text.includes('<h1>고객 안내 메일 4통(받는 사람 8명)을 보낼까요?</h1>'));
  assert.ok(batch.text.slice(batch.text.indexOf('<details>')).includes('이 업무의 메일 내용을 보고 따로 결정하기'), 'per-item decisions are reached through the task pages');
  const publication = await rig.get(`/approvals/publication/${rig.demo.ids.publication}`);
  assert.deepEqual(verbsOf(publication.text), ['approve', 'reject']);
  assert.ok(textOf(publication.text).includes('가을 신제품 안내') && textOf(publication.text).includes('누구나 볼 수 있게 공개할까요?') && textOf(publication.text).includes('이번 달 말부터 새 제품을 판매합니다'));
  const strategy = await rig.get(`/approvals/strategy_version/${rig.demo.ids.strategy}`);
  assert.deepEqual(verbsOf(strategy.text), ['approve', 'reject']);
  assert.ok(textOf(strategy.text).includes('주간 뉴스레터 제목에 질문형 문장 쓰기'));
  const policy = await rig.get(`/approvals/policy_version/${rig.demo.ids.policy}`);
  assert.equal(policy.status, 200);
  assert.ok(verbsOf(policy.text).includes('cancel'));
  assert.ok(textOf(policy.text).includes('업무 하나당 비용 한도(USD): 5 → 8'), 'the changed rule is said in words');
  for (const path of ['/approvals/org_proposal/nope', '/approvals/bogus/x', '/batch/000000000000']) assert.equal((await rig.get(path)).status, 404, path);
});

test('a policy proposal that only widens delegation never reads as "the same as the current policy": it says what the AI may now do, first', async (t) => {
  const widen = (edit: (active: string) => string) => (db: import('@aot/domain').Db, demo: { dir: string }): void => {
    const store = new PolicyStore({ dir: join(demo.dir, 'policies') });
    const hash = db.get<{ content_hash: string }>('SELECT content_hash FROM policy_version ORDER BY deployed_at DESC, rowid DESC LIMIT 1')!.content_hash;
    const archived = store.archive(edit(readFileSync(join(demo.dir, 'policies', `${hash}.yaml`), 'utf8')));
    const owner = db.get<{ id: string }>("SELECT id FROM actor WHERE kind = 'human' ORDER BY id LIMIT 1")!.id;
    db.writeTx((tx) => tx.run("INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES ('approval-policy-widen', 'policy_version', 'policy-widen', 'approved', ?, ?, NULL, '2026-11-04T00:00:00.000Z')", [archived.hash, owner]));
  };
  // 새 위임을 더한다: 모든 작업, 하루 1000건
  const added = await startRig(t, {
    before: widen((text) => {
      const block = text.slice(text.indexOf('    - id: routine-notice'));
      return `${text.trimEnd()}\n${block.replace('id: routine-notice', 'id: everything').replace("actions: ['notify-tool.send']", "actions: ['*.*']").replace("targets: ['mailbox:*']", "targets: ['*']").replace('max_per_day: 5', 'max_per_day: 1000')}`;
    }),
  });
  const addedPage = await added.get('/approvals/policy_version/policy-widen');
  assert.equal(addedPage.status, 200);
  const addedFirst = firstLevel(addedPage.text);
  assert.ok(addedFirst.includes('AI 위임 추가: 모든 작업, 등록된 고객에게만, 하루 최대 1000건'), addedFirst);
  assert.ok(!addedFirst.includes('현재 정책과 같은 내용'), 'a widening is never "the same"');
  assert.ok(textOf((await added.get('/')).text).includes('AI 위임 추가: 모든 작업, 등록된 고객에게만, 하루 최대 1000건'), 'the home card says it too');
  // 있던 위임을 넓힌다: 한도 상향
  const raised = await startRig(t, { before: widen((text) => text.replace('max_per_day: 5', 'max_per_day: 900').replace("actions: ['notify-tool.send']", "actions: ['notify-tool.send', '*.*']")) });
  const raisedFirst = firstLevel((await raised.get('/approvals/policy_version/policy-widen')).text);
  assert.ok(raisedFirst.includes("AI 위임 'routine-notice' 하루 최대 승인 건수 상향: 5 → 900") && raisedFirst.includes("작업 확대: '*.*'"), raisedFirst);
  assert.ok(!raisedFirst.includes('현재 정책과 같은 내용'));
  // 받는 사람 규칙은 첫 줄에 그대로 말한다: 도메인 목록, 그리고 규칙을 바꾸는 변경
  const domains = await startRig(t, { before: widen((text) => text.replace('recipients: { kind: known_contacts }', "recipients: { kind: domains, domains: ['shop.example.com'] }")) });
  const domainsFirst = firstLevel((await domains.get('/approvals/policy_version/policy-widen')).text);
  assert.ok(domainsFirst.includes("AI 위임 'routine-notice' 받는 사람 규칙 변경: 등록된 고객만 → 도메인 지정"), domainsFirst);
  // 위임을 줄이는 변경도 "같은 내용" 이 아니다
  const narrowed = await startRig(t, { before: widen((text) => text.replace('max_per_day: 5', 'max_per_day: 2')) });
  const narrowedFirst = firstLevel((await narrowed.get('/approvals/policy_version/policy-widen')).text);
  assert.ok(narrowedFirst.includes('AI 위임이 바뀝니다 (넓어지지 않음)') && !narrowedFirst.includes('현재 정책과 같은 내용'), narrowedFirst);
  // 진짜 같은 내용이면 그대로 말한다
  const same = await startRig(t, { before: widen((text) => text) });
  assert.ok(firstLevel((await same.get('/approvals/policy_version/policy-widen')).text).includes('현재 정책과 같은 내용'));
});

test('a task the AI approved that came back to a person says that rejecting or asking for a rewrite pauses the AI, like cancel does; a task the AI never touched says nothing', async (t) => {
  const rig = await startWriteRig(t, {
    before: (db) => db.writeTx((tx) => tx.run("INSERT INTO delegation_control (action, mandate_id, actor_id, reason, at) VALUES ('pause', NULL, (SELECT id FROM actor WHERE kind = 'human' ORDER BY id LIMIT 1), 'test', '2026-11-04T00:00:00.000Z')")),
  });
  const back = await rig.get(`/approvals/task/${rig.demo.ids.delegated.waiting}`);
  assert.equal(back.status, 200);
  const box = textOf(back.text.slice(back.text.indexOf('결정하기')));
  assert.ok(box.includes('이 일은 AI가 승인했던 일입니다') && box.includes('같은 종류의 AI 처리가 멈추고'), box);
  const untouched = textOf((await rig.get(`/approvals/task/${rig.demo.ids.task}`)).text);
  assert.ok(!untouched.includes('AI가 승인했던 일입니다'));
});

test('no screen shows an approval CLI command, an id, a hash or an ISO time above the fold', async (t) => {
  const rig = await startWriteRig(t);
  const ids = rig.demo.ids;
  const paths = ['/', '/watch', '/effects', `/approvals/org_proposal/${ids.orgNormal}`, `/approvals/org_proposal/${ids.orgRisky}`, `/approvals/task/${ids.task}`, `/approvals/task/${ids.plainTask}`, `/approvals/publication/${ids.publication}`,
    `/approvals/strategy_version/${ids.strategy}`, `/approvals/policy_version/${ids.policy}`, `/products/${ids.productSlug}`, `/experiments/${ids.experiments.promote}`, `/experiments/${ids.experiments.needs}`, '/signals/invoice-check',
    `/trials/${ids.orgPass}`, `/trials/${ids.orgInconclusive}`, linkTo((await rig.get('/')).text, '/batch/')];
  for (const path of paths) {
    const reply = await rig.get(path);
    assert.equal(reply.status, 200, path);
    assert.ok(!CLI_WORDS.test(reply.text), `${path} has no command text (not even inside the details)`);
    assert.ok(!/<code>/.test(reply.text.replace(/<details[\s\S]*?<\/details>/g, '')), `${path} has no code boxes above the fold`);
    assert.deepEqual(idsIn(firstLevel(reply.text)), [], path);
  }
});

test('trial: one verdict line first, one small chart, the buttons; the rest is folded away', async (t) => {
  const rig = await startWriteRig(t);
  const pass = await rig.get(`/trials/${rig.demo.ids.orgPass}`);
  const firstHtml = pass.text.slice(0, pass.text.indexOf('<details>'));
  assert.ok(textOf(firstHtml).includes('통과 — 4건 관측. 지금까지 통과율 100%로 기준(70%) 이상.'));
  assert.equal((firstHtml.match(/<svg class="chart"/g) ?? []).length, 1, 'exactly one chart above the fold');
  assert.ok(pass.text.slice(pass.text.indexOf('<details>')).includes('관측 수 vs 최소 관측'), 'observation and cost bars are inside details');
  assert.deepEqual(verbsOf(pass.text), ['confirm']);
  assert.ok(formsOf(pass.text).get('confirm')!.html.includes('required'), 'the reason is required for a confirmation (the engine needs one)');
  const inconclusive = await rig.get(`/trials/${rig.demo.ids.orgInconclusive}`);
  assert.ok(textOf(inconclusive.text).includes('판정 불충분 — 3건이 필요한데 1건만 관측됐습니다'));
  assert.deepEqual(verbsOf(inconclusive.text), [], 'a retrial needs a plan file: not decided on the screen');
  assert.ok(textOf(inconclusive.text).includes('이 결정은 화면에서 할 수 없습니다'));
  const running = await rig.get(`/trials/${rig.demo.ids.orgTrial}`);
  assert.ok(textOf(running.text).includes('아직 판정 전 — 6건 중 3건 관측. 지금까지 통과율 100%로 기준(80%) 이상.'));
  assert.deepEqual(verbsOf(running.text), [], 'nothing to decide yet');
  assert.ok(!/NaN|undefined|Infinity/.test(running.text));
  const watch = textOf((await rig.get('/watch')).text);
  assert.ok(watch.includes("'월간 지표 보고서 담당' 시험 중") && watch.includes('결과를 기다리는 중') && watch.includes('반복됩니다'));
  assert.equal((await rig.get('/trials/nope')).status, 404);
});

test('products, effects, experiments and signals each open on one question with the buttons to act', async (t) => {
  const rig = await startWriteRig(t);
  const product = await rig.get(`/products/${rig.demo.ids.productSlug}`);
  const productText = firstLevel(product.text);
  assert.ok(product.text.includes("<h1>상품 &#39;예시 상품&#39;을 등록할까요?</h1>") && productText.includes('검증 통과') && productText.includes('검증기 의견: 근거가 뒷받침됨') && productText.includes('7건 중 1건 확인됨, 외부 입력 3건 포함'));
  assert.deepEqual(idsIn(productText), []);
  assert.deepEqual(verbsOf(product.text), ['approve', 'reject', 'restart']);
  const productForms = formsOf(product.text);
  assert.equal(productForms.get('reject')!.label, '반려');
  assert.ok(productForms.get('reject')!.html.includes('required') && productForms.get('restart')!.html.includes('required'), 'the engine needs a reason for both');
  assert.ok(product.text.slice(product.text.indexOf('<details>')).includes('독립 평가 (원문)'), 'evidence list and raw verdicts are folded');
  const effects = await rig.get('/effects');
  assert.ok(textOf(effects.text).includes("'고객 안내 메일 초안 #4 발송' 전송 여부 1건 — 실제로 나갔나요?") && !textOf(effects.text.slice(0, effects.text.indexOf('<details>'))).includes('notify-tool'));
  assert.deepEqual(verbsOf(effects.text), ['confirmed', 'failed']);
  const effectForms = formsOf(effects.text);
  assert.ok(!effectForms.get('confirmed')!.html.includes('name="totp"') && effectForms.get('failed')!.html.includes('name="totp"') && effectForms.get('failed')!.html.includes('autocomplete="one-time-code"') && effectForms.get('failed')!.html.includes('inputmode="numeric"'), 'only "did not go out" asks for the OTP');
  assert.ok(!effects.text.includes(sha(Buffer.from('demo-request'))) && !effects.text.includes('effect-key-demo-1'), 'no request hash or effect key');
  const promote = await rig.get(`/experiments/${rig.demo.ids.experiments.promote}`);
  assert.deepEqual(verbsOf(promote.text), ['promote', 'reject']);
  assert.ok(textOf(promote.text).includes('정식 전략으로 올릴까요?') && textOf(promote.text).includes('보관 처리'));
  const needs = await rig.get(`/experiments/${rig.demo.ids.experiments.needs}`);
  assert.deepEqual(verbsOf(needs.text), ['reject']);
  assert.ok(textOf(needs.text).includes('판정 보류') && formsOf(needs.text).get('reject')!.label === '실험 끝내기');
  const signal = await rig.get('/signals/invoice-check');
  assert.deepEqual(verbsOf(signal.text), [], 'proposing a role needs a name chosen by a person: not decided on the screen');
  assert.ok(textOf(signal.text).includes('이 결정은 화면에서 할 수 없습니다'));
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

  const csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  for (const path of ['/', '/watch', '/nope', `/evidence/${rig.demo.ids.evidence.png}/file`]) {
    const reply = await rig.get(path);
    assert.equal(reply.headers['content-security-policy'], csp, path);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal(reply.headers['referrer-policy'], 'same-origin', 'no-referrer would make browsers send Origin: null on the decision POST');
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
  const csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
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

test('the screen does not offer buttons the engine would refuse (expired proposal, failed evaluation, no verified evidence)', async (t) => {
  const expired = await startWriteRig(t, { clockMs: NOW_MS + 60 * 86_400_000 });
  const page = await expired.get(`/approvals/org_proposal/${expired.demo.ids.orgNormal}`);
  assert.ok(page.text.includes('만료됨') && !verbsOf(page.text).includes('approve'), 'expired: reason, no approve button');
  assert.ok(verbsOf(page.text).includes('reject'), 'reject stays available');
  const failed = await startWriteRig(t, { before: (db) => db.writeTx((tx) => tx.run("UPDATE evaluation SET outcome = 'fail' WHERE id = 'evaluation-demo-verify'")) });
  const noPass = await failed.get(`/products/${failed.demo.ids.productSlug}`);
  assert.ok(noPass.text.includes('검증이 통과하지 못했습니다') && noPass.text.includes('검증 실패 — 승인 불가') && !verbsOf(noPass.text).includes('approve') && verbsOf(noPass.text).includes('reject'));
  const unverified = await startWriteRig(t, { before: (db) => db.writeTx((tx) => tx.run("UPDATE evidence SET verified = 0")) });
  const noEvidence = await unverified.get(`/products/${unverified.demo.ids.productSlug}`);
  assert.ok(noEvidence.text.includes('확인된 증거가 없습니다') && !verbsOf(noEvidence.text).includes('approve'));
  const ok = await (await startWriteRig(t)).get('/products/example-product');
  assert.ok(verbsOf(ok.text).includes('approve'), 'still offered when the engine would accept');
});

// ----- 초안 승인 업무 (ADR-0015 W11) -----
const DRAFT_ADDRESSES = ['kim.minji@example.com', 'lee.joon@example.com', 'park.seo@example.org', 'choi.yuna@example.com', 'han.dowon@example.com', 'jung.haru@example.com', 'support@example.com', 'oh.sora@example.com'];
const taskOfRun = (rig: Awaited<ReturnType<typeof startRig>>, run: string): string => rig.db.get<{ task_id: string }>('SELECT task_id FROM effect_draft WHERE task_run_id = ?', [run])!.task_id;
const setPayload = (db: import('@aot/domain').Db, run: string, seq: number, request: object): void => {
  const payload = canonicalJson(request) as string;
  db.writeTx((tx) => tx.run('UPDATE effect_draft SET payload = ?, payload_hash = ? WHERE task_run_id = ? AND seq = ?', [payload, sha256Hex(payload), run, seq]));
};

test('a customer-mail task with drafts shows who gets what, in three rows, with the influenced badge and the expiry', async (t) => {
  const rig = await startWriteRig(t);
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
  assert.ok(['kim.minji@example.com', 'lee.joon@example.com', 'park.seo@example.org'].every((a) => first.includes(a)) && !first.includes('k***@') && first.includes('example.com 2명, example.org 1명') && first.includes('이번 달 말부터 새 제품을 판매합니다') && first.includes('줄이거나 가리지 않고 그대로 보여 줍니다'), first);
  assert.ok(!first.includes('외부 입력 영향'), 'not influenced');
  assert.deepEqual(idsIn(first), [], 'no ids or hashes above the fold');
  const hashPrefix = rig.db.get<{ payload_hash: string }>('SELECT payload_hash FROM effect_draft WHERE task_run_id = ? AND seq = 1', ['run-demo-draft-0'])!.payload_hash.slice(0, 12);
  assert.ok(one.text.slice(one.text.indexOf('<details>')).includes(hashPrefix) && !first.includes(hashPrefix), 'the short payload hash is only inside the details');
  assert.deepEqual(verbsOf(one.text), ['approve', 'reject', 'changes']);
  assert.equal(formsOf(one.text).get('changes')!.label, '다시 쓰게');
  assert.ok(formsOf(one.text).get('changes')!.html.includes('required'), 'asking for a rewrite needs a reason');
  assert.ok(!CLI_WORDS.test(one.text) && !textOf(one.text).includes('CLI'));
  // 외부 입력 영향 업무
  const influenced = await rig.get(`/approvals/task/${taskOfRun(rig, 'run-demo-draft-1')}`);
  assert.ok(firstLevel(influenced.text).includes("받는 사람 3명 · 제목 '문의하신 환불 절차 안내' · 첫 줄 문의해 주신 환불은") && firstLevel(influenced.text).includes('외부 입력 영향 하에 작성됨') && firstLevel(influenced.text).includes('초안 23시간 뒤 만료'), firstLevel(influenced.text));
  assert.ok(influenced.text.includes('<span class="badge warn">외부 입력 영향 하에 작성됨</span>'));
});

test('an expired draft has no approve button: the reason and the rewrite button take its place', async (t) => {
  const rig = await startWriteRig(t);
  const id = taskOfRun(rig, 'run-demo-draft-2');
  const page = await rig.get(`/approvals/task/${id}`);
  const first = firstLevel(page.text);
  assert.ok(first.includes('초안 기한이 지났습니다 — 다시 쓰게 해 주세요') && first.includes('승인 불가 — 초안 기한 지남'), first);
  assert.deepEqual(verbsOf(page.text), ['reject', 'changes'], 'no approve button');
  // 묶음의 한 번에 승인에서도 빠진다
  const batch = await rig.get(`/batch/${/href="\/batch\/([^"]*)"/.exec((await rig.get('/')).text)![1]}`);
  assert.ok(textOf(batch.text).includes('보낼 수 있는 메일 3통 승인 (업무 2건)') && textOf(batch.text).includes('기한 지난 1통은 빠졌습니다') && !batch.text.includes('정책 거부)'));
  assert.ok(batch.text.slice(batch.text.indexOf('<details>')).includes('초안 기한이 지났습니다'), 'the per-task reason is inside the details');
});

test('recipient addresses are shown in full on the detail pages (never on the home card); a secret in a draft body is masked, never half shown, and blocks approval', async (t) => {
  const key = `${'sk'}-${'q'.repeat(30)}`;
  const rig = await startRig(t, { before: (db) => setPayload(db, 'run-demo-draft-2', 1, { to: ['oh.sora@example.com'], subject: `정기 점검 안내 ${key}`, text: `점검 안내입니다.\napi_key = ${key}\n${'긴 문장 '.repeat(20000)}` }) });
  const task = taskOfRun(rig, 'run-demo-draft-2');
  const home = (await rig.get('/')).text;
  for (const address of DRAFT_ADDRESSES) assert.ok(!home.includes(address), `${address} on the home card`);
  const pages = [`/approvals/task/${rig.demo.ids.task}`, `/approvals/task/${task}`, `/approvals/task/${taskOfRun(rig, 'run-demo-draft-1')}`, /href="(\/batch\/[^"]*)"/.exec(home)![1]!];
  for (const path of pages) {
    const body = (await rig.get(path)).text;
    assert.ok(!body.includes(key) && !body.includes('qqqqqqqq'), `secret on ${path}`);
    assert.ok(!/[a-z]\*\*\*@/.test(body), `masked address on ${path}`);
  }
  const detail = await rig.get(`/approvals/task/${task}`);
  assert.ok(detail.text.includes('oh.sora@example.com') && detail.text.includes('[REDACTED]'), 'the address is exact; the secret is masked');
  assert.ok(!verbsOf(detail.text).includes('approve'), 'nothing is cut silently: a draft that cannot be shown whole has no approve button');
  assert.ok(!detail.text.includes('이하 생략'), 'no silent or noted truncation of the mail');
});

// 승인하는 사람이 보지 못한 것이 나가면 안 된다: payload 의 모든 필드를 그대로 보여 주고, 다 보여 줄 수 없으면 승인 버튼을 내지 않는다
const FULL_MAIL = {
  to: ['kxx-attacker@example.com'], cc: ['cc.person@example.net'], bcc: ['hidden.watcher@example.org'], subject: '결제 안내', text: '안녕하세요.\n결제 링크를 확인해 주세요.',
  html: '<a href="https://evil.example/pay">여기를 누르세요</a><script>alert(1)</script>', reply_to: 'reply-here@evil.example',
  headers: { 'X-Campaign': 'spring-2026', 'List-Unsubscribe': '<mailto:u@example.com>' }, attachments: [{ name: 'invoice.pdf', size: 1024, sha256: 'ab'.repeat(32) }], x_unknown_field: { nested: [1, 'two', { three: true }] },
};

test('every field of a draft is shown in full above the buttons: attacker-like address, html as escaped source, reply_to, headers, attachments, an unknown key', async (t) => {
  const rig = await startWriteRig(t, { before: (db) => setPayload(db, 'run-demo-draft-0', 1, FULL_MAIL) });
  const id = rig.demo.ids.task;
  const page = await rig.get(`/approvals/task/${id}`);
  const above = page.text.slice(0, page.text.indexOf('결정하기'));
  const aboveText = textOf(above);
  for (const shown of ['kxx-attacker@example.com', 'cc.person@example.net', 'hidden.watcher@example.org', 'reply-here@evil.example', 'reply_to', 'x_unknown_field', 'X-Campaign', 'invoice.pdf', 'spring-2026', 'three']) assert.ok(aboveText.includes(shown), `${shown} is above the decision box`);
  assert.ok(above.includes('&lt;a href=&quot;https://evil.example/pay&quot;&gt;') && above.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !above.includes('<script>alert(1)'), 'html is shown as escaped source text');
  assert.ok(!/[a-z]\*\*\*@/.test(page.text), 'no masked address anywhere');
  assert.ok(verbsOf(page.text).includes('approve'), 'everything is visible, so approving is possible');
  const details = page.text.slice(page.text.indexOf('<details>'));
  assert.ok(details.includes('x_unknown_field') && details.includes('reply-here@evil.example') && details.includes(rig.db.get<{ payload_hash: string }>('SELECT payload_hash FROM effect_draft WHERE task_run_id = ? AND seq = 1', ['run-demo-draft-0'])!.payload_hash), 'the details hold the whole payload and the full hash');
  // 묶음 상세에도 같다
  const batch = (await rig.get(/href="(\/batch\/[^"]*)"/.exec((await rig.get('/')).text)![1]!)).text;
  const batchAbove = textOf(batch.slice(0, batch.indexOf('결정하기')));
  for (const shown of ['kxx-attacker@example.com', 'reply-here@evil.example', 'x_unknown_field']) assert.ok(batchAbove.includes(shown), `${shown} on the batch page`);
});

test('a draft with a field that cannot be shown whole (too large, binary) has no approve button on the task page or the batch page: it asks for a rewrite', async (t) => {
  const cases: [string, object, string][] = [
    ['too large html', { ...FULL_MAIL, html: '<p>x</p>'.repeat(10_000) }, '너무 큼'],
    ['binary attachment bytes', { ...FULL_MAIL, attachments: [{ name: 'a.bin', data: 'ab\u0000\u0001\ufffdcd' }] }, '글이 아닌 값'],
    ['non-mail payload with a huge field', { op: 'create', blob: 'z '.repeat(40_000) }, '너무 큼'],
  ];
  for (const [name, payload, why] of cases) {
    const rig = await startWriteRig(t, { before: (db) => setPayload(db, 'run-demo-draft-0', 1, payload) });
    const id = rig.demo.ids.task;
    const page = await rig.get(`/approvals/task/${id}`);
    const first = firstLevel(page.text);
    assert.ok(first.includes('다시 쓰게 할까요?') && first.includes('승인 불가 — 다 볼 수 없는 값이 있음') && first.includes(why), `${name}: ${first}`);
    assert.ok(!verbsOf(page.text).includes('approve'), `${name}: no approve button`);
    assert.ok(verbsOf(page.text).includes('changes'), `${name}: rewrite is offered`);
    assert.ok(!page.text.includes('이하 생략'), `${name}: nothing is cut`);
    // 다 볼 수 없는 업무는 묶음에 섞이지 않는다(할 수 있는 결정이 다르다). 어느 묶음의 승인 버튼에도 이 업무가 들어 있지 않다
    for (const [, href] of (await rig.get('/')).text.matchAll(/href="(\/batch\/[^"]*)"/g)) {
      const batch = (await rig.get(href!)).text;
      assert.ok(!(formsOf(batch).get('approve')?.html ?? '').includes(id), `${name}: batch ${href} approve leaves this task out`);
    }
  }
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

test('a draft with a secret-looking value cannot be approved on the screen: badge, one line of reason, rewrite only', async (t) => {
  const rig = await startWriteRig(t);
  const id = taskOfRun(rig, 'run-demo-draft-4');
  const page = await rig.get(`/approvals/task/${id}`);
  const first = firstLevel(page.text);
  assert.ok(first.includes("'예약 확인 메일'에 가려진 값이 있어요. 다시 쓰게 할까요?") && first.includes('승인 불가 — 가려진 값이 있음'), first);
  assert.ok(first.includes('비밀값처럼 보이는 내용이 있어 사람이 전부 볼 수 없습니다. 다시 쓰게 해 주세요'), first);
  assert.deepEqual(verbsOf(page.text), ['reject', 'changes'], 'no approve button');
  assert.ok(textOf(page.text).includes('headers.X-Api-Token') && !page.text.includes('xxxxxxxx'), 'the path is named, the value never shown');
  const risk = /위험·기한 (.*?)\s*$/.exec(textOf((await rig.get('/')).text.split('<a class="card"').find((c) => c.includes('예약 확인 메일'))!))![1]!;
  assert.ok(risk.split(' · ').length <= 2);
  // 값 모양만 비밀인 본문(키 이름은 평범함)도 같은 가리기(maskSecrets)로 걸러진다
  const valueOnly = await startWriteRig(t, { before: (db) => setPayload(db, 'run-demo-draft-2', 1, { to: ['oh.sora@example.com'], subject: '점검 안내', text: `토큰 ${'sk'}-${'z'.repeat(30)}` }) });
  const vo = await valueOnly.get(`/approvals/task/${taskOfRun(valueOnly, 'run-demo-draft-2')}`);
  assert.ok(vo.text.includes('승인 불가 — 가려진 값이 있음') && !verbsOf(vo.text).includes('approve') && !vo.text.includes('zzzzzzzz'));
});

test('a partly sent draft task shows what went out, and offers neither reject nor rewrite', async (t) => {
  const rig = await startWriteRig(t);
  const id = taskOfRun(rig, 'run-demo-effect');
  const page = await rig.get(`/approvals/task/${id}`);
  const first = firstLevel(page.text);
  assert.ok(first.includes('메일 1통이 실제로 나갔는지 먼저 확인해 주세요') && first.includes('이미 나감 1통 · 전송 여부 불명 1통') && !first.includes('보낼까요'), first);
  assert.ok(!verbsOf(page.text).includes('approve') && first.includes('승인 불가') && page.text.includes('href="/effects"'), 'no approve while an effect is unknown');
  assert.ok(first.includes('이미 나간 1통, 전송 여부 불명 1통 · 전송 여부 카드에서 확인') && first.includes('보냄') && first.includes('전송 여부 불명'), first);
  assert.ok(first.includes('거절 불가') && first.includes('다시 쓰게 불가'), first);
  assert.deepEqual(verbsOf(page.text), [], 'no button is offered');
  assert.ok((await rig.get('/effects')).text.includes('전송 여부 1건'), 'the effects card still owns the unknown effect');
  // 보내지 못함
  const failed = await startRig(t, { before: (db) => db.writeTx((tx) => tx.run("UPDATE external_effect SET state = 'failed' WHERE id = 'effect-demo-sent'")) });
  const failedText = firstLevel((await failed.get(`/approvals/task/${taskOfRun(failed, 'run-demo-effect')}`)).text);
  assert.ok(failedText.includes('보내지 못함'));
  // 불명이 없고 일부만 나갔으면 남은 것만 묻는다 (받는 사람도 남은 초안 기준)
  const rest = await startRig(t, { before: (db) => db.writeTx((tx) => { tx.run("UPDATE external_effect SET state = 'confirmed' WHERE id = 'effect-demo-1'"); }) });
  const restText = firstLevel((await rest.get(`/approvals/task/${taskOfRun(rest, 'run-demo-effect')}`)).text);
  assert.ok(restText.includes('남은 메일이 없습니다') && !restText.includes('먼저 확인해 주세요'), restText);
  const more = await startWriteRig(t, {
    before: (db) => {
      db.writeTx((tx) => tx.run("UPDATE external_effect SET state = 'confirmed' WHERE id = 'effect-demo-1'"));
      const taskId = db.get<{ task_id: string }>("SELECT task_id FROM effect_draft WHERE task_run_id = 'run-demo-effect' LIMIT 1")!.task_id;
      insertDraftRow(db, draftRowFor(taskId, 'run-demo-effect', { seq: 3, request: { to: ['a.one@example.com', 'b.two@example.com'], subject: '남은 안내', text: '남은 메일 본문입니다.' }, expires_at: '2026-11-07T00:00:00.000Z' }));
    },
  });
  const moreText = firstLevel((await more.get(`/approvals/task/${taskOfRun(more, 'run-demo-effect')}`)).text);
  assert.ok(moreText.includes('남은 메일 1통(받는 사람 2명)을 보낼까요?') && moreText.includes('이미 나감') === false, moreText);
  assert.ok(verbsOf((await more.get(`/approvals/task/${taskOfRun(more, 'run-demo-effect')}`)).text).includes('approve'), 'approve is back once nothing is unknown');
});

test('draft cards stay short: at most two risk segments on every draft card', async (t) => {
  const rig = await startRig(t);
  const cards = (await rig.get('/')).text.split('<a class="card"').slice(1).map(textOf).filter((c) => c.includes('확인할 것 받는 사람과 문구가 이대로'));
  assert.equal(cards.length, 3, 'batch, partly sent, masked');
  for (const c of cards) assert.ok(/위험·기한 (.*?)\s*$/.exec(c)![1]!.split(' · ').length <= 2, c);
});

test('the batch detail shows every mail above the decision box, and asks what the human can actually decide', async (t) => {
  const rig = await startWriteRig(t);
  const batch = (await rig.get(/href="(\/batch\/[^"]*)"/.exec((await rig.get('/')).text)![1]!)).text;
  const above = batch.slice(0, batch.indexOf('결정하기'));
  assert.ok(above.includes('보낼 내용') && above.indexOf('보낼 내용') < batch.indexOf('결정하기'), 'mails come first');
  for (const mail of ['kim.minji@example.com', 'example.com 2명, example.org 1명', '가을 신제품 판매 시작 안내', '문의하신 환불 절차 안내', '정기 점검 일정 안내', '이번 달 말부터 새 제품을 판매합니다']) assert.ok(above.includes(mail), mail);
  assert.ok(above.includes('고객 안내 메일 초안 #1 발송') && above.includes('<span class="badge bad">기한 지남</span>') && above.includes('외부 입력 영향 하에 작성됨'), 'grouped per task, badges inline');
  for (const address of ['kim.minji@example.com', 'park.seo@example.org', 'oh.sora@example.com']) assert.ok(batch.includes(address), `${address} is shown in full`);
  const box = textOf(batch.slice(batch.indexOf('결정하기')));
  assert.ok(box.includes('보낼 수 있는 메일 3통 승인 (업무 2건)') && box.includes('기한 지난 1통은 빠졌습니다') && box.includes('메일 4통 모두 거절') && box.includes('메일 4통 모두 다시 쓰게'), box);
  // 전부 기한이 지났으면: 할 수 있는 결정(다시 쓰기)을 묻는다
  const allExpired = await startWriteRig(t, { before: (db) => db.writeTx((tx) => tx.run("UPDATE effect_draft SET expires_at = '2026-11-01T00:00:00.000Z' WHERE task_run_id IN ('run-demo-draft-0', 'run-demo-draft-1', 'run-demo-draft-2')")) });
  const home = textOf((await allExpired.get('/')).text);
  assert.ok(home.includes('기한이 지난 메일 4통 — 다시 쓰게 할까요?'), home);
  const page = await allExpired.get(/href="(\/batch\/[^"]*)"/.exec((await allExpired.get('/')).text)![1]!);
  assert.ok(!verbsOf(page.text).includes('approve') && page.text.includes('기한 지남'));
});

test('delegated items are not decisions: the home lists them only in the "AI가 처리함" digest (read-only screen: no buttons), and /delegated shows the reason and when', async (t) => {
  const rig = await startRig(t);
  const home = (await rig.get('/')).text;
  const flat = textOf(home);
  assert.match(flat, /AI가 처리함/);
  assert.match(flat, /AI가 지난 24시간에 2건 처리함\. 1건은 아직 나가지 않았고 취소할 수 있습니다/);
  assert.match(flat, /50분 뒤 나감/);
  assert.match(flat, /AI의 판단: 정기 안내 메일이고 가격·계약 언급이 없어/);
  assert.ok(!home.includes('<form'), 'a read-only screen offers no buttons');
  const { waiting, sent } = rig.demo.ids.delegated;
  for (const id of [waiting, sent]) assert.ok(!home.includes(`href="/approvals/task/${id}"`), 'a delegated task is not a decision card');
  assert.match(flat, /결정할 일 \d+건|바깥에 나가는 일 \d+건/, 'the decisions that need a person are still there');
  const page = textOf((await rig.get('/delegated')).text);
  assert.match(page, /이용 약관 개정 안내 메일 발송|메일 1통 '정기 점검 일정 안내'/);
  assert.match(page, /나가기 전/);
  assert.match(page, /오늘 나감/);
  assert.ok(!/[0-9a-f]{32}|20\d\d-\d\d-\d\dT/.test(page), 'no ids, hashes or ISO times');
  assert.match(textOf((await rig.get(`/approvals/task/${waiting}`)).text), /AI가 처리한 일입니다/);
});
