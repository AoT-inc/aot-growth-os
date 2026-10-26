// 상품 등록 채널 (docs/products/README.md, docs/plans/registration-dogfood.md 4단계): 사람 승인 채널(Unix 소켓, trust-boundaries §3.1)에 얹은 `product` 명령.
// 사람이 후보 상품을 올리고, 읽기 접근을 승인하며 검증 업무를 시작하고, 증거를 읽은 뒤 등록·반려를 결정하고, 섀도 파일럿의 검증기 판정과 사람 결정을 비교한다.
//
// 인증 경계는 동의 채널과 같다: 소켓 파일 권한(0700 디렉터리 + 0600 소켓)과 요청의 actor 가 `actor.kind='human'`. 에이전트는 소켓이 보이지 않는다.
//
// 요청 (한 줄 JSON; 허용 키는 op 마다 다르다. 모르는 키는 거부):
//   {cmd:'product', actor, op:'add', slug, name, repo_path, kind?, stage?}   후보 등록: product(candidate) + product_repo(access_scope=none)
//   {cmd:'product', actor, op:'start', slug}                                  candidate → verifying: 검증 업무 1건을 만들고 읽기 접근(access_scope=read)을 승인한다 (한 트랜잭션)
//   {cmd:'product', actor, op:'status', slug?}                                상태·업무·평가·섀도 판정·증거 목록·review_hash (slug 생략하면 전체 요약)
//   {cmd:'product', actor, op:'evidence', slug, evidence_id}                  저장된 증거 본문 (사람이 읽고 결정하는 용도)
//   {cmd:'product', actor, op:'decide', slug, decision:'approve'|'reject', comment?, hash?}   등록·반려 (approve 는 status 가 보여 준 review_hash 필요, reject 는 사유 필수)
//   {cmd:'product', actor, op:'pilot'}                                        섀도 파일럿 보고: 검증기 판정 ↔ 사람 결정
//
// 상태 전이 (docs/schema/state-machines.md): candidate → verifying(task_creator+정책 경로: 이 채널의 `start`), verifying → pending_approval(검증기: 업무가 평가를 받고 needs_review 에
// 닿으면 `status`/`decide` 가 반영한다), pending_approval → registered(사람, approval 기록), verifying|pending_approval → rejected(사람). 사람 결정은 검증 업무의
// needs_review → completed|failed 전이와 같은 트랜잭션에서 approval 행과 함께 기록한다.
//
// 하지 않는 것: 수집 사실(기본 브랜치·스택 등)을 `product`/`product_repo` 에 자동 반영하지 않는다 (승인 시 반영은 후속). 에이전트가 등록 상태를 바꾸는 길은 없다.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { assertTransition, PRODUCT_REGISTRATION_MACHINE, TASK_MACHINE, type Clock, type Db, type TaskPolicyGate } from '@aot/domain';
import { SHADOW_VERDICT_SOURCE, SHADOW_VERDICT_TYPE, type EvidenceReader } from '@aot/evaluation';
import { createTaskInTx, TaskCreationError, withRefusalRecord } from '@aot/task-engine';

import { PRODUCT_SLUG, buildRegistrationTaskSpec, REGISTRATION_TASK_SPEC_VERSION, REGISTRATION_TRIGGER_PREFIX, registrationTriggerRef } from './registration-task.ts';
import { pathOverlapsAny } from './registration.ts';

export const PRODUCT_COMMANDS = ['product'] as const;
export const READ_ACCESS_EVENT_SOURCE = 'product-registration';
export const READ_ACCESS_GRANTED = 'registration.read_access_granted';
export const READ_ACCESS_REVOKED = 'registration.read_access_revoked';

/** 파일럿 종료 조건 (docs/plans/registration-dogfood.md Q22 f): 처음 5건 */
export const PILOT_TARGET_COUNT = 5;
const MAX_EVIDENCE_TEXT_BYTES = 200_000;

export interface ProductChannelOptions {
  db: Db;
  clock: Clock;
  gate: TaskPolicyGate;
  /** 증거 본문 읽기 (호스트 근거 저장소). 없으면 `evidence` op 는 쓸 수 없다 */
  evidenceReader?: EvidenceReader;
  /** 저장소 경로가 겹치면 안 되는 디렉터리 (데몬 인스턴스·근거 저장소) */
  forbiddenRoots: readonly string[];
}

/** 이 요청이 상품 등록 명령인가 (소켓 처리기 조합이 고르는 기준) */
export function isProductCommand(request: unknown): boolean {
  return typeof request === 'object' && request !== null && !Array.isArray(request)
    && (PRODUCT_COMMANDS as readonly unknown[]).includes((request as Record<string, unknown>)['cmd']);
}

const OPS = ['add', 'start', 'status', 'evidence', 'decide', 'pilot'] as const;
type Op = (typeof OPS)[number];
const KEYS: Readonly<Record<Op, readonly string[]>> = {
  add: ['cmd', 'actor', 'op', 'slug', 'name', 'repo_path', 'kind', 'stage'],
  start: ['cmd', 'actor', 'op', 'slug'],
  status: ['cmd', 'actor', 'op', 'slug'],
  evidence: ['cmd', 'actor', 'op', 'slug', 'evidence_id'],
  decide: ['cmd', 'actor', 'op', 'slug', 'decision', 'comment', 'hash'],
  pilot: ['cmd', 'actor', 'op'],
};
const KINDS = ['software', 'physical', 'service', 'other'];
const STAGES = ['idea', 'development', 'beta', 'live', 'maintenance', 'sunset'];

const refused = (code: string, error: string): Record<string, unknown> => ({ ok: false, code, error });

type ProductRow = { id: string; slug: string; name: string; kind: string; lifecycle_stage: string; registration_status: string; registration_approval_id: string | null; registered_at: string | null };
type RepoRow = { id: string; local_path: string | null; access_scope: string };
type TaskRow = { id: string; status: string; attempts: number; max_attempts: number; created_at: string };
type EvaluationRow = { id: string; outcome: string; safety: string; quality_note: string | null; at: string };
type EvidenceRow = { id: string; kind: string; ref: string; content_hash: string | null; trust_origin: string; verified: number };

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function createProductChannel(options: ProductChannelOptions): (request: unknown) => Promise<Record<string, unknown>> {
  const { db, clock, gate } = options;

  const productBySlug = (slug: string): ProductRow | undefined => db.get<ProductRow>(
    'SELECT id, slug, name, kind, lifecycle_stage, registration_status, registration_approval_id, registered_at FROM product WHERE slug = ?', [slug],
  );
  const repoOf = (productId: string): RepoRow | undefined => db.get<RepoRow>('SELECT id, local_path, access_scope FROM product_repo WHERE product_id = ? ORDER BY id LIMIT 1', [productId]);
  const latestTask = (slug: string, from: Db = db): TaskRow | undefined => from.get<TaskRow>(
    "SELECT id, status, attempts, max_attempts, created_at FROM task WHERE trigger_kind = 'manual' AND trigger_ref = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [registrationTriggerRef(slug)],
  );
  /** 업무의 가장 나중 실행(시도). 평가·증거는 *이 실행의 것*만 본다 — 앞선 시도의 평가가 뒤 시도의 사람 검토로 둔갑하지 않게 한다 */
  const latestRun = (taskId: string): { id: string; outcome: string | null } | undefined => db.get<{ id: string; outcome: string | null }>(
    'SELECT id, outcome FROM task_run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1', [taskId],
  );
  const evaluationOf = (taskId: string): EvaluationRow | undefined => {
    const run = latestRun(taskId);
    return run === undefined ? undefined : db.get<EvaluationRow>('SELECT id, outcome, safety, quality_note, at FROM evaluation WHERE task_id = ? AND task_run_id = ? ORDER BY at DESC, id DESC LIMIT 1', [taskId, run.id]);
  };
  const evidenceOf = (taskId: string): EvidenceRow[] => {
    const run = latestRun(taskId);
    return run === undefined ? [] : db.all<EvidenceRow>(
      'SELECT id, kind, ref, content_hash, trust_origin, verified FROM evidence WHERE task_id = ? AND (task_run_id = ? OR task_run_id IS NULL) ORDER BY captured_at, id', [taskId, run.id],
    );
  };
  const shadowOf = (taskId: string): Record<string, unknown> | null => {
    const row = db.get<{ payload: string }>(
      'SELECT payload FROM event WHERE source = ? AND type = ? AND json_extract(payload, \'$.task_id\') = ? ORDER BY rowid DESC LIMIT 1', [SHADOW_VERDICT_SOURCE, SHADOW_VERDICT_TYPE, taskId],
    );
    return row === undefined ? null : (JSON.parse(row.payload) as Record<string, unknown>);
  };

  /** 사람이 읽은 증거 집합에 승인이 묶이도록 하는 해시: 업무·평가·증거(id, 본문 해시)가 바뀌면 달라진다 */
  const reviewHash = (task: TaskRow, evaluation: EvaluationRow | undefined, evidence: readonly EvidenceRow[]): string => sha256(JSON.stringify({
    task: task.id, evaluation: evaluation?.id ?? null, evidence: evidence.map((row) => [row.id, row.content_hash]),
  }));

  /** verifying → pending_approval (검증기): 검증 업무가 평가를 받고 사람 검토(needs_review)에 닿았다 */
  const syncStatus = (): void => {
    const waiting = db.all<{ slug: string }>("SELECT slug FROM product WHERE registration_status = 'verifying'");
    for (const { slug } of waiting) {
      const task = latestTask(slug);
      // 사람 검토 중(needs_review)이고 *가장 나중 실행*이 결과를 내서 평가를 받았을 때만. 실행 전 승인 대기·한도/로그인 때문에 멈춘 재시도는 검증 검토가 아니다
      if (task === undefined || task.status !== 'needs_review' || latestRun(task.id)?.outcome !== 'submitted' || evaluationOf(task.id) === undefined) continue;
      db.writeTx((tx) => {
        assertTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'verifying', to: 'pending_approval', by: 'validator' });
        tx.run("UPDATE product SET registration_status = 'pending_approval', updated_at = ? WHERE slug = ? AND registration_status = 'verifying'", [clock.nowIso(), slug]);
      });
    }
  };

  const view = (product: ProductRow): Record<string, unknown> => {
    const repo = repoOf(product.id);
    const task = latestTask(product.slug);
    const evaluation = task === undefined ? undefined : evaluationOf(task.id);
    const evidence = task === undefined ? [] : evidenceOf(task.id);
    const decision = db.get<{ decision: string; comment: string | null; at: string }>(
      "SELECT decision, comment, at FROM approval WHERE subject_kind = 'product' AND subject_id = ? ORDER BY at DESC, rowid DESC LIMIT 1", [product.id],
    );
    return {
      slug: product.slug,
      name: product.name,
      kind: product.kind,
      lifecycle_stage: product.lifecycle_stage,
      registration_status: product.registration_status,
      access_scope: repo?.access_scope ?? null,
      repo_path: repo?.local_path ?? null,
      task: task === undefined ? null : { id: task.id, status: task.status, attempts: task.attempts, max_attempts: task.max_attempts },
      evaluation: evaluation === undefined ? null : { outcome: evaluation.outcome, safety: evaluation.safety, note: evaluation.quality_note, at: evaluation.at },
      shadow_verdict: task === undefined ? null : shadowOf(task.id),
      evidence: evidence.map((row) => ({ id: row.id, kind: row.kind, verified: Number(row.verified) === 1, trust_origin: row.trust_origin })),
      review_hash: task === undefined ? null : reviewHash(task, evaluation, evidence),
      ...(task !== undefined && task.status === 'needs_review' && evaluation === undefined
        ? { next: `the task is waiting before its run (policy approval, consent or a usage limit): see \`approve task ${task.id}\` / the daemon log` } : {}),
      decision: decision ?? null,
      registered_at: product.registered_at,
    };
  };

  /** 저장소 루트 검사: 실경로가 디렉터리이고 자기 `.git` 디렉터리가 있고 데몬 디렉터리와 겹치지 않는다. 통과하면 실경로, 아니면 거절 응답 */
  const checkRepoRoot = (repoPath: string): string | Record<string, unknown> => {
    let real: string;
    try {
      real = realpathSync(repoPath);
      if (!statSync(real).isDirectory()) return refused('invalid_repo', 'repo_path is not a directory');
      if (!lstatSync(join(real, '.git')).isDirectory()) return refused('invalid_repo', 'repo_path is not the root of a git repository (it needs its own .git directory)');
    } catch {
      return refused('invalid_repo', 'repo_path does not exist or is not a git repository root');
    }
    if (pathOverlapsAny(real, options.forbiddenRoots)) return refused('invalid_repo', 'repo_path overlaps a daemon directory (instance, evidence, database, TOTP, policy store, approval socket or run directories)');
    return real;
  };

  // ----- add -----
  const add = (actorId: string, request: Record<string, unknown>): Record<string, unknown> => {
    const slug = request['slug'];
    const name = request['name'];
    const repoPath = request['repo_path'];
    const kind = request['kind'] ?? 'software';
    const stage = request['stage'] ?? 'development';
    if (typeof slug !== 'string' || !PRODUCT_SLUG.test(slug)) return refused('invalid_request', 'slug must look like example-product (lowercase letters, digits, ".", "_", "-")');
    if (typeof name !== 'string' || name.trim() === '' || name.length > 200) return refused('invalid_request', 'name must be a non-empty string (max 200 characters)');
    if (typeof kind !== 'string' || !KINDS.includes(kind)) return refused('invalid_request', `kind must be one of ${KINDS.join(', ')}`);
    if (typeof stage !== 'string' || !STAGES.includes(stage)) return refused('invalid_request', `stage must be one of ${STAGES.join(', ')}`);
    if (typeof repoPath !== 'string' || !isAbsolute(repoPath) || /[\0\r\n]/.test(repoPath)) return refused('invalid_request', 'repo_path must be an absolute path');
    const checked = checkRepoRoot(repoPath);
    if (typeof checked !== 'string') return checked;
    const real = checked;
    if (productBySlug(slug) !== undefined) return refused('duplicate', `a product with slug '${slug}' already exists`);
    const sameRepo = db.get<{ slug: string }>('SELECT p.slug FROM product_repo pr JOIN product p ON p.id = pr.product_id WHERE pr.local_path = ?', [real]);
    if (sameRepo !== undefined) return refused('duplicate', `this repository is already a product ('${sameRepo.slug}'); register it once`);
    const now = clock.nowIso();
    const productId = `product-${randomUUID()}`;
    db.writeTx((tx) => {
      tx.run(
        `INSERT INTO product (id, slug, name, kind, lifecycle_stage, registration_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?)`,
        [productId, slug, name.trim(), kind, stage, now, now],
      );
      tx.run('INSERT INTO product_repo (id, product_id, name, local_path, access_scope) VALUES (?, ?, ?, ?, ?)', [`repo-${randomUUID()}`, productId, 'main', real, 'none']);
    });
    return { ok: true, product: view(productBySlug(slug)!), added_by: actorId };
  };

  // ----- start -----
  const start = (actorId: string, request: Record<string, unknown>): Record<string, unknown> => {
    const slug = request['slug'];
    if (typeof slug !== 'string') return refused('invalid_request', 'slug is required');
    const product = productBySlug(slug);
    if (product === undefined) return refused('not_found', `no product '${slug}'`);
    if (product.registration_status !== 'candidate') return refused('wrong_state', `the product is '${product.registration_status}'; only a candidate can start verification`);
    const repo = repoOf(product.id);
    if (repo === undefined || repo.local_path === null) return refused('invalid_repo', 'the product has no repository path');
    if (repo.access_scope !== 'none') return refused('wrong_state', `the repository access is already '${repo.access_scope}'`);
    // 읽기 접근을 승인하기 직전에 경로를 다시 확인한다 (add 이후 바뀌었거나 데몬 디렉터리 설정이 늘었을 수 있다)
    const recheck = checkRepoRoot(repo.local_path);
    if (typeof recheck !== 'string') return recheck;
    let taskId: string;
    try {
      taskId = withRefusalRecord(db, () => db.writeTx((tx) => {
        assertTransition(PRODUCT_REGISTRATION_MACHINE, { from: 'candidate', to: 'verifying', by: 'task_creator' });
        const created = createTaskInTx(tx, { clock, gate }, { spec: buildRegistrationTaskSpec(slug), taskSpecVersion: REGISTRATION_TASK_SPEC_VERSION });
        if (created.status === 'unassigned') {
          throw new TaskCreationError([{ path: 'role', code: 'unassigned', message: 'the registration-verifier role is not assignable (check the organization seed)' }]);
        }
        const now = clock.nowIso();
        // 읽기 접근 승인: 사람이 이 명령으로 승인한다. 승인 기록은 event 로 남긴다 (approval 행은 최종 등록 승인용이다)
        tx.run("UPDATE product SET registration_status = 'verifying', updated_at = ? WHERE id = ? AND registration_status = 'candidate'", [now, product.id]);
        tx.run("UPDATE product_repo SET access_scope = 'read' WHERE id = ? AND access_scope = 'none'", [repo.id]);
        const eventId = `event-${randomUUID()}`;
        tx.run(
          `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          [eventId, READ_ACCESS_EVENT_SOURCE, slug, READ_ACCESS_GRANTED, JSON.stringify({ slug, task_id: created.taskId, actor_id: actorId, access_scope: 'read' }), `${READ_ACCESS_EVENT_SOURCE}:${eventId}`, now, now],
        );
        return created.taskId;
      }));
    } catch (error) {
      if (error instanceof TaskCreationError) return refused('task_refused', error.message.slice(0, 600));
      throw error;
    }
    return {
      ok: true,
      product: view(productBySlug(slug)!),
      task_id: taskId,
    };
  };

  // ----- status -----
  const status = (request: Record<string, unknown>): Record<string, unknown> => {
    syncStatus();
    const slug = request['slug'];
    if (slug === undefined) {
      const rows = db.all<ProductRow>('SELECT id, slug, name, kind, lifecycle_stage, registration_status, registration_approval_id, registered_at FROM product ORDER BY created_at, slug');
      return {
        ok: true,
        products: rows.map((row) => {
          const full = view(row);
          return { slug: row['slug'], registration_status: full['registration_status'], task: full['task'], evaluation_outcome: (full['evaluation'] as { outcome: string } | null)?.outcome ?? null, shadow_verdict: (full['shadow_verdict'] as { verdict?: string } | null)?.verdict ?? null };
        }),
      };
    }
    if (typeof slug !== 'string') return refused('invalid_request', 'slug must be a string');
    const product = productBySlug(slug);
    if (product === undefined) return refused('not_found', `no product '${slug}'`);
    return { ok: true, product: view(product) };
  };

  // ----- evidence -----
  const evidence = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const slug = request['slug'];
    const evidenceId = request['evidence_id'];
    if (typeof slug !== 'string' || typeof evidenceId !== 'string') return refused('invalid_request', 'slug and evidence_id are required');
    if (options.evidenceReader === undefined) return refused('unavailable', 'no evidence store is configured (registration_tools)');
    const product = productBySlug(slug);
    if (product === undefined) return refused('not_found', `no product '${slug}'`);
    const task = latestTask(slug);
    const row = task === undefined ? undefined : evidenceOf(task.id).find((candidate) => candidate.id === evidenceId);
    if (row === undefined) return refused('not_found', `evidence '${evidenceId}' is not part of the latest verification of '${slug}'`);
    let content;
    try {
      content = await options.evidenceReader.read({ id: row.id, kind: row.kind as never, ref: row.ref, content_hash: row.content_hash });
    } catch {
      return refused('unreadable', 'the stored content could not be read');
    }
    if (!content.readable) return refused('unreadable', content.reason.slice(0, 300));
    const hashOk = row.content_hash !== null && sha256(content.text) === row.content_hash.replace(/^sha256:/, '');
    const bytes = Buffer.byteLength(content.text, 'utf8');
    let text = content.text;
    if (bytes > MAX_EVIDENCE_TEXT_BYTES) {
      text = Buffer.from(content.text, 'utf8').subarray(0, MAX_EVIDENCE_TEXT_BYTES).toString('utf8');
      if (text.endsWith('\uFFFD')) text = text.slice(0, -1); // 문자 중간에서 잘린 조각
    }
    return { ok: true, evidence: { id: row.id, kind: row.kind, trust_origin: row.trust_origin, hash_matches: hashOk, bytes, truncated: bytes > MAX_EVIDENCE_TEXT_BYTES, text } };
  };

  // ----- decide -----
  const decide = (actorId: string, request: Record<string, unknown>): Record<string, unknown> => {
    syncStatus();
    const slug = request['slug'];
    const decision = request['decision'];
    const comment = request['comment'];
    const hash = request['hash'];
    if (typeof slug !== 'string') return refused('invalid_request', 'slug is required');
    if (decision !== 'approve' && decision !== 'reject') return refused('invalid_request', 'decision must be approve or reject');
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > 1000)) return refused('invalid_request', 'comment must be a string (max 1000 characters)');
    if (hash !== undefined && typeof hash !== 'string') return refused('invalid_request', 'hash must be a string');
    if (decision === 'reject' && (comment === undefined || comment.trim() === '')) return refused('comment_required', 'a rejection needs a comment (the pilot compares it with the verifier verdict)');
    const product = productBySlug(slug);
    if (product === undefined) return refused('not_found', `no product '${slug}'`);
    const task = latestTask(slug);
    if (task === undefined) return refused('wrong_state', 'the product has no verification task');
    const evaluation = evaluationOf(task.id);
    const evidenceRows = evidenceOf(task.id);

    if (decision === 'approve') {
      if (product.registration_status !== 'pending_approval') return refused('wrong_state', `the product is '${product.registration_status}'; only a pending_approval product can be registered`);
      if (task.status !== 'needs_review') return refused('wrong_state', `the verification task is '${task.status}', not needs_review`);
      if (evaluation === undefined || evaluation.outcome !== 'pass' || evaluation.safety !== 'pass') {
        return refused('evaluation_not_passed', `the evaluation is ${evaluation === undefined ? 'missing' : `outcome '${evaluation.outcome}', safety '${evaluation.safety}'`}; only a passed evaluation can be approved (reject it, or let the task retry)`);
      }
      if (!evidenceRows.some((row) => row.ref.startsWith('blob:') && Number(row.verified) === 1)) return refused('no_evidence', 'the verification task has no host-stored, verified evidence linked');
      if (hash === undefined) return refused('hash_required', 'approve needs the review_hash that `product status` shows for the evidence you read');
      if (hash !== reviewHash(task, evaluation, evidenceRows)) return refused('hash_mismatch', 'the task, evaluation or evidence changed since you looked; run `product status` again');
    } else if (product.registration_status !== 'verifying' && product.registration_status !== 'pending_approval') {
      return refused('wrong_state', `the product is '${product.registration_status}'; only a product under verification can be rejected`);
    }
    const taskOpen = task.status === 'needs_review';
    if (decision === 'reject' && !taskOpen && !['completed', 'failed', 'cancelled'].includes(task.status)) {
      return refused('task_active', `the verification task is '${task.status}'; wait for it to reach needs_review (or cancel it) before rejecting`);
    }

    const now = clock.nowIso();
    const approved = decision === 'approve';
    db.writeTx((tx) => {
      const productApprovalId = `approval-${randomUUID()}`;
      tx.run(
        'INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [productApprovalId, 'product', product.id, approved ? 'approved' : 'rejected', approved && typeof hash === 'string' ? hash : null, actorId, comment ?? null, now],
      );
      assertTransition(PRODUCT_REGISTRATION_MACHINE, { from: product.registration_status as never, to: approved ? 'registered' : 'rejected', by: 'human', approvalId: productApprovalId });
      if (approved) {
        const changed = tx.run("UPDATE product SET registration_status = 'registered', registration_approval_id = ?, registered_at = ?, updated_at = ? WHERE id = ? AND registration_status = ?", [productApprovalId, now, now, product.id, product.registration_status]);
        if (changed.changes !== 1) throw new Error('the product changed while deciding');
      } else {
        const changed = tx.run("UPDATE product SET registration_status = 'rejected', updated_at = ? WHERE id = ? AND registration_status = ?", [now, product.id, product.registration_status]);
        if (changed.changes !== 1) throw new Error('the product changed while deciding');
        // 반려하면 읽기 접근을 회수한다 (도구는 다음 호출부터 닫힌다)
        tx.run("UPDATE product_repo SET access_scope = 'none' WHERE product_id = ? AND access_scope <> 'none'", [product.id]);
        const eventId = `event-${randomUUID()}`;
        tx.run(
          `INSERT INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          [eventId, READ_ACCESS_EVENT_SOURCE, slug, READ_ACCESS_REVOKED, JSON.stringify({ slug, actor_id: actorId, reason: 'rejected' }), `${READ_ACCESS_EVENT_SOURCE}:${eventId}`, now, now],
        );
      }
      if (taskOpen) {
        const taskApprovalId = `approval-${randomUUID()}`;
        const to = approved ? 'completed' : 'failed';
        tx.run('INSERT INTO approval (id, subject_kind, subject_id, decision, subject_hash, decided_by, comment, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
          taskApprovalId, 'task', task.id, approved ? 'approved' : 'rejected', null, actorId, `product ${approved ? 'registered' : 'rejected'} (${productApprovalId})`, now,
        ]);
        assertTransition(TASK_MACHINE, { from: 'needs_review', to, by: 'human', approvalId: taskApprovalId });
        const changed = tx.run("UPDATE task SET status = ?, updated_at = ? WHERE id = ? AND status = 'needs_review'", [to, now, task.id]);
        if (changed.changes !== 1) throw new Error('the verification task changed while deciding');
        tx.run('INSERT INTO task_transition (task_id, from_status, to_status, reason, caused_by, at) VALUES (?, ?, ?, ?, ?, ?)', [
          task.id, 'needs_review', to, `product ${approved ? 'registered' : 'rejected'} by a human (approval ${productApprovalId})`, actorId, now,
        ]);
      }
    });
    return { ok: true, product: view(productBySlug(slug)!) };
  };

  // ----- pilot -----
  const pilot = (): Record<string, unknown> => {
    syncStatus();
    const events = db.all<{ payload: string }>('SELECT payload FROM event WHERE source = ? AND type = ? ORDER BY rowid', [SHADOW_VERDICT_SOURCE, SHADOW_VERDICT_TYPE]);
    // 상품마다 *가장 나중* 판정 하나만 센다 (재실행·재평가로 같은 상품의 판정이 여러 번 쌓여도 한 건이다)
    const latest = new Map<string, { payload: Record<string, unknown>; slug: string }>();
    for (const event of events) {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      const task = db.get<{ trigger_ref: string }>('SELECT trigger_ref FROM task WHERE id = ?', [String(payload['task_id'] ?? '')]);
      if (task === undefined || !task.trigger_ref.startsWith(REGISTRATION_TRIGGER_PREFIX)) continue;
      const slug = task.trigger_ref.slice(REGISTRATION_TRIGGER_PREFIX.length);
      latest.set(slug, { payload, slug });
    }
    interface PilotRow { slug: string; verifier: unknown; verdict: string | null; verdict_note: unknown; human: 'approved' | 'rejected' | 'pending'; human_comment: string | null; decided_at: string | null; verifier_tokens: number | null; run_tokens: number | null; token_ratio: number | null }
    const rows: PilotRow[] = [];
    for (const { payload, slug } of latest.values()) {
      const product = productBySlug(slug);
      const human = product === undefined ? undefined : db.get<{ decision: string; comment: string | null; at: string }>(
        "SELECT decision, comment, at FROM approval WHERE subject_kind = 'product' AND subject_id = ? ORDER BY at DESC, rowid DESC LIMIT 1", [product.id],
      );
      const tokens = typeof payload['tokens'] === 'number' ? payload['tokens'] : null;
      const runTokens = typeof payload['run_tokens'] === 'number' ? payload['run_tokens'] : null;
      rows.push({
        slug, verifier: payload['verifier'] ?? null, verdict: typeof payload['verdict'] === 'string' ? payload['verdict'] : null, verdict_note: payload['note'] ?? null,
        human: human === undefined ? 'pending' : human.decision === 'approved' ? 'approved' : 'rejected', human_comment: human?.comment ?? null, decided_at: human?.at ?? null,
        verifier_tokens: tokens, run_tokens: runTokens, token_ratio: tokens !== null && runTokens !== null && runTokens > 0 ? tokens / runTokens : null,
      });
    }
    // 종료 기준은 *처음 결정된 5건*에 대해서만 본다 (결정 시각 순). 그 뒤 건은 참고용 요약에만 든다
    const decidedAll = rows.filter((row) => row.human !== 'pending').sort((a, b) => (a.decided_at ?? '').localeCompare(b.decided_at ?? '') || a.slug.localeCompare(b.slug));
    const window = decidedAll.slice(0, PILOT_TARGET_COUNT);
    const stats = (set: readonly PilotRow[]) => {
      const clear = set.filter((row) => row.verdict === 'supported' || row.verdict === 'unsupported');
      const ratios = set.map((row) => row.token_ratio).filter((value): value is number => value !== null);
      return {
        decided: set.length,
        supported: set.filter((row) => row.verdict === 'supported').length,
        supported_but_rejected: set.filter((row) => row.verdict === 'supported' && row.human === 'rejected').length,
        unsupported_but_approved: set.filter((row) => row.verdict === 'unsupported' && row.human === 'approved').length,
        unclear: set.filter((row) => row.verdict === 'unclear').length,
        agreement: clear.length === 0 ? null : clear.filter((row) => (row.verdict === 'supported') === (row.human === 'approved')).length / clear.length,
        token_ratio_mean: ratios.length === 0 ? null : ratios.reduce((sum, value) => sum + value, 0) / ratios.length,
        token_ratio_max: ratios.length === 0 ? null : Math.max(...ratios),
      };
    };
    const first = stats(window);
    return {
      ok: true,
      rows,
      summary: {
        verdicts_recorded: rows.length,
        pending_human: rows.length - decidedAll.length,
        all_decided: stats(decidedAll),
        first_decided: first,
        criterion: {
          target_count: PILOT_TARGET_COUNT,
          // 기준: 처음 결정된 5건에서 "검증기 supported 인데 사람이 반려" = 0. 5건이 채워지기 전에는 충족 여부를 정하지 않는다.
          // 검증기가 한 번도 supported 를 내지 않았다면(전부 unclear/unsupported) 0건은 의미가 없으므로 충족으로 치지 않는다
          met: window.length < PILOT_TARGET_COUNT ? null : first.supported_but_rejected === 0 && first.supported > 0,
          failed: first.supported_but_rejected > 0,
          ...(window.length >= PILOT_TARGET_COUNT && first.supported === 0 ? { note: 'the verifier never answered supported in the first decided products, so zero supported-but-rejected says nothing' } : {}),
        },
      },
    };
  };

  return async (raw) => {
    const request = raw as Record<string, unknown>;
    const actorId = request['actor'];
    if (typeof actorId !== 'string' || actorId === '') return refused('unknown_actor', 'an actor id is required');
    const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId]);
    if (!actor) return refused('unknown_actor', `unknown actor '${actorId}'`);
    if (actor.kind !== 'human') return refused('not_human', `only human actors can use the product channel; '${actorId}' is '${actor.kind}'`);
    const op = request['op'];
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return refused('unknown_op', `op must be one of ${OPS.join('|')}`);
    const unknown = Object.keys(request).filter((key) => !KEYS[op as Op].includes(key));
    if (unknown.length > 0) return refused('invalid_request', `unknown field(s) for ${op}: ${unknown.join(', ')}`);
    switch (op as Op) {
      case 'add': return add(actorId, request);
      case 'start': return start(actorId, request);
      case 'status': return status(request);
      case 'evidence': return evidence(request);
      case 'decide': return decide(actorId, request);
      case 'pilot': return pilot();
    }
  };
}
