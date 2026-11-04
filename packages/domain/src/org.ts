// 조직 변경 제안 (Phase B, ADR-0011, docs/plans/phase-b.md). `org_proposal` 행의 생성·검증·위험 분류·전이와, 승인된 diff 를 적용해 새 `org_version` 을 만드는 일을 맡는다.
//
// 1. 생성 (`createOrgProposal`): 제안자는 사람 또는 에이전트(제안만 한다). 내용 검증 → 금지 대상 거부 → 위험 분류 → 해시. id 는 해시에서 정해 같은 내용은 한 행이다(멱등).
//    - diff 는 `{ops: [...]}`. MVP 연산은 `add_role` 하나다(새 부서는 add_role 이 가리킬 때만). 정책·검증기·평가기·승인 엔진을 건드리는 연산·도구·역할 이름은 `forbidden_target` 으로 거부한다.
//    - 위험 분류는 코드가 정한다(제안자가 낮출 수 없다): 새 역할이 요청하는 (도구, 작업)이 지금 active 역할 어디에도 없으면 권한 확대 → `risky`.
//    - `evaluation_plan`·`rollback_plan`·`trial_scope`·`risk_assessment` 가 모두 있어야 한다(없으면 제안이 만들어지지 않는다 = 시험에 못 들어간다).
// 2. 전이 (`transitionOrgProposal`): ORG_PROPOSAL_MACHINE 허용표를 따른다(에이전트는 어떤 전이도 못 일으킨다). 전이마다 부수 효과를 같은 트랜잭션에서 한다:
//    - proposed → approved: 기준 버전이 현재 active 와 같아야 하고 만료 전이어야 한다. 승인 기록(approval) 필수.
//    - approved → trial: diff 적용. 새 역할은 `trial`(trial_scope.task_types 만 받는다), 새 부서는 `trial`, 새 `org_version`(status `trial`, parent = 기준 버전).
//    - trial → active: 새 역할·부서 `active`, 이전 active 버전 `retired`, 새 버전 `active`. 평가 `pass` 기록과 사람 확인(approval) 필요.
//    - trial → rolled_back / active → rolled_back: 새 역할·부서 `retired`(삭제 아님), 새 부서의 루틴 끔, 대기 업무를 `rollback_plan.queued_tasks.reroute_to` 역할로 옮김,
//      직전 버전을 active 로 복구(active 였던 경우), 새 버전 `rolled_back`. 이미 발생한 외부 부작용은 건드리지 않는다.
//    - trial → inconclusive: 평가 `inconclusive` 기록 필요. inconclusive → trial: 사람, 새 평가 계획 필수, 연장 상한(ORG_MAX_TRIAL_EXTENSIONS) 안에서 trial_extensions 증가.
//    - proposed → rejected / expired / superseded, active → retired(새 역할·부서 retired).
// 시각은 주입된 Clock 에서만 얻고, 쓰기 함수는 Db.writeTx 안에서만 동작한다.
import { canonicalJson, contentHash } from './canonical.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db/types.ts';
import type { ChangeClass, OrgProposalStatus } from './entities/enums.ts';
import type { OrgProposalRow, OrgVersionRow, RoleRow } from './entities/rows.ts';
import { assertTransition, type TransitionActor } from './state/machine.ts';
import { ORG_PROPOSAL_MACHINE } from './state/machines.ts';
import { isNonBlankString, isPlainObject, type PlainObject } from './validation.ts';

export const ORG_MAX_TRIAL_EXTENSIONS = 1;
export const ORG_DEFAULT_PROPOSAL_TTL_DAYS = 14;
export const ORG_DEFAULT_TRIAL_MIN_DAYS = 14;
export const ORG_MAX_OPS = 5;
export const ORG_MAX_TEXT_CHARS = 2000;
/** 재편 신호 후보 임계값 (Q13 잠정값, phase-b.md) */
export const ORG_SIGNAL_THRESHOLDS = { unassigned: 3, role_problems: 3, window_days: 30 } as const;
export const ORG_EVENT = { source: 'org-proposal' } as const;

const SLUG = /^[a-z][a-z0-9-]{1,40}$/;
/** 고정 코어를 가리키는 이름: 연산·도구·역할/부서 slug 에 들어 있으면 거부한다 */
const FORBIDDEN_WORDS = ['policy', 'approval', 'evaluator', 'evaluation', 'validator', 'verifier', 'org-management', 'org_management'];
const FORBIDDEN_TOOL_PREFIXES = ['policy', 'approval', 'evaluator', 'evaluation', 'validator', 'verifier', 'org', 'approve'];
const DAY_MS = 86_400_000;

export type OrgRuleCode =
  | 'agent_forbidden'
  | 'invalid_field'
  | 'forbidden_target'
  | 'unknown_actor'
  | 'not_human'
  | 'not_found'
  | 'stale_state'
  | 'conflict'
  | 'expired'
  | 'approval_missing'
  | 'result_missing'
  | 'extension_limit'
  | 'reason_required';

export class OrgRuleError extends Error {
  readonly code: OrgRuleCode;
  constructor(code: OrgRuleCode, message: string) {
    super(message);
    this.name = 'OrgRuleError';
    this.code = code;
  }
}

// ===== 입력 모양 =====

export interface OrgRoleTool {
  tool: string;
  operations: string[];
}
export interface OrgAddRoleOp {
  op: 'add_role';
  role: { slug: string; description: string; allowed_tools: OrgRoleTool[]; unit: string | { slug: string; name: string; responsibility: string } };
}
export interface OrgDiff {
  ops: OrgAddRoleOp[];
}
export interface OrgEvaluationPlan {
  /** 시험 업무 중 평가 pass 의 최소 비율 (0~1) */
  min_pass_rate: number;
  /** 최소 관측(시험 업무 완료·종료 수) */
  min_observations: number;
  /** 허용 비용(시험 업무 합계 USD). 넘으면 즉시 중단 */
  max_cost_usd: number;
  /** 비교 기준선: 시험 전 같은 업무 유형의 평가 기간(일) */
  baseline_window_days: number;
  /** 평가 기간(일) — 최소 시험 기간 이상 */
  evaluation_days: number;
}
export interface OrgRollbackPlan {
  org_version: 'restore_parent';
  routines: 'disable';
  /** 새 역할에 배정된 대기(queued) 업무를 옮길 기존 역할 slug (active) */
  queued_tasks: { reroute_to: string };
  running_tasks: 'finish';
  external_effects: 'human';
}
export interface OrgRiskAssessment {
  risks: string[];
  mitigations: string[];
}
export interface OrgTrialScope {
  task_types: string[];
}

export interface OrgProposalInput {
  proposedBy: string;
  diff: unknown;
  rationale: string;
  evidenceRefs: unknown;
  expectedEffect: string;
  riskAssessment: unknown;
  evaluationPlan: unknown;
  rollbackPlan: unknown;
  trialScope: unknown;
  trialMinDays?: number;
  ttlDays?: number;
}

export interface OrgProposalResult {
  created: boolean;
  proposalId: string;
  proposalHash: string;
  changeClass: ChangeClass;
  riskReasons: string[];
}

/** 업무 유형: 루틴 트리거의 ref 에서 `@` 앞 이름(루틴 slug), 그 밖의 트리거는 `manual` (phase-b.md 잠정 결정) */
export function taskTypeOf(trigger: { kind: string; ref: string }): string {
  return trigger.kind === 'routine' ? (trigger.ref.split('@')[0] ?? '') : 'manual';
}

const bad = (message: string): never => {
  throw new OrgRuleError('invalid_field', message);
};
const forbidden = (message: string): never => {
  throw new OrgRuleError('forbidden_target', message);
};

function text(value: unknown, field: string, max = ORG_MAX_TEXT_CHARS): string {
  if (!isNonBlankString(value)) return bad(`${field} must be a non-empty string`);
  if (value.length > max) return bad(`${field} is too long (max ${max} characters)`);
  return value;
}
function stringList(value: unknown, field: string, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some((item) => !isNonBlankString(item) || item.length > 500)) {
    return bad(`${field} must be a list of ${min}..${max} non-empty strings (each ≤ 500 characters)`);
  }
  return [...(value as string[])];
}
function exactKeys(value: PlainObject, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) bad(`${field} has unknown field(s): ${unknown.join(', ')}`);
}
function plain(value: unknown, field: string): PlainObject {
  return isPlainObject(value) ? value : bad(`${field} must be an object`);
}
function num(value: unknown, field: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    return bad(`${field} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
  }
  return value;
}
const mentionsForbidden = (name: string): boolean => FORBIDDEN_WORDS.some((word) => name.toLowerCase().includes(word));

export function parseOrgDiff(raw: unknown): OrgDiff {
  const body = plain(raw, 'diff');
  exactKeys(body, ['ops'], 'diff');
  if (!Array.isArray(body['ops']) || body['ops'].length < 1 || body['ops'].length > ORG_MAX_OPS) return bad(`diff.ops must list 1..${ORG_MAX_OPS} operations`);
  const ops: OrgAddRoleOp[] = [];
  body['ops'].forEach((rawOp: unknown, index: number) => {
    const path = `diff.ops[${index}]`;
    const op = plain(rawOp, path);
    const name = typeof op['op'] === 'string' ? op['op'] : '';
    if (mentionsForbidden(name)) forbidden(`${path}: '${name}' targets a fixed core component (policy, verifier, evaluator, approval engine); change it through the policy change procedure`);
    if (name !== 'add_role') return bad(`${path}.op must be 'add_role' (the only supported operation)`);
    exactKeys(op, ['op', 'role'], path);
    const role = plain(op['role'], `${path}.role`);
    exactKeys(role, ['slug', 'description', 'allowed_tools', 'unit'], `${path}.role`);
    const slug = typeof role['slug'] === 'string' && SLUG.test(role['slug']) ? role['slug'] : bad(`${path}.role.slug must match ${String(SLUG)}`);
    if (mentionsForbidden(slug)) forbidden(`${path}.role.slug '${slug}' imitates a fixed core component`);
    const tools: OrgRoleTool[] = [];
    if (!Array.isArray(role['allowed_tools']) || role['allowed_tools'].length > 20) return bad(`${path}.role.allowed_tools must be a list of ≤ 20 tools`);
    role['allowed_tools'].forEach((rawTool: unknown, toolIndex: number) => {
      const toolPath = `${path}.role.allowed_tools[${toolIndex}]`;
      const tool = plain(rawTool, toolPath);
      exactKeys(tool, ['tool', 'operations'], toolPath);
      const toolName = text(tool['tool'], `${toolPath}.tool`, 80);
      if (FORBIDDEN_TOOL_PREFIXES.some((prefix) => toolName.toLowerCase() === prefix || toolName.toLowerCase().startsWith(`${prefix}.`) || toolName.toLowerCase().startsWith(`${prefix}_`))) {
        forbidden(`${toolPath}.tool '${toolName}' is a control-plane tool; roles cannot request it`);
      }
      tools.push({ tool: toolName, operations: stringList(tool['operations'], `${toolPath}.operations`, 1, 20) });
    });
    let unit: OrgAddRoleOp['role']['unit'];
    if (typeof role['unit'] === 'string') {
      unit = SLUG.test(role['unit']) ? role['unit'] : bad(`${path}.role.unit must be a unit slug`);
    } else {
      const newUnit = plain(role['unit'], `${path}.role.unit`);
      exactKeys(newUnit, ['slug', 'name', 'responsibility'], `${path}.role.unit`);
      const unitSlug = typeof newUnit['slug'] === 'string' && SLUG.test(newUnit['slug']) ? newUnit['slug'] : bad(`${path}.role.unit.slug must match ${String(SLUG)}`);
      if (mentionsForbidden(unitSlug)) forbidden(`${path}.role.unit.slug '${unitSlug}' imitates a fixed core component`);
      unit = { slug: unitSlug, name: text(newUnit['name'], `${path}.role.unit.name`, 120), responsibility: text(newUnit['responsibility'], `${path}.role.unit.responsibility`) };
    }
    ops.push({ op: 'add_role', role: { slug, description: text(role['description'], `${path}.role.description`), allowed_tools: tools, unit } });
  });
  const slugs = ops.map((op) => op.role.slug);
  if (new Set(slugs).size !== slugs.length) return bad('diff.ops adds the same role slug twice');
  return { ops };
}

export function parseEvaluationPlan(raw: unknown, trialMinDays: number): OrgEvaluationPlan {
  const plan = plain(raw, 'evaluation_plan');
  exactKeys(plan, ['min_pass_rate', 'min_observations', 'max_cost_usd', 'baseline_window_days', 'evaluation_days'], 'evaluation_plan');
  return {
    min_pass_rate: num(plan['min_pass_rate'], 'evaluation_plan.min_pass_rate', 0.5, 1),
    min_observations: num(plan['min_observations'], 'evaluation_plan.min_observations', 1, 1000, true),
    max_cost_usd: num(plan['max_cost_usd'], 'evaluation_plan.max_cost_usd', 0, 100_000),
    baseline_window_days: num(plan['baseline_window_days'], 'evaluation_plan.baseline_window_days', 1, 365, true),
    evaluation_days: num(plan['evaluation_days'], 'evaluation_plan.evaluation_days', trialMinDays, 365, true),
  };
}

export function parseRollbackPlan(db: Db, raw: unknown): OrgRollbackPlan {
  const plan = plain(raw, 'rollback_plan');
  exactKeys(plan, ['org_version', 'routines', 'queued_tasks', 'running_tasks', 'external_effects'], 'rollback_plan');
  const fixed = (key: string, value: string): void => {
    if (plan[key] !== value) bad(`rollback_plan.${key} must be '${value}' (the only supported handling)`);
  };
  fixed('org_version', 'restore_parent');
  fixed('routines', 'disable');
  fixed('running_tasks', 'finish');
  fixed('external_effects', 'human');
  const queued = plain(plan['queued_tasks'], 'rollback_plan.queued_tasks');
  exactKeys(queued, ['reroute_to'], 'rollback_plan.queued_tasks');
  const target = text(queued['reroute_to'], 'rollback_plan.queued_tasks.reroute_to', 80);
  if (!db.get("SELECT 1 AS one FROM role WHERE slug = ? AND lifecycle = 'active'", [target])) bad(`rollback_plan.queued_tasks.reroute_to '${target}' is not an active role`);
  return { org_version: 'restore_parent', routines: 'disable', queued_tasks: { reroute_to: target }, running_tasks: 'finish', external_effects: 'human' };
}

function parseTrialScope(raw: unknown): OrgTrialScope {
  const scope = plain(raw, 'trial_scope');
  exactKeys(scope, ['task_types'], 'trial_scope');
  const types = stringList(scope['task_types'], 'trial_scope.task_types', 1, 10);
  if (types.some((type) => !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(type))) bad('trial_scope.task_types entries must be routine slugs or "manual"');
  return { task_types: [...new Set(types)].sort() };
}

function parseRiskAssessment(raw: unknown): OrgRiskAssessment {
  const risk = plain(raw, 'risk_assessment');
  exactKeys(risk, ['risks', 'mitigations'], 'risk_assessment');
  return { risks: stringList(risk['risks'], 'risk_assessment.risks', 1, 20), mitigations: stringList(risk['mitigations'], 'risk_assessment.mitigations', 1, 20) };
}

// ===== 현재 조직 =====

export function activeOrgVersion(db: Db): OrgVersionRow | undefined {
  return db.get<OrgVersionRow>("SELECT * FROM org_version WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1");
}

/** 지금 active 역할이 요청하는 (도구, 작업) 집합 — 새 역할이 이 안이면 권한 확대가 아니다 */
function grantedToolPairs(db: Db): Set<string> {
  const pairs = new Set<string>();
  for (const role of db.all<{ allowed_tools: string }>("SELECT allowed_tools FROM role WHERE lifecycle = 'active'")) {
    let tools: unknown;
    try {
      tools = JSON.parse(role.allowed_tools);
    } catch {
      continue;
    }
    if (!Array.isArray(tools)) continue;
    for (const entry of tools) {
      if (!isPlainObject(entry) || typeof entry['tool'] !== 'string' || !Array.isArray(entry['operations'])) continue;
      for (const operation of entry['operations']) pairs.add(`${entry['tool']}.${String(operation)}`);
    }
  }
  return pairs;
}

/** 위험 분류: 새 역할이 지금 어느 active 역할도 요청하지 않는 (도구, 작업)을 요청하면 risky */
export function classifyOrgDiff(db: Db, diff: OrgDiff): { changeClass: ChangeClass; reasons: string[] } {
  const granted = grantedToolPairs(db);
  const reasons: string[] = [];
  for (const { role } of diff.ops) {
    for (const tool of role.allowed_tools) {
      for (const operation of tool.operations) {
        if (!granted.has(`${tool.tool}.${operation}`)) reasons.push(`role '${role.slug}' requests '${tool.tool}.${operation}', which no active role has (permission expansion)`);
      }
    }
  }
  return { changeClass: reasons.length > 0 ? 'risky' : 'normal', reasons };
}

export const orgProposalHash = (parts: {
  diff: OrgDiff; base: string; trialScope: OrgTrialScope; evaluationPlan: OrgEvaluationPlan; rollbackPlan: OrgRollbackPlan; changeClass: ChangeClass; trialMinDays: number;
}): string => contentHash({
  diff: parts.diff, base_org_version_id: parts.base, trial_scope: parts.trialScope, evaluation_plan: parts.evaluationPlan,
  rollback_plan: parts.rollbackPlan, change_class: parts.changeClass, trial_min_days: parts.trialMinDays,
});

const proposalIdOf = (hash: string): string => `org-proposal-${hash.slice(0, 32)}`;

function requireActor(db: Db, actorId: string): { kind: string } {
  return db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId]) ?? ((): never => { throw new OrgRuleError('unknown_actor', `unknown actor '${actorId}'`); })();
}

/** 제안을 만든다 (멱등). 쓰기 트랜잭션 안에서 부른다 */
export function createOrgProposal(tx: Db, clock: Clock, input: OrgProposalInput): OrgProposalResult {
  requireActor(tx, input.proposedBy);
  const base = activeOrgVersion(tx) ?? ((): never => { throw new OrgRuleError('not_found', 'there is no active org_version to base a proposal on'); })();
  const trialMinDays = input.trialMinDays === undefined ? ORG_DEFAULT_TRIAL_MIN_DAYS : num(input.trialMinDays, 'trial_min_days', 7, 90, true);
  const ttlDays = input.ttlDays === undefined ? ORG_DEFAULT_PROPOSAL_TTL_DAYS : num(input.ttlDays, 'ttl_days', 1, 90, true);
  const diff = parseOrgDiff(input.diff);
  const trialScope = parseTrialScope(input.trialScope);
  const evaluationPlan = parseEvaluationPlan(input.evaluationPlan, trialMinDays);
  const rollbackPlan = parseRollbackPlan(tx, input.rollbackPlan);
  const riskAssessment = parseRiskAssessment(input.riskAssessment);
  const rationale = text(input.rationale, 'rationale');
  const expectedEffect = text(input.expectedEffect, 'expected_effect');
  const evidenceRefs = stringList(input.evidenceRefs, 'evidence_refs', 1, 30);

  for (const { role } of diff.ops) {
    if (tx.get('SELECT 1 AS one FROM role WHERE slug = ?', [role.slug])) bad(`role '${role.slug}' already exists`);
    if (typeof role.unit === 'string') {
      if (!tx.get("SELECT 1 AS one FROM org_unit WHERE slug = ? AND lifecycle = 'active'", [role.unit])) bad(`unit '${role.unit}' is not an active unit`);
    } else if (tx.get('SELECT 1 AS one FROM org_unit WHERE slug = ?', [role.unit.slug])) {
      bad(`unit '${role.unit.slug}' already exists; refer to it by slug`);
    }
  }
  const { changeClass, reasons } = classifyOrgDiff(tx, diff);
  const proposalHash = orgProposalHash({ diff, base: base.id, trialScope, evaluationPlan, rollbackPlan, changeClass, trialMinDays });
  const id = proposalIdOf(proposalHash);
  if (tx.get('SELECT 1 AS one FROM org_proposal WHERE id = ?', [id])) return { created: false, proposalId: id, proposalHash, changeClass, riskReasons: reasons };

  const now = clock.nowIso();
  const scope = { roles: diff.ops.map((op) => op.role.slug), task_types: trialScope.task_types };
  tx.run(
    `INSERT INTO org_proposal (id, proposed_by, diff, rationale, evidence_refs, expected_effect, base_org_version_id, proposal_hash, scope, risk_assessment,
       evaluation_plan, rollback_plan, change_class, trial_scope, trial_min_days, trial_extensions, expires_at, status, org_version_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'proposed', NULL, ?)`,
    [
      id, input.proposedBy, canonicalJson(diff), rationale, JSON.stringify(evidenceRefs), expectedEffect, base.id, proposalHash, canonicalJson(scope),
      canonicalJson(riskAssessment), canonicalJson(evaluationPlan), canonicalJson(rollbackPlan), changeClass, canonicalJson(trialScope), trialMinDays,
      new Date(Date.parse(now) + ttlDays * DAY_MS).toISOString(), now,
    ],
  );
  writeOrgEvent(tx, now, 'org.proposal.created', id, { proposal_id: id, proposed_by: input.proposedBy, change_class: changeClass, reasons });
  return { created: true, proposalId: id, proposalHash, changeClass, riskReasons: reasons };
}

function writeOrgEvent(tx: Db, now: string, type: string, key: string, payload: Record<string, unknown>): void {
  const idempotencyKey = `${type}:${key}:${now}`;
  tx.run(
    `INSERT OR IGNORE INTO event (id, source, external_id, type, payload, product_id, idempotency_key, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [`event-${contentHash({ idempotencyKey }).slice(0, 32)}`, ORG_EVENT.source, key, type, JSON.stringify(payload), idempotencyKey, now, now],
  );
}

export function getOrgProposal(db: Db, id: string): OrgProposalRow | undefined {
  return db.get<OrgProposalRow>('SELECT * FROM org_proposal WHERE id = ?', [id]);
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

export interface OrgTransitionRequest {
  proposalId: string;
  to: OrgProposalStatus;
  by: TransitionActor;
  /** 사람 행위자(actor id). `by='human'` 이면 필수 */
  actorId?: string;
  approvalId?: string;
  reason?: string;
  /** inconclusive → trial: 새 평가 계획 */
  evaluationPlan?: unknown;
}

export interface OrgTransitionResult {
  from: OrgProposalStatus;
  to: OrgProposalStatus;
  orgVersionId: string | null;
  /** 롤백으로 옮긴 대기 업무 id */
  reroutedTaskIds: string[];
  disabledRoutineIds: string[];
}

/** 한 전이를 한 트랜잭션에서 한다 (허용표 → 조건 → 부수 효과). 쓰기 트랜잭션 안에서 부른다 */
export function transitionOrgProposal(tx: Db, clock: Clock, request: OrgTransitionRequest): OrgTransitionResult {
  if (request.by === 'agent') throw new OrgRuleError('agent_forbidden', 'agents cannot change an organization proposal; they only propose');
  const row = getOrgProposal(tx, request.proposalId) ?? ((): never => { throw new OrgRuleError('not_found', `org_proposal '${request.proposalId}' does not exist`); })();
  const from = row.status;
  if (request.by === 'human') {
    const kind = requireActor(tx, request.actorId ?? '').kind;
    if (kind !== 'human') throw new OrgRuleError('not_human', `only a human actor can do this; '${request.actorId}' is '${kind}'`);
  }
  assertTransition(ORG_PROPOSAL_MACHINE, { from, to: request.to, by: request.by, reason: request.reason ?? null, approvalId: request.approvalId ?? null });
  const now = clock.nowIso();
  const result: OrgTransitionResult = { from, to: request.to, orgVersionId: row.org_version_id, reroutedTaskIds: [], disabledRoutineIds: [] };
  /** 사람의 `approved` 기록이 필요하다. `notBefore` 가 있으면 그 시각 *뒤*의 기록이어야 한다(예전 승인 기록을 확인·재시험에 재사용하지 못하게) */
  const humanOnly = (what: string, notBefore?: string): void => {
    if (!isNonBlankString(request.approvalId)) throw new OrgRuleError('approval_missing', `${what} needs a human approval record`);
    const approval = tx.get<{ decision: string; kind: string | null; at: string }>(
      `SELECT a.decision, actor.kind, a.at FROM approval a LEFT JOIN actor ON actor.id = a.decided_by
       WHERE a.id = ? AND a.subject_kind = 'org_proposal' AND a.subject_id = ?`,
      [request.approvalId, row.id],
    );
    if (!approval || approval.decision !== 'approved' || approval.kind !== 'human') {
      throw new OrgRuleError('approval_missing', `approval '${request.approvalId}' is not a human approval of org_proposal '${row.id}'`);
    }
    if (notBefore !== undefined && approval.at < notBefore) {
      throw new OrgRuleError('approval_missing', `approval '${request.approvalId}' predates the trial result it should confirm; a person must decide after seeing the result`);
    }
  };

  switch (`${from}>${request.to}`) {
    case 'proposed>approved': {
      if (now >= row.expires_at) throw new OrgRuleError('expired', `org_proposal '${row.id}' expired at ${row.expires_at}`);
      const current = activeOrgVersion(tx);
      if (!current || current.id !== row.base_org_version_id) {
        throw new OrgRuleError('conflict', `org_proposal '${row.id}' is based on org_version '${row.base_org_version_id}', but the active version is '${current?.id ?? '(none)'}'; propose again on the latest version`);
      }
      humanOnly('approving a proposal');
      break;
    }
    case 'proposed>rejected':
      if (!isNonBlankString(request.reason)) throw new OrgRuleError('reason_required', 'a reason is required to reject a proposal');
      break;
    case 'approved>trial': {
      result.orgVersionId = applyDiffAsTrial(tx, now, row);
      break;
    }
    case 'trial>active': {
      const latest = latestTrialResult(tx, row.id);
      if (latest?.outcome !== 'pass') throw new OrgRuleError('result_missing', `org_proposal '${row.id}' has no passing trial result`);
      humanOnly('confirming a trial', latest.at);
      result.orgVersionId = activateVersion(tx, row);
      break;
    }
    case 'trial>inconclusive': {
      if (latestTrialResult(tx, row.id)?.outcome !== 'inconclusive') throw new OrgRuleError('result_missing', `org_proposal '${row.id}' has no inconclusive trial result`);
      retireAddedRoles(tx, row); // 재시험 승인 전까지 종료로 취급: 새 역할은 업무를 더 받지 않는다 (재시험 때 되살린다)
      break;
    }
    case 'trial>rolled_back':
    case 'active>rolled_back': {
      if (from === 'trial' && latestTrialResult(tx, row.id)?.outcome !== 'fail') {
        throw new OrgRuleError('result_missing', `org_proposal '${row.id}' has no failing trial result`);
      }
      if (from === 'active' && !isNonBlankString(request.reason)) throw new OrgRuleError('reason_required', 'a reason is required to roll back an active change');
      const undone = undoApplied(tx, now, row, from === 'active');
      result.reroutedTaskIds = undone.rerouted;
      result.disabledRoutineIds = undone.routines;
      break;
    }
    case 'inconclusive>trial': {
      if (row.trial_extensions >= ORG_MAX_TRIAL_EXTENSIONS) throw new OrgRuleError('extension_limit', `org_proposal '${row.id}' already used its ${ORG_MAX_TRIAL_EXTENSIONS} trial extension`);
      if (request.evaluationPlan === undefined) throw new OrgRuleError('invalid_field', 'a new evaluation plan is required to retry a trial');
      const plan = parseEvaluationPlan(request.evaluationPlan, row.trial_min_days);
      humanOnly('retrying a trial', latestTrialResult(tx, row.id)?.at);
      reviveAddedRoles(tx, row);
      tx.run('UPDATE org_proposal SET evaluation_plan = ?, trial_extensions = trial_extensions + 1 WHERE id = ?', [canonicalJson(plan), row.id]);
      break;
    }
    case 'active>retired': {
      if (!isNonBlankString(request.reason)) throw new OrgRuleError('reason_required', 'a reason is required to retire an active change');
      retireAddedRoles(tx, row);
      break;
    }
    default:
      break;
  }
  const changed = tx.run('UPDATE org_proposal SET status = ?, org_version_id = ? WHERE id = ? AND status = ?', [request.to, result.orgVersionId, row.id, from]);
  if (changed.changes !== 1) throw new OrgRuleError('stale_state', `org_proposal '${row.id}' is no longer '${from}'`);
  writeOrgEvent(tx, now, `org.proposal.${request.to}`, row.id, {
    proposal_id: row.id, from, to: request.to, by: request.by, actor_id: request.actorId ?? null, approval_id: request.approvalId ?? null, reason: request.reason ?? null,
    org_version_id: result.orgVersionId, rerouted_task_ids: result.reroutedTaskIds, disabled_routine_ids: result.disabledRoutineIds,
  });
  return result;
}

export function latestTrialResult(db: Db, proposalId: string): { outcome: string; abort_reason: string | null; at: string } | undefined {
  return db.get<{ outcome: string; abort_reason: string | null; at: string }>(
    'SELECT outcome, abort_reason, at FROM org_trial_result WHERE proposal_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', [proposalId],
  );
}

// ===== diff 적용 =====

const unitSlugsCreatedBy = (diff: OrgDiff): string[] => diff.ops.flatMap((op) => (typeof op.role.unit === 'string' ? [] : [op.role.unit.slug]));

function applyDiffAsTrial(tx: Db, now: string, row: OrgProposalRow): string {
  const diff = parseOrgDiff(parseJson(row.diff));
  const trialScope = parseJson<OrgTrialScope>(row.trial_scope);
  const base = tx.get<OrgVersionRow>('SELECT * FROM org_version WHERE id = ?', [row.base_org_version_id]);
  if (!base || base.status !== 'active') throw new OrgRuleError('conflict', `base org_version '${row.base_org_version_id}' is no longer active`);
  const versionId = `org-version-${contentHash({ proposal: row.id, at: 'trial' }).slice(0, 24)}`;
  for (const { role } of diff.ops) {
    let unitId: string;
    if (typeof role.unit === 'string') {
      unitId = tx.get<{ id: string }>('SELECT id FROM org_unit WHERE slug = ?', [role.unit])?.id ?? ((): never => { throw new OrgRuleError('conflict', `unit '${String(role.unit)}' no longer exists`); })();
    } else {
      unitId = `unit-${contentHash({ proposal: row.id, unit: role.unit.slug }).slice(0, 24)}`;
      tx.run('INSERT INTO org_unit (id, parent_id, slug, lifecycle, name, responsibility, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)', [
        unitId, role.unit.slug, 'trial', role.unit.name, role.unit.responsibility, now,
      ]);
    }
    tx.run(
      'INSERT INTO role (id, org_unit_id, slug, description, allowed_tools, lifecycle, version, trial_scope, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [`role-${contentHash({ proposal: row.id, role: role.slug }).slice(0, 24)}`, unitId, role.slug, role.description, canonicalJson(role.allowed_tools), 'trial', canonicalJson(trialScope), now],
    );
  }
  const snapshot = parseJson<{ org_units?: unknown[]; roles?: unknown[] }>(base.snapshot);
  const nextSnapshot = {
    org_units: [...(snapshot.org_units ?? []), ...unitSlugsCreatedBy(diff).map((slug) => ({ slug, lifecycle: 'trial' }))],
    roles: [...(snapshot.roles ?? []), ...diff.ops.map((op) => ({ slug: op.role.slug, version: 1, lifecycle: 'trial' }))],
  };
  tx.run('INSERT INTO org_version (id, parent_id, proposal_id, snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    versionId, base.id, row.id, canonicalJson(nextSnapshot), 'trial', now,
  ]);
  return versionId;
}

function addedSlugs(row: OrgProposalRow): { roles: string[]; units: string[] } {
  const diff = parseOrgDiff(parseJson(row.diff));
  return { roles: diff.ops.map((op) => op.role.slug), units: unitSlugsCreatedBy(diff) };
}

function activateVersion(tx: Db, row: OrgProposalRow): string {
  const versionId = row.org_version_id ?? ((): never => { throw new OrgRuleError('not_found', `org_proposal '${row.id}' has no trial org_version`); })();
  const current = activeOrgVersion(tx);
  if (!current || current.id !== row.base_org_version_id) {
    throw new OrgRuleError('conflict', `the active org_version changed since the trial began (now '${current?.id ?? '(none)'}'); roll the trial back and propose again`);
  }
  const { roles, units } = addedSlugs(row);
  for (const slug of roles) tx.run("UPDATE role SET lifecycle = 'active' WHERE slug = ? AND lifecycle = 'trial'", [slug]);
  for (const slug of units) tx.run("UPDATE org_unit SET lifecycle = 'active' WHERE slug = ? AND lifecycle = 'trial'", [slug]);
  const snapshot = parseJson<{ org_units?: Array<{ slug: string; lifecycle?: string }>; roles?: Array<{ slug: string; lifecycle?: string }> }>(
    tx.get<{ snapshot: string }>('SELECT snapshot FROM org_version WHERE id = ?', [versionId])!.snapshot,
  );
  const activated = {
    org_units: (snapshot.org_units ?? []).map((unit) => (units.includes(unit.slug) ? { ...unit, lifecycle: 'active' } : unit)),
    roles: (snapshot.roles ?? []).map((role) => (roles.includes(role.slug) ? { ...role, lifecycle: 'active' } : role)),
  };
  tx.run("UPDATE org_version SET status = 'retired' WHERE id = ? AND status = 'active'", [current.id]);
  tx.run("UPDATE org_version SET status = 'active', snapshot = ? WHERE id = ? AND status = 'trial'", [canonicalJson(activated), versionId]);
  return versionId;
}

function retireAddedRoles(tx: Db, row: OrgProposalRow): { roles: string[]; units: string[] } {
  const { roles, units } = addedSlugs(row);
  for (const slug of roles) tx.run("UPDATE role SET lifecycle = 'retired' WHERE slug = ? AND lifecycle IN ('trial', 'active')", [slug]);
  for (const slug of units) tx.run("UPDATE org_unit SET lifecycle = 'retired' WHERE slug = ? AND lifecycle IN ('trial', 'active')", [slug]);
  return { roles, units };
}

function reviveAddedRoles(tx: Db, row: OrgProposalRow): void {
  const { roles, units } = addedSlugs(row);
  for (const slug of roles) tx.run("UPDATE role SET lifecycle = 'trial' WHERE slug = ? AND lifecycle = 'retired'", [slug]);
  for (const slug of units) tx.run("UPDATE org_unit SET lifecycle = 'trial' WHERE slug = ? AND lifecycle = 'retired'", [slug]);
}

function undoApplied(tx: Db, now: string, row: OrgProposalRow, wasActive: boolean): { rerouted: string[]; routines: string[] } {
  const { roles, units } = retireAddedRoles(tx, row);
  const rollback = parseJson<OrgRollbackPlan>(row.rollback_plan);
  const target = tx.get<{ id: string; version: number; org_unit_id: string }>("SELECT id, version, org_unit_id FROM role WHERE slug = ? AND lifecycle = 'active'", [rollback.queued_tasks.reroute_to]);
  const rerouted: string[] = [];
  const routines: string[] = [];
  for (const slug of units) {
    const unit = tx.get<{ id: string }>('SELECT id FROM org_unit WHERE slug = ?', [slug]);
    if (!unit) continue;
    for (const routine of tx.all<{ id: string }>('SELECT id FROM routine WHERE org_unit_id = ? AND enabled = 1 ORDER BY id', [unit.id])) {
      tx.run('UPDATE routine SET enabled = 0 WHERE id = ?', [routine.id]);
      routines.push(routine.id);
    }
  }
  for (const slug of roles) {
    const role = tx.get<RoleRow>('SELECT * FROM role WHERE slug = ?', [slug]);
    if (!role || !target) continue;
    for (const task of tx.all<{ id: string; spec: string }>("SELECT id, spec FROM task WHERE role_id = ? AND status = 'queued' ORDER BY id", [role.id])) {
      const spec = parseJson<Record<string, unknown>>(task.spec);
      const versions = isPlainObject(spec['versions']) ? { ...spec['versions'], role_version: Number(target.version) } : spec['versions'];
      const next = { ...spec, role: rollback.queued_tasks.reroute_to, versions };
      delete (next as Record<string, unknown>)['department'];
      tx.run('UPDATE task SET role_id = ?, role_version = ?, org_unit_id = ?, spec = ?, updated_at = ? WHERE id = ? AND status = ?', [
        target.id, Number(target.version), target.org_unit_id, JSON.stringify(next), now, task.id, 'queued',
      ]);
      rerouted.push(task.id);
    }
  }
  const versionId = row.org_version_id;
  if (versionId) {
    tx.run("UPDATE org_version SET status = 'rolled_back' WHERE id = ?", [versionId]);
    if (wasActive) {
      const parent = tx.get<{ parent_id: string | null }>('SELECT parent_id FROM org_version WHERE id = ?', [versionId]);
      if (parent?.parent_id) tx.run("UPDATE org_version SET status = 'active' WHERE id = ? AND status = 'retired'", [parent.parent_id]);
    }
  }
  return { rerouted, routines };
}

/** 만료된 `proposed` 제안을 `expired` 로 한다 (시스템). 만료 처리한 id 를 돌려준다 */
export function expireOrgProposals(tx: Db, clock: Clock): string[] {
  const now = clock.nowIso();
  const expired = tx.all<{ id: string }>("SELECT id FROM org_proposal WHERE status = 'proposed' AND expires_at <= ? ORDER BY id", [now]);
  for (const { id } of expired) transitionOrgProposal(tx, clock, { proposalId: id, to: 'expired', by: 'system', reason: 'expires_at passed' });
  return expired.map((item) => item.id);
}

/** 기준 버전이 더 이상 active 가 아닌 `proposed` 제안을 `superseded` 로 한다 (시스템) */
export function supersedeStaleOrgProposals(tx: Db, clock: Clock): string[] {
  const current = activeOrgVersion(tx);
  if (!current) return [];
  const stale = tx.all<{ id: string }>("SELECT id FROM org_proposal WHERE status = 'proposed' AND base_org_version_id != ? ORDER BY id", [current.id]);
  for (const { id } of stale) transitionOrgProposal(tx, clock, { proposalId: id, to: 'superseded', by: 'system', reason: `base org_version is no longer active (now ${current.id})` });
  return stale.map((item) => item.id);
}
