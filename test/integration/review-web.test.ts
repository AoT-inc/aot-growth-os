// 읽기 전용 검토 화면 (docs/operations/review-web.md): 화면 내용·명령 모양·보안 규칙을 실제 서버(127.0.0.1, 임시 포트)와 데모 시나리오 DB 로 확인한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeClock, openDb } from '@aot/domain';
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
const hrefs = (text: string): string[] => [...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

test('home counts what waits for a human and links to each list', async (t) => {
  const rig = await startRig(t);
  const home = await rig.get('/');
  assert.equal(home.status, 200);
  for (const label of ['사람의 결정을 기다리는 것', '조직 변경 제안', '실험 전략 제안', '정책 제안', '게시', '업무 (검토 필요)', '상품 등록 검토', '시험 중인 조직 변경', '확인이 필요한 외부 효과', '실험 결과 검토']) {
    assert.ok(home.text.includes(label), `home shows '${label}'`);
  }
  for (const target of ['/approvals', '/products', '/trials', '/effects', '/experiments', '/signals', '/evidence']) assert.ok(hrefs(home.text).includes(target), `home links ${target}`);
  assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
  // 모든 화면이 열린다
  for (const path of ['/approvals', '/trials', '/signals', '/products', `/products/${rig.demo.ids.productSlug}`, '/effects', '/experiments', '/evidence']) {
    assert.equal((await rig.get(path)).status, 200, path);
  }
});

test('org proposal detail: plain-language summary, the real approval hash only inside the command, and the command works', async (t) => {
  const rig = await startRig(t);
  const list = await rig.get('/approvals');
  assert.ok(list.text.includes(rig.demo.ids.orgNormal) && list.text.includes(rig.demo.ids.orgRisky), 'both pending proposals are listed');
  assert.ok(list.text.includes('역할 &#39;example-support-triager&#39; 추가'), 'headline in plain language');
  const page = await rig.get(`/approvals/org_proposal/${rig.demo.ids.orgNormal}`);
  assert.equal(page.status, 200);
  for (const label of ['무엇을 바꾸나', '새 역할 <b>example-support-triager</b>', '왜 필요한가', '기대 효과', '위험과 완화책', '평가 계획', '성공 기준', '즉시 중단 기준', '최소 관측', '롤백 계획', '만료', '기준 조직 버전', '일반 변경']) {
    assert.ok(page.text.includes(label), `detail shows '${label}'`);
  }
  const approve = /node apps\/daemon\/src\/approve\.ts approve org (\S+) --hash ([0-9a-f]{64})/.exec(page.text);
  assert.ok(approve, 'approve command with a 64-hex hash');
  assert.equal(approve![1], rig.demo.ids.orgNormal);
  assert.ok(page.text.includes(`${CLI} reject org ${rig.demo.ids.orgNormal} --comment`), 'reject command');
  assert.equal(page.text.split(approve![2]!).length - 1, 1, 'the hash appears once, only inside the command');

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

test('risky org proposal: marked as risky with the extra release step; detail for every kind of pending item', async (t) => {
  const rig = await startRig(t);
  const risky = await rig.get(`/approvals/org_proposal/${rig.demo.ids.orgRisky}`);
  assert.ok(risky.text.includes('위험 변경'), 'risky label');
  assert.ok(risky.text.includes('release 가 더 필요하다'), 'risky approval needs release afterwards');
  assert.ok(risky.text.includes('새 부서 <b>sales-ops</b>'), 'a new unit is described');
  const task = await rig.get(`/approvals/task/${rig.demo.ids.task}`);
  assert.equal(task.status, 200);
  assert.ok(task.text.includes('요청한 도구') && task.text.includes('정책 판정') && task.text.includes(`${CLI} approve task ${rig.demo.ids.task} --hash `));
  const publication = await rig.get(`/approvals/publication/${rig.demo.ids.publication}`);
  assert.ok(publication.text.includes(`${CLI} approve publication ${rig.demo.ids.publication} --hash `), 'publication command');
  const strategy = await rig.get(`/approvals/strategy_version/${rig.demo.ids.strategy}`);
  assert.ok(strategy.text.includes(`${CLI} approve strategy ${rig.demo.ids.strategy} --hash `) && strategy.text.includes('주간 뉴스레터'), 'strategy command and title');
  assert.equal((await rig.get('/approvals/org_proposal/nope')).status, 404);
  assert.equal((await rig.get('/approvals/bogus/x')).status, 404);
});

test('trials: chart, live verdict and the next-step commands per state', async (t) => {
  const rig = await startRig(t);
  const page = await rig.get('/trials');
  assert.ok(page.text.includes('<svg class="chart"'), 'inline svg chart');
  assert.ok(page.text.includes('통과율 (시험 vs 시험 전 기준선)') && page.text.includes('관측 수 vs 최소 관측'));
  assert.ok(page.text.includes(`${CLI} org confirm ${rig.demo.ids.orgPass} --comment`), 'pass → confirm');
  assert.ok(page.text.includes(`${CLI} org retrial ${rig.demo.ids.orgInconclusive} --file`), 'inconclusive → retrial');
  assert.ok(page.text.includes('판정 불충분'), 'inconclusive label');
  assert.ok(page.text.includes('3/6 observations'), 'in-progress trial shows observation progress');
  assert.ok(!/NaN|undefined|Infinity/.test(page.text), 'no broken numbers');
  assert.ok(!/<script/i.test(page.text), 'no script');
});

test('signals, products, effects and experiments show the commands to act', async (t) => {
  const rig = await startRig(t);
  const signals = await rig.get('/signals');
  assert.ok(signals.text.includes(`${CLI} org propose --type support-triage --role`), 'propose suggestion for a candidate type');
  assert.ok(!signals.text.includes('--type monthly-digest'), 'below the threshold: no suggestion');
  assert.ok(signals.text.includes('<svg class="chart"'));
  const product = await rig.get(`/products/${rig.demo.ids.productSlug}`);
  assert.ok(/product decide example-product approve --hash [0-9a-f]{64}/.test(product.text), 'decide approve with review hash');
  assert.ok(product.text.includes('product decide example-product reject --comment'));
  for (const label of ['독립 평가 결과', '섀도 판정', '증거 (7)', '사람 검토 대기']) assert.ok(product.text.includes(label), label);
  const effects = await rig.get('/effects');
  assert.ok(effects.text.includes(`resolve-effect ${rig.demo.ids.effect} --outcome confirmed --note`) && effects.text.includes('--outcome failed --note &quot;확인한 내용&quot; --totp-stdin'));
  assert.ok(!effects.text.includes(sha(Buffer.from('demo-request'))) && !effects.text.includes('effect-key-demo-1'), 'no request hash or effect key');
  assert.equal((await rig.get('/experiments')).status, 200);
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
  assert.ok(list.text.includes('외부 입력 — 지시 아님') && list.text.includes('검증됨'));
  assert.ok(!list.text.includes('x'.repeat(24)));
  const internal = await rig.get(`/evidence/${evidence.text}`);
  assert.ok(internal.text.includes('저장소 구조') && !internal.text.includes('class="card untrusted"'), 'internal text is shown without the untrusted frame');
  assert.ok(injected.text.includes('class="card untrusted"'), 'external text is framed as untrusted');
  const url = await rig.get(`/evidence/${evidence.url}`);
  assert.ok(url.text.includes('https://example.com/docs/getting-started') && !url.text.includes('href="https://example.com'), 'external urls are text, never links');
  const png = await rig.get(`/evidence/${evidence.png}`);
  assert.ok(png.text.includes(`<img class="evidence" alt="증거 그림 ${evidence.png}" src="/evidence/${evidence.png}/file">`));
  assert.equal((await rig.get('/evidence?task=%27%20OR%201%3D1%20--')).status, 200, 'query goes through bound parameters');
  assert.ok((await rig.get('/evidence?task=%27%20OR%201%3D1%20--')).text.includes('증거가 없다'), 'injection matches nothing');
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
  assert.ok(svgPage.text.includes('그림이 아닌 파일은 목록만 보이고 내보내지 않는다') && !svgPage.text.includes('<img'));
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
  assert.equal((await rig.get('/evidence/evidence-nohash/file')).status, 200);
  assert.ok((await rig.get('/evidence/evidence-nohash')).text.includes('해시 없음(미확인)'));

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
    const reply = await rig.get('/approvals', { host });
    assert.equal(reply.status, 421, host);
    assert.ok(!reply.text.includes('조직 변경'), 'nothing leaks to a wrong host');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const reply = await rig.get('/approvals', { method });
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers['allow'], 'GET, HEAD');
  }
  const head = await rig.get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);

  const csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  for (const path of ['/', '/approvals', '/nope', `/evidence/${rig.demo.ids.evidence.png}/file`]) {
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
  for (const path of ['/', '/approvals', '/trials', '/signals', '/products', '/effects', '/experiments', '/evidence', `/evidence/${rig.demo.ids.evidence.injected}`]) {
    const html = (await rig.get(path)).text;
    assert.ok(!/<form|<script|<iframe|<link |https?:\/\/[^\s"'<]*\.(js|css|woff2?|png)/i.test(html), `${path} has no forms, scripts or external resources`);
  }
});

test('the database is opened read-only: no write path, and serving every page leaves the file untouched', async (t) => {
  const rig = await startRig(t);
  const before = sha(readFileSync(rig.demo.dbPath));
  const mtime = statSync(rig.demo.dbPath).mtimeMs;
  const paths = ['/', '/approvals', '/trials', '/signals', '/products', `/products/${rig.demo.ids.productSlug}`, '/effects', '/experiments', '/evidence',
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
