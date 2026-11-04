// 검토 화면의 순수 부분: HTML 조립(이스케이프·가리기), 그래프, 그림 형식 판정, 명령줄 인자·위치 결정, Host 판정.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseReviewWebArgs, UsageError, type ConfigDeps } from '../../apps/daemon/src/review-web/config.ts';
import { sniffImage } from '../../apps/daemon/src/review-web/evidence-file.ts';
import { ago, clip, monthDay, percent, until } from '../../apps/daemon/src/review-web/format.ts';
import { choices, command, full, h, prettyJson, raw, shellArg, table, text } from '../../apps/daemon/src/review-web/html.ts';
import { hostAllowed } from '../../apps/daemon/src/review-web/server.ts';
import { barChart, lineChart } from '../../apps/daemon/src/review-web/svg.ts';
import { demoPng } from '../../scripts/review-web-demo.ts';

test('h escapes and masks every interpolated value unless it is already markup', () => {
  const key = `${'sk'}-${'a'.repeat(24)}`;
  assert.equal(h`<p>${'<img src=x onerror=alert(1)>'}</p>`.html, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(h`<p title="${'" onmouseover="x'}">`.html, '<p title="&quot; onmouseover=&quot;x">');
  assert.ok(h`${`token ${key}`}`.html.includes('[REDACTED]') && !h`${key}`.html.includes('aaaa'));
  assert.equal(h`${h`<b>${'<'}</b>`}`.html, '<b>&lt;</b>', 'nested markup is kept, its values were escaped once');
  assert.equal(h`${[h`<i>1</i>`, '<2>', null, false, undefined]}`.html, '<i>1</i>&lt;2&gt;');
  assert.equal(h`${raw('<hr>')}`.html, '<hr>');
  assert.equal(table(['a'], [['<x>']]).html.includes('&lt;x&gt;'), true);
  assert.ok(command('echo "<b>"').html.includes('echo &quot;&lt;b&gt;&quot;'));
  assert.ok(h`${'x'.repeat(10_000)}`.html.length < 4_100, 'long text is cut');
});

test('shellArg leaves plain values and quotes everything else', () => {
  assert.equal(shellArg('org-proposal-abc123'), 'org-proposal-abc123');
  assert.equal(shellArg('a b'), "'a b'");
  assert.equal(shellArg("it's; rm -rf /"), `'it'\\''s; rm -rf /'`);
  assert.equal(shellArg('$(whoami)'), "'$(whoami)'");
});

test('charts never print non-finite numbers and escape labels', () => {
  const bar = barChart('t', [{ label: '<b>', value: Number.NaN }, { label: 'ok', value: Number.POSITIVE_INFINITY }, { label: 'x', value: 0.5 }], { max: 0, ref: { value: Number.NaN, label: 'r' } }).html;
  assert.ok(!/NaN|Infinity|undefined/.test(bar), bar);
  assert.ok(bar.includes('&lt;b&gt;') && bar.includes('자료 없음'));
  const line = lineChart('t', [{ label: 'a', value: 0.2 }, { label: 'b', value: null }, { label: 'c', value: 0.9 }], { max: 1, ref: { value: 0.5, label: 'min' } }).html;
  assert.ok(!/NaN|Infinity|undefined/.test(line) && line.includes('<path'));
  assert.ok(!/NaN/.test(lineChart('t', [], { max: 1 }).html));
});

test('sniffImage identifies only png, jpeg, gif and webp by their leading bytes', () => {
  assert.equal(sniffImage(demoPng()), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')])), 'image/webp');
  for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<!doctype html><script>', '<?xml version="1.0"?><svg/>', 'plain text', '']) assert.equal(sniffImage(Buffer.from(text)), null, text);
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVEfmt ')])), null, 'riff that is not webp');
});

test('hostAllowed accepts exactly 127.0.0.1:<port> and localhost:<port>', () => {
  assert.equal(hostAllowed('127.0.0.1:8787', 8787), true);
  assert.equal(hostAllowed('localhost:8787', 8787), true);
  assert.equal(hostAllowed('LocalHost:8787', 8787), true);
  for (const bad of [undefined, '', '127.0.0.1', 'localhost', '127.0.0.1:8788', 'evil.example:8787', '127.0.0.1:8787.evil.example', '[::1]:8787', '127.0.0.1:8787, evil.example', ' 127.0.0.1:8787']) {
    assert.equal(hostAllowed(bad, 8787), false, String(bad));
  }
});

const deps = (files: Record<string, string>, env: Record<string, string> = {}): ConfigDeps => ({ env, readText: (path) => files[path] });

test('review-web args: the daemon config supplies db, policy and evidence locations; flags win', () => {
  const config = JSON.stringify({ db_path: '/data/aot.db', instance_dir: '/data/inst', policy_store_dir: '/data/pol', registration_tools: { evidence_dir: '/data/ev' } });
  const fromConfig = parseReviewWebArgs(['--config', '/c.json'], deps({ '/c.json': config }));
  assert.deepEqual(fromConfig, { dbPath: '/data/aot.db', port: 8787, host: '127.0.0.1', policyStoreDir: '/data/pol', evidenceDir: '/data/ev', evidenceRoots: [] });
  const env = parseReviewWebArgs([], deps({ '/env/daemon.config.json': JSON.stringify({ db_path: '/e.db' }) }, { AOT_INSTANCE_DIR: '/env' }));
  assert.equal(env.evidenceDir, '/env/evidence');
  assert.equal(env.policyStoreDir, '/env/policies');
  const viaEnvConfig = parseReviewWebArgs([], deps({ '/x.json': config }, { AOT_DAEMON_CONFIG: '/x.json' }));
  assert.equal(viaEnvConfig.dbPath, '/data/aot.db');
  const flags = parseReviewWebArgs(['--config', '/c.json', '--db', '/o.db', '--port', '0', '--evidence-dir', '/ed', '--policy-dir', '/pd', '--evidence-root', '/r1', '--evidence-root', '/r2'], deps({ '/c.json': config }));
  assert.deepEqual(flags, { dbPath: '/o.db', port: 0, host: '127.0.0.1', policyStoreDir: '/pd', evidenceDir: '/ed', evidenceRoots: ['/r1', '/r2'] });
});

test('review-web args: --db alone puts the instance folder next to the database; bad input is a usage error', () => {
  const alone = parseReviewWebArgs(['--db', 'instance/demo/review.db'], deps({}));
  assert.equal(alone.evidenceDir, 'instance/demo/evidence');
  assert.equal(alone.policyStoreDir, 'instance/demo/policies');
  const bad = (args: string[], pattern: RegExp, files: Record<string, string> = {}): void => assert.throws(() => parseReviewWebArgs(args, deps(files)), (error: unknown) => error instanceof UsageError && pattern.test(error.message), args.join(' '));
  bad([], /database is unknown/);
  bad(['--db', 'a.db', '--host', '0.0.0.0'], /only on 127\.0\.0\.1/);
  bad(['--db', 'a.db', '--host', 'localhost'], /only on 127\.0\.0\.1/);
  bad(['--db', 'a.db', '--port', '99999'], /--port/);
  bad(['--db', 'a.db', '--port', 'abc'], /--port/);
  bad(['--db', 'a.db', '--bogus', 'x'], /unknown option/);
  bad(['--db'], /needs a value/);
  bad(['--db', 'a.db', 'extra'], /unexpected argument/);
  bad(['--db', 'a.db', '--db', 'b.db'], /once/);
  bad(['--config', '/missing.json'], /not found/);
  bad(['--config', '/c.json'], /not an object|Unexpected|JSON/, { '/c.json': '[1]' });
});

test('text masks before it cuts, and says when it cut', () => {
  const key = `${'sk'}-${'b'.repeat(30)}`;
  const straddle = text(`${'a'.repeat(3_995)} ${key}`, 4_000);
  assert.ok(!straddle.includes('sk-b') && !straddle.includes('bbbb'), 'no secret prefix survives the cut');
  assert.ok(text('x'.repeat(5_000)).includes('이하 생략: 전체 5000자 중 4000자만 보인다'));
  assert.ok(!text('short').includes('생략'));
  assert.ok(full('y'.repeat(30_000)).html.length > 29_000 && !full('y'.repeat(30_000)).html.includes('생략'));
  assert.ok(text('z'.repeat(50), 10, false).endsWith('…') && !text('z'.repeat(50), 10, false).includes('생략'));
  const label = barChart('t', [{ label: `${'q'.repeat(8)} ${key}`, value: 1 }], { max: 1 }).html;
  assert.ok(!label.includes('sk-b') && !label.includes('bbbb'), 'svg labels are masked before they are cut');
});

test('prettyJson masks by key name (maskSecrets) before printing', () => {
  const out = prettyJson({ verdict: 'ok', password: 'hunter2-value', nested: [{ api_token: 'abc-value', count: 3 }] });
  assert.ok(!out.includes('hunter2-value') && !out.includes('abc-value') && out.includes('"count": 3') && out.includes('[REDACTED]'));
});

test('format: relative Korean dates, short text and percentages', () => {
  const now = Date.parse('2026-11-04T03:00:00.000Z');
  assert.equal(until('2026-11-17T03:00:00.000Z', now), '13일 뒤 만료');
  assert.equal(until('2026-11-04T10:00:00.000Z', now), '오늘 만료');
  assert.equal(until('2026-11-05T03:00:00.000Z', now), '내일 만료');
  assert.equal(until('2026-11-03T03:00:00.000Z', now), '만료됨');
  assert.equal(until('2026-11-15T03:00:00.000Z', now, '판정'), '11일 뒤 판정');
  assert.equal(ago('2026-11-01T03:00:00.000Z', now), '3일 전');
  assert.equal(ago('2026-11-03T03:00:00.000Z', now), '어제');
  assert.equal(ago('2026-11-04T01:00:00.000Z', now), '오늘');
  assert.equal(monthDay('2026-11-17T03:00:00.000Z'), '11월 17일');
  assert.equal(clip('가'.repeat(50), 40).length, 40);
  assert.equal(clip('a\n  b', 40), 'a b');
  assert.equal(percent(0.8), '80%');
  assert.equal(percent(null), '-');
  assert.equal(until('not a date', now), '-');
});

test('choices: approve and reject boxes, or the reason when approval is not possible', () => {
  const both = choices({ approve: { command: 'cmd-a' }, reject: { command: 'cmd-r' } }).html;
  assert.ok(both.indexOf('승인') < both.indexOf('cmd-a') && both.indexOf('cmd-a') < both.indexOf('거절') && both.indexOf('거절') < both.indexOf('cmd-r'));
  const blocked = choices({ approve: { blocked: '<b>만료됨</b>' }, reject: { command: 'cmd-r' } }).html;
  assert.ok(blocked.includes('승인할 수 없습니다') && blocked.includes('&lt;b&gt;만료됨') && !blocked.includes('<code>cmd-a'));
  assert.ok(!choices({ reject: { command: 'x' } }).html.includes('승인'));
});
