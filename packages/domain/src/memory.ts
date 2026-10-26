// memory_item 신뢰·만료 규칙 (docs/schema/memory-item.md). 기억은 출처·신뢰 상태·유효 기간을 가진 지식이다.
//  - 현재 사실 = validity='valid' AND verification_status='verified' AND (valid_until 없음 또는 미경과)
//  - 반증/만료 항목은 현재 사실이 아니지만 삭제되지 않고 과거 관측으로 조회된다
//  - 외부 입력 유래(external_untrusted)는 hypothesis/unverified 로만 저장한다
//  - 에이전트는 kind != 'hypothesis' 를 쓸 수 없고, 스스로 검증됨(verified)으로 올릴 수도 없다
//  - 규칙 9: `source_ref` 가 외부 입력 유래 근거(`evidence:<id>`, evidence.trust_origin = external_untrusted)를 가리키면 항목도 external_untrusted 다(생략하면 물려받고, internal 이라 적으면 거부).
//    그러면 규칙 3 이 hypothesis/unverified 로만 저장하게 하므로, 외부 근거는 기억으로 편입되어도 현재 사실이 되지 않는다
//  - 규칙 8: `inconclusive` 평가 결과(source_ref = `evaluation:<id>`)는 lesson/strategy_record 로 저장하지 않는다 (성공·실패 어느 쪽 사례도 아니다)
// 시각은 주입된 Clock 이 SQL 파라미터로 넘긴다. 쓰기 함수는 Db.writeTx 안에서만 동작한다.
import { randomUUID } from 'node:crypto';

import type { Clock } from './clock.ts';
import type { Db } from './db/types.ts';
import {
  MEMORY_KINDS, MEMORY_VALIDITIES, SENSITIVITIES, TRUST_ORIGINS, VERIFICATION_STATUSES,
  type MemoryKind, type MemoryValidity, type Sensitivity, type TrustOrigin, type VerificationStatus,
} from './entities/enums.ts';
import type { MemoryItemRow } from './entities/rows.ts';

export type MemoryRuleCode =
  | 'invalid_field'
  | 'source_required'
  | 'observed_at_required'
  | 'unknown_actor'
  | 'external_must_be_hypothesis'
  | 'agent_kind_forbidden'
  | 'agent_cannot_verify'
  | 'inconclusive_not_learnable'
  | 'untrusted_evidence_origin'
  | 'not_found'
  | 'already_superseded';

export class MemoryRuleError extends Error {
  readonly code: MemoryRuleCode;
  constructor(code: MemoryRuleCode, message: string) {
    super(message);
    this.name = 'MemoryRuleError';
    this.code = code;
  }
}

export interface NewMemoryItem {
  kind: MemoryKind;
  body: string;
  /** evidence id / URL / 문서. 없으면 저장 거부 */
  source_ref: string;
  /** 실제로 관측한 시점 (기록 시점 created_at 과 구분) */
  observed_at: string;
  verification_status?: VerificationStatus;
  validity?: MemoryValidity;
  valid_until?: string | null;
  sensitivity?: Sensitivity;
  trust_origin?: TrustOrigin;
  product_id?: string | null;
  policy_version_id?: string | null;
  strategy_version_id?: string | null;
  /** actor.id */
  created_by: string;
}

export interface MemoryContext {
  clock: Clock;
  /** 시험용 id 생성기 */
  newId?: () => string;
  /**
   * 규칙 5: 변동성 높은 종류의 기본 만료 기간(초). `valid_until` 을 주지 않은 항목에 `observed_at + 기간` 을 채운다.
   * 값은 정책 파라미터(`memory.default_validity`)이며 `@aot/policy` 가 정책 문서에서 만든다. null 이면 기본 만료 없음.
   */
  defaultValiditySeconds?: (kind: MemoryKind) => number | null;
}

/** 평가 결과를 근거로 가리키는 `source_ref` 의 접두사 (규칙 8) */
export const EVALUATION_SOURCE_PREFIX = 'evaluation:';
/** 근거(evidence 행)를 가리키는 `source_ref` 의 접두사 (규칙 9) */
export const EVIDENCE_SOURCE_PREFIX = 'evidence:';
/** 학습(성공·실패 사례) 기록으로 쓰는 기억 종류 */
const LEARNING_KINDS: readonly MemoryKind[] = ['lesson', 'strategy_record'];

const isIso = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value);

function actorKind(db: Db, actorId: string): 'human' | 'agent' {
  const actor = db.get<{ kind: string }>('SELECT kind FROM actor WHERE id = ?', [actorId]);
  if (!actor) throw new MemoryRuleError('unknown_actor', `actor '${actorId}' does not exist`);
  return actor.kind as 'human' | 'agent';
}

function evidenceTrustOrigin(db: Db, evidenceId: string): TrustOrigin {
  const evidence = db.get<{ trust_origin: TrustOrigin }>('SELECT trust_origin FROM evidence WHERE id = ?', [evidenceId]);
  if (!evidence) throw new MemoryRuleError('invalid_field', `source_ref points at evidence '${evidenceId}', which does not exist`);
  return evidence.trust_origin;
}

/** 규칙을 모두 확인한 뒤 저장한다. 위반하면 아무것도 쓰지 않고 MemoryRuleError. */
export function createMemoryItem(tx: Db, input: NewMemoryItem, context: MemoryContext): MemoryItemRow {
  const kind = input.kind;
  // 규칙 9: 근거를 가리키는 항목은 그 근거의 신뢰 출처를 물려받는다 (명시한 값이 더 느슨하면 아래에서 거부)
  const evidenceTrust = typeof input.source_ref === 'string' && input.source_ref.startsWith(EVIDENCE_SOURCE_PREFIX)
    ? evidenceTrustOrigin(tx, input.source_ref.slice(EVIDENCE_SOURCE_PREFIX.length))
    : null;
  const trust: TrustOrigin = input.trust_origin ?? evidenceTrust ?? 'internal';
  const verification: VerificationStatus = input.verification_status ?? 'unverified';
  const validity: MemoryValidity = input.validity ?? 'valid';
  const sensitivity: Sensitivity = input.sensitivity ?? 'internal';
  const rawValidUntil = input.valid_until ?? null;

  if (!oneOf(MEMORY_KINDS, kind)) throw new MemoryRuleError('invalid_field', `unknown kind '${String(kind)}'`);
  if (!oneOf(TRUST_ORIGINS, trust)) throw new MemoryRuleError('invalid_field', `unknown trust_origin '${String(trust)}'`);
  if (!oneOf(VERIFICATION_STATUSES, verification)) throw new MemoryRuleError('invalid_field', `unknown verification_status '${String(verification)}'`);
  if (!oneOf(MEMORY_VALIDITIES, validity)) throw new MemoryRuleError('invalid_field', `unknown validity '${String(validity)}'`);
  if (!oneOf(SENSITIVITIES, sensitivity)) throw new MemoryRuleError('invalid_field', `unknown sensitivity '${String(sensitivity)}'`);
  if (typeof input.body !== 'string' || input.body.trim() === '') throw new MemoryRuleError('invalid_field', 'body must not be empty');
  if (typeof input.source_ref !== 'string' || input.source_ref.trim() === '') {
    throw new MemoryRuleError('source_required', 'source_ref is required; an item without a source is not stored');
  }
  if (!isIso(input.observed_at)) throw new MemoryRuleError('observed_at_required', 'observed_at (when it was actually observed) must be an ISO timestamp');
  if (rawValidUntil !== null && !isIso(rawValidUntil)) throw new MemoryRuleError('invalid_field', 'valid_until must be an ISO timestamp or null');
  // 시각은 UTC ISO 8601(밀리초, Z) 로 정규화해 저장한다: 문자열 비교가 곧 시간순 비교가 된다 (clock.ts 와 같은 규약).
  const observedAt = new Date(input.observed_at).toISOString();
  const defaultSeconds = rawValidUntil === null && input.valid_until === undefined ? context.defaultValiditySeconds?.(kind) ?? null : null;
  const validUntil = rawValidUntil !== null
    ? new Date(rawValidUntil).toISOString()
    : defaultSeconds === null ? null : new Date(Date.parse(observedAt) + defaultSeconds * 1000).toISOString();

  // 규칙 8: inconclusive 평가는 실패도 성공도 아니므로 어느 쪽 사례로도 학습 기록에 쓰지 않는다.
  if (LEARNING_KINDS.includes(kind) && input.source_ref.startsWith(EVALUATION_SOURCE_PREFIX)) {
    const evaluationId = input.source_ref.slice(EVALUATION_SOURCE_PREFIX.length);
    const evaluation = tx.get<{ outcome: string }>('SELECT outcome FROM evaluation WHERE id = ?', [evaluationId]);
    if (!evaluation) throw new MemoryRuleError('invalid_field', `source_ref points at evaluation '${evaluationId}', which does not exist`);
    if (evaluation.outcome === 'inconclusive') {
      throw new MemoryRuleError('inconclusive_not_learnable', `evaluation '${evaluationId}' is inconclusive; it is not stored as a '${kind}' (neither a success nor a failure case)`);
    }
  }

  // 규칙 9: 외부 입력 유래 근거에서 온 항목을 internal 로 적어 신뢰된 것으로 만들 수 없다
  if (evidenceTrust === 'external_untrusted' && trust !== 'external_untrusted') {
    throw new MemoryRuleError('untrusted_evidence_origin', `source_ref points at evidence of external_untrusted origin; the item cannot be recorded with trust_origin '${trust}'`);
  }

  // 규칙 3: 외부 입력 유래는 hypothesis / unverified / external_untrusted 로만 시작한다. 승격은 검증 업무의 몫이다.
  if (trust === 'external_untrusted' && (kind !== 'hypothesis' || verification !== 'unverified')) {
    throw new MemoryRuleError('external_must_be_hypothesis', "items from external input are stored only as kind='hypothesis', verification_status='unverified'");
  }

  // 에이전트는 hypothesis 만 쓸 수 있고, 스스로 verified/refuted 로 만들 수 없다 (스스로 검증하면 규칙 1 로 현재 사실이 되기 때문).
  if (actorKind(tx, input.created_by) === 'agent') {
    if (kind !== 'hypothesis') throw new MemoryRuleError('agent_kind_forbidden', `agents may write only kind='hypothesis', not '${kind}'`);
    if (verification !== 'unverified') throw new MemoryRuleError('agent_cannot_verify', "agents cannot mark their own items verified or refuted");
  }

  const id = (context.newId ?? (() => `mem-${randomUUID()}`))();
  const createdAt = context.clock.nowIso();
  tx.run(
    `INSERT INTO memory_item (id, kind, body, source_ref, observed_at, verification_status, validity, valid_until, sensitivity,
       trust_origin, superseded_by, product_id, policy_version_id, strategy_version_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      id, kind, input.body, input.source_ref, observedAt, verification, validity, validUntil, sensitivity,
      trust, input.product_id ?? null, input.policy_version_id ?? null, input.strategy_version_id ?? null, input.created_by, createdAt,
    ],
  );
  return getMemoryItem(tx, id)!;
}

export function getMemoryItem(db: Db, id: string): MemoryItemRow | undefined {
  return db.get<MemoryItemRow>('SELECT * FROM memory_item WHERE id = ?', [id]);
}

/** 규칙 1 을 순수 함수로. `currentFacts` 의 SQL 과 같은 결과여야 한다 (시험이 대조한다). */
export function isCurrentFact(item: Pick<MemoryItemRow, 'kind' | 'validity' | 'verification_status' | 'valid_until'>, nowIso: string): boolean {
  if (item.validity !== 'valid' || item.verification_status !== 'verified') return false;
  if (item.valid_until === null) return true;
  // 규칙 6: commitment 는 만료로 stale 이 되지 않는다 (이행/취소로만 종료).
  return item.kind === 'commitment' || item.valid_until > nowIso;
}

export interface MemoryFilter {
  product_id?: string;
  kind?: MemoryKind;
}

/**
 * 현재 사실만. 반증(`refuted`)·대체(`superseded`)·만료 항목과 미검증 항목은 빠진다.
 * 만료는 `valid_until` 을 지금 시각과 비교해 판정하므로 `sweepExpiredMemory` 가 아직 돌지 않았어도 제외된다.
 */
export function currentFacts(db: Db, options: MemoryFilter & { clock: Clock }): MemoryItemRow[] {
  const where = [
    "validity = 'valid'",
    "verification_status = 'verified'",
    "(valid_until IS NULL OR kind = 'commitment' OR valid_until > ?)",
  ];
  const params: Array<string> = [options.clock.nowIso()];
  if (options.product_id !== undefined) { where.push('product_id = ?'); params.push(options.product_id); }
  if (options.kind !== undefined) { where.push('kind = ?'); params.push(options.kind); }
  return db.all<MemoryItemRow>(`SELECT * FROM memory_item WHERE ${where.join(' AND ')} ORDER BY observed_at DESC, id`, params);
}

/** 과거 관측까지 모두. 반증·만료·대체된 항목도 나온다 (삭제하지 않는다, 규칙 2). */
export function listMemoryItems(db: Db, filter: MemoryFilter = {}): MemoryItemRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.product_id !== undefined) { where.push('product_id = ?'); params.push(filter.product_id); }
  if (filter.kind !== undefined) { where.push('kind = ?'); params.push(filter.kind); }
  return db.all<MemoryItemRow>(
    `SELECT * FROM memory_item${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY observed_at DESC, id`,
    params,
  );
}

/**
 * 유효 기간이 지난 항목의 validity 를 'stale' 로 바꾼다 ("경과하면 stale 로 전환"). commitment 는 제외(규칙 6).
 * 이력이므로 삭제하지 않는다. @returns 바뀐 행 수
 */
export function sweepExpiredMemory(tx: Db, clock: Clock): number {
  return tx.run(
    "UPDATE memory_item SET validity = 'stale' WHERE validity = 'valid' AND kind <> 'commitment' AND valid_until IS NOT NULL AND valid_until <= ?",
    [clock.nowIso()],
  ).changes;
}

function assertMayChange(tx: Db, item: MemoryItemRow, byActorId: string): void {
  if (actorKind(tx, byActorId) === 'agent' && item.kind !== 'hypothesis') {
    throw new MemoryRuleError('agent_kind_forbidden', `agents cannot change an item of kind '${item.kind}'`);
  }
}

/** 반증: 검증 상태와 유효성을 모두 refuted 로. 항목은 남는다. */
export function refuteMemoryItem(tx: Db, id: string, byActorId: string): MemoryItemRow {
  const item = getMemoryItem(tx, id);
  if (!item) throw new MemoryRuleError('not_found', `memory item '${id}' does not exist`);
  assertMayChange(tx, item, byActorId);
  tx.run("UPDATE memory_item SET verification_status = 'refuted', validity = 'refuted' WHERE id = ?", [id]);
  return getMemoryItem(tx, id)!;
}

/**
 * 삭제 대신 대체 (규칙 2): 새 항목을 만들고 이전 항목의 superseded_by 를 연결하고 validity 를 'superseded' 로 바꾼다.
 * 새 항목에도 createMemoryItem 의 모든 규칙이 적용된다.
 */
export function supersedeMemoryItem(tx: Db, oldId: string, replacement: NewMemoryItem, context: MemoryContext): MemoryItemRow {
  const old = getMemoryItem(tx, oldId);
  if (!old) throw new MemoryRuleError('not_found', `memory item '${oldId}' does not exist`);
  if (old.superseded_by !== null) throw new MemoryRuleError('already_superseded', `memory item '${oldId}' is already superseded`);
  assertMayChange(tx, old, replacement.created_by);
  const created = createMemoryItem(tx, replacement, context);
  tx.run("UPDATE memory_item SET superseded_by = ?, validity = 'superseded' WHERE id = ?", [created.id, oldId]);
  return created;
}
