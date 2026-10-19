// policy 시험 공용: 시드된 DB + 정책 보관소 + 승인 엔진 + TOTP 비밀(시험 안에서 생성) + 실제 정책 게이트.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { FakeClock, type Db, type TaskRow } from '@aot/domain';
import {
  ApprovalEngine, createPolicyGate, generateTotpSecret, PolicyStore, totpCode, TotpSecretStore, base32Decode,
  type ApprovalResponse,
} from '@aot/policy';
import { createTask, type CreateTaskInput } from '@aot/task-engine';

import { DEFAULT_POLICY_TEMPLATE } from '../../apps/daemon/src/assemble.ts';
import { minimalDraft } from './spec-fixtures.ts';
import { addAgent, seededDb, START } from './seeded-db.ts';
import { makeTempDir } from './temp.ts';

export const DEFAULT_TEMPLATE_TEXT = readFileSync(DEFAULT_POLICY_TEMPLATE, 'utf8');

export const OWNER = 'actor-owner';
export const REVIEWER = 'actor-reviewer';
export const AGENT = 'actor-agent-1';
export const HOUR = 3_600_000;

export interface PolicyEnv {
  db: Db;
  clock: FakeClock;
  dir: string;
  store: PolicyStore;
  totp: TotpSecretStore;
  engine: ApprovalEngine;
  gate: ReturnType<typeof createPolicyGate>;
  /** 사람별 TOTP 비밀 (시험 안에서 만든 값) */
  secrets: Map<string, string>;
  /** 지금 가짜 시각의 TOTP 코드 */
  code(actor?: string, atMs?: number): string;
  /** 승인 엔진에 명령 하나 */
  send(command: Record<string, unknown>): ApprovalResponse;
}

export function policyEnv(t: TestContext): PolicyEnv {
  const { db, clock } = seededDb(t, new FakeClock(START));
  addAgent(db, clock, AGENT);
  db.writeTx((tx) => tx.run('INSERT INTO actor (id, kind, name, adapter, created_at) VALUES (?, ?, ?, NULL, ?)', [REVIEWER, 'human', 'example-reviewer', clock.nowIso()]));
  const dir = makeTempDir(t, 'aot-policy-');
  const store = new PolicyStore({ dir: join(dir, 'policies'), templates: [DEFAULT_POLICY_TEMPLATE] });
  const totp = new TotpSecretStore(join(dir, 'totp'));
  const secrets = new Map<string, string>();
  for (const actor of [OWNER, REVIEWER]) secrets.set(actor, totp.enroll(actor, generateTotpSecret()));
  const engine = new ApprovalEngine({ db, clock, store, totp });
  return {
    db, clock, dir, store, totp, engine, secrets,
    gate: createPolicyGate({ store }),
    code: (actor = OWNER, atMs = clock.nowMs()) => totpCode(base32Decode(secrets.get(actor)!), atMs),
    send: (command) => engine.handle(command),
  };
}

/** 외부 부작용(고객 대상 알림)을 요청하는 업무 — 기본 정책에서 require_approval */
export function effectDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...minimalDraft(),
    role: 'generalist',
    allowed_tools: [
      { tool: 'web_search', operations: ['search'], scope: 'internal', impact: 'read' },
      { tool: 'notify-tool', operations: ['send'], scope: 'customer', impact: 'external_effect', target: 'mailbox:example' },
    ],
    ...overrides,
  };
}

/** customer 범위 읽기 업무 — 외부 부작용이 아닌 require_approval (사람 1인 승인만, cooldown·TOTP 없음) */
export function customerReadDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...minimalDraft(),
    role: 'generalist',
    allowed_tools: [{ tool: 'crm_read', operations: ['read'], scope: 'customer', impact: 'read', target: 'crm:example' }],
    ...overrides,
  };
}

/** 내부 읽기만 하는 업무 — 기본 정책에서 allow */
export function readOnlyDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...minimalDraft(),
    role: 'generalist',
    allowed_tools: [{ tool: 'web_search', operations: ['search', 'fetch'], scope: 'internal', impact: 'read' }],
    ...overrides,
  };
}

export function createWithGate(env: PolicyEnv, spec: Record<string, unknown>, input: Partial<CreateTaskInput> = {}): string {
  return createTask(env.db, { clock: env.clock, gate: env.gate }, { spec, ...input }).taskId;
}

export const taskRow = (db: Db, id: string): TaskRow => db.get<TaskRow>('SELECT * FROM task WHERE id = ?', [id])!;

export const decisionsOf = (db: Db, taskId: string | null) =>
  db.all<{ action: string; decision: string; reason: string; scope: string; impact: string; task_run_id: string | null; policy_version_id: string }>(
    taskId === null
      ? 'SELECT action, decision, reason, scope, impact, task_run_id, policy_version_id FROM policy_decision WHERE task_id IS NULL ORDER BY id'
      : 'SELECT action, decision, reason, scope, impact, task_run_id, policy_version_id FROM policy_decision WHERE task_id = ? ORDER BY id',
    taskId === null ? [] : [taskId],
  );

/** show → approve 한 번 */
export function approve(env: PolicyEnv, taskId: string, actor = OWNER): ApprovalResponse {
  const shown = env.send({ cmd: 'show', actor, kind: 'task', id: taskId });
  if (!shown.ok) return shown;
  return env.send({ cmd: 'approve', actor, kind: 'task', id: taskId, hash: shown['hash'] });
}

/** 기본 정책 YAML 을 조금 바꾼 정책 텍스트 */
export function policyText(edit: (yaml: string) => string): string {
  return edit(DEFAULT_TEMPLATE_TEXT);
}


/** 시험 준비용: 정책을 승인 절차 없이 이미 배포된 것으로 둔다 (보관소에 넣고 policy_version 추가). */
export function deployDirect(env: PolicyEnv, text: string, approvedBy: string[] = [OWNER]): string {
  const parsed = env.store.archive(text);
  env.db.writeTx((tx) => tx.run(
    'INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at, rollback_of) VALUES (?, ?, ?, ?, ?, NULL)',
    [parsed.versionId, parsed.hash, 'normal', JSON.stringify(approvedBy), env.clock.nowIso()],
  ));
  return parsed.versionId;
}

/** 규칙 하나를 앞에 더한 기본 정책 텍스트 */
export const withExtraRule = (rule: string, base = DEFAULT_TEMPLATE_TEXT): string => base.replace('rules:\n', `rules:\n  - ${rule}\n`);
