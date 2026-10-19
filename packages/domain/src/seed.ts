// Phase A 시드 (a0-decisions D4, ADR-0011 Amendment 2026-10-19):
//   오너 1(human) + 부서 `core` 1 + `generalist@v1` + 읽기 전용 `registration-verifier@v1` + 초기 policy_version v1(기본 거부).
// 값은 모두 중립 예시다. 실제 이름은 호출하는 쪽이 `instance/` 의 값으로 넘긴다 (공개 저장소에는 두지 않는다).
// 시각은 주입된 Clock 에서만 얻고, 쓰기는 Db.writeTx 안에서만 한다.
import { createHash } from 'node:crypto';

import type { Clock } from './clock.ts';
import type { Db } from './db/types.ts';

export const SEED_IDS = {
  owner: 'actor-owner',
  unit: 'org-unit-core',
  orgVersion: 'org-version-1',
  generalist: 'role-generalist',
  registrationVerifier: 'role-registration-verifier',
  policy: 'policy-v1',
} as const;

export const SEED_SLUGS = {
  unit: 'core',
  generalist: 'generalist',
  registrationVerifier: 'registration-verifier',
} as const;

export const DEFAULT_OWNER_NAME = 'example-owner';

/**
 * 초기 정책 v1 의 요약: 기본 거부, internal 읽기 허용, write 는 업무 범위 내 허용,
 * external_effect 와 customer/public 범위는 require_approval (D4). `delete` 는 문서에 없으므로 기본 거부에 맡긴다.
 * 정책 표현 형식(Q7)은 A3 에서 정한다. 그때까지 `policy_version.content_hash` 는 이 요약의 해시이며,
 * 형식이 정해지면 새 policy_version 으로 교체한다.
 */
export const POLICY_V1_BASELINE = {
  default: 'deny',
  rules: [
    { scope: 'internal', impact: 'read', decision: 'allow' },
    { scope: 'internal', impact: 'write', decision: 'allow', condition: 'within_task_scope' },
    { impact: 'external_effect', decision: 'require_approval' },
    { scope: 'customer', decision: 'require_approval' },
    { scope: 'public', decision: 'require_approval' },
  ],
} as const;

/** 역할이 *요청*하는 도구 (권한은 정책이 정한다). 도구·작업 이름은 task-spec 예시와 상품 등록 템플릿에서 가져왔다. */
const GENERALIST_TOOLS = [
  { tool: 'web_search', operations: ['search', 'fetch'] },
  { tool: 'evidence_store', operations: ['append'] },
] as const;

const REGISTRATION_VERIFIER_TOOLS = [
  { tool: 'repo_read', operations: ['list_tree', 'read_file', 'read_metadata', 'read_history'] },
  { tool: 'secret_scan', operations: ['scan_tree', 'scan_history'] },
  { tool: 'license_check', operations: ['identify'] },
  { tool: 'evidence_store', operations: ['append'] },
] as const;

export interface SeedOptions {
  clock: Clock;
  /** 오너의 표시 이름. 기본은 중립 예시 값 */
  ownerName?: string;
}

export interface SeedResult {
  /** false 면 이미 시드되어 있어 아무것도 쓰지 않았다 */
  applied: boolean;
  ids: typeof SEED_IDS;
}

export function policyV1ContentHash(): string {
  return createHash('sha256').update(JSON.stringify(POLICY_V1_BASELINE)).digest('hex');
}

/**
 * 시드를 한 트랜잭션으로 적용한다. 이미 `policy-v1` 이 있으면 아무것도 하지 않는다(멱등).
 * 이미 열린 writeTx 안에서는 호출할 수 없다.
 */
export function seedPhaseA(db: Db, options: SeedOptions): SeedResult {
  const now = options.clock.nowIso();
  const ownerName = options.ownerName ?? DEFAULT_OWNER_NAME;
  if (ownerName.trim() === '') throw new RangeError('ownerName must not be blank');

  return db.writeTx((tx) => {
    if (tx.get('SELECT 1 AS one FROM policy_version WHERE id = ?', [SEED_IDS.policy])) {
      return { applied: false, ids: SEED_IDS };
    }

    tx.run('INSERT INTO actor (id, kind, name, adapter, created_at) VALUES (?, ?, ?, NULL, ?)', [SEED_IDS.owner, 'human', ownerName, now]);

    tx.run(
      'INSERT INTO org_unit (id, parent_id, slug, lifecycle, name, responsibility, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
      [SEED_IDS.unit, SEED_SLUGS.unit, 'active', 'core', 'Phase A 시드 조직의 유일한 부서 (역할의 org_unit_id 가 NOT NULL 이라 둔다)', now],
    );

    const insertRole = (id: string, slug: string, description: string, tools: unknown) =>
      tx.run(
        'INSERT INTO role (id, org_unit_id, slug, description, allowed_tools, lifecycle, version, trial_scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
        [id, SEED_IDS.unit, slug, description, JSON.stringify(tools), 'active', 1, now],
      );
    insertRole(SEED_IDS.generalist, SEED_SLUGS.generalist, '주간 조사와 실험 제안을 맡는 범용 역할', GENERALIST_TOOLS);
    insertRole(SEED_IDS.registrationVerifier, SEED_SLUGS.registrationVerifier, '상품 등록 검증 업무를 읽기 전용으로 수행하는 역할', REGISTRATION_VERIFIER_TOOLS);

    const snapshot = {
      org_units: [{ slug: SEED_SLUGS.unit }],
      roles: [
        { slug: SEED_SLUGS.generalist, version: 1, lifecycle: 'active' },
        { slug: SEED_SLUGS.registrationVerifier, version: 1, lifecycle: 'active' },
      ],
    };
    tx.run('INSERT INTO org_version (id, parent_id, proposal_id, snapshot, status, created_at) VALUES (?, NULL, NULL, ?, ?, ?)', [
      SEED_IDS.orgVersion, JSON.stringify(snapshot), 'active', now,
    ]);

    tx.run(
      'INSERT INTO policy_version (id, content_hash, change_class, approved_by, deployed_at, rollback_of) VALUES (?, ?, ?, ?, ?, NULL)',
      [SEED_IDS.policy, policyV1ContentHash(), 'normal', JSON.stringify([SEED_IDS.owner]), now],
    );
    return { applied: true, ids: SEED_IDS };
  });
}

/** 가장 최근에 배포된 policy_version 의 id. 없으면 null (업무를 만들 수 없다). */
export function currentPolicyVersionId(db: Db): string | null {
  return db.get<{ id: string }>('SELECT id FROM policy_version ORDER BY deployed_at DESC, rowid DESC LIMIT 1')?.id ?? null;
}

export interface TaskCreationPrerequisites {
  ok: boolean;
  /** 비어 있는 전제. 예: `policy_version` */
  missing: string[];
}

/**
 * 업무 생성(A2)의 데이터 전제: `task.policy_version_id` 가 NOT NULL 이므로 policy_version 이 있어야 하고,
 * 업무는 trial/active 역할에만 배정되므로 그런 역할이 있어야 `queued` 로 만들 수 있다.
 */
export function taskCreationPrerequisites(db: Db): TaskCreationPrerequisites {
  const missing: string[] = [];
  if (currentPolicyVersionId(db) === null) missing.push('policy_version');
  if (!db.get("SELECT 1 AS one FROM role WHERE lifecycle IN ('trial', 'active') LIMIT 1")) missing.push('assignable_role');
  return { ok: missing.length === 0, missing };
}
