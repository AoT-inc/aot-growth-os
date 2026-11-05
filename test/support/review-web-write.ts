// 검토 화면의 결정(POST) 시험 공용: 데모 DB + 가짜 승인 엔진(진짜 Unix 소켓 서버, 받은 요청을 기록하고 정해 둔 응답을 돌려준다) + 폼 읽기·POST 보내기.
import { request } from 'node:http';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { FakeClock, openDb, type Db } from '@aot/domain';
import { startApprovalServer } from '@aot/policy';

import { createReviewContext, type ReviewContext } from '../../apps/daemon/src/review-web/context.ts';
import { openReadOnlyDb } from '../../apps/daemon/src/review-web/read-only-db.ts';
import { startReviewServer, type ReviewServer } from '../../apps/daemon/src/review-web/server.ts';
import { createSocketClient, type DecisionClient } from '../../apps/daemon/src/review-web/write-state.ts';
import { seedDemo, type DemoResult } from '../../scripts/review-web-demo.ts';
import { NOW_MS, type Reply } from './review-web.ts';
import { makeTempDir } from './temp.ts';

export interface PostOptions {
  host?: string | null;
  origin?: string | null;
  secFetchSite?: string;
  contentType?: string | null;
  cookie?: string | null;
  headers?: Record<string, string>;
}

export function rawPost(port: number, path: string, body: string | Buffer, options: PostOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.host !== null) headers['Host'] = options.host ?? `127.0.0.1:${port}`;
    if (options.origin !== null) headers['Origin'] = options.origin ?? `http://127.0.0.1:${port}`;
    if (options.contentType !== null) headers['Content-Type'] = options.contentType ?? 'application/x-www-form-urlencoded';
    if (options.cookie !== null && options.cookie !== undefined) headers['Cookie'] = options.cookie;
    if (options.secFetchSite !== undefined) headers['Sec-Fetch-Site'] = options.secFetchSite;
    headers['Content-Length'] = String(Buffer.byteLength(body));
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buffer, text: buffer.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export interface PageForm {
  /** 폼이 보내는 모든 필드 (숨은 필드 + 이름이 있는 입력) */
  fields: Record<string, string>;
  /** 폼 안의 버튼 글자 */
  label: string;
  html: string;
}

const decodeAttr = (value: string): string => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** 화면 HTML 의 결정 폼을 `verb` 별로 읽는다 */
export function formsOf(html: string): Map<string, PageForm> {
  const forms = new Map<string, PageForm>();
  for (const match of html.matchAll(/<form class="act"[^>]*>([\s\S]*?)<\/form>/g)) {
    const inner = match[1]!;
    const fields: Record<string, string> = {};
    for (const input of inner.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[input[1]!] = decodeAttr(input[2]!);
    const label = /<button[^>]*>([\s\S]*?)<\/button>/.exec(inner)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
    if (fields['verb'] !== undefined) forms.set(fields['verb'], { fields, label, html: inner });
  }
  return forms;
}

export const encodeForm = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

export interface WriteRig {
  demo: DemoResult;
  ctx: ReviewContext;
  server: ReviewServer;
  db: Db;
  clock: FakeClock;
  socketPath: string;
  /** 가짜 엔진이 받은 요청 (순서대로) */
  sent: Record<string, unknown>[];
  /** 다음 응답을 정한다. 기본은 { ok: true } */
  respond: (handler: (request: Record<string, unknown>) => unknown) => void;
  get(path: string): Promise<Reply>;
  post(path: string, body: string | Buffer, options?: PostOptions): Promise<Reply>;
  /** 쿠키가 든 기본 헤더로 폼을 읽는다 */
  forms(path: string): Promise<Map<string, PageForm>>;
}

export async function startWriteRig(t: TestContext, options: { actor?: string | null; client?: DecisionClient; startEngine?: boolean; clockMs?: number; timeoutMs?: number; before?: (db: Db, demo: DemoResult) => void } = {}): Promise<WriteRig> {
  const dir = makeTempDir(t, 'aot-rw-');
  const demo = seedDemo({ dir: `${dir}/demo`, nowMs: NOW_MS });
  if (options.before !== undefined) {
    const writable = openDb({ path: demo.dbPath });
    try {
      options.before(writable, demo);
    } finally {
      writable.close();
    }
  }
  const sent: Record<string, unknown>[] = [];
  let handler: (request: Record<string, unknown>) => unknown = (req) => (req['cmd'] === 'whoami' ? { ok: true, actor: req['actor'], kind: 'human' } : { ok: true });
  const socketPath = join(dir, 'run', 'a.sock');
  if (options.startEngine !== false) {
    const engine = await startApprovalServer({ socketPath, handle: (req) => {
      sent.push(req as Record<string, unknown>);
      return handler(req as Record<string, unknown>);
    } });
    t.after(() => engine.close());
  }
  const db = openReadOnlyDb(demo.dbPath);
  t.after(() => db.close());
  const clock = new FakeClock(options.clockMs ?? NOW_MS);
  const actor = options.actor === undefined ? 'actor-owner' : options.actor;
  const ctx = createReviewContext({
    db, clock, policyStoreDir: `${dir}/demo/policies`, evidenceDir: demo.evidenceDir,
    ...(actor === null ? {} : { writer: { actor, client: options.client ?? createSocketClient(socketPath, options.timeoutMs ?? 2_000) } }),
  });
  const server = await startReviewServer(ctx, { port: 0 });
  t.after(() => server.close());
  const cookie = `aot_review=${server.token}`;
  const get = (path: string): Promise<Reply> => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: 'GET', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie }, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buffer, text: buffer.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
  return {
    demo, ctx, server, db, clock, socketPath, sent, respond: (fn) => { handler = fn; }, get,
    post: (path, body, extra) => rawPost(server.port, path, body, { cookie, ...extra }),
    forms: async (path) => formsOf((await get(path)).text),
  };
}
