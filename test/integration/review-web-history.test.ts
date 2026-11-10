// 결정 상세의 이력 요약 (설계 §2.2): 어떻게 왔나 · 앞선 결정 · 링크, 최대 3줄. 외부 URL 은 사람이 입력한 주소만 링크다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Db } from '@aot/domain';

import { safeHttpUrl } from '../../apps/daemon/src/review-web/history.ts';
import { draftRowFor, insertDraftRow } from '../support/drafts.ts';
import { startWriteRig } from '../support/review-web-write.ts';

const textOf = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const histOf = (html: string): string[] => [...(/<ul class="hist">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '').matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]!).trim());
const insertApproval = (db: Db, id: string, taskId: string, decision: string, comment: string | null, at: string): void => {
  db.writeTx((tx) => tx.run("INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES (?, 'task', ?, ?, NULL, 'actor-owner', ?, ?)", [id, taskId, decision, comment, at]));
};

test('history: how the item came, with at most three lines and internal links', async (t) => {
  const rig = await startWriteRig(t);
  const page = await rig.get(`/approvals/task/${rig.demo.ids.task}`);
  const lines = histOf(page.text);
  assert.ok(lines.length >= 1 && lines.length <= 3, String(lines.length));
  assert.match(lines[0]!, /^(오늘|어제|\d+일 전) 오너가 직접 만듦$/);
  // 사실 줄 다음, 본문·버튼 앞에 놓인다
  assert.ok(page.text.indexOf('class="facts"') < page.text.indexOf('class="hist"') && page.text.indexOf('class="hist"') < page.text.indexOf('결정하기'));
  // 첫 화면 규칙: id·해시·ISO 시각이 없다
  assert.ok(!/[0-9a-f]{64}|\d{4}-\d\d-\d\dT\d\d|task-[0-9a-f]{6}/.test(lines.join(' ')), lines.join(' | '));
  // 카드(홈)에는 이력을 더하지 않는다
  assert.ok(!(await rig.get('/')).text.includes('class="hist"'));
});

test('history: earlier decisions, draft rounds and failed runs are said in one line; links stay inside the screen', async (t) => {
  const rig = await startWriteRig(t, {
    before: (db, demo) => {
      const taskId = demo.ids.task;
      insertApproval(db, 'approval-h1', taskId, 'changes_requested', '인사말을 짧게', '2026-11-03T01:00:00.000Z');
      insertApproval(db, 'approval-h2', taskId, 'rejected', null, '2026-11-03T02:00:00.000Z');
      db.writeTx((tx) => tx.run("INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, ended_at, lease_owner, lease_expires_at, heartbeat_at, outcome) SELECT 'run-h-fail', task_id, 90, actor_id, adapter, started_at, started_at, lease_owner, lease_expires_at, heartbeat_at, 'error' FROM task_run WHERE task_id = ? LIMIT 1", [taskId]));
      insertDraftRow(db, draftRowFor(taskId, 'run-h-fail', { seq: 9, state: 'superseded' }));
      db.writeTx((tx) => tx.run("INSERT INTO evidence (id, task_id, kind, ref, trust_origin, captured_at, verified) VALUES ('evidence-h1', ?, 'document', 'blob:sha256:none', 'internal', '2026-11-03T00:00:00.000Z', 1)", [taskId]));
    },
  });
  const page = await rig.get(`/approvals/task/${rig.demo.ids.task}`);
  const lines = histOf(page.text);
  assert.equal(lines.length, 3, lines.join(' | '));
  assert.ok(lines[1]!.includes("다시 쓰게 1번('인사말을 짧게'), 지금 초안이 2번째") && lines[1]!.includes('한 번 거절된 뒤 다시 제안됨') && lines[1]!.includes('실행 '), lines[1]);
  assert.match(lines[1]!, /실행 \d+번 중 1번 실패/);
  const hist = /<ul class="hist">([\s\S]*?)<\/ul>/.exec(page.text)![1]!;
  const hrefs = [...hist.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(hrefs.some((h) => h.startsWith('/evidence?task=')) && hrefs.every((h) => h.startsWith('/')), hrefs.join(' '));
  assert.ok(lines[2]!.includes('증거 1건'), lines[2]);
});

test('history: only URLs a person entered become external links, and only http(s); agent-supplied URLs stay text', async (t) => {
  const rig = await startWriteRig(t, {
    before: (db, demo) => {
      db.writeTx((tx) => {
        tx.run("UPDATE task SET product_id = 'product-demo-1' WHERE id = ?", [demo.ids.task]);
        tx.run("UPDATE product_repo SET remote_url = 'https://git.example.com/acme/shop' WHERE id = 'repo-demo-1'");
        tx.run("INSERT INTO product_environment (id, product_id, name, url, access_class) VALUES ('env-h1', 'product-demo-1', 'staging', 'https://staging.example.com/', 'restricted')");
        tx.run("INSERT INTO product_environment (id, product_id, name, url, access_class) VALUES ('env-h2', 'product-demo-1', 'production', 'javascript:alert(1)', 'restricted')");
        tx.run("INSERT INTO product_environment (id, product_id, name, url, access_class) VALUES ('env-h3', 'product-demo-1', 'local', 'https://user:pass@evil.example/', 'restricted')");
      });
    },
  });
  const page = await rig.get(`/approvals/task/${rig.demo.ids.task}`);
  const hist = /<ul class="hist">([\s\S]*?)<\/ul>/.exec(page.text)![1]!;
  assert.ok(hist.includes('<a href="https://git.example.com/acme/shop" target="_blank" rel="noopener noreferrer">저장소 열기</a>'), hist);
  assert.ok(hist.includes('href="https://staging.example.com/"') && hist.includes('시험 환경 열기'));
  assert.ok(!hist.includes('javascript:') && !hist.includes('evil.example'), 'unsafe schemes and credentials are not linked');
  assert.ok(hist.includes('href="/products/example-product"'));
  // 에이전트·외부 입력에서 온 URL(증거의 출처 주소)은 글자일 뿐 링크가 아니다
  const evidence = await rig.get(`/evidence/${rig.demo.ids.evidence.url}`);
  assert.equal(evidence.status, 200);
  assert.ok(!/<a [^>]*href="https?:/.test(evidence.text), 'no external link on the evidence page');
  const list = await rig.get('/evidence');
  assert.ok(!/<a [^>]*href="https?:/.test(list.text));
  // 정책 판정 등 다른 화면에도 외부 링크가 새지 않는다
  assert.ok(!/<a [^>]*href="https?:/.test((await rig.get(`/approvals/task/${rig.demo.ids.plainTask}`)).text));
});

test('safeHttpUrl accepts plain http(s) addresses only', () => {
  assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHttpUrl('http://example.com'), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.com', '//example.com', 'example.com', 'https://u:p@example.com/', 'https://exa mple.com', 'https://example.com/"onmouseover="x', '', null, 5, `https://example.com/${'a'.repeat(300)}`]) assert.equal(safeHttpUrl(bad), null, String(bad));
});
