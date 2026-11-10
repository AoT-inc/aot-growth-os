// 읽기 전용 현황 화면 (/now /org /sites /cost): 렌더링, 빈 DB, 숨길 것(이메일·비밀 모양·초안 본문·금액), 인증, 상태를 바꾸는 경로 없음.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Db } from '@aot/domain';

import { SECURITY_HEADERS } from '../../apps/daemon/src/review-web/server.ts';
import { NOW_MS, startRig } from '../support/review-web.ts';
import { httpSiteRaw } from '../support/mcp.ts';

const PAGES = ['/now', '/org', '/sites', '/cost'] as const;
const textOf = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const firstLevel = (html: string): string => textOf(html.replace(/<details[\s\S]*?<\/details>/g, ''));
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const firstTask = (db: Db): string => db.get<{ id: string }>('SELECT id FROM task ORDER BY id LIMIT 1')!.id;
const iso = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

test('each page renders in a readable layout and only /now and /cost refresh themselves', async (t) => {
  const rig = await startRig(t);
  for (const path of PAGES) {
    const reply = await rig.get(path);
    assert.equal(reply.status, 200, path);
    const refresh = /<meta http-equiv="refresh" content="(\d+)">/.exec(reply.text);
    if (path === '/now' || path === '/cost') assert.equal(refresh?.[1], '30', `${path} refreshes every 30 seconds`);
    else assert.equal(refresh, null, `${path} does not refresh`);
    assert.ok(!/<script/i.test(reply.text), 'no script');
    assert.equal(reply.headers['content-security-policy'], SECURITY_HEADERS['Content-Security-Policy'], 'the same CSP as every other page (meta refresh needs no CSP change)');
    assert.match(reply.text, /<nav>.*\/now.*\/org.*\/sites.*\/cost/s);
  }
});

test('/now leads with four numbers, then running work, blocked work and recent completions; the refresh time is shown', async (t) => {
  const rig = await startRig(t, {
    before: (db) => {
      const id = firstTask(db);
      db.writeTx((tx) => {
        tx.run("UPDATE task SET status = 'running', updated_at = ? WHERE id = ?", [iso(-1000), id]);
        tx.run("INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, lease_owner, lease_expires_at, heartbeat_at) SELECT 'run-now-1', ?, 99, (SELECT id FROM actor WHERE kind='agent' LIMIT 1), 'fake-adapter', ?, 'w', ?, ?", [id, iso(-90 * 60_000), iso(60_000), iso(0)]);
      });
    },
  });
  const reply = await rig.get('/now');
  const body = reply.text;
  assert.equal((body.match(/<b class="n">/g) ?? []).length, 4, 'exactly four big numbers');
  const text = firstLevel(body);
  for (const label of ['결정할 일', '진행 중', '막힌 일', '한도로 멈춤']) assert.ok(text.includes(label), label);
  assert.ok(text.includes('진행 중인 업무') && text.includes('막힌 일') && text.includes('최근 완료'));
  assert.ok(text.includes('실행 중') && text.includes('시작 후 1시간 30분'), 'running task shows its role/status/elapsed time');
  assert.ok(text.includes('갱신 21:00:00'), 'refresh time in Korean time');
  assert.ok(text.includes('한도에 닿아 멈춘 업무는 없습니다'));
  assert.ok(!/run-now-1|task-[0-9a-f]{6}/.test(firstLevel(body)), 'ids stay inside the folded details');
});

test('a task stopped by the subscription limit is counted and labelled in words', async (t) => {
  const rig = await startRig(t, {
    before: (db) => {
      const id = firstTask(db);
      db.writeTx((tx) => {
        tx.run("UPDATE task SET status = 'needs_review' WHERE id = ?", [id]);
        tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [id, 'running', 'needs_review', 'run r killed: review_required: usage_limit: the subscription usage limit was reached', 'system:scheduler', iso(-1000)]);
      });
    },
  });
  const text = firstLevel((await rig.get('/now')).text);
  assert.match(text, /한도에 닿아 멈춘 업무가 1건 있습니다/);
  assert.match(text, /한도로 멈춤 · /);
  assert.ok(/<b class="n">1<\/b><span class="l">한도로 멈춤/.test((await rig.get('/now')).text));
});

test('/org lists departments with role stage and the number of tools each role can ask for', async (t) => {
  const rig = await startRig(t);
  const text = firstLevel((await rig.get('/org')).text);
  assert.match(text, /부서 \d+곳, 역할 \d+개/);
  assert.ok(/사용 중|시험 중|제안됨/.test(text) && /\d+개/.test(text) && text.includes('열린 도구'));
  assert.ok(!/\bslug\b|org-unit-/.test(text));
});

test('/sites without a daemon config says what is unknown instead of inventing a state', async (t) => {
  const rig = await startRig(t);
  const text = firstLevel((await rig.get('/sites')).text);
  assert.match(text, /상태 확인 불가/);
  assert.match(text, /데몬이 읽기 응답을 내야 합니다/);
  assert.match(text, /사이트 선언이 없습니다/);
});

test('/sites lists declared tools, never the server address, and shows the last outside call', async (t) => {
  const rig = await startRig(t, {
    mcpSites: [httpSiteRaw('https://mcp.course.example.com/mcp')],
    before: (db) => {
      const id = firstTask(db);
      const runId = db.get<{ id: string }>('SELECT id FROM task_run ORDER BY id LIMIT 1')!.id;
      db.writeTx((tx) => tx.run(
        "INSERT INTO external_effect (id, effect_key, task_id, task_run_id, tool, action, target, request_hash, state, supports_idempotency, planned_at, at) VALUES ('eff-x', 'key-x', ?, ?, 'mcp_course_update_unit', 'call', 'site:course/units', 'h', 'confirmed', 0, ?, ?)", [id, runId, iso(-3600_000), iso(-3600_000)],
      ));
    },
  });
  const reply = await rig.get('/sites');
  const text = firstLevel(reply.text);
  assert.match(text, /선언한 사이트 1곳, 도구 2개/);
  assert.ok(text.includes('search_units') && text.includes('update_unit') && text.includes('읽기만 함') && text.includes('초안 승인 필요'));
  assert.match(text, /1번/);
  assert.ok(!reply.text.includes('mcp.course.example.com') && !reply.text.includes('AOT_MCP_COURSE_TOKEN'), 'no address, no env names');
  assert.ok(reply.text.includes('sha256:'), 'the schema hash is in the folded details');
  assert.ok(!firstLevel(reply.text).includes('sha256:'));
});

test('/sites with a broken declaration shows a plain sentence, not the parser message', async (t) => {
  const rig = await startRig(t, { mcpSites: [{ site: 'x' }] });
  const text = firstLevel((await rig.get('/sites')).text);
  assert.match(text, /사이트 선언을 읽지 못했습니다/);
});

test('/cost shows weekly tokens by role and task, the last seen utilization, deferred runs, and always the unconfirmed-terms notice, never money', async (t) => {
  let logDir = '';
  const rig = await startRig(t, {
    runLogDir: (demo) => {
      logDir = join(demo.dir, 'run-logs');
      return logDir;
    },
    before: (db, demo) => {
      const id = firstTask(db);
      db.writeTx((tx) => {
        tx.run("INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES ('c-tok-1', ?, NULL, NULL, 'llm', 7.77, '{\"tokens\":1200}', ?)", [id, iso(-3600_000)]);
        tx.run("INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES ('c-tok-2', ?, NULL, NULL, 'llm', 0, '{\"tokens\":300}', ?)", [id, iso(-2 * 3600_000)]);
        tx.run("INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES ('c-old', ?, NULL, NULL, 'llm', 0, '{\"tokens\":999999}', ?)", [id, iso(-30 * 86_400_000)]);
        tx.run("INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES ('c-bad', ?, NULL, NULL, 'llm', 0, 'not json', ?)", [id, iso(-3600_000)]);
        tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [id, 'running', 'retry_wait', 'run r killed: deferred: usage_deferred: yield', 'system:scheduler', iso(-1000)]);
        mkdirSync(join(demo.dir, 'run-logs'), { recursive: true });
        writeFileSync(join(demo.dir, 'run-logs', 'run-cost-1.jsonl'), `${JSON.stringify({ at: iso(-600_000), message: 'usage_warning: the subscription window utilization reached 0.83 (warning threshold 0.8)' })}\n`);
        tx.run("INSERT INTO task_run (id, task_id, attempt, actor_id, adapter, started_at, lease_owner, lease_expires_at, heartbeat_at, run_log_ref, outcome) SELECT 'run-cost-1', ?, 98, (SELECT id FROM actor WHERE kind='agent' LIMIT 1), 'fake-adapter', ?, 'w', ?, ?, 'run-log:run-cost-1', 'submitted'", [id, iso(-700_000), iso(0), iso(0)]);
      });
    },
  });
  const reply = await rig.get('/cost');
  const text = firstLevel(reply.text);
  assert.match(text, /최근 7일 동안 1,500 토큰을 썼습니다/, 'old and unreadable entries are not counted');
  assert.ok(text.includes('1,500 토큰'));
  assert.match(text, /83%/);
  assert.match(text, /미뤄진 실행/);
  assert.match(text, /약관 미확인/);
  assert.match(text, /금액은 계산하지 않습니다/);
  assert.ok(!/USD|\$|달러|7\.77/.test(reply.text), 'no money is shown or derived');
  assert.ok(/<b class="n">1<\/b><span class="l">미뤄진 실행/.test(reply.text));
});

test('/cost with no run logs says it does not know the utilization; the terms notice is still there', async (t) => {
  const rig = await startRig(t, { empty: true });
  const text = firstLevel((await rig.get('/cost')).text);
  assert.match(text, /확인 불가/);
  assert.match(text, /약관 미확인/);
  assert.match(text, /기록된 토큰이 없습니다/);
});

test('an empty database renders every status page without error', async (t) => {
  const rig = await startRig(t, { empty: true });
  const now = firstLevel((await rig.get('/now')).text);
  assert.ok(now.includes('지금 진행 중인 업무가 없습니다') && now.includes('막힌 업무가 없습니다') && now.includes('아직 완료된 업무가 없습니다'));
  for (const path of PAGES) assert.equal((await rig.get(path)).status, 200, path);
});

test('nothing secret-shaped, no e-mail address and no draft body reaches the status pages', async (t) => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345';
  const rig = await startRig(t, {
    before: (db) => {
      const id = firstTask(db);
      db.writeTx((tx) => {
        tx.run("UPDATE task SET objective = ?, status = 'running' WHERE id = ?", [`고객 kim@example.com 에게 ${secret} 로 연락`, id]);
        tx.run("UPDATE role SET description = 'owner@example.org 에게 문의' WHERE id = (SELECT id FROM role LIMIT 1)");
      });
    },
  });
  const drafts = rig.db.all<{ payload: string }>('SELECT payload FROM effect_draft');
  assert.ok(drafts.length > 0, 'the demo has drafts to check against');
  for (const path of PAGES) {
    const reply = await rig.get(path);
    assert.ok(!reply.text.includes(secret) && !reply.text.includes('sk-ant'), `${path}: secret shape`);
    assert.ok(!EMAIL.test(textOf(reply.text)), `${path}: e-mail address`);
    for (const draft of drafts) {
      const addresses = draft.payload.match(new RegExp(EMAIL.source, 'g')) ?? [];
      for (const address of addresses) assert.ok(!reply.text.includes(address), `${path}: draft address`);
    }
  }
  assert.ok(firstLevel((await rig.get('/now')).text).includes('(메일 주소 가림)'));
});

test('status pages need the cookie: without it they are refused and show nothing', async (t) => {
  const rig = await startRig(t);
  for (const path of PAGES) {
    const reply = await rig.get(path, { cookie: null });
    assert.equal(reply.status, 401, path);
    assert.ok(!reply.text.includes('결정할 일') || reply.text.includes('인증이 필요'), 'no data');
    assert.ok(!/<b class="n">/.test(reply.text));
    assert.equal((await rig.get(path, { host: 'evil.example:80' })).status, 421, `${path}: bad Host`);
  }
});

test('the status pages have no way to change anything: no forms or buttons, writes are refused, and the database is unchanged', async (t) => {
  const rig = await startRig(t);
  const before = rig.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM task_transition) + (SELECT COUNT(*) FROM approval) + (SELECT COUNT(*) FROM cost_entry) AS n')!.n;
  for (const path of PAGES) {
    const reply = await rig.get(path);
    assert.ok(!/<form|<button|<input|<textarea|type="submit"/i.test(reply.text), `${path}: no controls`);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await rig.get(path, { method })).status, 405, `${path} ${method}`);
  }
  const after = rig.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM task_transition) + (SELECT COUNT(*) FROM approval) + (SELECT COUNT(*) FROM cost_entry) AS n')!.n;
  assert.equal(after, before);
});

test('the status source reads only: no write SQL in status.ts', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(join(import.meta.dirname, '../../apps/daemon/src/review-web/status.ts'), 'utf8');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b\s/.test(source.replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|`[^`]*`/g, (m) => (/^[`']\s*(SELECT|WITH)/i.test(m) ? m : ''))), 'no write statements');
  assert.ok(!/\.writeTx|\.run\(/.test(source));
});

// ----- 검사 반영 -----
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345';

test('a secret that straddles the 60-character cut is masked before cutting, so no prefix of it is shown', async (t) => {
  for (const pad of [40, 45, 50, 55, 58, 60]) {
    const rig = await startRig(t, {
      before: (db) => {
        const id = firstTask(db);
        db.writeTx((tx) => tx.run("UPDATE task SET objective = ?, status = 'running' WHERE id = ?", [`${'가'.repeat(pad)} ${SECRET}`, id]));
      },
    });
    for (const path of ['/now', '/cost']) {
      const body = (await rig.get(path)).text;
      assert.ok(!body.includes('sk-ant') && !body.includes('sk-a…') && !/sk-ant-?a?p?i?0?3?-?a/.test(body), `${path} pad ${pad}: no secret prefix`);
    }
  }
});

test('markup in task goals, role names, role descriptions and department names is escaped on every status page', async (t) => {
  const rig = await startRig(t, {
    before: (db) => {
      const id = firstTask(db);
      db.writeTx((tx) => {
        tx.run("UPDATE task SET objective = ?, status = 'running' WHERE id = ?", ['<script>alert(1)</script>"><img src=x onerror=alert(2)>', id]);
        tx.run("UPDATE role SET description = ? WHERE id = (SELECT id FROM role ORDER BY created_at LIMIT 1)", ['<script>alert(3)</script>']);
        tx.run("UPDATE role SET slug = ? WHERE id = (SELECT id FROM role ORDER BY created_at LIMIT 1)", ['<img src=x onerror=alert(4)>']);
        tx.run("UPDATE org_unit SET name = ?", ['<script>alert(5)</script>']);
        tx.run("INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES ('c-xss', ?, NULL, NULL, 'llm', 0, '{\"tokens\":5}', ?)", [id, iso(-1000)]);
      });
    },
  });
  for (const path of ['/now', '/org', '/cost']) {
    const body = (await rig.get(path)).text.replace(/<style>[\s\S]*?<\/style>/g, '');
    assert.ok(!/<script|<img/i.test(body), `${path}: no live tag`);
    assert.ok(!/ onerror=/.test(body.replace(/&lt;[^&]*&gt;/g, '')), `${path}: no live attribute`);
  }
  assert.ok((await rig.get('/now')).text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'shown as text');
  assert.ok((await rig.get('/org')).text.includes('&lt;script&gt;alert(5)&lt;/script&gt;'));
});

test('no sentence of any draft body reaches a status page', async (t) => {
  const rig = await startRig(t);
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { if (value.length >= 6) strings.push(value); } else if (Array.isArray(value)) value.forEach(walk); else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const row of rig.db.all<{ payload: string }>('SELECT payload FROM effect_draft')) walk(JSON.parse(row.payload));
  // 업무 목표는 화면에 나와도 되는 글이다: 초안 제목이 목표와 같으면 거기서 온 것으로 본다
  const objectives = rig.db.all<{ objective: string }>('SELECT objective FROM task').map((r) => r.objective);
  const draftOnly = strings.filter((piece) => !objectives.some((o) => o.includes(piece)));
  assert.ok(draftOnly.length > 5, 'the demo drafts have text to look for');
  for (const path of PAGES) {
    const text = textOf((await rig.get(path)).text);
    for (const piece of draftOnly) assert.ok(!text.includes(piece.replace(/\s+/g, ' ').trim()), `${path}: draft text '${piece.slice(0, 20)}'`);
  }
});

test('/org shows the exact stage and tool count of the demo roles', async (t) => {
  const rig = await startRig(t);
  const text = firstLevel((await rig.get('/org')).text);
  assert.match(text, /generalist .*?사용 중 2개/);
  assert.match(text, /registration-verifier .*?사용 중 3개/);
  assert.match(text, /example-analyst .*?시험 중 1개/);
});

test('the seven-day window includes exactly -7 days and excludes older entries; one deferred run counts once however many rows it has', async (t) => {
  const rig = await startRig(t, {
    before: (db) => {
      const id = firstTask(db);
      const week = 7 * 86_400_000;
      db.writeTx((tx) => {
        const cost = (key: string, tokens: number, at: string): void => void tx.run("INSERT INTO cost_entry (id, task_id, task_run_id, product_id, category, amount_usd, units, at) VALUES (?, ?, NULL, NULL, 'llm', 0, ?, ?)", [key, id, JSON.stringify({ tokens }), at]);
        cost('b-in', 100, iso(-week));
        cost('b-out', 1000, iso(-week - 1));
        const move = (run: string, at: string): void => void tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [id, 'running', 'retry_wait', `run ${run} killed: deferred: usage_deferred: yield`, 'system:scheduler', at]);
        move('run-a', iso(-1000));
        move('run-a', iso(-900));
        move('run-b', iso(-week));
        move('run-c', iso(-week - 1));
      });
    },
  });
  const cost = await rig.get('/cost');
  assert.match(firstLevel(cost.text), /최근 7일 동안 100 토큰을 썼습니다/);
  assert.ok(/<b class="n">2<\/b><span class="l">미뤄진 실행/.test(cost.text), 'run-a once + run-b at the boundary; run-c is too old');
});

test('role and site names pass through the same hiding as other text', async (t) => {
  const rig = await startRig(t, {
    before: (db) => db.writeTx((tx) => {
      tx.run("UPDATE role SET slug = 'kim@example.com' WHERE id = (SELECT id FROM role ORDER BY created_at LIMIT 1)");
    }),
  });
  assert.ok(!EMAIL.test(textOf((await rig.get('/org')).text)));
});

test('status pages never say decisions are made with buttons on this screen, even when decisions are enabled elsewhere', async (t) => {
  const { startWriteRig } = await import('../support/review-web-write.ts');
  const rig = await startWriteRig(t);
  const home = await rig.get('/');
  assert.match(home.text, /결정은 이 화면의 버튼으로 합니다/, 'the decision pages keep their banner');
  for (const path of PAGES) {
    const body = (await rig.get(path)).text;
    assert.ok(!body.includes('버튼으로 합니다'), path);
    assert.ok(body.includes('이 화면은 보기만 하는 화면입니다'), path);
  }
});
