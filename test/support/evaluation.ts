// evaluation 시험 공용: 제출된 run 만들기, 증거 넣기, 가짜 출처 조회기, 가짜 LLM 검증기.
// 실제 네트워크·모델은 쓰지 않는다.
import type { Db, FakeClock } from '@aot/domain';
import type { EffectObservation, EffectSignalSource, FetchResult, IsolatedVerificationInput, LlmVerdict, LlmVerifier, SourceFetcher } from '@aot/evaluation';
import { claimNextTask, submitRun } from '@aot/task-engine';

import { ALLOW_ALL_GATE, queuedTask } from './engine.ts';
import { addAgent } from './seeded-db.ts';

export const EXAMPLE_URL = 'https://docs.example.com/a';
export const OTHER_URL = 'https://docs.example.com/b';

/** URL → 본문 (또는 접근 불가). 호출 기록을 남긴다 */
export class FakeFetcher implements SourceFetcher {
  readonly calls: string[] = [];
  readonly #pages: Map<string, string | { fail: string }>;

  constructor(pages: Record<string, string | { fail: string }> = {}) {
    this.#pages = new Map(Object.entries(pages));
  }

  fetch(url: string): Promise<FetchResult> {
    this.calls.push(url);
    const page = this.#pages.get(url);
    if (page === undefined) return Promise.resolve({ reachable: false, reason: 'HTTP 404' });
    if (typeof page === 'object') return Promise.resolve({ reachable: false, reason: page.fail });
    return Promise.resolve({ reachable: true, status: 200, text: page });
  }
}

export class FakeLlm implements LlmVerifier {
  readonly id = 'fake-verifier@v1';
  readonly inputs: IsolatedVerificationInput[] = [];
  readonly #verdict: LlmVerdict;

  constructor(verdict: LlmVerdict = { verdict: 'supported', note: 'all claims are supported' }) {
    this.#verdict = verdict;
  }

  verify(input: IsolatedVerificationInput): Promise<LlmVerdict> {
    this.inputs.push(input);
    return Promise.resolve(this.#verdict);
  }
}

export const fakeEffect = (observation: EffectObservation | null): EffectSignalSource => ({ read: () => Promise.resolve(observation) });

export interface SubmittedRun {
  taskId: string;
  runId: string;
}

/** generalist 업무를 만들어 lease 를 잡고 결과를 제출한다 (task: validating, run: submitted). */
export function submittedRun(
  db: Db, clock: FakeClock, options: { spec?: Record<string, unknown>; result?: unknown; taskId?: string; worker?: string } = {},
): SubmittedRun {
  const actorId = db.get<{ id: string }>("SELECT id FROM actor WHERE kind = 'agent' LIMIT 1")?.id ?? addAgent(db, clock);
  const taskId = queuedTask(db, clock, options.spec ?? {}, options.taskId);
  const claim = claimNextTask(db, { clock, gate: ALLOW_ALL_GATE, workerId: options.worker ?? 'w1', actorId, adapter: 'fake-adapter', leaseMs: 60_000, taskId });
  if (!claim.claimed) throw new Error('test setup: could not claim the task');
  submitRun(db, clock, claim.claimed.lease, options.result ?? { summary: 'fake result' });
  return { taskId, runId: claim.claimed.lease.runId };
}

let evidenceCounter = 0;

export function addEvidence(
  db: Db, clock: FakeClock, run: SubmittedRun, input: { kind: string; ref: string; id?: string; contentHash?: string | null },
): string {
  const id = input.id ?? `ev-${(evidenceCounter += 1)}`;
  db.writeTx((tx) => tx.run(
    'INSERT INTO evidence (id, task_id, task_run_id, kind, ref, content_hash, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, run.taskId, run.runId, input.kind, input.ref, input.contentHash ?? null, clock.nowIso()],
  ));
  return id;
}

export const evidenceRow = (db: Db, id: string) =>
  db.get<{ verified: number; verification_note: string | null }>('SELECT verified, verification_note FROM evidence WHERE id = ?', [id])!;

/** 연구 업무가 낼 법한 보고서: 주장 + 출처 + 인용 */
export const researchReport = (claims: { statement: string; source_url: string; quote?: string; id?: string }[]): Record<string, unknown> => ({
  summary: 'weekly findings',
  claims,
});

/** 명세에 검증 항목을 덮어쓴 overrides */
export const validationSpec = (deterministic: string[], extra: { llm?: { check: string; isolated_context?: boolean } | null; human?: boolean } = {}): Record<string, unknown> => ({
  validation: { deterministic, llm: extra.llm ?? null, human: extra.human ?? false },
});

export const evaluationsOf = (db: Db, taskId: string) =>
  db.all<{ id: string; task_run_id: string; evaluator: string; outcome: string; safety: string }>(
    'SELECT id, task_run_id, evaluator, outcome, safety FROM evaluation WHERE task_id = ? ORDER BY at, id', [taskId],
  );

/** 등록된 상품 하나 (업무의 product 슬러그가 가리킬 수 있다) */
export function addProduct(db: Db, clock: FakeClock, slug = 'example-product'): string {
  const id = `p-${slug}`;
  db.writeTx((tx) => tx.run(
    'INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, slug, slug, 'software', 'live', 'registered', clock.nowIso(), clock.nowIso()],
  ));
  return id;
}
