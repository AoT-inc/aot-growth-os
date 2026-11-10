// 검토 화면 시험 공용: 데모 시나리오 DB 를 임시 폴더에 만들고, 읽기 전용 서버를 임시 포트로 띄우고, 임의 Host 헤더로 요청을 보낸다.
import { request } from 'node:http';
import type { TestContext } from 'node:test';

import { FakeClock, openDb, type Db } from '@aot/domain';

import { createReviewContext } from '../../apps/daemon/src/review-web/context.ts';
import { openReadOnlyDb } from '../../apps/daemon/src/review-web/read-only-db.ts';
import { startReviewServer, type ReviewServer } from '../../apps/daemon/src/review-web/server.ts';
import { seedDemo, type DemoResult } from '../../scripts/review-web-demo.ts';
import { makeTempDir } from './temp.ts';

export const NOW_MS = Date.parse('2026-11-04T12:00:00.000Z');

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
}

export interface ReviewRig {
  demo: DemoResult;
  server: ReviewServer;
  /** 서버가 쓰는 읽기 전용 DB 핸들 */
  db: Db;
  /** 기본 Host 헤더(`127.0.0.1:<포트>`)로 요청 */
  get(path: string, extra?: { method?: string; host?: string | null; cookie?: string | null }): Promise<Reply>;
}

export function rawRequest(port: number, path: string, options: { method?: string; host?: string | null; cookie?: string | null } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== null) headers['Host'] = options.host ?? `127.0.0.1:${port}`;
    if (options.cookie !== undefined && options.cookie !== null) headers['Cookie'] = options.cookie;
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 데모 DB 를 만들고(선택: `before` 로 쓰기 연결에서 행을 더한 뒤) 서버를 띄운다 */
export async function startRig(t: TestContext, options: { empty?: boolean; clockMs?: number; before?: (db: Db, demo: DemoResult) => void; extraRoots?: (demo: DemoResult) => string[]; mcpSites?: unknown; runLogDir?: (demo: DemoResult) => string } = {}): Promise<ReviewRig> {
  const dir = makeTempDir(t, 'aot-review-web-');
  const demo = seedDemo({ dir: `${dir}/demo`, nowMs: NOW_MS, ...(options.empty === true ? { empty: true } : {}) });
  if (options.before !== undefined) {
    const writable = openDb({ path: demo.dbPath });
    try {
      options.before(writable, demo);
    } finally {
      writable.close();
    }
  }
  const db = openReadOnlyDb(demo.dbPath);
  t.after(() => db.close());
  const ctx = createReviewContext({
    db, clock: new FakeClock(options.clockMs ?? NOW_MS), policyStoreDir: `${dir}/demo/policies`, evidenceDir: demo.evidenceDir, evidenceRoots: options.extraRoots?.(demo) ?? [],
    ...(options.mcpSites === undefined ? {} : { mcpSites: options.mcpSites }), ...(options.runLogDir === undefined ? {} : { runLogDir: options.runLogDir(demo) }),
  });
  const server = await startReviewServer(ctx, { port: 0 });
  t.after(() => server.close());
  return { demo, server, db, get: (path, extra) => rawRequest(server.port, path, { cookie: `aot_review=${server.token}`, ...extra }) };
}
