// 독립 검토 반영(H2, M2, L2, L4, L6)의 회귀 시험: 실제 커넥터 프로세스 + 가짜 서버. 네트워크 없음.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FLOOD_COUNT } from '../fixtures/mcp/fake-server.ts';
import {
  callsTo, connectorConfig, FAKE_SERVER, isAlive, readRecords, SEARCH_TOOL, startConnector, startStdioSite, stdioSiteRaw, stdioTransport, TOKEN_ENV, UPDATE_TOOL, waitFor,
} from '../support/mcp.ts';
import { makeTempDir } from '../support/temp.ts';

const listCalls = (path: string) => readRecords(path).filter((r) => r.method === 'tools/list');

test('H2/M2: a server flooding notices and requests gets at most 20 replies and 5 notices per minute; list_changed is passed on at most about once a second', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const c = startConnector(t, connectorConfig({ transport: stdioTransport('floods', record), env_from: { MCP_TOKEN: TOKEN_ENV } }));
  const listed = await c.ask({ op: 'list' });
  assert.equal(listed['ok'], true);
  const searched = await c.ask({ op: 'call', tool: 'units_search', arguments: { query: 'a' } });
  assert.equal(searched['ok'], true);
  // 서버가 보낸 FLOOD_COUNT*2 개 요청 중 분당 20개에만 답했다
  const replies = readRecords(record).filter((r) => typeof r.id === 'string' && String(r.id).startsWith('flood-'));
  assert.ok(replies.length <= 20, `replies: ${replies.length} of ${FLOOD_COUNT * 2}`);
  assert.ok(c.notices().filter((n) => n['type'] === 'server_request_refused').length <= 5);
  assert.ok(c.notices().filter((n) => n['type'] === 'list_changed').length <= 3, 'debounced');
});

test('H2/M2 at the site: the flood does not make the host list again and again, and events stay few', async (t) => {
  const dir = makeTempDir(t);
  const site = await startStdioSite(t, 'floods', { raw: stdioSiteRaw('floods', join(dir, 'r.jsonl'), {}) });
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(listCalls(site.recordPath).length <= 4, `tools/list requests: ${listCalls(site.recordPath).length}`);
  assert.ok(site.events.filter((e) => e.type === 'server_request_refused').length <= 5);
  assert.deepEqual(site.client.stateOf(UPDATE_TOOL), { status: 'open' });
  assert.equal(await site.client.refresh({ timeoutMs: 5000 }), true, 'a pre-send style refresh is not stuck behind a backlog');
});

test('L2: a server listing a tool name twice has that tool closed (duplicate)', async (t) => {
  const site = await startStdioSite(t, 'dup_tools');
  assert.deepEqual(site.client.stateOf(SEARCH_TOOL), { status: 'closed', reason: 'duplicate' });
  assert.deepEqual(site.client.stateOf(UPDATE_TOOL), { status: 'open' });
});

test('L6: concurrent lists share one request to the server; a cancelled list is answered at once and stops; the next list asks again', async (t) => {
  const record = join(makeTempDir(t), 'r.jsonl');
  const c = startConnector(t, connectorConfig({ transport: stdioTransport('hangs_list', record) }));
  const first = c.ask({ op: 'list' });  // id 1
  const second = c.ask({ op: 'list' }); // id 2
  await waitFor(() => listCalls(record).length === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(listCalls(record).length, 1, 'two waiting lists, one request to the server');
  assert.equal((await c.ask({ op: 'cancel', target_id: 1 }))['ok'], true); // id 3
  const cancelled = await first;
  assert.equal(cancelled['error'].code, 'aborted');
  assert.equal((await c.ask({ op: 'cancel', target_id: 2 }))['ok'], true); // id 4
  assert.equal((await second)['error'].code, 'aborted');
  c.ask({ op: 'list' }).catch(() => undefined); // 서버가 답하지 않으므로 시험이 끝나면 하네스가 정리한다
  await waitFor(() => listCalls(record).length === 2);
});

test('L4: the stdio MCP server process is gone after close and after the connector is killed (no orphan)', async (t) => {
  const dir = makeTempDir(t);
  const readPid = (file: string): number => Number(readFileSync(file, 'utf8'));
  const stray: number[] = [];
  t.after(() => { for (const pid of stray) try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 없음 */ } });

  // (a) 사이트 연결 close
  const pidA = join(dir, 'a.pid');
  const site = await startStdioSite(t, 'normal', { raw: stdioSiteRaw('normal', join(dir, 'a.jsonl'), { transport: { kind: 'stdio', command: process.execPath, args: [FAKE_SERVER, 'normal', join(dir, 'a.jsonl'), pidA] } }) });
  const a = readPid(pidA);
  stray.push(a);
  assert.equal(isAlive(a), true);
  await site.client.close();
  await waitFor(() => !isAlive(a), 5000);

  // (b) 커넥터가 강제로 죽었을 때 (호스트가 줄 상한 초과 등으로 죽이는 경로와 같은 kill)
  const pidB = join(dir, 'b.pid');
  const c = startConnector(t, connectorConfig({ transport: { kind: 'stdio', command: process.execPath, args: [FAKE_SERVER, 'normal', join(dir, 'b.jsonl'), pidB] } }));
  assert.equal((await c.ask({ op: 'list' }))['ok'], true);
  const b = readPid(pidB);
  stray.push(b);
  assert.equal(isAlive(b), true);
  c.link.kill();
  await waitFor(() => !isAlive(b), 5000);
  assert.equal(callsTo(join(dir, 'b.jsonl')).length, 0);
});
